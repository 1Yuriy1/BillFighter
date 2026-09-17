/**
 * The AI analyst (Layer B of the two-layer analysis; lib/rules.ts is the
 * deterministic Layer A). A stronger Claude model receives every extracted
 * document on the case, the rule findings, and the patient's plan terms, and
 * returns strict JSON: findings with evidence references, an ordered action
 * plan, and a plain-language summary written under the spec's no-jargon,
 * no-medical-advice constraint.
 *
 * The spec's hard rule: every finding's evidence must resolve to a real field
 * in an extracted document. A finding citing a document not on the case, a
 * field that does not exist, or a field with no value is rejected in full —
 * never softened, never repaired — and surfaces in rejectedFindings so staff
 * review sees exactly what the model tried to cite.
 */

import type { ExtractedDocument } from "./extract";
import type { Finding, FindingConfidence } from "./rules";
import { isMeaningfulValue, resolveField } from "./fieldPath";

/** Stronger model than extraction's haiku tier, per the spec; override with ANTHROPIC_MODEL. */
export const DEFAULT_ANALYST_MODEL = "claude-sonnet-4-5";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const MAX_OUTPUT_TOKENS = 8192;
const DEFAULT_TIMEOUT_MS = 60_000;

export const ANALYST_SYSTEM_PROMPT = `You are a medical billing analysis engine working for
patient advocates who help families challenge unfair medical bills. You are not a clinician:
you analyze billing, coverage, and paperwork — never medicine.

The user message is one JSON object: today (ISO date), the case's extracted documents (each
with an id and the structured extraction produced from it), the deterministic rule findings
already raised, and the patient's insurance plan terms.

Return ONLY a JSON object matching the schema below. No prose, no code fences.

Contract:
- findings: billing and coverage problems you can fully support with the documents. kind is
  open text; typical kinds: "price_outlier", "nsa_protected", "weak_denial",
  "missing_itemization", "network_surprise". Never restate a rule finding you were given —
  extend one only when you can add evidence it lacks.
- Every finding carries at least one evidence reference, and every reference must point at a
  field that exists with a non-null, non-empty value in one of the provided extracted
  documents: document_id plus a field path like "total_billed" or "line_items[2].billed".
  If you cannot point at the field, do not report the finding. A finding whose evidence is
  not in the documents is rejected in full — it is never repaired, softened, or kept.
- estimated_savings: a number only when you can compute it from values already in the
  documents (for example, billed minus allowed); null otherwise. Never guess a number.
- urgent: true only when a deadline or delay threatens ongoing treatment (an appeal window
  closing on an authorization for scheduled chemotherapy, for example). Money alone is
  never urgent.
- plan: the ordered action plan — what the family's advocate should do, most important
  first. Every step must be concrete and grounded in the findings and documents.
- summary: plain language for the family, at an eighth-grade reading level. Explain any
  insurance term you must use ("the EOB — the insurer's explanation of what it paid").
  Never use unexplained jargon.
- You never give medical or clinical advice: nothing about diagnoses, treatments,
  medications, or what care to seek. Billing, appeals, and coverage questions only. When a
  question needs a clinician, the plan says to ask the care team — nothing more specific.

Schema:
{
  "findings": [{ "kind": string, "description": string,
                 "estimated_savings": number | null, "confidence": "high" | "medium" | "low",
                 "urgent": boolean,
                 "evidence": [{ "document_id": string, "field": string, "quote": string | null }] }],
  "plan": [{ "title": string, "detail": string }],
  "summary": string
}`;

/** One extracted document with its database identity — evidence cites this id. */
export interface AnalyzedDocument {
  id: string;
  extracted: ExtractedDocument;
}

/** A pointer into an extracted document: which document, which field, what it says. */
export interface Evidence {
  document_id: string;
  /** Path into the extraction, e.g. "total_billed" or "line_items[2].billed". */
  field: string;
  /** Supporting text quoted from the document, for the evidence-highlight UI. */
  quote: string | null;
}

/** An AI finding, shaped for the findings table (source is always "ai"). */
export interface AiFinding {
  kind: string;
  description: string;
  estimated_savings: number | null;
  confidence: FindingConfidence;
  source: "ai";
  urgent: boolean;
  evidence: Evidence[];
}

export interface PlanStep {
  title: string;
  detail: string;
}

/** A finding the evidence hard rule rejected — surfaced, not silently dropped. */
export interface RejectedFinding {
  kind: string;
  description: string;
  evidence: Evidence[];
  /** Why the evidence does not resolve to a real extracted field. */
  reason: string;
}

