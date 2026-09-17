/**
 * The letter-drafting layer (the ACT step of the case pipeline). Every
 * outbound letter is a draft: { body, citations } — the spec's actions row —
 * where each citation maps a factual claim in the letter to the document id
 * and field it came from. The spec's hard rule is enforced here at the library
 * level: a draft containing an unsupported claim cannot reach the approval
 * queue. validateDraft (and the assertSupportedDraft guard it backs) checks
 * both directions of the invariant:
 *
 * - every citation resolves to a real field with a real value on a document
 *   that is part of the case, and its claim text appears in the body;
 * - every money figure and date appearing anywhere in the body is covered by
 *   a citation — nothing factual can be sneaked past the evidence.
 *
 * Construction makes the invariant hold by design: templates can only place a
 * document value into the letter through a cited claim, rendered by
 * formatFact, and buildDraft re-validates its own output before returning.
 * Hand-edited drafts re-validate at the approval-queue gate, so an edit that
 * breaks traceability (a deleted claim sentence, a typed-in number) is caught
 * rather than sent.
 *
 * Tone: firm on facts, gentle with people. The facts are stated and cited;
 * the requests are courteous; the tone lint rejects escalation language.
 *
 * Like the rest of the pipeline, the engine is pure: `today` is a parameter
 * (the letter's dateline), and the first matching document of a type is the
 * one a template draws on — callers order documents, newest intent first.
 */

import type { AnalyzedDocument } from "./analyze";
import type { DocType } from "./extract";
import { isMeaningfulValue, resolveField } from "./fieldPath";

/** The plan's five core letters plus the cancer-specific set. */
export type LetterTemplateId =
  | "denial_appeal"
  | "billing_dispute"
  | "itemized_bill_request"
  | "negotiation_request"
  | "financial_assistance"
  | "expedited_appeal"
  | "step_therapy_exception"
  | "off_label_routine_cost"
  | "clinical_trial_routine_cost"
  | "network_exception"
  | "copay_charity_adjustment";

/**
 * One cited fact, in the spec's actions.citations shape: the letter text
 * carrying the claim, the document it came from, and the field inside that
 * document's extraction. The claim must be a substring of the draft body.
 */
export interface Citation {
  claim: string;
  document_id: string;
  field: string;
}

/** A draft ready for the approval queue, per the spec's { body, citations }. */
export interface LetterDraft {
  templateId: LetterTemplateId;
  /** Routing metadata for the send layer; not a claim in the letter body. */
  recipient: string | null;
  subject: string;
  body: string;
  citations: Citation[];
}

export type LetterErrorCode =
  "unknown_template" | "missing_fact" | "template_bug" | "unsupported_draft";

export class LetterError extends Error {
  readonly code: LetterErrorCode;
  readonly problems: readonly string[];

  constructor(code: LetterErrorCode, message: string, problems: readonly string[] = []) {
    super(problems.length > 0 ? `${message}: ${problems.join("; ")}` : message);
    this.name = "LetterError";
    this.code = code;
    this.problems = problems;
  }
}

/* ------------------------------------------------------------------ */
/* Fact rendering                                                      */
/* ------------------------------------------------------------------ */

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

function isIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/** "2026-07-02" -> "July 2, 2026". Malformed input passes through unchanged. */
export function formatDateLong(isoDate: string): string {
  if (!isIsoDate(isoDate)) return isoDate;
  const [year, month, day] = isoDate.split("-").map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31) return isoDate;
  return `${MONTHS[month - 1]} ${day}, ${year}`;
}

/**
 * "$1,234.56" — whole dollars-and-cents in cents, dodging float drift.
 * Matches the finding descriptions in lib/rules.ts so a fact reads the same
 * in a finding and in a letter.
 */
