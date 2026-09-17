/**
 * The analysis write path (spec: ANALYZE → PLAN) — the initial-pass
 * counterpart to lib/followup/reanalyze.ts, which is deliberately thin glue
 * for the reply loop. A pass:
 *
 *   1. loads the case's extracted documents (a pass with none is a no-op),
 *   2. runs the deterministic rules (lib/rules.ts),
 *   3. hands documents + rule findings to the AI analyst (lib/analyze.ts),
 *   4. persists every finding (rule + ai) to the findings table,
 *   5. drafts one letter per template the documents support
 *      (lib/letters.ts — buildDraft enforces the citation invariant),
 *   6. fills the case's provider/insurer/amount/next-deadline roll-ups,
 *   7. moves the case intake/analyzing → awaiting_approval when drafts exist.
 *
 * Runs on the service connection (RLS bypass): findings and actions are
 * system writes, like the audit trail. Writes autocommit statement-by-statement
 * (no outer transaction) so a partial pass still leaves honest state — an
 * AnalysisError is recorded as a timeline event and rethrown; the pass is
 * re-runnable (see the dev jobs route or a re-upload) and its writes are
 * idempotent by dedupe keys: findings on (case_id, kind, description), drafts
 * on (case_id, subject) — the same get-or-create pattern the seed uses.
 */
import type { Client as PgClient, PoolClient } from "pg";
import {
  analyzeCase,
  AnalysisError,
  type AiFinding,
  type AnalystResult,
} from "@/lib/analyze";
import type { ExtractedDocument } from "@/lib/extract";
import { availableTemplates, buildDraft } from "@/lib/letters";
import type { Finding } from "@/lib/rules";
import { runRules } from "@/lib/rules";
import { transitionCase } from "./caseStatus";

type Queryable = PoolClient | PgClient;

export interface AnalysisPassSummary {
  findingsRecorded: number;
  findingsSkipped: number;
  draftsCreated: number;
  draftsSkipped: number;
  /** The analyst's plain-language summary, when the analyst ran. */
  summary: string | null;
  /** The case's status after the pass. */
  caseStatus: string | null;
}

interface CaseRow {
  status: string;
  provider_name: string | null;
  insurer_name: string | null;
}

/** Load-and-shape query row for extracted documents. */
interface DocRow {
  id: string;
  extracted: ExtractedDocument;
}

