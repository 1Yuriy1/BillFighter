/**
 * Read models for the two consoles, run under the caller's session client.
 *
 * Every function here takes the connection as an argument and runs plain SQL
 * — no user_id filters in app code. Visibility is RLS's job: under a family
 * session the queries physically cannot see another family's rows, and under
 * a caregiver session the caregiver_grants policies widen the scope exactly
 * one hop. The staff console runs under the `staff` role, which the schema
 * grants full access to.
 *
 * (The pages call these through withSessionClient(claims, ...); the tests
 * call them with db/test connectAs sessions so cross-tenant invisibility is
 * asserted against the real policies.)
 */

import type { PoolClient, QueryResultRow } from "pg";
import { isCaseStatus, type CaseStatus } from "@/lib/caseState";
import { deadlineTier, daysPhrase, daysUntil, formatDate } from "@/lib/display";
import { failedSendEntries } from "@/lib/actions/staffQueue";
import type { StaffQueueEntry } from "@/components/staff/StaffQueueTable";
import type { NotificationLevel } from "@/components/notifications/NotificationLevelPicker";
import type { CaseTimelineEvent, TimelineActor } from "@/components/cases/CaseTimeline";
import type { DraftCitation, DraftStatus } from "@/components/actions/DraftReviewCard";

type Queryable = PoolClient;

/* ------------------------------------------------------------------ */
/* Family dashboard                                                    */
/* ------------------------------------------------------------------ */

export interface DraftView {
  id: string;
  title: string;
  recipient: string | null;
  body: string;
  citations: DraftCitation[];
  status: DraftStatus;
  userApproved: boolean;
  staffApproved: boolean;
  /** ISO timestamp of the last update. */
  updatedAt: string;
}

export interface FamilyCaseView {
  id: string;
  title: string;
  status: CaseStatus;
  providerName: string | null;
  insurerName: string | null;
  amountDisputed: number | null;
  amountSaved: number | null;
  /** ISO date (yyyy-mm-dd) or null. */
  nextDeadline: string | null;
  events: CaseTimelineEvent[];
  drafts: DraftView[];
}

export interface CaregiverGrantView {
  id: string;
  caregiverEmail: string;
  createdAt: string;
}

export interface DelegatedFamilyView {
  /** caregiver_grants id — display only; the family's cases come via RLS. */
  id: string;
  familyEmail: string;
}

export interface FamilyDashboard {
  email: string;
  fullName: string | null;
  notificationLevel: NotificationLevel;
  /** Non-null when the crisis switch is on for this family. */
  pausedAt: string | null;
  cases: FamilyCaseView[];
  /** Grants the signed-in family has handed out. */
  caregiverGrants: CaregiverGrantView[];
  /** Grants naming the signed-in user as caregiver — the banner's source. */
  caregiverFor: DelegatedFamilyView[];
}

interface CaseRow extends QueryResultRow {
  id: string;
  status: string;
  provider_name: string | null;
  insurer_name: string | null;
  amount_disputed: string | null;
  amount_saved: string | null;
  next_deadline: Date | null;
  created_at: Date;
}

interface ActionRow extends QueryResultRow {
  id: string;
  case_id: string;
  channel: string;
  recipient: string | null;
  subject: string | null;
  body: string | null;
  citations: unknown;
  status: string;
  user_approved_at: Date | null;
  staff_approved_at: Date | null;
  created_at: Date;
}

interface EventRow extends QueryResultRow {
  id: string;
  case_id: string;
  actor: string;
  message: string | null;
  created_at: Date;
}

interface DocumentRow extends QueryResultRow {
  id: string;
  case_id: string;
  doc_type: string | null;
  created_at: Date;
}

interface GrantRow extends QueryResultRow {
  id: string;
  caregiver_email: string;
  family_email: string;
  created_at: Date;
}

function toNumberOrNull(value: string | null): number | null {
  return value === null ? null : Number(value);
}

