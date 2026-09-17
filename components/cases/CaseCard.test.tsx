import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CaseCard } from "./CaseCard";

const TODAY = "2026-09-17";

describe("CaseCard", () => {
  it("renders title, plain-language status, and formatted amounts", () => {
    render(
      <CaseCard
        title="Aetna bill from Riverwalk Imaging"
        status="awaiting_approval"
        amountDisputed={1249.5}
        amountSaved={418}
        nextDeadline={null}
      />,
    );
    expect(screen.getByText("Aetna bill from Riverwalk Imaging")).toBeInTheDocument();
    expect(screen.getByTestId("case-status-badge")).toHaveTextContent(
      "Waiting for your approval",
    );
    expect(screen.getByTestId("amount-disputed")).toHaveTextContent("$1,249.50");
    expect(screen.getByTestId("amount-saved")).toHaveTextContent("$418.00");
  });

  it("shows an em dash for unknown amounts instead of guessing", () => {
    render(
      <CaseCard
        title="BlueCross EOB — lab panel"
        status="waiting_reply"
        amountDisputed={268.75}
        amountSaved={null}
        nextDeadline={null}
      />,
    );
    expect(screen.getByTestId("amount-saved")).toHaveTextContent("—");
  });

  it("shows provider and insurer when given", () => {
    render(
      <CaseCard
        title="Aetna bill from Riverwalk Imaging"
        status="intake"
        providerName="Riverwalk Imaging"
        insurerName="Aetna"
        amountDisputed={null}
        amountSaved={null}
        nextDeadline={null}
      />,
    );
    expect(screen.getByText("Riverwalk Imaging · Aetna")).toBeInTheDocument();
  });

  it("renders the deadline banner when a deadline is near, and the date itself", () => {
    render(
      <CaseCard
        title="Aetna denial — MRI"
        status="in_progress"
        amountDisputed={900}
        amountSaved={null}
        nextDeadline="2026-09-22"
        today={TODAY}
      />,
    );
    expect(screen.getByTestId("next-deadline")).toHaveTextContent("Sep 22, 2026");
    expect(screen.getByRole("status")).toHaveTextContent(
      "Our team has stepped in and is handling it.",
    );
  });

  it("stays quiet when the deadline is far away", () => {
    render(
      <CaseCard
        title="BlueCross EOB — lab panel"
        status="waiting_reply"
        amountDisputed={268.75}
        amountSaved={null}
        nextDeadline="2026-10-30"
        today={TODAY}
      />,
    );
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("wraps the card in a link when href is given", () => {
    render(
      <CaseCard
        title="Aetna bill from Riverwalk Imaging"
        status="resolved"
        amountDisputed={1249.5}
        amountSaved={830}
        nextDeadline={null}
        href="/cases/1"
      />,
    );
    expect(
      screen.getByRole("link", { name: /Aetna bill from Riverwalk Imaging/ }),
    ).toHaveAttribute("href", "/cases/1");
  });
});
