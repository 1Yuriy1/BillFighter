import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyWebhookSignature } from "./signature";

const SECRET = "test-webhook-secret";

describe("verifyWebhookSignature", () => {
  const body = JSON.stringify({ From: "billing@example.com", To: "jane.k82@in.billfighter.com" });

  it("accepts a valid base64 HMAC-SHA256 signature", () => {
    const signature = createHmac("sha256", SECRET).update(body, "utf8").digest("base64");
    expect(verifyWebhookSignature(body, signature, SECRET)).toBe(true);
  });

  it("rejects a signature produced with the wrong secret", () => {
    const signature = createHmac("sha256", "attacker-key").update(body, "utf8").digest("base64");
    expect(verifyWebhookSignature(body, signature, SECRET)).toBe(false);
  });

  it("rejects a signature over a tampered body", () => {
    const signature = createHmac("sha256", SECRET).update(body, "utf8").digest("base64");
    expect(verifyWebhookSignature(`${body} `, signature, SECRET)).toBe(false);
  });

  it("rejects a missing or empty signature header", () => {
    expect(verifyWebhookSignature(body, null, SECRET)).toBe(false);
    expect(verifyWebhookSignature(body, undefined, SECRET)).toBe(false);
    expect(verifyWebhookSignature(body, "", SECRET)).toBe(false);
  });
});
