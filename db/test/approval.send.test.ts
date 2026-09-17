/**
 * Integration tests for the approval + send flow, per the MVP spec's
 * verification matrix ("Approval flow" row):
 *
 *   - approve-both -> sent + events row + follow_up_at set
 *   - single approval -> still draft
 *   - send failure x3 -> parked in staff queue
 *
 * Channel adapters are mocked -- the dispatcher's behavior around them is the
 * subject, not any provider. The acceptance invariant is exercised end to
 * end: no draft reaches an adapter at any status other than approved, and a
 * failed send is never silently dropped nor silently repeated.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, Pool, type QueryResult } from "pg";
import { approveDraft, ActionError } from "../../lib/actions/approval";
import { dispatchDueActions } from "../../lib/actions/dispatch";
import { failedSendEntries } from "../../lib/actions/staffQueue";
import { followUpAt } from "../../lib/actions/timing";
import {
  SendError,
  type ChannelAdapter,
  type OutboundAction,
  type SendResult,
} from "../../lib/actions/types";
import { connectAs, DATABASE_URL } from "./db";

const NOW = new Date("2026-09-17T12:00:00Z");

const pool = new Pool({ connectionString: DATABASE_URL });
let service: Client;

beforeAll(async () => {
  // The job runner and approval APIs run on the service connection (RLS
  // bypass) -- the same posture the webhook uses; session-role behavior is
  // covered separately below.
  service = new Client({ connectionString: DATABASE_URL });
  await service.connect();
});

afterAll(async () => {
  await service.end();
  await pool.end();
});

/* ------------------------------------------------------------------ */
/* Seeding                                                             */
/* ------------------------------------------------------------------ */

async function seedCase(options: { authorized?: boolean } = {}): Promise<{
  userId: string;
  caseId: string;
}> {
  const authorized = options.authorized ?? true;
  const user = await pool.query<{ id: string }>(
    `insert into users (email, authorization_signed_at)
     values ($1, $2) returning id`,
    [`${randomUUID()}@example.com`, authorized ? NOW : null],
  );
  const caseRow = await pool.query<{ id: string }>(
    `insert into cases (user_id, status, insurer_name, provider_name)
     values ($1, 'in_progress', 'Aetna', 'Riverwalk Imaging') returning id`,
    [user.rows[0].id],
  );
  return { userId: user.rows[0].id, caseId: caseRow.rows[0].id };
}

async function seedDraft(
  caseId: string,
  overrides: Partial<{ channel: string; status: string; recipient: string }> = {},
): Promise<string> {
  const res = await pool.query<{ id: string }>(
    `insert into actions (case_id, channel, recipient, subject, body, status)
     values ($1, $2, $3, $4, $5, $6) returning id`,
    [
      caseId,
      overrides.channel ?? "email",
      overrides.recipient ?? "billing@novaparkmedical.example",
      "Billing dispute -- account 4471",
      "We are requesting an itemized bill for the visit of July 2.",
      overrides.status ?? "draft",
    ],
  );
  return res.rows[0].id;
}

interface ActionState {
  status: string;
  approved_by: string | null;
  user_approved_at: Date | null;
  staff_approved_at: Date | null;
  sent_at: Date | null;
  follow_up_at: Date | null;
  send_attempts: number;
  next_attempt_at: Date | null;
  last_error: string | null;
}

async function actionState(actionId: string): Promise<ActionState> {
  const res = await pool.query<ActionState>(
    `select status, approved_by, user_approved_at, staff_approved_at, sent_at,
            follow_up_at, send_attempts, next_attempt_at, last_error
       from actions where id = $1`,
    [actionId],
  );
  return res.rows[0];
}

async function caseEvents(
  caseId: string,
): Promise<QueryResult<{ actor: string; message: string }>> {
  return pool.query(
    "select actor, message from events where case_id = $1 order by created_at, id",
    [caseId],
  );
}

/* ------------------------------------------------------------------ */
/* Mock adapters                                                       */
/* ------------------------------------------------------------------ */

function recordingAdapter(
  channel: ChannelAdapter["channel"],
  behavior: "ok" | "fail" = "ok",
  error = new SendError("flaky provider unavailable"),
): { adapter: ChannelAdapter; calls: OutboundAction[] } {
  const calls: OutboundAction[] = [];
  return {
    calls,
    adapter: {
      channel,
      async send(action: OutboundAction): Promise<SendResult> {
        calls.push(action);
        if (behavior === "fail") throw error;
        return { providerId: `mock-${channel}-${calls.length}` };
      },
    },
  };
}

/* ------------------------------------------------------------------ */
/* The spec's three scenarios                                          */
/* ------------------------------------------------------------------ */

