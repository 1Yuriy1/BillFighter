/**
 * POST /api/dev/jobs — on-demand trigger for the scheduled pipeline passes.
 *
 * The Inngest functions own the production cadence (deadlines daily, replies
 * every 15 min, dispatch every 5 min); this route runs the same runners with
 * the same service posture so local development, demos, and the E2E suite
 * can drive the pipeline synchronously instead of waiting on cron. Disabled
 * outside development (devLoginEnabled — same gate as /api/dev/login).
 */
import { NextResponse } from "next/server";
import { Pool, type PoolClient } from "pg";
import { dispatchDueActions } from "@/lib/actions/dispatch";
import { channelAdapters, deliverEmail } from "@/lib/followup/jobs";
import { runDeadlineCheck } from "@/lib/followup/deadlines";
import { classifyPendingReplies } from "@/lib/followup/replies";
import { proposeNextAction } from "@/lib/followup/reanalyze";
import { withServiceClient } from "@/lib/db/connect";
import { devLoginEnabled } from "@/lib/session";
import { currentClaims } from "@/lib/session-server";
import { runAnalysisPass } from "@/lib/pipeline/analysis";

// Same local default as the other service-connection routes; production sets
// DATABASE_URL to the Supabase connection string.
const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/billfighter_test",
});

export async function POST(request: Request): Promise<NextResponse> {
  if (!devLoginEnabled()) {
    return NextResponse.json({ error: "dev_jobs_disabled" }, { status: 403 });
  }
  const claims = await currentClaims();
  if (claims === null) {
    return NextResponse.json({ error: "signed_out" }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as
    | { job?: unknown; caseId?: unknown }
    | null;
  const job = typeof body?.job === "string" ? body.job : "";
  const caseId = typeof body?.caseId === "string" ? body.caseId : null;
  const now = new Date();

  async function withJobClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      return await fn(client);
    } finally {
      client.release();
    }
  }

  try {
    switch (job) {
      case "deadline":
        return NextResponse.json(
          await withJobClient((client) =>
            runDeadlineCheck(client, { now, deliver: deliverEmail }),
          ),
        );
      case "replies":
        return NextResponse.json(
          await withJobClient((client) =>
            classifyPendingReplies(client, {
              now,
              proposeNextAction: (caseId) => proposeNextAction(client, caseId, now),
              deliver: deliverEmail,
            }),
          ),
        );
      case "dispatch":
        return NextResponse.json(
          await withJobClient((client) =>
            dispatchDueActions(client, channelAdapters(), { now }),
          ),
        );
      case "analysis":
        if (caseId === null) {
          return NextResponse.json({ error: "caseId_required" }, { status: 400 });
        }
        return NextResponse.json(
          await withServiceClient((service) => runAnalysisPass(service, caseId, now)),
        );
      default:
        return NextResponse.json({ error: "unknown_job" }, { status: 400 });
    }
  } catch (error) {
    // Pass failures propagate with their codes — the trigger is a diagnostic
    // surface, and swallowing a failed pass here would hide exactly the
    // pipeline errors it exists to expose.
    if (error instanceof Error && "code" in error && typeof error.code === "string") {
      return NextResponse.json({ error: error.code }, { status: 502 });
    }
    throw error;
  }
}
