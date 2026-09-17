import { redirect } from "next/navigation";
import { CaregiverAccess } from "@/components/wiring/CaregiverAccess";
import { ApproveDraftButton } from "@/components/wiring/ApproveDraftButton";
import { PreferencesForm } from "@/components/wiring/PreferencesForm";
import { SignOutButton } from "@/components/wiring/SignOutButton";
import { DraftReviewCard } from "@/components/actions/DraftReviewCard";
import { CaseCard } from "@/components/cases/CaseCard";
import { CaseTimeline } from "@/components/cases/CaseTimeline";
import { DeadlineBanner } from "@/components/cases/DeadlineBanner";
import { familyDashboardData, type FamilyCaseView } from "@/lib/db/queries";
import { withSessionClient } from "@/lib/db/connect";
import { currentClaims } from "@/lib/session-server";
import { formatDate } from "@/lib/display";

function CaseSection({ caseView }: { caseView: FamilyCaseView }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <CaseCard
        title={caseView.title}
        status={caseView.status}
        providerName={caseView.providerName}
        insurerName={caseView.insurerName}
        amountDisputed={caseView.amountDisputed}
        amountSaved={caseView.amountSaved}
        nextDeadline={caseView.nextDeadline}
      />
      {caseView.nextDeadline !== null ? (
        <div className="mt-3">
          <DeadlineBanner deadline={caseView.nextDeadline} />
        </div>
      ) : null}

      {caseView.drafts.length > 0 ? (
        <div className="mt-5 flex flex-col gap-4">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
            Letters waiting for review
          </h3>
          {caseView.drafts.map((draft) => (
            <div key={draft.id} className="flex flex-col gap-2">
              <DraftReviewCard
                title={draft.title}
                recipient={draft.recipient}
                body={draft.body}
                citations={draft.citations}
                status={draft.status}
                userApproved={draft.userApproved}
                staffApproved={draft.staffApproved}
              />
              {draft.status === "draft" && !draft.userApproved ? (
                <ApproveDraftButton actionId={draft.id} />
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      <div className="mt-5">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          What has happened
        </h3>
        <CaseTimeline events={caseView.events} />
      </div>
    </section>
  );
}

/** The family's own console: their cases, drafts, preferences, and grants. */
export default async function DashboardPage() {
  const claims = await currentClaims();
  if (claims === null) {
    redirect("/login");
  }
  if (claims.role === "staff") {
    redirect("/staff");
  }

  const dashboard = await withSessionClient(claims, familyDashboardData);
  if (dashboard === null) {
    // Session names a user with no profile row — treat as signed out rather
    // than rendering a half-empty dashboard.
    redirect("/login");
  }

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-slate-900">
            {dashboard.fullName ?? "Your cases"}
          </h1>
          <p className="mt-1 text-sm text-slate-600">{dashboard.email}</p>
        </div>
        <SignOutButton />
      </header>

      {dashboard.pausedAt !== null ? (
        <p
          className="mt-6 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900"
          role="status"
        >
          All automated messages are paused {formatDate(dashboard.pausedAt)} — nothing goes out
          until you turn them back on below.
        </p>
      ) : null}

      {dashboard.caregiverFor.length > 0 ? (
        <p
          className="mt-6 rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900"
          role="status"
        >
          You help manage the cases of:{" "}
          {dashboard.caregiverFor.map((family) => family.familyEmail).join(", ")}
        </p>
      ) : null}

      {dashboard.cases.length === 0 ? (
        <p className="mt-8 rounded-xl border border-dashed border-slate-300 bg-white px-4 py-10 text-center text-slate-600">
          No cases yet. Once a bill or letter arrives by email, it shows up here with a
          plain-language explanation.
        </p>
      ) : (
        <div className="mt-8 flex flex-col gap-6">
          {dashboard.cases.map((caseView) => (
            <CaseSection key={caseView.id} caseView={caseView} />
          ))}
        </div>
      )}

      <section className="mt-10 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-lg font-semibold text-slate-900">Notifications</h2>
        <div className="mt-3">
          <PreferencesForm
            level={dashboard.notificationLevel}
            paused={dashboard.pausedAt !== null}
          />
        </div>
      </section>

      <section className="mt-6 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-lg font-semibold text-slate-900">Shared access</h2>
        <div className="mt-3">
          <CaregiverAccess grants={dashboard.caregiverGrants} />
        </div>
      </section>
    </main>
  );
}
