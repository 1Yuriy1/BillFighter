"use client";

import { useId } from "react";

interface PauseAllMessagesSwitchProps {
  /** Whether all automated messages are currently paused for this family. */
  paused: boolean;
  /** Called with the requested next state. */
  onToggle?: (paused: boolean) => void;
  disabled?: boolean;
}

/**
 * The spec's crisis switch: staff can pause ALL automated messages for a
 * family (e.g. after a death or crisis) so nothing goes out until it is
 * turned back on. Controlled and presentational — the state lives with the
 * caller.
 */
export function PauseAllMessagesSwitch({
  paused,
  onToggle,
  disabled,
}: PauseAllMessagesSwitchProps) {
  const labelId = useId();
  const helpId = useId();

  return (
    <div className="flex items-center justify-between gap-4 rounded-lg border border-slate-200 bg-white p-4">
      <div>
        <p id={labelId} className="text-sm font-semibold text-slate-900">
          Pause all automated messages
        </p>
        <p id={helpId} className="mt-0.5 text-sm text-slate-600">
          For hard moments — everything stops right away, and you can turn it back on any time.
          {paused
            ? " Automated messages are paused. Nothing will go out until it is turned back on."
            : ""}
        </p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={paused}
        aria-labelledby={labelId}
        aria-describedby={helpId}
        disabled={disabled}
        onClick={() => onToggle?.(!paused)}
        data-testid="pause-messages-switch"
        className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
          paused ? "bg-rose-600" : "bg-slate-300"
        } ${disabled ? "opacity-50" : ""}`}
      >
        <span
          aria-hidden="true"
          className={`absolute top-1 h-4 w-4 rounded-full bg-white transition-transform ${
            paused ? "left-6" : "left-1"
          }`}
        />
      </button>
    </div>
  );
}
