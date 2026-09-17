import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CaseTimeline } from "./CaseTimeline";

const EVENTS = [
  {
    id: "e1",
    actor: "system" as const,
    message: "Bill from Riverwalk Imaging received.",
    createdAt: "2026-09-14T15:03:00Z",
  },
  {
    id: "e2",
    actor: "staff" as const,
    message: "Staff reviewer approved the appeal letter after checking the evidence.",
    createdAt: "2026-09-16T18:40:00Z",
  },
];

describe("CaseTimeline", () => {
  it("renders each event with an actor label and formatted time", () => {
    render(<CaseTimeline events={EVENTS} />);
    expect(screen.getAllByTestId("timeline-actor")).toHaveLength(2);
    expect(screen.getByText("System")).toBeInTheDocument();
    expect(screen.getByText("Our team")).toBeInTheDocument();
    expect(screen.getByText("Bill from Riverwalk Imaging received.")).toBeInTheDocument();
    expect(screen.getByText("Staff reviewer approved the appeal letter after checking the evidence.")).toBeInTheDocument();
    expect(screen.getByText("Sep 14, 2026, 3:03 PM")).toBeInTheDocument();
  });

  it("marks events up as a semantic list with machine-readable timestamps", () => {
    render(<CaseTimeline events={EVENTS} />);
    expect(screen.getByTestId("case-timeline")).toBeInTheDocument();
    expect(screen.getByText("Sep 16, 2026, 6:40 PM").closest("time")).toHaveAttribute(
      "datetime",
      "2026-09-16T18:40:00Z",
    );
  });

  it("shows a gentle empty state when nothing has happened yet", () => {
    render(<CaseTimeline events={[]} />);
    expect(
      screen.getByText(
        "Nothing has happened yet — updates will appear here as we work on your case.",
      ),
    ).toBeInTheDocument();
  });
});
