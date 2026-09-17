/**
 * Mock external providers for the E2E suite: Anthropic, Postmark, and Stripe.
 *
 * The point is to exercise the REAL adapters in lib/ (extract, analyze,
 * postmark-email, stripe gateway) against recorded-shape responses, so CI
 * needs no live credentials. The Next server points at this process through
 * the base-URL overrides (ANTHROPIC_BASE_URL, POSTMARK_BASE_URL,
 * STRIPE_BASE_URL); production defaults are untouched.
 *
 * Recorded traffic is readable at GET /__outbox — the E2E asserts on the
 * actual outbound letters, receipts, and Stripe calls, not just on DB state.
 * POST /__reset clears the recorder between tests.
 *
 * Runs on MOCK_PROVIDERS_PORT (default 9310). Started by the Playwright
 * config's second webServer entry — no manual step.
 */
import { createServer } from "node:http";

const PORT = Number(process.env.MOCK_PROVIDERS_PORT ?? 9310);

/** The recorded traffic the E2E asserts on, grouped per provider. */
const outbox = {
  anthropic: [],
  postmark: [],
  stripe: [],
};

let postmarkSeq = 0;
let paymentSeq = 0;

/**
 * The synthetic extraction result for the E2E's uploaded bill. The source
 * text lives in tests/e2e/fixture-bill.txt and states every value here —
 * the invented-value check compares them — except the line items and total
 * deliberately disagree: the bill itself carries a $150 math imbalance, the
 * spec's flagged-extraction scenario.
 */
function extractionResponse() {
  return {
    doc_type: "itemized",
    patient_name: "Elena Marsh",
    provider_name: "St. Augustine Hospital",
    insurer_name: "Meridian Health Plan",
    claim_number: "CLM-2026-88412",
    service_dates: ["2026-07-02"],
    line_items: [
      {
        date: "2026-07-02",
        code: "45378",
        description: "Diagnostic colonoscopy",
        units: 1,
        billed: 500,
        allowed: null,
        paid: null,
        patient_owes: null,
      },
      {
        date: "2026-07-02",
        code: "00811",
        description: "Anesthesia, colonoscopy, moderate sedation",
        units: 1,
        billed: 200,
        allowed: null,
        paid: null,
        patient_owes: null,
      },
    ],
    total_billed: 850,
    patient_responsibility: 850,
    denial_reason: null,
    appeal_deadline: null,
    network_status: "unknown",
    was_emergency: null,
    notes: "",
  };
}

/**
 * The analyst response, built from the request's REAL document ids — the
 * evidence rule rejects citations that do not resolve, so a canned fixture
 * with fixture ids would be (correctly) thrown away. Findings cite the
 * uploaded bill's actual id and fields that exist on it.
 */
function analystResponse(requestBody) {
  const brief = JSON.parse(requestBody.messages[0].content);
  const bill =
    brief.documents.find(
      (doc) => doc.extracted !== null && doc.extracted.doc_type === "itemized",
    ) ?? brief.documents[0];
  const total = bill.extracted.total_billed;
  const responsibility = bill.extracted.patient_responsibility;
  return {
    findings: [
      {
        kind: "billing_error",
        description:
          `The itemized statement's line items do not add up to its stated total: the two ` +
          `line items sum to $700.00, but the statement demands $${Number(total).toFixed(2)} — ` +
          "a $150.00 gap that the hospital's own arithmetic created.",
        estimated_savings: 150,
        confidence: "high",
        urgent: false,
        evidence: [
          { document_id: bill.id, field: "total_billed", quote: "TOTAL BALANCE DUE: $850.00" },
          { document_id: bill.id, field: "line_items[0].billed", quote: null },
          { document_id: bill.id, field: "line_items[1].billed", quote: null },
        ],
      },
      {
        kind: "nsa_protected",
        description:
          `The statement's patient responsibility of $${Number(responsibility).toFixed(2)} was ` +
          "never reconciled against Meridian's plan terms; request the EOB and the " +
          "cost-share basis before paying anything.",
        estimated_savings: null,
        confidence: "medium",
        urgent: false,
        evidence: [
          { document_id: bill.id, field: "patient_responsibility", quote: null },
          { document_id: bill.id, field: "claim_number", quote: "CLM-2026-88412" },
        ],
      },
    ],
    plan: [
      {
        title: "Dispute the statement balance in writing",
        detail:
          `Send St. Augustine Hospital and Meridian a written dispute of the $${Number(total).toFixed(2)} ` +
          "balance, citing claim CLM-2026-88412 and the $150.00 line-item arithmetic gap.",
      },
      {
        title: "Request the EOB and cost-share basis",
        detail:
          "Ask Meridian for the EOB on claim CLM-2026-88412 and written confirmation of the " +
          "cost-share basis before the balance is due.",
      },
      {
        title: "Hold payment while the dispute is open",
        detail:
          "Do not pay the statement while the dispute is open; ask the billing office to flag the claim under review.",
      },
    ],
    summary:
      "The hospital's itemized statement demands $850.00, but its own line items only add up " +
      "to $700.00. Request the EOB from Meridian and dispute the balance in writing — the " +
      "documents support challenging it.",
  };
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let data = "";
    request.on("data", (chunk) => (data += chunk));
    request.on("end", () => resolve(data));
    request.on("error", reject);
  });
}