export function formatMoney(amount: number): string {
  const totalCents = Math.round(amount * 100);
  const sign = totalCents < 0 ? "-" : "";
  const absCents = Math.abs(totalCents);
  const dollars = Math.floor(absCents / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}$${dollars}.${(absCents % 100).toString().padStart(2, "0")}`;
}

function toIsoDate(today: Date): string {
  return today.toISOString().slice(0, 10);
}

/**
 * The single rendering path for a document value in a letter: amounts as
 * money, extraction dates in long form, strings verbatim. The claim-token
 * checks in validateDraft hold templates to this canonical form.
 */
export function formatFact(value: unknown): string {
  if (typeof value === "number") return formatMoney(value);
  if (typeof value === "string") {
    return isIsoDate(value) ? formatDateLong(value) : value.trim();
  }
  if (typeof value === "boolean") return value ? "yes" : "no";
  return String(value);
}

/**
 * Tokens a resolved value must contribute to its claim text. Numbers appear
 * as money, ISO dates in long form, strings verbatim. Booleans render as
 * declarative sentences the template writes (the citation itself is the
 * check), and collections are cited for existence, never embedded — so both
 * contribute no token.
 */
function factTokens(value: unknown): readonly string[] {
  if (typeof value === "number") return [formatMoney(value)];
  if (typeof value === "string") {
    return [isIsoDate(value) ? formatDateLong(value) : value.trim()];
  }
  return [];
}

/* ------------------------------------------------------------------ */
/* Fact resolution                                                     */
/* ------------------------------------------------------------------ */

/** A resolved document value plus where it came from. */
export interface Fact {
  readonly documentId: string;
  readonly field: string;
  readonly value: unknown;
}

function fact(doc: AnalyzedDocument, field: string): Fact {
  const lookup = resolveField(doc.extracted, field);
  if (!lookup.exists || !isMeaningfulValue(lookup.value)) {
    throw new LetterError("missing_fact", `Document "${doc.id}" has no value for "${field}"`);
  }
  return { documentId: doc.id, field, value: lookup.value };
}

function optionalFact(doc: AnalyzedDocument, field: string): Fact | null {
  const lookup = resolveField(doc.extracted, field);
  if (!lookup.exists || !isMeaningfulValue(lookup.value)) return null;
  return { documentId: doc.id, field, value: lookup.value };
}

function factStr(value: Fact): string {
  if (typeof value.value !== "string") {
    throw new LetterError(
      "template_bug",
      `Field "${value.field}" is not a string and cannot be used as one`,
    );
  }
  return value.value;
}

/** First meaningful value for any of the fields, scanning documents in order. */
function firstFact(documents: AnalyzedDocument[], fields: readonly string[]): Fact | null {
  for (const doc of documents) {
    for (const field of fields) {
      const found = optionalFact(doc, field);
      if (found) return found;
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Validation — the approval-queue guard                               */
/* ------------------------------------------------------------------ */

const MONEY_TOKEN = /\$\d[\d,]*(?:\.\d{1,2})?/g;
const ISO_DATE_TOKEN = /\b\d{4}-\d{2}-\d{2}\b/g;
const LONG_DATE_TOKEN = new RegExp(`\\b(${MONTHS.join("|")})\\s+\\d{1,2},\\s+\\d{4}\\b`, "g");

/**
 * Escalation language that does not belong in a firm-but-gentle letter. Word-
 * bounded so ordinary words ("issue", "assuming") cannot trip it. Staff
 * escalation paths exist for the rare letter that genuinely needs a harder
 * edge; drafts do not carry one by default.
 */
const TONE_BLOCKLIST: readonly RegExp[] = [
  /\bdemand(?:s|ing|ed)?\b/,
  /\bsue\b/,
  /\bsuing\b/,
  /\bsued\b/,
  /\blawsuit\b/,
  /\bnegligen(?:t|ce)\b/,
  /\bmalpractice\b/,
  /\bunacceptable\b/,
  /\boutrageous\b/,
  /\bthreaten(?:s|ing|ed)?\b/,
  /\bpunitive\b/,
  /\bbad[ -]faith\b/,
  /\bfraud(?:ulent)?\b/,
  /\bflagrant(?:ly)?\b/,
];

const PLACEHOLDER_TOKEN = /\{\{[^}]*\}\}/;

/**
 * Problems that keep a draft out of the approval queue. Empty means the draft
 * is fully supported: every citation resolves to a real field on a case
 * document, every claim text appears in the body, and every money figure or
 * date in the body is covered by a citation (the letter's own dateline — the
 * first long-form date — is the one exempt token, since the letter's date is
 * not a claim about the case).
 */
export function validateDraft(
  draft: LetterDraft,
  documents: AnalyzedDocument[],
): readonly string[] {
  const problems: string[] = [];
  if (draft.body.trim() === "") problems.push("body is empty");
  if (draft.subject.trim() === "") problems.push("subject is empty");
  if (draft.citations.length === 0) {
    problems.push("draft has no citations — nothing in it is verifiable");
  }

  for (const [index, citation] of draft.citations.entries()) {
    const label = `citation ${index + 1}`;
    if (citation.claim.trim() === "") {
      problems.push(`${label}: claim text is empty`);
      continue;
    }
    if (!draft.body.includes(citation.claim)) {
      problems.push(`${label}: claim text does not appear in the letter body`);
      continue;
    }
    const doc = documents.find((candidate) => candidate.id === citation.document_id);
    if (!doc) {
      problems.push(`${label}: document "${citation.document_id}" is not part of this case`);
      continue;
    }
    const lookup = resolveField(doc.extracted, citation.field);
    if (!lookup.exists) {
      problems.push(
        `${label}: field "${citation.field}" does not exist in document "${citation.document_id}"`,
      );
      continue;
    }
    if (!isMeaningfulValue(lookup.value)) {
      problems.push(
        `${label}: field "${citation.field}" in document "${citation.document_id}" has no value`,
      );
      continue;
    }
    for (const token of factTokens(lookup.value)) {
      if (!citation.claim.includes(token)) {
        problems.push(`${label}: text does not state the value of "${citation.field}" (${token})`);
      }
    }
  }

  // Reverse scan: no factual token in the body without a citation covering it.
  const covered = draft.citations.map((citation) => citation.claim);
  const uncovered = (token: string): boolean => !covered.some((claim) => claim.includes(token));

  for (const match of draft.body.matchAll(MONEY_TOKEN)) {
    if (uncovered(match[0])) {
      problems.push(`body states ${match[0]} and no citation supports it`);
    }
  }
  for (const match of draft.body.matchAll(ISO_DATE_TOKEN)) {
    if (uncovered(match[0])) {
      problems.push(`body states the date ${match[0]} and no citation supports it`);
    }
  }
  const longDates = [...draft.body.matchAll(LONG_DATE_TOKEN)];
  for (const [index, match] of longDates.entries()) {
    if (index === 0) continue; // the letter's own dateline
    if (uncovered(match[0])) {
      problems.push(`body states the date ${match[0]} and no citation supports it`);
    }
  }

  if (PLACEHOLDER_TOKEN.test(draft.body)) {
    problems.push("body contains an unfilled placeholder");
  }
  for (const pattern of TONE_BLOCKLIST) {
    const hit = pattern.exec(draft.body.toLowerCase());
    if (hit) {
      problems.push(
        `body uses escalation language ("${hit[0]}") — drafts stay firm on facts, gentle with people`,
      );
    }
  }

  return problems;
}

/** Throws LetterError("unsupported_draft") unless the draft is fully supported. */
export function assertSupportedDraft(draft: LetterDraft, documents: AnalyzedDocument[]): void {
  const problems = validateDraft(draft, documents);
  if (problems.length > 0) {
    throw new LetterError(
      "unsupported_draft",
      "This draft cannot reach the approval queue — an unsupported claim is present",
      problems,
    );
  }
}

/** The approval queue's gate: a draft with an unsupported claim never passes. */
export function canReachApprovalQueue(draft: LetterDraft, documents: AnalyzedDocument[]): boolean {
  return validateDraft(draft, documents).length === 0;
}

/* ------------------------------------------------------------------ */
/* Draft assembly                                                      */
/* ------------------------------------------------------------------ */

interface DraftWriter {
  /** A paragraph of fixed prose — no case facts may appear in it. */
  prose(text: string): void;
  /** A paragraph stating facts; records one citation per fact. */
  claimPara(text: string, facts: readonly Fact[]): void;
  /** A single skeleton line carrying facts; records citations, returns text. */
  claimLine(text: string, facts: readonly Fact[]): string;
}

function recordClaim(text: string, facts: readonly Fact[], citations: Citation[]): void {
  for (const value of facts) {
    for (const token of factTokens(value.value)) {
      if (!text.includes(token)) {
        throw new LetterError(
          "template_bug",
          `Letter text does not state the value of "${value.field}" (${token})`,
        );
      }
    }
  }
  for (const value of facts) {
    citations.push({ claim: text, document_id: value.documentId, field: value.field });
  }
}

function createWriter(citations: Citation[], paragraphs: string[]): DraftWriter {
  return {
    prose(text: string): void {
      paragraphs.push(text);
    },
    claimPara(text: string, facts: readonly Fact[]): void {
      recordClaim(text, facts, citations);
      paragraphs.push(text);
    },
    claimLine(text: string, facts: readonly Fact[]): string {
      recordClaim(text, facts, citations);
      return text;
    },
  };
}

/* ------------------------------------------------------------------ */
/* Templates                                                           */
/* ------------------------------------------------------------------ */

/**
 * Where a template draws a required fact from: a document of one of the
 * docTypes, on which every field holds a meaningful value and every expect
 * entry equals the extraction's value.
 */
export interface FactSource {
  readonly docTypes: readonly DocType[];
  readonly fields: readonly string[];
  readonly expect?: Readonly<Record<string, unknown>>;
}

function requirementMatches(doc: AnalyzedDocument, source: FactSource): boolean {
  if (!source.docTypes.includes(doc.extracted.doc_type)) return false;
  for (const field of source.fields) {
    const lookup = resolveField(doc.extracted, field);
    if (!lookup.exists || !isMeaningfulValue(lookup.value)) return false;
  }
  for (const [field, expected] of Object.entries(source.expect ?? {})) {
    const lookup = resolveField(doc.extracted, field);
    if (!lookup.exists || lookup.value !== expected) return false;
  }
  return true;
}

function findDoc(documents: AnalyzedDocument[], source: FactSource): AnalyzedDocument | null {
  return documents.find((doc) => requirementMatches(doc, source)) ?? null;
}

function describeRequirement(source: FactSource): string {
  const types = source.docTypes.map((type) => `"${type}"`).join(" or ");
  let description = `needs a document of type ${types}`;
  if (source.fields.length > 0) {
    description += ` with a value for ${source.fields.map((field) => `"${field}"`).join(", ")}`;
  }
  for (const [field, expected] of Object.entries(source.expect ?? {})) {
    description += ` where "${field}" is "${String(expected)}"`;
  }
  return description;
}

interface TemplateDocs {
  denial: AnalyzedDocument | null;
  bill: AnalyzedDocument | null;
  eob: AnalyzedDocument | null;
  plan: AnalyzedDocument | null;
  all: AnalyzedDocument[];
}

function resolveTemplateDocs(documents: AnalyzedDocument[]): TemplateDocs {
  const byType = (type: DocType): AnalyzedDocument | null =>
    documents.find((doc) => doc.extracted.doc_type === type) ?? null;
  return {
    denial: byType("denial"),
    bill: byType("itemized") ?? byType("bill"),
    eob: byType("eob"),
    plan: byType("plan"),
    all: documents,
  };
}

interface TemplateBuild {
  subject: string;
  recipient: string | null;
  salutation: string;
}

interface TemplateDef {
  readonly label: string;
  readonly description: string;
  readonly requirements: readonly FactSource[];
  readonly build: (writer: DraftWriter, docs: TemplateDocs, today: Date) => TemplateBuild;
}

function requireDoc(doc: AnalyzedDocument | null, kind: string): AnalyzedDocument {
  if (!doc) {
    throw new LetterError(
      "template_bug",
      `Template requires the ${kind} document, but requirement checking let it pass`,
    );
  }
  return doc;
}

function insurerName(docs: TemplateDocs): string | null {
  for (const doc of [docs.denial, docs.eob, docs.plan]) {
    if (!doc) continue;
    const name = optionalFact(doc, "insurer_name");
    if (name) return factStr(name);
  }
  return null;
}

function providerName(docs: TemplateDocs): string | null {
  for (const doc of [docs.bill, docs.denial, docs.eob, docs.plan]) {
    if (!doc) continue;
    const name = optionalFact(doc, "provider_name");
    if (name) return factStr(name);
  }
  return null;
}

function recipientBlock(
  docs: TemplateDocs,
  audience: "insurer" | "provider",
): { recipient: string | null; salutation: string } {
  const recipient = audience === "insurer" ? insurerName(docs) : providerName(docs);
  const salutation =
    recipient === null
      ? "To Whom It May Concern:"
      : audience === "insurer"
        ? "Dear Claims Review Team:"
        : "Dear Billing Office:";
  return { recipient, salutation };
}

/** Quoted verbatim text, for denial reasons and other document language. */
function quoted(value: Fact): string {
  return `"${factStr(value)}"`;
}

/** The statement paragraph shared by the billing-side letters. */
function statementSummary(writer: DraftWriter, docs: TemplateDocs): void {
  const bill = docs.bill;
  if (!bill) return;
  const total = optionalFact(bill, "total_billed");
  if (!total) return;
  const provider = optionalFact(bill, "provider_name");
  const firstServiceDate = optionalFact(bill, "service_dates[0]");
  const facts: Fact[] = [];
  let text = "The statement";
  if (provider) {
    text += ` from ${factStr(provider)}`;
    facts.push(provider);
  }
  text += ` lists a total of ${formatFact(total.value)}`;
  facts.push(total);
  if (firstServiceDate) {
    text += ` for services provided on ${formatFact(firstServiceDate.value)}`;
    facts.push(firstServiceDate);
  }
  writer.claimPara(`${text}.`, facts);
}

/** The EOB patient-responsibility paragraph, when an EOB with one is on file. */
function eobResponsibility(writer: DraftWriter, docs: TemplateDocs): void {
  const eob = docs.eob;
  if (!eob) return;
  const responsibility = optionalFact(eob, "patient_responsibility");
  if (!responsibility) return;
  const insurer = optionalFact(eob, "insurer_name");
  const facts: Fact[] = [];
  let text = "The EOB";
  if (insurer) {
    text += ` from ${factStr(insurer)}`;
    facts.push(insurer);
  }
  text += ` lists the patient responsibility as ${formatFact(responsibility.value)}`;
  facts.push(responsibility);
  writer.claimPara(`${text}.`, facts);
}

/** The balance paragraph shared by the payment-relief letters. */
function balanceParagraph(writer: DraftWriter, docs: TemplateDocs): void {
  const source = docs.bill ?? docs.eob;
  if (!source) return;
  const balance = optionalFact(source, "patient_responsibility");
  if (!balance) return;
  const named =
    source.extracted.doc_type === "eob"
      ? (optionalFact(source, "insurer_name") ?? optionalFact(source, "provider_name"))
      : (optionalFact(source, "provider_name") ?? optionalFact(source, "insurer_name"));
  const facts: Fact[] = [];
  let text = source.extracted.doc_type === "eob" ? "The EOB" : "The statement";
  if (named) {
    text += ` from ${factStr(named)}`;
    facts.push(named);
  }
  text += ` lists a patient responsibility of ${formatFact(balance.value)}`;
  facts.push(balance);
  writer.claimPara(`${text}.`, facts);
}

/** Facts every denial-based letter states: the reason, and the deadline if set. */
function denialFacts(writer: DraftWriter, docs: TemplateDocs): void {
  const denial = requireDoc(docs.denial, "denial");
  const reason = fact(denial, "denial_reason");
  writer.claimPara(`The denial notice gives the reason for the denial as ${quoted(reason)}.`, [
    reason,
  ]);
  const deadline = optionalFact(denial, "appeal_deadline");
  if (deadline) {
    writer.claimPara(`The notice states an appeal deadline of ${formatFact(deadline.value)}.`, [
      deadline,
    ]);
  }
}

function buildDenialAppeal(writer: DraftWriter, docs: TemplateDocs): TemplateBuild {
  requireDoc(docs.denial, "denial");
  writer.prose(
    "I am writing to appeal the denial of the claim referenced below and to ask that the decision be reviewed and the claim reprocessed.",
  );
  denialFacts(writer, docs);
  statementSummary(writer, docs);
  eobResponsibility(writer, docs);
  writer.prose(
    "The denial does not line up with the services billed, and I ask that the decision be reviewed by a reviewer with authority to approve coverage. Please include the specific plan language the denial relied on with your written response.",
  );
  return {
    ...recipientBlock(docs, "insurer"),
    subject: "Written appeal of denied claim",
  };
}

function buildExpeditedAppeal(writer: DraftWriter, docs: TemplateDocs): TemplateBuild {
  requireDoc(docs.denial, "denial");
  writer.prose(
    "I am writing to ask that the denial referenced below be reviewed on an expedited basis under your urgent-review process.",
  );
  denialFacts(writer, docs);
  writer.prose(
    "I am asking for an expedited review because a standard timeline could interrupt care that is already scheduled. The treating providers can supply clinical documentation on request; I am not asking your reviewer to make treatment decisions — only to decide coverage and timing on the urgent track your process provides.",
  );
  writer.prose(
    "Please confirm receipt of this expedited-review request and tell me in writing how the review will proceed.",
  );
  return {
    ...recipientBlock(docs, "insurer"),
    subject: "Expedited appeal request",
  };
}

function buildStepTherapyException(writer: DraftWriter, docs: TemplateDocs): TemplateBuild {
  requireDoc(docs.denial, "denial");
  writer.prose(
    "I am writing to request a step-therapy exception for the therapy identified in the denial referenced below.",
  );
  denialFacts(writer, docs);
  writer.prose(
    "The prescribing specialist's documentation supporting the exception is available on request. I am not asking your reviewer to make treatment decisions — only that the step-therapy exception process be applied to this request.",
  );
  writer.prose(
    "I ask that you review this request under your step-therapy exception criteria, and that you send written instructions if additional forms or documentation are required.",
  );
  return {
    ...recipientBlock(docs, "insurer"),
    subject: "Step-therapy exception request",
  };
}

function buildOffLabelRoutineCost(writer: DraftWriter, docs: TemplateDocs): TemplateBuild {
  requireDoc(docs.denial, "denial");
  writer.prose(
    "I am writing to ask that the denied claim referenced below be reviewed for coverage of the routine patient costs associated with the prescribed use of the therapy in question.",
  );
  denialFacts(writer, docs);
  writer.prose(
    "I ask that the review separate the coverage question for the therapy itself from the routine costs of care associated with its use, and that the determination on routine patient costs be made under the plan's standard criteria for those costs.",
  );
  writer.prose(
    "If the plan requires specific forms or supporting documents for this review, please send the requirements in writing.",
  );
  return {
    ...recipientBlock(docs, "insurer"),
    subject: "Coverage review request — routine patient costs",
  };
}

function buildClinicalTrialRoutineCost(writer: DraftWriter, docs: TemplateDocs): TemplateBuild {
  requireDoc(docs.denial, "denial");
  writer.prose(
    "I am writing to ask that the routine patient costs of care associated with the clinical-trial participation identified in the claim referenced below be covered under the plan.",
  );
  denialFacts(writer, docs);
  statementSummary(writer, docs);
  writer.prose(
    "I ask that the review distinguish the routine costs of trial participation from the costs of the trial itself, and that the determination be made under the plan's criteria for routine patient costs.",
  );
  return {
    ...recipientBlock(docs, "insurer"),
    subject: "Coverage request — clinical-trial routine patient costs",
  };
}

function buildNetworkException(writer: DraftWriter, docs: TemplateDocs): TemplateBuild {
  const networkDoc = requireDoc(
    docs.all.find((doc) => doc.extracted.network_status === "out") ?? null,
    "out-of-network record",
  );
  const status = fact(networkDoc, "network_status");
  writer.prose(
    "I am writing to ask that the services referenced below be covered at the in-network level of benefits, either through a network exception or through the plan's rules for these services.",
  );
  writer.claimPara(
    `The plan's records list the network status of this claim as ${formatFact(status.value)}.`,
    [status],
  );
  const emergency = docs.all
    .map((doc) => optionalFact(doc, "was_emergency"))
    .find((value) => value !== null && value.value === true);
  if (emergency) {
    writer.claimPara("The documents on file record the services as emergency care.", [emergency]);
    writer.prose(
      "I ask that the services be processed at the in-network level of benefits under the plan's terms for emergency care.",
    );
  }
  writer.prose(
    "If a network exception requires specific forms or supporting documents, please send the requirements in writing.",
  );
  return {
    ...recipientBlock(docs, "insurer"),
    subject: "Network exception request",
  };
}

