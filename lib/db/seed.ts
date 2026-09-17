/**
 * Idempotent synthetic seed for the consoles (spec: build ships synthetic
 * data only — no real PHI).
 *
 * Creates the staff seat, two families, a caregiver with a grant on family
 * A, and enough case shape to exercise every staff-console queue: a family
 * draft awaiting both approvals, a family-approved draft (urgent staff pin),
 * a low-confidence extraction, a stuck case (backdated activity), a 48-hour
 * deadline, and a pending orphan email.
 *
 * Every step is get-or-create keyed on a stable natural key, so repeated
 * calls (CI reruns, walkthrough refreshes) converge instead of duplicating.
 */

import type { PoolClient, QueryResultRow } from "pg";

export interface SeedSummary {
  staff: { email: string };
  familyA: { email: string; caseTitles: string[]; draftSubject: string };
  familyB: { email: string; caseTitles: string[]; draftSubject: string };
  caregiver: { email: string; grantedTo: string };
}

interface IdRow extends QueryResultRow {
  id: string;
}

function daysFromNow(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

async function ensureUser(
  client: PoolClient,
  email: string,
  fullName: string,
  options: { isStaff?: boolean } = {},
): Promise<string> {
  const existing = await client.query<IdRow>(`select id from users where email = $1`, [email]);
  if (existing.rows.length > 0) {
    return existing.rows[0].id;
  }
  const inserted = await client.query<IdRow>(
    `insert into users (email, full_name, is_staff, authorization_signed_at)
     values ($1, $2, $3, now())
     returning id`,
    [email, fullName, options.isStaff ?? false],
  );
  return inserted.rows[0].id;
}

async function ensureCase(
  client: PoolClient,
  userId: string,
  keys: { insurerName: string; providerName: string },
  values: {
    status: string;
    amountDisputed: string;
    amountSaved: string;
    nextDeadline: string | null;
    createdAt?: Date;
  },
): Promise<string> {
  const existing = await client.query<IdRow>(
    `select id from cases where user_id = $1 and insurer_name = $2 and provider_name = $3`,
    [userId, keys.insurerName, keys.providerName],
  );
  if (existing.rows.length > 0) {
    return existing.rows[0].id;
  }
  const inserted = await client.query<IdRow>(
    `insert into cases (user_id, status, insurer_name, provider_name, amount_disputed,
                        amount_saved, next_deadline, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     returning id`,
    [
      userId,
      values.status,
      keys.insurerName,
      keys.providerName,
      values.amountDisputed,
      values.amountSaved,
      values.nextDeadline,
      values.createdAt ?? new Date(),
    ],
  );
  return inserted.rows[0].id;
}

async function ensureDocument(
  client: PoolClient,
  caseId: string,
  docType: string,
  values: { needsHumanReview: boolean; reviewReason: string | null },
): Promise<string> {
  const existing = await client.query<IdRow>(
    `select id from documents where case_id = $1 and doc_type = $2`,
    [caseId, docType],
  );
  if (existing.rows.length > 0) {
    return existing.rows[0].id;
  }
  const inserted = await client.query<IdRow>(
    `insert into documents (case_id, doc_type, needs_human_review, review_reason, extracted)
     values ($1, $2, $3, $4, $5)
     returning id`,
    [
      caseId,
      docType,
      values.needsHumanReview,
      values.reviewReason,
      JSON.stringify({ source: "seed" }),
    ],
  );
  return inserted.rows[0].id;
}

async function ensureDraft(
  client: PoolClient,
  caseId: string,
  subject: string,
  values: {
    recipient: string;
    body: string;
    citations: unknown;
    userApprovedAt: Date | null;
  },
): Promise<string> {
  const existing = await client.query<IdRow>(
    `select id from actions where case_id = $1 and subject = $2`,
    [caseId, subject],
  );
  if (existing.rows.length > 0) {
    return existing.rows[0].id;
  }
  const inserted = await client.query<IdRow>(
    `insert into actions (case_id, channel, recipient, subject, body, citations,
                          status, user_approved_at)
     values ($1, 'email', $2, $3, $4, $5, 'draft', $6)
     returning id`,
    [
      caseId,
      values.recipient,
      subject,
      values.body,
      JSON.stringify(values.citations),
      values.userApprovedAt,
    ],
  );
  return inserted.rows[0].id;
}

async function ensureEvent(
  client: PoolClient,
  caseId: string,
  keys: { actor: string; message: string },
  createdAt?: Date,
): Promise<void> {
  const existing = await client.query<QueryResultRow>(
    `select 1 from events where case_id = $1 and actor = $2 and message = $3`,
    [caseId, keys.actor, keys.message],
  );
  if (existing.rows.length > 0) {
    return;
  }
  await client.query(
    `insert into events (case_id, actor, message, created_at) values ($1, $2, $3, $4)`,
    [caseId, keys.actor, keys.message, createdAt ?? new Date()],
  );
}

async function ensureOrphan(client: PoolClient, subject: string): Promise<void> {
  const existing = await client.query<QueryResultRow>(
    `select 1 from orphan_emails where subject = $1`,
    [subject],
  );
  if (existing.rows.length > 0) {
    return;
  }
  await client.query(
    `insert into orphan_emails (from_email, recipients, subject, reason, status, raw_payload)
     values ('stranger@unknown-clinic.example', 'unknown@billfighter.local', $1, 'unknown_recipient', 'pending', $2)`,
    [
      subject,
      JSON.stringify({
        From: "stranger@unknown-clinic.example",
        FromFullName: "Unknown Clinic",
        To: "unknown@billfighter.local",
        Subject: subject,
        MessageID: `seed-${subject.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
        TextBody: "This message did not match any known alias or case address.",
        Date: new Date().toISOString(),
      }),
    ],
  );
}

async function ensureGrant(
  client: PoolClient,
  familyUserId: string,
  caregiverUserId: string,
  familyEmail: string,
  caregiverEmail: string,
): Promise<void> {
  const existing = await client.query<QueryResultRow>(
    `select 1 from caregiver_grants where family_user_id = $1 and caregiver_user_id = $2`,
    [familyUserId, caregiverUserId],
  );
  if (existing.rows.length > 0) {
    return;
  }
  await client.query(
    `insert into caregiver_grants (family_user_id, caregiver_user_id, family_email, caregiver_email)
     values ($1, $2, $3, $4)`,
    [familyUserId, caregiverUserId, familyEmail, caregiverEmail],
  );
}

async function userIdByEmail(client: PoolClient, email: string): Promise<string> {
  const found = await client.query<IdRow>(`select id from users where email = $1`, [email]);
  if (found.rows.length === 0) {
    throw new Error(`seed invariant violated: user ${email} must exist by grant time`);
  }
  return found.rows[0].id;
}

/** Creates the demo data set if absent; safe to call repeatedly. */
export async function seedDemoData(client: PoolClient): Promise<SeedSummary> {
  const staffEmail = "staff@billfighter.local";
  const familyAEmail = "family.martinez@example.com";
  const familyBEmail = "family.rossi@example.com";
  const caregiverEmail = "caregiver@example.com";

  await ensureUser(client, staffEmail, "BillFighter Staff", { isStaff: true });
  const familyA = await ensureUser(client, familyAEmail, "Maria Martinez");
  const familyB = await ensureUser(client, familyBEmail, "Elena Rossi");
  await ensureUser(client, caregiverEmail, "Chris Martinez (caregiver)");

  // Family A, case 1 — a draft waiting on BOTH approvals (the dogfood path).
  const caseA1 = await ensureCase(
    client,
    familyA,
    { insurerName: "BlueCross BlueShield", providerName: "Mercy General Hospital" },
    {
      status: "awaiting_approval",
      amountDisputed: "1420.50",
      amountSaved: "320.00",
      nextDeadline: daysFromNow(12),
    },
  );
  const docA1 = await ensureDocument(client, caseA1, "bill", {
    needsHumanReview: false,
    reviewReason: null,
  });
  await ensureDraft(client, caseA1, "Appeal of denied imaging claim", {
    recipient: "appeals@bcbs.example",
    body:
      "Dear Claims Department,\n\nI am appealing the denial of the MRI claim dated " +
      "September 2 (billed $1,420.50). The imaging was ordered by Dr. Okafor after " +
      "the emergency visit and the plan's own policy covers post-ER follow-up " +
      "imaging. Please reconsider.\n\nSincerely,\nMaria Martinez",
    citations: [
      {
        claim: "The bill shows $1,420.50 for the MRI (CPT 70553).",
        document_id: docA1,
        field: "total_charged",
      },
      {
        claim: "The EOB lists the denial code CO-29 for this date of service.",
        document_id: docA1,
        field: "denial_code",
      },
    ],
    userApprovedAt: null,
  });
  await ensureEvent(client, caseA1, {
    actor: "agent",
    message: "Case opened from an emailed bill.",
  });
  await ensureEvent(client, caseA1, {
    actor: "system",
    message: "Bill extracted — 2 findings, math checks passed.",
  });
  await ensureEvent(client, caseA1, {
    actor: "agent",
    message: "Appeal letter drafted from 2 cited findings.",
  });

  // Family A, case 2 — no activity for 12 days: the stuck queue.
  const caseA2 = await ensureCase(
    client,
    familyA,
    { insurerName: "Aetna", providerName: "Oncology Associates" },
    {
      status: "waiting_reply",
      amountDisputed: "890.00",
      amountSaved: "0.00",
      nextDeadline: null,
      createdAt: new Date(daysAgoIso(12)),
    },
  );
  await ensureEvent(
    client,
    caseA2,
    { actor: "agent", message: "Reconsideration letter sent to Aetna." },
    new Date(daysAgoIso(12)),
  );

  // Family B — family-approved draft (staff-urgent), low-confidence doc,
  // 48-hour deadline: three queue kinds on one case.
  const caseB1 = await ensureCase(
    client,
    familyB,
    { insurerName: "UnitedHealthcare", providerName: "Riverbend Clinic" },
    {
      status: "awaiting_approval",
      amountDisputed: "412.25",
      amountSaved: "0.00",
      nextDeadline: daysFromNow(2),
    },
  );
  const docB1 = await ensureDocument(client, caseB1, "eob", {
    needsHumanReview: true,
    reviewReason:
      "math_check: line items sum to $512.25 but the stated balance is $412.25 — manual check required",
  });
  await ensureDraft(client, caseB1, "Request for corrected EOB", {
    recipient: "memberAppeals@uhc.example",
    body:
      "Dear UnitedHealthcare,\n\nThe EOB for my July 18 visit lists line items totaling " +
      "$512.25 but shows a member balance of $412.25. Please send a corrected EOB " +
      "so the record is accurate before I file my appeal.\n\nThank you,\nElena Rossi",
    citations: [
      {
        claim: "The EOB's line items total $512.25 while the stated balance is $412.25.",
        document_id: docB1,
        field: "balance",
      },
    ],
    userApprovedAt: new Date(),
  });
  await ensureEvent(client, caseB1, {
    actor: "agent",
    message: "Case opened from an emailed EOB.",
  });
  await ensureEvent(client, caseB1, {
    actor: "system",
    message: "EOB extracted with a math discrepancy — flagged for human review.",
  });
  await ensureEvent(client, caseB1, {
    actor: "agent",
    message: "Correction request drafted from 1 cited finding.",
  });

  await ensureGrant(
    client,
    familyA,
    await userIdByEmail(client, caregiverEmail),
    familyAEmail,
    caregiverEmail,
  );
  await ensureOrphan(client, "Question about my bill");

  return {
    staff: { email: staffEmail },
    familyA: {
      email: familyAEmail,
      caseTitles: ["BlueCross BlueShield — Mercy General Hospital", "Aetna — Oncology Associates"],
      draftSubject: "Appeal of denied imaging claim",
    },
    familyB: {
      email: familyBEmail,
      caseTitles: ["UnitedHealthcare — Riverbend Clinic"],
      draftSubject: "Request for corrected EOB",
    },
    caregiver: { email: caregiverEmail, grantedTo: familyAEmail },
  };
}
