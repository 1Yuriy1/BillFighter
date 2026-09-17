/**
 * The outbound dispatcher — the job runner that turns APPROVED actions into
 * sent letters (spec: "On approval the job runner sends via the right
 * channel, logs an events row, and sets follow_up_at").
 *
 * The spec's hard invariant is enforced twice, on purpose:
 *
 *   1. the due-queue query only selects rows with status = 'approved';
 *   2. `assertDispatchable` re-checks the locked row inside the transaction
 *      before any adapter is touched — even a buggy or hand-rolled query
 *      cannot put a draft in front of a channel without this guard throwing.
 *
 * Failure handling per spec: a failed send retries with exponential backoff
 * (lib/actions/timing.ts) while the action stays 'approved' with its retry
 * ledger in send_attempts / next_attempt_at / last_error; the third failure
 * parks the action at status 'failed' with the error attached — it surfaces
 * in the staff queue (lib/actions/staffQueue.ts), never silently dropped,
 * never silently repeated. Structural failures (no adapter for the channel,
 * user authorization unsigned) cannot succeed on retry, so they park
 * immediately with the reason attached.
 *
 * Each action dispatches inside its own transaction, locked from the status
 * re-check through the DB write, so two concurrent runners cannot double-send.
 * The known residual gap is the usual at-least-once window: a crash between
 * adapter success and commit can resend — the same at-least-once semantics
 * Postmark itself applies to inbound webhooks; the provider id in the event
 * trail reconciles duplicates.
 */
import type { Client as PgClient, PoolClient, QueryResultRow } from "pg";
import { backoffDelayMs, followUpAt, MAX_SEND_ATTEMPTS } from "./timing";
import { SendError, type ChannelAdapter, type OutboundAction } from "./types";

type Queryable = PoolClient | PgClient;

export interface DispatchOptions {
  /** Job-run timestamp; injected so tests drive the clock. */
  now: Date;
  /** Backoff base for retries; defaults to production timing. */
  retryBaseMs?: number;
}

export interface DispatchSummary {
  sent: number;
  /** Failed attempts that scheduled another retry (still 'approved'). */
  retried: number;
  /** Parked at 'failed' — staff queue, error attached. */
  parked: number;
  /** Rows that were due but no longer dispatchable when locked. */
  skipped: number;
}

interface DueActionRow extends QueryResultRow {
  id: string;
  case_id: string;
  channel: OutboundAction["channel"];
  recipient: string | null;
  subject: string | null;
  body: string | null;
  status: string;
  send_attempts: number;
  authorization_signed_at: Date | null;
}

/**
 * The dispatch guard: only an 'approved' action may reach a channel adapter.
 * Throws before any adapter is constructed or called, so the violation is
 * loud and the surrounding transaction rolls back untouched.
 */
export function assertDispatchable(action: { status: string; id: string }): void {
  if (action.status !== "approved") {
    throw new SendError(
      `dispatch guard: action ${action.id} has status '${action.status}' — ` +
        `only 'approved' actions may reach a channel adapter`,
    );
  }
}

/**
 * Dispatches every approved action whose next attempt is due. The job entry
 * point: safe to run on a schedule, idempotent per action (sent rows drop out
 * of the due query; locked rows re-check their status).
 */
export async function dispatchDueActions(
  client: Queryable,
  adapters: readonly ChannelAdapter[],
  options: DispatchOptions,
): Promise<DispatchSummary> {
  const due = await client.query<DueActionRow>(
    `select a.id, a.case_id, a.channel, a.recipient, a.subject, a.body,
            a.status, a.send_attempts, u.authorization_signed_at
       from actions a
       join cases c on c.id = a.case_id
       left join users u on u.id = c.user_id
      where a.status = 'approved'
        and (a.next_attempt_at is null or a.next_attempt_at <= $1)
      order by a.created_at`,
    [options.now],
  );

  const byChannel = new Map(adapters.map((adapter) => [adapter.channel, adapter]));
  const summary: DispatchSummary = { sent: 0, retried: 0, parked: 0, skipped: 0 };

  for (const row of due.rows) {
    const outcome = await dispatchOne(client, byChannel, row, options);
    summary[outcome] += 1;
  }
  return summary;
}

