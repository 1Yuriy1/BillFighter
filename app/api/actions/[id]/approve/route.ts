import { NextResponse } from "next/server";
import { ActionError, approveDraft } from "@/lib/actions/approval";
import { approveAsUser } from "@/lib/actions/userApproval";
import { withServiceClient, withSessionClient } from "@/lib/db/connect";
import { advanceCaseAfterApproval } from "@/lib/pipeline/caseStatus";
import { currentClaims } from "@/lib/session-server";

/**
 * Records one human approval on a draft action.
 *
 * Staff sign the staff slot (full column grants on their session role).
 * Families and caregivers sign the user slot through approveAsUser — the
 * session client's column grant permits exactly that one write, and gate
 * completion runs on the service connection only when staff already signed.
 *
 * "not_found" covers both a missing id and one outside the session's RLS
 * scope, so the UI cannot probe for other families' action ids.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const claims = await currentClaims();
  if (claims === null) {
    return NextResponse.json({ error: "signed_out" }, { status: 401 });
  }
  const { id } = await params;

  try {
    if (claims.role === "staff") {
      const outcome = await withSessionClient(claims, (client) =>
        approveDraft(client, id, "staff", new Date()),
      );
      if (outcome.status === "completed") {
        // The staff session holds no UPDATE grant on cases (owner-only
        // policy) — the gate→in_progress advance rides the service
        // connection instead of the approval transaction.
        await withServiceClient((service) => advanceCaseAfterApproval(service, id));
      }
      return NextResponse.json(outcome);
    }

    const outcome = await withServiceClient(async (service) => {
      const result = await withSessionClient(claims, (session) =>
        approveAsUser(session, service, id, new Date()),
      );
      if (result.status === "completed") {
        await advanceCaseAfterApproval(service, id);
      }
      return result;
    });
    if (outcome.status === "not_accessible") {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    return NextResponse.json(outcome);
  } catch (error) {
    if (error instanceof ActionError) {
      return NextResponse.json(
        { error: error.code },
        { status: error.code === "not_found" ? 404 : 409 },
      );
    }
    throw error;
  }
}
