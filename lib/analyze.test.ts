import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ANALYST_SYSTEM_PROMPT,
  AnalysisError,
  DEFAULT_ANALYST_MODEL,
  analyzeCase,
  parseAnalystResponse,
  type AnalyzeCaseInput,
} from "./analyze";
import {
  ANALYST_DOCUMENTS,
  CONTAMINATED_RESPONSE,
  PLAN_TERMS,
  TODAY,
  VALID_RESPONSE,
} from "./fixtures/analyst";
import type { ExtractedDocument } from "./extract";
import { runRules } from "./rules";

function caseInput(overrides: Partial<AnalyzeCaseInput> = {}): AnalyzeCaseInput {
  return {
    documents: ANALYST_DOCUMENTS,
    ruleFindings: runRules(
      ANALYST_DOCUMENTS.map((doc) => doc.extracted),
      TODAY,
    ),
    planTerms: PLAN_TERMS,
    today: TODAY,
    ...overrides,
  };
}

interface CapturedRequest {
  url: string;
  init: RequestInit;
}

/** Stubs global fetch with a canned analyst message; returns captured requests. */
function stubAnalyst(payload: unknown): CapturedRequest[] {
  const requests: CapturedRequest[] = [];
  const response = new Response(
    JSON.stringify({ content: [{ type: "text", text: JSON.stringify(payload) }] }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    requests.push({ url: String(input), init: init ?? {} });
    return Promise.resolve(response);
  });
  return requests;
}

/** Stubs global fetch with a raw body/status pair for error-path tests. */
function stubRaw(body: string, status = 200): void {
  vi.stubGlobal("fetch", () => Promise.resolve(new Response(body, { status })));
}

/** Parses raw, returning the thrown AnalysisError; fails the test on success. */
function schemaErrorOrThrow(raw: unknown): AnalysisError {
  try {
    parseAnalystResponse(raw);
  } catch (error) {
    expect(error).toBeInstanceOf(AnalysisError);
    return error as AnalysisError;
  }
  throw new Error("expected schema_mismatch, but parsing succeeded");
}

describe("parseAnalystResponse (structured-output validation)", () => {
  it("accepts the valid recorded response unchanged", () => {
    const parsed = parseAnalystResponse(structuredClone(VALID_RESPONSE));
    expect(parsed.findings).toHaveLength(2);
    expect(parsed.findings[0]).toEqual(VALID_RESPONSE.findings[0]);
    expect(parsed.plan).toEqual(VALID_RESPONSE.plan);
    expect(parsed.summary).toBe(VALID_RESPONSE.summary);
  });

  it("accepts an empty analysis — no new findings is a legitimate answer", () => {
    const parsed = parseAnalystResponse({ findings: [], plan: [], summary: "Nothing new." });
    expect(parsed.findings).toEqual([]);
    expect(parsed.plan).toEqual([]);
  });

  it("accepts an urgent finding — the analyst may raise urgency the rules cannot see", () => {
    const parsed = parseAnalystResponse({
      ...VALID_RESPONSE,
      findings: [{ ...VALID_RESPONSE.findings[0], urgent: true }],
    });
    expect(parsed.findings[0].urgent).toBe(true);
  });

  it("ignores unknown extra keys — source is forced at the analyzeCase layer", () => {
    expect(() =>
      parseAnalystResponse({
        ...VALID_RESPONSE,
        findings: [{ ...VALID_RESPONSE.findings[0], source: "rule" }],
      }),
    ).not.toThrow();
  });

  it("rejects a non-object response", () => {
    expect(() => parseAnalystResponse("not an object")).toThrowError(AnalysisError);
    expect(() => parseAnalystResponse(null)).toThrowError(/not a JSON object/);
  });

  it("rejects a missing or empty summary", () => {
    const error = schemaErrorOrThrow({ ...structuredClone(VALID_RESPONSE), summary: "" });
    expect(error.code).toBe("schema_mismatch");
    expect(error.detail).toContain("summary");
  });

  it("rejects a confidence outside the three levels", () => {
    const error = schemaErrorOrThrow({
      ...VALID_RESPONSE,
      findings: [{ ...VALID_RESPONSE.findings[0], confidence: "certain" }],
    });
    expect(error.detail).toContain("confidence");
  });

  it("rejects a negative or non-finite estimated_savings — savings are never guessed", () => {
    const error = schemaErrorOrThrow({
      ...VALID_RESPONSE,
      findings: [{ ...VALID_RESPONSE.findings[0], estimated_savings: -5 }],
    });
    expect(error.detail).toContain("estimated_savings");
    const error2 = schemaErrorOrThrow({
      ...VALID_RESPONSE,
      findings: [{ ...VALID_RESPONSE.findings[0], estimated_savings: Number.POSITIVE_INFINITY }],
    });
    expect(error2.detail).toContain("estimated_savings");
  });

  it("rejects a non-boolean urgent", () => {
    const error = schemaErrorOrThrow({
      ...VALID_RESPONSE,
      findings: [{ ...VALID_RESPONSE.findings[0], urgent: "yes" }],
    });
    expect(error.detail).toContain("urgent");
  });

  it("rejects evidence that is not an array", () => {
    const error = schemaErrorOrThrow({
      ...VALID_RESPONSE,
      findings: [{ ...VALID_RESPONSE.findings[0], evidence: "nowhere" }],
    });
    expect(error.detail).toContain("evidence");
  });

  it("rejects evidence entries without a document and field", () => {
    const error = schemaErrorOrThrow({
      ...VALID_RESPONSE,
      findings: [
        {
          ...VALID_RESPONSE.findings[0],
          evidence: [...VALID_RESPONSE.findings[0].evidence, {}],
        },
      ],
    });
    expect(error.detail).toContain("document_id");
  });

  it("rejects a plan step with an empty title", () => {
    const error = schemaErrorOrThrow({
      ...VALID_RESPONSE,
      plan: [{ title: "", detail: "Do the thing." }],
    });
    expect(error.detail).toContain("title");
  });

  it("rejects missing top-level keys", () => {
    expect(schemaErrorOrThrow({ plan: [], summary: "s" }).detail).toContain("findings");
    expect(schemaErrorOrThrow({ findings: [], summary: "s" }).detail).toContain("plan");
  });
});

