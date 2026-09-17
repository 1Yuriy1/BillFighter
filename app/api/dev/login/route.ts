import { NextResponse } from "next/server";
import type { QueryResultRow } from "pg";
import { withServiceClient } from "@/lib/db/connect";
import { devLoginEnabled, serializeSession, SESSION_COOKIE_NAME } from "@/lib/session";

interface UserRow extends QueryResultRow {
  id: string;
  is_staff: boolean;
}

/**
 * Development sign-in: swaps the email for signed session claims. Phase 1
 * stand-in for Supabase auth (see lib/session.ts); disabled with
 * BILLFIGHTER_ENABLE_DEV_LOGIN=false. Only ever resolves SYNTHETIC seed
 * users — there is nothing real to leak.
 */
export async function POST(request: Request): Promise<NextResponse> {
  if (!devLoginEnabled()) {
    return NextResponse.json({ error: "dev_login_disabled" }, { status: 403 });
  }
  const body = (await request.json().catch(() => null)) as { email?: unknown } | null;
  const email = typeof body?.email === "string" ? body.email.trim() : "";
  if (email === "") {
    return NextResponse.json({ error: "email_required" }, { status: 400 });
  }

  const user = await withServiceClient(async (client) => {
    const found = await client.query<UserRow>(
      `select id, is_staff from users where lower(email) = lower($1)`,
      [email],
    );
    return found.rows[0];
  });
  if (user === undefined) {
    return NextResponse.json({ error: "unknown_user" }, { status: 404 });
  }

  const role = user.is_staff ? ("staff" as const) : ("user" as const);
  const response = NextResponse.json({ sub: user.id, role });
  response.cookies.set(SESSION_COOKIE_NAME, serializeSession({ sub: user.id, role }), {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 7 * 24 * 60 * 60,
  });
  return response;
}
