/**
 * The payment gateway seam. The charge flow (charge.ts) depends on this
 * interface, never on Stripe directly — the same way lib/actions depends on
 * ChannelAdapter and lib/followup receives `deliver`. Real Stripe (test
 * mode) plugs in via makeStripeGateway; tests record against an in-memory
 * fake, which is what makes the no-charge-without-proof invariant testable
 * without network.
 */

import type { ReceiptLineItem } from "./fee";

export interface ChargeRequest {
  /** Stripe customer id (users.stripe_customer_id) — card saved at signup. */
  customerId: string;
  /** The fee in integer cents — exactly what computeSuccessFee produced. */
  amountCents: number;
  currency: string;
  /** Human text on the Stripe receipt. */
  description: string;
  /** Receipt email goes to the family. */
  receiptEmail: string;
  /** Audit trail on the Stripe object: case, proof, the receipt math. */
  metadata: Record<string, string>;
  /** The receipt line items (disputed, savings, fee) mirrored onto Stripe. */
  receiptLineItems: ReceiptLineItem[];
}

export interface ChargeResult {
  /** Stripe payment intent id (pi_...), stored on payments.stripe_charge_id. */
  chargeId: string;
  /** Stripe-hosted receipt URL, when the charge exposes one. */
  receiptUrl: string | null;
}

export interface PaymentGateway {
  /**
   * Creates the Stripe customer at signup — the card-saving step links a
   * payment method to this customer. Idempotency lives in the caller
   * (ensureStripeCustomer), which skips this when one is already linked.
   */
  createCustomer(input: { email: string; name?: string }): Promise<{ customerId: string }>;

  /**
   * Charges the saved card off-session. Implementations must refuse a
   * customer without a saved payment method — "card saved at signup" is a
   * precondition, not a hope.
   */
  createCharge(request: ChargeRequest): Promise<ChargeResult>;
}

/** Gateway failures, typed so callers branch on code, never on message text. */
export class GatewayError extends Error {
  readonly code:
    | "test_mode_required"
    | "missing_credentials"
    | "no_saved_card"
    | "stripe_api_error"
    | "transport_failed";

  constructor(
    code:
      | "test_mode_required"
      | "missing_credentials"
      | "no_saved_card"
      | "stripe_api_error"
      | "transport_failed",
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "GatewayError";
    this.code = code;
  }
}
