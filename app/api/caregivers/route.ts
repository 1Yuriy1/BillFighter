import { NextResponse } from "next/server";
import type { QueryResultRow } from "pg";
import { withServiceClient, withSessionClient } from "@/lib/db/connect";
import { currentClaims } from "@/lib/session-server";

interface GrantRow extends QueryResultRow {
  id: string;
  caregiver_email: string;
}

/**
 * Caregiver delegated access. A family manages its own grants (create by
 * caregiver email, revoke by grant id); the grants table's RLS makes a
 * caregiver's grants invisible to other families. Creation resolves the
 * email through the service connection — a family session cannot read the
 * users table to find the caregiver's id, and must not learn whether an
 * arbitrary email is registered beyond the response it receives.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const claims = await currentClaims();
  if (claims === null) {
    return NextResponse.json({ error: "signed_out" }, { status: 401 });
  }
  const body = (await request.json().catch(() => null)) as { caregiverEmail?: unknown } | null;
  const caregiverEmail =
    typeof body?.caregiverEmail === "string" ? body.caregiverEmail.trim().toLowerCase() : "";
  if (!caregiverEmail.includes("@")) {
    return NextResponse.json({ error: "valid_email_required" }, { status: 400 });
  }

  return withServiceClient(async (service) => {
    const caregiver = await service.query<{ id: string } & QueryResultRow>(
      `select id from users where lower(email) = $1`,
      [caregiverEmail],
    );
    if (caregiver.rows.length === 0) {
      return NextResponse.json({ error: "no_registered_user_with_that_email" }, { status: 404 });
    }
    const caregiverId = caregiver.rows[0].id;
    if (caregiverId === claims.sub) {
      return NextResponse.json({ error: "cannot_grant_to_self" }, { status: 400 });
    }

    // The insert goes through the FAMILY's session so RLS validates the
    // family_user_id; the email columns are captured for display (the two
    // sessions cannot read each other's users rows).
    const familyEmail = await withSessionClient(claims, async (client) => {
      const profile = await client.query<{ email: string } & QueryResultRow>(
        `select email from users where id = auth.uid()`,
      );
      if (profile.rows.length === 0) {
        throw new Error("session user has no profile row");
      }
      await client.query(
        `insert into caregiver_grants (family_user_id, caregiver_user_id, family_email, caregiver_email)
         values (auth.uid(), $1, $2, $3)`,
        [caregiverId, profile.rows[0].email, caregiverEmail],
      );
      return profile.rows[0].email as string;
    });

    return NextResponse.json({ caregiverEmail, familyEmail }, { status: 201 });
  });
}

/** Revokes one of the signed-in family's grants (by id). */
export async function DELETE(request: Request): Promise<NextResponse> {
  const claims = await currentClaims();
  if (claims === null) {
    return NextResponse.json({ error: "signed_out" }, { status: 401 });
  }
  const grantId = new URL(request.url).searchParams.get("id") ?? "";
  if (grantId === "") {
    return NextResponse.json({ error: "id_required" }, { status: 400 });
  }

  const deleted = await withSessionClient(claims, async (client) => {
    const result = await client.query<GrantRow>(
      `delete from caregiver_grants
        where id = $1
          and family_user_id = auth.uid()
       returning id, caregiver_email`,
      [grantId],
    );
    return result.rows[0];
  });

  if (deleted === undefined) {
    // Same response for "no such grant" and "not yours" — no existence leak.
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  return NextResponse.json({ revoked: deleted.caregiver_email });
}
