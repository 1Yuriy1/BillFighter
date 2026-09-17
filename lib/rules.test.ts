import { describe, expect, it } from "vitest";
import type { ExtractedDocument, LineItem } from "./extract";
import {
  daysUntil,
  detectBillEobMismatches,
  detectDeadlineProximity,
  detectDuplicateLineItems,
  detectUrgentTreatment,
  runRules,
} from "./rules";

// Noon UTC so the date under test is Sep 17 regardless of how the engine
// normalizes the clock — the rules layer only ever sees whole UTC days.
const TODAY = new Date("2026-09-17T12:00:00Z");

const chemoDenial = {
  doc_type: "denial",
  denial_reason: "Prior authorization for chemotherapy not obtained",
} as const;

function lineItem(overrides: Partial<LineItem> = {}): LineItem {
  return {
    date: "2026-08-01",
    code: "99213",
    description: "Office visit",
    units: 1,
    billed: 150,
    allowed: null,
    paid: null,
    patient_owes: null,
    ...overrides,
  };
}

function document(overrides: Partial<ExtractedDocument> = {}): ExtractedDocument {
  return {
    doc_type: "bill",
    patient_name: "Test Patient",
    provider_name: "Test Provider",
    insurer_name: null,
    claim_number: null,
    service_dates: [],
    line_items: [],
    total_billed: null,
    patient_responsibility: null,
    denial_reason: null,
    appeal_deadline: null,
    network_status: "unknown",
    was_emergency: null,
    notes: "",
    ...overrides,
  };
}

describe("daysUntil", () => {
  it("counts whole calendar days from today to the deadline", () => {
    expect(daysUntil("2026-10-17", TODAY)).toBe(30);
    expect(daysUntil("2026-09-18", TODAY)).toBe(1);
  });

  it("goes negative once the deadline has passed", () => {
    expect(daysUntil("2026-09-14", TODAY)).toBe(-3);
  });

  it("returns null for dates the extractor could not read", () => {
    expect(daysUntil(null, TODAY)).toBe(null);
    expect(daysUntil("October 17", TODAY)).toBe(null);
    expect(daysUntil("2026-02-30", TODAY)).toBe(null);
  });
});

