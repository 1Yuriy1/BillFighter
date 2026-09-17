/**
 * Math verification for extracted documents: a document's line items must sum
 * to its stated total. Any imbalance flags the document for human review —
 * extraction output is never trusted past arithmetic.
 */
import type { LineItem } from "./extract";

export interface MathCheck {
  balanced: boolean;
  delta: number;
  needsHumanReview: boolean;
}

/** Tolerances in dollars — float money is compared at cent granularity. */
const CENT_TOLERANCE = 0.005;

/**
 * Verifies that a document's line items sum to its billed total.
 * Returns balanced/delta plus a needsHumanReview flag for mismatches.
 * Line items without a billed amount contribute nothing to the sum.
 */
export function verifyMath(lineItems: LineItem[], totalBilled: number | null): MathCheck {
  if (totalBilled === null) {
    // Nothing to check — absence of a total is an extraction gap, not a
    // math error.
    return { balanced: true, delta: 0, needsHumanReview: false };
  }
  const sum = lineItems.reduce((acc, item) => acc + (item.billed === null ? 0 : item.billed), 0);
  // Compare in whole cents to dodge float drift (0.1 + 0.2 != 0.3).
  const delta = Math.round((sum - totalBilled) * 100) / 100;
  const balanced = Math.abs(delta) < CENT_TOLERANCE;
  return { balanced, delta, needsHumanReview: !balanced };
}