describe("analyzeCase (mocked Anthropic API)", () => {
  let captured: CapturedRequest[] = [];

  beforeEach(() => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key-123");
    vi.stubEnv("ANTHROPIC_MODEL", undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("returns findings marked source 'ai' with evidence intact, plan in order, summary verbatim", async () => {
    captured = stubAnalyst(VALID_RESPONSE);
    const result = await analyzeCase(caseInput());

    expect(result.rejectedFindings).toEqual([]);
    expect(result.findings.map((f) => f.kind)).toEqual(["nsa_protected", "cost_share_error"]);
    expect(result.findings.every((f) => f.source === "ai")).toBe(true);
    expect(result.findings[0].evidence).toHaveLength(3);
    expect(result.findings[0].evidence[0]).toEqual({
      document_id: "doc-bill-1",
      field: "patient_responsibility",
      quote: "Statement says charges may not reflect insurance adjustments.",
    });
    expect(result.plan.map((step) => step.title)).toEqual([
      "Dispute the out-of-network balance in writing",
      "Ask Meridian to confirm the cost-share basis",
      "Hold payment until the dispute resolves",
    ]);
    expect(result.summary).toBe(VALID_RESPONSE.summary);
    expect(captured).toHaveLength(1);
  });

  it("sends the case brief — documents, rule findings, plan terms, today — under the analyst prompt", async () => {
    captured = stubAnalyst(VALID_RESPONSE);
    await analyzeCase(caseInput());

    const body = JSON.parse(captured[0].init.body as string);
    expect(captured[0].url).toBe("https://api.anthropic.com/v1/messages");
    expect(body.model).toBe(DEFAULT_ANALYST_MODEL);
    expect(body.temperature).toBe(0);
    expect(body.system).toBe(ANALYST_SYSTEM_PROMPT);
    const headers = captured[0].init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("test-key-123");

    const brief = JSON.parse(body.messages[0].content);
    expect(brief.today).toBe("2026-09-17");
    expect(brief.documents.map((doc: { id: string }) => doc.id)).toEqual([
      "doc-bill-1",
      "doc-eob-1",
      "doc-plan-1",
    ]);
    // Real output of the Layer-A rules over the fixture documents:
    expect(brief.rule_findings.map((f: { kind: string }) => f.kind)).toEqual([
      "bill_eob_mismatch",
      "deadline_proximity",
    ]);
    expect(brief.plan_terms).toBe(PLAN_TERMS);
  });

  it("honors the ANTHROPIC_MODEL override", async () => {
    vi.stubEnv("ANTHROPIC_MODEL", "test-model-override");
    captured = stubAnalyst(VALID_RESPONSE);
    await analyzeCase(caseInput());
    expect(JSON.parse(captured[0].init.body as string).model).toBe("test-model-override");
  });

  it("rejects (not softens) findings whose evidence cites a document outside the case", async () => {
    stubAnalyst(CONTAMINATED_RESPONSE);
    const result = await analyzeCase(caseInput());

    const rejected = result.rejectedFindings.map((f) => f.kind);
    expect(rejected).toEqual([
      "price_outlier",
      "phantom_discount",
      "deadline_extension",
      "unsupported_claim",
      "proto_probe",
    ]);
    expect(result.rejectedFindings[0].reason).toContain("not part of this case");
    expect(result.findings.map((f) => f.kind)).toEqual(["nsa_protected"]);
  });

  it("names the document and field in each rejection reason", async () => {
    stubAnalyst(CONTAMINATED_RESPONSE);
    const result = await analyzeCase(caseInput());

    const byKind = new Map(result.rejectedFindings.map((f) => [f.kind, f.reason]));
    expect(byKind.get("phantom_discount")).toContain('does not exist in document "doc-eob-1"');
    expect(byKind.get("deadline_extension")).toContain("has no value");
    expect(byKind.get("deadline_extension")).toContain("appeal_deadline");
    expect(byKind.get("unsupported_claim")).toContain("no evidence references");
    // The prototype-traversal probe resolves to nothing and is rejected:
    expect(byKind.get("proto_probe")).toContain('does not exist in document "doc-bill-1"');
  });

  it("rejects every finding when no citation resolves, keeping the plan and summary", async () => {
    const allBad = {
      findings: [CONTAMINATED_RESPONSE.findings[1], CONTAMINATED_RESPONSE.findings[4]],
      plan: VALID_RESPONSE.plan,
      summary: VALID_RESPONSE.summary,
    };
    stubAnalyst(allBad);
    const result = await analyzeCase(caseInput());

    expect(result.findings).toEqual([]);
    expect(result.rejectedFindings).toHaveLength(2);
    expect(result.plan).toEqual(VALID_RESPONSE.plan);
    expect(result.summary).toBe(VALID_RESPONSE.summary);
  });

  it("throws missing_api_key when no key is configured", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", undefined);
    const error = await analyzeCase(caseInput()).catch((e) => e);
    expect(error).toBeInstanceOf(AnalysisError);
    expect(error.code).toBe("missing_api_key");
  });

  it("wraps an API error status with the status code", async () => {
    stubRaw("boom", 500);
    const error = await analyzeCase(caseInput()).catch((e) => e);
    expect(error.code).toBe("api_error");
    expect(error.status).toBe(500);
  });

  it("wraps a network failure", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new Error("connection refused")));
    const error = await analyzeCase(caseInput()).catch((e) => e);
    expect(error.code).toBe("api_error");
    expect(error.detail).toContain("connection refused");
  });

  it("reports empty_response when the API returns no text", async () => {
    stubRaw(JSON.stringify({ content: [] }));
    const error = await analyzeCase(caseInput()).catch((e) => e);
    expect(error.code).toBe("empty_response");
  });

  it("reports unparseable_json when the model returns prose instead of JSON", async () => {
    stubRaw(JSON.stringify({ content: [{ type: "text", text: "Here is what I think..." }] }));
    const error = await analyzeCase(caseInput()).catch((e) => e);
    expect(error.code).toBe("unparseable_json");
  });

  it("reports schema_mismatch when the model response breaks the contract", async () => {
    stubAnalyst({ findings: "everything is fine", plan: [], summary: "s" });
    const error = await analyzeCase(caseInput()).catch((e) => e);
    expect(error.code).toBe("schema_mismatch");
    expect(error.detail).toContain("findings");
  });
});

