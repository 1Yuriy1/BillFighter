import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_EXTRACTION_MODEL,
  DOC_TYPES,
  EXTRACTION_SYSTEM_PROMPT,
  ExtractionError,
  extractDocument,
  findInventedValues,
  parseExtractedDocument,
  type ExtractedDocument,
} from "./extract";
import { FIXTURES, type FixtureName } from "./fixtures/documents";

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

/**
 * What a faithful Claude response looks like for each fixture: only values
 * the document states, nulls everywhere else. The mocked API returns exactly
 * these, so every expectation is hand-auditable against the fixture text.
 */
const EXPECTED: Record<FixtureName, ExtractedDocument> = {
  cleanBill: {
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
        description: "Established patient office visit",
        units: 1,
        billed: 150,
        allowed: null,
        paid: null,
        patient_owes: null,
      },
      {
        date: "2026-08-01",
        code: "36415",
        description: "Venipuncture",
        units: 1,
        billed: 12,
        allowed: null,
        paid: null,
        patient_owes: null,
      },
    ],
    total_billed: 162,
    patient_responsibility: null,
    denial_reason: null,
    appeal_deadline: null,
    network_status: "unknown",
    was_emergency: null,
    notes: "",
  },
  itemizedBill: {
    doc_type: "itemized",
    patient_name: "Elena Marsh",
    provider_name: "St. Augustine Hospital",
    insurer_name: null,
    claim_number: null,
    service_dates: ["2026-07-02", "2026-07-03"],
    line_items: [
      {
        date: "2026-07-02",
        code: "45378",
        description: "Diagnostic colonoscopy",
        units: 1,
        billed: 1850,
        allowed: null,
        paid: null,
        patient_owes: null,
      },
      {
        date: "2026-07-02",
        code: "00811",
        description: "Anesthesia, colonoscopy, moderate",
        units: 1,
        billed: 640,
        allowed: null,
        paid: null,
        patient_owes: null,
      },
      {
        date: "2026-07-02",
        code: "J1885",
        description: "Ketorolac tromethamine injection 15mg",
        units: 2,
        billed: 76,
        allowed: null,
        paid: null,
        patient_owes: null,
      },
      {
        date: "2026-07-03",
        code: "99233",
        description: "Subsequent hospital care, high",
        units: 1,
        billed: 210,
        allowed: null,
        paid: null,
        patient_owes: null,
      },
    ],
    total_billed: 2776,
    patient_responsibility: null,
    denial_reason: null,
    appeal_deadline: null,
    network_status: "unknown",
    was_emergency: null,
    notes: "",
  },
  eob: {
    doc_type: "eob",
    patient_name: "Elena Marsh",
    provider_name: "Riverside Family Medicine",
    insurer_name: "Meridian Health Plan",
    claim_number: "CL-2026-118842",
    service_dates: ["2026-08-01"],
    line_items: [
      {
        date: "2026-08-01",
        code: "99213",
        description: "Established patient office visit",
        units: 1,
        billed: 150,
        allowed: 96,
        paid: 76.8,
        patient_owes: 19.2,
      },
      {
        date: "2026-08-01",
        code: "36415",
        description: "Venipuncture",
        units: 1,
        billed: 12,
        allowed: 12,
        paid: 9.6,
        patient_owes: 2.4,
      },
    ],
    total_billed: 162,
    patient_responsibility: 21.6,
    denial_reason: null,
    appeal_deadline: null,
    network_status: "in",
    was_emergency: null,
    notes: "",
  },
  denialLetter: {
    doc_type: "denial",
    patient_name: null,
    provider_name: null,
    insurer_name: "Meridian Health Plan",
    claim_number: "CL-2026-118842",
    service_dates: ["2026-08-02"],
    line_items: [
      {
        date: "2026-08-02",
        code: "72148",
        description: "MRI lumbar spine",
        units: 1,
        billed: 1950,
        allowed: null,
        paid: null,
        patient_owes: null,
      },
    ],
    // The letter names one service's billed amount but states no document
    // total — a missing total is an extraction gap, not a math error.
    total_billed: null,
    patient_responsibility: null,
    denial_reason: "Prior authorization was not obtained before the service was rendered",
    appeal_deadline: "2027-02-16",
    network_status: "unknown",
    was_emergency: null,
    notes: "",
  },
  blurryPhoto: {
    doc_type: "other",
    patient_name: null,
    provider_name: null,
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
    notes:
      "Patient name, service date, and amount due are illegible in the OCR output; document cannot be classified with confidence.",
  },
  multipageEob: {
    doc_type: "eob",
    patient_name: "Elena Marsh",
    provider_name: "Lakeview Radiology Associates",
    insurer_name: "Meridian Health Plan",
    claim_number: "CL-2026-120001",
    service_dates: ["2026-07-28"],
    line_items: [
      {
        date: "2026-07-28",
        code: "70450",
        description: "CT head or brain without contrast",
        units: 1,
        billed: 850,
        allowed: 410,
        paid: 328,
        patient_owes: 82,
      },
      {
        date: "2026-07-28",
        code: "72148",
        description: "MRI lumbar spine without contrast",
        units: 1,
        billed: 1050,
        allowed: 590,
        paid: 472,
        patient_owes: 118,
      },
      {
        date: "2026-07-28",
        code: "72158",
        description: "MRI lumbar spine with and without contrast",
        units: 1,
        billed: 1450,
        allowed: 780,
        paid: 624,
        patient_owes: 156,
      },
    ],
    total_billed: 4120,
    patient_responsibility: 436,
    denial_reason: null,
    appeal_deadline: null,
    network_status: "unknown",
    was_emergency: null,
    notes:
      "One line on page 2 could not be scanned; scanned line items do not cover the stated claim total.",
  },
  missingDeadlineDenial: {
    doc_type: "denial",
    patient_name: "Elena Marsh",
    provider_name: null,
    insurer_name: "Meridian Health Plan",
    claim_number: "CL-2026-121904",
    service_dates: ["2026-08-05"],
    line_items: [
      {
        date: "2026-08-05",
        code: "97110",
        description: "Physical therapy, lower back",
        units: 1,
        billed: 510,
        allowed: null,
        paid: null,
        patient_owes: null,
      },
    ],
    total_billed: null,
    patient_responsibility: null,
    denial_reason:
      "The plan has determined these services were not medically necessary under the terms of your coverage",
    appeal_deadline: null,
    network_status: "unknown",
    was_emergency: null,
    notes: "",
  },
};

