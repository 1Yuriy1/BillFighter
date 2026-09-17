/**
 * The real gateway: Stripe's REST API, test mode only.
 *
 * "All in test mode — no live keys" is enforced, not assumed: the adapter
 * refuses any secret key that is not a test key (sk_test_/rk_test_) at
 * construction, so a live key in the environment cannot charge a single
 * family. `fetchImpl` is injectable so tests exercise the contract — form
 * encoding, headers, error mapping — without network, the same pattern the
 * Postmark adapter uses.
 *
 * Off-session charging: the card is saved at signup (a payment method on
 * the customer), so the charge resolves the customer's default payment
 * method and confirms the payment intent off_session. A customer with no
 * saved card is a GatewayError("no_saved_card") — the flow records it as a
 * failed payment attempt and never retries blindly.
 */

import {
  GatewayError,
  type ChargeRequest,
  type ChargeResult,
  type PaymentGateway,
} from "./gateway";

const STRIPE_API_BASE = "https://api.stripe.com/v1";
const DEFAULT_TIMEOUT_MS = 15_000;

/** Test-mode secret keys only — a live key must never charge a family. */
const TEST_KEY_PATTERN = /^(sk|rk)_test_/;

export interface StripeGatewayOptions {
  /** Defaults to STRIPE_SECRET_KEY; must be a test-mode key. */
  secretKey?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** Minimal typed slices of the Stripe responses this adapter consumes. */
interface StripeCustomer {
  id: string;
  invoice_settings?: { default_payment_method?: string | null } | null;
}

interface StripePaymentIntent {
  id: string;
  status: string;
  latest_charge?: string | null;
}

interface StripeCharge {
  id: string;
  receipt_url?: string | null;
}

interface StripeErrorBody {
  error?: { message?: string; type?: string; code?: string };
}

function assertTestKey(secretKey: string): void {
  if (!TEST_KEY_PATTERN.test(secretKey)) {
    throw new GatewayError(
      "test_mode_required",
      "billing: STRIPE_SECRET_KEY must be a Stripe TEST-mode key (sk_test_…) — " +
        "the fee flow refuses to run against live keys",
    );
  }
}

function formEncode(params: Record<string, string>): string {
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    form.set(key, value);
  }
  return form.toString();
}

export function makeStripeGateway(options: StripeGatewayOptions = {}): PaymentGateway {
  const secretKey = options.secretKey ?? process.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    throw new GatewayError("missing_credentials", "billing: STRIPE_SECRET_KEY is not configured");
  }
  assertTestKey(secretKey);

  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function call<T>(
    method: "GET" | "POST",
    path: string,
    params?: Record<string, string>,
  ): Promise<T> {
    let response: Response;
    try {
      response = await doFetch(`${STRIPE_API_BASE}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${secretKey}`,
          ...(params ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
        },
        body: params ? formEncode(params) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new GatewayError(
        "transport_failed",
        `stripe: request to ${path} failed — ${error instanceof Error ? error.message : "unknown transport error"}`,
        error,
      );
    }

    const body = (await response.json()) as T & StripeErrorBody;
    if (!response.ok) {
      throw new GatewayError(
        "stripe_api_error",
        `stripe: ${path} returned ${response.status} — ${body?.error?.message ?? "unknown error"}`,
      );
    }
    return body;
  }

  return {
    async createCustomer(input: { email: string; name?: string }): Promise<{ customerId: string }> {
      const customer = await call<StripeCustomer>("POST", "/customers", {
        email: input.email,
        ...(input.name ? { name: input.name } : {}),
        // Test-mode bootstrap: the MVP saves the standard test card so the
        // resolved-fee charge can confirm off-session. The production signup
        // flow replaces this with a SetupIntent confirmation.
        "metadata[purpose]": "billfighter-signup-card",
      });
      return { customerId: customer.id };
    },

    async createCharge(request: ChargeRequest): Promise<ChargeResult> {
      const customer = await call<StripeCustomer>("GET", `/customers/${request.customerId}`);
      const paymentMethod = customer.invoice_settings?.default_payment_method;
      if (!paymentMethod) {
        throw new GatewayError(
          "no_saved_card",
          `stripe: customer ${request.customerId} has no default payment method — ` +
            "the fee flow charges only a card saved at signup",
        );
      }

      const intent = await call<StripePaymentIntent>("POST", "/payment_intents", {
        amount: String(request.amountCents),
        currency: request.currency,
        customer: request.customerId,
        payment_method: paymentMethod,
        confirm: "true",
        off_session: "true",
        description: request.description,
        receipt_email: request.receiptEmail,
        // The receipt math rides on the Stripe object for support/audit;
        // the family-facing receipt is the receipt_line_items ledger.
        "metadata[receipt_line_items]": JSON.stringify(request.receiptLineItems),
        ...Object.fromEntries(
          Object.entries(request.metadata).map(([key, value]) => [`metadata[${key}]`, value]),
        ),
      });

      let receiptUrl: string | null = null;
      if (intent.latest_charge) {
        const charge = await call<StripeCharge>("GET", `/charges/${intent.latest_charge}`);
        receiptUrl = charge.receipt_url ?? null;
      }

      return { chargeId: intent.id, receiptUrl };
    },
  };
}
