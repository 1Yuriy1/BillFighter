/**
 * POST /api/documents — browser document upload (spec: INTAKE, upload half).
 *
 * Session-scoped end to end: the case lookup, case creation, and the
 * documents INSERT all run on the session client, so RLS (cases_select_own /
 * documents_insert_own, caregiver-widened) is the tenancy check — a family
 * can only upload into a case it can see. The analysis pass runs afterwards
 * on the service connection: findings and actions are system writes, the
 * same posture the inbound webhook uses.
 *
 * Error contract: 400 bad request, 401 signed out, 403 staff (staff do not
 * own family cases), 404 unknown/inaccessible case, 413 oversized file,
 * 502 extraction/analysis failure with the document already stored and
 * flagged for review — the pipeline keeps every artifact and never drops
 * one silently.
 */
import { NextResponse } from "next/server";
import { AnalysisError } from "@/lib/analyze";
import { withServiceClient, withSessionClient } from "@/lib/db/connect";
import { makeLocalStore } from "@/lib/intake/storage";
import { runAnalysisPass } from "@/lib/pipeline/analysis";
import { persistUploadedDocument } from "@/lib/pipeline/upload";
import { currentClaims } from "@/lib/session-server";

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: Request): Promise<NextResponse> {
  const claims = await currentClaims();
  if (claims === null) {
    return NextResponse.json({ error: "signed_out" }, { status: 401 });
  }
  if (claims.role === "staff") {
    return NextResponse.json({ error: "staff_use_console" }, { status: 403 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "expected_multipart_form" }, { status: 400 });
  }

  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json({ error: "file_required" }, { status: 400 });
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return NextResponse.json({ error: "file_too_large" }, { status: 413 });
  }

  const caseIdField = form.get("caseId");
  const newCase = form.get("newCase") === "1";
  if (caseIdField !== null && typeof caseIdField !== "string") {
    return NextResponse.json({ error: "caseId_invalid" }, { status: 400 });
  }
  if (caseIdField !== null && !UUID_SHAPE.test(caseIdField)) {
    return NextResponse.json({ error: "caseId_invalid" }, { status: 400 });
  }

  const caseId = await withSessionClient(claims, async (session) => {
    if (caseIdField !== null) {
      // RLS scoping makes "no rows" mean "not yours or not there" — the same
      // response either way, so ids cannot be probed.
      const visible = await session.query<{ id: string }>(
        "select id from cases where id = $1",
        [caseIdField],
      );
      if (visible.rows.length === 0) {
        return null;
      }
      return caseIdField;
    }
    if (newCase) {
      const created = await session.query<{ id: string }>(
        `insert into cases (user_id) values ($1) returning id`,
        [claims.sub],
      );
      return created.rows[0].id;
    }
    // Default: the family's newest open case — the common "more paperwork
    // for the same fight" upload. With no open case at all, start one.
    const open = await session.query<{ id: string }>(
      `select id from cases where status <> 'closed' order by created_at desc limit 1`,
    );
    if (open.rows.length > 0) {
      return open.rows[0].id;
    }
    const created = await session.query<{ id: string }>(
      `insert into cases (user_id) values ($1) returning id`,
      [claims.sub],
    );
    return created.rows[0].id;
  });

  if (caseId === null) {
    return NextResponse.json({ error: "case_not_found" }, { status: 404 });
  }

  const now = new Date();
  const content = Buffer.from(await file.arrayBuffer());

  let upload;
  try {
    upload = await withSessionClient(claims, (session) =>
      persistUploadedDocument(session, makeLocalStore(), {
        caseId,
        filename: file.name,
        contentType: file.type,
        content,
        now,
      }),
    );
  } catch (error) {
    if (error instanceof Error && "code" in error && typeof error.code === "string") {
      // ExtractionError (non-missing-key): the document is stored and
      // flagged; surface the code so the client can show an honest error.
      return NextResponse.json(
        { error: "extraction_failed", code: error.code, caseId },
        { status: 502 },
      );
    }
    throw error;
  }

  let analysis = null;
  if (upload.extracted) {
    try {
      analysis = await withServiceClient((service) => runAnalysisPass(service, caseId, now));
    } catch (error) {
      if (error instanceof AnalysisError) {
        return NextResponse.json(
          { error: "analysis_failed", code: error.code, caseId, document: upload },
          { status: 502 },
        );
      }
      throw error;
    }
  }

  return NextResponse.json({ caseId, document: upload, analysis });
}
