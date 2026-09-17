import { describe, expect, it } from "vitest";
import {
  caseStatusBadgeClass,
  caseStatusLabel,
  daysPhrase,
  daysUntil,
  deadlineTier,
  formatDateTime,
  formatDate,
  formatUsd,
  sortUrgentFirst,
} from "./display";

describe("deadlineTier", () => {
  it.each([
    [15, "none"],
    [30, "none"],
    [14, "notify"],
    [6, "notify"],
    [5, "escalate"],
    [3, "escalate"],
    [2, "urgent"],
    [0, "urgent"],
    [-4, "urgent"],
  ] as const)("daysLeft=%i -> %s", (daysLeft, expected) => {
    expect(deadlineTier(daysLeft)).toBe(expected);
  });
});

describe("daysUntil", () => {
  it("counts whole calendar days in UTC", () => {
    expect(daysUntil("2026-09-19", "2026-09-17")).toBe(2);
    expect(daysUntil("2026-10-01", "2026-09-17")).toBe(14);
  });

  it("returns negative for past deadlines", () => {
    expect(daysUntil("2026-09-10", "2026-09-17")).toBe(-7);
  });

  it("handles month and year boundaries", () => {
    expect(daysUntil("2027-01-01", "2026-12-31")).toBe(1);
  });

  it("accepts full ISO timestamps, using their UTC date", () => {
    expect(daysUntil("2026-09-19T23:59:59Z", "2026-09-17T00:00:01Z")).toBe(2);
  });

  it("throws on an invalid date instead of producing a silent NaN", () => {
    expect(() => daysUntil("not-a-date", "2026-09-17")).toThrow(/Invalid date/);
  });
});

describe("daysPhrase", () => {
  it("pluralizes correctly", () => {
    expect(daysPhrase(1)).toBe("1 day");
    expect(daysPhrase(2)).toBe("2 days");
    expect(daysPhrase(14)).toBe("14 days");
  });
});

describe("formatUsd", () => {
  it("formats amounts in USD", () => {
    expect(formatUsd(1249.5)).toBe("$1,249.50");
    expect(formatUsd(0)).toBe("$0.00");
  });

  it("renders null as an em dash — never a guessed number", () => {
    expect(formatUsd(null)).toBe("—");
  });
});

describe("formatDate / formatDateTime", () => {
  it("formats a date-only value in UTC", () => {
    expect(formatDate("2026-10-01")).toBe("Oct 1, 2026");
  });

  it("formats a timestamp with time in UTC", () => {
    expect(formatDateTime("2026-09-17T15:41:00Z")).toBe("Sep 17, 2026, 3:41 PM");
  });

  it("throws on invalid input", () => {
    expect(() => formatDate("garbage")).toThrow(/Invalid date/);
    expect(() => formatDateTime("garbage")).toThrow(/Invalid date/);
  });
});

describe("sortUrgentFirst", () => {
  it("pins urgent entries to the top and preserves relative order", () => {
    const entries = [
      { id: "a", urgent: false },
      { id: "b", urgent: true },
      { id: "c", urgent: true },
      { id: "d", urgent: false },
    ];
    expect(sortUrgentFirst(entries).map((entry) => entry.id)).toEqual(["b", "c", "a", "d"]);
  });

  it("treats missing urgent as not urgent and does not mutate the input", () => {
    const entries = [{ id: "a" }, { id: "b", urgent: true }];
    const sorted = sortUrgentFirst(entries);
    expect(sorted.map((entry) => entry.id)).toEqual(["b", "a"]);
    expect(entries.map((entry) => entry.id)).toEqual(["a", "b"]);
  });
});

describe("status presentation", () => {
  it("labels every status in plain language", () => {
    expect(caseStatusLabel("awaiting_approval")).toBe("Waiting for your approval");
    expect(caseStatusLabel("resolved")).toBe("Resolved");
  });

  it("pairs every label with a badge class", () => {
    expect(caseStatusBadgeClass("awaiting_approval")).toMatch(/bg-amber-100/);
  });
});
