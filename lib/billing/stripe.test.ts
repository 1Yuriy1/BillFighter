/**
 * The Stripe gateway contract, tested against an injected fetch — the same
 * offline pattern as the Postmark adapter tests. The adapter speaks Stripe's
 * REST API in TEST MODE ONLY: construction refuses missing and live keys, the
 * charge resolves the customer's saved card, and Stripe errors surface as
 * typed GatewayErrors instead of raw fetch noise.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayError } from "./gateway";
import { makeStripeGateway } from "./stripe";

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

const TEST_KEY = "sk_test_billfighter_integration_key";

function jsonResponse(status: number, payload: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  } as Response;
}

/** A fetch stub recording every call; per-path canned responses. */
function stubFetch(responses: Record<string, unknown>): {
  calls: RecordedCall[];
  fetchImpl: typeof fetch;
} {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const path = url.replace("https://api.stripe.com/v1", "");
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    for (const [pattern, payload] of Object.entries(responses)) {
      if (path.startsWith(pattern)) {
        return jsonResponse(200, payload);
      }
    }
    return jsonResponse(404, {
      error: { message: `no stub for ${path}`, type: "invalid_request_error" },
    });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.STRIPE_SECRET_KEY;
});

describe("makeStripeGateway — test-mode lock", () => {
  it("constructs with an explicit test-mode key", () => {
    const { fetchImpl } = stubFetch({});
    expect(() => makeStripeGateway({ secretKey: TEST_KEY, fetchImpl })).not.toThrow();
  });

  it("refuses to construct without a key", () => {
    const { fetchImpl } = stubFetch({});
    expect(() => makeStripeGateway({ fetchImpl })).toThrow(GatewayError);
  });

  it("refuses a LIVE key — the fee flow cannot charge a family in live mode", () => {
    const { fetchImpl } = stubFetch({});
    for (const liveKey of ["sk_live_abc123", "rk_live_abc123", "sk_prod_whatever"]) {
      expect(() => makeStripeGateway({ secretKey: liveKey, fetchImpl })).toThrow(GatewayError);
      try {
        makeStripeGateway({ secretKey: liveKey, fetchImpl });
      } catch (error) {
        expect((error as GatewayError).code).toBe("test_mode_required");
      }
    }
  });
});

describe("createCustomer — the card saved at signup", () => {
  it("POSTs the email and name to /customers with the bearer key", async () => {
    const { calls, fetchImpl } = stubFetch({ "/customers": { id: "cus_new123" } });
    const gateway = makeStripeGateway({ secretKey: TEST_KEY, fetchImpl });

    const result = await gateway.createCustomer({
      email: "family@example.com",
      name: "Maria Martinez",
    });

    expect(result).toEqual({ customerId: "cus_new123" });
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].headers.authorization).toBe(`Bearer ${TEST_KEY}`); // Headers normalizes to lowercase
    expect(calls[0].body).toContain("email=family%40example.com");
    expect(calls[0].body).toContain("name=Maria+Martinez");
  });
});

describe("createCharge — off-session against the saved card", () => {
  const savedCardCustomer = {
    id: "cus_saved",
    invoice_settings: { default_payment_method: "pm_card_visa" },
  };

  it("charges the customer's default payment method off-session, with the receipt math", async () => {
    const { calls, fetchImpl } = stubFetch({
      "/customers/cus_saved": savedCardCustomer,
      "/payment_intents": { id: "pi_123", status: "succeeded", latest_charge: "ch_123" },
      "/charges/ch_123": { id: "ch_123", receipt_url: "https://pay.stripe.com/receipts/ch_123" },
    });
    const gateway = makeStripeGateway({ secretKey: TEST_KEY, fetchImpl });

    const result = await gateway.createCharge({
      customerId: "cus_saved",
      amountCents: 4800,
      currency: "usd",
      description: "BillFighter success fee",
      receiptEmail: "family@example.com",
      metadata: { case_id: "case-1", fee_cents: "4800" },
      receiptLineItems: [
        { kind: "disputed", label: "Disputed amount", amount: "$1,420.50" },
        { kind: "savings", label: "Confirmed savings", amount: "$320.00" },
        { kind: "fee", label: "Success fee", amount: "$48.00" },
      ],
    });

    expect(result).toEqual({
      chargeId: "pi_123",
      receiptUrl: "https://pay.stripe.com/receipts/ch_123",
    });
    const intentCall = calls.find((call) => call.url.endsWith("/payment_intents"));
    expect(intentCall).toBeDefined();
    expect(intentCall?.body).toContain("amount=4800");
    expect(intentCall?.body).toContain("customer=cus_saved");
    expect(intentCall?.body).toContain("payment_method=pm_card_visa");
    expect(intentCall?.body).toContain("off_session=true");
    expect(intentCall?.body).toContain("confirm=true");
    expect(intentCall?.body).toContain("receipt_email=family%40example.com");
    expect(intentCall?.body).toContain("metadata%5Bcase_id%5D=case-1");
    // The receipt line items ride on the Stripe object for audit.
    expect(decodeURIComponent(intentCall?.body ?? "")).toContain("receipt_line_items");
  });

  it("refuses a customer with no saved card — charging is a precondition, not a hope", async () => {
    const { calls, fetchImpl } = stubFetch({
      "/customers/cus_bare": { id: "cus_bare", invoice_settings: { default_payment_method: null } },
    });
    const gateway = makeStripeGateway({ secretKey: TEST_KEY, fetchImpl });

    await expect(
      gateway.createCharge({
        customerId: "cus_bare",
        amountCents: 4800,
        currency: "usd",
        description: "x",
        receiptEmail: "family@example.com",
        metadata: {},
        receiptLineItems: [],
      }),
    ).rejects.toMatchObject({ code: "no_saved_card" } satisfies Pick<GatewayError, "code">);

    // Only the customer lookup happened — no payment intent was attempted.
    expect(calls.map((call) => call.url)).toEqual(["https://api.stripe.com/v1/customers/cus_bare"]);
  });

  it("maps Stripe API errors to typed GatewayErrors", async () => {
    const fetchImpl = (async () =>
      jsonResponse(402, {
        error: { message: "Your card was declined.", type: "card_error" },
      })) as typeof fetch;
    const gateway = makeStripeGateway({ secretKey: TEST_KEY, fetchImpl });

    await expect(
      gateway.createCharge({
        customerId: "cus_saved",
        amountCents: 4800,
        currency: "usd",
        description: "x",
        receiptEmail: "family@example.com",
        metadata: {},
        receiptLineItems: [],
      }),
    ).rejects.toMatchObject({ code: "stripe_api_error" } satisfies Pick<GatewayError, "code">);
  });
});
