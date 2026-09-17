"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type SubmitState = "idle" | "working" | "recorded" | "completed" | "error";

const FEEDBACK: Record<Exclude<SubmitState, "idle" | "working" | "error">, string> = {
  recorded: "Your signature is recorded — the family still needs to approve.",
  completed: "Both signatures in — this letter is queued to send.",
};

/**
 * The staff approve button behind the two-human gate: records the staff
 * signature on a draft via the same approval route the family button uses
 * (the session role decides which slot fills). Feedback states render from
 * the API's outcome; the server components refresh so gate state always
 * reads from the database.
 */
export function StaffApproveButton({ actionId }: { actionId: string }) {
  const router = useRouter();
  const [state, setState] = useState<SubmitState>("idle");

  async function approve() {
    setState("working");
    try {
      const response = await fetch(`/api/actions/${actionId}/approve`, { method: "POST" });
      if (!response.ok) {
        setState("error");
        return;
      }
      const outcome = (await response.json()) as { status?: string };
      setState(outcome.status === "completed" ? "completed" : "recorded");
      router.refresh();
    } catch {
      setState("error");
    }
  }

  if (state === "recorded" || state === "completed") {
    return (
      <p className="text-sm font-medium text-green-700" role="status" data-testid="staff-approve-feedback">
        {FEEDBACK[state]}
      </p>
    );
  }
  return (
    <span className="inline-flex flex-col items-start gap-1">
      <button
        type="button"
        onClick={approve}
        disabled={state === "working"}
        data-testid="staff-approve-button"
        className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-700 disabled:opacity-50"
      >
        {state === "working" ? "Recording…" : "Approve as staff"}
      </button>
      {state === "error" ? (
        <span className="text-sm text-red-700" role="alert">
          Could not record the staff approval — try again.
        </span>
      ) : null}
    </span>
  );
}