type DispatchOutcome = keyof DispatchSummary;

async function dispatchOne(
  client: Queryable,
  byChannel: Map<string, ChannelAdapter>,
  row: DueActionRow,
  options: DispatchOptions,
): Promise<DispatchOutcome> {
  const { now } = options;
  await client.query("begin");
  try {
    const locked = await client.query<DueActionRow>(
      `select a.id, a.case_id, a.channel, a.recipient, a.subject, a.body,
              a.status, a.send_attempts, u.authorization_signed_at
         from actions a
         join cases c on c.id = a.case_id
         left join users u on u.id = c.user_id
        where a.id = $1
        for update of a`,
      [row.id],
    );
    const action = locked.rows[0];
    if (action === undefined) {
      await client.query("commit");
      return "skipped";
    }

    // Guard #2: the locked row itself must still be approved. The due query
    // already filtered on status, but between query and lock another runner
    // may have sent it; and regardless, nothing non-approved passes here.
    assertDispatchable(action);

    const adapter = byChannel.get(action.channel);
    if (adapter === undefined) {
      // No adapter for this channel (call/portal are later phases): retrying
      // cannot conjure one — park immediately with the reason attached.
      await parkAction(
        client,
        action,
        `no adapter for channel '${action.channel}' — staff must re-route or implement the channel`,
      );
      await client.query("commit");
      return "parked";
    }

    // users.authorization_signed_at is the schema's documented gate: no
    // outbound action before it. Staff resolve; retrying cannot.
    if (action.authorization_signed_at === null) {
      await parkAction(
        client,
        action,
        "user has not signed the authorization — outbound send blocked by gate",
      );
      await client.query("commit");
      return "parked";
    }

    const outbound: OutboundAction = {
      id: action.id,
      channel: action.channel,
      recipient: action.recipient ?? "",
      subject: action.subject ?? "",
      body: action.body ?? "",
    };

    try {
      const result = await adapter.send(outbound);
      const followup = followUpAt(now);
      await client.query(
        `update actions
            set status = 'sent', sent_at = $2, follow_up_at = $3,
                last_error = null, next_attempt_at = null
          where id = $1`,
        [action.id, now, followup],
      );
      await client.query("insert into events (case_id, actor, message) values ($1, 'system', $2)", [
        action.case_id,
        `letter sent via ${action.channel}` +
          (result.providerId ? ` (provider id ${result.providerId})` : "") +
          ` — follow-up due ${followup.toISOString().slice(0, 10)}`,
      ]);
      await client.query("commit");
      return "sent";
    } catch (error) {
      const attempts = action.send_attempts + 1;
      const message = error instanceof Error ? error.message : "unknown send error — see adapter";
      if (attempts >= MAX_SEND_ATTEMPTS) {
        await parkAction(
          client,
          action,
          `${message} (send failed after ${MAX_SEND_ATTEMPTS} attempts)`,
          attempts,
        );
        await client.query("commit");
        return "parked";
      }
      const retryAt = new Date(now.getTime() + backoffDelayMs(attempts, options.retryBaseMs));
      await client.query(
        `update actions
            set send_attempts = $2, next_attempt_at = $3, last_error = $4
          where id = $1`,
        [action.id, attempts, retryAt, message],
      );
      await client.query("insert into events (case_id, actor, message) values ($1, 'system', $2)", [
        action.case_id,
        `send attempt ${attempts} failed — will retry at ${retryAt.toISOString()}: ${message}`,
      ]);
      await client.query("commit");
      return "retried";
    }
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}

/**
 * Parks an action at 'failed' with the error attached — staff-queue visible.
 * `attempts` records how many adapter attempts were made (send-failure parks
 * pass the final count; structural parks keep the row's existing value).
 */
async function parkAction(
  client: Queryable,
  action: DueActionRow,
  error: string,
  attempts: number = action.send_attempts,
): Promise<void> {
  await client.query(
    `update actions
        set status = 'failed', send_attempts = $2, last_error = $3, next_attempt_at = null
      where id = $1`,
    [action.id, attempts, error],
  );
  await client.query("insert into events (case_id, actor, message) values ($1, 'system', $2)", [
    action.case_id,
    `send parked in staff queue — action failed: ${error}`,
  ]);
}
