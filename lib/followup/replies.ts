/**
 * Inbound reply classification — the follow-up engine's reply handling (spec
 * Flows: "every reply is a document that re-enters extraction" and the reply
 * ladder).
 *
 * Intake (lib/intake/processInbound.ts) files each reply's body as a
 * `reply`-type document named `*-reply-body.txt`. This runner picks up every
 * such document with no classification yet, classifies it into one of the
 * spec's five outcomes (lib/followup/classify.ts), and acts:
 *
 *   resolved / partial_win    the case resolves (waiting_reply -> resolved)
 *   needs_info / denied_again the case re-opens analysis (back to
 *                             'analyzing') and the analyst proposes the
 *                             next action onto the timeline
 *   irrelevant                nothing moves; the family hears only at the
 *                             "everything" level
 *
 * Every state change goes through the case state machine — a reply that
 * cannot legally transition (say, a denial arriving while the case is
 * already 'analyzing') is recorded, never forced. Each reply runs in its
 * own transaction keyed on `reply_classifications.document_id` (unique), so
 * a re-run classifies each reply exactly once — the same structural
 * idempotency the intake webhook gets from Postmark's MessageID.
 *
 * Attachment-only replies (no readable body — the family answered with a
 * PDF) are deliberately left unclassified: there is no text to classify and
 * extraction owns their content. They re-enter through the normal
 * extraction -> analysis path instead of this runner guessing.
 *
 * The pause-all-automated-messages switch and the notification level gate
 * only the family-facing message — case state moves regardless (a denial
 * re-opens the case even for a paused family; what stops is the email).
 */

import { readFile } from "node:fs/promises";
import type { Client as PgClient, PoolClient, QueryResultRow } from "pg";
import { canTransition, isCaseStatus, type CaseStatus } from "../caseState";
import { classifyReplyText, replyNotificationSubject, type ReplyOutcome } from "./classify";
import type { DeliverMessage } from "./notifications";
import { replyRelevance, shouldNotifyUser } from "./notifications";

/** Intake names the reply body with this fixed suffix (lib/intake/processInbound.ts). */
const REPLY_BODY_SUFFIX = "-reply-body.txt";

type Queryable = PoolClient | PgClient;

/** Who proposes the next action for a re-opened case. */
export type ProposeNextAction = (caseId: string) => Promise<ProposedAction | null>;

export interface ProposedAction {
  title: string;
  detail: string;
}

export interface ClassifyOptions {
  /** Job-run timestamp; injected so tests drive the clock. */
  now: Date;
  /**
   * Analyst hook for re-opened cases (needs_info / denied_again). Omitted or
   * returning null when the analyst is unavailable — the case still re-opens
   * and the timeline records that the proposal is pending.
   */
  proposeNextAction?: ProposeNextAction;
  /** User-facing email delivery; omitted when no transport is configured. */
  deliver?: DeliverMessage;
  /**
   * Optional case scope. The scheduled job omits it and scans every pending
   * reply; a scoped run classifies only these cases' replies (targeted
   * backfills, and tests sharing a database with parallel suites that file
   * their own reply documents).
   */
  caseIds?: string[];
}

