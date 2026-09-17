/**
 * Notification preferences and the user-facing gate for the follow-up engine
 * (lib/followup/).
 *
 * The spec's family email preferences live on the users row (migration 004):
 *
 *   notification_level — "everything" vs "action_needed" ("Only what needs
 *     you"). "action_needed" still sends the things that need the family's
 *     action plus resolutions; pure FYIs wait for the timeline.
 *   pause_all_messages — the crisis switch (stored as
 *     automated_messages_paused_at; non-null means on): staff can pause ALL
 *     automated messages for a family (e.g. after a death in the family);
 *     nothing user-facing goes out while it is on.
 *
 * Staff-facing escalation is deliberately unaffected by both: an escalation
 * is how staff learns the family needs help — silencing it would silence the
 * alarm, not the noise. Everything user-facing goes through
 * {@link shouldNotifyUser}; everything staff-facing does not.
 */

import type { CaseStatus } from "../caseState";
import type { ReplyOutcome } from "./classify";

/** The `users.notification_level` enum from migration 004. */
export const NOTIFICATION_LEVELS = ["everything", "action_needed"] as const;

export type NotificationLevel = (typeof NOTIFICATION_LEVELS)[number];

/**
 * How much a notification touches the family. "action_needed" — the family
 * should do something (a deadline is closing, we need their records);
 * "resolved" — the outcome families always hear about; "informational" —
 * progress notes that only "everything" families receive.
 */
export type NotificationRelevance = "action_needed" | "resolved" | "informational";

export interface FamilyPrefs {
  notificationLevel: NotificationLevel;
  pauseAllMessages: boolean;
}

export function isNotificationLevel(value: string): value is NotificationLevel {
  return (NOTIFICATION_LEVELS as readonly string[]).includes(value);
}

/**
 * Whether an automated message may go to the family. The pause switch wins
 * over everything; at the "action_needed" level, only action-needed items
 * and resolutions pass.
 */
export function shouldNotifyUser(prefs: FamilyPrefs, relevance: NotificationRelevance): boolean {
  if (prefs.pauseAllMessages) return false;
  if (prefs.notificationLevel === "everything") return true;
  return relevance !== "informational";
}

/** A message handed to the delivery transport (email today, channels later). */
export interface OutgoingMessage {
  /** Where the message goes (the family's email address). */
  to: string;
  subject: string;
  body: string;
  /**
   * The notification's dedup key — stable identity for the transport, so a
   * provider-side reconciliation can match sends to ledger rows.
   */
  dedupKey: string;
}

/**
 * Delivery hook injected by the host (the Inngest job wires Postmark's email
 * adapter). Omitted when no transport is configured: notifications are still
 * recorded and trailed, only the outbound send is skipped.
 */
export type DeliverMessage = (message: OutgoingMessage) => Promise<void>;

/**
 * Relevance of a reply outcome for the family's notification level:
 * resolutions (resolved, partial_win) and needs-action outcomes
 * (needs_info, denied_again) reach both levels; irrelevant replies reach
 * only "everything".
 */
export function replyRelevance(outcome: ReplyOutcome): NotificationRelevance {
  switch (outcome) {
    case "resolved":
    case "partial_win":
      return "resolved";
    case "needs_info":
    case "denied_again":
      return "action_needed";
    case "irrelevant":
      return "informational";
  }
}

/**
 * Whether a case is live for deadline purposes: resolved and closed cases
 * have no deadline to protect.
 */
export function isLiveCaseStatus(status: CaseStatus): boolean {
  return status !== "resolved" && status !== "closed";
}
