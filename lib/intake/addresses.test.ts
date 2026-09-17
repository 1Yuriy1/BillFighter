import { describe, expect, it } from "vitest";
import { caseCodeFor, caseReplyAddress, parseCaseAddress } from "./addresses";

const CASE_ID = "8f2a4d3e-7425-40de-944b-e07fc1f90ae7";

describe("case reply addresses", () => {
  it("derives the reply code from the case UUID", () => {
    expect(caseCodeFor(CASE_ID)).toBe("8f2a4d3e");
  });

  it("builds the spec's address shape on the inbound domain", () => {
    expect(caseReplyAddress(CASE_ID, "in.billfighter.com")).toBe(
      "case-8f2a4d3e@in.billfighter.com",
    );
  });

  it("round-trips address -> parse -> same code", () => {
    const parsed = parseCaseAddress(caseReplyAddress(CASE_ID), "in.billfighter.com");
    expect(parsed).toEqual({ code: "8f2a4d3e" });
  });

  it("parses case-insensitively", () => {
    expect(parseCaseAddress("CASE-8F2A4D3E@IN.BillFighter.COM", "in.billfighter.com")).toEqual({
      code: "8f2a4d3e",
    });
  });

  it("rejects addresses off the inbound domain", () => {
    expect(parseCaseAddress("case-8f2a4d3e@evil.example", "in.billfighter.com")).toBeNull();
  });

  it("rejects wrong local-part shapes", () => {
    expect(parseCaseAddress("jane.k82@in.billfighter.com", "in.billfighter.com")).toBeNull();
    expect(parseCaseAddress("case-8f2a@in.billfighter.com", "in.billfighter.com")).toBeNull();
    expect(parseCaseAddress("case-8f2a4d3ex@in.billfighter.com", "in.billfighter.com")).toBeNull();
    expect(parseCaseAddress("case-8g2a4d3e@in.billfighter.com", "in.billfighter.com")).toBeNull();
  });
});
