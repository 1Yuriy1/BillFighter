import { formatDateTime, sortUrgentFirst } from "@/lib/display";

export type StaffQueueKind =
  "draft_review" | "low_confidence" | "failed_send" | "stuck" | "deadline" | "orphan_mail";

export interface StaffQueueEntry {
  id: string;
  /** Human case name, e.g. "Aetna bill from Riverwalk Imaging". */
  caseLabel: string;
  /** One-line summary of what needs attention. */
  summary: string;
  /** Optional detail line, e.g. the error attached to a failed send. */
  detail?: string | null;
  kind: StaffQueueKind;
  /** Urgent entries pin to the top of the queue (spec: urgent first). */
  urgent?: boolean;
  /** ISO timestamp of the last update. */
  updatedAt: string;
  href?: string;
}

const KIND_META: Record<StaffQueueKind, { label: string; chipClass: string }> = {
  draft_review: { label: "Draft needs review", chipClass: "bg-amber-100 text-amber-800" },
  low_confidence: {
    label: "Low-confidence extraction",
    chipClass: "bg-orange-100 text-orange-800",
  },
  failed_send: { label: "Send failed", chipClass: "bg-rose-100 text-rose-800" },
  stuck: { label: "Stuck case", chipClass: "bg-gray-100 text-gray-700" },
  deadline: { label: "Deadline alert", chipClass: "bg-blue-100 text-blue-800" },
  orphan_mail: { label: "Orphan mail", chipClass: "bg-violet-100 text-violet-800" },
};

interface StaffQueueTableProps {
  /** The queue as queried; the component applies the urgent-first ordering. */
  entries: readonly StaffQueueEntry[];
}

/**
 * The staff console review queue: drafts to review, low-confidence
 * extractions, stuck cases, failed sends (with the error attached), and
 * deadline alerts — urgent entries always pinned to the top. Purely
 * presentational; the urgent-first sort is a pure function from lib/display.
 */
export function StaffQueueTable({ entries }: StaffQueueTableProps) {
  const sorted = sortUrgentFirst(entries);

  if (sorted.length === 0) {
    return (
      <p
        data-testid="staff-queue-empty"
        className="rounded-md border border-dashed border-slate-300 p-4 text-sm text-slate-600"
      >
        Nothing needs review right now.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <caption className="sr-only">Staff review queue, urgent cases first</caption>
        <thead>
          <tr className="border-b border-slate-200 text-left text-slate-600">
            <th scope="col" className="px-3 py-2 font-medium">
              Case
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              What needs review
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Updated
            </th>
            <th scope="col" className="px-3 py-2">
              <span className="sr-only">Open</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((entry) => {
            const kind = KIND_META[entry.kind];
            return (
              <tr
                key={entry.id}
                data-testid="staff-queue-row"
                className={entry.urgent ? "bg-rose-50" : undefined}
              >
                <td className="px-3 py-3 align-top font-medium text-slate-900">
                  {entry.caseLabel}
                  {entry.urgent ? (
                    <span className="ml-2 rounded-full bg-rose-600 px-2 py-0.5 text-xs font-medium text-white">
                      Urgent
                    </span>
                  ) : null}
                </td>
                <td className="px-3 py-3 align-top">
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${kind.chipClass}`}
                  >
                    {kind.label}
                  </span>
                  <p className="mt-1 text-slate-800">{entry.summary}</p>
                  {entry.detail ? (
                    <p className="mt-0.5 text-xs text-slate-500">{entry.detail}</p>
                  ) : null}
                </td>
                <td className="px-3 py-3 align-top text-slate-600">
                  <time dateTime={entry.updatedAt}>{formatDateTime(entry.updatedAt)}</time>
                </td>
                <td className="px-3 py-3 align-top text-right">
                  {entry.href ? (
                    <a
                      href={entry.href}
                      className="rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                    >
                      Open
                    </a>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
