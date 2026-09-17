"use client";

// One source of truth with the scheduler: lib/followup/notifications.ts
// derives the type from the migration enum's values and carries the runtime
// guard the server side uses to parse stored preferences.
import type { NotificationLevel } from "@/lib/followup/notifications";

export type { NotificationLevel };

interface NotificationLevelPickerProps {
  /** Currently selected level (the family's saved preference). */
  level: NotificationLevel;
  /** Called with the newly chosen level. */
  onChange?: (level: NotificationLevel) => void;
  disabled?: boolean;
}

const OPTIONS: ReadonlyArray<{
  value: NotificationLevel;
  label: string;
  description: string;
}> = [
  {
    value: "everything",
    label: "Everything",
    description: "Every update about your case, big or small.",
  },
  {
    value: "action_needed",
    label: "Only what needs you",
    description: "Just the things that need your action, plus when a case is resolved.",
  },
];

/**
 * The per-family notification level from the spec ("everything" vs.
 * "action needed + resolved"), asked in plain language. Controlled and
 * presentational — the choice lives with the caller.
 */
export function NotificationLevelPicker({
  level,
  onChange,
  disabled,
}: NotificationLevelPickerProps) {
  return (
    <fieldset data-testid="notification-level-picker" className="flex flex-col gap-2">
      <legend className="text-sm font-semibold text-slate-900">
        How much should we email you?
      </legend>
      <div className="flex flex-col gap-2">
        {OPTIONS.map((option) => (
          <label
            key={option.value}
            className="flex items-start gap-2 rounded-md border border-slate-200 bg-white p-3"
          >
            <input
              type="radio"
              name="notification-level"
              value={option.value}
              checked={level === option.value}
              disabled={disabled}
              onChange={() => onChange?.(option.value)}
              className="mt-0.5"
            />
            <span>
              <span className="block text-sm font-medium text-slate-900">{option.label}</span>
              <span className="block text-sm text-slate-600">{option.description}</span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
