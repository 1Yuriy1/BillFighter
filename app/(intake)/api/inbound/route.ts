/**
 * POST /api/inbound — the Postmark inbound webhook.
 *
 * Order is deliberate and security-bearing: verify the webhook signature
 * against the RAW request body first (401 on anything unverified), then parse
 * and validate the payload, then route. Postmark retries on any non-200, so
 * transient DB failures surface as 500s and a bad payload as a 400; a
 * signature failure is always 401 and never touches the database.
 */
import { Pool } from "pg";
import { SIGNATURE_HEADER, verifyWebhookSignature } from "@/lib/intake/signature";
import { isPostmarkInboundPayload } from "@/lib/intake/postmark";
import { processInboundEmail } from "@/lib/intake/processInbound";
import { makeLocalStore } from "@/lib/intake/storage";

const pool = new Pool({
  // Same local default as the test harness (db/test/db.ts); production sets
  // DATABASE_URL to the Supabase connection string.
  connectionString:
    process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/billfighter_test",
});

export async function POST(request: Request): Promise<Response> {
  const rawBody = await request.text();
  const secret = process.env.POSTMARK_WEBHOOK_SECRET;
  if (!secret || !verifyWebhookSignature(rawBody, request.headers.get(SIGNATURE_HEADER), secret)) {
    // Fail closed: no secret configured or no valid signature — no processing.
    return Response.json({ error: "signature verification failed" }, { status: 401 });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return Response.json({ error: "malformed JSON body" }, { status: 400 });
  }
  if (!isPostmarkInboundPayload(parsed)) {
    return Response.json({ error: "unexpected payload shape" }, { status: 400 });
  }

  const client = await pool.connect();
  try {
    const outcome = await processInboundEmail(client, makeLocalStore(), parsed);
    return Response.json(outcome, { status: 200 });
  } finally {
    client.release();
  }
}
