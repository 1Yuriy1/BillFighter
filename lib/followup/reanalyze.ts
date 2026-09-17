/**
 * The analyst's next-action proposal for a re-opened case (spec Flows: a
 * denied-again or needs-info reply re-opens analysis and the analyst proposes
 * the next action).
 *
 * This is deliberately the thin glue, not a second analysis engine: it
 * assembles the case's extracted documents, re-runs the deterministic rules
 * (lib/rules.ts), hands both to the AI analyst (lib/analyze.ts), and returns
 * the plan's first step as the proposed next action. The full analysis write
 * path (findings, summary, plan persistence) belongs to the console
 * workstream and is intentionally not duplicated here.
 *
 * Failure contract, chosen so a broken analyst can never roll back a reply
 * classification:
 *   - no ANTHROPIC_API_KEY configured → null, recorded as "proposal pending"
 *     on the timeline (a missing analyst is a configuration state, not a
 *     runtime error);
 *   - an analyst API failure → the AnalysisError propagates, the reply's
 *     transaction rolls back, and Inngest's retry re-runs the pass — visible,
 *     retried, never swallowed.
 */

import type { PoolClient, QueryResultRow } from "pg";
import { analyzeCase, AnalysisError, type AnalyzedDocument, type PlanStep } from "@/lib/analyze";
import type { ExtractedDocument } from "@/lib/extract";
import { runRules } from "@/lib/rules";
import type { ProposedAction } from "./replies";

/** The analyst re-open hook the reply pass hands to the runner. */
export async function proposeNextAction(
  client: PoolClient,
  caseId: string,
  now: Date,
): Promise<ProposedAction | null> {
  const docs = await client.query<QueryResultRow>(
    `select id, extracted
       from documents
      where case_id = $1 and extracted is not null
      order by created_at`,
    [caseId],
  );
  const documents: AnalyzedDocument[] = docs.rows.map((row) => ({
    id: String(row.id),
    extracted: row.extracted as ExtractedDocument,
  }));
  if (documents.length === 0) return null;

  const findings = runRules(
    documents.map((doc) => doc.extracted),
    now,
  );

  // Plan terms are not persisted yet — the plan document's own extraction is
  // the best available source (spec: "from the plan document or the
  // profile"). No plan document → empty terms; the analyst works without
  // them rather than failing the reply pass.
  const planRow = docs.rows.find((row) => row.extracted?.doc_type === "plan");
  const planTerms = planRow ? JSON.stringify(planRow.extracted) : "";

  let result;
  try {
    result = await analyzeCase({ documents, ruleFindings: findings, planTerms, today: now });
  } catch (error) {
    if (error instanceof AnalysisError && error.code === "missing_api_key") return null;
    throw error;
  }

  const first: PlanStep | undefined = result.plan[0];
  if (!first) return null;
  return { title: first.title, detail: first.detail };
}
