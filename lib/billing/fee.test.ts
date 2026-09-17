/**
 * The capped fee formula, per the MVP spec's verification matrix: the charge
 * amount must equal min(15% × confirmed savings, $500) exactly, with the cap
 * boundary tested. Pure math — no database, no clock.
 */
import { describe, expect, it } from "vitest";
import { buildReceiptLineItems, computeSuccessFee, FEE_CAP_CENTS, toCents } from "./fee";

describe("toCents", () => {
  it("converts numeric dollars and pg numeric strings to integer cents", () => {
    expect(toCents(1420.5)).toBe(142050);
    expect(toCents("1420.50")).toBe(142050);
    expect(toCents("320.00")).toBe(32000);
    expect(toCents(0)).toBe(0);
  });

  it("rejects garbage instead of charging a nonsense amount", () => {
    expect(() => toCents("not-a-number")).toThrow(/cannot parse/);
  });
});

describe("computeSuccessFee — the capped formula", () => {
  it("takes 15% of confirmed savings below the cap", () => {
    // 15% of $100.00 = $15.00; 15% of $3,000.00 = $450.00.
    expect(computeSuccessFee(10_000)).toEqual({ feeCents: 1_500, capped: false });
    expect(computeSuccessFee(300_000)).toEqual({ feeCents: 45_000, capped: false });
  });

  it("savings of zero mean nothing to charge", () => {
    expect(computeSuccessFee(0)).toEqual({ feeCents: 0, capped: false });
  });

  it("caps the fee at exactly $500.00 once 15% exceeds it", () => {
    // 15% of $4,000.00 = $600.00 > $500.00 — the cap wins, exactly.
    expect(computeSuccessFee(400_000)).toEqual({ feeCents: FEE_CAP_CENTS, capped: true });
    // Far above the cap: still exactly $500.00.
    expect(computeSuccessFee(1_000_000)).toEqual({ feeCents: FEE_CAP_CENTS, capped: true });
  });

  it("the cap boundary is exact: 15% rounding to $500.00 does not count as capped", () => {
    // 15% of $3,333.33 = $499.9995 → rounds to $500.00 — equals the cap
    // exactly without ever exceeding it, so nothing was shaved off.
    const atBoundary = computeSuccessFee(333_333);
    expect(atBoundary).toEqual({ feeCents: FEE_CAP_CENTS, capped: false });
    // One cent more of savings pushes 15% over: still exactly $500.00, capped.
    const justOver = computeSuccessFee(333_334);
    expect(justOver).toEqual({ feeCents: FEE_CAP_CENTS, capped: true });
  });

  it("deterministic integer math — the same input always yields the same fee", () => {
    // 15% of $320.00 (the spec's example savings) = $48.00, exactly.
    for (let i = 0; i < 100; i += 1) {
      expect(computeSuccessFee(32_000).feeCents).toBe(4_800);
    }
  });

  it("refuses non-integer cents — Stripe amounts are integers", () => {
    expect(() => computeSuccessFee(1234.56)).toThrow(/integer cents/);
  });
});

describe("buildReceiptLineItems — the receipt shows the math", () => {
  it("itemizes disputed amount, confirmed savings, and fee, in that order", () => {
    const items = buildReceiptLineItems(142_050, 32_000, computeSuccessFee(32_000));
    expect(items.map((item) => item.kind)).toEqual(["disputed", "savings", "fee"]);
    expect(items.map((item) => item.amount)).toEqual(["$1,420.50", "$320.00", "$48.00"]);
  });

  it("the fee label states the formula, and names the cap when the cap applied", () => {
    const below = buildReceiptLineItems(142_050, 32_000, computeSuccessFee(32_000));
    expect(below[2].label).toBe("Success fee — 15% of $320.00 in confirmed savings");

    const capped = buildReceiptLineItems(1_000_000, 1_000_000, computeSuccessFee(1_000_000));
    expect(capped[2].label).toBe(
      "Success fee — 15% of $10,000.00 in confirmed savings, capped at $500.00",
    );
    expect(capped[2].amount).toBe("$500.00");
  });
});
