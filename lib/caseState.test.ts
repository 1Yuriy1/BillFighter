import { describe, expect, it } from "vitest";
import { canTransition, isCaseStatus, nextStatuses, transition } from "./caseState";

describe("case state machine", () => {
  it("allows every edge the spec defines", () => {
    const legalEdges: Array<
      [Parameters<typeof canTransition>[0], Parameters<typeof canTransition>[0]]
    > = [
      ["intake", "analyzing"],
      ["analyzing", "awaiting_approval"],
      ["awaiting_approval", "in_progress"],
      ["in_progress", "waiting_reply"],
      ["waiting_reply", "analyzing"], // denied again / needs info -> re-analyze
      ["waiting_reply", "resolved"],
      ["resolved", "closed"], // closed is manual
    ];
    for (const [from, to] of legalEdges) {
      expect(canTransition(from, to), `${from} -> ${to}`).toBe(true);
    }
  });

  it("rejects skipping the approval flow", () => {
    expect(canTransition("intake", "in_progress")).toBe(false);
    expect(canTransition("intake", "resolved")).toBe(false);
    expect(canTransition("analyzing", "waiting_reply")).toBe(false);
    expect(canTransition("awaiting_approval", "resolved")).toBe(false);
    expect(canTransition("in_progress", "resolved")).toBe(false);
  });

  it("never leaves closed", () => {
    expect(nextStatuses("closed")).toEqual([]);
    expect(canTransition("closed", "intake")).toBe(false);
  });

  it("round-trips through transition()", () => {
    expect(transition("waiting_reply", "analyzing")).toBe("analyzing");
    expect(() => transition("closed", "intake")).toThrow(/Illegal case transition/);
  });

  it("guards isCaseStatus", () => {
    expect(isCaseStatus("analyzing")).toBe(true);
    expect(isCaseStatus("closed")).toBe(true);
    expect(isCaseStatus("bogus")).toBe(false);
  });
});
