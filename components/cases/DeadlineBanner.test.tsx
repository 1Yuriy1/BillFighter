import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DeadlineBanner } from "./DeadlineBanner";

const TODAY = "2026-09-17";

describe("DeadlineBanner", () => {
  it("renders nothing when there is no deadline", () => {
    const { container } = render(<DeadlineBanner deadline={null} today={TODAY} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when the deadline is more than 14 days out", () => {
    const { container } = render(<DeadlineBanner deadline="2026-10-15" today={TODAY} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("notifies gently at the 14-day boundary", () => {
    render(<DeadlineBanner deadline="2026-10-01" today={TODAY} />);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Your appeal deadline is in 14 days. You do not need to do anything — we are watching it for you.",
    );
  });

  it("still notifies at 6 days", () => {
    render(<DeadlineBanner deadline="2026-09-23" today={TODAY} />);
    expect(screen.getByRole("status")).toHaveTextContent(/in 6 days/);
  });

  it("says the team has stepped in at the 5-day escalation tier", () => {
    render(<DeadlineBanner deadline="2026-09-22" today={TODAY} />);
    expect(screen.getByRole("status")).toHaveTextContent(
      "The appeal deadline is in 5 days. Our team has stepped in and is handling it.",
    );
  });

  it("pins attention at the 2-day (48 hour) tier", () => {
    render(<DeadlineBanner deadline="2026-09-19" today={TODAY} />);
    expect(screen.getByRole("status")).toHaveTextContent(
      "The appeal deadline is in 2 days. This is at the top of our list right now — a person is on it.",
    );
  });

  it("uses singular phrasing for one day", () => {
    render(<DeadlineBanner deadline="2026-09-18" today={TODAY} />);
    expect(screen.getByRole("status")).toHaveTextContent(/in 1 day\./);
  });

  it("says a person is working on it once the deadline has passed", () => {
    render(<DeadlineBanner deadline="2026-09-10" today={TODAY} />);
    expect(screen.getByRole("status")).toHaveTextContent(
      "The appeal deadline has passed. A person on our team is working on this right now.",
    );
  });
});
