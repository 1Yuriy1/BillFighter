/**
 * The daily deadline check — the follow-up engine's tier ladder (spec Flows:
 * deadline escalation).
 *
 * One decision per case with a live `next_deadline`, per tier — the
 * thresholds live in lib/display's {@link deadlineTier}:
 *
 *   notify (14..6 days out)   the family hears about the deadline
 *   escalate (5..3 days out)  staff is escalated as well — "not just the
 *                             user"; the family alert is not re-sent (the
 *                             14-day notice already counts), but a case
 *                             first seen here alerts the family now
 *   urgent (48h or overdue)   the case pins to the top of the staff console
 *                             — recorded only when no appeal is drafted
 *                             yet; an appeal already in motion is owned by
 *                             the draft-review queue instead
 *
 * Idempotency is structural, not best-effort: every notification lands in
 * `notifications` under a unique dedup key (tier + case + deadline). A
 * re-run the same day — or any later day within the same tier — conflicts
 * on the key and is a no-op, so a family never gets a tier twice for the
 * same deadline. A changed deadline is a new key and may notify again;
 * that is the point.
 *
 * Failure posture follows the dispatch precedent (lib/actions/dispatch.ts):
 * each case runs in its own transaction and the optional delivery hook is
 * called inside it, so a failure rolls back that case cleanly (committed
 * cases stay notified; the failed case retries on the next run). The known
 * residual gap is the usual at-least-once window — a crash after a provider
 * accepted a send but before commit can resend; the dedup key in the ledger
 * reconciles.
 *
 * The pause-all-automated-messages switch gates user-facing messages only.
 * Staff escalation is intentionally unaffected: pausing is how a family in
 * crisis stops the noise, and the deadline alarm is exactly what staff must
 * still see.
 */

import type { Client as PgClient, PoolClient, QueryResultRow } from "pg";
import { daysPhrase, daysUntil, deadlineTier, formatDate } from "../display";
import type { DeliverMessage, FamilyPrefs } from "./notifications";
import { isNotificationLevel, shouldNotifyUser } from "./notifications";

type Queryable = PoolClient | PgClient;

export interface DeadlineCheckOptions {
  /** Job-run timestamp; injected so tests drive the clock. */
  now: Date;
  /** User-facing email delivery; omitted when no transport is configured. */
  deliver?: DeliverMessage;
  /**
   * Optional case scope. The scheduled job omits it and scans everything; a
   * scoped run processes only these cases (targeted backfills, and tests
   * sharing a database with parallel suites that seed their own cases).
   */
  caseIds?: string[];
}

export interface DeadlineRunSummary {
  /** Cases scanned with a live deadline. */
  scanned: number;
  /** User deadline alerts recorded (and delivered, when a transport runs). */
  notified: number;
  /** Staff escalations recorded (tier escalate). */
  escalated: number;
  /** Urgent staff records — the 48-hour console pin. */
  pinned: number;
  /** User alerts suppressed because automated messages are paused. */
  paused: number;
  /** Notification attempts already on the ledger (idempotency gate). */
  skipped: number;
  /** Per-case failures, rethrown as one aggregate error after the loop. */
  failures: Array<{ caseId: string; message: string }>;
}

/** UTC calendar day of a timestamp, matching lib/display's day math. */
export function isoDay(moment: Date): string {
  return moment.toISOString().slice(0, 10);
}

interface CaseRow extends QueryResultRow {
  id: string;
  user_id: string;
  /** to_char YYYY-MM-DD — no local-timezone Date parsing. */
  next_deadline: string;
  insurer_name: string | null;
  provider_name: string | null;
  status: string;
  email: string;
  notification_level: string;
  pause_all_messages: boolean;
  has_appeal_draft: boolean;
}

function caseLabel(row: Pick<CaseRow, "id" | "insurer_name" | "provider_name">): string {
  return row.insurer_name ?? row.provider_name ?? `case ${row.id.slice(0, 8)}`;
}

