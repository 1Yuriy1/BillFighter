import type { CaseStatus } from "@/lib/caseState";
import { caseStatusBadgeClass, caseStatusLabel, formatDate, formatUsd } from "@/lib/display";
import { DeadlineBanner } from "./DeadlineBanner";

interface CaseCardProps {
  /** Human case name, e.g. "Aetna bill from Riverwalk Imaging". */
  title: string;
  status: CaseStatus;
  providerName?: string | null;
  insurerName?: string | null;
  /** Null renders as an em dash — an unknown amount is shown as absent, never guessed. */
  amountDisputed: number | null;
  amountSaved: number | null;
  /** ISO date or timestamp; null when the case has no known deadline. */
  nextDeadline: string | null;
  /** Injectable clock (ISO date) for deterministic tests and previews. */
  today?: string;
  /** When set, the whole card links to the case. */
  href?: string;
}

/**
 * A case summary card for the user dashboard: status badge, disputed/saved
 * amounts, next deadline, and the deadline banner when a deadline is near.
 * Purely presentational — all data arrives as props.
 */
export function CaseCard({
  title,
  status,
  providerName,
  insurerName,
  amountDisputed,
  amountSaved,
  nextDeadline,
  today,
  href,
}: CaseCardProps) {
  const who = [providerName, insurerName].filter(Boolean).join(" · ");
  const body = (
    <article className="flex h-full flex-col gap-3 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-slate-900">{title}</h3>
          {who.length > 0 ? <p className="text-sm text-slate-600">{who}</p> : null}
        </div>
        <span
          data-testid="case-status-badge"
          className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium ${caseStatusBadgeClass(status)}`}
        >
          {caseStatusLabel(status)}
        </span>
      </header>

      <dl className="grid grid-cols-2 gap-2 text-sm">
        <div>
          <dt className="text-slate-500">Amount in dispute</dt>
          <dd data-testid="amount-disputed" className="font-medium text-slate-900">
            {formatUsd(amountDisputed)}
          </dd>
        </div>
        <div>
          <dt className="text-slate-500">Saved so far</dt>
          <dd data-testid="amount-saved" className="font-medium text-green-700">
            {formatUsd(amountSaved)}
          </dd>
        </div>
      </dl>

      {nextDeadline !== null ? (
        <p className="text-sm text-slate-600">
          Next deadline: <span data-testid="next-deadline">{formatDate(nextDeadline)}</span>
        </p>
      ) : null}

      <div className="mt-auto">
        <DeadlineBanner deadline={nextDeadline} today={today} />
      </div>
    </article>
  );

  return href ? (
    <a href={href} className="block transition-shadow hover:shadow-md">
      {body}
    </a>
  ) : (
    body
  );
}
