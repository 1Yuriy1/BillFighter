/**
 * The case state machine, per the BillFighter MVP spec.
 *
 * intake -> analyzing -> awaiting_approval -> in_progress -> waiting_reply
 *   -> resolved -> closed, with waiting_reply cycling back to analyzing when a
 * reply needs re-work ("denied again" / "needs info"). `closed` is manual.
 */
export const CASE_STATUSES = [
  "intake",
  "analyzing",
  "awaiting_approval",
  "in_progress",
  "waiting_reply",
  "resolved",
  "closed",
] as const;

export type CaseStatus = (typeof CASE_STATUSES)[number];

export function isCaseStatus(value: string): value is CaseStatus {
  return (CASE_STATUSES as readonly string[]).includes(value);
}

/**
 * Legal transitions. Keys are the current status; the check constraint on
 * cases.status and this map must stay in agreement.
 */
const TRANSITIONS: Readonly<Record<CaseStatus, readonly CaseStatus[]>> = {
  intake: ["analyzing"],
  analyzing: ["awaiting_approval"],
  awaiting_approval: ["in_progress"],
  in_progress: ["waiting_reply"],
  waiting_reply: ["analyzing", "resolved"],
  resolved: ["closed"],
  closed: [],
};

/** Whether the transition from -> to is part of the spec's state machine. */
export function canTransition(from: CaseStatus, to: CaseStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** States a case may legally move to next. */
export function nextStatuses(from: CaseStatus): readonly CaseStatus[] {
  return TRANSITIONS[from];
}

/**
 * Applies a transition, returning the new status. Throws on an illegal move —
 * callers should treat that as a bug, not a user-input path.
 */
export function transition(from: CaseStatus, to: CaseStatus): CaseStatus {
  if (!canTransition(from, to)) {
    throw new Error(`Illegal case transition: ${from} -> ${to}`);
  }
  return to;
}