function sendJson(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://localhost:${PORT}`);
  const body = await readBody(request);

  // ---- Anthropic (extraction + analyst share the Messages API) ----
  if (url.pathname === "/anthropic/v1/messages" && request.method === "POST") {
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      return sendJson(response, 400, { error: "bad json" });
    }
    const isExtraction = parsed.system?.startsWith(
      "You are a medical billing document extraction engine",
    );
    const payload = isExtraction ? extractionResponse() : analystResponse(parsed);
    outbox.anthropic.push({
      kind: isExtraction ? "extraction" : "analysis",
      at: new Date().toISOString(),
    });
    return sendJson(response, 200, {
      id: `msg_mock_${outbox.anthropic.length}`,
      type: "message",
      role: "assistant",
      model: parsed.model,
      content: [{ type: "text", text: JSON.stringify(payload) }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    });
  }

  // ---- Postmark outbound ----
  if (url.pathname === "/postmark/email" && request.method === "POST") {
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      return sendJson(response, 422, { Message: "bad json" });
    }
    postmarkSeq += 1;
    outbox.postmark.push({ ...parsed, at: new Date().toISOString() });
    return sendJson(response, 200, { MessageID: `mock-postmark-${postmarkSeq}`, To: parsed.To });
  }

  // ---- Stripe: customer create + read (charge reads the saved card) ----
  const customerCreate = url.pathname === "/stripe/v1/customers" && request.method === "POST";
  const customerRead =
    /^\/stripe\/v1\/customers\/[^/]+$/.test(url.pathname) && request.method === "GET";
  if (customerCreate || customerRead) {
    let email = undefined;
    if (customerCreate) {
      const params = new URLSearchParams(body);
      email = params.get("email") ?? undefined;
    }
    const id = customerRead ? url.pathname.split("/").pop() : "cus_mock_1";
    outbox.stripe.push({ kind: customerCreate ? "create_customer" : "read_customer", id, email });
    return sendJson(response, 200, {
      id,
      object: "customer",
      email,
      // The signup-card bootstrap: the MVP saves the standard test card, so
      // the customer always has a default payment method to charge.
      invoice_settings: { default_payment_method: "pm_mock_saved_card" },
    });
  }

  // ---- Stripe: payment intent confirm + charge read (receipt URL) ----
  if (url.pathname === "/stripe/v1/payment_intents" && request.method === "POST") {
    paymentSeq += 1;
    const params = new URLSearchParams(body);
    const entry = {
      kind: "payment_intent",
      amount: params.get("amount"),
      currency: params.get("currency"),
      customer: params.get("customer"),
      description: params.get("description"),
      receipt_email: params.get("receipt_email"),
      metadata: Object.fromEntries(
        [...params.entries()]
          .filter(([key]) => key.startsWith("metadata["))
          .map(([key, value]) => [key, value]),
      ),
    };
    outbox.stripe.push(entry);
    return sendJson(response, 200, {
      id: `pi_mock_${paymentSeq}`,
      object: "payment_intent",
      status: "succeeded",
      latest_charge: `ch_mock_${paymentSeq}`,
    });
  }
  const chargeRead =
    /^\/stripe\/v1\/charges\/[^/]+$/.test(url.pathname) && request.method === "GET";
  if (chargeRead) {
    const id = url.pathname.split("/").pop();
    return sendJson(response, 200, {
      id,
      object: "charge",
      receipt_url: `https://mock.stripe/receipts/${id}`,
    });
  }

  // ---- Test-only recorder ----
  if (url.pathname === "/__outbox" && request.method === "GET") {
    return sendJson(response, 200, outbox);
  }
  if (url.pathname === "/__reset" && request.method === "POST") {
    outbox.anthropic.length = 0;
    outbox.postmark.length = 0;
    outbox.stripe.length = 0;
    return sendJson(response, 200, { reset: true });
  }

  sendJson(response, 404, { error: `no mock for ${request.method} ${url.pathname}` });
});

server.listen(PORT, () => {
  console.log(`mock providers listening on http://localhost:${PORT}`);
});