export async function runAnalysisPass(
  client: Queryable,
  caseId: string,
  now: Date,
): Promise<AnalysisPassSummary> {
  const summary: AnalysisPassSummary = {
    findingsRecorded: 0,
    findingsSkipped: 0,
    draftsCreated: 0,
    draftsSkipped: 0,
    summary: null,
    caseStatus: null,
  };

  const docs = await loadExtractedDocuments(client, caseId);
  if (docs.length === 0) {
    summary.caseStatus = await caseStatus(client, caseId);
    return summary;
  }

  const caseRow = await loadCase(client, caseId);
  // A resolved case is settled: new documents (a corrected statement, a
  // proof of payment) are filed for the record and become savings-proof
  // candidates, but re-running the analyst would draft new dispute letters
  // for a dispute that is over. The pass re-runs only for open cases.
  if (caseRow.status === "resolved") {
    summary.caseStatus = caseRow.status;
    return summary;
  }
  if (caseRow.status === "intake") {
    await transitionCase(client, caseId, "intake", "analyzing", {
      actor: "agent",
      message: "documents received — analysis started",
    });
    caseRow.status = "analyzing";
  }

  const ruleFindings = runRules(docs.map((doc) => doc.extracted), now);

  let analyst: AnalystResult | null = null;
  try {
    analyst = await analyzeCase(
      {
        documents: docs,
        ruleFindings,
        // MVP: plan terms ride in the documents (the plan doc); the profile
        // field arrives with production signup.
        planTerms: "",
        today: now,
      },
    );
  } catch (error) {
    if (error instanceof AnalysisError) {
      await client.query("insert into events (case_id, actor, message) values ($1, 'agent', $2)", [
        caseId,
        `analysis failed (${error.code}) — the pass is re-runnable; document kept for review`,
      ]);
    }
    throw error;
  }

  for (const finding of ruleFindings) {
    await persistFinding(client, caseId, finding);
    summary.findingsRecorded += 1;
  }
  for (const finding of analyst.findings) {
    const inserted = await persistFinding(client, caseId, finding);
    if (inserted) summary.findingsRecorded += 1;
  }
  summary.findingsSkipped = countDuplicates(ruleFindings, analyst);
  summary.summary = analyst.summary;

  await recordAnalystEvents(client, caseId, analyst, ruleFindings);

  // Drafts: one per template the documents support. buildDraft is the
  // citation invariant's last gate — a LetterError here means the template
  // checker and availableTemplates disagree, which is a bug to surface, not
  // to skip silently; it propagates.
  const templates = availableTemplates(docs);
  for (const templateId of templates) {
    const draft = buildDraft(templateId, docs, now);
    const created = await getOrCreateDraft(client, caseId, draft);
    if (created) summary.draftsCreated += 1;
    else summary.draftsSkipped += 1;
  }
  if (summary.draftsCreated > 0) {
    await client.query("insert into events (case_id, actor, message) values ($1, 'agent', $2)", [
      caseId,
      `${summary.draftsCreated} letter${summary.draftsCreated === 1 ? "" : "s"} drafted — queued for your review and approval`,
    ]);
  } else {
    await client.query("insert into events (case_id, actor, message) values ($1, 'agent', $2)", [
      caseId,
      "analysis complete — no letters needed yet; add more documents for a stronger case",
    ]);
  }

  await refreshCaseRollups(client, caseId, docs);

  if (summary.draftsCreated > 0 && caseRow.status === "analyzing") {
    await transitionCase(client, caseId, "analyzing", "awaiting_approval", {
      actor: "agent",
      message: "letters ready — awaiting your approval",
    });
    caseRow.status = "awaiting_approval";
  }
  summary.caseStatus = await caseStatus(client, caseId);
  return summary;
}

/* ------------------------------------------------------------------ */
/* Persistence helpers                                                 */
/* ------------------------------------------------------------------ */

async function loadExtractedDocuments(client: Queryable, caseId: string): Promise<DocRow[]> {
  const result = await client.query<DocRow>(
    `select id, extracted
       from documents
      where case_id = $1 and extracted is not null
      order by created_at asc`,
    [caseId],
  );
  return result.rows;
}

async function loadCase(client: Queryable, caseId: string): Promise<CaseRow> {
  const result = await client.query<CaseRow>(
    `select status, provider_name, insurer_name
       from cases
      where id = $1`,
    [caseId],
  );
  if (result.rows.length === 0) {
    throw new Error(`runAnalysisPass: case ${caseId} not found`);
  }
  return result.rows[0];
}

async function caseStatus(client: Queryable, caseId: string): Promise<string | null> {
  const result = await client.query<{ status: string }>(
    "select status from cases where id = $1",
    [caseId],
  );
  return result.rows[0]?.status ?? null;
}

/**
 * Get-or-create on (case_id, kind, description) — re-running the pass over
 * the same documents must not duplicate findings.
 */
async function persistFinding(
  client: Queryable,
  caseId: string,
  finding: Finding | AiFinding,
): Promise<boolean> {
  const result = await client.query(
    `insert into findings (case_id, kind, description, estimated_savings, confidence, source)
     select $1, $2, $3, $4, $5, $6
     where not exists (
       select 1 from findings
        where case_id = $1 and kind = $2 and description = $3
     )`,
    [caseId, finding.kind, finding.description, finding.estimated_savings, finding.confidence, finding.source],
  );
  return (result.rowCount ?? 0) > 0;
}

