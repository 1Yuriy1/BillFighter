/**
 * The inbound email router. A signature-verified Postmark payload becomes
 * case documents — or an orphan-queue row when nothing identifies the
 * recipient. Routing priority per the spec:
 *
 *   1. per-case reply address (case-8f2a@…)  -> doc_type 'reply' on that case
 *   2. per-user alias (users.inbound_alias)  -> doc_type 'other' on the
 *      user's open case, else a new case in 'intake'
 *   3. nothing matched                       -> orphan queue, never dropped
 *
 * Every path is idempotent: Postmark redelivers webhooks (at-least-once), so
 * a unique MessageID gate makes a replay a no-op instead of duplicate
 * documents. All writes for one email happen in one transaction.
 */
import type { Client as PgClient, PoolClient } from "pg";
import type { PostmarkInboundPayload } from "./postmark";
import { candidateRecipients, parseAddressList } from "./postmark";
import { caseReplyAddress, inboundDomain, parseCaseAddress } from "./addresses";
import type { IntakeStore } from "./storage";

type Queryable = PoolClient | PgClient;

export type OrphanReason = "unknown_alias" | "unknown_case_address" | "ambiguous_case_address";

export type InboundOutcome =
  | { status: "processed"; routing: "alias" | "case_reply"; caseId: string; documentCount: number }
  | { status: "duplicate" }
  | { status: "orphaned"; reason: OrphanReason; orphanId: string };

/** One email's whole DB story: gate row, documents, timeline event. */
export async function processInboundEmail(
  client: Queryable,
  store: IntakeStore,
  payload: PostmarkInboundPayload,
): Promise<InboundOutcome> {
  const recipients = candidateRecipients(payload);
  const fromEmail = payload.FromFull?.Email ?? parseAddressList(payload.From)[0] ?? null;

  await client.query("begin");
  try {
    const outcome = await routeEmail(client, store, payload, recipients, fromEmail);
    await client.query("commit");
    return outcome;
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}

async function routeEmail(
  client: Queryable,
  store: IntakeStore,
  payload: PostmarkInboundPayload,
  recipients: string[],
  fromEmail: string | null,
): Promise<InboundOutcome> {
  const domain = inboundDomain();

  // 1. A case reply address wins: it is the most specific claim on this mail.
  const caseAddress = recipients
    .map((address) => parseCaseAddress(address, domain))
    .find((parsed) => parsed !== null);

  if (caseAddress) {
    const matches = await client.query(
      "select id, user_id from cases where left(id::text, 8) = $1",
      [caseAddress.code],
    );
    if (matches.rows.length === 0) {
      return parkOrphan(client, payload, recipients, fromEmail, "unknown_case_address");
    }
    // A shared prefix must never pick a winner — the spec's named failure
    // mode is "a reply attaching to the wrong case".
    if (matches.rows.length > 1) {
      return parkOrphan(client, payload, recipients, fromEmail, "ambiguous_case_address");
    }
    return processCaseReply(client, store, payload, fromEmail, matches.rows[0]);
  }

  // 2. Per-user alias: documents enter on the user's open case, or a new one.
  const aliasMatch = await client.query(
    "select id from users where lower(inbound_alias) = any($1)",
    [recipients],
  );
  if (aliasMatch.rows.length === 0) {
    return parkOrphan(client, payload, recipients, fromEmail, "unknown_alias");
  }
  const user: { id: string } = aliasMatch.rows[0];

  // Dedup gate BEFORE any write the email would cause. No row returned means
  // this MessageID was already processed — a redelivery, not new mail.
  const gate = await client.query(
    "insert into intake_emails (message_id, routing, user_id) values ($1, 'alias', $2) on conflict (message_id) do nothing returning id",
    [payload.MessageID, user.id],
  );
  if (gate.rows.length === 0) return { status: "duplicate" };

  const openCase = await client.query(
    "select id from cases where user_id = $1 and status not in ('resolved', 'closed') order by created_at desc limit 1",
    [user.id],
  );
  const caseId: string =
    openCase.rows.length > 0
      ? openCase.rows[0].id
      : (await client.query("insert into cases (user_id) values ($1) returning id", [user.id]))
          .rows[0].id;

  await client.query("update intake_emails set case_id = $1 where message_id = $2", [
    caseId,
    payload.MessageID,
  ]);

  const documentCount = await storeAttachments(client, store, payload, caseId, "other");
  return { status: "processed", routing: "alias", caseId, documentCount };
}

async function processCaseReply(
  client: Queryable,
  store: IntakeStore,
  payload: PostmarkInboundPayload,
  fromEmail: string | null,
  target: { id: string; user_id: string | null },
): Promise<InboundOutcome> {
  const caseId = target.id;

  const gate = await client.query(
    "insert into intake_emails (message_id, routing, user_id, case_id) values ($1, 'case_reply', $2, $3) on conflict (message_id) do nothing returning id",
    [payload.MessageID, target.user_id, caseId],
  );
  if (gate.rows.length === 0) return { status: "duplicate" };

  let documentCount = await storeAttachments(client, store, payload, caseId, "reply");

  // "Every reply is a document that re-enters extraction": the reply text
  // itself becomes a reply document alongside any attachments.
  const replyText = payload.StrippedTextReply ?? payload.TextBody;
  if (replyText && replyText.trim().length > 0) {
    const bodyPath = await store.save(caseId, "reply-body.txt", Buffer.from(replyText, "utf8"));
    await client.query(
      "insert into documents (case_id, doc_type, file_path) values ($1, 'reply', $2)",
      [caseId, bodyPath],
    );
    documentCount += 1;
  }

  await client.query("insert into events (case_id, actor, message) values ($1, 'system', $2)", [
    caseId,
    `reply received from ${fromEmail ?? "unknown sender"} via ${caseReplyAddress(caseId)}`,
  ]);

  return { status: "processed", routing: "case_reply", caseId, documentCount };
}

/**
 * Persists each attachment under the case and files it as a document row.
 * Classification at intake is coarse and keyed by the route that matched:
 * attachments riding a case reply are 'reply' (extraction refines each into
 * eob/denial/etc. later); alias-channel attachments are 'other'.
 */
async function storeAttachments(
  client: Queryable,
  store: IntakeStore,
  payload: PostmarkInboundPayload,
  caseId: string,
  docType: "reply" | "other",
): Promise<number> {
  let count = 0;
  for (const attachment of payload.Attachments ?? []) {
    const content = Buffer.from(attachment.Content, "base64");
    const filePath = await store.save(caseId, attachment.Name, content);
    await client.query("insert into documents (case_id, doc_type, file_path) values ($1, $2, $3)", [
      caseId,
      docType,
      filePath,
    ]);
    count += 1;
  }
  return count;
}

async function parkOrphan(
  client: Queryable,
  payload: PostmarkInboundPayload,
  recipients: string[],
  fromEmail: string | null,
  reason: OrphanReason,
): Promise<InboundOutcome> {
  const inserted = await client.query(
    "insert into orphan_emails (message_id, from_email, recipients, subject, reason, raw_payload) values ($1, $2, $3, $4, $5, $6) on conflict (message_id) do nothing returning id",
    [
      payload.MessageID,
      fromEmail,
      recipients.join(", "),
      payload.Subject ?? null,
      reason,
      JSON.stringify(payload),
    ],
  );
  if (inserted.rows.length === 0) return { status: "duplicate" };
  return { status: "orphaned", reason, orphanId: inserted.rows[0].id };
}
