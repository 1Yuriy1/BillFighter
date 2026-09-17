import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { NotificationLevelPicker } from "./NotificationLevelPicker";

describe("NotificationLevelPicker", () => {
  it("offers the two spec levels in plain language", () => {
    render(<NotificationLevelPicker level="everything" />);
    expect(screen.getByText("How much should we email you?")).toBeInTheDocument();
    // The accessible name aggregates the label + its description, so match by prefix.
    expect(screen.getByRole("radio", { name: /Everything/ })).toBeInTheDocument();
    expect(
      screen.getByRole("radio", { name: /Only what needs you/ }),
    ).toBeInTheDocument();
    expect(screen.getByText(/plus when a case is resolved/)).toBeInTheDocument();
  });

  it("reflects the currently saved level", () => {
    render(<NotificationLevelPicker level="action_needed" />);
    expect(screen.getByRole("radio", { name: /Everything/ })).not.toBeChecked();
    expect(screen.getByRole("radio", { name: /Only what needs you/ })).toBeChecked();
  });

  it("calls onChange with the newly chosen level", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<NotificationLevelPicker level="everything" onChange={onChange} />);
    await user.click(screen.getByRole("radio", { name: /Only what needs you/ }));
    expect(onChange).toHaveBeenCalledWith("action_needed");
  });

  it("disables the radios when disabled", () => {
    render(<NotificationLevelPicker level="everything" disabled />);
    expect(screen.getByRole("radio", { name: /Everything/ })).toBeDisabled();
    expect(screen.getByRole("radio", { name: /Only what needs you/ })).toBeDisabled();
  });
});
