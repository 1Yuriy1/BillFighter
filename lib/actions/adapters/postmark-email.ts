/**
 * The real email channel: Postmark's send API.
 *
 * The token comes from POSTMARK_SERVER_TOKEN (or the `serverToken` option);
 * the sender address from OUTBOUND_FROM_EMAIL (or `fromAddress`, defaulting
 * to no-reply@billfighter.com). `fetchImpl` is injectable so tests exercise
 * the contract — headers, payload, error mapping — without network.
 */
import { SendError, type ChannelAdapter, type OutboundAction, type SendResult } from "../types";

const POSTMARK_SEND_URL = "https://api.postmarkapp.com/email";
const DEFAULT_TIMEOUT_MS = 15_000;

export interface PostmarkEmailAdapterOptions {
  serverToken?: string;
  fromAddress?: string;
  messageStream?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export function makePostmarkEmailAdapter(
  options: PostmarkEmailAdapterOptions = {},
): ChannelAdapter {
  return {
    channel: "email",
    async send(action: OutboundAction): Promise<SendResult> {
      const token = options.serverToken ?? process.env.POSTMARK_SERVER_TOKEN;
      if (!token) {
        throw new SendError("POSTMARK_SERVER_TOKEN is not configured — cannot send email");
      }
      const from =
        options.fromAddress ?? process.env.OUTBOUND_FROM_EMAIL ?? "no-reply@billfighter.com";
      const doFetch = options.fetchImpl ?? fetch;

      let response: Response;
      try {
        response = await doFetch(POSTMARK_SEND_URL, {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            "X-Postmark-Server-Token": token,
          },
          body: JSON.stringify({
            From: from,
            To: action.recipient,
            Subject: action.subject,
            TextBody: action.body,
            MessageStream: options.messageStream ?? "outbound",
          }),
          signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        });
      } catch (error) {
        throw new SendError(
          `postmark: request failed — ${error instanceof Error ? error.message : "unknown transport error"}`,
          error,
        );
      }

      // Postmark returns 200 with { MessageID } on success and 4xx/5xx with a
      // human-readable { Message } explaining the rejection — surface it.
      const body = (await response.json().catch(() => null)) as {
        MessageID?: string;
        Message?: string;
      } | null;
      if (!response.ok) {
        throw new SendError(
          `postmark: send rejected (${response.status}) — ${body?.Message ?? "no detail returned"}`,
          body,
        );
      }
      return { providerId: body?.MessageID ?? null };
    },
  };
}
