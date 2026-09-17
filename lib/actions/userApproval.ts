/**
 * The user side of the two-human approval gate, as the app exercises it.
 *
 * Migration 003 enforces at the column level that an authenticated session
 * can touch ONLY `user_approved_at` on an action — a user cannot set the
 * staff slot or flip status to 'approved' themselves. This module honors
 * that shape:
 *
 *   1. the SESSION client records the user's approval (RLS scopes the row;
 *      the column grant scopes the write — caregiver sessions pass both via
 *      has_family_access),
 *   2. the SERVICE client, only when staff already approved, completes the
 *      gate in one guarded statement (`where status = 'draft'`) and writes
 *      the timeline events.
 *
 * Staff approve through lib/actions/approval.approveDraft on their own
 * session, which holds the full staff grants.
 */

import type { PoolClient, QueryResultRow } from "pg";

export type UserApproveOutcome =
  | { status: "recorded" }
  | { status: "already_recorded" }
  | { status: "completed" }
  | { status: "not_accessible" };

interface ActionGateRow extends QueryResultRow {
  status: string;
  user_approved_at: Date | null;
  staff_approved_at: Date | null;
}

/**
 * Records the session user's approval on a draft action.
 *
 * `not_accessible` covers both "no such action" and "not in this family's
 * scope" — the API returns the same response for each, so the UI never
 * learns whether another family's action id exists.
 */
export async function approveAsUser(
  session: PoolClient,
  service: PoolClient,
  actionId: string,
  now: Date,
): Promise<UserApproveOutcome> {
  const visible = await session.query<ActionGateRow>(
    `select status, user_approved_at, staff_approved_at
       from actions
      where id = $1`,
    [actionId],
  );
  const action = visible.rows[0];
  if (action === undefined) {
    return { status: "not_accessible" };
  }
  if (action.status !== "draft" || action.user_approved_at !== null) {
    return { status: "already_recorded" };
  }

  const recorded = await session.query(
    `update actions
        set user_approved_at = $2
      where id = $1
        and status = 'draft'
        and user_approved_at is null`,
    [actionId, now],
  );
  if ((recorded.rowCount ?? 0) === 0) {
    // RLS or a concurrent approval removed the row from reach; re-read to
    // classify honestly instead of claiming success.
    const recheck = await session.query<ActionGateRow>(
      `select status, user_approved_at, staff_approved_at from actions where id = $1`,
      [actionId],
    );
    return recheck.rows[0] === undefined
      ? { status: "not_accessible" }
      : { status: "already_recorded" };
  }

  // Gate completion runs on the service connection: the user's column grant
  // cannot write status/approved_by, and the guarded update makes the
  // concurrent-staff-approval race safe (first completion wins, the loser
  // matches zero rows).
  if (action.staff_approved_at !== null) {
    await service.query("begin");
    try {
      const completed = await service.query(
        `update actions
            set status = 'approved', approved_by = 'user'
          where id = $1
            and status = 'draft'
          returning id`,
        [actionId],
      );
      if (completed.rows.length > 0) {
        await insertEvents(service, actionId, [
          "user approved the draft",
          "both approvals received — queued for send (user completed the gate)",
        ]);
      }
      await service.query("commit");
      return { status: "completed" };
    } catch (error) {
      await service.query("rollback");
      throw error;
    }
  }

  await insertEvents(service, actionId, ["user approved the draft"]);
  return { status: "recorded" };
}

async function insertEvents(
  service: PoolClient,
  actionId: string,
  messages: string[],
): Promise<void> {
  for (const message of messages) {
    await service.query(
      `insert into events (case_id, actor, message)
       select case_id, 'user', $2 from actions where id = $1`,
      [actionId, message],
    );
  }
}
