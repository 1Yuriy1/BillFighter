import { describe, expect, it } from "vitest";
import {
  backoffDelayMs,
  BACKOFF_FACTOR,
  DEFAULT_RETRY_BASE_MS,
  escalationAt,
  ESCALATE_AFTER_DAYS,
  followUpAt,
  FOLLOW_UP_AFTER_DAYS,
  MAX_SEND_ATTEMPTS,
} from "./timing";

describe("backoffDelayMs", () => {
  it("scales exponentially from the base delay", () => {
    expect(backoffDelayMs(1, 1000)).toBe(1000);
    expect(backoffDelayMs(2, 1000)).toBe(5000);
    expect(backoffDelayMs(3, 1000)).toBe(25000);
  });

  it("defaults to the production base", () => {
    expect(backoffDelayMs(1)).toBe(DEFAULT_RETRY_BASE_MS);
    expect(BACKOFF_FACTOR).toBe(5);
  });

  it("rejects non-positive attempts", () => {
    expect(() => backoffDelayMs(0)).toThrow(RangeError);
    expect(() => backoffDelayMs(-1)).toThrow(RangeError);
  });
});

describe("follow-up clock", () => {
  const sentAt = new Date("2026-09-17T12:00:00Z");

  it("follow-up letter falls due 14 days after the send", () => {
    expect(FOLLOW_UP_AFTER_DAYS).toBe(14);
    expect(followUpAt(sentAt)).toEqual(new Date("2026-10-01T12:00:00Z"));
  });

  it("staff escalation falls due 30 days after the send", () => {
    expect(ESCALATE_AFTER_DAYS).toBe(30);
    expect(escalationAt(sentAt)).toEqual(new Date("2026-10-17T12:00:00Z"));
  });

  it("caps send attempts at three (spec: park after three failures)", () => {
    expect(MAX_SEND_ATTEMPTS).toBe(3);
  });
});
