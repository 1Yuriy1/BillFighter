"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { CaregiverGrantView } from "@/lib/db/queries";

/**
 * The family's delegated-access panel: invite a caregiver by email, see the
 * grants currently handed out, revoke. The server resolves the email and
 * RLS scopes every write; this component only renders what the family's own
 * session returned.
 */
export function CaregiverAccess({ grants }: { grants: CaregiverGrantView[] }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [invited, setInvited] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  async function invite() {
    setWorking(true);
    setError(null);
    setInvited(null);
    try {
      const response = await fetch("/api/caregivers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ caregiverEmail: email }),
      });
      if (response.ok) {
        setInvited(email.trim());
        setEmail("");
        router.refresh();
      } else {
        const body = (await response.json()) as { error?: string };
        setError(
          body.error === "no_registered_user_with_that_email"
            ? "No BillFighter account uses that email yet."
            : "Could not add that caregiver — check the address and try again.",
        );
      }
    } catch {
      setError("Could not add that caregiver — try again.");
    } finally {
      setWorking(false);
    }
  }

  async function revoke(grantId: string) {
    setWorking(true);
    setError(null);
    try {
      const response = await fetch(`/api/caregivers?id=${encodeURIComponent(grantId)}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        setError("Could not revoke access — try again.");
      }
      router.refresh();
    } catch {
      setError("Could not revoke access — try again.");
    } finally {
      setWorking(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <label htmlFor="caregiver-email" className="text-sm font-semibold text-slate-900">
          Give someone you trust access
        </label>
        <p className="mb-2 text-sm text-slate-600">
          A caregiver (a spouse, an adult child, a social worker) sees your cases and can approve
          letters with you. They must already have a BillFighter account.
        </p>
        <div className="flex items-center gap-2">
          <input
            id="caregiver-email"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="caregiver@example.com"
            className="w-64 rounded-lg border border-slate-300 px-3 py-2 text-sm"
          />
          <button
            type="button"
            onClick={invite}
            disabled={working || !email.includes("@")}
            className="rounded-lg bg-slate-800 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-900 disabled:opacity-50"
          >
            {working ? "Working…" : "Add access"}
          </button>
        </div>
        {invited !== null ? (
          <p className="mt-2 text-sm text-green-700" role="status">
            {invited} can now see your cases.
          </p>
        ) : null}
      </div>

      {grants.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {grants.map((grant) => (
            <li
              key={grant.id}
              className="flex items-center justify-between rounded-lg bg-slate-100 px-3 py-2 text-sm"
            >
              <span>{grant.caregiverEmail}</span>
              <button
                type="button"
                onClick={() => revoke(grant.id)}
                disabled={working}
                className="text-red-700 underline hover:no-underline disabled:opacity-50"
              >
                Remove access
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-slate-500">Nobody else has access to your cases.</p>
      )}

      {error !== null ? (
        <p className="text-sm text-red-700" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
