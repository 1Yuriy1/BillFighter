"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type SubmitState = "idle" | "working" | "recorded" | "completed" | "error";

const FEEDBACK: Record<Exclude<SubmitState, "idle" | "working" | "error">, string> = {
  recorded: "Your approval is recorded — waiting on the second signature.",
  completed: "Both approvals in — this letter is queued to send.",
};

/**
 * The family/caregiver approve button behind the two-human gate: records the
 * session user's approval (RLS + column grants scope the write server-side)
 * and refreshes the server components so approval state renders from the
 * database, never from optimistic local state alone.
 */
export function ApproveDraftButton({ actionId }: { actionId: string }) {
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
      <p className="text-sm font-medium text-green-700" role="status">
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
        data-testid="approve-draft-button"
        className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
      >
        {state === "working" ? "Recording…" : "Approve to send"}
      </button>
      {state === "error" ? (
        <span className="text-sm text-red-700" role="alert">
          Could not record your approval — try again.
        </span>
      ) : null}
    </span>
  );
}
