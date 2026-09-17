/**
 * The family-facing notification gate — the pause switch and the level
 * filter, unit-tested pure (the DB behavior around it is covered in
 * db/test/followup.test.ts).
 */
import { describe, expect, it } from "vitest";
import type { ReplyOutcome } from "./classify";
import {
  isLiveCaseStatus,
  isNotificationLevel,
  replyRelevance,
  shouldNotifyUser,
  type FamilyPrefs,
} from "./notifications";

const everything: FamilyPrefs = { notificationLevel: "everything", pauseAllMessages: false };
const actionNeeded: FamilyPrefs = { notificationLevel: "action_needed", pauseAllMessages: false };
const paused: FamilyPrefs = { notificationLevel: "everything", pauseAllMessages: true };

describe("shouldNotifyUser — pause wins over everything", () => {
  it("suppresses every relevance while the crisis switch is on, at any level", () => {
    for (const relevance of ["action_needed", "resolved", "informational"] as const) {
      expect(shouldNotifyUser(paused, relevance)).toBe(false);
      expect(
        shouldNotifyUser({ notificationLevel: "action_needed", pauseAllMessages: true }, relevance),
      ).toBe(false);
    }
  });

  it("sends everything at the 'everything' level when not paused", () => {
    for (const relevance of ["action_needed", "resolved", "informational"] as const) {
      expect(shouldNotifyUser(everything, relevance)).toBe(true);
    }
  });

  it("at the 'action_needed' level sends actions and resolutions but not pure FYIs", () => {
    expect(shouldNotifyUser(actionNeeded, "action_needed")).toBe(true);
    expect(shouldNotifyUser(actionNeeded, "resolved")).toBe(true);
    expect(shouldNotifyUser(actionNeeded, "informational")).toBe(false);
  });
});

describe("replyRelevance — the outcome-to-relevance map", () => {
  it("resolutions and denials alike reach the family at both levels", () => {
    const outcomes: ReplyOutcome[] = ["resolved", "partial_win", "needs_info", "denied_again"];
    for (const outcome of outcomes) {
      expect(replyRelevance(outcome)).not.toBe("informational");
    }
  });

  it("irrelevant replies are pure FYIs — they reach only 'everything' families", () => {
    expect(replyRelevance("irrelevant")).toBe("informational");
  });
});

describe("isNotificationLevel — parsing the stored preference", () => {
  it("accepts exactly the migration's enum values", () => {
    expect(isNotificationLevel("everything")).toBe(true);
    expect(isNotificationLevel("action_needed")).toBe(true);
  });

  it("rejects anything else so a corrupt row degrades to a code-level default", () => {
    expect(isNotificationLevel("all")).toBe(false);
    expect(isNotificationLevel("")).toBe(false);
  });
});

describe("isLiveCaseStatus — resolved and closed cases have no deadline to protect", () => {
  it("treats every active status as live", () => {
    for (const status of [
      "intake",
      "analyzing",
      "awaiting_approval",
      "in_progress",
      "waiting_reply",
    ] as const) {
      expect(isLiveCaseStatus(status)).toBe(true);
    }
  });

  it("excludes resolved and closed", () => {
    expect(isLiveCaseStatus("resolved")).toBe(false);
    expect(isLiveCaseStatus("closed")).toBe(false);
  });
});