/** Which fixtures describe a document whose line items reconcile to its total. */
const MATH_IMBALANCE: Partial<Record<FixtureName, { balanced: boolean; delta: number }>> = {
  multipageEob: { balanced: false, delta: -770 },
};

interface CapturedRequest {
  url: string;
  init: RequestInit;
}

/** Stubs global fetch with a canned Anthropic message; returns captured requests. */
function stubAnthropic(doc: ExtractedDocument): CapturedRequest[] {
  const requests: CapturedRequest[] = [];
  const response = new Response(
    JSON.stringify({ content: [{ type: "text", text: JSON.stringify(doc) }] }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    requests.push({ url: String(input), init: init ?? {} });
    return Promise.resolve(response);
  });
  return requests;
}

/** Stubs global fetch with a raw body/status pair for error-path tests. */
function stubAnthropicRaw(body: string, status = 200): void {
  vi.stubGlobal("fetch", () => Promise.resolve(new Response(body, { status })));
}

describe("extractDocument (mocked Anthropic API)", () => {
  beforeEach(() => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key-123");
    vi.stubEnv("ANTHROPIC_MODEL", undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  for (const fixtureName of Object.keys(FIXTURES) as FixtureName[]) {
    const fixture = FIXTURES[fixtureName];
    const imbalance = MATH_IMBALANCE[fixtureName];

    it(`extracts the ${fixture.name} into the strict contract`, async () => {
      stubAnthropic(EXPECTED[fixtureName]);
      const result = await extractDocument(fixture.text);
      expect(result.extracted).toEqual(EXPECTED[fixtureName]);
      expect(result.extracted.doc_type).toBe(EXPECTED[fixtureName].doc_type);
      // Every number and date came from the document — nothing invented:
      expect(findInventedValues(fixture.text, result.extracted)).toEqual([]);
      if (imbalance) {
        expect(result.mathCheck.needsHumanReview).toBe(true);
        expect(result.mathCheck.balanced).toBe(imbalance.balanced);
        expect(result.mathCheck.delta).toBe(imbalance.delta);
      } else {
        expect(result.mathCheck.needsHumanReview).toBe(false);
      }
    });
  }

  it("returns nulls where the blurry photo has no data — never guessing", async () => {
    stubAnthropic(EXPECTED.blurryPhoto);
    const result = await extractDocument(FIXTURES.blurryPhoto.text);
    expect(result.extracted.doc_type).toBe("other");
    for (const field of [
      "patient_name",
      "provider_name",
      "insurer_name",
      "claim_number",
      "total_billed",
      "patient_responsibility",
      "appeal_deadline",
      "denial_reason",
    ] as const) {
      expect(result.extracted[field]).toBeNull();
    }
    expect(result.extracted.service_dates).toEqual([]);
    expect(result.extracted.line_items).toEqual([]);
  });

  it("never invents an appeal deadline when the denial states none", async () => {
    stubAnthropic(EXPECTED.missingDeadlineDenial);
    const result = await extractDocument(FIXTURES.missingDeadlineDenial.text);
    expect(result.extracted.appeal_deadline).toBeNull();
  });

  it("surfaces hallucinated values through the fabricated-value tripwire", async () => {
    const fabricated = { ...EXPECTED.missingDeadlineDenial, appeal_deadline: "2026-11-01" };
    stubAnthropic(fabricated);
    const result = await extractDocument(FIXTURES.missingDeadlineDenial.text);
    expect(findInventedValues(FIXTURES.missingDeadlineDenial.text, result.extracted)).toEqual([
      { field: "appeal_deadline", value: "2026-11-01" },
    ]);
  });

  it("sends the document to the Anthropic Messages API under the strict contract", async () => {
    const requests = stubAnthropic(EXPECTED.cleanBill);
    await extractDocument(FIXTURES.cleanBill.text);
    expect(requests).toHaveLength(1);
    const { url, init } = requests[0];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("test-key-123");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe(DEFAULT_EXTRACTION_MODEL);
    expect(body.temperature).toBe(0);
    expect(body.system).toBe(EXTRACTION_SYSTEM_PROMPT);
    expect(body.messages).toEqual([{ role: "user", content: FIXTURES.cleanBill.text }]);
  });

  it("honors the ANTHROPIC_MODEL override", async () => {
    vi.stubEnv("ANTHROPIC_MODEL", "claude-sonnet-4-5");
    const requests = stubAnthropic(EXPECTED.cleanBill);
    await extractDocument(FIXTURES.cleanBill.text);
    const body = JSON.parse(String(requests[0].init.body));
    expect(body.model).toBe("claude-sonnet-4-5");
  });

  it("parses a reply wrapped in a fenced code block", async () => {
    const response = new Response(
      JSON.stringify({
        content: [
          { type: "text", text: "```json\n" + JSON.stringify(EXPECTED.cleanBill) + "\n```" },
        ],
      }),
      { status: 200 },
    );
    vi.stubGlobal("fetch", () => Promise.resolve(response));
    const result = await extractDocument(FIXTURES.cleanBill.text);
    expect(result.extracted).toEqual(EXPECTED.cleanBill);
  });

  it("throws missing_api_key when ANTHROPIC_API_KEY is unset", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", undefined);
    await expect(extractDocument(FIXTURES.cleanBill.text)).rejects.toMatchObject({
      code: "missing_api_key",
    });
  });

  it("throws api_error with the HTTP status on a 500", async () => {
    stubAnthropicRaw('{"error":{"type":"api_error","message":"boom"}}', 500);
    const error = await extractDocument(FIXTURES.cleanBill.text).catch((e) => e);
    expect(error).toBeInstanceOf(ExtractionError);
    expect(error.code).toBe("api_error");
    expect(error.status).toBe(500);
  });

  it("throws api_error when the request fails before a response arrives", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new Error("connection refused")));
    await expect(extractDocument(FIXTURES.cleanBill.text)).rejects.toMatchObject({
      code: "api_error",
    });
  });

  it("throws empty_response when the reply has no text blocks", async () => {
    stubAnthropicRaw(JSON.stringify({ content: [] }));
    await expect(extractDocument(FIXTURES.cleanBill.text)).rejects.toMatchObject({
      code: "empty_response",
    });
  });

  it("throws unparseable_json when the reply is prose instead of JSON", async () => {
    stubAnthropicRaw(
      JSON.stringify({
        content: [{ type: "text", text: "I'm sorry, I cannot help with that." }],
      }),
    );
    await expect(extractDocument(FIXTURES.cleanBill.text)).rejects.toMatchObject({
      code: "unparseable_json",
    });
  });

  it("throws schema_mismatch when the reply violates the contract", async () => {
    const bad = {
      ...EXPECTED.eob,
      line_items: [{ ...EXPECTED.eob.line_items[0], billed: "N/A" }],
    };
    stubAnthropicRaw(JSON.stringify({ content: [{ type: "text", text: JSON.stringify(bad) }] }));
    const error = await extractDocument(FIXTURES.eob.text).catch((e) => e);
    expect(error).toBeInstanceOf(ExtractionError);
    expect(error.code).toBe("schema_mismatch");
    expect(error.detail).toContain("line_items[0].billed");
  });
});
