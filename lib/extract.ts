/**
 * The extraction contract from the BillFighter MVP spec: Claude reads a
 * document's OCR text and returns strict JSON — nulls for absent values,
 * never guessed numbers. The raw response is schema-validated before it
 * reaches callers, and a fabricated-value tripwire cross-checks every number
 * and date against the source text. Math verification lives in mathCheck.ts.
 */
import { verifyMath, type MathCheck } from "./mathCheck";

export const DOC_TYPES = ["bill", "itemized", "eob", "denial", "plan", "reply", "other"] as const;

export type DocType = (typeof DOC_TYPES)[number];

export const NETWORK_STATUSES = ["in", "out", "unknown"] as const;

export type NetworkStatus = (typeof NETWORK_STATUSES)[number];

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
  doc_type: DocType;
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
  network_status: NetworkStatus;
  was_emergency: boolean | null;
  notes: string;
}

export interface ExtractionResult {
  extracted: ExtractedDocument;
  mathCheck: MathCheck;
}

/** Fast, cheap model per the spec; override with ANTHROPIC_MODEL. */
export const DEFAULT_EXTRACTION_MODEL = "claude-haiku-4-5";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const MAX_OUTPUT_TOKENS = 4096;
const DEFAULT_TIMEOUT_MS = 30_000;

export const EXTRACTION_SYSTEM_PROMPT = `You are a medical billing document extraction engine. You read OCR text from
medical bills, itemized statements, EOBs, denial letters, insurance plan
documents, and insurer replies, and you return a single JSON object.

Contract:
- Return ONLY a JSON object matching the schema below. No prose, no code fences.
- Every field is either present (copied from the document) or null. Never guess.
- Numbers: copy exactly what the document states. If a value is missing,
  illegible, or not stated, use null — never estimate, prorate, or infer.
- Dates: ISO 8601 (YYYY-MM-DD). If the document states no appeal deadline,
  appeal_deadline is null — never compute or assume one from relative wording.
- doc_type: "bill" (provider bill or statement), "itemized" (itemized statement
  with line-level detail), "eob" (explanation of benefits), "denial" (denial or
  adverse benefit determination), "plan" (insurance plan or policy document),
  "reply" (other insurer correspondence responding to a claim or appeal), or
  "other" when the document cannot be confidently classified.
- network_status: "in", "out", or "unknown" — "unknown" unless the document
  states network status.
- was_emergency: true or false only if the document states it; otherwise null.
- service_dates: [] when none are stated.
- notes: briefly quote anything ambiguous, illegible, or worth a reviewer's
  attention; empty string if nothing.

Schema:
{
  "doc_type": "bill" | "itemized" | "eob" | "denial" | "plan" | "reply" | "other",
  "patient_name": string | null,
  "provider_name": string | null,
  "insurer_name": string | null,
  "claim_number": string | null,
  "service_dates": string[],
  "line_items": [{ "date": string | null, "code": string | null,
                   "description": string, "units": number | null,
                   "billed": number | null, "allowed": number | null,
                   "paid": number | null, "patient_owes": number | null }],
  "total_billed": number | null,
  "patient_responsibility": number | null,
  "denial_reason": string | null,
  "appeal_deadline": string | null,
  "network_status": "in" | "out" | "unknown",
  "was_emergency": boolean | null,
  "notes": string
}`;

export type ExtractionErrorCode =
  "missing_api_key" | "api_error" | "empty_response" | "unparseable_json" | "schema_mismatch";

export class ExtractionError extends Error {
  readonly code: ExtractionErrorCode;
  readonly status: number | null;
  readonly detail: string | null;

  constructor(
    code: ExtractionErrorCode,
    message: string,
    options: { status?: number; detail?: string } = {},
  ) {
    super(message);
    this.name = "ExtractionError";
    this.code = code;
    this.status = options.status ?? null;
    this.detail = options.detail ?? null;
  }
}

export interface ExtractDocumentOptions {
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
}

/**
 * Extracts a structured document from OCR text via the Anthropic Messages API
 * and runs the math check on the result. Throws ExtractionError on any
 * failure — missing key, API error, or a response that fails the strict
 * schema. Callers should run findInventedValues on the result and route any
 * hit to human review.
 */
