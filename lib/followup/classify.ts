/**
 * Reply classification — the deterministic layer of the follow-up engine's
 * reply handling (lib/followup/).
 *
 * Every classified reply resolves to exactly one outcome, in the spec's
 * vocabulary:
 *
 *   resolved      the insurer agreed, paid, or reprocessed in our favor
 *   partial_win   the insurer conceded something without fully denying
 *   needs_info    the insurer wants more from us before deciding
 *   denied_again  the insurer restated or reaffirmed its denial
 *   irrelevant    mail that does not bear on the dispute at all
 *
 * Ordering is conservative on purpose: any explicit denial language wins
 * first, so a mixed answer ("partially denied", "we paid part but deny the
 * rest") re-opens analysis instead of closing a dispute that continues. When
 * nothing matches, the outcome is needs_info — an unrecognizable reply gets
 * a human (and the analyst) looking at it, never a silent resolution.
 *
 * Patterns are first-person insurer phrasing ("we deny", "we have paid"),
 * which the family's own appeal letters quote only in the third person —
 * the main false-positive risk is quoted history inside a long reply, which
 * a stricter NLP pass (the analyst layer) can refine later.
 */

export const REPLY_OUTCOMES = [
  "resolved",
  "partial_win",
  "needs_info",
  "denied_again",
  "irrelevant",
] as const;

export type ReplyOutcome = (typeof REPLY_OUTCOMES)[number];

export function isReplyOutcome(value: string): value is ReplyOutcome {
  return (REPLY_OUTCOMES as readonly string[]).includes(value);
}

/** First match wins — ordered so the conservative outcome outranks the optimistic one. */
const SIGNALS: ReadonlyArray<{ outcome: ReplyOutcome; patterns: RegExp[] }> = [
  {
    outcome: "denied_again",
    patterns: [
      /\bwe (?:have |are |must )?den(?:y|ied|ies)\b/i,
      /\bdenial\b/i,
      /\bdenied\b/i,
      /\bunable to approve\b/i,
      /\b(?:cannot|can't|will not|won't) approve\b/i,
      /\b(?:cannot|can't|will not|won't) cover\b/i,
      /\bnot covered\b/i,
      /\buph(?:old|eld|olds)\b/i,
      /\badverse (?:benefit )?determination\b/i,
      /\bmaintain(?:s|ed)? our\b/i,
      /\bremains? denied\b/i,
    ],
  },
  {
    outcome: "partial_win",
    patterns: [
      /\bpartial(?:ly)?\b/i,
      /\bportion\b/i,
      /\bin part\b/i,
      /\bsome of the (?:charges|costs|amount|balance|billed)\b/i,
      /\breduc(?:ed|tion)\b/i,
      /\bdiscount(?:ed)?\b/i,
    ],
  },
  {
    outcome: "resolved",
    patterns: [
      /\b(?:claim|appeal) (?:was |has been |is )?approved\b/i,
      /\bwe (?:have |are )?(?:approved|paid|reprocessed|recalculated|adjusted|issued)\b/i,
      /\bpayment (?:was |has been )?(?:issued|made|sent|applied)\b/i,
      /\bwe agree\b/i,
      /\brefund(?:ed|s)?\b/i,
      /\b(?:zero|no) balance\b/i,
      /\bwritten?-?off\b/i,
      /\boverpayment\b/i,
      /\bcorrected the (?:claim|error)\b/i,
    ],
  },
  {
    outcome: "needs_info",
    patterns: [
      /\bwe need\b/i,
      /\bwe require\b/i,
      /\bplease (?:provide|send|submit|include|supply)\b/i,
      /\badditional (?:information|documentation|records|details)\b/i,
      /\bmore information\b/i,
      /\bmissing (?:information|documentation|records|item(?:s|ization)?)\b/i,
      /\brecords? (?:requested|required)\b/i,
      /\bitemized (?:bill|statement)\b/i,
      /\bin order to (?:process|review|complete)\b/i,
      /\bwe were unable to process\b/i,
    ],
  },
  {
    outcome: "irrelevant",
    patterns: [
      /\bpayment reminder\b/i,
      /\bpast due\b/i,
      /\bautopay\b/i,
      /\bstatement (?:is |are )?enclosed\b/i,
      /\bappointment (?:reminder|confirmation)\b/i,
      /\bsurvey\b/i,
      /\bunsubscribe\b/i,
      /\bthis (?:is an? )?automated (?:message|receipt|notice)\b/i,
    ],
  },
];

/** Normalizes a reply for matching: lowercase, whitespace-collapsed. */
function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ");
}

/**
 * Classifies a reply's text. Never throws on odd input: an empty or
 * whitespace-only body is needs_info (something came in, nothing readable —
 * look at it), not a silent pass.
 */
export function classifyReplyText(text: string): ReplyOutcome {
  const normalized = normalize(text);
  if (normalized.trim().length === 0) return "needs_info";

  for (const signal of SIGNALS) {
    if (signal.patterns.some((pattern) => pattern.test(normalized))) {
      return signal.outcome;
    }
  }
  return "needs_info";
}

/** Plain-language subject lines for a family notification, per outcome. */
export function replyNotificationSubject(outcome: ReplyOutcome): string {
  switch (outcome) {
    case "resolved":
      return "Good news — your case was resolved";
    case "partial_win":
      return "Partial win — your case was resolved";
    case "needs_info":
      return "We need a little more information";
    case "denied_again":
      return "The insurer denied the appeal again — here is the plan";
    case "irrelevant":
      return "We received a reply on your case";
  }
}
