import { formatDateTime } from "@/lib/display";

export type TimelineActor = "agent" | "staff" | "user" | "system";

export interface CaseTimelineEvent {
  id: string;
  actor: TimelineActor;
  message: string;
  /** ISO timestamp of when the event happened. */
  createdAt: string;
}

const ACTOR_META: Record<TimelineActor, { label: string; chipClass: string }> = {
  agent: { label: "Assistant", chipClass: "bg-blue-100 text-blue-800" },
  staff: { label: "Our team", chipClass: "bg-teal-100 text-teal-800" },
  user: { label: "You", chipClass: "bg-slate-200 text-slate-700" },
  system: { label: "System", chipClass: "bg-gray-100 text-gray-600" },
};

interface CaseTimelineProps {
  /** Rendered top to bottom in the order given (newest last). */
  events: readonly CaseTimelineEvent[];
}

/**
 * The live case timeline: every action, reply, and status change as an events
 * feed (the `events` table's actor + message + created_at). Purely
 * presentational — all data arrives as props.
 */
export function CaseTimeline({ events }: CaseTimelineProps) {
  if (events.length === 0) {
    return (
      <p className="rounded-md border border-dashed border-slate-300 p-4 text-sm text-slate-600">
        Nothing has happened yet — updates will appear here as we work on your case.
      </p>
    );
  }

  return (
    <ol data-testid="case-timeline" className="space-y-4 border-l border-slate-200 pl-4">
      {events.map((event) => {
        const actor = ACTOR_META[event.actor];
        return (
          <li key={event.id} className="relative">
            <span
              aria-hidden="true"
              className="absolute -left-[21px] top-1.5 h-2.5 w-2.5 rounded-full border border-slate-300 bg-white"
            />
            <div className="flex flex-wrap items-center gap-2">
              <span
                data-testid="timeline-actor"
                className={`rounded-full px-2 py-0.5 text-xs font-medium ${actor.chipClass}`}
              >
                {actor.label}
              </span>
              <time dateTime={event.createdAt} className="text-xs text-slate-500">
                {formatDateTime(event.createdAt)}
              </time>
            </div>
            <p className="mt-1 text-sm text-slate-800">{event.message}</p>
          </li>
        );
      })}
    </ol>
  );
}