export async function extractDocument(
  documentText: string,
  options: ExtractDocumentOptions = {},
): Promise<ExtractionResult> {
  const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new ExtractionError("missing_api_key", "ANTHROPIC_API_KEY is not set");
  }
  const model = options.model ?? process.env.ANTHROPIC_MODEL ?? DEFAULT_EXTRACTION_MODEL;

  let response: Response;
  try {
    response = await fetch(ANTHROPIC_API_URL, {
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
        system: EXTRACTION_SYSTEM_PROMPT,
        messages: [{ role: "user", content: documentText }],
      }),
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (error) {
    throw new ExtractionError("api_error", "Anthropic API request failed", {
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    throw new ExtractionError("api_error", `Anthropic API returned ${response.status}`, {
      status: response.status,
      detail: bodyText.slice(0, 200),
    });
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    throw new ExtractionError("api_error", "Anthropic API returned invalid JSON", {
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  const text = messageText(payload);
  const raw = parseJsonLoose(text);
  const extracted = parseExtractedDocument(raw);
  return { extracted, mathCheck: verifyMath(extracted.line_items, extracted.total_billed) };
}

/** Joins the text blocks of an Anthropic message response. */
function messageText(payload: unknown): string {
  if (!isObjectLike(payload) || !Array.isArray(payload.content)) {
    throw new ExtractionError("api_error", "Anthropic response has no content array");
  }
  const text = payload.content
    .filter(
      (block): block is { type: "text"; text: string } =>
        isObjectLike(block) && block.type === "text" && typeof block.text === "string",
    )
    .map((block) => block.text)
    .join("");
  if (text.trim() === "") {
    throw new ExtractionError("empty_response", "Anthropic response contained no text");
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
    throw new ExtractionError("unparseable_json", "Extraction response was not valid JSON", {
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
  throw new ExtractionError("schema_mismatch", "Extraction response failed schema validation", {
    detail: `${field}: expected ${expected}, got ${describe(got)}`,
  });
}

function stringOrNull(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string") schemaFail(field, "string or null", value);
  return value;
}

function numberOrNull(value: unknown, field: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    schemaFail(field, "number or null", value);
  }
  return value;
}

function booleanOrNull(value: unknown, field: string): boolean | null {
  if (value === null) return null;
  if (typeof value !== "boolean") schemaFail(field, "boolean or null", value);
  return value;
}

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function isoDateOrNull(value: unknown, field: string): string | null {
  const str = stringOrNull(value, field);
  if (str === null) return null;
  if (!isIsoDate(str)) schemaFail(field, "ISO date (YYYY-MM-DD) or null", str);
  return str;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    schemaFail(field, `one of ${allowed.join(", ")}`, value);
  }
  return value as T;
}

function parseLineItems(value: unknown, field: string): LineItem[] {
  if (!Array.isArray(value)) schemaFail(field, "array", value);
  return value.map((entry, index) => {
    const itemField = `${field}[${index}]`;
    if (!isObjectLike(entry)) schemaFail(itemField, "object", entry);
    return {
      date: isoDateOrNull(entry.date, `${itemField}.date`),
      code: stringOrNull(entry.code, `${itemField}.code`),
      description:
        typeof entry.description === "string"
          ? entry.description
          : schemaFail(`${itemField}.description`, "string", entry.description),
      units: numberOrNull(entry.units, `${itemField}.units`),
      billed: numberOrNull(entry.billed, `${itemField}.billed`),
      allowed: numberOrNull(entry.allowed, `${itemField}.allowed`),
      paid: numberOrNull(entry.paid, `${itemField}.paid`),
      patient_owes: numberOrNull(entry.patient_owes, `${itemField}.patient_owes`),
    };
  });
}

function parseIsoDateArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) schemaFail(field, "array", value);
  return value.map((entry, index) => {
    if (typeof entry !== "string") schemaFail(`${field}[${index}]`, "string", entry);
    if (!isIsoDate(entry)) schemaFail(`${field}[${index}]`, "ISO date (YYYY-MM-DD)", entry);
    return entry;
  });
}

/**
 * Validates an unknown response against the strict extraction contract.
 * Unknown extra keys are ignored; known keys must match the schema exactly.
 * Throws ExtractionError with a schema_mismatch code on any deviation.
 */
export function parseExtractedDocument(raw: unknown): ExtractedDocument {
  if (!isObjectLike(raw)) {
    throw new ExtractionError("schema_mismatch", "Extraction response is not a JSON object", {
      detail: `root: expected object, got ${describe(raw)}`,
    });
  }
  return {
    doc_type: oneOf(raw.doc_type, DOC_TYPES, "doc_type"),
    patient_name: stringOrNull(raw.patient_name, "patient_name"),
    provider_name: stringOrNull(raw.provider_name, "provider_name"),
    insurer_name: stringOrNull(raw.insurer_name, "insurer_name"),
    claim_number: stringOrNull(raw.claim_number, "claim_number"),
    service_dates: parseIsoDateArray(raw.service_dates, "service_dates"),
    line_items: parseLineItems(raw.line_items, "line_items"),
    total_billed: numberOrNull(raw.total_billed, "total_billed"),
    patient_responsibility: numberOrNull(raw.patient_responsibility, "patient_responsibility"),
    denial_reason: stringOrNull(raw.denial_reason, "denial_reason"),
    appeal_deadline: isoDateOrNull(raw.appeal_deadline, "appeal_deadline"),
    network_status: oneOf(raw.network_status, NETWORK_STATUSES, "network_status"),
    was_emergency: booleanOrNull(raw.was_emergency, "was_emergency"),
    notes: typeof raw.notes === "string" ? raw.notes : schemaFail("notes", "string", raw.notes),
  };
}

export interface InventedValue {
  /** Path into the extraction, e.g. "total_billed" or "line_items[2].billed". */
  field: string;
  /** The value as extracted, in string form. */
  value: string;
}

const MONTH_NAMES = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
] as const;

/**
 * Cross-checks every number and date in an extraction against the source
 * text. A value that appears nowhere in the document was invented, not
 * extracted — this catches hallucinated totals and computed deadlines that
 * the never-guess prompt is meant to prevent. Formatting-insensitive:
 * "$1,234.56" or "February 16, 2027" in the text matches 1234.56 and
 * "2027-02-16". A tripwire, not a proof: a fabricated number that coincides
 * with text elsewhere passes.
 */
export function findInventedValues(sourceText: string, doc: ExtractedDocument): InventedValue[] {
  // Normalize both sides identically: strip $, digit-grouping commas, and
  // non-breaking spaces so "$1,234.56" matches 1234.56 and month-name dates
  // survive their own comma stripping.
  const normalize = (text: string): string => text.replace(/[$,\u00a0]/g, "").toLowerCase();
  const haystack = normalize(sourceText);
  const invented: InventedValue[] = [];

  const check = (field: string, value: string, forms: string[]): void => {
    if (!forms.some((form) => haystack.includes(normalize(form)))) {
      invented.push({ field, value });
    }
  };

  const numberForms = (v: number): string[] => [String(v), v.toFixed(2)];

  const dateForms = (iso: string): string[] => {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
    if (!match) return [iso];
    const [, year, month, day] = match;
    const monthName = MONTH_NAMES[Number(month) - 1];
    if (!monthName) return [iso];
    return [
      iso,
      `${month}/${day}/${year}`,
      `${Number(month)}/${Number(day)}/${year}`,
      `${monthName} ${Number(day)}, ${year}`,
    ];
  };

  const checkNumber = (field: string, value: number | null): void => {
    if (value !== null) check(field, String(value), numberForms(value));
  };
  const checkDate = (field: string, value: string | null): void => {
    if (value !== null) check(field, value, dateForms(value));
  };

  checkNumber("total_billed", doc.total_billed);
  checkNumber("patient_responsibility", doc.patient_responsibility);
  doc.service_dates.forEach((date, i) => checkDate(`service_dates[${i}]`, date));
  checkDate("appeal_deadline", doc.appeal_deadline);
  doc.line_items.forEach((item, i) => {
    const prefix = `line_items[${i}]`;
    checkDate(`${prefix}.date`, item.date);
    checkNumber(`${prefix}.units`, item.units);
    checkNumber(`${prefix}.billed`, item.billed);
    checkNumber(`${prefix}.allowed`, item.allowed);
    checkNumber(`${prefix}.paid`, item.paid);
    checkNumber(`${prefix}.patient_owes`, item.patient_owes);
  });

  return invented;
}
