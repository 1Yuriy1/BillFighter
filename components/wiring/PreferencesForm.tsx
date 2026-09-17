"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  NotificationLevelPicker,
  type NotificationLevel,
} from "@/components/notifications/NotificationLevelPicker";
import { PauseAllMessagesSwitch } from "@/components/notifications/PauseAllMessagesSwitch";

interface PreferencesFormProps {
  /** The saved notification level for this family. */
  level: NotificationLevel;
  /** Whether the crisis switch is currently on for this family. */
  paused: boolean;
  /**
   * Staff console usage: the family row being edited. Omitted on the
   * family's own dashboard (the API defaults to the session's own row).
   */
  targetUserId?: string;
}

/**
 * Wires the presentational notification controls to /api/preferences. State
 * stays at the saved value until the server confirms — no optimistic flips,
 * because the pause switch is a safety control and must reflect the truth.
 */
export function PreferencesForm({ level, paused, targetUserId }: PreferencesFormProps) {
  const router = useRouter();
  const [savedLevel, setSavedLevel] = useState(level);
  const [savedPaused, setSavedPaused] = useState(paused);
  const [error, setError] = useState(false);

  async function post(payload: { level?: NotificationLevel; paused?: boolean }) {
    setError(false);
    const response = await fetch("/api/preferences", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...payload, targetUserId }),
    });
    if (!response.ok) {
      setError(true);
      router.refresh();
      return;
    }
    const saved = (await response.json()) as {
      notificationLevel: NotificationLevel;
      pausedAt: string | null;
    };
    setSavedLevel(saved.notificationLevel);
    setSavedPaused(saved.pausedAt !== null);
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h3 className="text-sm font-semibold text-slate-900">Email me</h3>
        <p className="mb-2 text-sm text-slate-600">
          {savedLevel === "everything"
            ? "Every update, including when cases resolve."
            : "Only when something needs your action (resolved cases stay quiet)."}
        </p>
        <NotificationLevelPicker level={savedLevel} onChange={(next) => post({ level: next })} />
      </div>
      <div>
        <h3 className="text-sm font-semibold text-slate-900">Pause all automated messages</h3>
        <p className="mb-2 text-sm text-slate-600">
          For a crisis or a death in the family. Nothing automated goes out to anyone about this
          family until you turn this back on — letters already approved wait, un-sent.
        </p>
        <PauseAllMessagesSwitch paused={savedPaused} onToggle={(next) => post({ paused: next })} />
      </div>
      {error ? (
        <p className="text-sm text-red-700" role="alert">
          The change did not save — try again.
        </p>
      ) : null}
    </div>
  );
}