function buildBillingDispute(writer: DraftWriter, docs: TemplateDocs): TemplateBuild {
  requireDoc(docs.bill, "statement");
  writer.prose(
    "I am writing to dispute the balance shown on the statement referenced below and to ask that the charges be reviewed and corrected.",
  );
  statementSummary(writer, docs);
  const eobResponsibilityFact =
    docs.eob === null ? null : optionalFact(docs.eob, "patient_responsibility");
  if (eobResponsibilityFact) {
    eobResponsibility(writer, docs);
    writer.prose(
      "The two figures do not agree, and I ask that the difference be reconciled or the bill corrected.",
    );
  }
  writer.prose(
    "I ask for a corrected statement showing the charges you stand behind — with the date, code, description, and units for each — and documentation supporting any charge that remains on the bill.",
  );
  return {
    ...recipientBlock(docs, "provider"),
    subject: "Billing dispute — request for corrected statement",
  };
}

function buildItemizedBillRequest(writer: DraftWriter, docs: TemplateDocs): TemplateBuild {
  requireDoc(docs.bill, "statement");
  writer.prose(
    "I am writing to request a complete itemized statement for the services referenced below.",
  );
  statementSummary(writer, docs);
  writer.prose(
    "The statement I received does not show the detail needed to review the charges. Please send an itemized bill listing every charge with its date, code, description, and units, and the balance for each.",
  );
  writer.prose(
    "I would appreciate receiving the itemized statement within your standard turnaround time for record requests. Thank you for your help with this.",
  );
  return {
    ...recipientBlock(docs, "provider"),
    subject: "Request for itemized statement",
  };
}

