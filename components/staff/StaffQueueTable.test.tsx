import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StaffQueueTable } from "./StaffQueueTable";

const ENTRIES = [
  {
    id: "q1",
    caseLabel: "Aetna bill from Riverwalk Imaging",
    summary: "Duplicate-charge appeal awaiting staff sign-off.",
    kind: "draft_review" as const,
    updatedAt: "2026-09-16T18:40:00Z",
    href: "/staff/cases/1",
  },
  {
    id: "q2",
    caseLabel: "Aetna denial — MRI",
    summary: "Appeal deadline in 2 days with no appeal drafted yet.",
    kind: "deadline" as const,
    urgent: true,
    updatedAt: "2026-09-17T08:15:00Z",
  },
  {
    id: "q3",
    caseLabel: "United bill from Lakeside Ortho",
    summary: "Letter to Lakeside billing failed to send three times.",
    detail: "SMTP 554: delivery permanently failed",
    kind: "failed_send" as const,
    updatedAt: "2026-09-14T16:22:00Z",
  },
];

describe("StaffQueueTable", () => {
  it("pins urgent entries to the top regardless of input order", () => {
    render(<StaffQueueTable entries={ENTRIES} />);
    const rows = screen.getAllByTestId("staff-queue-row");
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent("Aetna denial — MRI");
    expect(rows[1]).toHaveTextContent("Aetna bill from Riverwalk Imaging");
    expect(rows[2]).toHaveTextContent("United bill from Lakeside Ortho");
  });

  it("marks urgent rows with an Urgent badge and a kind label for every row", () => {
    render(<StaffQueueTable entries={ENTRIES} />);
    expect(screen.getByText("Urgent")).toBeInTheDocument();
    expect(screen.getByText("Draft needs review")).toBeInTheDocument();
    expect(screen.getByText("Deadline alert")).toBeInTheDocument();
    expect(screen.getByText("Send failed")).toBeInTheDocument();
  });

  it("shows the error attached to a failed send", () => {
    render(<StaffQueueTable entries={ENTRIES} />);
    expect(screen.getByText("SMTP 554: delivery permanently failed")).toBeInTheDocument();
  });

  it("links to the case when href is given", () => {
    render(<StaffQueueTable entries={ENTRIES} />);
    expect(screen.getAllByRole("link", { name: "Open" })).toHaveLength(1);
  });

  it("shows a calm empty state when the queue is clear", () => {
    render(<StaffQueueTable entries={[]} />);
    expect(screen.getByTestId("staff-queue-empty")).toHaveTextContent(
      "Nothing needs review right now.",
    );
  });
});
