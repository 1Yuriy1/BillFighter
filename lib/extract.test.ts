import { describe, expect, it } from "vitest";
import {
  DOC_TYPES,
  EXTRACTION_SYSTEM_PROMPT,
  ExtractionError,
  findInventedValues,
  parseExtractedDocument,
  type ExtractedDocument,
} from "./extract";

/** A fully-populated valid extraction — tests null out what their fixture lacks. */
function validDocument(overrides: Partial<ExtractedDocument> = {}): ExtractedDocument {
  return {
    doc_type: "bill",
    patient_name: "Elena Marsh",
    provider_name: "Riverside Family Medicine",
    insurer_name: null,
    claim_number: null,
    service_dates: ["2026-08-01"],
    line_items: [
      {
        date: "2026-08-01",
        code: "99213",
        description: "Office visit",
        units: 1,
        billed: 150,
        allowed: null,
        paid: null,
        patient_owes: null,
      },
    ],
    total_billed: 150,
    patient_responsibility: null,
    denial_reason: null,
    appeal_deadline: null,
    network_status: "unknown",
    was_emergency: null,
    notes: "",
    ...overrides,
  };
}

/** Parses raw, returning the thrown ExtractionError; fails the test on success. */
function schemaErrorOrThrow(raw: unknown): ExtractionError {
  try {
    parseExtractedDocument(raw);
  } catch (error) {
    expect(error).toBeInstanceOf(ExtractionError);
    return error as ExtractionError;
  }
  throw new Error("expected schema_mismatch, but parsing succeeded");
}

describe("parseExtractedDocument", () => {
  it("accepts a valid extraction unchanged", () => {
    const doc = validDocument();
    expect(parseExtractedDocument(structuredClone(doc))).toEqual(doc);
  });

  it("accepts every doc_type in the contract, including reply", () => {
    for (const docType of DOC_TYPES) {
      expect(parseExtractedDocument({ ...validDocument({ doc_type: docType }) }).doc_type).toBe(
        docType,
      );
    }
  });

  it("rejects a non-object response", () => {
    expect(() => parseExtractedDocument("not an object")).toThrowError(ExtractionError);
    expect(() => parseExtractedDocument(null)).toThrowError(/not a JSON object/);
  });

  it("rejects a doc_type outside the contract", () => {
    const error = schemaErrorOrThrow({ ...validDocument(), doc_type: "invoice" });
    expect(error.code).toBe("schema_mismatch");
    expect(error.detail).toContain("doc_type");
  });

  it("rejects a string where a number belongs — hallucinated types never pass", () => {
    const error = schemaErrorOrThrow({
      ...validDocument({
        line_items: [
          {
            date: "2026-08-01",
            code: "99213",
            description: "Office visit",
            units: 1,
            billed: "N/A" as unknown as number,
            allowed: null,
            paid: null,
            patient_owes: null,
          },
        ],
      }),
    });
    expect(error.code).toBe("schema_mismatch");
    expect(error.detail).toContain("line_items[0].billed");
  });

  it("rejects a guessed deadline that is not an ISO date", () => {
    const error = schemaErrorOrThrow({ ...validDocument(), appeal_deadline: "within 180 days" });
    expect(error.detail).toContain("appeal_deadline");
  });

  it("rejects non-ISO entries in service_dates", () => {
    const error = schemaErrorOrThrow({ ...validDocument(), service_dates: ["08/01/2026"] });
    expect(error.detail).toContain("service_dates[0]");
  });

  it("rejects a null notes field — notes is an empty string when there is nothing to say", () => {
    const error = schemaErrorOrThrow({ ...validDocument(), notes: null });
    expect(error.detail).toContain("notes");
  });

  it("ignores unknown extra keys rather than failing on model verbosity", () => {
    const parsed = parseExtractedDocument({ ...validDocument(), confidence: 0.9 });
    expect(parsed.patient_name).toBe("Elena Marsh");
  });
});

describe("findInventedValues", () => {
  const source = [
    "RIVERSIDE FAMILY MEDICINE — STATEMENT",
    "Patient: Elena Marsh",
    "Date of Service: 08/01/2026",
    "CPT 99213 — Office visit ... $150.00",
    "Total Amount Due: $150.00",
  ].join("\n");

  it("finds nothing invented in a faithful extraction", () => {
    expect(findInventedValues(source, validDocument())).toEqual([]);
  });

  it("flags a total that appears nowhere in the document", () => {
    const doc = validDocument({ total_billed: 9999 });
    expect(findInventedValues(source, doc)).toEqual([{ field: "total_billed", value: "9999" }]);
  });

  it("matches money across formatting — $1,234.56 in text matches 1234.56", () => {
    const doc = validDocument({
      total_billed: 1234.56,
      line_items: [],
      service_dates: [],
    });
    const text = "Total billed: $1,234.56";
    expect(findInventedValues(text, doc)).toEqual([]);
  });

  it("flags a deadline the document never states — the computed-deadline trap", () => {
    const doc = validDocument({ appeal_deadline: "2027-02-16" });
    expect(findInventedValues(source, doc)).toEqual([
      { field: "appeal_deadline", value: "2027-02-16" },
    ]);
  });

  it("accepts a stated deadline in any common form", () => {
    // Only the deadline is populated: the tripwire checks every value against
    // the text, so anything else would be flagged against these mini-sources.
    const doc = validDocument({
      patient_name: null,
      provider_name: null,
      service_dates: [],
      line_items: [],
      total_billed: null,
      appeal_deadline: "2027-02-16",
    });
    for (const form of [
      "appeal by 2027-02-16",
      "appeal by 02/16/2027",
      "appeal by 2/16/2027",
      "appeal by February 16, 2027",
    ]) {
      expect(findInventedValues(form, doc)).toEqual([]);
    }
  });

  it("flags invented line-item values with their path", () => {
    const doc = validDocument({
      line_items: [
        {
          date: "2026-08-01",
          code: "99213",
          description: "Office visit",
          units: 1,
          billed: 150,
          allowed: 96,
          paid: null,
          patient_owes: null,
        },
      ],
    });
    const invented = findInventedValues(source, doc);
    expect(invented).toEqual([{ field: "line_items[0].allowed", value: "96" }]);
  });
});

describe("EXTRACTION_SYSTEM_PROMPT", () => {
  it("encodes the never-guess contract", () => {
    expect(EXTRACTION_SYSTEM_PROMPT).toMatch(/Never guess/);
    expect(EXTRACTION_SYSTEM_PROMPT).toMatch(/never estimate, prorate, or infer/);
    expect(EXTRACTION_SYSTEM_PROMPT).toMatch(/never compute or assume one/);
  });

  it("states every doc_type in the contract", () => {
    for (const docType of DOC_TYPES) {
      expect(EXTRACTION_SYSTEM_PROMPT).toContain(`"${docType}"`);
    }
  });
});
