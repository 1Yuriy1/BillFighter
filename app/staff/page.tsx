import { redirect } from "next/navigation";
import { OrphanActions } from "@/components/wiring/OrphanActions";
import { PreferencesForm } from "@/components/wiring/PreferencesForm";
import { SavingsConfirmForm } from "@/components/wiring/SavingsConfirmForm";
import { SignOutButton } from "@/components/wiring/SignOutButton";
import { StaffApproveButton } from "@/components/wiring/StaffApproveButton";
import { StaffQueueTable, type StaffQueueEntry } from "@/components/staff/StaffQueueTable";
import { DraftReviewCard } from "@/components/actions/DraftReviewCard";
import { formatDateTime, sortUrgentFirst } from "@/lib/display";
import {
  staffConsoleData,
  staffDraftReviewRows,
  staffFamilyRows,
  staffSavingsRows,
} from "@/lib/db/queries";
import { withSessionClient } from "@/lib/db/connect";
import { currentClaims } from "@/lib/session-server";

const ORPHAN_PREFIX = "orphan-";

function orphanId(queueId: string): string {
  return queueId.slice(ORPHAN_PREFIX.length);
}

function OrphanSection({ entries }: { entries: StaffQueueEntry[] }) {
  if (entries.length === 0) {
    return (
      <p className="text-sm text-slate-500">
        No unmatched mail. Anything that arrives without a matching case address lands here instead
        of being dropped.
      </p>
    );
  }
  return (
    <ul className="flex flex-col gap-3">
      {sortUrgentFirst(entries).map((entry) => (
        <li
          key={entry.id}
          className="flex items-center justify-between gap-4 rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm"
        >
          <div className="min-w-0">
            <p className="text-sm font-medium text-slate-900">{entry.summary}</p>
            {entry.detail !== null && entry.detail !== undefined ? (
              <p className="mt-0.5 text-xs text-slate-600">{entry.detail}</p>
            ) : null}
            <p className="mt-0.5 text-xs text-slate-400">
              Received {formatDateTime(entry.updatedAt)}
            </p>
          </div>
          <OrphanActions orphanId={orphanId(entry.id)} />
        </li>
      ))}
    </ul>
  );
}

/** The staff console: review queue (urgent first) and per-family controls. */
export default async function StaffPage() {
  const claims = await currentClaims();
  if (claims === null) {
    redirect("/login");
  }
  if (claims.role !== "staff") {
    redirect("/dashboard");
  }

  const [queue, families, drafts, savings] = await withSessionClient(claims, async (client) => {
    const entries = await staffConsoleData(client);
    const familyRows = await staffFamilyRows(client);
    const draftRows = await staffDraftReviewRows(client);
    const savingsRows = await staffSavingsRows(client);
    return [entries, familyRows, draftRows, savingsRows] as const;
  });

  const orphans = queue.filter((entry) => entry.kind === "orphan_mail");
  const caseQueue = queue.filter((entry) => entry.kind !== "orphan_mail");

  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-slate-900">Staff console</h1>
          <p className="mt-1 text-sm text-slate-600">
            Everything that needs a human, urgent first.
          </p>
        </div>
        <SignOutButton />
      </header>

      <section className="mt-8">
        <h2 className="text-lg font-semibold text-slate-900">Review queue</h2>
        {caseQueue.length === 0 ? (
          <p className="mt-3 rounded-xl border border-dashed border-slate-300 bg-white px-4 py-10 text-center text-slate-600">
            Nothing waiting — no drafts to review, no low-confidence extractions, no failed sends,
            no stuck cases, and no deadline alerts.
          </p>
        ) : (
          <div className="mt-3">
            <StaffQueueTable entries={caseQueue} />
          </div>
        )}
      </section>

      <section className="mt-10">
        <h2 className="text-lg font-semibold text-slate-900">Drafts awaiting your signature</h2>
        <p className="mb-3 text-sm text-slate-600">
          The second signature of the two-human gate. Read the letter, check it against the cited
          documents, then sign — the family approves first or second, but nothing sends until both
          humans have signed.
        </p>
        {drafts.length === 0 ? (
          <p className="text-sm text-slate-500" data-testid="staff-drafts-empty">
            No drafts waiting on staff review.
          </p>
        ) : (
          <ul className="flex flex-col gap-5" data-testid="staff-draft-review-list">
            {drafts.map((draft) => (
              <li
                key={draft.id}
                className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
              >
                <p className="text-sm font-semibold text-slate-900">
                  {draft.caseLabel}
                  {draft.userApprovedAt !== null ? (
                    <span className="ml-2 rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800">
                      Family approved — waiting on you
                    </span>
                  ) : null}
                </p>
                <div className="mt-3">
                  <DraftReviewCard
                    title={draft.subject ?? `Letter via ${draft.caseLabel}`}
                    recipient={draft.recipient}
                    body={draft.body ?? ""}
                    citations={draft.citations}
                    status="draft"
                    userApproved={draft.userApprovedAt !== null}
                    staffApproved={false}
                  />
                </div>
                <div className="mt-3">
                  <StaffApproveButton actionId={draft.id} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-10">
        <h2 className="text-lg font-semibold text-slate-900">Savings to confirm</h2>
        <p className="mb-3 text-sm text-slate-600">
          Resolved cases waiting on the proof gate: attach the proof (a bill or EOB showing the
          corrected amount), confirm the savings, and the capped 15% success fee charges — $500
          maximum, nothing charged without proof.
        </p>
        {savings.length === 0 ? (
          <p className="text-sm text-slate-500" data-testid="staff-savings-empty">
            No resolved cases waiting on savings confirmation.
          </p>
        ) : (
          <ul className="flex flex-col gap-4" data-testid="staff-savings-list">
            {savings.map((caseRow) => (
              <li
                key={caseRow.caseId}
                className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
              >
                <p className="text-sm font-semibold text-slate-900">{caseRow.caseLabel}</p>
                <p className="mt-0.5 text-xs text-slate-600">
                  {caseRow.familyEmail}
                  {caseRow.amountDisputed !== null
                    ? ` — disputed amount $${caseRow.amountDisputed.toFixed(2)}`
                    : ""}
                </p>
                <SavingsConfirmForm caseRow={caseRow} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-10">
        <h2 className="text-lg font-semibold text-slate-900">Orphan mail</h2>
        <p className="mb-3 text-sm text-slate-600">
          Inbound email that matched no case address. Attach it to the right case or dismiss it — it
          never disappears silently.
        </p>
        <OrphanSection entries={orphans} />
      </section>

      <section className="mt-10">
        <h2 className="text-lg font-semibold text-slate-900">Family settings</h2>
        <p className="mb-3 text-sm text-slate-600">
          Per-family notification levels and the crisis pause. Pausing stops every automated message
          for that family immediately.
        </p>
        {families.length === 0 ? (
          <p className="text-sm text-slate-500">No families signed up yet.</p>
        ) : (
          <ul className="flex flex-col gap-4">
            {families.map((family) => (
              <li
                key={family.id}
                className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
              >
                <p className="text-sm font-semibold text-slate-900">{family.email}</p>
                <div className="mt-2">
                  <PreferencesForm
                    level={family.notificationLevel}
                    paused={family.pausedAt !== null}
                    targetUserId={family.id}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
