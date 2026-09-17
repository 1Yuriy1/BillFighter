import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { PauseAllMessagesSwitch } from "./PauseAllMessagesSwitch";

describe("PauseAllMessagesSwitch", () => {
  it("exposes a labeled switch reflecting the paused state", () => {
    render(<PauseAllMessagesSwitch paused={false} />);
    const toggle = screen.getByRole("switch", { name: "Pause all automated messages" });
    expect(toggle).toBeInTheDocument();
    expect(toggle).toHaveAttribute("aria-checked", "false");
  });

  it("marks the switch as checked when paused", () => {
    render(<PauseAllMessagesSwitch paused />);
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "true");
  });

  it("calls onToggle with the requested next state", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    render(<PauseAllMessagesSwitch paused={false} onToggle={onToggle} />);
    await user.click(screen.getByRole("switch"));
    expect(onToggle).toHaveBeenCalledWith(true);
  });

  it("explains that everything stops while paused", () => {
    render(<PauseAllMessagesSwitch paused />);
    expect(
      screen.getByText(
        /Automated messages are paused\. Nothing will go out until it is turned back on\./,
      ),
    ).toBeInTheDocument();
  });

  it("does not show the paused explanation while unpaused", () => {
    render(<PauseAllMessagesSwitch paused={false} />);
    expect(
      screen.queryByText(/Nothing will go out until it is turned back on\./),
    ).not.toBeInTheDocument();
  });

  it("does not call onToggle when disabled", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    render(<PauseAllMessagesSwitch paused={false} onToggle={onToggle} disabled />);
    await user.click(screen.getByRole("switch"));
    expect(onToggle).not.toHaveBeenCalled();
  });
});