export interface AnalystResult {
  findings: AiFinding[];
  /** Ordered action plan — array order is the execution order. */
  plan: PlanStep[];
  /** Plain-language summary, no jargon, no medical advice. */
  summary: string;
  rejectedFindings: RejectedFinding[];
}

export interface AnalyzeCaseInput {
  documents: AnalyzedDocument[];
  ruleFindings: Finding[];
  /** The patient's insurance plan terms (from the plan document or the profile). */
  planTerms: string;
  /** Today at the caller's clock, so deadline reasoning is testable and pure. */
  today: Date;
}

export interface AnalystOptions {
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
}

export type AnalysisErrorCode =
  "missing_api_key" | "api_error" | "empty_response" | "unparseable_json" | "schema_mismatch";

export class AnalysisError extends Error {
  readonly code: AnalysisErrorCode;
  readonly status: number | null;
  readonly detail: string | null;

  constructor(
    code: AnalysisErrorCode,
    message: string,
    options: { status?: number; detail?: string } = {},
  ) {
    super(message);
    this.name = "AnalysisError";
    this.code = code;
    this.status = options.status ?? null;
    this.detail = options.detail ?? null;
  }
}

export interface ParsedFinding {
  kind: string;
  description: string;
  estimated_savings: number | null;
  confidence: FindingConfidence;
  urgent: boolean;
  evidence: Evidence[];
}

export interface ParsedAnalystResponse {
  findings: ParsedFinding[];
  plan: PlanStep[];
  summary: string;
}

const CONFIDENCE_LEVELS: readonly FindingConfidence[] = ["high", "medium", "low"];

/**
 * Validates an unknown response against the strict analyst contract. Unknown
 * extra keys are ignored; known keys must match the schema exactly. This
 * checks structure only — evidence references are resolved against the case's
 * documents by analyzeCase, which rejects (not softens) any finding whose
 * citations do not resolve. Throws AnalysisError with a schema_mismatch code
 * on any structural deviation.
 */
export function parseAnalystResponse(raw: unknown): ParsedAnalystResponse {
  if (!isObjectLike(raw)) {
    throw new AnalysisError("schema_mismatch", "Analyst response is not a JSON object", {
      detail: `root: expected object, got ${describe(raw)}`,
    });
  }
  return {
    findings: parseFindings(raw.findings),
    plan: parsePlan(raw.plan),
    summary: nonEmptyString(raw.summary, "summary"),
  };
}

function parseFindings(value: unknown): ParsedFinding[] {
  if (!Array.isArray(value)) schemaFail("findings", "array", value);
  return value.map((entry, index) => {
    const field = `findings[${index}]`;
    if (!isObjectLike(entry)) schemaFail(field, "object", entry);
    return {
      kind: nonEmptyString(entry.kind, `${field}.kind`),
      description: nonEmptyString(entry.description, `${field}.description`),
      estimated_savings: nonNegativeNumberOrNull(
        entry.estimated_savings,
        `${field}.estimated_savings`,
      ),
      confidence: oneOf(entry.confidence, CONFIDENCE_LEVELS, `${field}.confidence`),
      urgent:
        typeof entry.urgent === "boolean"
          ? entry.urgent
          : schemaFail(`${field}.urgent`, "boolean", entry.urgent),
      evidence: parseEvidence(entry.evidence, `${field}.evidence`),
    };
  });
}

function parseEvidence(value: unknown, field: string): Evidence[] {
  if (!Array.isArray(value)) schemaFail(field, "array", value);
  return value.map((entry, index) => {
    const itemField = `${field}[${index}]`;
    if (!isObjectLike(entry)) schemaFail(itemField, "object", entry);
    return {
      document_id: nonEmptyString(entry.document_id, `${itemField}.document_id`),
      field: nonEmptyString(entry.field, `${itemField}.field`),
      quote: entry.quote === undefined ? null : stringOrNull(entry.quote, `${itemField}.quote`),
    };
  });
}

function parsePlan(value: unknown): PlanStep[] {
  if (!Array.isArray(value)) schemaFail("plan", "array", value);
  return value.map((entry, index) => {
    const field = `plan[${index}]`;
    if (!isObjectLike(entry)) schemaFail(field, "object", entry);
    return {
      title: nonEmptyString(entry.title, `${field}.title`),
      detail: nonEmptyString(entry.detail, `${field}.detail`),
    };
  });
}

