/**
 * Scheduler integration tests for the follow-up engine, per the MVP spec's
 * verification matrix (Flows: deadline escalation + reply handling).
 *
 * The clock is frozen and stepped: one case whose deadline is fixed at
 * 2026-10-01, and the job run at three injected "now" values — 14 days out
 * (family notified), 5 days out (staff escalated, family not re-emailed),
 * 2 days out (case pinned for staff, no appeal drafted). Idempotency is
 * asserted directly: re-running the job the same day — and again later
 * within the same tier — never double-notifies.
 *
 * The reply ladder runs the same way: real reply-body files on disk, real
 * DB state changes, a recorded delivery hook instead of Postmark.
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, Pool } from "pg";
import { runDeadlineCheck, deadlineEntries, isoDay } from "../../lib/followup/deadlines";
import { classifyPendingReplies } from "../../lib/followup/replies";
import { DATABASE_URL } from "./db";

/* ------------------------------------------------------------------ */
/* Clock fixtures — one deadline, three stepped "now" values           */
/* ------------------------------------------------------------------ */

const DEADLINE = "2026-10-01"; // fixed date the whole file reasons against
const DAY_14 = new Date("2026-09-17T12:00:00Z"); // 14 days out — notify tier
const DAY_5 = new Date("2026-09-26T12:00:00Z"); //  5 days out — escalate tier
const DAY_2 = new Date("2026-09-29T12:00:00Z"); //  2 days out — urgent tier
const LATER_SAME_TIER = new Date("2026-09-18T12:00:00Z"); // 13 days out — still notify

const pool = new Pool({ connectionString: DATABASE_URL });
let service: Client;

beforeAll(async () => {
  service = new Client({ connectionString: DATABASE_URL });
  await service.connect();
});

afterAll(async () => {
  await service.end();
  await pool.end();
});

/* ------------------------------------------------------------------ */
/* Seeding and query helpers                                           */
/* ------------------------------------------------------------------ */

async function seedCase(
  options: {
    status?: string;
    notificationLevel?: string;
    pauseAllMessages?: boolean;
    withDraft?: boolean;
  } = {},
): Promise<{ userId: string; caseId: string }> {
  const user = await pool.query<{ id: string }>(
    `insert into users (email, authorization_signed_at, notification_level, automated_messages_paused_at)
     values ($1, $2, $3, $4) returning id`,
    [
      `${randomUUID()}@example.com`,
      new Date("2026-09-01T00:00:00Z"),
      options.notificationLevel ?? "everything",
      options.pauseAllMessages === true ? new Date("2026-09-01T01:00:00Z") : null,
    ],
  );
  const caseRow = await pool.query<{ id: string }>(
    `insert into cases (user_id, status, insurer_name, provider_name, next_deadline)
     values ($1, $2, 'Aetna', 'Riverwalk Imaging', $3) returning id`,
    [user.rows[0].id, options.status ?? "in_progress", DEADLINE],
  );
  const caseId = caseRow.rows[0].id;
  if (options.withDraft) {
    await pool.query(
      `insert into actions (case_id, channel, recipient, subject, body, status)
       values ($1, 'email', 'aetna@example.com', 'Appeal letter', 'Please reconsider.', 'draft')`,
      [caseId],
    );
  }
  return { userId: user.rows[0].id, caseId };
}

async function userCount(caseId: string): Promise<number> {
  const result = await pool.query(
    `select count(*)::int as n from notifications where case_id = $1 and audience = 'user'`,
    [caseId],
  );
  return result.rows[0].n as number;
}

async function statusOf(caseId: string): Promise<string> {
  const result = await pool.query<{ status: string }>(`select status from cases where id = $1`, [
    caseId,
  ]);
  return result.rows[0].status;
}

/** Recorded deliveries — stands in for the Postmark adapter in these tests. */
const sent: Array<{ to: string; dedupKey: string }> = [];
const deliver = async (message: { to: string; dedupKey: string }): Promise<void> => {
  sent.push({ to: message.to, dedupKey: message.dedupKey });
};

