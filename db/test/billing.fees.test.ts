/**
 * Billing integration tests for the staff-confirmed success fee, per the MVP
 * spec's verification matrix:
 *
 *   - no charge ever fires without an attached proof document (missing doc,
 *     another case's doc, and a non-proof doc_type all refuse before the
 *     gateway is touched);
 *   - the charge amount equals the capped formula exactly, boundary-testing
 *     the $500 cap;
 *   - the receipt line items — disputed amount, confirmed savings, fee — are
 *     present on the payment record.
 *
 * The gateway is a recording fake: the DB flow, the gates, the ledger, and
 * the idempotency are what these tests own. The Stripe adapter's own
 * contract (test-mode key lock, form encoding, error mapping) is covered in
 * lib/billing/stripe.test.ts, and a live sk_test_ round-trip can be run
 * manually with STRIPE_SECRET_KEY set — CI stays network-free.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, Pool } from "pg";
import { confirmSavingsAndCharge, ensureStripeCustomer, FeeError } from "../../lib/billing/charge";
import type { ChargeRequest, PaymentGateway } from "../../lib/billing/gateway";
import { connectAs, DATABASE_URL } from "./db";

/* ------------------------------------------------------------------ */
/* A recording gateway — charges in memory, never on a network          */
/* ------------------------------------------------------------------ */

function recordingGateway(options: { failChargeWith?: Error } = {}) {
  const charges: ChargeRequest[] = [];
  const customers: Array<{ email: string; name?: string }> = [];
  let customerSeq = 0;
  const gateway: PaymentGateway = {
    async createCustomer(input) {
      customers.push(input);
      customerSeq += 1;
      return { customerId: `cus_test_${customerSeq}` };
    },
    async createCharge(request) {
      charges.push(request);
      if (options.failChargeWith) {
        throw options.failChargeWith;
      }
      return {
        chargeId: `pi_test_${charges.length}`,
        receiptUrl: `https://pay.stripe.com/test/receipts/${charges.length}`,
      };
    },
  };
  return { gateway, charges, customers };
}

/* ------------------------------------------------------------------ */
/* Harness                                                              */
/* ------------------------------------------------------------------ */

const NOW = new Date("2026-09-17T12:00:00Z");
const pool = new Pool({ connectionString: DATABASE_URL });
let service: Client;

beforeAll(async () => {
  service = new Client({ connectionString: DATABASE_URL });
  await service.connect();
});

afterAll(async () => {
  await service.end();
  await pool.end();
});

async function seedFamily(options: { withCustomer?: boolean } = {}): Promise<string> {
  const user = await pool.query<{ id: string }>(
    `insert into users (email, authorization_signed_at, stripe_customer_id)
     values ($1, $2, $3) returning id`,
    [
      `${randomUUID()}@example.com`,
      new Date("2026-09-01T00:00:00Z"),
      options.withCustomer === false ? null : `cus_test_${randomUUID()}`,
    ],
  );
  return user.rows[0].id;
}

async function seedCase(
  userId: string,
  options: { status?: string; amountDisputed?: string } = {},
): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `insert into cases (user_id, status, provider_name, insurer_name, amount_disputed)
     values ($1, $2, 'Riverwalk Imaging', 'Aetna', $3) returning id`,
    [userId, options.status ?? "resolved", options.amountDisputed ?? "1420.50"],
  );
  return result.rows[0].id;
}

/** The proof: a corrected bill or EOB filed on the case. */
async function seedDocument(caseId: string, options: { docType?: string } = {}): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `insert into documents (case_id, doc_type, file_path, extracted)
     values ($1, $2, '/tmp/proof.pdf', '{"total_charged": 940.50}') returning id`,
    [caseId, options.docType ?? "bill"],
  );
  return result.rows[0].id;
}

async function paymentRows(
  caseId: string,
): Promise<Array<{ status: string; error_message: string | null }>> {
  const result = await pool.query<{ status: string; error_message: string | null }>(
    `select status, error_message from payments where case_id = $1 order by created_at`,
    [caseId],
  );
  return result.rows;
}