export async function analyzeCase(
  input: AnalyzeCaseInput,
  options: AnalystOptions = {},
): Promise<AnalystResult> {
  const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new AnalysisError("missing_api_key", "ANTHROPIC_API_KEY is not set");
  }
  const model = options.model ?? process.env.ANTHROPIC_MODEL ?? DEFAULT_ANALYST_MODEL;

  const caseBrief = {
    today: input.today.toISOString().slice(0, 10),
    documents: input.documents.map((doc) => ({ id: doc.id, extracted: doc.extracted })),
    rule_findings: input.ruleFindings,
    plan_terms: input.planTerms,
  };

  let response: Response;
  try {
    // Production default; the E2E harness points ANTHROPIC_BASE_URL at the
    // recorded mock provider so CI never needs live Anthropic credentials.
    const apiUrl = process.env.ANTHROPIC_BASE_URL ?? ANTHROPIC_API_URL;
    response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model,
        max_tokens: MAX_OUTPUT_TOKENS,
        temperature: 0,
        system: ANALYST_SYSTEM_PROMPT,
        messages: [{ role: "user", content: JSON.stringify(caseBrief) }],
      }),
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (error) {
    throw new AnalysisError("api_error", "Anthropic API request failed", {
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    throw new AnalysisError("api_error", `Anthropic API returned ${response.status}`, {
      status: response.status,
      detail: bodyText.slice(0, 200),
    });
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    throw new AnalysisError("api_error", "Anthropic API returned invalid JSON", {
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  const text = messageText(payload);
  const raw = parseJsonLoose(text);
  const parsed = parseAnalystResponse(raw);

  const findings: AiFinding[] = [];
  const rejectedFindings: RejectedFinding[] = [];
  for (const finding of parsed.findings) {
    const reason = evidenceRejection(finding.evidence, input.documents);
    if (reason !== null) {
      rejectedFindings.push({
        kind: finding.kind,
        description: finding.description,
        evidence: finding.evidence,
        reason,
      });
      continue;
    }
    findings.push({ ...finding, source: "ai" });
  }

  return { findings, plan: parsed.plan, summary: parsed.summary, rejectedFindings };
}

/** Reason a finding's evidence fails the hard rule, or null when it all resolves. */
function evidenceRejection(evidence: Evidence[], documents: AnalyzedDocument[]): string | null {
  if (evidence.length === 0) {
    return "finding has no evidence references";
  }
  for (const reference of evidence) {
    const documentId = reference.document_id.trim();
    const doc = documents.find((candidate) => candidate.id === documentId);
    if (!doc) {
      return `cites document "${documentId}", which is not part of this case`;
    }
    const value = resolveField(doc.extracted, reference.field);
    if (!value.exists) {
      return `cites field "${reference.field}" which does not exist in document "${documentId}"`;
    }
    if (!isMeaningfulValue(value.value)) {
      return `cites field "${reference.field}" of document "${documentId}", which has no value`;
    }
  }
  return null;
}

function messageText(payload: unknown): string {
  if (!isObjectLike(payload) || !Array.isArray(payload.content)) {
    throw new AnalysisError("api_error", "Anthropic response has no content array");
  }
  const text = payload.content
    .filter(
      (block): block is { type: "text"; text: string } =>
        isObjectLike(block) && block.type === "text" && typeof block.text === "string",
    )
    .map((block) => block.text)
    .join("");
  if (text.trim() === "") {
    throw new AnalysisError("empty_response", "Anthropic response contained no text");
  }
  return text;
}

/** Parses the model's JSON, tolerating a fenced code block around it. */
function parseJsonLoose(text: string): unknown {
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    throw new AnalysisError("unparseable_json", "Analyst response was not valid JSON", {
      detail: trimmed.slice(0, 120),
    });
  }
}

function isObjectLike(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  switch (typeof value) {
    case "string":
      return `string ${JSON.stringify(truncate(value, 40))}`;
    case "number":
      return `number ${value}`;
    case "boolean":
      return `boolean ${value}`;
    case "undefined":
      return "undefined";
    default:
      return "object";
  }
}

function schemaFail(field: string, expected: string, got: unknown): never {
  throw new AnalysisError("schema_mismatch", "Analyst response failed schema validation", {
    detail: `${field}: expected ${expected}, got ${describe(got)}`,
  });
}

function stringOrNull(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string") schemaFail(field, "string or null", value);
  return value;
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    schemaFail(field, "non-empty string", value);
  }
  return value;
}

function nonNegativeNumberOrNull(value: unknown, field: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    schemaFail(field, "non-negative number or null", value);
  }
  return value;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    schemaFail(field, `one of ${allowed.join(", ")}`, value);
  }
  return value as T;
}
