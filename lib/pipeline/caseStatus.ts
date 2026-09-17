/**
 * Applies one state-machine transition to a case, with its timeline event.
 *
 * The cases.status check constraint keeps invalid enum values out of the
 * database, but the transition graph (lib/caseState.ts) lives only in code —
 * so every writer that moves a case forward goes through here: an illegal
 * move throws before the UPDATE runs, and a legal one lands with its `events`
 * row in the same transaction/commit scope the caller manages. The guarded
 * WHERE clause makes the move race-safe: a concurrent writer that already
 * changed the status yields rowCount 0 instead of a silent overwrite.
 */
import type { Client as PgClient, PoolClient } from "pg";
import { canTransition, type CaseStatus } from "@/lib/caseState";

type Queryable = PoolClient | PgClient;

/**
 * Moves the case forward when the approval gate completes (spec state
 * machine: awaiting_approval → in_progress once both humans have signed).
 *
 * Runs on the service connection — the staff session role holds no UPDATE
 * grant on cases (owner-only update policy), so the transition cannot ride
 * the approval transaction. Idempotent by the guarded WHERE: a case already
 * moved (or a seeded case in another state) leaves rowCount 0, not an error.
 */
export async function advanceCaseAfterApproval(client: Queryable, actionId: string): Promise<void> {
  const action = await client.query<{ case_id: string }>(
    "select case_id from actions where id = $1",
    [actionId],
  );
  const caseId = action.rows[0]?.case_id;
  if (caseId === undefined) return;
  await transitionCase(client, caseId, "awaiting_approval", "in_progress", {
    actor: "system",
    message: "both approvals received — the advocate is acting on the case",
  });
}

/**
 * Moves the case to waiting_reply after a successful send (spec state
 * machine: in_progress → waiting_reply on send). Walks forward through
 * awaiting_approval → in_progress first, because the dispatch job can race
 * the approval route's own transition — each guarded UPDATE no-ops when the
 * previous step already happened.
 */
export async function advanceCaseAfterSend(client: Queryable, caseId: string): Promise<void> {
  await transitionCase(client, caseId, "awaiting_approval", "in_progress", {
    actor: "system",
    message: "letter sent — case in progress",
  });
  await transitionCase(client, caseId, "in_progress", "waiting_reply", {
    actor: "system",
    message: "letter sent — waiting for the insurer's reply",
  });
}

/**
 * Moves the case from `from` to `to` and records the event as `actor`.
 * Returns false when the case is no longer in `from` (already moved by a
 * concurrent pass); returns true only after both the UPDATE and the event
 * row land. Throws on an illegal transition — that is always a bug in the
 * caller's state reasoning, never something to catch and carry on from.
 */
export async function transitionCase(
  client: Queryable,
  caseId: string,
  from: CaseStatus,
  to: CaseStatus,
  event: { actor: "system" | "agent"; message: string },
): Promise<boolean> {
  if (!canTransition(from, to)) {
    throw new Error(`Illegal case transition: ${from} -> ${to}`);
  }
  const updated = await client.query(
    `update cases set status = $3
      where id = $1 and status = $2`,
    [caseId, from, to],
  );
  const moved = (updated.rowCount ?? 0) > 0;
  if (moved) {
    await client.query("insert into events (case_id, actor, message) values ($1, $2, $3)", [
      caseId,
      event.actor,
      `case status ${from} -> ${to}: ${event.message}`,
    ]);
  }
  return moved;
}