describe("detectDuplicateLineItems", () => {
  it("flags two line items with the same code and same date", () => {
    const findings = detectDuplicateLineItems([
      lineItem({ billed: 150 }),
      lineItem({ billed: 150 }),
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      kind: "duplicate",
      estimated_savings: 150,
      confidence: "high",
      source: "rule",
      urgent: false,
    });
    expect(findings[0]?.description).toContain("99213");
    expect(findings[0]?.description).toContain("2026-08-01");
  });

  it("does not flag the same code on a different date", () => {
    const findings = detectDuplicateLineItems([
      lineItem({ date: "2026-08-01" }),
      lineItem({ date: "2026-09-01" }),
    ]);
    expect(findings).toEqual([]);
  });

  it("does not flag different codes on the same date", () => {
    const findings = detectDuplicateLineItems([
      lineItem({ code: "99213" }),
      lineItem({ code: "99214", description: "Longer visit" }),
    ]);
    expect(findings).toEqual([]);
  });

  it("sums every extra occurrence beyond the first", () => {
    const findings = detectDuplicateLineItems([
      lineItem({ billed: 150 }),
      lineItem({ billed: 150 }),
      lineItem({ billed: 150 }),
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.estimated_savings).toBe(300);
    expect(findings[0]?.description).toContain("3 times");
  });

  it("leaves savings unknown when an extra occurrence has no billed amount", () => {
    const findings = detectDuplicateLineItems([
      lineItem({ billed: 150 }),
      lineItem({ billed: null, description: "Repeat entry, amount unreadable" }),
      lineItem({ billed: 150 }),
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.estimated_savings).toBe(null);
  });

  it("groups codes case- and whitespace-insensitively", () => {
    const findings = detectDuplicateLineItems([
      lineItem({ code: "J1234" }),
      lineItem({ code: "  j1234 ", description: "Injection" }),
    ]);
    expect(findings).toHaveLength(1);
  });

  it("never groups items with a missing code or date", () => {
    expect(detectDuplicateLineItems([lineItem({ code: null }), lineItem({ code: null })])).toEqual(
      [],
    );
    expect(detectDuplicateLineItems([lineItem({ date: null }), lineItem({ date: null })])).toEqual(
      [],
    );
  });

  it("detects duplicates per document, so a bill and its EOB never cross-match", () => {
    const findings = runRules(
      [
        document({
          doc_type: "eob",
          line_items: [lineItem({ billed: null, allowed: 120, paid: 100 })],
        }),
        document({ line_items: [lineItem({})] }),
      ],
      TODAY,
    );
    expect(findings).toEqual([]);
  });
});

describe("detectBillEobMismatches", () => {
  it("flags a bill demanding more patient responsibility than the EOB allows", () => {
    const findings = detectBillEobMismatches([
      document({ claim_number: "C-100", patient_responsibility: 4200 }),
      document({ doc_type: "eob", claim_number: "C-100", patient_responsibility: 1800 }),
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      kind: "bill_eob_mismatch",
      estimated_savings: 2400,
      confidence: "high",
      source: "rule",
    });
    expect(findings[0]?.description).toContain("C-100");
  });

  it("stays silent when the bill asks for no more than the EOB allows", () => {
    const findings = detectBillEobMismatches([
      document({ claim_number: "C-100", patient_responsibility: 1500 }),
      document({ doc_type: "eob", claim_number: "C-100", patient_responsibility: 1800 }),
    ]);
    expect(findings).toEqual([]);
  });

  it("does not compare documents for different claims", () => {
    const findings = detectBillEobMismatches([
      document({ claim_number: "C-100", patient_responsibility: 4200 }),
      document({ doc_type: "eob", claim_number: "C-200", patient_responsibility: 1800 }),
    ]);
    expect(findings).toEqual([]);
  });

  it("does not compare when a claim number is missing", () => {
    const findings = detectBillEobMismatches([
      document({ claim_number: null, patient_responsibility: 4200 }),
      document({ doc_type: "eob", claim_number: "C-100", patient_responsibility: 1800 }),
    ]);
    expect(findings).toEqual([]);
  });

  it("flags totals that disagree even when patient responsibility matches", () => {
    const findings = detectBillEobMismatches([
      document({ claim_number: "C-100", total_billed: 2500, patient_responsibility: 500 }),
      document({
        doc_type: "eob",
        claim_number: "C-100",
        total_billed: 2000,
        patient_responsibility: 500,
      }),
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      kind: "bill_eob_mismatch",
      estimated_savings: null,
      confidence: "medium",
    });
  });

  it("stays silent when bill and EOB agree", () => {
    const findings = detectBillEobMismatches([
      document({ claim_number: "C-100", total_billed: 3000, patient_responsibility: 1000 }),
      document({
        doc_type: "eob",
        claim_number: "C-100",
        total_billed: 3000,
        patient_responsibility: 1000,
      }),
    ]);
    expect(findings).toEqual([]);
  });
});

describe("detectDeadlineProximity", () => {
  it("fires at exactly 30 days (boundary)", () => {
    const findings = detectDeadlineProximity([document({ appeal_deadline: "2026-10-17" })], TODAY);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      kind: "deadline_proximity",
      estimated_savings: null,
      confidence: "high",
      source: "rule",
      urgent: false,
    });
    expect(findings[0]?.description).toContain("30 days");
  });

  it("stays silent at 31 days (boundary)", () => {
    const findings = detectDeadlineProximity([document({ appeal_deadline: "2026-10-18" })], TODAY);
    expect(findings).toEqual([]);
  });

  it("treats a deadline of today as immediate", () => {
    const findings = detectDeadlineProximity([document({ appeal_deadline: "2026-09-17" })], TODAY);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.description).toContain("today");
  });

  it("reports an overdue deadline as passed", () => {
    const findings = detectDeadlineProximity([document({ appeal_deadline: "2026-09-14" })], TODAY);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.description).toContain("passed 3 days ago");
  });

  it("reports each distinct deadline once", () => {
    const sameDeadlineTwice = [
      document({ appeal_deadline: "2026-10-01" }),
      document({ doc_type: "denial", appeal_deadline: "2026-10-01" }),
    ];
    expect(detectDeadlineProximity(sameDeadlineTwice, TODAY)).toHaveLength(1);

    const twoDeadlines = [
      document({ appeal_deadline: "2026-10-01" }),
      document({ doc_type: "denial", appeal_deadline: "2026-10-10" }),
    ];
    expect(detectDeadlineProximity(twoDeadlines, TODAY)).toHaveLength(2);
  });

  it("ignores unreadable deadlines", () => {
    expect(detectDeadlineProximity([document({ appeal_deadline: "coming soon" })], TODAY)).toEqual(
      [],
    );
  });
});

