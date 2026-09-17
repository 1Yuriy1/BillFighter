/**
 * Webhook signature verification for /api/inbound.
 *
 * Postmark does not natively sign webhook deliveries — its documented security
 * options are HTTP basic auth, custom headers, and IP allowlisting — so the
 * spec's "signature-verified webhook" is a shared-secret HMAC over the raw
 * request body: the sending side (Postmark's custom-header config or a signing
 * gateway in front of the webhook) delivers
 *
 *   X-Webhook-Signature: base64(HMAC-SHA256(rawBody, POSTMARK_WEBHOOK_SECRET))
 *
 * and the receiver recomputes and compares in constant time BEFORE parsing or
 * routing anything. Unsigned or mismatched requests are rejected with 401 —
 * mail from an unverified source is never processed.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const SIGNATURE_HEADER = "x-webhook-signature";

export function computeWebhookSignature(rawBody: string, secret: string): string {
  return createHmac("sha256", secret).update(rawBody, "utf8").digest("base64");
}

export function verifyWebhookSignature(
  rawBody: string,
  signature: string | null | undefined,
  secret: string,
): boolean {
  if (!signature) return false;
  const expected = Buffer.from(computeWebhookSignature(rawBody, secret), "utf8");
  const provided = Buffer.from(signature, "utf8");
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(expected, provided);
}
