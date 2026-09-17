/**
 * The staff-confirmed savings flow, per the MVP spec's Architecture section:
 * when a case resolves, staff confirm the savings by attaching a proof
 * document (the new bill or EOB showing the corrected amount), and the system
 * charges min(15% × confirmed savings, $500 cap).
 *
 * Two invariants are structural here:
 *
 *   - **No charge without a proof.** `confirmSavingsAndCharge` validates that
 *     the proof document exists, belongs to THIS case, and is a bill or EOB
 *     before the gateway is ever called; the payments row itself carries a
 *     NOT NULL proof_document_id. A charge without an attached proof is
 *     unrepresentable at both the code and the database level.
 *
 *   - **At most one live charge per case.** The flow checks for a pending or
 *     succeeded payment inside the same transaction that inserts the new
 *     pending row, and the partial unique index (payments_case_live_idx)
 *     enforces it under concurrency — a race loses the insert, not the
 *     family's money.
 *
 * Phasing, chosen so money and ledger never disagree: transaction 1 validates
 * and inserts the pending payment; the gateway call happens OUTSIDE any
 * transaction (network I/O must not hold row locks); transaction 2 records
 * success and writes the receipt line items. A gateway failure marks the
 * payment 'failed' and rethrows — visible, retried, never swallowed. If the
 * finalize transaction itself failed after the gateway accepted the charge,
 * the payment row stays 'pending' with no charge id: the idempotency gate
 * then blocks any re-charge, so the worst case is an un-reconciled success,
 * never a double charge.
 */

import type { Client as PgClient, PoolClient, QueryResultRow } from "pg";
import { buildReceiptLineItems, computeSuccessFee, FEE_CAP_CENTS, toCents } from "./fee";
import { GatewayError, type ChargeRequest, type PaymentGateway } from "./gateway";

type Queryable = PoolClient | PgClient;

export class FeeError extends Error {
  readonly code:
    | "case_not_found"
    | "case_not_resolved"
    | "proof_required"
    | "no_stripe_customer"
    | "invalid_savings";

  constructor(
    code:
      | "case_not_found"
      | "case_not_resolved"
      | "proof_required"
      | "no_stripe_customer"
      | "invalid_savings",
    message: string,
  ) {
    super(message);
    this.name = "FeeError";
    this.code = code;
  }
}

/** Family-facing receipt delivery, injected like `deliver` in lib/followup. */
export type DeliverReceipt = (message: {
  to: string;
  subject: string;
  body: string;
  paymentId: string;
}) => Promise<void>;

export interface ConfirmSavingsInput {
  caseId: string;
  /** The proof: a bill or EOB document already filed on this case. */
  proofDocumentId: string;
  proofKind: "new_bill" | "eob";
  /** The savings staff verified against the proof (dollars or numeric string). */
  confirmedSavings: number | string;
  /** Who confirmed (staff identifier for the audit trail). */
  confirmedBy: string;
  note?: string;
  /** Injected so tests drive the clock, as everywhere in lib/. */
  now: Date;
  gateway: PaymentGateway;
  deliverReceipt?: DeliverReceipt;
}

export type ConfirmSavingsOutcome =
  | {
      outcome: "charged";
      paymentId: string;
      feeCents: number;
      receiptUrl: string | null;
    }
  | { outcome: "skipped_no_fee"; reason: "no_confirmed_savings" }
  | { outcome: "skipped_already_charged"; paymentId: string; status: string };

interface CaseRow extends QueryResultRow {
  id: string;
  user_id: string;
  status: string;
  amount_disputed: string | null;
  email: string;
  stripe_customer_id: string | null;
}

interface CaseContext {
  caseRow: CaseRow;
  savingsCents: number;
  disputedCents: number;
}

/**
 * Loads and validates the case for a charge: resolved, with a Stripe
 * customer, on a case whose proof document is real. Runs inside the caller's
 * transaction so the row lock and the validations are one decision.
 */