/** "appeal deadline in 5 days" / "appeal deadline overdue by 2 days". */
function deadlinePhrase(daysLeft: number): string {
  return daysLeft >= 0
    ? `appeal deadline in ${daysPhrase(daysLeft)}`
    : `appeal deadline overdue by ${daysPhrase(-daysLeft)}`;
}

function prefsOf(row: Pick<CaseRow, "notification_level" | "pause_all_messages">): FamilyPrefs {
  return {
    notificationLevel: isNotificationLevel(row.notification_level)
      ? row.notification_level
      : "everything",
    pauseAllMessages: row.pause_all_messages,
  };
}

/** The family-facing deadline email, in the spec's plain tone. */
function userMessageFor(
  row: CaseRow,
  daysLeft: number,
  dedupKey: string,
): { to: string; subject: string; body: string; dedupKey: string } {
  const label = caseLabel(row);
  const when =
    daysLeft >= 0
      ? `in ${daysPhrase(daysLeft)}, on ${formatDate(row.next_deadline)}`
      : `overdue — it was due ${formatDate(row.next_deadline)}`;
  return {
    to: row.email,
    subject: `Your appeal deadline is coming up — ${label}`,
    body:
      `Your appeal for ${label} is due ${when}. ` +
      `We are watching this deadline for you and will keep your case moving. ` +
      `If anything changes on your end, just reply to this email.`,
    dedupKey,
  };
}

/** Staff escalation copy — the staff console is the surface; the row is the record. */
function staffCopyFor(row: CaseRow, daysLeft: number): { subject: string; body: string } {
  const label = caseLabel(row);
  return {
    subject: `Deadline escalation: ${label} — ${daysPhrase(Math.abs(daysLeft))} to deadline`,
    body:
      `Case ${label} has an ${deadlinePhrase(daysLeft)} (${formatDate(row.next_deadline)}). ` +
      `Staff now owns the follow-up alongside the family.`,
  };
}

/** One notification insert; false when the dedup key already holds the row. */
async function recordNotification(
  client: Queryable,
  row: {
    caseId: string;
    userId: string;
    tier: "notify" | "escalate" | "urgent";
    audience: "user" | "staff";
    subject: string;
    body: string;
    dedupKey: string;
  },
): Promise<boolean> {
  const result = await client.query(
    `insert into notifications
       (case_id, user_id, kind, tier, audience, subject, body, dedup_key)
     values ($1, $2, 'deadline_tier', $3, $4, $5, $6, $7)
     on conflict (dedup_key) do nothing
     returning id`,
    [row.caseId, row.userId, row.tier, row.audience, row.subject, row.body, row.dedupKey],
  );
  return result.rows.length > 0;
}

async function recordEvent(client: Queryable, caseId: string, message: string): Promise<void> {
  await client.query("insert into events (case_id, actor, message) values ($1, 'system', $2)", [
    caseId,
    message,
  ]);
}

/**
 * One case's tier decision, inside its own transaction: locked from the
 * status re-check through the write, so two concurrent runners cannot both
 * notify. Returns the per-case counters for the run summary.
 */
