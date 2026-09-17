/**
 * Synthetic fixture documents for extraction tests. These are fake OCR texts
 * — no real PHI — spanning the document types the intake pipeline meets:
 * a clean bill, an itemized statement, an EOB, a denial with an explicit
 * appeal deadline, a blurry photo that OCR could barely read, a multi-page
 * EOB with an illegible line, and a denial that states no deadline.
 */
export interface FixtureDocument {
  name: string;
  text: string;
}

export const FIXTURES = {
  cleanBill: {
    name: "clean bill",
    text: [
      "RIVERSIDE FAMILY MEDICINE",
      "1200 Garden View Drive, Suite 210",
      "Patient: Elena Marsh          Account: 88-2042",
      "Statement Date: 08/15/2026",
      "",
      "Date of Service: 08/01/2026",
      "CPT 99213 - Established patient office visit ............ $150.00",
      "CPT 36415 - Venipuncture ................................ $12.00",
      "",
      "TOTAL AMOUNT DUE: $162.00",
      "Please remit within 30 days.",
    ].join("\n"),
  },
  itemizedBill: {
    name: "itemized bill",
    text: [
      "ST. AUGUSTINE HOSPITAL",
      "ITEMIZED STATEMENT",
      "Account #: 0044821      Patient: Elena Marsh",
      "Admission: 07/02/2026   Discharge: 07/03/2026",
      "",
      "Svc Date      CPT     Description                              Units   Charge",
      "07/02/2026    45378   Diagnostic colonoscopy                   1       1,850.00",
      "07/02/2026    00811   Anesthesia, colonoscopy, moderate        1         640.00",
      "07/02/2026    J1885   Ketorolac tromethamine injection 15mg    2          76.00",
      "07/03/2026    99233   Subsequent hospital care, high           1         210.00",
      "",
      "Subtotal: $2,776.00",
      "Insurance Adjustments: $0.00",
      "BALANCE DUE: $2,776.00",
    ].join("\n"),
  },
  eob: {
    name: "EOB",
    text: [
      "MERIDIAN HEALTH PLAN",
      "EXPLANATION OF BENEFITS — THIS IS NOT A BILL",
      "Claim Number: CL-2026-118842",
      "Insured: Elena Marsh",
      "Provider: Riverside Family Medicine",
      "Date(s) of Service: 08/01/2026",
      "",
      "CPT     Billed    Allowed    Plan Paid   Patient Responsibility",
      "99213   150.00    96.00      76.80       19.20",
      "36415   12.00     12.00      9.60        2.40",
      "",
      "Claim Totals:  Billed $162.00   Allowed $108.00   Plan Paid $86.40   Patient Responsibility $21.60",
      "Provider Network Status: IN NETWORK",
    ].join("\n"),
  },
  denialLetter: {
    name: "denial letter with explicit deadline",
    text: [
      "MERIDIAN HEALTH PLAN",
      "NOTICE OF ADVERSE BENEFIT DETERMINATION",
      "",
      "Date: 08/20/2026",
      "Claim Number: CL-2026-118842",
      "Denial Reference: DEN-55219",
      "",
      "Dear Member:",
      "",
      "We have determined that the following service is not a covered benefit:",
      "  Service: MRI lumbar spine (CPT 72148)",
      "  Date of Service: 08/02/2026",
      "  Billed Amount: $1,950.00",
      "",
      "Reason for Denial: Prior authorization was not obtained before the",
      "service was rendered.",
      "",
      "You have the right to appeal this determination. Your appeal must be",
      "submitted in writing no later than February 16, 2027.",
    ].join("\n"),
  },
  blurryPhoto: {
    name: "blurry photo",
    text: [
      "[OCR CONFIDENCE: LOW — photographed document, page 1 of 1]",
      "Pat______________________________",
      "______visit... 0_/__2026",
      "am___due $____.__",
      "[remaining 14 lines illegible]",
    ].join("\n"),
  },
  multipageEob: {
    name: "multi-page EOB with an illegible line",
    text: [
      "MERIDIAN HEALTH PLAN",
      "EXPLANATION OF BENEFITS — PAGE 1 OF 3",
      "Claim Number: CL-2026-120001",
      "Insured: Elena Marsh    Provider: Lakeview Radiology Associates",
      "Date(s) of Service: 07/28/2026",
      "",
      "CPT     Billed     Allowed    Plan Paid   Patient Responsibility",
      "70450   850.00     410.00     328.00      82.00",
      "72148   1,050.00   590.00     472.00      118.00",
      "",
      "--- PAGE 2 OF 3 ---",
      "CPT     Billed     Allowed    Plan Paid   Patient Responsibility",
      "72158   1,450.00   780.00     624.00      156.00",
      "[NOTE: one line on this page could not be scanned]",
      "",
      "--- PAGE 3 OF 3 ---",
      "Claim Totals:  Billed $4,120.00   Allowed $2,180.00   Plan Paid $1,744.00",
      "Patient Responsibility: $436.00",
    ].join("\n"),
  },
  missingDeadlineDenial: {
    name: "denial letter with no stated deadline",
    text: [
      "MERIDIAN HEALTH PLAN",
      "DETERMINATION NOTICE",
      "",
      "Date: 09/02/2026",
      "Claim Number: CL-2026-121904",
      "",
      "Member: Elena Marsh",
      "Service: Physical therapy, lower back (CPT 97110), date of service 08/05/2026",
      "Billed Amount: $510.00",
      "",
      "Reason for Denial: The plan has determined these services were not",
      "medically necessary under the terms of your coverage.",
      "",
      "You may contact Member Services at the number on your ID card to discuss",
      "this determination or to request a review of the decision. Information",
      "about your appeal rights is available in your plan documents.",
    ].join("\n"),
  },
} satisfies Record<string, FixtureDocument>;

export type FixtureName = keyof typeof FIXTURES;
