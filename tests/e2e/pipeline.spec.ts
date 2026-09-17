/**
 * The full-pipeline E2E: one synthetic bill drives the entire product —
 * upload → extraction (with the bill's own $150 math imbalance flagged for
 * human review) → rules + AI analysis → cited letter drafts → family
 * approval → staff approval → dispatch (mock Postmark) → follow-up
 * scheduled → inbound reply (signed webhook) → classification → resolution
 * → staff savings confirmation against the proof → capped 15% fee (mock
 * Stripe) → receipt.
 *
 * Every external provider is the local mock (scripts/mock-providers.mjs,
 * wired through the base-URL overrides in playwright.config.ts), so CI needs
 * no live credentials. The spec runs against its own dedicated family and
 * staff users (created in beforeAll, previous runs cleaned up first) — the
 * seeded demo data is never touched, so UI assertions cannot collide with
 * it. UI assertions cover what a human sees; direct DB assertions cover
 * what the spec's falsifiable checks actually claim — persisted state,
 * never optimistic UI. The mock's /__outbox proves the real outbound bytes:
 * the dispute letter, the resolution notification, and the fee receipt.
 */
import { readFileSync } from "node:fs";
import { createHmac } from "node:crypto";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { Client } from "pg";

const FAMILY_EMAIL = "e2e-family@billfighter.test";
const STAFF_EMAIL = "e2e-staff@billfighter.test";
const MOCK_BASE = process.env.MOCK_PROVIDERS_URL ?? "http://localhost:9310";
const CASE_PROVIDER = "St. Augustine Hospital";
const CASE_LABEL = "Meridian Health Plan — St. Augustine Hospital";
const CLAIM_NUMBER = "CLM-2026-88412";
const DISPUTED_AMOUNT = 850;
const CONFIRMED_SAVINGS = 150; // the bill's own math imbalance
const FEE_CENTS = Math.round(CONFIRMED_SAVINGS * 0.15 * 100); // $22.50

const WEBHOOK_SECRET = process.env.POSTMARK_WEBHOOK_SECRET ?? "e2e-webhook-secret";
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/billfighter_test";

const FIXTURE_BILL = readFileSync(path.join(__dirname, "fixture-bill.txt"), "utf8");

interface MockOutbox {
  anthropic: { kind: string }[];
  postmark: { To: string; Subject?: string; TextBody?: string }[];
  stripe: { kind: string; amount?: string; email?: string; metadata?: Record<string, string> }[];
}

async function outbox(): Promise<MockOutbox> {
  const response = await fetch(`${MOCK_BASE}/__outbox`);
  return (await response.json()) as MockOutbox;
}

async function resetOutbox(): Promise<void> {
  await fetch(`${MOCK_BASE}/__reset`, { method: "POST" });
}

/** Dev sign-in inside the page's own origin, so the session cookie sticks. */
async function devLogin(page: Page, email: string): Promise<void> {
  await page.goto("/");
  const status = await page.evaluate(async (loginEmail) => {
    const response = await fetch("/api/dev/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: loginEmail }),
    });
    return response.status;
  }, email);
  expect(status, `dev login for ${email}`).toBe(200);
}

/** Runs a pipeline job through the dev trigger route (any signed-in session). */
async function runJob(page: Page, job: string): Promise<Record<string, unknown>> {
  const result = await page.evaluate(async (jobName) => {
    const response = await fetch("/api/dev/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ job: jobName }),
    });
    return { status: response.status, body: await response.json() };
  }, job);
  expect(result.status, `job ${job}`).toBe(200);
  return result.body as Record<string, unknown>;
}

let db: Client;

/**
 * Removes every trace of earlier E2E runs for the dedicated users — the
 * pipeline is not idempotent across runs (new cases per upload), so the
 * cleanup is what makes reruns deterministic. Order follows the FK graph:
 * payments/proofs → classification → findings/actions/documents/events →
 * intake emails → cases → users.
 */