function buildNegotiationRequest(writer: DraftWriter, docs: TemplateDocs): TemplateBuild {
  writer.prose(
    "I am writing about the balance shown on the statement referenced below, and to ask whether a reduced amount can be agreed on.",
  );
  balanceParagraph(writer, docs);
  writer.prose(
    "This balance is difficult for our family to absorb all at once. I ask whether the practice can agree to a reduced lump-sum amount, a prompt-pay discount, or a structured payment plan — and that any terms we agree on be confirmed in writing before any payment is due.",
  );
  return {
    ...recipientBlock(docs, "provider"),
    subject: "Payment options for the enclosed balance",
  };
}

function buildFinancialAssistance(writer: DraftWriter, docs: TemplateDocs): TemplateBuild {
  writer.prose(
    "I am writing to ask about financial assistance — sometimes called charity care — for the balance shown on the statement referenced below.",
  );
  balanceParagraph(writer, docs);
  writer.prose(
    "Please send the financial-assistance application, the documents needed to apply, and the income guidelines used to decide eligibility.",
  );
  writer.prose(
    "If the balance has been referred to a collections agency, I ask that it be paused while the application is under review.",
  );
  return {
    ...recipientBlock(docs, "provider"),
    subject: "Financial assistance application request",
  };
}

function buildCopayCharityAdjustment(writer: DraftWriter, docs: TemplateDocs): TemplateBuild {
  writer.prose(
    "I am writing to ask about help with the patient-responsibility balance on the statement referenced below — copay assistance, a charity adjustment, or a payment arrangement.",
  );
  balanceParagraph(writer, docs);
  writer.prose(
    "The services in question are part of ongoing treatment, and the balance comes on top of regular cost-sharing. I ask that the account be reviewed for any assistance program that could apply, and that the available options be sent in writing.",
  );
  return {
    ...recipientBlock(docs, "provider"),
    subject: "Copay assistance and adjustment options",
  };
}

