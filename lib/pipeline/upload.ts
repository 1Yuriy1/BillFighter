/**
 * Upload persistence (spec: INTAKE, upload half) — the browser-upload
 * counterpart to lib/intake/processInbound.ts (email half). One function:
 *
 *   1. saves the file bytes to the intake store (content is never lost,
 *      even when extraction fails),
 *   2. extracts text documents through the Claude extraction pass and runs
 *      the math check plus the invented-value tripwire on the result,
 *   3. inserts the documents row once, with its final state — sessions hold
 *      no UPDATE grant on documents (grants are insert/select only), so the
 *      row carries extraction output at insert time instead of being patched.
 *
 * Every failure path lands in a stored, reviewable state — flagged for staff
 * with a reason — never a silent drop. Runs on the session client (RLS
 * scoped): the insert policy (documents_insert_own, widened to caregivers in
 * 004_consoles) is the tenancy check.
 */
import type { PoolClient } from "pg";
import { extractDocument, ExtractionError, findInventedValues } from "@/lib/extract";
import type { IntakeStore } from "@/lib/intake/storage";

export interface PersistedUpload {
  documentId: string;
  filePath: string;
  /** The stored doc_type: the extracted type when extraction ran, else "other". */
  docType: string;
  /** True when structured extraction produced an extracted JSON document. */
  extracted: boolean;
  needsHumanReview: boolean;
  reviewReason: string | null;
}

export interface UploadInput {
  caseId: string;
  filename: string;
  contentType: string | null;
  content: Buffer;
  now: Date;
}

/** Extensions treated as OCR-ready text. Binary formats wait for OCR (staff review). */
const TEXT_EXTENSIONS = /\.(txt|md|json|csv|html?)$/i;

/**
 * True when the upload is textual and can go straight to extraction. PDFs and
 * photos need an OCR pass the MVP does not have yet — they route to staff
 * review instead of pretending to extract.
 */
export function isTextUpload(contentType: string | null, filename: string): boolean {
  if (contentType?.startsWith("text/")) return true;
  return TEXT_EXTENSIONS.test(filename);
}

export async function persistUploadedDocument(
  session: PoolClient,
  store: IntakeStore,
  input: UploadInput,
): Promise<PersistedUpload> {
  const filePath = await store.save(input.caseId, input.filename, input.content);

  if (!isTextUpload(input.contentType, input.filename)) {
    return insertDocument(session, {
      caseId: input.caseId,
      filePath,
      docType: "other",
      extracted: null,
      needsHumanReview: true,
      reviewReason: "OCR pending — binary document routed to staff review",
    });
  }

  const text = input.content.toString("utf8");
  try {
    const result = await extractDocument(text);
    const invented = findInventedValues(text, result.extracted);
    const reviewReason =
      mathReviewReason(result.mathCheck) ?? inventedReviewReason(invented.length);
    return insertDocument(session, {
      caseId: input.caseId,
      filePath,
      docType: result.extracted.doc_type,
      extracted: result.extracted,
      needsHumanReview: result.mathCheck.needsHumanReview || invented.length > 0,
      reviewReason,
    });
  } catch (error) {
    if (error instanceof ExtractionError && error.code === "missing_api_key") {
      return insertDocument(session, {
        caseId: input.caseId,
        filePath,
        docType: "other",
        extracted: null,
        needsHumanReview: true,
        reviewReason: "extraction pending — no API key configured; document kept for review",
      });
    }
    // Extraction failed for a real reason (API error, schema mismatch) —
    // store the document flagged for review and surface the failure in the
    // response. Never swallowed: the upload API maps this to a 502 with the
    // error code.
    const message = error instanceof Error ? error.message : "unknown extraction failure";
    await insertDocument(session, {
      caseId: input.caseId,
      filePath,
      docType: "other",
      extracted: null,
      needsHumanReview: true,
      reviewReason: `extraction failed — ${message}`,
    });
    throw error;
  }
}

/** The math-imbalance reason string, or null when the document is balanced. */
function mathReviewReason(mathCheck: { balanced: boolean; delta: number }): string | null {
  if (mathCheck.balanced) return null;
  const direction = mathCheck.delta > 0 ? "more than" : "less than";
  const delta = Math.abs(mathCheck.delta).toFixed(2);
  return (
    `math check failed — line items sum ${direction} the stated total by $${delta}; ` +
    "flagged for human review before any claim relies on it"
  );
}

/** The invented-value reason string, or null when every value traces to source text. */
function inventedReviewReason(inventedCount: number): string | null {
  if (inventedCount === 0) return null;
  return (
    `${inventedCount} extracted value${inventedCount === 1 ? "" : "s"} not found in the source text — ` +
    "flagged for human review before any claim relies on it"
  );
}

interface DocumentInsert {
  caseId: string;
  filePath: string;
  docType: string;
  extracted: unknown;
  needsHumanReview: boolean;
  reviewReason: string | null;
}

async function insertDocument(session: PoolClient, doc: DocumentInsert): Promise<PersistedUpload> {
  const result = await session.query<{ id: string }>(
    `insert into documents
       (case_id, doc_type, file_path, extracted, needs_human_review, review_reason)
     values ($1, $2, $3, $4::jsonb, $5, $6)
     returning id`,
    [
      doc.caseId,
      doc.docType,
      doc.filePath,
      doc.extracted === null ? null : JSON.stringify(doc.extracted),
      doc.needsHumanReview,
      doc.reviewReason,
    ],
  );
  return {
    documentId: result.rows[0].id,
    filePath: doc.filePath,
    docType: doc.docType,
    extracted: doc.extracted !== null,
    needsHumanReview: doc.needsHumanReview,
    reviewReason: doc.reviewReason,
  };
}