async function cleanupE2eUsers(): Promise<void> {
  const caseIds = `select id from cases where user_id in
    (select id from users where email = $1 or email = $2)`;
  const docIds = `select d.id from documents d join cases c on c.id = d.case_id
    where c.user_id in (select id from users where email = $1 or email = $2)`;
  await db.query(
    `delete from receipt_line_items where payment_id in
       (select p.id from payments p where p.case_id in (${caseIds}))`,
    [FAMILY_EMAIL, STAFF_EMAIL],
  );
  await db.query(
    `delete from payments where case_id in (${caseIds})
        or user_id in (select id from users where email = $1 or email = $2)`,
    [FAMILY_EMAIL, STAFF_EMAIL],
  );
  await db.query(`delete from savings_proofs where case_id in (${caseIds})`, [
    FAMILY_EMAIL,
    STAFF_EMAIL,
  ]);
  await db.query(
    `delete from notifications where case_id in (${caseIds})
        or user_id in (select id from users where email = $1 or email = $2)`,
    [FAMILY_EMAIL, STAFF_EMAIL],
  );
  await db.query(
    `delete from reply_classifications where case_id in (${caseIds})
        or document_id in (${docIds})`,
    [FAMILY_EMAIL, STAFF_EMAIL],
  );
  await db.query(`delete from findings where case_id in (${caseIds})`, [FAMILY_EMAIL, STAFF_EMAIL]);
  await db.query(`delete from actions where case_id in (${caseIds})`, [FAMILY_EMAIL, STAFF_EMAIL]);
  await db.query(`delete from documents where case_id in (${caseIds})`, [
    FAMILY_EMAIL,
    STAFF_EMAIL,
  ]);
  await db.query(`delete from events where case_id in (${caseIds})`, [FAMILY_EMAIL, STAFF_EMAIL]);
  await db.query(
    `delete from intake_emails where case_id in (${caseIds})
        or user_id in (select id from users where email = $1 or email = $2)`,
    [FAMILY_EMAIL, STAFF_EMAIL],
  );
  await db.query(`delete from cases where id in (${caseIds})`, [FAMILY_EMAIL, STAFF_EMAIL]);
  await db.query(`delete from users where email = $1 or email = $2`, [FAMILY_EMAIL, STAFF_EMAIL]);
}

test.beforeAll(async () => {
  db = new Client({ connectionString: DATABASE_URL });
  await db.connect();
  await cleanupE2eUsers();
  // Dedicated family (authorization signed — the outbound gate) and staff
  // users; the pipeline under test then runs against a clean slate.
  await db.query(
    `insert into users (email, full_name, is_staff, authorization_signed_at)
     values ($1, 'E2E Family', false, now()), ($2, 'E2E Staff', true, null)`,
    [FAMILY_EMAIL, STAFF_EMAIL],
  );
});

test.afterAll(async () => {
  await db.end();
});

test.describe.configure({ mode: "serial" });