/* ------------------------------------------------------------------ */
/* The deadline tiers, one frozen clock step at a time                 */
/* ------------------------------------------------------------------ */

describe("daily deadline check — three tiers on a frozen clock", () => {
  it("notifies the family at 14 days, escalates staff at 5 days, pins at 48 hours", async () => {
    const { caseId } = await seedCase();

    // Day 1 — 14 days out: the family hears about the deadline.
    const day1 = await runDeadlineCheck(service, { now: DAY_14, deliver, caseIds: [caseId] });
    // scanned counts the whole run against a shared database — the per-case
    // assertions below carry the guarantee.
    expect(day1.scanned).toBeGreaterThanOrEqual(1);
    expect(day1.notified).toBeGreaterThanOrEqual(1);
    const rows1 = await pool.query(
      `select kind, tier, outcome, audience, dedup_key
         from notifications where case_id = $1 order by created_at, dedup_key`,
      [caseId],
    );
    expect(rows1.rows).toHaveLength(1);
    expect(rows1.rows[0]).toMatchObject({
      kind: "deadline_tier",
      tier: "notify",
      audience: "user",
      dedup_key: `deadline:notify:${caseId}:${DEADLINE}`,
    });
    expect(sent.some((s) => s.dedupKey === `deadline:notify:${caseId}:${DEADLINE}`)).toBe(true);

    // Day 2 — 5 days out: staff is escalated as well; the family is not
    // re-emailed (the 14-day notice already counts).
    const day2 = await runDeadlineCheck(service, { now: DAY_5, deliver, caseIds: [caseId] });
    expect(day2.escalated).toBeGreaterThanOrEqual(1);
    expect(day2.notified).toBe(0);
    const staffRow = await pool.query(
      `select tier, audience from notifications
        where case_id = $1 and audience = 'staff' and tier = 'escalate'`,
      [caseId],
    );
    expect(staffRow.rows).toHaveLength(1);
    expect(await userCount(caseId)).toBe(1);

    // Day 3 — 2 days out, no appeal drafted: the case pins to the staff console.
    const day3 = await runDeadlineCheck(service, { now: DAY_2, deliver, caseIds: [caseId] });
    expect(day3.pinned).toBeGreaterThanOrEqual(1);
    const urgentRow = await pool.query(
      `select tier, audience from notifications
        where case_id = $1 and audience = 'staff' and tier = 'urgent'`,
      [caseId],
    );
    expect(urgentRow.rows).toHaveLength(1);
    expect(await userCount(caseId)).toBe(1);
  });

  it("never double-notifies: a re-run the same day is a full no-op", async () => {
    const { caseId } = await seedCase();

    await runDeadlineCheck(service, { now: DAY_14, deliver, caseIds: [caseId] });
    const againSameDay = await runDeadlineCheck(service, {
      now: new Date("2026-09-17T18:00:00Z"), // same day, different hour
      deliver,
      caseIds: [caseId],
    });
    // Earlier tests' cases are also scanned and skip — the guarantee is that
    // nothing NEW is notified, and this case's family count stays at one.
    expect(againSameDay.notified).toBe(0);
    expect(againSameDay.skipped).toBeGreaterThanOrEqual(1);

    // And again the next day, still inside the same tier (13 days out).
    const nextDay = await runDeadlineCheck(service, {
      now: LATER_SAME_TIER,
      deliver,
      caseIds: [caseId],
    });
    expect(nextDay.notified).toBe(0);
    expect(await userCount(caseId)).toBe(1);
  });

  it("notifies again when the deadline itself moves — new deadline, new key", async () => {
    const { caseId } = await seedCase();
    await runDeadlineCheck(service, { now: DAY_14, deliver, caseIds: [caseId] });
    expect(await userCount(caseId)).toBe(1);

    await pool.query(`update cases set next_deadline = '2026-10-15' where id = $1`, [caseId]);
    const moved = await runDeadlineCheck(service, { now: DAY_14, deliver, caseIds: [caseId] });
    expect(moved.notified).toBeGreaterThanOrEqual(1);
    expect(await userCount(caseId)).toBe(2);
  });

  it("pins only when no appeal is drafted — an in-motion case is left to the draft queue", async () => {
    const { caseId } = await seedCase({ withDraft: true });
    const run = await runDeadlineCheck(service, { now: DAY_2, deliver, caseIds: [caseId] });
    // Earlier tests' drafted-free cases may pin in this run — the guarantee
    // is per-case: this case never gains an urgent row.
    expect(run.skipped).toBeGreaterThanOrEqual(1);
    const urgentRows = await pool.query(
      `select 1 from notifications where case_id = $1 and tier = 'urgent'`,
      [caseId],
    );
    expect(urgentRows.rows).toHaveLength(0);
  });

  it("suppresses the family alert when automated messages are paused — staff escalation still fires", async () => {
    const { caseId } = await seedCase({ pauseAllMessages: true });

    const notifyRun = await runDeadlineCheck(service, { now: DAY_14, deliver, caseIds: [caseId] });
    expect(notifyRun.paused).toBeGreaterThanOrEqual(1);
    // Earlier tests' never-notified cases may notify in this run — the
    // per-case guarantee is the family count staying at zero.
    expect(await userCount(caseId)).toBe(0);

    const escalateRun = await runDeadlineCheck(service, { now: DAY_5, deliver, caseIds: [caseId] });
    expect(escalateRun.escalated).toBeGreaterThanOrEqual(1);
    const staffRows = await pool.query(
      `select 1 from notifications where case_id = $1 and audience = 'staff' and tier = 'escalate'`,
      [caseId],
    );
    expect(staffRows.rows).toHaveLength(1);
  });

  it("deadline alerts pass the 'action_needed' level — they always need the family", async () => {
    const { caseId } = await seedCase({ notificationLevel: "action_needed" });
    const run = await runDeadlineCheck(service, { now: DAY_14, deliver, caseIds: [caseId] });
    expect(run.notified).toBeGreaterThanOrEqual(1);
    expect(await userCount(caseId)).toBe(1);
  });

  it("skips resolved and closed cases entirely", async () => {
    const resolvedCase = await seedCase({ status: "resolved" });
    const liveCase = await seedCase();
    const run = await runDeadlineCheck(service, {
      now: DAY_14,
      deliver,
      caseIds: [resolvedCase.caseId, liveCase.caseId],
    });
    // Exclusion is proven per-case: the live case hears from us, the
    // resolved one never does.
    expect(run.notified).toBeGreaterThanOrEqual(1);
    const resolvedRows = await pool.query(
      `select count(*)::int as n from notifications where case_id = $1`,
      [resolvedCase.caseId],
    );
    expect(resolvedRows.rows[0].n).toBe(0);
    expect(await userCount(liveCase.caseId)).toBe(1);
  });

  it("reports the run day in UTC — the tier math is calendar-day based", () => {
    expect(isoDay(DAY_14)).toBe("2026-09-17");
  });
});

