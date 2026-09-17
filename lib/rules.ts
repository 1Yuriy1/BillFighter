/**
 * The deterministic rules layer (Layer A of the two-layer analysis; the AI
 * analyst in lib/analyze.ts is Layer B). Every rule is a pure function over
 * extracted documents — no DB, no API, and no clock: `today` is a parameter,
 * so deadline rules are testable at their exact boundaries.
 *
 * Findings mirror the `findings` table in db/migrations/001_init.sql (kind,
 * description, estimated_savings, confidence, source). Kind is open-ended
 * text like the column it lands in; the rules layer produces: duplicate,
 * bill_eob_mismatch, deadline_proximity, urgent_treatment. Savings are null
 * when not computable — a rule never guesses a number.
 */

import type { ExtractedDocument, LineItem } from "./extract";

export type FindingSource = "rule" | "ai";

export type FindingConfidence = "high" | "medium" | "low";

export interface Finding {
  kind: string;
  description: string;
  estimated_savings: number | null;
  confidence: FindingConfidence;
  source: FindingSource;
  /**
   * True only on findings the urgent rule raised. Urgency is a finding
   * attribute per the spec — the staff console sorts urgent first.
   */
  urgent: boolean;
}

/** An appeal deadline within this many days of today becomes a finding. */
const DEADLINE_WINDOW_DAYS = 30;

/**
 * Days out at which an approaching deadline plus a treatment signal becomes
 * urgent (overdue counts — a passed deadline is more urgent, not less).
 */
const URGENT_WINDOW_DAYS = 14;

/**
 * Treatment signals that make an approaching deadline urgent. Substring
 * match, case-insensitive; "chemo" also catches "chemotherapy". Built for
 * cancer families first — a delayed chemo authorization is the canonical
 * urgent case.
 */
const TREATMENT_KEYWORDS = ["chemo", "radiation", "oncology", "immunotherapy"] as const;

const MS_PER_DAY = 86_400_000;

function makeFinding(
  kind: string,
  description: string,
  estimated_savings: number | null,
  confidence: FindingConfidence,
  urgent = false,
): Finding {
  return { kind, description, estimated_savings, confidence, source: "rule", urgent };
}

/** Whole dollars-and-cents amount, compared in cents to dodge float drift. */
function cents(amount: number): number {
  return Math.round(amount * 100);
}