function toIsoOrNull(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

function caseTitle(row: Pick<CaseRow, "insurer_name" | "provider_name" | "id">): string {
  const parts = [row.insurer_name, row.provider_name].filter((part) => part !== null);
  if (parts.length === 0) {
    return `Case ${row.id.slice(0, 8)}`;
  }
  return parts.join(" — ");
}

function documentLabel(docType: string | null, createdAt: Date): string {
  const type = docType === null || docType === "" ? "document" : docType;
  return `${type} document, received ${formatDate(createdAt.toISOString())}`;
}

function isTimelineActor(value: string): value is TimelineActor {
  return value === "agent" || value === "staff" || value === "user" || value === "system";
}

/**
 * Parses the actions.citations jsonb (`[{claim, document_id, field}]`) into
 * the DraftReviewCard's citation slots. A citation naming a document the
 * session cannot see degrades to a placeholder label — the card must never
 * render a claim without its source.
 */
function parseCitations(raw: unknown, docsById: Map<string, DocumentRow>): DraftCitation[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const citations: DraftCitation[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object") {
      continue;
    }
    const record = entry as { claim?: unknown; document_id?: unknown; field?: unknown };
    if (typeof record.claim !== "string" || record.claim === "") {
      continue;
    }
    const documentId = typeof record.document_id === "string" ? record.document_id : null;
    const doc = documentId === null ? undefined : docsById.get(documentId);
    citations.push({
      claim: record.claim,
      documentLabel: doc
        ? documentLabel(doc.doc_type, doc.created_at)
        : "(source document not attached)",
      field: typeof record.field === "string" ? record.field : "(unknown field)",
    });
  }
  return citations;
}

const REVIEWABLE_STATUSES = ["draft", "failed"] as const;

/** Loads the full dashboard for the session's RLS scope, or null for an unknown user id. */
export async function familyDashboardData(client: Queryable): Promise<FamilyDashboard | null> {
  const profileResult = await client.query<QueryResultRow>(
    `select email, full_name, notification_level, automated_messages_paused_at
       from users
      where id = auth.uid()`,
  );
  const profile = profileResult.rows[0];
  if (profile === undefined) {
    return null;
  }

  const caseRows = await client.query<CaseRow>(
    `select id, status, provider_name, insurer_name, amount_disputed, amount_saved,
            next_deadline, created_at
       from cases
      order by created_at desc`,
  );
  const caseIds = caseRows.rows.map((row) => row.id);

  const docRows =
    caseIds.length === 0
      ? { rows: [] as DocumentRow[] }
      : await client.query<DocumentRow>(
          `select id, case_id, doc_type, created_at from documents where case_id = any($1::uuid[])`,
          [caseIds],
        );
  const docsById = new Map(docRows.rows.map((doc) => [doc.id, doc]));

  const actionRows =
    caseIds.length === 0
      ? { rows: [] as ActionRow[] }
      : await client.query<ActionRow>(
          `select id, case_id, channel, recipient, subject, body, citations, status,
                  user_approved_at, staff_approved_at, created_at
             from actions
            where status = any($1::text[])
            order by created_at`,
          [[...REVIEWABLE_STATUSES]],
        );

  const eventRows =
    caseIds.length === 0
      ? { rows: [] as EventRow[] }
      : await client.query<EventRow>(
          `select id, case_id, actor, message, created_at
             from events
            where case_id = any($1::uuid[])
            order by created_at`,
          [caseIds],
        );

  const grantRows = await client.query<GrantRow>(
    `select id, caregiver_email, family_email, created_at
       from caregiver_grants
      where family_user_id = auth.uid()
      order by created_at`,
  );
  const delegatedRows = await client.query<GrantRow>(
    `select id, caregiver_email, family_email, created_at
       from caregiver_grants
      where caregiver_user_id = auth.uid()
      order by created_at`,
  );

  const eventsByCase = new Map<string, CaseTimelineEvent[]>();
  for (const row of eventRows.rows) {
    const list = eventsByCase.get(row.case_id) ?? [];
    list.push({
      id: row.id,
      actor: isTimelineActor(row.actor) ? row.actor : "system",
      message: row.message ?? "",
      createdAt: row.created_at.toISOString(),
    });
    eventsByCase.set(row.case_id, list);
  }

  const draftsByCase = new Map<string, DraftView[]>();
  for (const row of actionRows.rows) {
    const list = draftsByCase.get(row.case_id) ?? [];
    list.push({
      id: row.id,
      title: row.subject ?? `Letter via ${row.channel}`,
      recipient: row.recipient,
      body: row.body ?? "",
      citations: parseCitations(row.citations, docsById),
      status: row.status as DraftStatus,
      userApproved: row.user_approved_at !== null,
      staffApproved: row.staff_approved_at !== null,
      updatedAt: row.created_at.toISOString(),
    });
    draftsByCase.set(row.case_id, list);
  }

  const cases: FamilyCaseView[] = caseRows.rows.map((row) => ({
    id: row.id,
    title: caseTitle(row),
    status: isCaseStatus(row.status) ? row.status : "intake",
    providerName: row.provider_name,
    insurerName: row.insurer_name,
    amountDisputed: toNumberOrNull(row.amount_disputed),
    amountSaved: toNumberOrNull(row.amount_saved),
    nextDeadline: toIsoOrNull(row.next_deadline),
    events: eventsByCase.get(row.id) ?? [],
    drafts: draftsByCase.get(row.id) ?? [],
  }));

  return {
    email: profile.email as string,
    fullName: (profile.full_name as string | null) ?? null,
    notificationLevel: profile.notification_level as NotificationLevel,
    pausedAt: toIsoOrNull(profile.automated_messages_paused_at as Date | null),
    cases,
    caregiverGrants: grantRows.rows.map((row) => ({
      id: row.id,
      caregiverEmail: row.caregiver_email,
      createdAt: row.created_at.toISOString(),
    })),
    caregiverFor: delegatedRows.rows.map((row) => ({
      id: row.id,
      familyEmail: row.family_email,
    })),
  };
}

