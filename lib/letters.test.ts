/**
 * Letter-engine tests. The acceptance rule from the task: every factual claim
 * in a generated letter has a citation, and every citation resolves to an
 * existing document field. The scan for uncited facts is reimplemented here
 * (not delegated to validateDraft) so the invariant is checked independently
 * of the code that enforces it.
 */

import { describe, expect, it } from "vitest";
import { isMeaningfulValue, resolveField } from "./fieldPath";
import {
  assertSupportedDraft,
  availableTemplates,
  buildDraft,
  canReachApprovalQueue,
  formatFact,
  formatDateLong,
  formatMoney,
  LetterError,
  missingRequirements,
  TEMPLATE_IDS,
  validateDraft,
  type LetterDraft,
  type LetterTemplateId,
} from "./letters";
import {
  EMERGENCY_DOCUMENTS,
  IN_NETWORK_STATEMENT_DOCUMENTS,
  LETTER_DOCUMENTS,
  LETTERS_TODAY,
  NO_BALANCE_DOCUMENTS,
  STATEMENT_ONLY_DOCUMENTS,
} from "./fixtures/letters";

/* ------------------------------------------------------------------ */
/* Independent fact-token scanner (does NOT reuse lib/letters code)    */
/* ------------------------------------------------------------------ */

const SCAN_RULES: readonly { kind: string; re: RegExp }[] = [
  { kind: "money", re: /\$\d[\d,]*(?:\.\d{1,2})?/g },
  { kind: "iso-date", re: /\b\d{4}-\d{2}-\d{2}\b/g },
  {
    kind: "long-date",
    re: /\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}\b/g,
  },
];

interface ScannedToken {
  kind: string;
  text: string;
  index: number;
}

function scanFactTokens(body: string): ScannedToken[] {
  const tokens: ScannedToken[] = [];
  for (const rule of SCAN_RULES) {
    for (const match of body.matchAll(rule.re)) {
      tokens.push({ kind: rule.kind, text: match[0], index: match.index ?? 0 });
    }
  }
  return tokens.sort((a, b) => a.index - b.index);
}

/**
 * Uncited factual tokens in a body: every money figure, ISO date, and
 * long-form date, except the letter's own dateline (the first long-form
 * date, which is the letter's date, not a claim about the case).
 */
function uncitedTokens(draft: LetterDraft): ScannedToken[] {
  const covered = draft.citations.map((citation) => citation.claim);
  const tokens = scanFactTokens(draft.body);
  const datelineIndex = tokens.findIndex((token) => token.kind === "long-date");
  return tokens.filter(
    (token, index) =>
      index !== datelineIndex && !covered.some((claim) => claim.includes(token.text)),
  );
}

/* ------------------------------------------------------------------ */
/* Tests                                                               */
/* ------------------------------------------------------------------ */