/** "$1,234.56" — deterministic formatting for finding descriptions. */
function formatMoney(amount: number): string {
  const totalCents = cents(amount);
  const sign = totalCents < 0 ? "-" : "";
  const absCents = Math.abs(totalCents);
  const dollars = Math.floor(absCents / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}$${dollars}.${(absCents % 100).toString().padStart(2, "0")}`;
}

function pluralDays(count: number): string {
  return count === 1 ? "day" : "days";
}

/**
 * Strict ISO date (YYYY-MM-DD) at UTC midnight, or null. Anything else —
 * prose dates, partial dates, impossible dates — is an extraction gap the
 * rules layer refuses to interpret, never a guess.
 */
function parseIsoDate(value: string | null): number | null {
  if (value === null || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const ms = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(ms)) return null;
  // Round-trip so a well-formed but impossible date (2026-02-30) is rejected
  // even on engines whose Date.parse is lenient.
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(ms);
  const roundTrips =
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day;
  return roundTrips ? ms : null;
}

function startOfUtcDay(date: Date): number {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

/**
 * Whole calendar days from today until the deadline — negative once the
 * deadline has passed, null when the deadline is absent or unreadable.
 */
export function daysUntil(deadline: string | null, today: Date): number | null {
  const deadlineMs = parseIsoDate(deadline);
  if (deadlineMs === null) return null;
  return Math.round((deadlineMs - startOfUtcDay(today)) / MS_PER_DAY);
}

/**
 * Rule 1 — duplicate line items. Within one document, the same code on the
 * same date of service appearing more than once is a duplicate; the same
 * code on a different date is not (separate encounters). Detection stays
 * per-document on purpose: a bill and its EOB legitimately repeat the same
 * codes across documents. Items whose code or date the extractor could not
 * read never group — an unprovable duplicate is not reported.
 */
export function detectDuplicateLineItems(lineItems: LineItem[]): Finding[] {
  const groups = new Map<string, LineItem[]>();
  for (const item of lineItems) {
    const code = item.code === null ? null : item.code.trim().toUpperCase();
    const date = item.date === null ? null : item.date.trim();
    if (!code || !date) continue;
    const key = `${code}|${date}`;
    const group = groups.get(key);
    if (group) {
      group.push(item);
    } else {
      groups.set(key, [item]);
    }
  }

  const findings: Finding[] = [];
  for (const [key, group] of groups) {
    if (group.length < 2) continue;
    const [code, date] = key.split("|");
    const extras = group.slice(1);
    // Savings = the billed amount of every occurrence after the first — the
    // charges you would dispute. If any extra lacks a billed amount the sum
    // is incomplete, so it stays null rather than understating.
    let savings: number | null = 0;
    for (const extra of extras) {
      if (extra.billed === null) {
        savings = null;
        break;
      }
      savings += extra.billed;
    }
    if (savings !== null) {
      savings = cents(savings) / 100;
    }
    findings.push(
      makeFinding(
        "duplicate",
        `Line item ${code} dated ${date} appears ${group.length} times in the same document — possible duplicate billing.`,
        savings,
        "high",
      ),
    );
  }
  return findings;
}

/**
 * Rule 2 — bill-vs-EOB mismatch. A bill and an EOB describe the same claim
 * only when their claim numbers agree; without that anchor the comparison
 * would cross-match unrelated claims, so nothing is reported. Two checks:
 * the family-facing one (a bill demanding more patient responsibility than
 * the EOB allows — the difference is the disputable amount) and a
 * reconciliation one (totals that disagree — a real discrepancy, but savings
 * are unknown until the amounts are reconciled).
 */
export function detectBillEobMismatches(documents: ExtractedDocument[]): Finding[] {
  const bills = documents.filter((d) => d.doc_type === "bill" || d.doc_type === "itemized");
  const eobs = documents.filter((d) => d.doc_type === "eob");
  const findings: Finding[] = [];
  for (const bill of bills) {
    for (const eob of eobs) {
      const billClaim = bill.claim_number === null ? null : bill.claim_number.trim();
      const eobClaim = eob.claim_number === null ? null : eob.claim_number.trim();
      if (!billClaim || !eobClaim || billClaim !== eobClaim) continue;

      const billOwes = bill.patient_responsibility;
      const eobOwes = eob.patient_responsibility;
      if (billOwes !== null && eobOwes !== null && cents(billOwes) > cents(eobOwes)) {
        const difference = cents(billOwes - eobOwes) / 100;
        findings.push(
          makeFinding(
            "bill_eob_mismatch",
            `The bill charges ${formatMoney(billOwes)} in patient responsibility, but the EOB for claim ${billClaim} allows ${formatMoney(eobOwes)} — dispute the ${formatMoney(difference)} difference.`,
            difference,
            "high",
          ),
        );
      }

      const billTotal = bill.total_billed;
      const eobTotal = eob.total_billed;
      if (billTotal !== null && eobTotal !== null && cents(billTotal) !== cents(eobTotal)) {
        findings.push(
          makeFinding(
            "bill_eob_mismatch",
            `The bill total ${formatMoney(billTotal)} does not match the EOB total ${formatMoney(eobTotal)} for claim ${billClaim} — reconcile the amounts before paying.`,
            null,
            "medium",
          ),
        );
      }
    }
  }
  return findings;
}

/** Distinct appeal deadlines across a case's documents, in extraction order. */
function uniqueDeadlines(documents: ExtractedDocument[]): string[] {
  return [
    ...new Set(
      documents
        .map((d) => d.appeal_deadline)
        .filter((deadline): deadline is string => deadline !== null),
    ),
  ];
}

function describeDeadline(date: string, days: number): string {
  if (days < 0) {
    const overdue = -days;
    return `The appeal deadline ${date} passed ${overdue} ${pluralDays(overdue)} ago — ask staff whether an appeal is still possible.`;
  }
  if (days === 0) {
    return `The appeal deadline ${date} is today — an appeal must go out immediately.`;
  }
  return `The appeal deadline ${date} is in ${days} ${pluralDays(days)} — an appeal must be submitted before then.`;
}

/**
 * Rule 3 — deadline proximity. Every extracted appeal deadline within
 * DEADLINE_WINDOW_DAYS of today (overdue included) becomes a finding.
 * Identical dates across documents are one clock, reported once.
 */
export function detectDeadlineProximity(documents: ExtractedDocument[], today: Date): Finding[] {
  const findings: Finding[] = [];
  for (const date of uniqueDeadlines(documents)) {
    const days = daysUntil(date, today);
    if (days === null || days > DEADLINE_WINDOW_DAYS) continue;
    findings.push(makeFinding("deadline_proximity", describeDeadline(date, days), null, "high"));
  }
  return findings;
}

/**
 * True when a treatment keyword appears in a denial reason, notes, or line
 * item description — the deterministic stand-in for "treatment-related
 * findings". The AI analyst (Layer B) may raise urgency the rules cannot
 * see; the rules layer only ever sees text.
 */
function isTreatmentRelated(documents: ExtractedDocument[]): boolean {
  return documents.some((doc) =>
    [doc.denial_reason, doc.notes, ...doc.line_items.map((item) => item.description)].some(
      (text) =>
        text !== null && TREATMENT_KEYWORDS.some((keyword) => text.toLowerCase().includes(keyword)),
    ),
  );
}

/**
 * Rule 4 — the urgent flag. Per the spec, urgency is set when an appeal
 * deadline is approaching AND the case is treatment-related (a delayed chemo
 * authorization is the canonical case). Without both signals the deadline
 * rule alone reports the clock; urgency needs the stakes.
 */
export function detectUrgentTreatment(documents: ExtractedDocument[], today: Date): Finding | null {
  if (!isTreatmentRelated(documents)) return null;

  let nearest: { date: string; days: number } | null = null;
  for (const date of uniqueDeadlines(documents)) {
    const days = daysUntil(date, today);
    if (days === null || days > URGENT_WINDOW_DAYS) continue;
    if (!nearest || days < nearest.days) nearest = { date, days };
  }
  if (!nearest) return null;

  const when =
    nearest.days < 0
      ? `passed ${-nearest.days} ${pluralDays(-nearest.days)} ago`
      : nearest.days === 0
        ? "is today"
        : `is in ${nearest.days} ${pluralDays(nearest.days)}`;
  return makeFinding(
    "urgent_treatment",
    `Urgent: treatment-related case with an appeal deadline of ${nearest.date} that ${when} — escalate to staff today.`,
    null,
    "high",
    true,
  );
}

/**
 * Runs every deterministic rule over a case's extracted documents. Pure:
 * the same documents and the same `today` always produce the same findings.
 */
export function runRules(documents: ExtractedDocument[], today: Date): Finding[] {
  const findings: Finding[] = documents.flatMap((doc) => detectDuplicateLineItems(doc.line_items));
  findings.push(...detectBillEobMismatches(documents));
  findings.push(...detectDeadlineProximity(documents, today));
  const urgent = detectUrgentTreatment(documents, today);
  if (urgent) findings.push(urgent);
  return findings;
}
