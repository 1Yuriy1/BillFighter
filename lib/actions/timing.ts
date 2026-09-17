/**
 * The send-side clock, as pure functions: how long to wait before retrying a
 * failed send, and when follow-up activity falls due after a successful one.
 * Spec: "Failed sends retry with backoff; three failures park the action in
 * the staff queue"; "sets follow_up_at (14 days -> follow-up letter, 30 days
 * -> escalate to staff)".
 */

/** Send attempts before the action parks in the staff queue (spec: three). */
export const MAX_SEND_ATTEMPTS = 3;

/** Base delay for the first retry; later retries multiply by BACKOFF_FACTOR. */
export const DEFAULT_RETRY_BASE_MS = 5 * 60 * 1000;

/** Exponential backoff multiplier: 5 min -> 25 min -> 125 min... */
export const BACKOFF_FACTOR = 5;

/** Days after a successful send when the follow-up letter falls due. */
export const FOLLOW_UP_AFTER_DAYS = 14;

/** Days after a successful send when staff escalation falls due. */
export const ESCALATE_AFTER_DAYS = 30;

/**
 * Delay before retry `attempt` (1-based) after a failure, exponential in the
 * attempt number. Attempt 1 gets the base delay.
 */
export function backoffDelayMs(attempt: number, baseMs: number = DEFAULT_RETRY_BASE_MS): number {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new RangeError(`backoffDelayMs: attempt must be a positive integer, got ${attempt}`);
  }
  return baseMs * BACKOFF_FACTOR ** (attempt - 1);
}

function addDays(from: Date, days: number): Date {
  return new Date(from.getTime() + days * 24 * 60 * 60 * 1000);
}

/** When the follow-up letter falls due: 14 days after the send. */
export function followUpAt(sentAt: Date): Date {
  return addDays(sentAt, FOLLOW_UP_AFTER_DAYS);
}

/** When staff escalation falls due: 30 days after the send. */
export function escalationAt(sentAt: Date): Date {
  return addDays(sentAt, ESCALATE_AFTER_DAYS);
}
