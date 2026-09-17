import { describe, expect, it } from "vitest";
import { verifyMath, type LineItem } from "./extract";

function item(billed: number | null, description = "Office visit"): LineItem {
  return {
    date: "2026-08-01",
    code: "99213",
    description,
    units: 1,
    billed,
    allowed: null,
    paid: null,
    patient_owes: null,
  };
}

describe("verifyMath", () => {
  it("passes when line items sum to the total", () => {
    const result = verifyMath([item(100.25), item(49.75)], 150.0);
    expect(result).toEqual({ balanced: true, delta: 0, needsHumanReview: false });
  });

  it("flags a document whose line items do not sum to its total", () => {
    const result = verifyMath([item(100.0), item(49.75)], 150.0);
    expect(result.balanced).toBe(false);
    expect(result.delta).toBe(-0.25);
    expect(result.needsHumanReview).toBe(true);
  });

  it("compares at cent granularity so float drift never flags", () => {
    const result = verifyMath([item(0.1), item(0.2)], 0.3);
    expect(result.balanced).toBe(true);
    expect(result.needsHumanReview).toBe(false);
  });

  it("ignores line items without a billed amount", () => {
    const result = verifyMath([item(150.0), item(null, "adjacent page, no billed")], 150.0);
    expect(result.balanced).toBe(true);
  });

  it("treats a missing total as an extraction gap, not a math error", () => {
    const result = verifyMath([item(100.0)], null);
    expect(result).toEqual({ balanced: true, delta: 0, needsHumanReview: false });
  });

  it("is fine with zero line items against a total only if the total is zero", () => {
    expect(verifyMath([], 0).balanced).toBe(true);
    expect(verifyMath([], 42).needsHumanReview).toBe(true);
  });
});
