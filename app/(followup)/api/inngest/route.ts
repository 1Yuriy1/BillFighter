/**
 * The Inngest serve endpoint — registers the follow-up engine's functions
 * (lib/followup/jobs.ts) and runs them when Inngest invokes this route.
 *
 * `serve` verifies Inngest's request signature itself (the signing key comes
 * from INNGEST_SIGNING_KEY via Inngest's env handling); unverified requests
 * are rejected before any function body runs. Same deployment shape as the
 * Postmark inbound webhook — a route group keeps the URL at /api/inngest.
 */
import { serve } from "inngest/next";
import { inngest } from "@/lib/followup/inngest";
import { dailyDeadlineCheck, dispatchApprovedActions, replyClassificationPass } from "@/lib/followup/jobs";

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [dailyDeadlineCheck, dispatchApprovedActions, replyClassificationPass],
});
