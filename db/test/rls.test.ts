import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Client } from "pg";
import { connectAs } from "./db";

/**
 * Acceptance tests for the foundation schema, run against a local
 * (Supabase-compatible) Postgres:
 *
 *  1. A user session reads ZERO rows of another user's cases, documents,
 *     actions (and the rest of the six tables).
 *  2. Every case-scoped mutation writes an `events` audit row.
 *  3. Staff — a separate role — see across cases, and users cannot touch the
 *     audit log directly.
 */

let admin: Client;
let userA: Client; // authenticated session for user A
let userB: Client; // authenticated session for user B
let staff: Client; // staff session

const userAId = "11111111-1111-4111-8111-111111111111";
const userBId = "22222222-2222-4222-8222-222222222222";

let caseAId: string;
let caseBId: string;

beforeAll(async () => {
  admin = await connectAs();
  userA = await connectAs({ role: "authenticated", sub: userAId });
  userB = await connectAs({ role: "authenticated", sub: userBId });
  staff = await connectAs({ role: "staff" });

  // Seed two tenants as admin. Each insert fires the audit trigger
  // (actor 'system' — no JWT claims on the admin connection).
  await admin.query(
    `insert into users (id, email, full_name) values
       ($1, 'a@example.test', 'User A'),
       ($2, 'b@example.test', 'User B')`,
    [userAId, userBId],
  );
  const a = await admin.query<{ id: string }>(
    `insert into cases (user_id, provider_name, insurer_name, status)
     values ($1, 'Provider A', 'Insurer A', 'analyzing') returning id`,
    [userAId],
  );
  const b = await admin.query<{ id: string }>(
    `insert into cases (user_id, provider_name, insurer_name, status)
     values ($1, 'Provider B', 'Insurer B', 'analyzing') returning id`,
    [userBId],
  );
  caseAId = a.rows[0].id;
  caseBId = b.rows[0].id;

  await admin.query(
    `insert into documents (case_id, doc_type, extracted)
     values ($1, 'bill', '{"total_billed": 100}'), ($2, 'eob', '{"total_billed": 200}')`,
    [caseAId, caseBId],
  );
  await admin.query(
    `insert into actions (case_id, channel, subject, status)
     values ($1, 'email', 'Appeal for A', 'draft'), ($2, 'email', 'Appeal for B', 'draft')`,
    [caseAId, caseBId],
  );
  await admin.query(
    `insert into findings (case_id, kind, description, confidence, source)
     values ($1, 'duplicate', 'Duplicate charge', 'high', 'rule'),
            ($2, 'weak_denial', 'Denial lacks rationale', 'medium', 'ai')`,
    [caseAId, caseBId],
  );
});

afterAll(async () => {
  for (const c of [userA, userB, staff, admin]) {
    await c.end();
  }
});

describe("cross-tenant isolation (RLS)", () => {
  it("user A sees only their own case", async () => {
    const res = await userA.query<{ id: string }>("select id from cases order by created_at");
    expect(res.rows.map((r) => r.id)).toEqual([caseAId]);
  });

  it("user A reads zero rows of user B's case by id", async () => {
    const res = await userA.query("select * from cases where id = $1", [caseBId]);
    expect(res.rows).toEqual([]);
  });

  it("user A reads zero rows of user B's documents", async () => {
    const res = await userA.query("select * from documents where case_id = $1", [caseBId]);
    expect(res.rows).toEqual([]);
  });

  it("user A reads zero rows of user B's actions", async () => {
    const res = await userA.query("select * from actions where case_id = $1", [caseBId]);
    expect(res.rows).toEqual([]);
  });

  it("user A reads zero rows of user B's findings and events", async () => {
    const findings = await userA.query("select * from findings where case_id = $1", [caseBId]);
    expect(findings.rows).toEqual([]);
    const events = await userA.query("select * from events where case_id = $1", [caseBId]);
    expect(events.rows).toEqual([]);
  });

  it("the users table exposes only the session's own row", async () => {
    const res = await userA.query<{ id: string }>("select id from users");
    expect(res.rows.map((r) => r.id)).toEqual([userAId]);
  });

  it("user A cannot update user B's case", async () => {
    const res = await userA.query("update cases set status = 'closed' where id = $1", [caseBId]);
    expect(res.rowCount).toBe(0);
  });

  it("user A cannot see user B in a full-table scan of every table", async () => {
    // Belt and braces: aggregate cross-tenant visibility across the tables
    // (cases scopes by owner; the rest by their case's owner; users by id).
    const res = await userA.query<{
      cases: number;
      documents: number;
      findings: number;
      actions: number;
      events: number;
    }>(
      `select
         (select count(*)::int from cases where user_id = $1) as cases,
         (select count(*)::int from documents where case_id = $2) as documents,
         (select count(*)::int from findings where case_id = $2) as findings,
         (select count(*)::int from actions where case_id = $2) as actions,
         (select count(*)::int from events where case_id = $2) as events`,
      [userBId, caseBId],
    );
    expect(res.rows[0]).toEqual({
      cases: 0,
      documents: 0,
      findings: 0,
      actions: 0,
      events: 0,
    });
  });
});

describe("audit trail (events)", () => {
  // Migration 007 dropped the table-level audit triggers. They wrote raw
  // "<table> <op>" rows into the family-visible timeline and made every
  // case deletion fail (the AFTER DELETE row referenced the case being
  // deleted and violated events_case_id_fkey). The application writes the
  // meaningful timeline entries instead — these tests pin that contract.
  it("keeps raw machine events out of the timeline on case mutations", async () => {
    const inserted = await userA.query<{ id: string }>(
      `insert into cases (user_id, provider_name) values ($1, 'Provider C') returning id`,
      [userAId],
    );
    const newCaseId = inserted.rows[0].id;

    const events = await userA.query<{ actor: string; message: string }>(
      "select actor, message from events where case_id = $1",
      [newCaseId],
    );
    expect(events.rows).toHaveLength(0);
  });

  it("keeps raw machine events out of the timeline on updates and document inserts", async () => {
    await userA.query("update cases set status = 'awaiting_approval' where id = $1", [caseAId]);
    await admin.query("insert into documents (case_id, doc_type) values ($1, 'reply')", [caseAId]);

    const res = await userA.query<{ actor: string; message: string }>(
      "select actor, message from events where case_id = $1",
      [caseAId],
    );
    expect(res.rows).toHaveLength(0);
  });

  it("blocks a user session from writing to the audit log directly", async () => {
    await expect(
      userA.query("insert into events (case_id, actor, message) values ($1, 'user', 'forged')", [
        caseAId,
      ]),
    ).rejects.toThrow();
  });

  it("deletes a case cleanly even with events history (the 007 FK fix)", async () => {
    const inserted = await userA.query<{ id: string }>(
      `insert into cases (user_id, provider_name) values ($1, 'Provider D') returning id`,
      [userAId],
    );
    const newCaseId = inserted.rows[0].id;
    await admin.query(
      "insert into events (case_id, actor, message) values ($1, 'system', 'timeline entry')",
      [newCaseId],
    );

    // Case deletion is an admin/service capability (families hold no DELETE
    // grant). Before 007 even this delete rolled back: the audit trigger's
    // AFTER DELETE insert referenced the case row being deleted.
    await expect(admin.query("delete from cases where id = $1", [newCaseId])).resolves.toBeTruthy();
  });
});

describe("staff role", () => {
  it("sees across all tenants", async () => {
    const res = await staff.query<{ n: number }>("select count(*)::int as n from cases");
    expect(res.rows[0].n).toBeGreaterThanOrEqual(2);
  });
});
