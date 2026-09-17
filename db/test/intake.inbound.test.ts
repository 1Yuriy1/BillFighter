/**
 * Integration tests for the /api/inbound Postmark webhook, per the MVP
 * spec's verification matrix: alias match, case-reply match, bad signature
 * rejected, orphan path. Each test POSTs a signed webhook payload (test
 * signing key) through the real route handler against the real database
 * created by globalSetup.
 */
import { createHmac, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { POST } from "../../app/(intake)/api/inbound/route";
import { caseReplyAddress } from "../../lib/intake/addresses";
import type { PostmarkInboundPayload } from "../../lib/intake/postmark";
import { DATABASE_URL } from "./db";

const TEST_SECRET = "intake-test-signing-key";
const TEST_DOMAIN = "in.billfighter.com";

const pool = new Pool({ connectionString: DATABASE_URL });
let storageRoot = "";

beforeAll(async () => {
  process.env.POSTMARK_WEBHOOK_SECRET = TEST_SECRET;
  process.env.INBOUND_DOMAIN = TEST_DOMAIN;
  storageRoot = await mkdtemp(path.join(tmpdir(), "intake-test-"));
  process.env.INTAKE_STORAGE_DIR = storageRoot;
});

afterAll(async () => {
  await rm(storageRoot, { recursive: true, force: true });
  await pool.end();
});

async function seedUser(alias: string | null): Promise<string> {
  const res = await pool.query(
    "insert into users (email, inbound_alias) values ($1, $2) returning id",
    [`${randomUUID()}@example.com`, alias],
  );
  return res.rows[0].id;
}

async function seedCase(userId: string, status: string): Promise<string> {
  const res = await pool.query("insert into cases (user_id, status) values ($1, $2) returning id", [
    userId,
    status,
  ]);
  return res.rows[0].id;
}

function payloadFor(
  recipient: string,
  overrides: Partial<PostmarkInboundPayload> = {},
): PostmarkInboundPayload {
  return {
    From: "NovaPark Billing <billing@novaparkmedical.example>",
    FromFull: {
      Email: "billing@novaparkmedical.example",
      Name: "NovaPark Billing",
      MailboxHash: "",
    },
    To: `"Jane K" <${recipient}>`,
    ToFull: [{ Email: recipient, Name: "Jane K", MailboxHash: "" }],
    Subject: "Re: account balance",
    MessageID: randomUUID(),
    TextBody: "See the attached document.",
    Attachments: [
      {
        Name: "statement.pdf",
        Content: Buffer.from("synthetic-pdf-bytes", "utf8").toString("base64"),
        ContentType: "application/pdf",
        ContentLength: 18,
      },
    ],
    ...overrides,
  };
}

function signedRequest(payload: PostmarkInboundPayload, secret: string = TEST_SECRET): Request {
  const body = JSON.stringify(payload);
  return new Request("http://localhost/api/inbound", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-webhook-signature": createHmac("sha256", secret).update(body, "utf8").digest("base64"),
    },
    body,
  });
}

async function documentRows(caseId: string): Promise<{ doc_type: string; file_path: string }[]> {
  const res = await pool.query("select doc_type, file_path from documents where case_id = $1", [
    caseId,
  ]);
  return res.rows;
}

