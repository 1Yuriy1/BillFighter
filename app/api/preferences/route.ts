import { NextResponse } from "next/server";
import type { QueryResultRow } from "pg";
import type { NotificationLevel } from "@/components/notifications/NotificationLevelPicker";
import { withSessionClient } from "@/lib/db/connect";
import { currentClaims } from "@/lib/session-server";

interface UserRow extends QueryResultRow {
  id: string;
  notification_level: string;
  automated_messages_paused_at: string | null;
}

function isNotificationLevel(value: unknown): value is NotificationLevel {
  return value === "everything" || value === "action_needed";
}

interface PreferencesBody {
  level?: unknown;
  paused?: unknown;
  /** Staff-only: which family to update. A family session may only touch its own row. */
  targetUserId?: unknown;
}

/**
 * Per-family notification level and the pause-all-automated-messages switch.
 *
 * A family session updates its own row only (the users column grants limit
 * the write surface to exactly these two preferences). Staff pass
 * targetUserId and update any family — the staff role holds full users
 * grants, and RLS plus the session role decide which path runs.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const claims = await currentClaims();
  if (claims === null) {
    return NextResponse.json({ error: "signed_out" }, { status: 401 });
  }
  const body = (await request.json().catch(() => null)) as PreferencesBody | null;
  if (body === null) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  if (body.level !== undefined && !isNotificationLevel(body.level)) {
    return NextResponse.json({ error: "invalid_level" }, { status: 400 });
  }
  if (body.paused !== undefined && typeof body.paused !== "boolean") {
    return NextResponse.json({ error: "invalid_paused" }, { status: 400 });
  }
  if (body.level === undefined && body.paused === undefined) {
    return NextResponse.json({ error: "nothing_to_update" }, { status: 400 });
  }

  const staffTarget =
    claims.role === "staff" && typeof body.targetUserId === "string" ? body.targetUserId : null;

  const updated = await withSessionClient(claims, async (client) => {
    const result = await client.query<UserRow>(
      `update users set
         notification_level = coalesce($1, notification_level),
         automated_messages_paused_at =
           case
             when $2::boolean is null then automated_messages_paused_at
             when $2::boolean then coalesce(automated_messages_paused_at, now())
             else null
           end
       where id = $3
       returning id, notification_level, automated_messages_paused_at`,
      [
        body.level ?? null,
        typeof body.paused === "boolean" ? body.paused : null,
        staffTarget ?? claims.sub,
      ],
    );
    return result.rows[0];
  });

  if (updated === undefined) {
    return NextResponse.json({ error: "unknown_user" }, { status: 404 });
  }
  return NextResponse.json({
    notificationLevel: updated.notification_level,
    pausedAt: updated.automated_messages_paused_at,
  });
}
