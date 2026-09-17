"use client";

import { useId, useState } from "react";

/** The `actions.status` enum from the schema. */
export type DraftStatus = "draft" | "approved" | "sent" | "failed" | "superseded";

/**
 * One evidence slot: a factual claim in the letter traced to the document
 * field it came from (the `actions.citations` traceability invariant).
 */
export interface DraftCitation {
  claim: string;
  /** Human label of the source document, e.g. "EOB from Aetna, 2026-08-14". */
  documentLabel: string;
  /** The extracted field backing the claim, e.g. "denial_reason". */
  field: string;
}

export interface DraftReviewCardProps {
  title: string;
  recipient?: string | null;
  /** The letter body as drafted. */
  body: string;
  citations: readonly DraftCitation[];
  status: DraftStatus;
  /** First of the two required approvals (Phase 1: user + staff). */
  userApproved?: boolean;
  /** Second of the two required approvals. */
  staffApproved?: boolean;
  onApprove?: () => void;
  /** Called with the trimmed note when a change is requested. */
  onRequestChanges?: (note: string) => void;
  onDismiss?: () => void;
}

const STATUS_META: Record<DraftStatus, { label: string; chipClass: string; note: string }> = {
  draft: {
    label: "Ready to send",
    chipClass: "bg-amber-100 text-amber-800",
    note: "Nothing gets sent until both you and our team approve.",
  },
  approved: {
    label: "Approved",
    chipClass: "bg-green-100 text-green-800",
    note: "Approved — there is nothing more for you to do here.",
  },
  sent: {
    label: "Sent",
    chipClass: "bg-blue-100 text-blue-800",
    note: "This letter has been sent.",
  },
  failed: {
    label: "Sending failed",
    chipClass: "bg-rose-100 text-rose-800",
    note: "Sending failed — our team will try again shortly.",
  },
  superseded: {
    label: "Replaced",
    chipClass: "bg-gray-100 text-gray-600",
    note: "This draft was replaced by a newer version.",
  },
};

/**
 * The draft-review card from the spec's approval flow: the letter, the
 * evidence behind every claim, both approval slots, and the three options —
 * approve, request changes, or dismiss. Purely presentational: every behavior
 * arrives as a callback prop.
 */
export function DraftReviewCard({
  title,
  recipient,
  body,
  citations,
  status,
  userApproved = false,
  staffApproved = false,
  onApprove,
  onRequestChanges,
  onDismiss,
}: DraftReviewCardProps) {
  const meta = STATUS_META[status];
  const isDraft = status === "draft";
  const [panelOpen, setPanelOpen] = useState(false);
  const [note, setNote] = useState("");
  const noteId = useId();

  const submitChangeRequest = () => {
    onRequestChanges?.(note.trim());
    setNote("");
    setPanelOpen(false);
  };

  return (
    <article
      data-testid="draft-review-card"
      className="flex flex-col gap-4 rounded-lg border border-slate-200 bg-white p-4 shadow-sm"
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-slate-900">
            {isDraft ? "Ready to send — Approve?" : title}
          </h3>
          {recipient ? <p className="text-sm text-slate-600">To: {recipient}</p> : null}
        </div>
        <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${meta.chipClass}`}>
          {meta.label}
        </span>
      </header>

      <p className="text-sm text-slate-700">{body}</p>

      <section aria-label="Evidence">
        <h4 className="text-sm font-semibold text-slate-900">Why we said this</h4>
        {citations.length === 0 ? (
          <p className="mt-1 text-sm text-slate-600">
            This draft has no cited evidence yet — our team will add it before approval.
          </p>
        ) : (
          <ul data-testid="draft-citations" className="mt-2 space-y-2">
            {citations.map((citation) => (
              <li
                key={citation.claim}
                className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2"
              >
                <p className="text-sm text-slate-800">{citation.claim}</p>
                <p className="mt-0.5 text-xs text-slate-500">
                  From: {citation.documentLabel} ({citation.field})
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="Approvals">
        <h4 className="text-sm font-semibold text-slate-900">Approvals</h4>
        <ul className="mt-1 space-y-1 text-sm text-slate-700">
          <li data-testid="user-approval">{userApproved ? "Received" : "Pending"} — your approval</li>
          <li data-testid="staff-approval">
            {staffApproved ? "Received" : "Pending"} — staff approval
          </li>
        </ul>
        <p className="mt-2 text-xs text-slate-500">{meta.note}</p>
      </section>

      {isDraft ? (
        <footer className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => onApprove?.()}
            className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700"
          >
            Approve
          </button>
          <button
            type="button"
            onClick={() => setPanelOpen((open) => !open)}
            aria-expanded={panelOpen}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Request changes
          </button>
          <button
            type="button"
            onClick={() => onDismiss?.()}
            className="rounded-md px-3 py-1.5 text-sm font-medium text-slate-500 hover:bg-slate-50"
          >
            Dismiss
          </button>
        </footer>
      ) : null}

      {panelOpen ? (
        <div data-testid="change-request-panel" className="flex flex-col gap-2">
          <label htmlFor={noteId} className="text-sm font-medium text-slate-900">
            What should we change?
          </label>
          <textarea
            id={noteId}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="Tell us in your own words — there is no wrong way to say it."
            rows={3}
            className="rounded-md border border-slate-300 p-2 text-sm"
          />
          <div className="flex gap-2">
            <button
              type="button"
              onClick={submitChangeRequest}
              className="rounded-md bg-slate-800 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-900"
            >
              Send change request
            </button>
            <button
              type="button"
              onClick={() => setPanelOpen(false)}
              className="rounded-md px-3 py-1.5 text-sm font-medium text-slate-500 hover:bg-slate-50"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </article>
  );
}