describe("POST /api/inbound", () => {
  it("routes alias mail onto the user's open case as 'other' documents", async () => {
    const alias = `jane.${randomUUID().slice(0, 8)}@${TEST_DOMAIN}`;
    const userId = await seedUser(alias);
    const caseId = await seedCase(userId, "waiting_reply");
    const payload = payloadFor(alias);

    const res = await POST(signedRequest(payload));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; routing: string; caseId: string };
    expect(body.status).toBe("processed");
    expect(body.routing).toBe("alias");
    expect(body.caseId).toBe(caseId);

    const docs = await documentRows(caseId);
    expect(docs).toHaveLength(1);
    expect(docs[0].doc_type).toBe("other");
    // The attachment's bytes really landed in the intake store.
    expect((await readFile(docs[0].file_path)).toString("utf8")).toBe("synthetic-pdf-bytes");

    const gate = await pool.query(
      "select routing, user_id, case_id from intake_emails where message_id = $1",
      [payload.MessageID],
    );
    expect(gate.rows).toHaveLength(1);
    expect(gate.rows[0].routing).toBe("alias");
    expect(gate.rows[0].user_id).toBe(userId);
    expect(gate.rows[0].case_id).toBe(caseId);
  });

  it("routes a case reply to the correct case as 'reply' documents with a timeline event", async () => {
    const userId = await seedUser(null);
    const caseId = await seedCase(userId, "waiting_reply");
    const payload = payloadFor(caseReplyAddress(caseId, TEST_DOMAIN));

    const res = await POST(signedRequest(payload));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; routing: string; caseId: string };
    expect(body.status).toBe("processed");
    expect(body.routing).toBe("case_reply");
    expect(body.caseId).toBe(caseId);

    // Attachment + the reply text itself, both filed as 'reply' on THE case.
    const docs = await documentRows(caseId);
    expect(docs).toHaveLength(2);
    expect(docs.every((d) => d.doc_type === "reply")).toBe(true);

    // No new case was opened for this reply.
    const caseCount = await pool.query("select count(*)::int as n from cases where user_id = $1", [
      userId,
    ]);
    expect(caseCount.rows[0].n).toBe(1);

    const events = await pool.query(
      "select actor, message from events where case_id = $1 and message like 'reply received%'",
      [caseId],
    );
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0].actor).toBe("system");
  });

  it("rejects unsigned, wrongly-signed, and tampered webhooks with 401 and processes nothing", async () => {
    const alias = `jane.${randomUUID().slice(0, 8)}@${TEST_DOMAIN}`;
    const userId = await seedUser(alias);
    const payload = payloadFor(alias);
    const body = JSON.stringify(payload);

    const unsigned = await POST(
      new Request("http://localhost/api/inbound", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }),
    );
    expect(unsigned.status).toBe(401);

    const wrongSecret = await POST(
      new Request("http://localhost/api/inbound", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-webhook-signature": createHmac("sha256", "attacker-key")
            .update(body, "utf8")
            .digest("base64"),
        },
        body,
      }),
    );
    expect(wrongSecret.status).toBe(401);

    const signature = createHmac("sha256", TEST_SECRET).update(body, "utf8").digest("base64");
    const tampered = await POST(
      new Request("http://localhost/api/inbound", {
        method: "POST",
        headers: { "content-type": "application/json", "x-webhook-signature": signature },
        body: `${body} `,
      }),
    );
    expect(tampered.status).toBe(401);

    // Fail closed even when no secret is configured.
    delete process.env.POSTMARK_WEBHOOK_SECRET;
    try {
      const unconfigured = await POST(signedRequest(payload));
      expect(unconfigured.status).toBe(401);
    } finally {
      process.env.POSTMARK_WEBHOOK_SECRET = TEST_SECRET;
    }

    const docs = await pool.query(
      "select count(*)::int as n from documents where case_id in (select id from cases where user_id = $1)",
      [userId],
    );
    const gates = await pool.query(
      "select count(*)::int as n from intake_emails where message_id = $1",
      [payload.MessageID],
    );
    expect(docs.rows[0].n).toBe(0);
    expect(gates.rows[0].n).toBe(0);
  });

  it("parks mail for an unrecognized recipient in the orphan queue, never dropped", async () => {
    const payload = payloadFor("stranger@somewhere-else.example");

    const res = await POST(signedRequest(payload));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; reason: string };
    expect(body.status).toBe("orphaned");
    expect(body.reason).toBe("unknown_alias");

    const orphan = await pool.query(
      "select status, reason, from_email, recipients, raw_payload from orphan_emails where message_id = $1",
      [payload.MessageID],
    );
    expect(orphan.rows).toHaveLength(1);
    expect(orphan.rows[0].status).toBe("pending");
    expect(orphan.rows[0].reason).toBe("unknown_alias");
    expect(orphan.rows[0].from_email).toBe("billing@novaparkmedical.example");
    expect(orphan.rows[0].recipients).toBe("stranger@somewhere-else.example");
    expect(orphan.rows[0].raw_payload).toMatchObject({ MessageID: payload.MessageID });

    // An orphan is not processed mail: no gate row, no documents.
    const gates = await pool.query(
      "select count(*)::int as n from intake_emails where message_id = $1",
      [payload.MessageID],
    );
    expect(gates.rows[0].n).toBe(0);
  });

  it("treats a redelivered MessageID as a no-op (at-least-once delivery)", async () => {
    const alias = `jane.${randomUUID().slice(0, 8)}@${TEST_DOMAIN}`;
    const userId = await seedUser(alias);
    const caseId = await seedCase(userId, "intake");
    const payload = payloadFor(alias);

    const first = await POST(signedRequest(payload));
    expect(first.status).toBe(200);
    const second = await POST(signedRequest(payload));
    expect(second.status).toBe(200);
    expect(((await second.json()) as { status: string }).status).toBe("duplicate");

    expect(await documentRows(caseId)).toHaveLength(1);
  });

  it("opens a new case for alias mail when the user has only closed cases", async () => {
    const alias = `jane.${randomUUID().slice(0, 8)}@${TEST_DOMAIN}`;
    const userId = await seedUser(alias);
    const closedCaseId = await seedCase(userId, "resolved");
    const payload = payloadFor(alias);

    const res = await POST(signedRequest(payload));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; caseId: string };
    expect(body.caseId).not.toBe(closedCaseId);

    const newCase = await pool.query("select status from cases where id = $1", [body.caseId]);
    expect(newCase.rows[0].status).toBe("intake");
    expect(await documentRows(body.caseId)).toHaveLength(1);
  });
});
