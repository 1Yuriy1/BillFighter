/**
 * The success-fee math, per the MVP spec's Architecture section: the fee is
 * min(15% of confirmed savings, $500 cap), charged only on staff-confirmed
 * savings.
 *
 * Everything here is integer cents and pure — Stripe takes integer amounts
 * in the currency's smallest unit, and the cap boundary (a boundary-test in
 * the verification matrix) must be exact, so no floats survive a round trip.
 * The pg driver returns `numeric` columns as strings; toCents is the one
 * place that converts.
 */

import { formatUsd } from "../display";

/** $500.00 expressed in cents — the spec's cap. */
export const FEE_CAP_CENTS = 50_000;

export interface FeeComputation {
  /** The fee in integer cents: min(round(15% × savings), 50000). */
  feeCents: number;
  /** True when 15% of the savings exceeded the cap and the cap won. */
  capped: boolean;
}

/**
 * Dollars (or a pg `numeric` string) to integer cents, rounded to the nearest
 * cent. Display dollars come from money columns at 2dp, so this is exact for
 * real inputs; Math.round absorbs float representation noise (0.15 × 320000).
 */
export function toCents(dollars: number | string): number {
  const value = typeof dollars === "number" ? dollars : Number(dollars);
  if (Number.isNaN(value)) {
    throw new Error(`fee: cannot parse dollar amount "${dollars}"`);
  }
  return Math.round(value * 100);
}

/**
 * The capped fee formula: min(round(15% × savingsCents), 50000).
 *
 * Integer math (× 15 then ÷ 100) keeps the rounding deterministic: the
 * multiplication is exact, so the single divide produces one clean float —
 * e.g. savings of $3,333.33 (333333¢) → 49999.95¢ → rounds to 50000¢, which
 * equals the cap exactly without ever having exceeded it. `capped` is judged
 * on the UNROUNDED exact math (savings × 15 vs cap × 100): 15% of $3,333.34
 * is $500.001 — over the cap, so min() picks the cap and the receipt says so,
 * even though rounding lands on the same cent. Zero or negative savings yield
 * a zero fee — there is nothing to charge (negative savings is a data error
 * upstream, but a zero fee is still the safe answer).
 */
export function computeSuccessFee(savingsCents: number): FeeComputation {
  if (!Number.isInteger(savingsCents)) {
    throw new Error(`fee: savings must be integer cents, got ${savingsCents}`);
  }
  if (savingsCents <= 0) {
    return { feeCents: 0, capped: false };
  }
  const rawFeeCents = Math.round((savingsCents * 15) / 100);
  // Exact comparison on the unrounded fee: savings×15 cents vs cap×100.
  const capped = savingsCents * 15 > FEE_CAP_CENTS * 100;
  return {
    feeCents: Math.min(rawFeeCents, FEE_CAP_CENTS),
    capped,
  };
}

/** One line of the family-facing receipt, in display dollars. */
export interface ReceiptLineItem {
  /** The receipt's fixed three-line shape: disputed, then savings, then fee. */
  kind: "disputed" | "savings" | "fee";
  /** Human text — the fee line carries the math ("15% of $320.00…"). */
  label: string;
  /** Display dollars, 2dp (numeric for the receipt_line_items column). */
  amount: string;
}

/**
 * The receipt's line items — disputed amount, confirmed savings, fee, in
 * that order — so the receipt shows the calculation, not just a number.
 * The fee label states the formula and notes the cap when the cap applied.
 */
export function buildReceiptLineItems(
  disputedCents: number,
  savingsCents: number,
  fee: FeeComputation,
): ReceiptLineItem[] {
  const savingsDollars = savingsCents / 100;
  const feeLabel =
    fee.feeCents === 0
      ? "Success fee — no confirmed savings, nothing charged"
      : `Success fee — 15% of ${formatUsd(savingsDollars)} in confirmed savings` +
        (fee.capped ? `, capped at ${formatUsd(FEE_CAP_CENTS / 100)}` : "");
  return [
    {
      kind: "disputed",
      label: "Disputed amount",
      amount: formatUsd(disputedCents / 100),
    },
    {
      kind: "savings",
      label: "Confirmed savings",
      amount: formatUsd(savingsDollars),
    },
    {
      kind: "fee",
      label: feeLabel,
      amount: formatUsd(fee.feeCents / 100),
    },
  ];
}
