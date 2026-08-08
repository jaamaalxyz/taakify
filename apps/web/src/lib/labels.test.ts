import { describe, it, expect } from "vitest";
import {
  OWNERSHIP_LABELS,
  LOAN_DIRECTION_LABELS,
  READING_STATUS_LABELS,
  READING_STATUS_ORDER,
  WISHLIST_PRIORITY_LABELS,
  priorityRank,
} from "./labels.js";

// The whole point of a "single source of truth" labels module is that every
// screen renders the same string. A typo here propagates everywhere at once,
// so these tests pin the exact strings and the priority ordering rather than
// just asserting "a label exists".

describe("OWNERSHIP_LABELS", () => {
  it("title-cases every ownership value", () => {
    expect(OWNERSHIP_LABELS).toEqual({
      owned: "Owned",
      borrowed_in: "Borrowed",
      wishlist: "Wishlist",
    });
  });
});

describe("LOAN_DIRECTION_LABELS", () => {
  it("title-cases every loan direction value", () => {
    expect(LOAN_DIRECTION_LABELS).toEqual({
      lent_out: "Lent out",
      borrowed_in: "Borrowed in",
    });
  });
});

describe("READING_STATUS_LABELS", () => {
  it("title-cases every reading status value", () => {
    expect(READING_STATUS_LABELS).toEqual({
      unread: "Unread",
      want_to_read: "Want to Read",
      reading: "Reading",
      finished: "Finished",
      abandoned: "Abandoned",
    });
  });
});

describe("READING_STATUS_ORDER", () => {
  it("lists every status exactly once, in lifecycle order", () => {
    expect(READING_STATUS_ORDER).toEqual([
      "unread",
      "want_to_read",
      "reading",
      "finished",
      "abandoned",
    ]);
  });

  it("covers the same keys as READING_STATUS_LABELS", () => {
    expect(new Set(READING_STATUS_ORDER)).toEqual(
      new Set(Object.keys(READING_STATUS_LABELS))
    );
  });
});

describe("WISHLIST_PRIORITY_LABELS", () => {
  it("title-cases every wishlist priority value", () => {
    expect(WISHLIST_PRIORITY_LABELS).toEqual({
      high: "High",
      medium: "Medium",
      low: "Low",
    });
  });
});

describe("priorityRank", () => {
  it("ranks high before medium before low", () => {
    expect(priorityRank("high")).toBeLessThan(priorityRank("medium"));
    expect(priorityRank("medium")).toBeLessThan(priorityRank("low"));
  });

  it("ranks null (no priority set) last", () => {
    expect(priorityRank(null)).toBeGreaterThan(priorityRank("low"));
  });

  it("returns a finite number for every input", () => {
    for (const p of ["high", "medium", "low", null] as const) {
      expect(priorityRank(p)).toBeTypeOf("number");
    }
  });
});