describe("deadline queue entries — the staff console read", () => {
  it("returns entries inside the 14-day horizon and flags the urgent ones", async () => {
    const pinned = await seedCase(); // deadline 2026-10-01, no draft → urgent at DAY_2
    const calm = await seedCase({ withDraft: true }); // at the urgent tier, but drafted
    await pool.query(`update cases set next_deadline = '2026-09-27' where id = $1`, [calm.caseId]);
    const far = await seedCase();
    await pool.query(`update cases set next_deadline = '2026-11-15' where id = $1`, [far.caseId]);

    const entries = await deadlineEntries(service, { now: DAY_2 });
    const byCase = new Map(entries.map((entry) => [entry.caseId, entry]));

    expect(byCase.has(pinned.caseId)).toBe(true);
    expect(byCase.get(pinned.caseId)?.urgent).toBe(true);
    expect(byCase.get(calm.caseId)?.urgent).toBe(false);
    expect(byCase.has(far.caseId)).toBe(false); // outside the horizon
  });
});

/* ------------------------------------------------------------------ */
/* The reply ladder                                                    */
/* ------------------------------------------------------------------ */

const tmpDir = mkdtempSync(join(tmpdir(), "billfighter-replies-"));

/** Seeds a reply document whose body file really exists, as intake files them. */
async function seedReply(caseId: string, body: string): Promise<string> {
  const filePath = join(tmpDir, `${randomUUID()}-reply-body.txt`);
  writeFileSync(filePath, body, "utf8");
  const doc = await pool.query<{ id: string }>(
    `insert into documents (case_id, doc_type, file_path) values ($1, 'reply', $2) returning id`,
    [caseId, filePath],
  );
  return doc.rows[0].id;
}