describe("approval flow (spec verification row)", () => {
  it("single approval -> action stays 'draft' and no adapter is ever called", async () => {
    const { caseId } = await seedCase();
    const actionId = await seedDraft(caseId);
    const email = recordingAdapter("email");

    const outcome = await approveDraft(service, actionId, "user", NOW);

    expect(outcome.status).toBe("waiting");
    const state = await actionState(actionId);
    expect(state.status).toBe("draft");
    expect(state.user_approved_at).toEqual(NOW);
    expect(state.staff_approved_at).toBeNull();
    expect(state.approved_by).toBeNull();

    const summary = await dispatchDueActions(service, [email.adapter], { now: NOW });
    expect(email.calls).toHaveLength(0);
    expect(summary.sent).toBe(0);
    expect((await actionState(actionId)).status).toBe("draft");
  });

  it("approve-both -> dispatched once, events row, follow_up_at 14 days out", async () => {
    const { caseId } = await seedCase();
    const actionId = await seedDraft(caseId);
    const email = recordingAdapter("email");

    await approveDraft(service, actionId, "user", NOW);
    const completing = await approveDraft(service, actionId, "staff", NOW);

    expect(completing.status).toBe("completed");
    expect(completing).toMatchObject({ actionStatus: "approved", approvedBy: "staff" });

    const summary = await dispatchDueActions(service, [email.adapter], { now: NOW });
    expect(summary.sent).toBe(1);
    expect(email.calls).toHaveLength(1);
    expect(email.calls[0]).toMatchObject({
      id: actionId,
      channel: "email",
      recipient: "billing@novaparkmedical.example",
    });

    const state = await actionState(actionId);
    expect(state.status).toBe("sent");
    expect(state.sent_at).toEqual(NOW);
    expect(state.follow_up_at).toEqual(followUpAt(NOW));
    expect(state.last_error).toBeNull();
    const FOLLOW_UP_DAYS_MS = 14 * 24 * 60 * 60 * 1000;
    expect(state.follow_up_at!.getTime() - state.sent_at!.getTime()).toBe(FOLLOW_UP_DAYS_MS);

    // The audit trail: each approval, the completed gate, the send.
    const events = await caseEvents(caseId);
    const messages = events.rows.map((row) => row.message);
    expect(messages.some((m) => m.includes("user approved the draft"))).toBe(true);
    expect(messages.some((m) => m.includes("staff approved the draft"))).toBe(true);
    expect(messages.some((m) => m.includes("both approvals received"))).toBe(true);
    expect(
      messages.some((m) => m.includes("letter sent via email") && m.includes("mock-email-1")),
    ).toBe(true);

    // Idempotent dispatch: a second job run must not repeat the send.
    const second = await dispatchDueActions(service, [email.adapter], { now: NOW });
    expect(second.sent).toBe(0);
    expect(email.calls).toHaveLength(1);
  });

  it("send failure x3 -> parked in staff queue with the error attached, never repeated", async () => {
    const { caseId } = await seedCase();
    const actionId = await seedDraft(caseId);
    const email = recordingAdapter("email", "fail");
    const retryBaseMs = 1000;

    await approveDraft(service, actionId, "user", NOW);
    await approveDraft(service, actionId, "staff", NOW);

    // Attempt 1 fails -> scheduled for retry, still 'approved'.
    const first = await dispatchDueActions(service, [email.adapter], {
      now: NOW,
      retryBaseMs,
    });
    expect(first.retried).toBe(1);
    let state = await actionState(actionId);
    expect(state.status).toBe("approved");
    expect(state.send_attempts).toBe(1);
    expect(state.next_attempt_at).toEqual(new Date(NOW.getTime() + retryBaseMs));
    expect(state.last_error).toContain("flaky provider unavailable");

    // Backoff is honored: a run before next_attempt_at does nothing.
    await dispatchDueActions(service, [email.adapter], {
      now: new Date(NOW.getTime() + retryBaseMs - 1),
      retryBaseMs,
    });
    expect(email.calls).toHaveLength(1);

    // Attempt 2 fails -> still 'approved', longer backoff (x5).
    const second = await dispatchDueActions(service, [email.adapter], {
      now: new Date(NOW.getTime() + retryBaseMs),
      retryBaseMs,
    });
    expect(second.retried).toBe(1);
    state = await actionState(actionId);
    expect(state.status).toBe("approved");
    expect(state.send_attempts).toBe(2);
    expect(state.next_attempt_at).toEqual(new Date(NOW.getTime() + retryBaseMs + 5 * retryBaseMs));

    // Attempt 3 fails -> parked in the staff queue with the error attached.
    const third = await dispatchDueActions(service, [email.adapter], {
      now: new Date(NOW.getTime() + retryBaseMs + 5 * retryBaseMs),
      retryBaseMs,
    });
    expect(third.parked).toBe(1);
    state = await actionState(actionId);
    expect(state.status).toBe("failed");
    expect(state.send_attempts).toBe(3);
    expect(state.last_error).toContain("flaky provider unavailable");
    expect(state.next_attempt_at).toBeNull();

    const queue = await failedSendEntries(service);
    const entry = queue.find((candidate) => candidate.id === actionId);
    expect(entry).toBeDefined();
    expect(entry!.detail).toContain("flaky provider unavailable");
    expect(entry!.summary).toContain("email");
    expect(entry!.caseLabel).toContain("Aetna");

    // Never silently repeated: the parked action is out of the due queue.
    const after = await dispatchDueActions(service, [email.adapter], {
      now: new Date(NOW.getTime() + 10 * retryBaseMs),
      retryBaseMs,
    });
    expect(after.retried).toBe(0);
    expect(after.sent).toBe(0);
    expect(email.calls).toHaveLength(3);

    // The timeline tells the whole story.
    const events = await caseEvents(caseId);
    const messages = events.rows.map((row) => row.message);
    expect(messages.some((m) => m.includes("send attempt 1 failed"))).toBe(true);
    expect(messages.some((m) => m.includes("send attempt 2 failed"))).toBe(true);
    expect(messages.some((m) => m.includes("send parked in staff queue"))).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* Structural blocks park immediately -- retrying cannot fix them      */
/* ------------------------------------------------------------------ */

describe("structural gates park immediately", () => {
  it("unsigned authorization blocks the outbound send at the gate", async () => {
    const { caseId } = await seedCase({ authorized: false });
    const actionId = await seedDraft(caseId);
    const email = recordingAdapter("email");

    await approveDraft(service, actionId, "user", NOW);
    await approveDraft(service, actionId, "staff", NOW);

    const summary = await dispatchDueActions(service, [email.adapter], { now: NOW });
    expect(summary.parked).toBe(1);
    expect(email.calls).toHaveLength(0);

    const state = await actionState(actionId);
    expect(state.status).toBe("failed");
    expect(state.last_error).toContain("authorization");

    const queue = await failedSendEntries(service);
    expect(queue.find((entry) => entry.id === actionId)).toBeDefined();
  });

  it("a channel with no adapter parks with the reason attached", async () => {
    const { caseId } = await seedCase();
    const actionId = await seedDraft(caseId, { channel: "call" });
    const email = recordingAdapter("email");

    await approveDraft(service, actionId, "user", NOW);
    await approveDraft(service, actionId, "staff", NOW);

    const summary = await dispatchDueActions(service, [email.adapter], { now: NOW });
    expect(summary.parked).toBe(1);
    expect(email.calls).toHaveLength(0);

    const state = await actionState(actionId);
    expect(state.status).toBe("failed");
    expect(state.last_error).toContain("no adapter for channel 'call'");
  });
});

/* ------------------------------------------------------------------ */
/* Gate behavior around drafts and duplicates                          */
/* ------------------------------------------------------------------ */

describe("approval gate edges", () => {
  it("rejects approving a non-draft action", async () => {
    const { caseId } = await seedCase();
    const actionId = await seedDraft(caseId, { status: "sent" });

    const error = await approveDraft(service, actionId, "staff", NOW).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ActionError);
    expect((error as ActionError).code).toBe("invalid_state");
  });

  it("rejects approvals of unknown actions", async () => {
    const error = await approveDraft(
      service,
      "00000000-0000-0000-0000-000000000000",
      "user",
      NOW,
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ActionError);
    expect((error as ActionError).code).toBe("not_found");
  });

  it("duplicate approval by the same role is a no-op", async () => {
    const { caseId } = await seedCase();
    const actionId = await seedDraft(caseId);

    await approveDraft(service, actionId, "user", NOW);
    const duplicate = await approveDraft(service, actionId, "user", NOW);

    expect(duplicate.status).toBe("duplicate");
    const state = await actionState(actionId);
    expect(state.status).toBe("draft");
    expect(state.user_approved_at).toEqual(NOW);
  });

  it("records approved_by as the role that completed the gate (user last)", async () => {
    const { caseId } = await seedCase();
    const actionId = await seedDraft(caseId);

    await approveDraft(service, actionId, "staff", NOW);
    const completing = await approveDraft(service, actionId, "user", NOW);

    expect(completing).toMatchObject({ status: "completed", approvedBy: "user" });
    const state = await actionState(actionId);
    expect(state.status).toBe("approved");
    expect(state.approved_by).toBe("user");
    expect(state.staff_approved_at).toEqual(NOW);
    expect(state.user_approved_at).toEqual(NOW);
  });
});

/* ------------------------------------------------------------------ */
/* The two-human invariant at the database layer                       */
/* ------------------------------------------------------------------ */

describe("column-level grants (migration 003)", () => {
  it("a user session may record only its own approval -- never the staff gate", async () => {
    const { userId, caseId } = await seedCase();
    const actionId = await seedDraft(caseId);
    const session = await connectAs({ role: "authenticated", sub: userId });
    try {
      // Own approval: allowed.
      await session.query("update actions set user_approved_at = $1 where id = $2", [
        NOW,
        actionId,
      ]);

      // Staff gate: refused at the grant level.
      await expect(
        session.query("update actions set staff_approved_at = $1 where id = $2", [NOW, actionId]),
      ).rejects.toThrow(/permission denied/i);

      // Status flip: refused -- approval is not self-service.
      await expect(
        session.query("update actions set status = 'approved' where id = $1", [actionId]),
      ).rejects.toThrow(/permission denied/i);

      const state = await actionState(actionId);
      expect(state.status).toBe("draft");
      expect(state.user_approved_at).toEqual(NOW);
      expect(state.staff_approved_at).toBeNull();
    } finally {
      await session.end();
    }
  });
});
