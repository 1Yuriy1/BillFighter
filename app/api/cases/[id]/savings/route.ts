/**
 * POST /api/cases/[id]/savings — staff savings confirmation and fee charge.
 *
 * Staff-only: the family session role holds no write path to any of this —
 * the confirmation, the payment ledger, and the Stripe charge are system
 * actions. The charge runs on the service connection (the payment flow is
 * RLS-bypass by design, per lib/billing/charge.ts) with the proof gate,
 * the capped 15% fee math, and the idempotent payment ledger all enforced
 * inside confirmSavingsAndCharge. If the family has no linked Stripe
 * customer yet, one is created first (test-mode bootstrap with the saved
 * test card — the production signup flow replaces this). Stripe failures
 * map to 502; the payment row is already parked for retry by the charge
 * module.
 */
import { NextResponse } from "next/server";
import type { QueryResultRow } from "pg";
import { confirmSavingsAndCharge, ensureStripeCustomer, FeeError } from "@/lib/billing/charge";
import { makeStripeGateway } from "@/lib/billing/stripe";
import { GatewayError } from "@/lib/billing/gateway";
import { makePostmarkEmailAdapter } from "@/lib/actions/adapters/postmark-email";
import { withServiceClient } from "@/lib/db/connect";
import { currentClaims } from "@/lib/session-server";

interface SavingsBody {
  proofDocumentId?: unknown;
  proofKind?: unknown;
  confirmedSavings?: unknown;
  note?: unknown;
}

interface CaseFamilyRow extends QueryResultRow {
  user_id: string;
  email: string;
  full_name: string | null;
}

const FEE_ERROR_STATUS: Record<FeeError["code"], number> = {
  case_not_found: 404,
  case_not_resolved: 409,
  proof_required: 409,
  no_stripe_customer: 409,
  invalid_savings: 400,
};

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const claims = await currentClaims();
  if (claims === null) {
    return NextResponse.json({ error: "signed_out" }, { status: 401 });
  }
  if (claims.role !== "staff") {
    return NextResponse.json({ error: "staff_only" }, { status: 403 });
  }

  const { id } = await params;
  const body = (await request.json().catch(() => null)) as SavingsBody | null;
  const proofDocumentId = typeof body?.proofDocumentId === "string" ? body.proofDocumentId : null;
  const proofKind = body?.proofKind === "eob" ? ("eob" as const) : ("new_bill" as const);
  const confirmedSavings = body?.confirmedSavings;
  if (
    proofDocumentId === null ||
    (typeof confirmedSavings !== "number" && typeof confirmedSavings !== "string")
  ) {
    return NextResponse.json({ error: "proof_document_and_savings_required" }, { status: 400 });
  }

  const gateway = makeStripeGateway();
  try {
    const outcome = await withServiceClient(async (service) => {
      const family = await service.query<CaseFamilyRow>(
        `select c.user_id, u.email, u.full_name
           from cases c
           join users u on u.id = c.user_id
          where c.id = $1`,
        [id],
      );
      if (family.rows.length === 0) {
        return NextResponse.json({ error: "case_not_found" }, { status: 404 });
      }
      // Link a Stripe customer before the charge reads the column — a family
      // that never went through production signup has no saved customer yet.
      await ensureStripeCustomer(service, gateway, {
        userId: family.rows[0].user_id,
        email: family.rows[0].email,
        name: family.rows[0].full_name ?? undefined,
      });
      return NextResponse.json(
        await confirmSavingsAndCharge(service, {
          caseId: id,
          proofDocumentId,
          proofKind,
          confirmedSavings,
          confirmedBy: claims.sub,
          note: typeof body?.note === "string" ? body.note : undefined,
          now: new Date(),
          gateway,
          // The family's receipt rides the same Postmark email channel as
          // every other outbound message; the paymentId keeps the send
          // idempotent under retries.
          deliverReceipt: async (message) => {
            await makePostmarkEmailAdapter().send({
              id: `receipt-${message.paymentId}`,
              channel: "email",
              recipient: message.to,
              subject: message.subject,
              body: message.body,
            });
          },
        }),
      );
    });
    return outcome;
  } catch (error) {
    if (error instanceof FeeError) {
      return NextResponse.json({ error: error.code }, { status: FEE_ERROR_STATUS[error.code] });
    }
    if (error instanceof GatewayError) {
      // The payment ledger row is parked for retry inside the charge module;
      // the staff console surfaces the failure without losing the trail.
      return NextResponse.json({ error: error.code }, { status: 502 });
    }
    throw error;
  }
}
