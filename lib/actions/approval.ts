/**
 * The approval gate, against the database.
 *
 * `approveDraft` records one of the two required approvals (user, staff) on a
 * draft action. The action's status stays 'draft' until BOTH approvals are in;
 * the approval that completes the gate flips status to 'approved', records
 * itself in `approved_by`, and queues the action for the dispatch job
 * (lib/actions/dispatch.ts) — the send itself never happens here (spec: "On
 * approval the job runner sends").
 *
 * Runs inside one transaction with the row locked, so concurrent approvals
 * serialize and the gate cannot be raced past.
 */
import type { Client as PgClient, PoolClient, QueryResultRow } from "pg";
import { recordApproval, type ApprovalState } from "./approvalState";
import type { ActionStatus, ApprovalRole } from "./types";

type Queryable = PoolClient | PgClient;

export type ActionErrorCode = "not_found" | "invalid_state";

export class ActionError extends Error {
  readonly code: ActionErrorCode;

  constructor(code: ActionErrorCode, message: string) {
    super(message);
    this.name = "ActionError";
    this.code = code;
  }
}

export type ApproveOutcome =
  | {
      status: "waiting";
      actionStatus: "draft";
      userApprovedAt: Date | null;
      staffApprovedAt: Date | null;
    }
  | { status: "duplicate"; actionStatus: ActionStatus }
  | { status: "completed"; actionStatus: "approved"; approvedBy: ApprovalRole };

interface ActionRow extends QueryResultRow {
  id: string;
  case_id: string;
  status: ActionStatus;
  user_approved_at: Date | null;
  staff_approved_at: Date | null;
}

/**
 * Records one approval on a draft action.
 *
 * Idempotent per role: approving twice by the same role is a no-op. Approving
 * a non-draft action (already approved, sent, failed, superseded) is an
 * invalid_state error — approvals are for drafts, and completed gates are
 * terminal.
 */
export async function approveDraft(
  client: Queryable,
  actionId: string,
  role: ApprovalRole,
  now: Date,
): Promise<ApproveOutcome> {
  await client.query("begin");
  try {
    const locked = await client.query<ActionRow>(
      `select id, case_id, status, user_approved_at, staff_approved_at
         from actions
        where id = $1
        for update`,
      [actionId],
    );
    if (locked.rows.length === 0) {
      throw new ActionError("not_found", `No action ${actionId}`);
    }
    const action = locked.rows[0];
    if (action.status !== "draft") {
      throw new ActionError(
        "invalid_state",
        `Action ${actionId} is ${action.status}, not draft — approvals apply to drafts`,
      );
    }

    const state: ApprovalState = {
      userApprovedAt: action.user_approved_at,
      staffApprovedAt: action.staff_approved_at,
    };
    const outcome = recordApproval(state, role, now);
    if (!outcome.changed) {
      await client.query("commit");
      return { status: "duplicate", actionStatus: action.status };
    }

    if (outcome.completed) {
      await client.query(
        `update actions
            set user_approved_at = $2, staff_approved_at = $3,
                status = 'approved', approved_by = $4
          where id = $1`,
        [actionId, outcome.state.userApprovedAt, outcome.state.staffApprovedAt, role],
      );
      await insertEvent(client, action.case_id, role, `${role} approved the draft`);
      await insertEvent(
        client,
        action.case_id,
        "system",
        `both approvals received — queued for send (${role} completed the gate)`,
      );
    } else {
      await client.query(
        `update actions
            set user_approved_at = $2, staff_approved_at = $3
          where id = $1`,
        [actionId, outcome.state.userApprovedAt, outcome.state.staffApprovedAt],
      );
      await insertEvent(client, action.case_id, role, `${role} approved the draft`);
    }

    await client.query("commit");
    return outcome.completed
      ? { status: "completed", actionStatus: "approved", approvedBy: role }
      : {
          status: "waiting",
          actionStatus: "draft",
          userApprovedAt: outcome.state.userApprovedAt,
          staffApprovedAt: outcome.state.staffApprovedAt,
        };
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}

async function insertEvent(
  client: Queryable,
  caseId: string,
  actor: "user" | "staff" | "system",
  message: string,
): Promise<void> {
  await client.query("insert into events (case_id, actor, message) values ($1, $2, $3)", [
    caseId,
    actor,
    message,
  ]);
}