async function processDeadlineCase(
  client: Queryable,
  caseId: string,
  todayIso: string,
  deliver: DeliverMessage | undefined,
): Promise<{
  notified: number;
  escalated: number;
  pinned: number;
  paused: number;
  skipped: number;
}> {
  await client.query("begin");
  try {
    const locked = await client.query<CaseRow>(
      `select c.id, c.user_id, to_char(c.next_deadline, 'YYYY-MM-DD') as next_deadline,
              c.insurer_name, c.provider_name, c.status,
              u.email, u.notification_level,
              -- The crisis switch's single storage column is the pause
              -- timestamp (004_consoles); the jobs reason about a boolean.
              u.automated_messages_paused_at is not null as pause_all_messages,
              exists (select 1 from actions a where a.case_id = c.id) as has_appeal_draft
         from cases c
         join users u on u.id = c.user_id
        where c.id = $1
          for update of c`,
      [caseId],
    );
    const row = locked.rows[0];
    const daysLeft = daysUntil(row.next_deadline, todayIso);
    const tier = deadlineTier(daysLeft);
    const label = caseLabel(row);
    const counters = { notified: 0, escalated: 0, pinned: 0, paused: 0, skipped: 0 };

    if (tier === "urgent") {
      // Spec: 48 hours out with no appeal drafted — pin to the top of the
      // staff console. An appeal already drafted means the case is moving;
      // the draft-review queue owns it from here.
      if (row.has_appeal_draft) {
        await recordEvent(
          client,
          row.id,
          `deadline tier urgent: ${deadlinePhrase(daysLeft)} (${formatDate(row.next_deadline)}) — ` +
            `appeal already drafted; no console pin needed`,
        );
        counters.skipped += 1;
      } else {
        const inserted = await recordNotification(client, {
          caseId: row.id,
          userId: row.user_id,
          tier: "urgent",
          audience: "staff",
          subject: `Action needed: ${label} — 48 hours to deadline, no appeal drafted`,
          body:
            `The ${label} case deadline is ${formatDate(row.next_deadline)} ` +
            `(${daysPhrase(Math.abs(daysLeft))}${daysLeft < 0 ? " overdue" : " away"}) ` +
            `and no appeal has been drafted yet. The case is pinned to the top of your console.`,
          dedupKey: `deadline:urgent:${row.id}:${row.next_deadline}`,
        });
        if (inserted) {
          counters.pinned += 1;
          await recordEvent(
            client,
            row.id,
            `deadline tier urgent: ${deadlinePhrase(daysLeft)} (${formatDate(row.next_deadline)}) ` +
              `with no appeal drafted — pinned to top of staff console`,
          );
        } else {
          counters.skipped += 1;
        }
      }
      await client.query("commit");
      return counters;
    }

    // notify + escalate alert the family under one key: the first deadline
    // alert the family gets counts for both tiers, so escalation never
    // re-emails a family already told at 14 days.
    const tierName = tier === "escalate" ? "escalate" : "notify";
    if (shouldNotifyUser(prefsOf(row), "action_needed")) {
      const dedupKey = `deadline:notify:${row.id}:${row.next_deadline}`;
      const message = userMessageFor(row, daysLeft, dedupKey);
      const inserted = await recordNotification(client, {
        caseId: row.id,
        userId: row.user_id,
        tier: tierName,
        audience: "user",
        subject: message.subject,
        body: message.body,
        dedupKey,
      });
      if (inserted) {
        counters.notified += 1;
        await recordEvent(
          client,
          row.id,
          `deadline tier ${tierName}: ${deadlinePhrase(daysLeft)} ` +
            `(${formatDate(row.next_deadline)}) — family notified`,
        );
        if (deliver) {
          await deliver(message);
        }
      } else {
        counters.skipped += 1;
      }
    } else {
      counters.paused += 1;
      await recordEvent(
        client,
        row.id,
        `deadline tier ${tierName}: ${deadlinePhrase(daysLeft)} ` +
          `(${formatDate(row.next_deadline)}) — family notification suppressed, ` +
          `automated messages paused`,
      );
    }

    if (tier === "escalate") {
      const staff = staffCopyFor(row, daysLeft);
      const inserted = await recordNotification(client, {
        caseId: row.id,
        userId: row.user_id,
        tier: "escalate",
        audience: "staff",
        subject: staff.subject,
        body: staff.body,
        dedupKey: `deadline:escalate:${row.id}:${row.next_deadline}`,
      });
      if (inserted) {
        counters.escalated += 1;
        await recordEvent(
          client,
          row.id,
          `deadline tier escalate: ${deadlinePhrase(daysLeft)} ` +
            `(${formatDate(row.next_deadline)}) — staff escalation recorded`,
        );
      } else {
        counters.skipped += 1;
      }
    }

    await client.query("commit");
    return counters;
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}

/**
 * Runs the daily deadline check across every case with a live deadline.
 * Cases run one transaction each; a failure on one case is collected and
 * rethrown as an aggregate error after the loop, so one bad case cannot
 * hold the rest hostage — committed cases dedup-skip on retry.
 */
export async function runDeadlineCheck(
  client: Queryable,
  options: DeadlineCheckOptions,
): Promise<DeadlineRunSummary> {
  const todayIso = isoDay(options.now);
  const scan = await client.query<Pick<CaseRow, "id">>(
    `select c.id
       from cases c
       join users u on u.id = c.user_id
      where c.next_deadline is not null
        and c.status not in ('resolved', 'closed')
        and ($1::uuid[] is null or c.id = any($1::uuid[]))
      order by c.next_deadline`,
    [options.caseIds ?? null],
  );

  const summary: DeadlineRunSummary = {
    scanned: scan.rows.length,
    notified: 0,
    escalated: 0,
    pinned: 0,
    paused: 0,
    skipped: 0,
    failures: [],
  };

  for (const scanned of scan.rows) {
    try {
      const outcome = await processDeadlineCase(client, scanned.id, todayIso, options.deliver);
      summary.notified += outcome.notified;
      summary.escalated += outcome.escalated;
      summary.pinned += outcome.pinned;
      summary.paused += outcome.paused;
      summary.skipped += outcome.skipped;
    } catch (error) {
      summary.failures.push({
        caseId: scanned.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (summary.failures.length > 0) {
    throw new Error(
      `deadline check: ${summary.failures.length} case(s) failed — ` +
        summary.failures.map((f) => `${f.caseId.slice(0, 8)}: ${f.message}`).join("; "),
    );
  }
  return summary;
}

/* ------------------------------------------------------------------ */
/* Staff console queue                                                 */
/* ------------------------------------------------------------------ */

/** A deadline queue entry, shaped for StaffQueueTable (kind 'deadline'). */
export interface DeadlineQueueEntry {
  id: string;
  caseId: string;
  /** Human case name, e.g. "Aetna — Riverwalk Imaging". */
  caseLabel: string;
  summary: string;
  kind: "deadline";
  /** 48h-or-less with no appeal drafted — pins to the top of the console. */
  urgent: boolean;
  updatedAt: string;
}

export interface DeadlineQueueOptions {
  /** Clock injection so the queue read is testable. */
  now: Date;
}

/**
 * Deadline queue read for the staff console: live cases whose deadline is
 * inside the notify horizon (14 days or closer, overdue included). Entries
 * at the urgent tier with no appeal drafted carry urgent: true, which
 * StaffQueueTable sorts to the top — the spec's 48-hour pin.
 */
export async function deadlineEntries(
  client: Queryable,
  options: DeadlineQueueOptions,
): Promise<DeadlineQueueEntry[]> {
  const todayIso = isoDay(options.now);
  const result = await client.query<QueryResultRow>(
    `select c.id,
            to_char(c.next_deadline, 'YYYY-MM-DD') as next_deadline,
            c.insurer_name, c.provider_name,
            exists (select 1 from actions a where a.case_id = c.id) as has_appeal_draft,
            coalesce(
              (select max(e.created_at) from events e where e.case_id = c.id),
              c.created_at
            ) as updated_at
       from cases c
      where c.next_deadline is not null
        and c.status not in ('resolved', 'closed')
      order by c.next_deadline`,
  );

  const entries: DeadlineQueueEntry[] = [];
  for (const row of result.rows) {
    const deadlineIso = String(row.next_deadline);
    const daysLeft = daysUntil(deadlineIso, todayIso);
    if (deadlineTier(daysLeft) === "none") continue;
    const noAppealDrafted = !row.has_appeal_draft;
    const urgent = deadlineTier(daysLeft) === "urgent" && noAppealDrafted;
    const when =
      daysLeft >= 0
        ? `due in ${daysPhrase(daysLeft)} (${formatDate(deadlineIso)})`
        : `overdue by ${daysPhrase(-daysLeft)} (${formatDate(deadlineIso)})`;
    entries.push({
      id: `deadline:${row.id}`,
      caseId: String(row.id),
      caseLabel: row.insurer_name ?? row.provider_name ?? `case ${String(row.id).slice(0, 8)}`,
      summary: `Appeal deadline ${when}` + (urgent ? " — no appeal drafted yet" : ""),
      kind: "deadline",
      urgent,
      updatedAt: new Date(row.updated_at as Date).toISOString(),
    });
  }
  return entries;
}