export interface ClassifyRunSummary {
  /** Pending reply bodies found by the scan. */
  scanned: number;
  /** Classifications recorded (first classification of a reply). */
  classified: number;
  /** Cases moved back to 'analyzing' (needs_info / denied_again). */
  reopened: number;
  /** Cases resolved (resolved / partial_win). */
  resolvedCases: number;
  /** Family notifications recorded (and delivered, when a transport runs). */
  notified: number;
  /** Family notifications suppressed — automated messages paused. */
  paused: number;
  /** Family notifications suppressed — "action needed" level, FYI outcome. */
  levelSuppressed: number;
  /** Classifications already on the ledger (idempotency gate). */
  skipped: number;
  /**
   * Replies whose body file could not be read (storage loss): surfaced here
   * and left pending for the next pass, instead of failing the whole run —
   * one missing file must not stop classification for every other family.
   */
  readFailures: number;
  /** Per-reply failures, rethrown as one aggregate error after the loop. */
  failures: Array<{ documentId: string; message: string }>;
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

interface PendingReplyRow extends QueryResultRow {
  id: string;
  case_id: string;
  file_path: string;
}

interface CaseForReplyRow extends QueryResultRow {
  status: string;
  user_id: string;
  email: string;
  notification_level: string;
  pause_all_messages: boolean;
}

async function recordEvent(
  client: Queryable,
  caseId: string,
  actor: "system" | "agent",
  message: string,
): Promise<void> {
  await client.query("insert into events (case_id, actor, message) values ($1, $2, $3)", [
    caseId,
    actor,
    message,
  ]);
}

function familyMessage(
  outcome: ReplyOutcome,
  to: string,
  documentId: string,
): { to: string; subject: string; body: string; dedupKey: string } {
  const subject = replyNotificationSubject(outcome);
  const body =
    outcome === "resolved" || outcome === "partial_win"
      ? `The insurer's reply came in and your case moved to resolved. ` +
        `Open your case page for the plain-language summary and what was saved.`
      : outcome === "needs_info" || outcome === "denied_again"
        ? `The insurer's reply came in and your advocate is on it — the case is back in review ` +
          `and the next step will appear on your case page shortly.`
        : `We received a reply on your case. It does not change anything about your dispute — ` +
          `no action is needed from you.`;
  return { to, subject, body, dedupKey: `reply:${documentId}` };
}

async function applyOutcome(
  client: Queryable,
  outcome: ReplyOutcome,
  caseRow: CaseForReplyRow,
  caseId: string,
  options: { now: Date; proposeNextAction?: ProposeNextAction },
): Promise<{ reopened: number; resolvedCases: number }> {
  let reopened = 0;
  let resolvedCases = 0;
  const current: CaseStatus = isCaseStatus(caseRow.status) ? caseRow.status : "intake";

  if (outcome === "resolved" || outcome === "partial_win") {
    if (canTransition(current, "resolved")) {
      await client.query("update cases set status = 'resolved' where id = $1", [caseId]);
      resolvedCases += 1;
      await recordEvent(client, caseId, "system", `reply classified as ${outcome} — case resolved`);
    } else {
      await recordEvent(
        client,
        caseId,
        "system",
        `reply classified as ${outcome} — no status change from '${current}'`,
      );
    }
    return { reopened, resolvedCases };
  }

  if (outcome === "needs_info" || outcome === "denied_again") {
    if (canTransition(current, "analyzing")) {
      await client.query("update cases set status = 'analyzing' where id = $1", [caseId]);
      reopened += 1;
      await recordEvent(
        client,
        caseId,
        "system",
        `reply classified as ${outcome} — case re-opened for analysis`,
      );
      const proposed = options.proposeNextAction ? await options.proposeNextAction(caseId) : null;
      if (proposed) {
        await recordEvent(
          client,
          caseId,
          "agent",
          `analyst proposes next action: ${proposed.title} — ${proposed.detail}`,
        );
      } else {
        await recordEvent(
          client,
          caseId,
          "system",
          `analysis re-opened — analyst proposal for the next action pending`,
        );
      }
    } else {
      await recordEvent(
        client,
        caseId,
        "system",
        `reply classified as ${outcome} — case already '${current}'; no re-open needed`,
      );
    }
    return { reopened, resolvedCases };
  }

  await recordEvent(client, caseId, "system", "reply classified as irrelevant — no case change");
  return { reopened, resolvedCases };
}

/** One reply's classification, inside its own transaction. */
async function classifyReply(
  client: Queryable,
  reply: PendingReplyRow,
  options: ClassifyOptions,
): Promise<{
  classified: number;
  reopened: number;
  resolvedCases: number;
  notified: number;
  paused: number;
  levelSuppressed: number;
  skipped: number;
}> {
  const counters = {
    classified: 0,
    reopened: 0,
    resolvedCases: 0,
    notified: 0,
    paused: 0,
    levelSuppressed: 0,
    skipped: 0,
  };

  const text = await readFile(reply.file_path, "utf8");
  const outcome = classifyReplyText(text);

  await client.query("begin");
  try {
    // The ledger row is the idempotency gate: a re-run (or a concurrent
    // runner) conflicts on document_id and treats the reply as done.
    const gate = await client.query(
      `insert into reply_classifications (document_id, case_id, outcome)
       values ($1, $2, $3)
       on conflict (document_id) do nothing
       returning id`,
      [reply.id, reply.case_id, outcome],
    );
    if (gate.rows.length === 0) {
      counters.skipped += 1;
      await client.query("commit");
      return counters;
    }
    counters.classified += 1;

    const caseResult = await client.query<CaseForReplyRow>(
      `select c.status, c.user_id, u.email, u.notification_level,
              -- Same single storage column as deadlines.ts (004_consoles).
              u.automated_messages_paused_at is not null as pause_all_messages
         from cases c
         join users u on u.id = c.user_id
        where c.id = $1
          for update of c`,
      [reply.case_id],
    );
    const caseRow = caseResult.rows[0];

    const outcomeCounters = await applyOutcome(client, outcome, caseRow, reply.case_id, options);
    counters.reopened += outcomeCounters.reopened;
    counters.resolvedCases += outcomeCounters.resolvedCases;

    const relevance = replyRelevance(outcome);
    if (
      shouldNotifyUser(
        {
          notificationLevel:
            caseRow.notification_level === "action_needed" ? "action_needed" : "everything",
          pauseAllMessages: caseRow.pause_all_messages,
        },
        relevance,
      )
    ) {
      const message = familyMessage(outcome, caseRow.email, reply.id);
      const recorded = await client.query(
        `insert into notifications
           (case_id, user_id, kind, outcome, audience, subject, body, dedup_key)
         values ($1, $2, 'reply_outcome', $3, 'user', $4, $5, $6)
         on conflict (dedup_key) do nothing
         returning id`,
        [reply.case_id, caseRow.user_id, outcome, message.subject, message.body, message.dedupKey],
      );
      if (recorded.rows.length > 0) {
        counters.notified += 1;
        await recordEvent(
          client,
          reply.case_id,
          "system",
          `family notified: reply outcome ${outcome}`,
        );
        if (options.deliver) {
          await options.deliver(message);
        }
      } else {
        counters.skipped += 1;
      }
    } else if (caseRow.pause_all_messages) {
      counters.paused += 1;
      await recordEvent(
        client,
        reply.case_id,
        "system",
        `family notification suppressed — automated messages paused`,
      );
    } else {
      counters.levelSuppressed += 1;
      await recordEvent(
        client,
        reply.case_id,
        "system",
        `family notification suppressed — notification level is "action needed"`,
      );
    }

    await client.query("commit");
    return counters;
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}

/**
 * Classifies every pending reply body. Replies run one transaction each; a
 * failure on one reply is collected and rethrown as an aggregate error after
 * the loop — committed replies stay classified, the failed reply retries on
 * the next run.
 */
export async function classifyPendingReplies(
  client: Queryable,
  options: ClassifyOptions,
): Promise<ClassifyRunSummary> {
  const scan = await client.query<PendingReplyRow>(
    `select d.id, d.case_id, d.file_path
       from documents d
      where d.doc_type = 'reply'
        and d.file_path like $1
        and ($2::uuid[] is null or d.case_id = any($2::uuid[]))
        and not exists (
          select 1 from reply_classifications rc where rc.document_id = d.id
        )
      order by d.created_at`,
    [`%${REPLY_BODY_SUFFIX}`, options.caseIds ?? null],
  );

  const summary: ClassifyRunSummary = {
    scanned: scan.rows.length,
    classified: 0,
    reopened: 0,
    resolvedCases: 0,
    notified: 0,
    paused: 0,
    levelSuppressed: 0,
    skipped: 0,
    readFailures: 0,
    failures: [],
  };

  for (const reply of scan.rows) {
    try {
      const outcome = await classifyReply(client, reply, options);
      summary.classified += outcome.classified;
      summary.reopened += outcome.reopened;
      summary.resolvedCases += outcome.resolvedCases;
      summary.notified += outcome.notified;
      summary.paused += outcome.paused;
      summary.levelSuppressed += outcome.levelSuppressed;
      summary.skipped += outcome.skipped;
    } catch (error) {
      if (isMissingFileError(error)) {
        summary.readFailures += 1;
        console.warn(
          `[followup] reply body unreadable, left pending for retry: ` +
            `document ${reply.id} at ${reply.file_path}`,
        );
        continue;
      }
      summary.failures.push({
        documentId: reply.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (summary.failures.length > 0) {
    throw new Error(
      `reply classification: ${summary.failures.length} reply(ies) failed — ` +
        summary.failures.map((f) => `${f.documentId.slice(0, 8)}: ${f.message}`).join("; "),
    );
  }
  return summary;
}