function expectFeeError(error: unknown, code: FeeError["code"]): boolean {
  expect(error).toBeInstanceOf(FeeError);
  expect((error as FeeError).code).toBe(code);
  return true;
}

/* ------------------------------------------------------------------ */
/* The proof gate — no charge ever fires without an attached proof      */
/* ------------------------------------------------------------------ */

describe("confirmSavingsAndCharge — the proof gate", () => {
  it("refuses to charge when the proof document does not exist", async () => {
    const userId = await seedFamily();
    const caseId = await seedCase(userId);
    const { gateway, charges } = recordingGateway();

    await expect(
      confirmSavingsAndCharge(service, {
        caseId,
        proofDocumentId: randomUUID(), // no such document
        proofKind: "new_bill",
        confirmedSavings: "320.00",
        confirmedBy: "staff-1",
        now: NOW,
        gateway,
      }),
    ).rejects.toSatisfy((error: unknown) => expectFeeError(error, "proof_required"));

    expect(charges).toHaveLength(0);
    expect(await paymentRows(caseId)).toHaveLength(0);
  });

  it("refuses to charge on another case's proof document", async () => {
    const otherUserId = await seedFamily();
    const otherCaseId = await seedCase(otherUserId);
    const otherDocId = await seedDocument(otherCaseId);

    const userId = await seedFamily();
    const caseId = await seedCase(userId);
    const { gateway, charges } = recordingGateway();

    await expect(
      confirmSavingsAndCharge(service, {
        caseId,
        proofDocumentId: otherDocId, // real document, wrong case
        proofKind: "new_bill",
        confirmedSavings: "320.00",
        confirmedBy: "staff-1",
        now: NOW,
        gateway,
      }),
    ).rejects.toSatisfy((error: unknown) => expectFeeError(error, "proof_required"));

    expect(charges).toHaveLength(0);
    expect(await paymentRows(caseId)).toHaveLength(0);
  });

  it("refuses to charge on a non-proof document type (the proof is a bill or EOB)", async () => {
    const userId = await seedFamily();
    const caseId = await seedCase(userId);
    const replyDocId = await seedDocument(caseId, { docType: "reply" });
    const { gateway, charges } = recordingGateway();

    await expect(
      confirmSavingsAndCharge(service, {
        caseId,
        proofDocumentId: replyDocId,
        proofKind: "new_bill",
        confirmedSavings: "320.00",
        confirmedBy: "staff-1",
        now: NOW,
        gateway,
      }),
    ).rejects.toSatisfy((error: unknown) => expectFeeError(error, "proof_required"));

    expect(charges).toHaveLength(0);
    expect(await paymentRows(caseId)).toHaveLength(0);
  });

  it("refuses to charge a case that is not resolved", async () => {
    const userId = await seedFamily();
    const caseId = await seedCase(userId, { status: "waiting_reply" });
    const proofDocId = await seedDocument(caseId);
    const { gateway, charges } = recordingGateway();

    await expect(
      confirmSavingsAndCharge(service, {
        caseId,
        proofDocumentId: proofDocId,
        proofKind: "new_bill",
        confirmedSavings: "320.00",
        confirmedBy: "staff-1",
        now: NOW,
        gateway,
      }),
    ).rejects.toSatisfy((error: unknown) => expectFeeError(error, "case_not_resolved"));

    expect(charges).toHaveLength(0);
  });

  it("refuses to charge when the family has no Stripe customer — the card is saved at signup", async () => {
    const userId = await seedFamily({ withCustomer: false });
    const caseId = await seedCase(userId);
    const proofDocId = await seedDocument(caseId);
    const { gateway, charges } = recordingGateway();

    await expect(
      confirmSavingsAndCharge(service, {
        caseId,
        proofDocumentId: proofDocId,
        proofKind: "new_bill",
        confirmedSavings: "320.00",
        confirmedBy: "staff-1",
        now: NOW,
        gateway,
      }),
    ).rejects.toSatisfy((error: unknown) => expectFeeError(error, "no_stripe_customer"));

    expect(charges).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* The charge — capped formula, receipt, idempotency                    */
/* ------------------------------------------------------------------ */

describe("confirmSavingsAndCharge — the capped charge and its receipt", () => {
  it("charges exactly 15% of confirmed savings and records the receipt line items", async () => {
    const userId = await seedFamily();
    const caseId = await seedCase(userId, { amountDisputed: "1420.50" });
    const proofDocId = await seedDocument(caseId);
    const { gateway, charges } = recordingGateway();
    const receipts: Array<{ to: string; subject: string; body: string; paymentId: string }> = [];

    const result = await confirmSavingsAndCharge(service, {
      caseId,
      proofDocumentId: proofDocId,
      proofKind: "new_bill",
      confirmedSavings: "320.00",
      confirmedBy: "staff-1",
      now: NOW,
      gateway,
      deliverReceipt: async (message) => {
        receipts.push(message);
      },
    });

    // 15% of $320.00 = $48.00, exactly.
    expect(result.outcome).toBe("charged");
    expect(result).toMatchObject({ feeCents: 4800 });

    // The gateway saw exactly the capped formula's amount.
    expect(charges).toHaveLength(1);
    expect(charges[0].amountCents).toBe(4800);
    expect(charges[0].customerId).toMatch(/^cus_test_/);
    expect(charges[0].metadata.case_id).toBe(caseId);
    expect(charges[0].metadata.proof_document_id).toBe(proofDocId);

    // The payment row: proof attached, amounts snapshotted, succeeded.
    const payment = await pool.query<{
      id: string;
      status: string;
      fee_cents: number;
      disputed_amount: string;
      confirmed_savings: string;
      fee_amount: string;
      proof_document_id: string;
      stripe_charge_id: string;
      receipt_url: string;
    }>(
      `select id, status, fee_cents, disputed_amount, confirmed_savings, fee_amount,
              proof_document_id, stripe_charge_id, receipt_url
         from payments where case_id = $1`,
      [caseId],
    );
    expect(payment.rows).toHaveLength(1);
    expect(payment.rows[0].status).toBe("succeeded");
    expect(payment.rows[0].fee_cents).toBe(4800);
    expect(Number(payment.rows[0].disputed_amount)).toBe(1420.5);
    expect(Number(payment.rows[0].confirmed_savings)).toBe(320);
    expect(Number(payment.rows[0].fee_amount)).toBe(48);
    expect(payment.rows[0].proof_document_id).toBe(proofDocId);
    expect(payment.rows[0].stripe_charge_id).toBe("pi_test_1");
    expect(payment.rows[0].receipt_url).toContain("pay.stripe.com");

    // The receipt line items: disputed, savings, fee — the math, on record.
    const items = await pool.query<{ kind: string; label: string; amount: string }>(
      `select kind, label, amount from receipt_line_items
        where payment_id = $1`,
      [payment.rows[0].id],
    );
    expect(items.rows.map((row) => row.kind)).toEqual(["disputed", "savings", "fee"]);
    expect(Number(items.rows[0].amount)).toBe(1420.5);
    expect(Number(items.rows[1].amount)).toBe(320);
    expect(Number(items.rows[2].amount)).toBe(48);
    expect(items.rows[2].label).toContain("15% of $320.00");

    // The savings became the case's confirmed amount_saved.
    const caseRow = await pool.query<{ amount_saved: string }>(
      `select amount_saved from cases where id = $1`,
      [caseId],
    );
    expect(Number(caseRow.rows[0].amount_saved)).toBe(320);

    // The family hears about it, with the math in the receipt email.
    expect(receipts).toHaveLength(1);
    expect(receipts[0].body).toContain("$48.00");
    expect(receipts[0].body).toContain("$320.00");

    // The audit trail: confirmation and charge events on the timeline.
    const timeline = await pool.query<{ message: string }>(
      `select message from events where case_id = $1 and message like '%fee%'`,
      [caseId],
    );
    expect(timeline.rows.length).toBeGreaterThanOrEqual(2);
  });

  it("caps the fee at exactly $500.00 through the full flow", async () => {
    const userId = await seedFamily();
    const caseId = await seedCase(userId, { amountDisputed: "10000.00" });
    const proofDocId = await seedDocument(caseId, { docType: "eob" });
    const { gateway, charges } = recordingGateway();

    const result = await confirmSavingsAndCharge(service, {
      caseId,
      proofDocumentId: proofDocId,
      proofKind: "eob",
      confirmedSavings: "10000.00", // 15% = $1,500 — the cap wins
      confirmedBy: "staff-1",
      now: NOW,
      gateway,
    });

    expect(result).toMatchObject({ outcome: "charged", feeCents: 50000 });
    expect(charges).toHaveLength(1);
    expect(charges[0].amountCents).toBe(50000); // exactly the cap, not a cent more

    // Just below the cap: 15% of $3,000.00 = $450.00 passes through uncapped.
    const userId2 = await seedFamily();
    const caseId2 = await seedCase(userId2);
    const proof2 = await seedDocument(caseId2);
    const run2 = recordingGateway();
    const result2 = await confirmSavingsAndCharge(service, {
      caseId: caseId2,
      proofDocumentId: proof2,
      proofKind: "new_bill",
      confirmedSavings: "3000.00",
      confirmedBy: "staff-1",
      now: NOW,
      gateway: run2.gateway,
    });
    expect(result2).toMatchObject({ outcome: "charged", feeCents: 45000 });
    expect(run2.charges[0].amountCents).toBe(45000);
  });

  it("charges nothing when confirmed savings are zero — and says so on the timeline", async () => {
    const userId = await seedFamily();
    const caseId = await seedCase(userId);
    const proofDocId = await seedDocument(caseId);
    const { gateway, charges } = recordingGateway();

    const result = await confirmSavingsAndCharge(service, {
      caseId,
      proofDocumentId: proofDocId,
      proofKind: "new_bill",
      confirmedSavings: "0",
      confirmedBy: "staff-1",
      now: NOW,
      gateway,
    });

    expect(result.outcome).toBe("skipped_no_fee");
    expect(charges).toHaveLength(0);
    expect(await paymentRows(caseId)).toHaveLength(0);
    const caseRow = await pool.query<{ amount_saved: string }>(
      `select amount_saved from cases where id = $1`,
      [caseId],
    );
    expect(Number(caseRow.rows[0].amount_saved)).toBe(0);
  });

  it("never charges twice — a live payment blocks any new charge", async () => {
    const userId = await seedFamily();
    const caseId = await seedCase(userId);
    const proofDocId = await seedDocument(caseId);
    const first = recordingGateway();

    await confirmSavingsAndCharge(service, {
      caseId,
      proofDocumentId: proofDocId,
      proofKind: "new_bill",
      confirmedSavings: "320.00",
      confirmedBy: "staff-1",
      now: NOW,
      gateway: first.gateway,
    });

    // A re-run (different proof, whatever) cannot re-charge the case.
    const second = recordingGateway();
    const secondProof = await seedDocument(caseId);
    const again = await confirmSavingsAndCharge(service, {
      caseId,
      proofDocumentId: secondProof,
      proofKind: "eob",
      confirmedSavings: "320.00",
      confirmedBy: "staff-2",
      now: NOW,
      gateway: second.gateway,
    });

    expect(again.outcome).toBe("skipped_already_charged");
    expect(second.charges).toHaveLength(0);
    const payments = await paymentRows(caseId);
    expect(payments).toHaveLength(1);
    expect(payments[0].status).toBe("succeeded");
  });

  it("a gateway failure marks the payment failed, surfaces the error, and allows a retry", async () => {
    const userId = await seedFamily();
    const caseId = await seedCase(userId);
    const proofDocId = await seedDocument(caseId);
    const failing = recordingGateway({
      failChargeWith: new Error("stripe: your card was declined."),
    });

    await expect(
      confirmSavingsAndCharge(service, {
        caseId,
        proofDocumentId: proofDocId,
        proofKind: "new_bill",
        confirmedSavings: "320.00",
        confirmedBy: "staff-1",
        now: NOW,
        gateway: failing.gateway,
      }),
    ).rejects.toThrow(/declined/);

    const failedRows = await paymentRows(caseId);
    expect(failedRows).toHaveLength(1);
    expect(failedRows[0].status).toBe("failed");
    expect(failedRows[0].error_message).toContain("declined");

    // A failed charge releases the slot: a healthy retry charges exactly once.
    // A later timestamp keeps the two ledger rows in insertion order.
    const retry = recordingGateway();
    const result = await confirmSavingsAndCharge(service, {
      caseId,
      proofDocumentId: proofDocId,
      proofKind: "new_bill",
      confirmedSavings: "320.00",
      confirmedBy: "staff-1",
      now: new Date(NOW.getTime() + 60_000),
      gateway: retry.gateway,
    });
    expect(result).toMatchObject({ outcome: "charged", feeCents: 4800 });
    expect(retry.charges).toHaveLength(1);
    const payments = await paymentRows(caseId);
    expect(payments.map((row) => row.status)).toEqual(["failed", "succeeded"]);
  });
});

/* ------------------------------------------------------------------ */
/* Signup — the card saved at signup links the Stripe customer          */
/* ------------------------------------------------------------------ */

describe("ensureStripeCustomer — the signup hook", () => {
  it("creates the customer, links it on the user, and is idempotent", async () => {
    const userId = await seedFamily({ withCustomer: false });
    const { gateway, customers } = recordingGateway();

    const first = await ensureStripeCustomer(service, gateway, {
      userId,
      email: "family@example.com",
      name: "Maria Martinez",
    });
    expect(first.customerId).toBe("cus_test_1");
    expect(customers).toHaveLength(1);

    const linked = await pool.query<{ stripe_customer_id: string | null }>(
      `select stripe_customer_id from users where id = $1`,
      [userId],
    );
    expect(linked.rows[0].stripe_customer_id).toBe("cus_test_1");

    // A second call (signup retry, re-run) never creates a duplicate.
    const second = await ensureStripeCustomer(service, gateway, {
      userId,
      email: "family@example.com",
    });
    expect(second.customerId).toBe("cus_test_1");
    expect(customers).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/* Row-level security — families read their own receipts, nothing more  */
/* ------------------------------------------------------------------ */

describe("payments RLS", () => {
  it("a family reads its own payment and receipt rows and can neither read nor write others'", async () => {
    const userId = await seedFamily();
    const caseId = await seedCase(userId);
    const proofDocId = await seedDocument(caseId);
    const { gateway } = recordingGateway();
    const result = await confirmSavingsAndCharge(service, {
      caseId,
      proofDocumentId: proofDocId,
      proofKind: "new_bill",
      confirmedSavings: "320.00",
      confirmedBy: "staff-1",
      now: NOW,
      gateway,
    });
    if (result.outcome !== "charged") {
      throw new Error("expected a charge for the RLS test");
    }

    const strangerId = await seedFamily();

    const family = await connectAs({ role: "authenticated", sub: userId });
    try {
      const own = await family.query(`select id from payments where case_id = $1`, [caseId]);
      expect(own.rows).toHaveLength(1);
      const foreign = await family.query(`select id from payments where user_id = $1`, [
        strangerId,
      ]);
      expect(foreign.rows).toHaveLength(0);
      // No family writes: insert/update grants simply do not exist.
      await expect(
        family.query(
          `insert into payments (case_id, proof_document_id, disputed_amount, confirmed_savings, fee_amount, fee_cents)
           values ($1, $2, 1, 1, 1, 1)`,
          [caseId, proofDocId],
        ),
      ).rejects.toThrow(/permission denied/);
    } finally {
      await family.end();
    }

    const staff = await connectAs({ role: "staff" });
    try {
      const all = await staff.query<{ n: number }>(`select count(*)::int as n from payments`);
      expect(all.rows[0].n).toBeGreaterThanOrEqual(1);
    } finally {
      await staff.end();
    }
  });
});
