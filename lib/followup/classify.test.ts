/**
 * The reply-outcome classifier — the conservative ladder, unit-tested pure
 * (the DB behavior around it is covered in db/test/followup.test.ts).
 */
import { describe, expect, it } from "vitest";
import { classifyReplyText, replyNotificationSubject } from "./classify";

describe("classifyReplyText — the conservative ladder", () => {
  it("classifies insurer agreement, payment, and approval language as resolved", () => {
    for (const text of [
      "Your claim has been approved for payment.",
      "We have paid the disputed amount in full.",
      "Payment has been issued to your provider.",
      "We agree with your appeal — the claim was recalculated.",
      "A refund of $340 has been issued to your account.",
      "After review, we corrected the claim.",
    ]) {
      expect(classifyReplyText(text)).toBe("resolved");
    }
  });

  it("classifies partial-payment and partial-adjustment language as partial_win", () => {
    for (const text of [
      "We have adjusted the bill and reduced your responsibility by $340.",
      "We accept partial responsibility for this charge and will reprocess it.",
      "Only some of the charges are payable after our review.",
      "You are responsible for a portion of the billed amount.",
    ]) {
      expect(classifyReplyText(text)).toBe("partial_win");
    }
  });

  it("classifies more-information requests as needs_info", () => {
    for (const text of [
      "We cannot complete our review without additional information from you.",
      "Please provide the itemized statement so we can continue.",
      "We need more information about the services billed.",
      "We were unable to process the request as submitted.",
    ]) {
      expect(classifyReplyText(text)).toBe("needs_info");
    }
  });

  it("classifies denial reaffirmations as denied_again", () => {
    for (const text of [
      "After careful review, we uphold our original decision to deny this claim.",
      "Your appeal has been denied. This is our final decision.",
      "We have denied the claim again and consider the matter settled.",
      "The service is not covered under your plan.",
      "We are unable to approve the requested exception.",
      "We maintain our previous adverse benefit determination.",
    ]) {
      expect(classifyReplyText(text)).toBe("denied_again");
    }
  });

  it("classifies only explicit non-dispute mail as irrelevant — a signal is required", () => {
    for (const text of [
      "This is an automated message — please do not reply.",
      "Your statement is enclosed for your records.",
      "This is a payment reminder for your account.",
      "Please take our survey about your recent visit.",
      "Your appointment confirmation is attached.",
    ]) {
      expect(classifyReplyText(text)).toBe("irrelevant");
    }
  });

  it("falls back to needs_info for ambiguous or empty replies — never guesses a resolution", () => {
    for (const text of [
      "",
      "   ",
      "Hello?",
      "See attached.",
      "Thank you for your correspondence. Have a nice day.",
    ]) {
      expect(classifyReplyText(text)).toBe("needs_info");
    }
  });

  it("denial language outranks resolution language — a mixed answer re-opens analysis", () => {
    // The ladder stops at the first matching bucket, denial first: a letter
    // that both pays something and denies the rest never closes the case.
    expect(classifyReplyText("We have paid $200 of your claim, but the remainder is denied.")).toBe(
      "denied_again",
    );
    expect(
      classifyReplyText(
        "We resolved the disputed charge, though we note your earlier claim was denied.",
      ),
    ).toBe("denied_again");
  });
});

describe("replyNotificationSubject — plain-language, outcome-honest", () => {
  it("tells the family what the outcome was without jargon", () => {
    expect(replyNotificationSubject("resolved")).toMatch(/resolved/i);
    expect(replyNotificationSubject("partial_win")).toMatch(/partial win/i);
    expect(replyNotificationSubject("needs_info")).toMatch(/more information/i);
    expect(replyNotificationSubject("denied_again")).toMatch(/denied.*again/i);
    expect(replyNotificationSubject("irrelevant")).toMatch(/received a reply/i);
  });
});
