/**
 * App-side database connections.
 *
 * Two doors, and nothing else:
 *
 *   - withSessionClient — a connection scoped to the signed-in session: SET
 *     ROLE to the session's DB role plus the JWT claims PostgREST would set.
 *     Every dashboard, console, and server-action query runs here, so
 *     visibility is decided by RLS at the database — the UI has no path that
 *     reads another family's rows, even in development.
 *   - withServiceClient — the service connection (RLS bypass), used only by
 *     the webhook, sign-in lookup, and the seed route.
 *
 * Postgres gotcha this module exists to contain: RESET ALL does not undo
 * SET ROLE — only RESET ROLE does. A session connection returned to the pool
 * without RESET ROLE keeps its restricted role, and the next borrower of
 * that connection (including the service door) silently runs as that role.
 * Session connections are therefore role-reset on success and destroyed on
 * any failure, so a poisoned connection can never re-enter the pool.
 */

import { Pool, type PoolClient } from "pg";
import type { SessionClaims } from "@/lib/session";

const connectionString =
  process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/billfighter_test";

/** Shared app pool. Postgres caps this well below any real Phase 1 load. */
const pool = new Pool({ connectionString });

type DbRole = "authenticated" | "staff";

function dbRoleFor(claims: SessionClaims): DbRole {
  return claims.role === "staff" ? "staff" : "authenticated";
}

async function applyClaims(client: PoolClient, claims: SessionClaims): Promise<void> {
  await client.query(`set role ${dbRoleFor(claims)}`);
  await client.query("select set_config('request.jwt.claim.sub', $1, false)", [claims.sub]);
  await client.query("select set_config('request.jwt.claim.role', $1, false)", [dbRoleFor(claims)]);
}

/** Clears session role and claims so a pooled connection cannot carry them. */
async function resetClaims(client: PoolClient): Promise<void> {
  await client.query("reset role");
  await client.query("reset all");
}

/** Runs `fn` with a connection scoped to the session's RLS claims. */
export async function withSessionClient<T>(
  claims: SessionClaims,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let released = false;
  const release = (destroy = false) => {
    if (released) return;
    released = true;
    client.release(destroy);
  };
  try {
    await applyClaims(client, claims);
    const result = await fn(client);
    await resetClaims(client);
    return result;
  } catch (error) {
    // A failed request leaves no guarantee about the connection's session
    // state (role, aborted transactions) — destroy it rather than reuse it.
    release(true);
    throw error;
  } finally {
    release();
  }
}

/** Runs `fn` with the service connection (RLS bypass) — intake, sign-in, seed. */
export async function withServiceClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    // Defense in depth: a connection that somehow retained a session role
    // must not lend it to the RLS-bypass door. Clean connections: no-op.
    await client.query("reset role");
    return await fn(client);
  } finally {
    client.release();
  }
}
