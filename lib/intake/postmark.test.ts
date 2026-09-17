import { describe, expect, it } from "vitest";
import { candidateRecipients, isPostmarkInboundPayload, parseAddressList } from "./postmark";

describe("parseAddressList", () => {
  it("extracts addresses from display-name form", () => {
    expect(parseAddressList('"Jane K" <jane.k82@in.billfighter.com>')).toEqual([
      "jane.k82@in.billfighter.com",
    ]);
  });

  it("splits multiple addresses", () => {
    expect(parseAddressList("a@b.com, C D <c@d.com>")).toEqual(["a@b.com", "c@d.com"]);
  });

  it("keeps commas inside quoted names intact", () => {
    expect(parseAddressList('"K, Jane" <jane@b.com>')).toEqual(["jane@b.com"]);
  });

  it("passes bare addresses through", () => {
    expect(parseAddressList("a@b.com")).toEqual(["a@b.com"]);
  });
});

describe("candidateRecipients", () => {
  it("collects, lowercases, and deduplicates every recipient surface", () => {
    const payload = {
      From: "billing@example.com",
      To: '"Jane K" <Jane.K82@in.billfighter.com>',
      ToFull: [{ Email: "jane.k82@in.billfighter.com", Name: "Jane K", MailboxHash: "" }],
      Cc: "archive@billfighter.com",
      OriginalRecipient: "JANE.K82@in.billfighter.com",
      MessageID: "m-1",
    };
    expect(candidateRecipients(payload)).toEqual([
      "jane.k82@in.billfighter.com",
      "archive@billfighter.com",
    ]);
  });
});

describe("isPostmarkInboundPayload", () => {
  const valid = {
    From: "billing@example.com",
    To: "jane.k82@in.billfighter.com",
    MessageID: "m-1",
    Attachments: [
      { Name: "a.pdf", Content: "AAAA", ContentType: "application/pdf", ContentLength: 3 },
    ],
  };

  it("accepts a minimal valid payload", () => {
    expect(isPostmarkInboundPayload(valid)).toBe(true);
  });

  it("accepts a payload with no attachments", () => {
    expect(isPostmarkInboundPayload({ ...valid, Attachments: undefined })).toBe(true);
  });

  it("rejects missing required fields", () => {
    expect(isPostmarkInboundPayload({ To: "a@b.com", MessageID: "m" })).toBe(false);
    expect(isPostmarkInboundPayload({ From: "a@b.com", MessageID: "m" })).toBe(false);
    expect(isPostmarkInboundPayload({ From: "a@b.com", To: "c@d.com" })).toBe(false);
    expect(isPostmarkInboundPayload(null)).toBe(false);
    expect(isPostmarkInboundPayload("webhook")).toBe(false);
  });

  it("rejects malformed attachment arrays", () => {
    expect(isPostmarkInboundPayload({ ...valid, Attachments: [{ Name: 1 }] })).toBe(false);
    expect(isPostmarkInboundPayload({ ...valid, Attachments: "attachments" })).toBe(false);
  });
});
