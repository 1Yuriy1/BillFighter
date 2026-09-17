"use client";

import { useState } from "react";
import { CaseCard } from "@/components/cases/CaseCard";
import { CaseTimeline, type CaseTimelineEvent } from "@/components/cases/CaseTimeline";
import { DeadlineBanner } from "@/components/cases/DeadlineBanner";
import { DraftReviewCard, type DraftCitation } from "@/components/actions/DraftReviewCard";
import { StaffQueueTable, type StaffQueueEntry } from "@/components/staff/StaffQueueTable";
import {
  NotificationLevelPicker,
  type NotificationLevel,
} from "@/components/notifications/NotificationLevelPicker";
import { PauseAllMessagesSwitch } from "@/components/notifications/PauseAllMessagesSwitch";

/**
 * Fixture-driven demo of every presentational component. No backend — every
 * value below is synthetic so this page doubles as the visual verification
 * surface for the component library.
 */

const DEMO_TODAY = "2026-09-17";

const TIMELINE_EVENTS: CaseTimelineEvent[] = [
  {
    id: "e1",
    actor: "system",
    message: "Bill from Riverwalk Imaging received.",
    createdAt: "2026-09-14T15:03:00Z",
  },
  {
    id: "e2",
    actor: "agent",
    message:
      "We found the ER administration charge was billed twice. A draft appeal is ready for your review.",
    createdAt: "2026-09-15T09:12:00Z",
  },
  {
    id: "e3",
    actor: "staff",
    message: "Staff reviewer approved the appeal letter after checking the evidence.",
    createdAt: "2026-09-16T18:40:00Z",
  },
];

const DRAFT_CITATIONS: DraftCitation[] = [
  {
    claim: "The emergency room administration fee of $349.00 appears twice on the same visit date.",
    documentLabel: "Itemized bill from Riverwalk Imaging, 2026-07-02",
    field: "line_items",
  },
  {
    claim: "The plan considers emergency services in network at 100% of allowed amount.",
    documentLabel: "Aetna plan documents, 2026",
    field: "notes",
  },
];

const QUEUE_ENTRIES: StaffQueueEntry[] = [
  {
    id: "q1",
    caseLabel: "Aetna denial — MRI",
    summary: "Appeal deadline in 2 days with no appeal drafted yet.",
    kind: "deadline",
    urgent: true,
    updatedAt: "2026-09-17T08:15:00Z",
    href: "#",
  },
  {
    id: "q2",
    caseLabel: "Aetna bill from Riverwalk Imaging",
    summary: "Duplicate-charge appeal awaiting staff sign-off.",
    kind: "draft_review",
    updatedAt: "2026-09-16T18:40:00Z",
    href: "#",
  },
  {
    id: "q3",
    caseLabel: "BlueCross EOB — lab panel",
    summary: "Extraction confidence is low on the second page; needs a human read.",
    kind: "low_confidence",
    updatedAt: "2026-09-15T11:05:00Z",
    href: "#",
  },
  {
    id: "q4",
    caseLabel: "United bill from Lakeside Ortho",
    summary: "Letter to Lakeside billing failed to send three times.",
    detail: "SMTP 554: delivery permanently failed",
    kind: "failed_send",
    updatedAt: "2026-09-14T16:22:00Z",
    href: "#",
  },
];

export default function PreviewPage() {
  const [level, setLevel] = useState<NotificationLevel>("everything");
  const [paused, setPaused] = useState(false);
  const [userApproved, setUserApproved] = useState(false);

  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <h1 className="text-xl font-semibold text-slate-900">Component preview</h1>
      <p className="mt-1 text-sm text-slate-600">
        Fixture data only — every component renders in isolation from props.
      </p>

      <section className="mt-8 flex flex-col gap-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Cases</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <CaseCard
            title="Aetna bill from Riverwalk Imaging"
            status="awaiting_approval"
            providerName="Riverwalk Imaging"
            insurerName="Aetna"
            amountDisputed={1249.5}
            amountSaved={418.0}
            nextDeadline="2026-09-19"
            today={DEMO_TODAY}
            href="#"
          />
          <CaseCard
            title="BlueCross EOB — lab panel"
            status="waiting_reply"
            providerName="Lakeside Labs"
            insurerName="BlueCross"
            amountDisputed={268.75}
            amountSaved={null}
            nextDeadline="2026-10-30"
            today={DEMO_TODAY}
          />
        </div>
      </section>

      <section className="mt-8">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          Deadline banner
        </h2>
        <div className="mt-3 flex flex-col gap-3">
          <DeadlineBanner deadline="2026-10-01" today={DEMO_TODAY} />
          <DeadlineBanner deadline="2026-09-20" today={DEMO_TODAY} />
          <DeadlineBanner deadline="2026-09-18" today={DEMO_TODAY} />
          <DeadlineBanner deadline="2026-09-10" today={DEMO_TODAY} />
        </div>
      </section>

      <section className="mt-8">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          Draft review
        </h2>
        <div className="mt-3">
          <DraftReviewCard
            title="Expedited appeal to Aetna"
            recipient="Aetna appeals department"
            body="Dear Aetna, we are writing to appeal the denial of the MRI performed on July 2. The duplicate emergency room administration charge has been corrected by the provider, and the plan documents confirm the remaining balance should be covered."
            citations={DRAFT_CITATIONS}
            status="draft"
            userApproved={userApproved}
            staffApproved
            onApprove={() => setUserApproved(true)}
            onRequestChanges={() => {}}
            onDismiss={() => {}}
          />
        </div>
      </section>

      <section className="mt-8">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          Case timeline
        </h2>
        <div className="mt-3">
          <CaseTimeline events={TIMELINE_EVENTS} />
        </div>
      </section>

      <section className="mt-8">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          Staff queue
        </h2>
        <div className="mt-3">
          <StaffQueueTable entries={QUEUE_ENTRIES} />
        </div>
      </section>

      <section className="mt-8 flex flex-col gap-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          Notification settings
        </h2>
        <NotificationLevelPicker level={level} onChange={setLevel} />
        <PauseAllMessagesSwitch paused={paused} onToggle={setPaused} />
      </section>
    </main>
  );
}
