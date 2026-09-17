import { describe, expect, it } from "vitest";
import { assertDispatchable } from "./dispatch";

describe("assertDispatchable — the 'no draft reaches an adapter' guard", () => {
  it("passes only for approved actions", () => {
    expect(() => assertDispatchable({ id: "a1", status: "approved" })).not.toThrow();
  });

  it("rejects every non-approved status loudly", () => {
    for (const status of ["draft", "sent", "failed", "superseded"]) {
      expect(() => assertDispatchable({ id: "a1", status })).toThrowError(
        /only 'approved' actions may reach a channel adapter/,
      );
    }
  });

  it("names the action and the offending status in the error", () => {
    const error = (() => {
      try {
        assertDispatchable({ id: "act-77", status: "draft" });
        return null;
      } catch (e) {
        return e as Error;
      }
    })();
    expect(error?.message).toContain("act-77");
    expect(error?.message).toContain("'draft'");
  });
});
