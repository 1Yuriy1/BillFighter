/**
 * Synthetic analyst fixtures — no real PHI. The case mirrors the extraction
 * fixture world (Elena Marsh, St. Augustine Hospital, Meridian Health Plan):
 * an out-of-network itemized bill and the matching EOB, plus the plan
 * document's terms. VALID_RESPONSE is a recorded analyst response — the
 * prompt-eval's positive control. CONTAMINATED_RESPONSE is a recording laced
 * with findings whose evidence does not resolve; it is the negative control
 * proving the hard rule rejects bad citations instead of softening them.
 */

import type { AnalyzedDocument } from "../analyze";
import type { ExtractedDocument } from "../extract";

/** A fixed clock, like the rules tests: 2026-09-17, with the EOB deadline 14 days out. */
export const TODAY = new Date("2026-09-17T12:00:00Z");

export const PLAN_TERMS = [
  "Meridian Health Plan PPO, plan year 2026: $1,500 deductible (met June 2026);",
  "20% coinsurance in network, 40% out of network after deductible;",
  "out-of-pocket maximum $6,000. No Surprises Act protections apply to emergency care.",
].join(" ");

const BILL: ExtractedDocument = {
  doc_type: "itemized",
  patient_name: "Elena Marsh",
  provider_name: "St. Augustine Hospital",
  insurer_name: null,
  claim_number: "CLM-2026-88412",
  service_dates: ["2026-07-02"],
  line_items: [
    {
      date: "2026-07-02",
      code: "45378",
      description: "Diagnostic colonoscopy",
      units: 1,
      billed: 1850,
      allowed: null,
      paid: null,
      patient_owes: null,
    },
    {
      date: "2026-07-02",
      code: "00811",
      description: "Anesthesia, colonoscopy, moderate sedation",
      units: 1,
      billed: 640,
      allowed: null,
      paid: null,
      patient_owes: null,
    },
  ],
  total_billed: 2490,
  patient_responsibility: 2490,
  denial_reason: null,
  appeal_deadline: null,
  network_status: "out",
  was_emergency: null,
  notes: "Statement says charges may not reflect insurance adjustments.",
};

const EOB: ExtractedDocument = {
  doc_type: "eob",
  patient_name: "Elena Marsh",
  provider_name: "St. Augustine Hospital",
  insurer_name: "Meridian Health Plan",
  claim_number: "CLM-2026-88412",
  service_dates: ["2026-07-02"],
  line_items: [
    {
      date: "2026-07-02",
      code: "45378",
      description: "Diagnostic colonoscopy",
      units: 1,
      billed: 1850,
      allowed: 950,
      paid: 760,
      patient_owes: 190,
    },
    {
      date: "2026-07-02",
      code: "00811",
      description: "Anesthesia, colonoscopy, moderate sedation",
      units: 1,
      billed: 640,
      allowed: 250,
      paid: 200,
      patient_owes: 50,
    },
  ],
  total_billed: 2490,
  patient_responsibility: 240,
  denial_reason: null,
  appeal_deadline: "2026-10-01",
  network_status: "out",
  was_emergency: null,
  notes: "",
};

const PLAN: ExtractedDocument = {
  doc_type: "plan",
  patient_name: "Elena Marsh",
  provider_name: null,
  insurer_name: "Meridian Health Plan",
  claim_number: null,
  service_dates: [],
  line_items: [],
  total_billed: null,
  patient_responsibility: null,
  denial_reason: null,
  appeal_deadline: null,
  network_status: "unknown",
  was_emergency: null,
  notes:
    "PPO plan year 2026: deductible $1,500 (met 06/2026); coinsurance 20% in network, " +
    "40% out of network after deductible; out-of-pocket maximum $6,000.",
};

export const ANALYST_DOCUMENTS: AnalyzedDocument[] = [
  { id: "doc-bill-1", extracted: BILL },
  { id: "doc-eob-1", extracted: EOB },
  { id: "doc-plan-1", extracted: PLAN },
];