describe("template availability", () => {
  it("offers all eleven templates (five core letters plus the cancer-specific set)", () => {
    expect(TEMPLATE_IDS).toHaveLength(11);
    expect(availableTemplates(LETTER_DOCUMENTS)).toEqual([...TEMPLATE_IDS]);
  });

  it("offers only the statement-backed templates when no denial is on the case", () => {
    expect(availableTemplates(STATEMENT_ONLY_DOCUMENTS)).toEqual([
      "billing_dispute",
      "itemized_bill_request",
      "negotiation_request",
      "financial_assistance",
      "network_exception",
      "copay_charity_adjustment",
    ]);
  });

  it("explains what a missing requirement needs", () => {
    expect(missingRequirements("denial_appeal", STATEMENT_ONLY_DOCUMENTS)).toEqual([
      'needs a document of type "denial" with a value for "denial_reason"',
    ]);
  });

  it("gates the network exception on an out-of-network record", () => {
    expect(missingRequirements("network_exception", IN_NETWORK_STATEMENT_DOCUMENTS)).toEqual([
      'needs a document of type "itemized" or "bill" or "eob" or "denial" or "plan" where "network_status" is "out"',
    ]);
    expect(
      availableTemplates(IN_NETWORK_STATEMENT_DOCUMENTS),
      "the statement itself is still draftable",
    ).toContain("itemized_bill_request");
  });

  it("gates the balance letters on a patient-responsibility figure", () => {
    expect(availableTemplates(NO_BALANCE_DOCUMENTS)).toEqual([
      "billing_dispute",
      "itemized_bill_request",
      "network_exception",
    ]);
  });

  it("throws missing_fact instead of drafting around a gap", () => {
    try {
      buildDraft("denial_appeal", STATEMENT_ONLY_DOCUMENTS, LETTERS_TODAY);
      throw new Error("expected buildDraft to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(LetterError);
      const letterError = error as LetterError;
      expect(letterError.code).toBe("missing_fact");
      expect(letterError.problems).toHaveLength(1);
    }
  });

  it("throws unknown_template for an unlisted template id", () => {
    expect(() =>
      buildDraft("love_letter" as unknown as LetterTemplateId, LETTER_DOCUMENTS, LETTERS_TODAY),
    ).toThrowError(LetterError);
  });
});

describe("every generated draft upholds the citation invariant", () => {
  for (const templateId of TEMPLATE_IDS) {
    it(`${templateId}: passes validateDraft`, () => {
      const draft = buildDraft(templateId, LETTER_DOCUMENTS, LETTERS_TODAY);
      expect(validateDraft(draft, LETTER_DOCUMENTS)).toEqual([]);
    });

    it(`${templateId}: every citation resolves to a real field on a case document`, () => {
      const draft = buildDraft(templateId, LETTER_DOCUMENTS, LETTERS_TODAY);
      expect(draft.citations.length).toBeGreaterThan(0);
      for (const citation of draft.citations) {
        // The spec's actions.citations shape: [{ claim, document_id, field }].
        expect(Object.keys(citation).sort()).toEqual(["claim", "document_id", "field"]);
        expect(draft.body).toContain(citation.claim);
        const doc = LETTER_DOCUMENTS.find((candidate) => candidate.id === citation.document_id);
        expect(doc, `document ${citation.document_id} on the case`).toBeDefined();
        const lookup = resolveField(doc!.extracted, citation.field);
        expect(lookup.exists, `field ${citation.field} exists`).toBe(true);
        expect(isMeaningfulValue(lookup.value), `field ${citation.field} has a value`).toBe(true);
      }
    });

    it(`${templateId}: no factual token in the body escapes citation (independent scan)`, () => {
      const draft = buildDraft(templateId, LETTER_DOCUMENTS, LETTERS_TODAY);
      expect(uncitedTokens(draft)).toEqual([]);
    });

    it(`${templateId}: is deterministic`, () => {
      const first = buildDraft(templateId, LETTER_DOCUMENTS, LETTERS_TODAY);
      const second = buildDraft(templateId, LETTER_DOCUMENTS, LETTERS_TODAY);
      expect(second).toEqual(first);
    });

    it(`${templateId}: survives a JSON round-trip intact (the actions-row shape)`, () => {
      const draft = buildDraft(templateId, LETTER_DOCUMENTS, LETTERS_TODAY);
      const stored = JSON.parse(JSON.stringify(draft)) as LetterDraft;
      expect(validateDraft(stored, LETTER_DOCUMENTS)).toEqual([]);
    });
  }
});

describe("generated letters read like letters", () => {
  it("opens with the dateline, the claim line, and the salutation", () => {
    const draft = buildDraft("denial_appeal", LETTER_DOCUMENTS, LETTERS_TODAY);
    expect(
      draft.body.startsWith(
        "September 17, 2026\n\nRe: Claim CLM-2026-88412 (patient: Elena Marsh)\n\nDear Claims Review Team:",
      ),
    ).toBe(true);
  });

  it("closes with the patient's cited name", () => {
    const draft = buildDraft("denial_appeal", LETTER_DOCUMENTS, LETTERS_TODAY);
    expect(draft.body.trimEnd().endsWith("Elena Marsh")).toBe(true);
    expect(
      draft.citations.some(
        (citation) => citation.field === "patient_name" && citation.claim.startsWith("Sincerely,"),
      ),
    ).toBe(true);
  });

  it("routes denial letters to the insurer and billing letters to the provider", () => {
    const appeal = buildDraft("denial_appeal", LETTER_DOCUMENTS, LETTERS_TODAY);
    expect(appeal.recipient).toBe("Meridian Health Plan");
    const dispute = buildDraft("billing_dispute", LETTER_DOCUMENTS, LETTERS_TODAY);
    expect(dispute.recipient).toBe("St. Augustine Hospital");
    expect(dispute.body).toContain("Dear Billing Office:");
  });

  it("states the denial reason verbatim and the deadline as a cited fact", () => {
    const draft = buildDraft("step_therapy_exception", LETTER_DOCUMENTS, LETTERS_TODAY);
    expect(draft.body).toContain(
      '"Services are excluded from coverage under the plan\'s step-therapy requirement."',
    );
    const appeal = buildDraft("denial_appeal", LETTER_DOCUMENTS, LETTERS_TODAY);
    expect(appeal.body).toContain("November 30, 2026");
    expect(
      appeal.citations.some(
        (citation) => citation.document_id === "doc-denial" && citation.field === "appeal_deadline",
      ),
    ).toBe(true);
  });

  it("renders the statement figures as money", () => {
    const draft = buildDraft("billing_dispute", LETTER_DOCUMENTS, LETTERS_TODAY);
    expect(draft.body).toContain("$2,490.00");
    expect(draft.body).toContain("$973.00");
    expect(draft.body).toContain("July 2, 2026");
  });

  it("adds the emergency path for emergency out-of-network care", () => {
    const draft = buildDraft("network_exception", EMERGENCY_DOCUMENTS, LETTERS_TODAY);
    expect(draft.body).toContain("The documents on file record the services as emergency care.");
    expect(draft.citations.some((citation) => citation.field === "was_emergency")).toBe(true);
    expect(validateDraft(draft, EMERGENCY_DOCUMENTS)).toEqual([]);
  });
});

describe("the approval-queue guard", () => {
  it("passes every generated draft", () => {
    for (const templateId of TEMPLATE_IDS) {
      const draft = buildDraft(templateId, LETTER_DOCUMENTS, LETTERS_TODAY);
      expect(canReachApprovalQueue(draft, LETTER_DOCUMENTS)).toBe(true);
      expect(() => assertSupportedDraft(draft, LETTER_DOCUMENTS)).not.toThrow();
    }
  });

  it("rejects a draft whose body carries an unsupported money figure", () => {
    const draft = buildDraft("denial_appeal", LETTER_DOCUMENTS, LETTERS_TODAY);
    const tampered: LetterDraft = {
      ...draft,
      body: `${draft.body}\n\nAn additional $999.00 applies.`,
    };
    expect(uncitedTokens(tampered).map((token) => token.text)).toContain("$999.00");
    expect(canReachApprovalQueue(tampered, LETTER_DOCUMENTS)).toBe(false);
    try {
      assertSupportedDraft(tampered, LETTER_DOCUMENTS);
      throw new Error("expected assertSupportedDraft to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(LetterError);
      const letterError = error as LetterError;
      expect(letterError.code).toBe("unsupported_draft");
      expect(letterError.problems.some((problem) => problem.includes("$999.00"))).toBe(true);
    }
  });

  it("rejects uncited ISO dates and repeated dateline dates", () => {
    const draft = buildDraft("denial_appeal", LETTER_DOCUMENTS, LETTERS_TODAY);
    const withIso = {
      ...draft,
      body: `${draft.body}\n\nRecords from 2026-08-08 show the same service.`,
    };
    const withDatelineRepeat = {
      ...draft,
      body: `${draft.body}\n\nSeptember 17, 2026`,
    };
    expect(canReachApprovalQueue(withIso, LETTER_DOCUMENTS)).toBe(false);
    expect(canReachApprovalQueue(withDatelineRepeat, LETTER_DOCUMENTS)).toBe(false);
  });

  it("rejects an uncited long-form date", () => {
    const draft = buildDraft("denial_appeal", LETTER_DOCUMENTS, LETTERS_TODAY);
    const tampered = {
      ...draft,
      body: `${draft.body}\n\nPlease respond by October 1, 2026.`,
    };
    expect(canReachApprovalQueue(tampered, LETTER_DOCUMENTS)).toBe(false);
  });

  it("rejects a citation whose claim text is no longer in the body", () => {
    const draft = buildDraft("denial_appeal", LETTER_DOCUMENTS, LETTERS_TODAY);
    const cited = draft.citations.find((citation) => citation.field === "denial_reason");
    expect(cited).toBeDefined();
    const tampered: LetterDraft = {
      ...draft,
      body: draft.body.replace(cited!.claim, ""),
    };
    expect(validateDraft(tampered, LETTER_DOCUMENTS)).toContainEqual(
      expect.stringContaining("claim text does not appear in the letter body"),
    );
  });

  it("rejects a claim whose text does not state the cited value", () => {
    const draft = buildDraft("billing_dispute", LETTER_DOCUMENTS, LETTERS_TODAY);
    // Rewrite the figure consistently in body and claims: the citation now
    // points at text that no longer states what the document says.
    const tampered: LetterDraft = {
      ...draft,
      body: draft.body.replaceAll("$2,490.00", "$1.00"),
      citations: draft.citations.map((citation) => ({
        ...citation,
        claim: citation.claim.replaceAll("$2,490.00", "$1.00"),
      })),
    };
    expect(validateDraft(tampered, LETTER_DOCUMENTS)).toContainEqual(
      expect.stringContaining("text does not state the value of"),
    );
  });

  it("rejects citations pointing outside the case", () => {
    const draft = buildDraft("denial_appeal", LETTER_DOCUMENTS, LETTERS_TODAY);
    const ghost: LetterDraft = {
      ...draft,
      citations: [
        ...draft.citations,
        { claim: draft.body, document_id: "doc-ghost", field: "total_billed" },
      ],
    };
    expect(validateDraft(ghost, LETTER_DOCUMENTS)).toContainEqual(
      expect.stringContaining('document "doc-ghost" is not part of this case'),
    );
    const absent: LetterDraft = {
      ...draft,
      citations: [
        ...draft.citations,
        { claim: draft.body, document_id: "doc-denial", field: "made_up_field" },
      ],
    };
    expect(validateDraft(absent, LETTER_DOCUMENTS)).toContainEqual(
      expect.stringContaining('field "made_up_field" does not exist'),
    );
    const empty: LetterDraft = {
      ...draft,
      citations: [
        ...draft.citations,
        { claim: draft.body, document_id: "doc-denial", field: "total_billed" },
      ],
    };
    expect(validateDraft(empty, LETTER_DOCUMENTS)).toContainEqual(
      expect.stringContaining('field "total_billed" in document "doc-denial" has no value'),
    );
  });

  it("keeps drafts gentle: escalation language is a problem", () => {
    const draft = buildDraft("denial_appeal", LETTER_DOCUMENTS, LETTERS_TODAY);
    const demanding: LetterDraft = {
      ...draft,
      body: `${draft.body}\n\nI demand a response within 24 hours.`,
    };
    expect(validateDraft(demanding, LETTER_DOCUMENTS)).toContainEqual(
      expect.stringContaining("escalation language"),
    );
    expect(canReachApprovalQueue(demanding, LETTER_DOCUMENTS)).toBe(false);
  });

  it("does not flag ordinary words that merely contain blocked substrings", () => {
    const draft = buildDraft("denial_appeal", LETTER_DOCUMENTS, LETTERS_TODAY);
    const issues = {
      ...draft,
      body: `${draft.body}\n\nIf any issue remains, I will assume we can resolve it.`,
    };
    expect(validateDraft(issues, LETTER_DOCUMENTS)).toEqual([]);
  });

  it("rejects unfilled placeholders, an empty body, and an empty subject", () => {
    const draft = buildDraft("denial_appeal", LETTER_DOCUMENTS, LETTERS_TODAY);
    const placeholder: LetterDraft = { ...draft, body: `${draft.body} {{amount}}` };
    expect(validateDraft(placeholder, LETTER_DOCUMENTS)).toContainEqual(
      expect.stringContaining("unfilled placeholder"),
    );
    const emptyBody: LetterDraft = { ...draft, body: "  " };
    expect(validateDraft(emptyBody, LETTER_DOCUMENTS)).toContainEqual("body is empty");
    const emptySubject: LetterDraft = { ...draft, subject: "" };
    expect(validateDraft(emptySubject, LETTER_DOCUMENTS)).toContainEqual("subject is empty");
  });
});

describe("fact formatting", () => {
  it("renders numbers as money, dates in long form, strings verbatim", () => {
    expect(formatFact(1234.5)).toBe("$1,234.50");
    expect(formatMoney(0)).toBe("$0.00");
    expect(formatMoney(2490)).toBe("$2,490.00");
    expect(formatFact("2026-07-02")).toBe("July 2, 2026");
    expect(formatDateLong("2026-11-30")).toBe("November 30, 2026");
    expect(formatFact("Meridian Health Plan")).toBe("Meridian Health Plan");
    expect(formatFact(true)).toBe("yes");
    expect(formatFact(false)).toBe("no");
  });
});
