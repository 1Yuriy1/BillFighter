/**
 * The extraction contract from the BillFighter MVP spec: Claude reads a
 * document and returns strict JSON — nulls for absent values, never guessed
 * numbers. Math verification is separate from extraction: a document whose
 * line items don't sum to its total is flagged, never trusted.
 */

export interface LineItem {
  date: string | null;
  code: string | null;
  description: string;
  units: number | null;
  billed: number | null;
  allowed: number | null;
  paid: number | null;
  patient_owes: number | null;
}

export interface ExtractedDocument {
  doc_type: "bill" | "itemized" | "eob" | "denial" | "plan" | "other";
  patient_name: string | null;
  provider_name: string | null;
  insurer_name: string | null;
  claim_number: string | null;
  service_dates: string[];
  line_items: LineItem[];
  total_billed: number | null;
  patient_responsibility: number | null;
  denial_reason: string | null;
  appeal_deadline: string | null; // ISO date; null unless stated
  network_status: "in" | "out" | "unknown";
  was_emergency: boolean | null;
  notes: string;
}

export interface ExtractionResult {
  extracted: ExtractedDocument;
  mathCheck: { balanced: boolean; delta: number; needsHumanReview: boolean };
}

/** Tolerances in dollars — float money is compared at cent granularity. */
const CENT_TOLERANCE = 0.005;

/**
 * Verifies that a document's line items sum to its billed total.
 * Returns balanced/delta plus a needsHumanReview flag for mismatches.
 * Line items without a billed amount contribute nothing to the sum.
 */
export function verifyMath(
  lineItems: LineItem[],
  totalBilled: number | null,
): ExtractionResult["mathCheck"] {
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