test("full pipeline: upload to proof-gated fee on one synthetic case", async ({
  page,
  browser,
  request,
}) => {
  test.setTimeout(240_000);
  await resetOutbox();

  // ---- Family signs in to an empty dashboard; the new-case upload form ----
  await devLogin(page, FAMILY_EMAIL);
  await page.goto("/dashboard");
  await expect(page.getByText("No cases yet", { exact: false })).toBeVisible();

  // Upload the bill; extraction + analysis run inside the POST.
  await page
    .getByTestId("upload-input")
    .first()
    .setInputFiles({
      name: "st-augustine-bill.txt",
      mimeType: "text/plain",
      buffer: Buffer.from(FIXTURE_BILL, "utf8"),
    });
  await page.getByTestId("upload-submit").first().click();
  // Starting a new case swaps the empty state for the case section once the
  // upload+analysis POST lands, unmounting the form — so the completed case
  // section (not the form's transient result text) is the completion signal.
  // DraftReviewCard renders its own <section>s (evidence, approvals), so the
  // case section is identified by its status badge, not by text alone.
  const caseSection = page
    .locator("section")
    .filter({ has: page.getByTestId("case-status-badge") })
    .filter({ hasText: CASE_PROVIDER });
  const section = caseSection.last();
  await expect(section).toBeVisible({ timeout: 60_000 });

  // The new case renders with its rollups filled from the extraction, and
  // the two-human gate is visibly open.
  await expect(section.getByText(CASE_LABEL).first()).toBeVisible();
  await expect(section.getByTestId("case-status-badge")).toHaveText("Waiting for your approval");
  await expect(section.getByText("Letters waiting for review")).toBeVisible();

  // ---- Spec check: the math imbalance is flagged, not smoothed over ------
  const flagged = await db.query<{ needs_human_review: boolean; review_reason: string | null }>(
    `select d.needs_human_review, d.review_reason
       from documents d join cases c on c.id = d.case_id join users u on u.id = c.user_id
      where u.email = $1 and d.doc_type = 'itemized'
      order by d.created_at desc limit 1`,
    [FAMILY_EMAIL],
  );
  expect(flagged.rows).toHaveLength(1);
  expect(flagged.rows[0].needs_human_review).toBe(true);
  expect(flagged.rows[0].review_reason ?? "").toContain("math check failed");
  expect(flagged.rows[0].review_reason ?? "").toContain("$150.00");

  // ---- Spec check: analysis persisted cited findings + drafts ------------
  const analysis = await db.query<{
    case_id: string;
    case_status: string;
    amount_disputed: string | null;
    finding_count: string;
    draft_count: string;
  }>(
    `select c.id as case_id, c.status as case_status, c.amount_disputed,
            (select count(*) from findings f where f.case_id = c.id) as finding_count,
            (select count(*) from actions a
              where a.case_id = c.id and a.channel = 'email') as draft_count
       from cases c join users u on u.id = c.user_id
      where u.email = $1`,
    [FAMILY_EMAIL],
  );
  expect(analysis.rows).toHaveLength(1);
  expect(analysis.rows[0].case_status).toBe("awaiting_approval");
  expect(Number(analysis.rows[0].amount_disputed)).toBe(DISPUTED_AMOUNT);
  expect(Number(analysis.rows[0].finding_count)).toBeGreaterThanOrEqual(2);
  expect(Number(analysis.rows[0].draft_count)).toBeGreaterThanOrEqual(1);
  const caseId = analysis.rows[0].case_id;

  // ---- Family signs the first draft (the two-human gate, signature 1) ----
  await section.getByTestId("approve-draft-button").first().click();
  // router.refresh() re-renders the draft card from the database, which
  // remounts the button and drops its transient client message — the
  // durable signal is the server-rendered approvals list.
  await expect(
    section.getByText("Received — your approval").first(),
  ).toBeVisible();
  const actionRow = (
    await db.query<{ id: string }>(
      `select a.id from actions a
        where a.case_id = $1 and a.status = 'draft' and a.user_approved_at is not null
        order by a.created_at limit 1`,
      [caseId],
    )
  ).rows[0];
  expect(actionRow.id).toBeTruthy();

  // ---- Staff console: review queue flags the math, then signs (gate 2) ---
  const staffContext = await browser.newContext();
  const staffPage = await staffContext.newPage();
  await devLogin(staffPage, STAFF_EMAIL);
  await staffPage.goto("/staff");

  // The review queue names the math failure on our document.
  const queueRow = staffPage
    .locator("table tr, li")
    .filter({ hasText: CASE_PROVIDER })
    .filter({ hasText: "math check failed" })
    .first();
  await expect(queueRow).toBeVisible();

  // Our family-approved draft is the review entry — scoped by action id so
  // a stray draft from a crashed earlier run can never absorb the click.
  const draftRow = staffPage
    .getByTestId("staff-draft-review-list")
    .locator("li")
    .filter({ has: staffPage.locator(`[data-action-id="${actionRow.id}"]`) });
  await expect(draftRow).toBeVisible();
  await expect(
    draftRow.getByText("Family approved — waiting on you", { exact: false }),
  ).toBeVisible();
  await draftRow.getByTestId("staff-approve-button").click();
  // Signing moves the draft out of the review list entirely (the query
  // filters staff_approved_at is null), so the refresh removes the row —
  // and the button's transient feedback element with it. The durable
  // signal is the row's disappearance, verified in the DB below.
  await expect(draftRow).toHaveCount(0);

  const approved = await db.query<{ status: string; case_status: string }>(
    `select a.status, c.status as case_status
       from actions a join cases c on c.id = a.case_id
      where a.id = $1`,
    [actionRow.id],
  );
  expect(approved.rows[0].status).toBe("approved");
  expect(approved.rows[0].case_status).toBe("in_progress");

  // ---- Dispatch: the approved letter leaves through the mock Postmark ----
  const dispatch = await runJob(staffPage, "dispatch");
  expect(Number(dispatch.sent ?? 0)).toBeGreaterThanOrEqual(1);

  const sent = await db.query<{ status: string; follow_up_at: Date | null }>(
    `select status, follow_up_at from actions where id = $1`,
    [actionRow.id],
  );
  expect(sent.rows[0].status).toBe("sent");
  expect(sent.rows[0].follow_up_at).not.toBeNull();

  const waiting = await db.query<{ status: string }>(`select status from cases where id = $1`, [
    caseId,
  ]);
  expect(waiting.rows[0].status).toBe("waiting_reply");

  const outboxAfterSend = await outbox();
  // The claim number rides in the letter body ("Re: Claim …"), which is what
  // the billing office matches against their system; the subject is a label.
  const disputeLetter = outboxAfterSend.postmark.find((entry) =>
    (entry.TextBody ?? "").includes(CLAIM_NUMBER),
  );
  expect(disputeLetter, "dispute letter sent with the claim number").toBeTruthy();

  // ---- Inbound reply: signed webhook, classified as resolved -------------
  const replyAddress = `case-${caseId.replace(/-/g, "").slice(0, 8)}@in.billfighter.com`;
  const rawBody = JSON.stringify({
    From: "billing@meridianhealthplan.example",
    To: replyAddress,
    MessageID: `e2e-reply-${Date.now()}`,
    TextBody:
      "We have reprocessed the claim and issued a refund. Your account shows a zero balance. Thank you for your patience.",
  });
  const signature = createHmac("sha256", WEBHOOK_SECRET).update(rawBody, "utf8").digest("base64");
  const inbound = await request.post("/api/inbound", {
    headers: { "x-webhook-signature": signature, "content-type": "application/json" },
    data: rawBody,
  });
  expect(inbound.status(), "inbound webhook accepted").toBe(200);

  const classify = await runJob(staffPage, "replies");
  expect(Number(classify.resolvedCases ?? 0)).toBeGreaterThanOrEqual(1);

  const resolved = await db.query<{ status: string }>(`select status from cases where id = $1`, [
    caseId,
  ]);
  expect(resolved.rows[0].status).toBe("resolved");
  const classification = await db.query<{ outcome: string }>(
    `select rc.outcome from reply_classifications rc
       join documents d on d.id = rc.document_id
      where d.case_id = $1 order by rc.created_at desc limit 1`,
    [caseId],
  );
  expect(classification.rows[0].outcome).toBe("resolved");
  const outboxAfterReply = await outbox();
  const resolutionNotice = outboxAfterReply.postmark.find((entry) =>
    (entry.Subject ?? "").includes("resolved"),
  );
  expect(resolutionNotice, "family notified of the resolution").toBeTruthy();

  // Family dashboard reflects the resolution.
  await page.goto("/dashboard");
  const resolvedSection = page
    .locator("section")
    .filter({ has: page.getByTestId("case-status-badge") })
    .filter({ hasText: CASE_PROVIDER })
    .last();
  await expect(resolvedSection.getByTestId("case-status-badge")).toHaveText("Resolved");

  // ---- The family files the corrected statement — the savings proof -------
  // The refund in hand is a $700 corrected total (the line items' sum), so
  // the $850 billed was $150 too much. A resolved case accepts documents
  // for the record — analysis stays closed with the dispute — and this one
  // is the proof the staff confirmation gates on.
  const corrected = await db.query<{ doc_count: string }>(
    `select count(*) as doc_count from documents where case_id = $1`,
    [caseId],
  );
  await resolvedSection
    .getByTestId("upload-input")
    .first()
    .setInputFiles({
      name: "corrected-statement.txt",
      mimeType: "text/plain",
      buffer: Buffer.from(
        [
          "CORRECTED STATEMENT — supersedes all prior statements",
          `Claim ${CLAIM_NUMBER} — patient Elena Marsh`,
          "St. Augustine Hospital — Patient Billing Office",
          "Physician services (office visit, established patient): $500.00",
          "Laboratory services (panel, CPT 80053): $200.00",
          "Payments received: $150.00",
          "Corrected total patient responsibility: $700.00",
        ].join("\n"),
        "utf8",
      ),
    });
  await resolvedSection.getByTestId("upload-submit").first().click();
  await expect
    .poll(async () =>
      Number(
        (
          await db.query<{ doc_count: string }>(
            `select count(*) as doc_count from documents where case_id = $1`,
            [caseId],
          )
        ).rows[0].doc_count,
      ),
    )
    .toBe(Number(corrected.rows[0].doc_count) + 1);

  // ---- Staff confirms savings against the proof; the fee charges ---------
  await staffPage.goto("/staff");
  const savingsEntry = staffPage
    .getByTestId("staff-savings-list")
    .locator("li")
    .filter({ hasText: FAMILY_EMAIL })
    .filter({ hasText: CASE_PROVIDER })
    .first();
  await expect(savingsEntry).toBeVisible();
  await expect(savingsEntry.getByTestId("savings-proof")).toBeVisible();
  await savingsEntry.getByTestId("savings-amount").fill(String(CONFIRMED_SAVINGS));
  await savingsEntry.getByTestId("savings-confirm").click();
  // Charging sets amount_saved, which drops the case from the savings list
  // (the query filters amount_saved is null) — the refresh removes the row
  // and the form's transient feedback with it. The payments row below is
  // the durable record of the charge.
  await expect(savingsEntry).toHaveCount(0);

  // Proof-gated, capped, ledgered: the payments row is the receipt of record.
  const payment = await db.query<{
    fee_cents: number;
    confirmed_savings: string;
    status: string;
    stripe_charge_id: string | null;
  }>(`select fee_cents, confirmed_savings, status, stripe_charge_id from payments where case_id = $1`, [
    caseId,
  ]);
  expect(payment.rows).toHaveLength(1);
  expect(payment.rows[0].status).toBe("succeeded");
  expect(payment.rows[0].fee_cents).toBe(FEE_CENTS);
  expect(Number(payment.rows[0].confirmed_savings)).toBe(CONFIRMED_SAVINGS);
  expect(payment.rows[0].stripe_charge_id ?? "").toMatch(/^pi_mock_/);

  const saved = await db.query<{ amount_saved: string | null }>(
    `select amount_saved from cases where id = $1`,
    [caseId],
  );
  expect(Number(saved.rows[0].amount_saved)).toBe(CONFIRMED_SAVINGS);

  // The mock Stripe saw the off-session payment intent...
  const finalOutbox = await outbox();
  const intent = finalOutbox.stripe.find((entry) => entry.kind === "payment_intent");
  expect(intent, "stripe payment intent").toBeTruthy();
  expect(intent?.amount).toBe(String(FEE_CENTS));
  // ...and the family's receipt email carries the fee line items.
  const receipt = finalOutbox.postmark.find(
    (entry) => entry.To === FAMILY_EMAIL && (entry.TextBody ?? "").includes("$22.50"),
  );
  expect(receipt, "receipt email with the fee math").toBeTruthy();

  // ---- Deadlines: the follow-up deadline was registered at dispatch ------
  const followUp = await db.query<{ follow_up_at: Date | null }>(
    `select follow_up_at from actions where id = $1`,
    [actionRow.id],
  );
  expect(followUp.rows[0].follow_up_at).not.toBeNull();

  await staffContext.close();
});