/** Recorded analyst response — every citation resolves. The eval's positive control. */
export const VALID_RESPONSE = {
  findings: [
    {
      kind: "nsa_protected",
      description:
        "The hospital's itemized statement bills $2,490.00 in patient responsibility for " +
        "claim CLM-2026-88412, but the EOB assigns $240.00 — the out-of-network balance of " +
        "$2,250.00 is disputable under the plan's out-of-network terms.",
      estimated_savings: 2250,
      confidence: "high",
      urgent: false,
      evidence: [
        {
          document_id: "doc-bill-1",
          field: "patient_responsibility",
          quote: "Statement says charges may not reflect insurance adjustments.",
        },
        { document_id: "doc-eob-1", field: "patient_responsibility", quote: null },
        { document_id: "doc-eob-1", field: "line_items[0].allowed", quote: null },
      ],
    },
    {
      kind: "cost_share_error",
      description:
        "The EOB lists the provider as out-of-network but its patient share is 20% of the " +
        "allowed amounts — the plan's in-network coinsurance — rather than the 40% " +
        "out-of-network coinsurance its terms describe. Confirm the cost-share basis with " +
        "Meridian before paying any part of the bill.",
      estimated_savings: null,
      confidence: "medium",
      urgent: false,
      evidence: [
        { document_id: "doc-eob-1", field: "network_status", quote: null },
        { document_id: "doc-eob-1", field: "line_items[1].allowed", quote: null },
        { document_id: "doc-plan-1", field: "notes", quote: null },
      ],
    },
  ],
  plan: [
    {
      title: "Dispute the out-of-network balance in writing",
      detail:
        "Send Meridian and St. Augustine Hospital a written dispute of the $2,250.00 " +
        "difference between the bill's $2,490.00 patient responsibility and the EOB's " +
        "$240.00, citing claim CLM-2026-88412, before the EOB's 2026-10-01 deadline.",
    },
    {
      title: "Ask Meridian to confirm the cost-share basis",
      detail:
        "Request written confirmation of whether the $240.00 patient share used in-network " +
        "or out-of-network coinsurance, since the EOB's numbers and the plan terms disagree.",
    },
    {
      title: "Hold payment until the dispute resolves",
      detail:
        "Do not pay the $2,490.00 statement while the dispute is open; ask the hospital's " +
        "billing office to flag the claim as under review.",
    },
  ],
  summary:
    "The hospital billed you $2,490.00 for a colonoscopy, but the EOB — the insurer's " +
    "explanation of what it will pay — says your share is $240.00. The hospital is " +
    "out-of-network for this claim, which means it does not have a price agreement with " +
    "Meridian. The gap between the two numbers is $2,250.00, and the documents support " +
    "disputing it. The EOB gives you until October 1, 2026 to appeal.",
} as const;

/**
 * Recorded analyst response laced with unresolvable citations — the eval's
 * negative control. One finding is sound; the rest cite a document that is
 * not on the case, fields that do not exist, a field with no value, no
 * evidence at all, and a prototype-traversal path. All five must be
 * rejected, never softened into the kept findings.
 */
export const CONTAMINATED_RESPONSE = {
  findings: [
    VALID_RESPONSE.findings[0],
    {
      kind: "price_outlier",
      description:
        "The anesthesia charge of $640.00 is three times the typical regional price for " +
        "this service.",
      estimated_savings: 420,
      confidence: "low",
      urgent: false,
      evidence: [{ document_id: "doc-web-md", field: "typical_price", quote: null }],
    },
    {
      kind: "phantom_discount",
      description:
        "The EOB shows a prompt-pay discount of $95.00 that was never applied to your bill.",
      estimated_savings: 95,
      confidence: "medium",
      urgent: false,
      evidence: [{ document_id: "doc-eob-1", field: "prompt_pay_discount", quote: null }],
    },
    {
      kind: "deadline_extension",
      description:
        "The bill grants an extension of the appeal deadline beyond the standard window.",
      estimated_savings: null,
      confidence: "high",
      urgent: false,
      evidence: [{ document_id: "doc-bill-1", field: "appeal_deadline", quote: null }],
    },
    {
      kind: "unsupported_claim",
      description: "The hospital waived the entire balance in a prior phone call.",
      estimated_savings: 2490,
      confidence: "high",
      urgent: false,
      evidence: [],
    },
    {
      kind: "proto_probe",
      description: "The bill lists a billed amount on a hidden field.",
      estimated_savings: null,
      confidence: "low",
      urgent: false,
      evidence: [{ document_id: "doc-bill-1", field: "__proto__.billed", quote: null }],
    },
  ],
  plan: VALID_RESPONSE.plan,
  summary: VALID_RESPONSE.summary,
} as const;
