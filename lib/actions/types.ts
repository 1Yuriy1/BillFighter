/**
 * Shared contracts for the approval + send layer (lib/actions/).
 *
 * The spec's invariant lives here as a type: an adapter can only be handed an
 * {@link OutboundAction}, and the dispatcher only constructs one from an
 * actions row whose status is 'approved'. Nothing else reaches a channel.
 */

/** The `actions.channel` enum from the schema. */
export type ActionChannel = "email" | "fax" | "mail" | "call" | "portal";

/** The `actions.status` enum from the schema. */
export type ActionStatus = "draft" | "approved" | "sent" | "failed" | "superseded";

/**
 * The shape an adapter is allowed to see: the dispatch payload of an APPROVED
 * action. Built only by the dispatcher from a row it has verified.
 */
export interface OutboundAction {
  id: string;
  channel: ActionChannel;
  recipient: string;
  subject: string;
  body: string;
}

/** A channel's acknowledgment of a send. */
export interface SendResult {
  /**
   * The provider's message/reference id, kept in the audit trail for
   * reconciliation. Null when the provider issues no id.
   */
  providerId: string | null;
}

/**
 * One outbound channel. Real channels talk to their provider (email via
 * Postmark); stub channels (fax, mail in Phase 1) record intent without
 * external transmission.
 */
export interface ChannelAdapter {
  readonly channel: ActionChannel;
  send(action: OutboundAction): Promise<SendResult>;
}

/** A send that failed for a reason the adapter can name. */
export class SendError extends Error {
  readonly detail?: unknown;

  constructor(message: string, detail?: unknown) {
    super(message);
    this.name = "SendError";
    this.detail = detail;
  }
}

export type ApprovalRole = "user" | "staff";
