import { Client } from "pg";

export const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/billfighter_test";

export type SessionRole = "authenticated" | "staff";

export interface SessionOptions {
  /** Database role to SET ROLE to. RLS policies target these roles. */
  role?: SessionRole;
  /** JWT subject claim (request.jwt.claim.sub) — the user id. */
  sub?: string;
  /** JWT role claim (request.jwt.claim.role). */
  claimRole?: string;
}

/**
 * Opens a connection that acts like the given session: SET ROLE plus the JWT
 * claims Supabase/PostgREST would set. Used by the RLS/audit tests to simulate
 * user and staff sessions against a plain local Postgres.
 */
export async function connectAs(options: SessionOptions = {}): Promise<Client> {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  if (options.role) {
    await client.query(`set role ${options.role}`);
  }
  if (options.sub) {
    await client.query("select set_config('request.jwt.claim.sub', $1, false)", [options.sub]);
  }
  if (options.claimRole) {
    await client.query("select set_config('request.jwt.claim.role', $1, false)", [
      options.claimRole,
    ]);
  }
  return client;
}
