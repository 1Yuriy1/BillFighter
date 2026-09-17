/**
 * Synthetic letter fixtures — no real PHI. The case extends the extraction
 * fixture world (Elena Marsh, St. Augustine Hospital, Meridian Health Plan)
 * with the documents a cancer-family denial case carries: the plan's denial
 * of a chemotherapy administration as out-of-network and step-therapy
 * required, the itemized bill, and the matching EOB.
 */

import type { AnalyzedDocument } from "../analyze";
import type { ExtractedDocument } from "../extract";

/** A fixed clock, like the other fixture suites: 2026-09-17. */
export const LETTERS_TODAY = new Date("2026-09-17T12:00:00Z");

const DENIAL: ExtractedDocument = {
  doc_type: "denial",
  patient_name: "Elena Marsh",
  provider_name: "St. Augustine Hospital",
  insurer_name: "Meridian Health Plan",
  claim_number: "CLM-2026-88412",
  service_dates: ["2026-07-02"],
  line_items: [],
  total_billed: null,
  patient_responsibility: null,
  denial_reason: "Services are excluded from coverage under the plan's step-therapy requirement.",
  appeal_deadline: "2026-11-30",
  network_status: "out",
  was_emergency: null,
  notes: "",
};

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
      code: "96413",
      description: "Chemotherapy administration, intravenous infusion",
      units: 1,
      billed: 1850,
      allowed: null,
      paid: null,
      patient_owes: null,
    },
    {
      date: "2026-07-02",
      code: "J9271",
      description: "Ondansetron 4mg oral",
      units: 30,
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
  notes: "",
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
      code: "96413",
      description: "Chemotherapy administration, intravenous infusion",
      units: 1,
      billed: 1850,
      allowed: 1110,
      paid: 777,
      patient_owes: 333,
    },
    {
      date: "2026-07-02",
      code: "J9271",
      description: "Ondansetron 4mg oral",
      units: 30,
      billed: 640,
      allowed: 0,
      paid: 0,
      patient_owes: 640,
    },
  ],
  total_billed: 2490,
  patient_responsibility: 973,
  denial_reason: null,
  appeal_deadline: null,
  network_status: "out",
  was_emergency: null,
  notes: "",
};

/** The full fixture case: denial, itemized bill, and EOB. */
export const LETTER_DOCUMENTS: AnalyzedDocument[] = [
  { id: "doc-denial", extracted: DENIAL },
  { id: "doc-itemized-bill", extracted: BILL },
  { id: "doc-eob", extracted: EOB },
];

/** A case with only a statement on file — no denial, no EOB. */
export const STATEMENT_ONLY_DOCUMENTS: AnalyzedDocument[] = [
  { id: "doc-itemized-bill", extracted: BILL },
];

/** An in-network statement — the negative control for the network exception. */
const IN_NETWORK_BILL: ExtractedDocument = { ...BILL, network_status: "in" };

export const IN_NETWORK_STATEMENT_DOCUMENTS: AnalyzedDocument[] = [
  { id: "doc-itemized-bill", extracted: IN_NETWORK_BILL },
];

/** A statement with no patient-responsibility figure — the balance letters' gap. */
const NO_BALANCE_BILL: ExtractedDocument = {
  ...BILL,
  patient_responsibility: null,
};

export const NO_BALANCE_DOCUMENTS: AnalyzedDocument[] = [
  { id: "doc-itemized-bill", extracted: NO_BALANCE_BILL },
];

/** An emergency out-of-network record for the emergency-path network letter. */
const EMERGENCY_BILL: ExtractedDocument = { ...BILL, was_emergency: true };

export const EMERGENCY_DOCUMENTS: AnalyzedDocument[] = [
  { id: "doc-emergency-bill", extracted: EMERGENCY_BILL },
];
