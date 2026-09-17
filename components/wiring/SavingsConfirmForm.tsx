"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { StaffSavingsRow } from "@/lib/db/queries";

type SubmitState = "idle" | "working" | "charged" | "skipped" | "error";

interface ConfirmResponse {
  outcome?: string;
  feeCents?: number;
  reason?: string;
  error?: string;
}

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * The staff savings-confirmation form behind the fee flow: picks the proof
 * document (a bill or EOB on the case), states the verified savings, and
 * confirms — POST /api/cases/[id]/savings runs the proof gate, the capped
 * fee math, and the Stripe charge (test mode). The button stays disabled
 * until a proof document and a savings amount are both present: the proof
 * gate is the product's spine, so the UI never invites bypassing it.
 */
export function SavingsConfirmForm({ caseRow }: { caseRow: StaffSavingsRow }) {
  const router = useRouter();
  const [state, setState] = useState<SubmitState>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [proofDocumentId, setProofDocumentId] = useState(caseRow.documents[0]?.id ?? "");
  const [proofKind, setProofKind] = useState<"new_bill" | "eob">("new_bill");
  const [savings, setSavings] = useState("");

  async function confirm() {
    if (state === "working") return;
    setState("working");
    setMessage(null);
    try {
      const response = await fetch(`/api/cases/${caseRow.caseId}/savings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          proofDocumentId,
          proofKind,
          confirmedSavings: savings,
          note: "Confirmed from the staff console",
        }),
      });
      const body = (await response.json().catch(() => null)) as ConfirmResponse | null;
      if (!response.ok) {
        setState("error");
        setMessage(body?.error ?? "confirmation_failed");
        return;
      }
      if (body?.outcome === "charged") {
        setState("charged");
        setMessage(`Success fee of ${dollars(body.feeCents ?? 0)} charged — receipt on its way.`);
      } else {
        setState("skipped");
        setMessage(
          body?.reason === "no_confirmed_savings"
            ? "No confirmed savings — recorded on the timeline, nothing charged."
            : "This case was already charged — the ledger kept the first payment.",
        );
      }
      router.refresh();
    } catch {
      setState("error");
      setMessage("confirmation_failed");
    }
  }

  if (caseRow.documents.length === 0) {
    return (
      <p className="text-sm text-slate-600" data-testid="savings-no-proof">
        No bill or EOB document on this case yet — attach the proof before confirming savings.
      </p>
    );
  }

  const ready = proofDocumentId !== "" && savings.trim() !== "";

  return (
    <form
      className="mt-3 flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        void confirm();
      }}
    >
      <div className="flex flex-wrap gap-3">
        <label className="flex flex-col gap-1 text-sm text-slate-700">
          Proof document
          <select
            value={proofDocumentId}
            onChange={(event) => setProofDocumentId(event.target.value)}
            data-testid="savings-proof"
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
          >
            {caseRow.documents.map((doc) => (
              <option key={doc.id} value={doc.id}>
                {doc.docType === "eob" ? "EOB" : "Bill"} — filed {doc.createdAt.slice(0, 10)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm text-slate-700">
          Proof kind
          <select
            value={proofKind}
            onChange={(event) => setProofKind(event.target.value as "new_bill" | "eob")}
            data-testid="savings-kind"
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
          >
            <option value="new_bill">New bill (savings happened)</option>
            <option value="eob">EOB shows the corrected amount</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm text-slate-700">
          Confirmed savings ($)
          <input
            type="number"
            min="0"
            step="0.01"
            value={savings}
            onChange={(event) => setSavings(event.target.value)}
            data-testid="savings-amount"
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
          />
        </label>
      </div>
      <button
        type="submit"
        disabled={!ready || state === "working"}
        data-testid="savings-confirm"
        className="w-fit rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
      >
        {state === "working" ? "Confirming…" : "Confirm savings and charge fee"}
      </button>
      {message !== null && state !== "error" ? (
        <p className="text-sm font-medium text-green-700" role="status" data-testid="savings-feedback">
          {message}
        </p>
      ) : null}
      {state === "error" ? (
        <p className="text-sm text-red-700" role="alert" data-testid="savings-error">
          The confirmation failed ({message ?? "unknown error"}) — nothing was charged; fix the
          error and try again.
        </p>
      ) : null}
    </form>
  );
}