const DENIAL_REQUIREMENT: FactSource = {
  docTypes: ["denial"],
  fields: ["denial_reason"],
};

const STATEMENT_REQUIREMENT: FactSource = {
  docTypes: ["itemized", "bill"],
  fields: ["total_billed"],
};

const BALANCE_REQUIREMENT: FactSource = {
  docTypes: ["itemized", "bill", "eob"],
  fields: ["patient_responsibility"],
};

const OUT_OF_NETWORK_REQUIREMENT: FactSource = {
  docTypes: ["itemized", "bill", "eob", "denial", "plan"],
  fields: [],
  expect: { network_status: "out" },
};

const TEMPLATES: Readonly<Record<LetterTemplateId, TemplateDef>> = {
  // The plan's five core letters.
  denial_appeal: {
    label: "Denial appeal",
    description: "Appeal a denied claim and ask that it be reprocessed.",
    requirements: [DENIAL_REQUIREMENT],
    build: buildDenialAppeal,
  },
  billing_dispute: {
    label: "Billing dispute",
    description: "Dispute a bill's balance and ask for corrected charges.",
    requirements: [STATEMENT_REQUIREMENT],
    build: buildBillingDispute,
  },
  itemized_bill_request: {
    label: "Itemized bill request",
    description: "Request a complete itemized statement before disputing charges.",
    requirements: [STATEMENT_REQUIREMENT],
    build: buildItemizedBillRequest,
  },
  negotiation_request: {
    label: "Negotiation request",
    description: "Ask about a discount, settlement, or payment arrangement on the balance.",
    requirements: [BALANCE_REQUIREMENT],
    build: buildNegotiationRequest,
  },
  financial_assistance: {
    label: "Financial assistance",
    description: "Ask for the provider's charity-care or financial-assistance application.",
    requirements: [BALANCE_REQUIREMENT],
    build: buildFinancialAssistance,
  },
  // The cancer-specific set.
  expedited_appeal: {
    label: "Expedited appeal",
    description: "Ask for an expedited review when treatment timing is at risk.",
    requirements: [DENIAL_REQUIREMENT],
    build: buildExpeditedAppeal,
  },
  step_therapy_exception: {
    label: "Step-therapy exception",
    description:
      "Ask the insurer to cover the prescribed therapy without completing its required sequence first.",
    requirements: [DENIAL_REQUIREMENT],
    build: buildStepTherapyException,
  },
  off_label_routine_cost: {
    label: "Off-label routine cost",
    description: "Ask for coverage review of routine costs when the prescribed use is off-label.",
    requirements: [DENIAL_REQUIREMENT],
    build: buildOffLabelRoutineCost,
  },
  clinical_trial_routine_cost: {
    label: "Clinical-trial routine cost",
    description: "Ask for coverage of routine patient costs during clinical-trial participation.",
    requirements: [DENIAL_REQUIREMENT],
    build: buildClinicalTrialRoutineCost,
  },
  network_exception: {
    label: "Network exception",
    description: "Ask for in-network coverage when the claim was processed out-of-network.",
    requirements: [OUT_OF_NETWORK_REQUIREMENT],
    build: buildNetworkException,
  },
  copay_charity_adjustment: {
    label: "Copay or charity adjustment",
    description: "Ask about copay assistance, charity adjustments, or payment arrangements.",
    requirements: [BALANCE_REQUIREMENT],
    build: buildCopayCharityAdjustment,
  },
};