describe("reply classification — state changes, notifications, idempotency", () => {
  it("resolves the case on a resolution reply and tells the family", async () => {
    const { caseId } = await seedCase({ status: "waiting_reply" });
    const docId = await seedReply(caseId, "Your claim has been approved for payment.");
    sent.length = 0;

    const run = await classifyPendingReplies(service, { now: DAY_14, deliver, caseIds: [caseId] });
    expect(run.classified).toBe(1);
    expect(run.resolvedCases).toBe(1);
    expect(await statusOf(caseId)).toBe("resolved");

    const ledger = await pool.query(
      `select outcome from reply_classifications where document_id = $1`,
      [docId],
    );
    expect(ledger.rows[0].outcome).toBe("resolved");

    const family = await pool.query(
      `select kind, outcome, dedup_key from notifications where case_id = $1`,
      [caseId],
    );
    expect(family.rows).toHaveLength(1);
    expect(family.rows[0]).toMatchObject({ kind: "reply_outcome", outcome: "resolved" });
    expect(sent.some((s) => s.dedupKey === `reply:${docId}`)).toBe(true);
  });

  it("re-opens the case on a denied-again reply and the analyst proposes the next action", async () => {
    const { caseId } = await seedCase({ status: "waiting_reply" });
    await seedReply(caseId, "After careful review, we uphold our original decision.");

    const run = await classifyPendingReplies(service, {
      now: DAY_14,
      deliver,
      caseIds: [caseId],
      proposeNextAction: async () => ({
        title: "Request external review",
        detail: "File with the state independent review board within 4 months.",
      }),
    });
    expect(run.classified).toBeGreaterThanOrEqual(1);
    expect(run.reopened).toBeGreaterThanOrEqual(1);
    expect(await statusOf(caseId)).toBe("analyzing");

    const events = await pool.query<{ message: string }>(
      `select message from events where case_id = $1 order by created_at`,
      [caseId],
    );
    const messages = events.rows.map((row) => row.message);
    expect(messages.some((m) => m.includes("case re-opened for analysis"))).toBe(true);
    expect(messages.some((m) => m.includes("analyst proposes next action"))).toBe(true);
    expect(messages.some((m) => m.includes("Request external review"))).toBe(true);
  });

  it("records a pending proposal when no analyst hook is configured", async () => {
    const { caseId } = await seedCase({ status: "waiting_reply" });
    await seedReply(caseId, "We need more information about the services billed.");

    const run = await classifyPendingReplies(service, { now: DAY_14, deliver, caseIds: [caseId] });
    expect(run.reopened).toBe(1);
    expect(await statusOf(caseId)).toBe("analyzing");
    const events = await pool.query<{ message: string }>(
      `select message from events where case_id = $1 order by created_at`,
      [caseId],
    );
    expect(
      events.rows.some((row) =>
        row.message.includes("analyst proposal for the next action pending"),
      ),
    ).toBe(true);
  });

  it("leaves an irrelevant reply's case alone and only tells 'everything' families", async () => {
    const { caseId } = await seedCase({ status: "waiting_reply" });
    const docId = await seedReply(caseId, "This is a payment reminder for your account.");

    await classifyPendingReplies(service, { now: DAY_14, deliver, caseIds: [caseId] });
    // Per-case: the case does not move, and the classification ledger
    // records the outcome.
    expect(await statusOf(caseId)).toBe("waiting_reply");
    expect(await userCount(caseId)).toBe(1); // everything level hears FYIs
    const ledger = await pool.query(
      `select outcome from reply_classifications where document_id = $1`,
      [docId],
    );
    expect(ledger.rows[0].outcome).toBe("irrelevant");
  });

  it("suppresses irrelevant-reply notifications at the 'action_needed' level", async () => {
    const { caseId } = await seedCase({
      status: "waiting_reply",
      notificationLevel: "action_needed",
    });
    await seedReply(caseId, "This is a payment reminder for your account.");

    const run = await classifyPendingReplies(service, { now: DAY_14, deliver, caseIds: [caseId] });
    expect(run.levelSuppressed).toBe(1);
    expect(await userCount(caseId)).toBe(0);
  });

  it("suppresses family notifications while paused but still moves case state", async () => {
    const { caseId } = await seedCase({ status: "waiting_reply", pauseAllMessages: true });
    await seedReply(caseId, "After careful review, we uphold our original decision.");

    const run = await classifyPendingReplies(service, { now: DAY_14, deliver, caseIds: [caseId] });
    expect(run.reopened).toBe(1); // the case moves regardless
    expect(run.paused).toBe(1);
    expect(await userCount(caseId)).toBe(0);
    expect(await statusOf(caseId)).toBe("analyzing");
  });

  it("classifies each reply exactly once — a re-run is a full no-op", async () => {
    const { caseId } = await seedCase({ status: "waiting_reply" });
    await seedReply(caseId, "Your claim has been approved for payment.");

    await classifyPendingReplies(service, { now: DAY_14, deliver, caseIds: [caseId] });
    const eventsBefore = await pool.query(
      `select count(*)::int as n from events where case_id = $1`,
      [caseId],
    );

    const rerun = await classifyPendingReplies(service, {
      now: DAY_14,
      deliver,
      caseIds: [caseId],
    });
    // Scoped to this case, the re-run sees only the already-classified
    // document: a full no-op — no new scan hits, no new events.
    expect(rerun.scanned).toBe(0);
    expect(rerun.classified).toBe(0);
    const eventsAfter = await pool.query(
      `select count(*)::int as n from events where case_id = $1`,
      [caseId],
    );
    expect(eventsAfter.rows[0].n).toBe(eventsBefore.rows[0].n);
  });

  it("leaves a missing body file pending and keeps the pass running", async () => {
    const { caseId } = await seedCase({ status: "waiting_reply" });
    const missingDoc = await pool.query<{ id: string }>(
      `insert into documents (case_id, doc_type, file_path) values ($1, 'reply', $2) returning id`,
      [caseId, `/tmp/billfighter-gone/${randomUUID()}-reply-body.txt`],
    );
    const missingDocId = missingDoc.rows[0].id;

    const run = await classifyPendingReplies(service, { now: DAY_14, deliver, caseIds: [caseId] });
    // Storage loss is surfaced, not swallowed — and not fatal: the pass
    // completes, the document stays pending for the next pass's retry.
    expect(run.readFailures).toBe(1);
    expect(run.classified).toBe(0);
    expect(run.failures).toHaveLength(0);
    expect(await statusOf(caseId)).toBe("waiting_reply");
    expect(await userCount(caseId)).toBe(0);
    const ledger = await pool.query(
      `select count(*)::int as n from reply_classifications where document_id = $1`,
      [missingDocId],
    );
    expect(ledger.rows[0].n).toBe(0);
  });

  it("refuses an impossible transition but keeps the classification — denial on a resolved case", async () => {
    const { caseId } = await seedCase({ status: "resolved" });
    await seedReply(caseId, "After careful review, we uphold our original decision.");

    const run = await classifyPendingReplies(service, { now: DAY_14, deliver, caseIds: [caseId] });
    expect(run.reopened).toBe(0);
    expect(run.classified).toBe(1);
    expect(await statusOf(caseId)).toBe("resolved");
  });
});
