import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DraftReviewCard } from "./DraftReviewCard";

const CITATIONS = [
  {
    claim: "The emergency room administration fee of $349.00 appears twice on the same visit date.",
    documentLabel: "Itemized bill from Riverwalk Imaging, 2026-07-02",
    field: "line_items",
  },
  {
    claim: "The plan considers emergency services in network at 100% of allowed amount.",
    documentLabel: "Aetna plan documents, 2026",
    field: "notes",
  },
];

function renderCard(overrides = {}) {
  const onApprove = vi.fn();
  const onRequestChanges = vi.fn();
  const onDismiss = vi.fn();
  const result = render(
    <DraftReviewCard
      title="Expedited appeal to Aetna"
      recipient="Aetna appeals department"
      body="Dear Aetna, we are writing to appeal the denial of the MRI performed on July 2."
      citations={CITATIONS}
      status="draft"
      onApprove={onApprove}
      onRequestChanges={onRequestChanges}
      onDismiss={onDismiss}
      {...overrides}
    />,
  );
  return { onApprove, onRequestChanges, onDismiss, ...result };
}

describe("DraftReviewCard", () => {
  it("asks Ready to send — Approve? for a draft, per the approval flow", () => {
    renderCard();
    expect(screen.getByText("Ready to send — Approve?")).toBeInTheDocument();
  });

  it("uses the draft title as the heading once it is no longer a draft", () => {
    renderCard({ status: "sent" });
    expect(screen.getByText("Expedited appeal to Aetna")).toBeInTheDocument();
    expect(screen.getByText("This letter has been sent.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
  });

  it("lists an evidence slot for every citation: the claim and where it came from", () => {
    renderCard();
    const citations = screen.getByTestId("draft-citations");
    expect(citations).toHaveTextContent(
      "The emergency room administration fee of $349.00 appears twice on the same visit date.",
    );
    expect(citations).toHaveTextContent(
      "From: Itemized bill from Riverwalk Imaging, 2026-07-02 (line_items)",
    );
    expect(citations).toHaveTextContent("From: Aetna plan documents, 2026 (notes)");
  });

  it("shows a calm empty state when a draft has no citations", () => {
    renderCard({ citations: [] });
    expect(
      screen.getByText(
        "This draft has no cited evidence yet — our team will add it before approval.",
      ),
    ).toBeInTheDocument();
  });

  it("reflects the two-approval invariant (user + staff)", () => {
    renderCard({ userApproved: true, staffApproved: false });
    expect(screen.getByTestId("user-approval")).toHaveTextContent(/^Received/);
    expect(screen.getByTestId("staff-approval")).toHaveTextContent(/^Pending/);
  });

  it("calls onApprove when approved", async () => {
    const user = userEvent.setup();
    const { onApprove } = renderCard();
    await user.click(screen.getByRole("button", { name: "Approve" }));
    expect(onApprove).toHaveBeenCalledTimes(1);
  });

  it("calls onDismiss when dismissed", async () => {
    const user = userEvent.setup();
    const { onDismiss } = renderCard();
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("requests changes with a note typed into the panel", async () => {
    const user = userEvent.setup();
    const { onRequestChanges } = renderCard();
    await user.click(screen.getByRole("button", { name: "Request changes" }));
    expect(screen.getByTestId("change-request-panel")).toBeInTheDocument();
    await user.type(
      screen.getByLabelText("What should we change?"),
      "Please say which date the MRI was on.",
    );
    await user.click(screen.getByRole("button", { name: "Send change request" }));
    expect(onRequestChanges).toHaveBeenCalledWith("Please say which date the MRI was on.");
    expect(screen.queryByTestId("change-request-panel")).not.toBeInTheDocument();
  });

  it("trims the change-request note and clears the panel afterwards", async () => {
    const user = userEvent.setup();
    const { onRequestChanges } = renderCard();
    await user.click(screen.getByRole("button", { name: "Request changes" }));
    await user.type(screen.getByLabelText("What should we change?"), "  fix the date  ");
    await user.click(screen.getByRole("button", { name: "Send change request" }));
    expect(onRequestChanges).toHaveBeenCalledWith("fix the date");
  });

  it("can close the change-request panel without sending", async () => {
    const user = userEvent.setup();
    const { onRequestChanges } = renderCard();
    await user.click(screen.getByRole("button", { name: "Request changes" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onRequestChanges).not.toHaveBeenCalled();
    expect(screen.queryByTestId("change-request-panel")).not.toBeInTheDocument();
  });
});