export const TEMPLATE_IDS: readonly LetterTemplateId[] = Object.keys(
  TEMPLATES,
) as LetterTemplateId[];

function templateDef(templateId: LetterTemplateId): TemplateDef {
  const def: TemplateDef | undefined = (TEMPLATES as Record<string, TemplateDef>)[templateId];
  if (!def) {
    throw new LetterError("unknown_template", `Unknown letter template "${templateId}"`);
  }
  return def;
}

/** Requirement descriptions a template cannot satisfy with these documents. */
export function missingRequirements(
  templateId: LetterTemplateId,
  documents: AnalyzedDocument[],
): readonly string[] {
  return templateDef(templateId)
    .requirements.filter((source) => findDoc(documents, source) === null)
    .map(describeRequirement);
}

/** Templates that can be drafted from the documents currently on the case. */
export function availableTemplates(documents: AnalyzedDocument[]): readonly LetterTemplateId[] {
  return TEMPLATE_IDS.filter(
    (templateId) => missingRequirements(templateId, documents).length === 0,
  );
}

const CLOSING =
  "Thank you for your time and attention to this request. I look forward to your written response.";

/**
 * Builds a draft from the template and the case's extracted documents, then
 * re-validates its own output — the engine never returns a draft that fails
 * the citation invariant. Throws LetterError("missing_fact") when the
 * template's requirements are not met, rather than drafting around a gap.
 */