function countDuplicates(ruleFindings: Finding[], analyst: AnalystResult): number {
  const seen = new Set<string>();
  let dupes = 0;
  for (const finding of [...ruleFindings, ...analyst.findings]) {
    const key = `${finding.kind}|${finding.description}`;
    if (seen.has(key)) dupes += 1;
    seen.add(key);
  }
  return dupes;
}

/**
 * The analyst's summary and the rejected-findings trail become timeline
 * events — rejected findings are surfaced, never silently dropped (the
 * evidence hard rule in lib/analyze.ts produced the rejection list).
 */
async function recordAnalystEvents(
  client: Queryable,
  caseId: string,
  analyst: AnalystResult,
  ruleFindings: Finding[],
): Promise<void> {
  const urgentCount =
    analyst.findings.filter((f) => f.urgent).length +
    ruleFindings.filter((f) => f.urgent).length;
  const parts = [
    `${analyst.findings.length + ruleFindings.length} problem${analyst.findings.length + ruleFindings.length === 1 ? "" : "s"} found` +
      (urgentCount > 0 ? `, ${urgentCount} urgent` : ""),
  ];
  if (analyst.rejectedFindings.length > 0) {
    parts.push(
      `${analyst.rejectedFindings.length} unsupported claim${analyst.rejectedFindings.length === 1 ? "" : "s"} rejected by the evidence rule`,
    );
  }
  await client.query("insert into events (case_id, actor, message) values ($1, 'agent', $2)", [
    caseId,
    `analysis complete — ${parts.join("; ")}`,
  ]);
  await client.query("insert into events (case_id, actor, message) values ($1, 'agent', $2)", [
    caseId,
    analyst.summary,
  ]);
}

/**
 * Get-or-create on (case_id, subject) so a re-run (or a second upload into
 * the same case) never duplicates a draft. Status stays 'draft' either way —
 * only the approval gate advances it.
 */
async function getOrCreateDraft(
  client: Queryable,
  caseId: string,
  draft: { subject: string; recipient: string | null; body: string; citations: unknown[] },
): Promise<boolean> {
  const result = await client.query(
    `insert into actions (case_id, channel, recipient, subject, body, citations, status)
     select $1, 'email', $2, $3, $4, $5::jsonb, 'draft'
     where not exists (
       select 1 from actions
        where case_id = $1 and subject = $3 and status in ('draft', 'approved', 'sent')
     )`,
    [caseId, draft.recipient, draft.subject, draft.body, JSON.stringify(draft.citations)],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Fills the case roll-ups from what the pass actually found: provider and
 * insurer names from the first document that states them, next_deadline
 * from the earliest extracted appeal deadline, and amount_disputed from the
 * stated balance the family is being asked to pay (patient responsibility,
 * falling back to the total billed) — the balance under dispute, not the
 * findings' savings estimate.
 */
async function refreshCaseRollups(
  client: Queryable,
  caseId: string,
  docs: DocRow[],
): Promise<void> {
  const provider = docs.find((doc) => doc.extracted.provider_name)?.extracted.provider_name ?? null;
  const insurer = docs.find((doc) => doc.extracted.insurer_name)?.extracted.insurer_name ?? null;
  const deadlines = docs
    .map((doc) => doc.extracted.appeal_deadline)
    .filter((deadline): deadline is string => Boolean(deadline))
    .sort();
  const nextDeadline = deadlines[0] ?? null;

  const statedBalance = docs.find(
    (doc) => doc.extracted.patient_responsibility !== null || doc.extracted.total_billed !== null,
  )?.extracted;
  const amountDisputed =
    statedBalance?.patient_responsibility ?? statedBalance?.total_billed ?? 0;

  await client.query(
    `update cases
        set provider_name = coalesce(provider_name, $2),
            insurer_name = coalesce(insurer_name, $3),
            next_deadline = coalesce(next_deadline, $4),
            amount_disputed = $5
      where id = $1`,
    [caseId, provider, insurer, nextDeadline, amountDisputed > 0 ? amountDisputed : null],
  );
}
