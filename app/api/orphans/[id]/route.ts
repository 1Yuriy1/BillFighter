import { NextResponse } from "next/server";
import type { QueryResultRow } from "pg";
import { withSessionClient } from "@/lib/db/connect";
import { currentClaims } from "@/lib/session-server";

const RESOLUTIONS = ["claimed", "dismissed"] as const;
type Resolution = (typeof RESOLUTIONS)[number];

/**
 * Staff resolution of orphan mail — an email that matched no case address.
 * 'claimed' means a human found (or created) the right case and took it
 * over; 'dismissed' means it is spam/irrelevant. Both clear the pending
 * queue. Family sessions are refused outright.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const claims = await currentClaims();
  if (claims === null) {
    return NextResponse.json({ error: "signed_out" }, { status: 401 });
  }
  if (claims.role !== "staff") {
    return NextResponse.json({ error: "staff_only" }, { status: 403 });
  }

  const { id } = await params;
  const body = (await request.json().catch(() => null)) as { status?: unknown } | null;
  const status = body?.status;
  if (typeof status !== "string" || !RESOLUTIONS.includes(status as Resolution)) {
    return NextResponse.json({ error: "status_must_be_claimed_or_dismissed" }, { status: 400 });
  }

  const updated = await withSessionClient(claims, async (client) => {
    const result = await client.query<{ id: string } & QueryResultRow>(
      `update orphan_emails
          set status = $2
        where id = $1
          and status = 'pending'
       returning id`,
      [id, status],
    );
    return result.rows[0];
  });

  if (updated === undefined) {
    return NextResponse.json({ error: "not_found_or_not_pending" }, { status: 404 });
  }
  return NextResponse.json({ id: updated.id, status });
}
