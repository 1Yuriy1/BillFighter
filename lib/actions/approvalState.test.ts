import { describe, expect, it } from "vitest";
import { bothApproved, recordApproval, type ApprovalState } from "./approvalState";

const T0 = new Date("2026-09-17T10:00:00Z");
const T1 = new Date("2026-09-17T11:00:00Z");

function state(userApprovedAt: Date | null, staffApprovedAt: Date | null): ApprovalState {
  return { userApprovedAt, staffApprovedAt };
}

describe("recordApproval", () => {
  it("keeps the action incomplete after only the user approves", () => {
    const outcome = recordApproval(state(null, null), "user", T0);
    expect(outcome.changed).toBe(true);
    expect(outcome.completed).toBe(false);
    expect(outcome.state).toEqual(state(T0, null));
  });

  it("keeps the action incomplete after only staff approves", () => {
    const outcome = recordApproval(state(null, null), "staff", T0);
    expect(outcome.completed).toBe(false);
    expect(outcome.state).toEqual(state(null, T0));
  });

  it("completes when user approves first and staff follows", () => {
    const afterUser = recordApproval(state(null, null), "user", T0);
    const afterStaff = recordApproval(afterUser.state, "staff", T1);
    expect(afterStaff.completed).toBe(true);
    expect(afterStaff.state).toEqual(state(T0, T1));
  });

  it("completes when staff approves first and the user follows", () => {
    const afterStaff = recordApproval(state(null, null), "staff", T0);
    const afterUser = recordApproval(afterStaff.state, "user", T1);
    expect(afterUser.completed).toBe(true);
    expect(afterUser.state).toEqual(state(T1, T0));
  });

  it("is idempotent per role — a duplicate approval changes nothing", () => {
    const afterUser = recordApproval(state(null, null), "user", T0);
    const duplicate = recordApproval(afterUser.state, "user", T1);
    expect(duplicate.changed).toBe(false);
    expect(duplicate.completed).toBe(false);
    expect(duplicate.state).toEqual(afterUser.state);
  });

  it("does not re-arm a completed gate on a duplicate approval", () => {
    // Both approvals in, then the same role 'approves' again (stale click):
    // state untouched, still complete.
    const full = state(T0, T0);
    const duplicate = recordApproval(full, "staff", T1);
    expect(duplicate.changed).toBe(false);
    expect(duplicate.completed).toBe(true);
    expect(duplicate.state).toEqual(full);
  });
});

describe("bothApproved", () => {
  it("is true only when both stamps are present", () => {
    expect(bothApproved(state(null, null))).toBe(false);
    expect(bothApproved(state(T0, null))).toBe(false);
    expect(bothApproved(state(null, T0))).toBe(false);
    expect(bothApproved(state(T0, T1))).toBe(true);
  });
});
