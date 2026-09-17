"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Staff resolution buttons for one orphan email (inbound mail that matched
 * no case address). Both actions post to /api/orphans/[id]; the row leaves
 * the pending queue server-side, and the refresh re-renders from the queue
 * query.
 */
export function OrphanActions({ orphanId }: { orphanId: string }) {
  const router = useRouter();
  const [working, setWorking] = useState<"claimed" | "dismissed" | null>(null);
  const [error, setError] = useState(false);

  async function resolve(status: "claimed" | "dismissed") {
    setWorking(status);
    setError(false);
    try {
      const response = await fetch(`/api/orphans/${orphanId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (!response.ok) {
        setError(true);
        setWorking(null);
        return;
      }
      router.refresh();
    } catch {
      setError(true);
      setWorking(null);
    }
  }

  return (
    <span className="flex flex-col items-end gap-1">
      <span className="flex gap-2">
        <button
          type="button"
          onClick={() => resolve("claimed")}
          disabled={working !== null}
          className="rounded-lg bg-slate-800 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-900 disabled:opacity-50"
        >
          {working === "claimed" ? "Claiming…" : "Attach to a case"}
        </button>
        <button
          type="button"
          onClick={() => resolve("dismissed")}
          disabled={working !== null}
          className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-100 disabled:opacity-50"
        >
          {working === "dismissed" ? "Dismissing…" : "Dismiss"}
        </button>
      </span>
      {error ? (
        <span className="text-xs text-red-700" role="alert">
          Did not save — try again.
        </span>
      ) : null}
    </span>
  );
}
