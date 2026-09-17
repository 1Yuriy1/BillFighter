import { daysPhrase, daysUntil, deadlineTier, type DeadlineTier } from "@/lib/display";

interface DeadlineBannerProps {
  /** Next deadline as an ISO date or timestamp; null means no known deadline. */
  deadline: string | null;
  /**
   * Today as an ISO date. Defaults to the real clock; inject it in tests and
   * previews so the banner is deterministic.
   */
  today?: string;
}

const TONE_CLASS: Record<Exclude<DeadlineTier, "none">, string> = {
  notify: "border-blue-200 bg-blue-50 text-blue-900",
  escalate: "border-amber-300 bg-amber-50 text-amber-900",
  urgent: "border-rose-300 bg-rose-50 text-rose-900",
};

function bannerMessage(tier: Exclude<DeadlineTier, "none">, daysLeft: number): string {
  if (daysLeft < 0) {
    return "The appeal deadline has passed. A person on our team is working on this right now.";
  }
  switch (tier) {
    case "notify":
      return `Your appeal deadline is in ${daysPhrase(daysLeft)}. You do not need to do anything — we are watching it for you.`;
    case "escalate":
      return `The appeal deadline is in ${daysPhrase(daysLeft)}. Our team has stepped in and is handling it.`;
    case "urgent":
      return `The appeal deadline is in ${daysPhrase(daysLeft)}. This is at the top of our list right now — a person is on it.`;
  }
}

/**
 * The 14 / 5 / 2-day deadline tiers from the spec: gentle notice at 14 days,
 * a staff-escalation note at 5, and a prominent "a person is on it" banner at
 * 2 days (48 hours) or overdue. Renders nothing when there is no deadline or
 * it is more than 14 days out.
 */
export function DeadlineBanner({ deadline, today }: DeadlineBannerProps) {
  if (deadline === null) {
    return null;
  }
  const daysLeft = daysUntil(deadline, today ?? new Date().toISOString());
  const tier = deadlineTier(daysLeft);
  if (tier === "none") {
    return null;
  }
  return (
    <p
      role="status"
      data-testid="deadline-banner"
      className={`rounded-md border px-3 py-2 text-sm ${TONE_CLASS[tier]}`}
    >
      {bannerMessage(tier, daysLeft)}
    </p>
  );
}