describe("detectUrgentTreatment", () => {
  it("fires at exactly 14 days when the case is treatment-related (boundary)", () => {
    const findings = detectUrgentTreatment(
      [document({ ...chemoDenial, appeal_deadline: "2026-10-01" })],
      TODAY,
    );
    expect(findings).not.toBe(null);
    expect(findings).toMatchObject({
      kind: "urgent_treatment",
      urgent: true,
      estimated_savings: null,
      source: "rule",
    });
    expect(findings?.description).toContain("2026-10-01");
    expect(findings?.description).toContain("14 days");
  });

  it("does not fire at 15 days (boundary)", () => {
    const findings = detectUrgentTreatment(
      [document({ ...chemoDenial, appeal_deadline: "2026-10-02" })],
      TODAY,
    );
    expect(findings).toBe(null);
  });

  it("does not fire on an approaching deadline without a treatment signal", () => {
    const findings = detectUrgentTreatment(
      [
        document({
          doc_type: "denial",
          denial_reason: "Missing referral form",
          appeal_deadline: "2026-10-01",
        }),
      ],
      TODAY,
    );
    expect(findings).toBe(null);
  });

  it("does not fire on treatment without an approaching deadline", () => {
    const findings = detectUrgentTreatment(
      [document({ ...chemoDenial, appeal_deadline: "2026-12-01" })],
      TODAY,
    );
    expect(findings).toBe(null);
  });

  it("treats an overdue deadline as urgent when treatment-related", () => {
    const findings = detectUrgentTreatment(
      [document({ ...chemoDenial, appeal_deadline: "2026-09-10" })],
      TODAY,
    );
    expect(findings).not.toBe(null);
    expect(findings?.urgent).toBe(true);
  });

  it("scans notes and line items for treatment signals, not just denial reasons", () => {
    const findings = detectUrgentTreatment(
      [
        document({
          line_items: [lineItem({ description: "Chemotherapy infusion — first hour" })],
          appeal_deadline: "2026-10-01",
        }),
      ],
      TODAY,
    );
    expect(findings).not.toBe(null);
  });
});

describe("runRules", () => {
  it("runs every rule and stamps source='rule' on each finding", () => {
    const findings = runRules(
      [
        document({
          claim_number: "C-100",
          patient_responsibility: 4200,
          line_items: [lineItem({}), lineItem({})],
        }),
        document({ doc_type: "eob", claim_number: "C-100", patient_responsibility: 1800 }),
        document({ ...chemoDenial, appeal_deadline: "2026-10-01" }),
      ],
      TODAY,
    );
    expect(findings.map((f) => f.kind)).toEqual([
      "duplicate",
      "bill_eob_mismatch",
      "deadline_proximity",
      "urgent_treatment",
    ]);
    expect(findings.every((f) => f.source === "rule")).toBe(true);
  });

  it("returns no findings for a clean case", () => {
    const findings = runRules([document({ line_items: [lineItem({})] })], TODAY);
    expect(findings).toEqual([]);
  });
});