/* ------------------------------------------------------------------ */
/* Staff console                                                       */
/* ------------------------------------------------------------------ */

interface StaffCaseRow extends QueryResultRow {
  id: string;
  insurer_name: string | null;
  provider_name: string | null;
  next_deadline: Date | null;
  status: string;
}

function staffCaseLabel(row: Pick<StaffCaseRow, "insurer_name" | "provider_name" | "id">): string {
  return caseTitle(row);
}

/** True when the case's deadline is inside the 48-hour pin window (or overdue). */
function deadlineUrgent(nextDeadline: Date, todayIso: string): boolean {
  return deadlineTier(daysUntil(nextDeadline.toISOString(), todayIso)) === "urgent";
}

/**
 * The staff console's queue: drafts to review, low-confidence extractions,
 * failed sends, stuck cases, deadline alerts, and orphan mail — each entry
 * flagged urgent where the spec pins it to the top.
 */
export async function staffConsoleData(client: Queryable): Promise<StaffQueueEntry[]> {
  const todayIso = new Date().toISOString();

  // Drafts awaiting staff sign-off. A family-approved draft is the urgent
  // case: a person is already waiting on us.
  const draftRows = await client.query<ActionRow & StaffCaseRow>(
    `select a.id, a.case_id, a.channel, a.recipient, a.subject, a.body, a.citations,
            a.status, a.user_approved_at, a.staff_approved_at, a.created_at,
            c.insurer_name, c.provider_name, c.next_deadline, c.status as case_status
       from actions a
       join cases c on c.id = a.case_id
      where a.status = 'draft'
      order by a.created_at`,
  );
  const draftEntries: StaffQueueEntry[] = draftRows.rows.map((row) => {
    const waitingOn =
      row.user_approved_at === null
        ? "waiting for the family's approval"
        : "family approved — waiting for your sign-off";
    return {
      id: `draft-${row.id}`,
      caseLabel: staffCaseLabel(row),
      summary: `Draft "${row.subject ?? `letter via ${row.channel}`}" — ${waitingOn}.`,
      kind: "draft_review",
      urgent:
        row.user_approved_at !== null ||
        (row.next_deadline !== null && deadlineUrgent(row.next_deadline, todayIso)),
      updatedAt: row.created_at.toISOString(),
    };
  });

  // Low-confidence extractions: the persisted human-review flag set at
  // extraction time (math-check failure, OCR confidence, invented values).
  const reviewRows = await client.query<QueryResultRow>(
    `select d.id, d.doc_type, d.review_reason, d.created_at,
            c.insurer_name, c.provider_name, c.id as case_id
       from documents d
       join cases c on c.id = d.case_id
      where d.needs_human_review
      order by d.created_at`,
  );
  const reviewEntries: StaffQueueEntry[] = reviewRows.rows.map((row) => ({
    id: `review-${row.id as string}`,
    caseLabel: staffCaseLabel(row as Pick<StaffCaseRow, "insurer_name" | "provider_name" | "id">),
    summary: `${(row.doc_type as string | null) ?? "document"} needs a human look before anyone relies on it.`,
    detail: (row.review_reason as string | null) ?? null,
    kind: "low_confidence",
    updatedAt: (row.created_at as Date).toISOString(),
  }));

  // Failed sends, with the error attached (lib/actions/staffQueue).
  const failedEntries: StaffQueueEntry[] = (await failedSendEntries(client)).map((entry) => ({
    id: `failed-${entry.id}`,
    caseLabel: entry.caseLabel,
    summary: entry.summary,
    detail: entry.detail,
    kind: "failed_send",
    updatedAt: entry.createdAt,
  }));

  // Stuck cases: open cases with no timeline activity for 7+ days.
  const stuckRows = await client.query<
    StaffCaseRow & { last_activity: Date | null; created_at: Date }
  >(
    `select c.id, c.insurer_name, c.provider_name, c.next_deadline, c.status,
            max(e.created_at) as last_activity, c.created_at
       from cases c
       left join events e on e.case_id = c.id
      where c.status not in ('resolved', 'closed')
      group by c.id
     having coalesce(max(e.created_at), c.created_at) < now() - interval '7 days'
      order by last_activity nulls first`,
  );
  const stuckEntries: StaffQueueEntry[] = stuckRows.rows.map((row) => ({
    id: `stuck-${row.id}`,
    caseLabel: staffCaseLabel(row),
    summary: `No activity since ${
      row.last_activity === null
        ? "the case was opened"
        : formatDate(row.last_activity.toISOString())
    }.`,
    kind: "stuck",
    updatedAt: (row.last_activity ?? row.created_at).toISOString(),
  }));

  // Deadline alerts: 14-day tier and closer on open cases.
  const deadlineRows = await client.query<StaffCaseRow>(
    `select id, insurer_name, provider_name, next_deadline, status
       from cases
      where next_deadline is not null
        and next_deadline <= (current_date + 14)
        and status not in ('resolved', 'closed')
      order by next_deadline`,
  );
  const deadlineEntries: StaffQueueEntry[] = deadlineRows.rows.map((row) => {
    const deadline = row.next_deadline as Date;
    const daysLeft = daysUntil(deadline.toISOString(), todayIso);
    return {
      id: `deadline-${row.id}`,
      caseLabel: staffCaseLabel(row),
      summary: `Appeal deadline in ${daysPhrase(daysLeft)}.`,
      kind: "deadline",
      urgent: deadlineUrgent(deadline, todayIso),
      updatedAt: todayIso,
    };
  });

  // Orphan mail: unidentified inbound, parked instead of dropped.
  const orphanRows = await client.query<QueryResultRow>(
    `select id, from_email, recipients, subject, reason, created_at
       from orphan_emails
      where status = 'pending'
      order by created_at`,
  );
  const orphanEntries: StaffQueueEntry[] = orphanRows.rows.map((row) => ({
    id: `orphan-${row.id as string}`,
    caseLabel: "(no case attached)",
    summary: `Mail to ${(row.recipients as string) ?? "(unknown recipient)"} matched no alias or case address.`,
    detail: [
      row.subject === null || row.subject === "" ? null : `Subject: ${row.subject as string}`,
      `Reason: ${row.reason as string}`,
      row.from_email === null ? null : `From: ${row.from_email as string}`,
    ]
      .filter((part) => part !== null)
      .join(" · "),
    kind: "orphan_mail",
    updatedAt: (row.created_at as Date).toISOString(),
  }));

  return [
    ...draftEntries,
    ...reviewEntries,
    ...failedEntries,
    ...stuckEntries,
    ...deadlineEntries,
    ...orphanEntries,
  ];
}

/* ------------------------------------------------------------------ */
/* Staff per-family settings                                           */
/* ------------------------------------------------------------------ */

export interface StaffFamilyRow {
  id: string;
  email: string;
  notificationLevel: NotificationLevel;
  pausedAt: string | null;
}

/**
 * Every family's notification level and pause switch, for the staff
 * console's per-family settings section. Runs under the staff session role
 * (full column grants); never called with a family session.
 */
export async function staffFamilyRows(client: Queryable): Promise<StaffFamilyRow[]> {
  const rows = await client.query<QueryResultRow>(
    `select id, email, notification_level, automated_messages_paused_at
       from users
      where is_staff = false
      order by email`,
  );
  return rows.rows.map((row) => ({
    id: row.id as string,
    email: row.email as string,
    notificationLevel: row.notification_level as NotificationLevel,
    pausedAt: toIsoOrNull(row.automated_messages_paused_at as Date | null),
  }));
}