async function loadCaseContext(
  client: Queryable,
  input: ConfirmSavingsInput,
): Promise<CaseContext> {
  const caseResult = await client.query<CaseRow>(
    `select c.id, c.user_id, c.status, c.amount_disputed, u.email,
            u.stripe_customer_id
       from cases c
       join users u on u.id = c.user_id
      where c.id = $1
        for update of c`,
    [input.caseId],
  );
  const caseRow = caseResult.rows[0];
  if (!caseRow) {
    throw new FeeError("case_not_found", `billing: case ${input.caseId} does not exist`);
  }
  if (caseRow.status !== "resolved") {
    // Savings are confirmed on resolution — the state machine (lib/caseState)
    // is the only door to 'resolved', via the reply classification pass.
    throw new FeeError(
      "case_not_resolved",
      `billing: case ${input.caseId} is '${caseRow.status}', not 'resolved' — ` +
        "savings can only be confirmed on a resolved case",
    );
  }
  if (!caseRow.stripe_customer_id) {
    throw new FeeError(
      "no_stripe_customer",
      `billing: user for case ${input.caseId} has no Stripe customer — ` +
        "the card is saved at signup; charge refused rather than improvised",
    );
  }

  // The proof gate: the document must exist, be THIS case's, and be a bill,
  // itemized statement, or EOB — "the new bill or EOB showing the corrected
  // amount". Itemized statements are bills for proof purposes: a corrected
  // itemized statement is exactly what a billing office sends after a
  // reprocessed claim.
  const proof = await client.query(
    `select 1 from documents
      where id = $1 and case_id = $2 and doc_type in ('bill', 'itemized', 'eob')`,
    [input.proofDocumentId, input.caseId],
  );
  if (proof.rows.length === 0) {
    throw new FeeError(
      "proof_required",
      `billing: savings confirmation for case ${input.caseId} refused — ` +
        `document ${input.proofDocumentId} is not a bill/EOB proof on this case; ` +
        "no charge fires without an attached proof document",
    );
  }

  const savingsCents = toCents(input.confirmedSavings);
  if (savingsCents < 0) {
    throw new FeeError(
      "invalid_savings",
      `billing: confirmed savings cannot be negative (${input.confirmedSavings})`,
    );
  }
  const disputedCents = caseRow.amount_disputed === null ? 0 : toCents(caseRow.amount_disputed);

  return { caseRow, savingsCents, disputedCents };
}

/**
 * Staff confirm the savings on a resolved case: the proof document is
 * attached, the savings are recorded, and the capped success fee is charged
 * against the card saved at signup. Idempotent — a case with a live payment
 * cannot be charged again, whatever re-runs or concurrency do.
 */
