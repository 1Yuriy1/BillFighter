import { describe, expect, it } from "vitest";
import { makePostmarkEmailAdapter } from "./adapters/postmark-email";
import { faxAdapter } from "./adapters/fax";
import { mailAdapter } from "./adapters/mail";
import { makeStubAdapter } from "./adapters/stub";
import { SendError, type OutboundAction } from "./types";

const ACTION: OutboundAction = {
  id: "11111111-1111-1111-1111-111111111111",
  channel: "email",
  recipient: "billing@novaparkmedical.example",
  subject: "Billing dispute — account 4471",
  body: "We are requesting an itemized bill.",
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("postmark email adapter", () => {
  it("sends to the Postmark API with the server token and returns the MessageID", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const adapter = makePostmarkEmailAdapter({
      serverToken: "test-token",
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        return jsonResponse(200, { MessageID: "pm-1234" });
      },
    });

    const result = await adapter.send(ACTION);

    expect(result).toEqual({ providerId: "pm-1234" });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.postmarkapp.com/email");
    const headers = new Headers(calls[0].init.headers);
    expect(headers.get("X-Postmark-Server-Token")).toBe("test-token");
    const payload = JSON.parse(String(calls[0].init.body)) as Record<string, string>;
    expect(payload.To).toBe(ACTION.recipient);
    expect(payload.Subject).toBe(ACTION.subject);
    expect(payload.TextBody).toBe(ACTION.body);
    expect(payload.MessageStream).toBe("outbound");
    expect(payload.From).toContain("@");
  });

  it("maps a provider rejection to a SendError carrying Postmark's message", async () => {
    const adapter = makePostmarkEmailAdapter({
      serverToken: "test-token",
      fetchImpl: async () => jsonResponse(422, { Message: "Invalid 'To' address" }),
    });

    const error = await adapter.send(ACTION).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SendError);
    expect((error as SendError).message).toContain("422");
    expect((error as SendError).message).toContain("Invalid 'To' address");
  });

  it("maps a transport failure to a SendError", async () => {
    const adapter = makePostmarkEmailAdapter({
      serverToken: "test-token",
      fetchImpl: async () => {
        throw new Error("connection reset");
      },
    });

    const error = await adapter.send(ACTION).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SendError);
    expect((error as SendError).message).toContain("request failed");
  });

  it("fails loudly when no token is configured", async () => {
    const saved = process.env.POSTMARK_SERVER_TOKEN;
    delete process.env.POSTMARK_SERVER_TOKEN;
    try {
      const adapter = makePostmarkEmailAdapter({ fetchImpl: async () => jsonResponse(200, {}) });
      const error = await adapter.send(ACTION).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SendError);
      expect((error as SendError).message).toContain("POSTMARK_SERVER_TOKEN");
    } finally {
      if (saved !== undefined) process.env.POSTMARK_SERVER_TOKEN = saved;
    }
  });
});

describe("fax and mail stubs", () => {
  it("acknowledge the send with a synthetic provider id (no transmission)", async () => {
    const fax = await faxAdapter.send(ACTION);
    const mail = await mailAdapter.send(ACTION);
    expect(fax.providerId?.startsWith("stub-fax-")).toBe(true);
    expect(mail.providerId?.startsWith("stub-mail-")).toBe(true);
  });

  it("refuses to stub the real email channel", () => {
    expect(() => makeStubAdapter("email")).toThrow("email");
  });
});
