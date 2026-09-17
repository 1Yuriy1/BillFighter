import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { DATABASE_URL } from "./db";

/**
 * Recreates the test database and applies db/migrations/*.sql in name order.
 * Runs once before the whole suite; tests then connect per-session.
 */
export default async function globalSetup(): Promise<void> {
  const url = new URL(DATABASE_URL);
  const dbName = url.pathname.replace(/^\//, "");
  if (!/^[a-z_][a-z0-9_]*$/.test(dbName)) {
    throw new Error(`Unsafe test database name: ${dbName}`);
  }

  const adminUrl = new URL(DATABASE_URL);
  adminUrl.pathname = "/postgres";

  const admin = new Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  try {
    // Kick off stale connections (e.g. a previous interrupted run), then
    // rebuild the database from scratch so the migration always applies
    // cleanly against an empty schema.
    await admin.query(
      `select pg_terminate_backend(pid)
       from pg_stat_activity
       where datname = $1 and pid <> pg_backend_pid()`,
      [dbName],
    );
    await admin.query(`drop database if exists "${dbName}"`);
    await admin.query(`create database "${dbName}"`);
  } finally {
    await admin.end();
  }

  const conn = new Client({ connectionString: DATABASE_URL });
  await conn.connect();
  try {
    const migrationsDir = path.resolve(process.cwd(), "db/migrations");
    const migrations = readdirSync(migrationsDir)
      .filter((name) => name.endsWith(".sql"))
      .sort();
    for (const name of migrations) {
      await conn.query(readFileSync(path.join(migrationsDir, name), "utf8"));
    }
  } finally {
    await conn.end();
  }
}