export async function confirmSavingsAndCharge(
  client: Queryable,
  input: ConfirmSavingsInput,
): Promise<ConfirmSavingsOutcome> {
  // ---- Phase 1: validate + record the confirmation + open the payment ----
  await client.query("begin");
  let paymentId: string;
  let context: CaseContext;
  try {
    context = await loadCaseContext(client, input);
    const fee = computeSuccessFee(context.savingsCents);

    if (fee.feeCents === 0) {
      // Nothing to charge: record the confirmation on the timeline and stop.
      await client.query("update cases set amount_saved = $1 where id = $2", [
        context.savingsCents / 100,
        input.caseId,
      ]);
      await client.query("insert into events (case_id, actor, message) values ($1, 'staff', $2)", [
        input.caseId,
        "staff confirmed savings — no confirmed savings, no fee charged",
      ]);
      await client.query("commit");
      return { outcome: "skipped_no_fee", reason: "no_confirmed_savings" };
    }

    // The idempotency gate: any pending or succeeded payment blocks a new
    // one. (Failed payments release the slot — a retry is legitimate.)
    const live = await client.query<{ id: string; status: string }>(
      `select id, status from payments
        where case_id = $1 and status <> 'failed'
        for update`,
      [input.caseId],
    );
    if (live.rows.length > 0) {
      await client.query("commit");
      return {
        outcome: "skipped_already_charged",
        paymentId: live.rows[0].id,
        status: live.rows[0].status,
      };
    }

    await client.query("update cases set amount_saved = $1 where id = $2", [
      context.savingsCents / 100,
      input.caseId,
    ]);
    await client.query(
      `insert into savings_proofs
         (case_id, document_id, doc_kind, confirmed_savings, confirmed_by, note, created_at)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [
        input.caseId,
        input.proofDocumentId,
        input.proofKind,
        context.savingsCents / 100,
        input.confirmedBy,
        input.note ?? null,
        input.now,
      ],
    );
    const inserted = await client.query<{ id: string }>(
      `insert into payments
         (case_id, user_id, proof_document_id, disputed_amount, confirmed_savings,
          fee_amount, fee_cents, currency, status, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, 'usd', 'pending', $8)
       returning id`,
      [
        input.caseId,
        context.caseRow.user_id,
        input.proofDocumentId,
        context.disputedCents / 100,
        context.savingsCents / 100,
        fee.feeCents / 100,
        fee.feeCents,
        input.now,
      ],
    );
    paymentId = inserted.rows[0].id;
    await client.query("insert into events (case_id, actor, message) values ($1, 'staff', $2)", [
      input.caseId,
      `staff confirmed savings of ${formatDollars(context.savingsCents)} with ` +
        `${input.proofKind === "new_bill" ? "new bill" : "EOB"} proof — ` +
        `success fee of ${formatDollars(fee.feeCents)}` +
        `${fee.capped ? ` (capped at ${formatDollars(FEE_CAP_CENTS)})` : ""} pending`,
    ]);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  }

  // ---- Phase 2: the gateway call — outside any transaction ----
  const fee = computeSuccessFee(context.savingsCents);
  const receiptItems = buildReceiptLineItems(context.disputedCents, context.savingsCents, fee);
  const request: ChargeRequest = {
    customerId: context.caseRow.stripe_customer_id as string,
    amountCents: fee.feeCents,
    currency: "usd",
    description:
      `BillFighter success fee — disputed ${formatDollars(context.disputedCents)}, ` +
      `confirmed savings ${formatDollars(context.savingsCents)}, ` +
      `fee ${formatDollars(fee.feeCents)}${fee.capped ? " (cap applied)" : ""}`,
    receiptEmail: context.caseRow.email,
    metadata: {
      case_id: input.caseId,
      payment_id: paymentId,
      proof_document_id: input.proofDocumentId,
      disputed_amount_cents: String(context.disputedCents),
      confirmed_savings_cents: String(context.savingsCents),
      fee_cents: String(fee.feeCents),
    },
    receiptLineItems: receiptItems,
  };

  let chargeId: string;
  let receiptUrl: string | null;
  try {
    const result = await input.gateway.createCharge(request);
    chargeId = result.chargeId;
    receiptUrl = result.receiptUrl;
  } catch (error) {
    // The charge did not happen (or did not confirm): mark the attempt
    // failed and surface the error — the flow never swallows a gateway
    // failure, and a failed payment releases the idempotency slot.
    const message =
      error instanceof GatewayError || error instanceof Error
        ? error.message
        : "unknown gateway error";
    await client.query(`update payments set status = 'failed', error_message = $1 where id = $2`, [
      message,
      paymentId,
    ]);
    await client.query("insert into events (case_id, actor, message) values ($1, 'system', $2)", [
      input.caseId,
      `success fee charge failed: ${message}`,
    ]);
    throw error;
  }

  // ---- Phase 3: finalize — success ledger + receipt line items ----
  await client.query("begin");
  try {
    await client.query(
      `update payments
          set status = 'succeeded', stripe_charge_id = $1, receipt_url = $2
        where id = $3`,
      [chargeId, receiptUrl, paymentId],
    );
    for (const item of receiptItems) {
      await client.query(
        `insert into receipt_line_items (payment_id, kind, label, amount)
         values ($1, $2, $3, $4)`,
        [paymentId, item.kind, item.label, Number(item.amount.replace(/[$,]/g, ""))],
      );
    }
    await client.query("insert into events (case_id, actor, message) values ($1, 'system', $2)", [
      input.caseId,
      `success fee charged: ${formatDollars(fee.feeCents)} ` +
        `(disputed ${formatDollars(context.disputedCents)}, confirmed savings ` +
        `${formatDollars(context.savingsCents)}) — receipt recorded`,
    ]);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  }

  // ---- Phase 4: the family's receipt email — after commit, non-fatal ----
  // Unlike lib/followup's in-transaction delivery, the receipt email is sent
  // after the charge ledger commits: a mail failure must not roll the
  // payment record back to 'pending' while the family's card was charged.
  // A lost email is re-derivable from the payments row; a phantom payment
  // record is not. Failures surface as a timeline event, never silently.
  if (input.deliverReceipt) {
    try {
      await input.deliverReceipt({
        to: context.caseRow.email,
        subject: `Your BillFighter receipt — ${formatDollars(fee.feeCents)}`,
        body:
          `We saved you ${formatDollars(context.savingsCents)} on your disputed ` +
          `${formatDollars(context.disputedCents)} bill. Our success fee is 15% of ` +
          `confirmed savings${fee.capped ? `, capped at ${formatDollars(FEE_CAP_CENTS)}` : ""}: ` +
          `${formatDollars(fee.feeCents)}. The itemized receipt is on your case page.`,
        paymentId,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[billing] receipt email failed for payment ${paymentId}: ${message}`);
      await client.query("insert into events (case_id, actor, message) values ($1, 'system', $2)", [
        input.caseId,
        `receipt email could not be sent (non-fatal): ${message}`,
      ]);
    }
  }

  return { outcome: "charged", paymentId, feeCents: fee.feeCents, receiptUrl };
}

/**
 * The signup hook: links a Stripe customer (card saved at signup) to a user.
 * Idempotent — an existing stripe_customer_id is returned as-is, so signup
 * retries and re-runs never create duplicate customers.
 */
export async function ensureStripeCustomer(
  client: Queryable,
  gateway: PaymentGateway,
  input: { userId: string; email: string; name?: string },
): Promise<{ customerId: string }> {
  const existing = await client.query<{ stripe_customer_id: string | null }>(
    "select stripe_customer_id from users where id = $1",
    [input.userId],
  );
  const linked = existing.rows[0]?.stripe_customer_id;
  if (linked) {
    return { customerId: linked };
  }

  const created = await gateway.createCustomer({ email: input.email, name: input.name });
  await client.query("update users set stripe_customer_id = $1 where id = $2", [
    created.customerId,
    input.userId,
  ]);
  return { customerId: created.customerId };
}

function formatDollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
