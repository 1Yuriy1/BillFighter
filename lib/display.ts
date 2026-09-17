import type { CaseStatus } from "./caseState";

/**
 * Presentational helpers shared by the UI component library.
 *
 * Everything here is a pure function of its inputs — no fetching, no globals —
 * so components stay props-driven and renderable in isolation (spec rule).
 */

/** Plain-language label + badge palette per case status, per the spec's gentle tone. */
export const STATUS_META: Record<CaseStatus, { label: string; badgeClass: string }> = {
  intake: { label: "Getting started", badgeClass: "bg-slate-100 text-slate-700" },
  analyzing: { label: "Reviewing your documents", badgeClass: "bg-blue-100 text-blue-800" },
  awaiting_approval: {
    label: "Waiting for your approval",
    badgeClass: "bg-amber-100 text-amber-800",
  },
  in_progress: { label: "Working on it", badgeClass: "bg-sky-100 text-sky-800" },
  waiting_reply: { label: "Waiting for a reply", badgeClass: "bg-violet-100 text-violet-800" },
  resolved: { label: "Resolved", badgeClass: "bg-green-100 text-green-800" },
  closed: { label: "Closed", badgeClass: "bg-gray-100 text-gray-600" },
};

export function caseStatusLabel(status: CaseStatus): string {
  return STATUS_META[status].label;
}

export function caseStatusBadgeClass(status: CaseStatus): string {
  return STATUS_META[status].badgeClass;
}

export type DeadlineTier = "none" | "notify" | "escalate" | "urgent";

/**
 * Spec deadline tiers: inside 14 days the family is notified, inside 5 days
 * staff escalate as well, and inside 2 days (48 hours) the case pins to the
 * top of the staff console. Overdue deadlines are always urgent.
 */
export function deadlineTier(daysLeft: number): DeadlineTier {
  if (daysLeft <= 2) return "urgent";
  if (daysLeft <= 5) return "escalate";
  if (daysLeft <= 14) return "notify";
  return "none";
}

/** Whole UTC calendar days from `todayIso` until `deadlineIso`; negative means past due. */
export function daysUntil(deadlineIso: string, todayIso: string): number {
  return Math.round((utcDayStart(deadlineIso) - utcDayStart(todayIso)) / MS_PER_DAY);
}

/** "3 days" / "1 day" for deadline copy. */
export function daysPhrase(daysLeft: number): string {
  const abs = Math.abs(daysLeft);
  return `${abs} day${abs === 1 ? "" : "s"}`;
}

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

/**
 * USD for display. Unknown amounts render as an em dash — per the extraction
 * contract, a missing number is displayed as absent, never guessed.
 */
export function formatUsd(amount: number | null): string {
  return amount === null ? "—" : usd.format(amount);
}

const dateOnly = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" });
const dateTime = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});

/** Medium UTC date (e.g. "Oct 1, 2026") for date-only values like next_deadline. */
export function formatDate(iso: string): string {
  return dateOnly.format(utcDayStart(iso));
}

/** Medium UTC date + short time (e.g. "Sep 17, 2026, 3:41 PM") for event timestamps. */
export function formatDateTime(iso: string): string {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid date: ${iso}`);
  }
  return dateTime.format(parsed);
}

/** Stable urgent-first ordering: urgent entries keep their relative order, then the rest. */
export function sortUrgentFirst<T extends { urgent?: boolean }>(entries: readonly T[]): T[] {
  return [
    ...entries.filter((entry) => entry.urgent === true),
    ...entries.filter((entry) => entry.urgent !== true),
  ];
}

const MS_PER_DAY = 86_400_000;

function utcDayStart(iso: string): number {
  const day = iso.slice(0, 10);
  const parsed = Date.parse(`${day}T00:00:00Z`);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid date: ${iso}`);
  }
  return parsed;
}
