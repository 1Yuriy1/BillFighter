/**
 * Cookie-backed session claims for the consoles.
 *
 * Phase 1 stand-in for Supabase auth: the signed cookie carries the same
 * claims Supabase would deliver (the user id as `sub`, plus the app role),
 * and the DB connection materializes them exactly the way PostgREST does —
 * `request.jwt.claim.sub` / `request.jwt.claim.role`. Every dashboard query
 * then runs under the family's own RLS scope; the UI has no data path that
 * bypasses it.
 *
 * The cookie proves nothing more than "this browser picked a user" until real
 * auth lands — which is why every write stays inside that user's RLS scope
 * and the build ships synthetic data only (spec: no real PHI in Phase 1).
 * Disable sign-in for any shared deployment with
 * BILLFIGHTER_ENABLE_DEV_LOGIN=false.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE_NAME = "bf_session";

/** App-side role. The DB role is derived from this in lib/db/connect.ts. */
export type SessionRole = "user" | "staff";

export interface SessionClaims {
  /** users.id — the JWT `sub` claim PostgREST would set. */
  sub: string;
  role: SessionRole;
}

const SIGNING_SECRET = process.env.SESSION_SECRET ?? "billfighter-dev-session-secret";

function base64Url(input: string): string {
  return Buffer.from(input, "utf8").toString("base64url");
}

function sign(payload: string): string {
  return createHmac("sha256", SIGNING_SECRET).update(payload).digest("base64url");
}

/** Encodes claims for the session cookie: `<payload>.<hmac>`. */
export function serializeSession(claims: SessionClaims): string {
  const payload = base64Url(JSON.stringify(claims));
  return `${payload}.${sign(payload)}`;
}

/**
 * Verifies the cookie's signature and parses the claims. Returns null for
 * anything absent, malformed, or forged — callers treat that as signed out.
 */
export function parseSession(cookieValue: string | undefined): SessionClaims | null {
  if (cookieValue === undefined) {
    return null;
  }
  const separator = cookieValue.lastIndexOf(".");
  if (separator <= 0) {
    return null;
  }
  const payload = cookieValue.slice(0, separator);
  const signature = cookieValue.slice(separator + 1);
  const expected = sign(payload);
  const given = Buffer.from(signature);
  if (given.length !== expected.length || !timingSafeEqual(given, Buffer.from(expected))) {
    return null;
  }
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      sub?: unknown;
      role?: unknown;
    };
    if (typeof claims.sub !== "string" || claims.sub === "") {
      return null;
    }
    if (claims.role !== "user" && claims.role !== "staff") {
      return null;
    }
    return { sub: claims.sub, role: claims.role };
  } catch {
    return null;
  }
}

/**
 * Whether dev sign-in is enabled. On by default so CI's production-build e2e
 * and the sandbox walkthrough can seed and act as synthetic families; set
 * BILLFIGHTER_ENABLE_DEV_LOGIN=false to close it (the phase-2 Supabase auth
 * wiring replaces this path entirely).
 */
export function devLoginEnabled(): boolean {
  return process.env.BILLFIGHTER_ENABLE_DEV_LOGIN !== "false";
}
