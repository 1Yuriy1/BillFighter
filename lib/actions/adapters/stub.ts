/**
 * Stub channels for Phase 1: fax and postal mail.
 *
 * The spec asks for "fax and mail as interfaces with stub implementations" —
 * the pipeline must run end to end today, but no external transmission
 * happens. A stub acknowledges the send with a synthetic provider id so the
 * dispatcher's event trail records exactly what "sent" means: an intent
 * recorded by a stub, not a delivery. Real implementations replace these by
 * registering a real ChannelAdapter for the channel — no dispatch changes.
 */
import { randomUUID } from "node:crypto";
import type { ActionChannel, ChannelAdapter, SendResult } from "../types";

export function makeStubAdapter(channel: ActionChannel): ChannelAdapter {
  if (channel === "email") {
    throw new Error("makeStubAdapter: email is the real Postmark channel — no stub allowed");
  }
  return {
    channel,
    async send(): Promise<SendResult> {
      return { providerId: `stub-${channel}-${randomUUID()}` };
    },
  };
}
