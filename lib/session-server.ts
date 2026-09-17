import { cookies } from "next/headers";
import { parseSession, SESSION_COOKIE_NAME, type SessionClaims } from "@/lib/session";

/** Reads and verifies the session cookie for route handlers and server components. */
export async function currentClaims(): Promise<SessionClaims | null> {
  const store = await cookies();
  return parseSession(store.get(SESSION_COOKIE_NAME)?.value);
}
