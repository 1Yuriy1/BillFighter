/**
 * The Inngest functions behind the follow-up engine — the scheduled side of
 * the spec's follow-up flow.
 *
 * Two functions, both backed by pure runners with injectable clocks
 * (deadlines.ts, replies.ts) so the tests drive time directly:
 *
 *   dailyDeadlineCheck — daily at 08:00 America/New_York; walks every live
 *     case's deadline through the notify → escalate → urgent tiers.
 *
 *   replyClassificationPass — every 15 minutes; classifies newly filed reply
 *     documents and moves case state. Replies deserve a faster cadence than
 *     deadlines: a family hearing "your advocate is on it" minutes after
 *     their insurer's denial lands is the product promise; the daily scan is
 *     only for the deadline ladder.
 *
 *   dispatchApprovedActions — every 5 minutes; sends approved actions
 *     through their channel adapters (Postmark email; fax/mail are stubs)
 *     and stamps follow_up_at. Fastest cadence of the three: an approved
 *     letter sitting unsent wastes the two humans who signed it.
 *
 * All run on the service connection (no RLS claims — they act across all
 * cases the way the inbound webhook does) and all rely on the same
 * structural idempotency: notifications, classifications, and sent-state
 * dispatches land under unique keys, so a retry or a re-run never double-
 * notifies or double-sends.
 */
import { Pool } from "pg";
import { makePostmarkEmailAdapter } from "@/lib/actions/adapters/postmark-email";
import { makeStubAdapter } from "@/lib/actions/adapters/stub";
import { dispatchDueActions } from "@/lib/actions/dispatch";
import type { ChannelAdapter } from "@/lib/actions/types";
import { inngest } from "./inngest";
import { runDeadlineCheck } from "./deadlines";
import { classifyPendingReplies } from "./replies";
import type { DeliverMessage } from "./notifications";
import { proposeNextAction } from "./reanalyze";

// Same local default as the webhook route (app/(intake)/api/inbound/route.ts);
// production sets DATABASE_URL to the Supabase connection string.
const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/billfighter_test",
});

/**
 * The family-facing delivery hook: the Postmark email channel from the
 * approval/send layer. The notification ledger row commits first inside the
 * case's transaction; a provider rejection throws, rolls the transaction
 * back, and the next pass retries — a notification row means "recorded and
 * sent", never "recorded and forgotten".
 */
export const deliverEmail: DeliverMessage = async (message) => {
  await makePostmarkEmailAdapter().send({
    id: message.dedupKey,
    channel: "email",
    recipient: message.to,
    subject: message.subject,
    body: message.body,
  });
};

/** The daily deadline check — spec Flows, deadline escalation tiers. */
export const dailyDeadlineCheck = inngest.createFunction(
  {
    id: "daily-deadline-check",
    retries: 2,
    triggers: [{ cron: "TZ=America/New_York 0 8 * * *" }],
  },
  async ({ step }) => {
    const summary = await step.run("run-deadline-check", async () => {
      const client = await pool.connect();
      try {
        return await runDeadlineCheck(client, { now: new Date(), deliver: deliverEmail });
      } finally {
        client.release();
      }
    });
    return summary;
  },
);

/**
 * The channel adapters the dispatcher resolves per action. Email is real
 * (Postmark); fax and mail are Phase-1 stubs that record intent with a
 * synthetic provider id — the event trail says exactly what "sent" means.
 */
export function channelAdapters(): ChannelAdapter[] {
  return [makePostmarkEmailAdapter(), makeStubAdapter("fax"), makeStubAdapter("mail")];
}

/** The approved-action dispatcher — spec Flows, approval gate → send. */
export const dispatchApprovedActions = inngest.createFunction(
  {
    id: "dispatch-approved-actions",
    retries: 2,
    triggers: [{ cron: "*/5 * * * *" }],
  },
  async ({ step }) => {
    const summary = await step.run("dispatch-due-actions", async () => {
      const client = await pool.connect();
      try {
        return await dispatchDueActions(client, channelAdapters(), { now: new Date() });
      } finally {
        client.release();
      }
    });
    return summary;
  },
);

/** The reply-classification pass — spec Flows, reply handling ladder. */
export const replyClassificationPass = inngest.createFunction(
  {
    id: "reply-classification-pass",
    retries: 2,
    triggers: [{ cron: "*/15 * * * *" }],
  },
  async ({ step }) => {
    const summary = await step.run("classify-replies", async () => {
      const client = await pool.connect();
      try {
        return await classifyPendingReplies(client, {
          now: new Date(),
          proposeNextAction: (caseId) => proposeNextAction(client, caseId, new Date()),
          deliver: deliverEmail,
        });
      } finally {
        client.release();
      }
    });
    return summary;
  },
);