export function buildDraft(
  templateId: LetterTemplateId,
  documents: AnalyzedDocument[],
  today: Date,
): LetterDraft {
  const def = templateDef(templateId);
  const missing = missingRequirements(templateId, documents);
  if (missing.length > 0) {
    throw new LetterError(
      "missing_fact",
      `Template "${templateId}" is missing required facts`,
      missing,
    );
  }

  const docs = resolveTemplateDocs(documents);
  const citations: Citation[] = [];
  const paragraphs: string[] = [];
  const writer = createWriter(citations, paragraphs);
  const meta = def.build(writer, docs, today);

  const claimNo = firstFact(documents, ["claim_number"]);
  const patient = firstFact(documents, ["patient_name"]);
  let reLine: string | null = null;
  if (claimNo && patient) {
    reLine = writer.claimLine(`Re: Claim ${factStr(claimNo)} (patient: ${factStr(patient)})`, [
      claimNo,
      patient,
    ]);
  } else if (claimNo) {
    reLine = writer.claimLine(`Re: Claim ${factStr(claimNo)}`, [claimNo]);
  } else if (patient) {
    reLine = writer.claimLine(`Re: patient ${factStr(patient)}`, [patient]);
  }

  writer.prose(CLOSING);
  if (patient) {
    writer.claimPara(`Sincerely,\n${factStr(patient)}`, [patient]);
  } else {
    writer.prose("Sincerely,");
  }

  const head = [formatDateLong(toIsoDate(today)), reLine, meta.salutation].filter(
    (line): line is string => line !== null,
  );
  const draft: LetterDraft = {
    templateId,
    subject: meta.subject,
    recipient: meta.recipient,
    body: [...head, ...paragraphs].join("\n\n"),
    citations,
  };

  // The engine's own output is held to the same gate as the approval queue.
  const problems = validateDraft(draft, documents);
  if (problems.length > 0) {
    throw new LetterError(
      "unsupported_draft",
      `Template "${templateId}" produced a draft that fails the citation invariant`,
      problems,
    );
  }
  return draft;
}
