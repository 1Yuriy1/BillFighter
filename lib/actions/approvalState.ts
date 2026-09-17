/**
 * The two-human approval gate as a pure state machine.
 *
 * Phase 1 requires BOTH the user's and staff's approval before an action may
 * leave as 'approved' (spec: "both approvals are required in Phase 1;
 * approved_by records who"). Recording is per-role and idempotent: a repeated
 * approval by the same role changes nothing, approvals may arrive in either
 * order, and the action is complete only when both are in.
 */

import type { ApprovalRole } from "./types";

export interface ApprovalState {
  userApprovedAt: Date | null;
  staffApprovedAt: Date | null;
}

export interface ApprovalOutcome {
  /** The state after applying this approval. */
  state: ApprovalState;
  /**
   * False when the same role had already approved (a duplicate click or
   * redelivered request): the state is unchanged and no event is due.
   */
  changed: boolean;
  /** True when this approval completed the gate — the action may dispatch. */
  completed: boolean;
}

/**
 * Applies one approval to the current state. `now` stamps the approving role;
 * the other role's stamp passes through untouched.
 */
export function recordApproval(
  state: ApprovalState,
  role: ApprovalRole,
  now: Date,
): ApprovalOutcome {
  const alreadyAt = role === "user" ? state.userApprovedAt : state.staffApprovedAt;
  if (alreadyAt !== null) {
    return { state, changed: false, completed: bothApproved(state) };
  }

  const next: ApprovalState =
    role === "user" ? { ...state, userApprovedAt: now } : { ...state, staffApprovedAt: now };

  return { state: next, changed: true, completed: bothApproved(next) };
}

/** Both required approvals are in — the action may be dispatched. */
export function bothApproved(state: ApprovalState): boolean {
  return state.userApprovedAt !== null && state.staffApprovedAt !== null;
}