describe("prompt-eval: evidence and advice language", () => {
  /** Independent path walk for the eval — deliberately simple, own-property only. */
  function fieldValue(document: ExtractedDocument, field: string): unknown {
    let cursor: unknown = document;
    for (const part of field.split(".")) {
      const match = /^([A-Za-z_][A-Za-z0-9_]*)(?:\[(\d+)\])?$/.exec(part);
      if (!match) return undefined;
      if (cursor === null || typeof cursor !== "object" || !(match[1] in cursor)) return undefined;
      cursor = (cursor as Record<string, unknown>)[match[1]];
      if (match[2] !== undefined) {
        if (!Array.isArray(cursor)) return undefined;
        cursor = cursor[Number(match[2])];
      }
    }
    return cursor;
  }

  /** True when the value can support a claim: present and not empty. */
  function supports(value: unknown): boolean {
    if (value === null || value === undefined) return false;
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === "string") return value.trim() !== "";
    return true;
  }

  const BLOCKED_ADVICE_PHRASES = [
    "talk to your doctor",
    "ask your doctor",
    "see a doctor",
    "see your doctor",
    "seek medical",
    "emergency room",
    "go to the er",
    "stop taking",
    "start taking",
    "dosage",
    "prescri",
    "diagnos",
    "prognosis",
  ];
  const BLOCKED_ADVICE_PATTERNS: RegExp[] = [
    /\byou should (take|stop|skip)\b/i,
    /\btake your (medication|medicine)\b/i,
  ];

  /** Advice-style language hits in one text — empty when clean. */
  function findAdviceLanguage(text: string): string[] {
    const hits = BLOCKED_ADVICE_PHRASES.filter((phrase) => text.toLowerCase().includes(phrase));
    for (const pattern of BLOCKED_ADVICE_PATTERNS) {
      if (pattern.test(text)) hits.push(pattern.source);
    }
    return hits;
  }

  /** Every analyst-authored sentence in a recorded response, evidence quotes excluded. */
  function authoredTexts(response: RecordedResponse): string[] {
    return [
      ...response.findings.map((finding) => finding.description),
      ...response.plan.flatMap((step) => [step.title, step.detail]),
      response.summary,
    ];
  }

  interface RecordedResponse {
    findings: readonly { description: string }[];
    plan: readonly { title: string; detail: string }[];
    summary: string;
  }

  beforeEach(() => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key-123");
    vi.stubEnv("ANTHROPIC_MODEL", undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("every valid-recording finding cites an existing, non-empty extracted field", async () => {
    stubAnalyst(VALID_RESPONSE);
    const result = await analyzeCase(caseInput());

    expect(result.findings.length).toBeGreaterThan(0);
    for (const finding of result.findings) {
      expect(finding.evidence.length).toBeGreaterThan(0);
      for (const reference of finding.evidence) {
        const doc = ANALYST_DOCUMENTS.find((candidate) => candidate.id === reference.document_id);
        if (!doc) {
          throw new Error(`eval: evidence cites unknown document ${reference.document_id}`);
        }
        expect(supports(fieldValue(doc.extracted, reference.field))).toBe(true);
      }
    }
    // The module's own resolver agrees — nothing was filtered:
    expect(result.rejectedFindings).toEqual([]);
  });

  it("no valid-recording text contains advice-style language", () => {
    const violations = authoredTexts(VALID_RESPONSE).flatMap((text) => findAdviceLanguage(text));
    expect(violations).toEqual([]);
  });

  it("the contaminated recording's bad citations are all caught — nothing softens through", async () => {
    stubAnalyst(CONTAMINATED_RESPONSE);
    const result = await analyzeCase(caseInput());

    const rejectedKinds = result.rejectedFindings.map((f) => f.kind);
    const keptKinds = result.findings.map((f) => f.kind);
    for (const bad of [
      "price_outlier",
      "phantom_discount",
      "deadline_extension",
      "unsupported_claim",
      "proto_probe",
    ]) {
      expect(rejectedKinds).toContain(bad);
      expect(keptKinds).not.toContain(bad);
    }
    // Advice-language discipline applies to contaminated text too:
    expect(authoredTexts(CONTAMINATED_RESPONSE).flatMap((t) => findAdviceLanguage(t))).toEqual([]);
  });
});
