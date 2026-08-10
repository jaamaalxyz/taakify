import { describe, expect, it } from "vitest";
import {
  isOverdue,
  localDateStr,
  ownershipLabel,
  priorityRank,
  todayStr,
} from "../src/logic.js";
import {
  LOAN_DIRECTION_VALUES,
  OWNERSHIP_VALUES,
  READING_STATUS_VALUES,
  WISHLIST_PRIORITY_VALUES,
} from "../src/types.js";

// --- enum values match the DB CHECK constraints --------------------------
// (apps/api/migrations/0002_core.sql). This file is now the single source
// of truth per the task brief, but we still assert against the literal
// constraint values here so a future migration edit is caught by a failing
// test rather than silent drift.

describe("enum values match DB CHECK constraints", () => {
  it("book.ownership", () => {
    expect(OWNERSHIP_VALUES).toEqual(["owned", "borrowed_in", "wishlist"]);
  });

  it("book.wishlist_priority", () => {
    expect(WISHLIST_PRIORITY_VALUES).toEqual(["high", "medium", "low"]);
  });

  it("reading_status.status", () => {
    expect(READING_STATUS_VALUES).toEqual([
      "unread",
      "want_to_read",
      "reading",
      "finished",
      "abandoned",
    ]);
  });

  it("loan.direction", () => {
    expect(LOAN_DIRECTION_VALUES).toEqual(["lent_out", "borrowed_in"]);
  });
});

// --- ownership badge mapping ----------------------------------------------

describe("ownershipLabel", () => {
  it("maps every ownership value to a human label", () => {
    expect(ownershipLabel("owned")).toBe("Owned");
    expect(ownershipLabel("borrowed_in")).toBe("Borrowed");
    expect(ownershipLabel("wishlist")).toBe("Wishlist");
  });
});

describe("priorityRank", () => {
  it("orders high < medium < low < null", () => {
    expect(priorityRank("high")).toBeLessThan(priorityRank("medium"));
    expect(priorityRank("medium")).toBeLessThan(priorityRank("low"));
    expect(priorityRank("low")).toBeLessThan(priorityRank(null));
  });
});

// --- isOverdue matrix -------------------------------------------------
//
// Locks the JS helper to the server's authoritative SQL semantics
// (apps/api/src/routes/loans.ts):
//   returned_date IS NULL AND due_date IS NOT NULL AND due_date < CURRENT_DATE
//
// Every row below is built from local-timezone date strings (localDateStr),
// never toISOString(), because this codebase has already been bitten by a
// UTC-shift bug in date-string construction (see apps/api/src/lib/date.ts
// and the todayStr() duplicates in apps/web).

function daysFrom(base: Date, offsetDays: number): string {
  const d = new Date(base);
  d.setDate(d.getDate() + offsetDays);
  return localDateStr(d);
}

describe("isOverdue matrix", () => {
  const now = new Date();
  const today = localDateStr(now);
  const yesterday = daysFrom(now, -1);
  const tomorrow = daysFrom(now, 1);
  const lastWeek = daysFrom(now, -7);

  const cases: Array<{
    name: string;
    returnedDate: string | null;
    dueDate: string | null;
    today: string;
    expected: boolean;
  }> = [
    {
      name: "not returned, due yesterday -> overdue",
      returnedDate: null,
      dueDate: yesterday,
      today,
      expected: true,
    },
    {
      name: "not returned, due today -> not overdue (SQL uses <, not <=)",
      returnedDate: null,
      dueDate: today,
      today,
      expected: false,
    },
    {
      name: "not returned, due tomorrow -> not overdue",
      returnedDate: null,
      dueDate: tomorrow,
      today,
      expected: false,
    },
    {
      name: "not returned, no due date -> not overdue",
      returnedDate: null,
      dueDate: null,
      today,
      expected: false,
    },
    {
      name: "returned yesterday, due yesterday -> not overdue (already returned)",
      returnedDate: yesterday,
      dueDate: yesterday,
      today,
      expected: false,
    },
    {
      name: "returned today, due last week -> not overdue (returned, even if late)",
      returnedDate: today,
      dueDate: lastWeek,
      today,
      expected: false,
    },
  ];

  for (const { name, returnedDate, dueDate, today: t, expected } of cases) {
    it(name, () => {
      expect(isOverdue(dueDate, returnedDate, t)).toBe(expected);
    });
  }

  it("matches the raw SQL boolean expression for every row in the matrix", () => {
    for (const { returnedDate, dueDate, today: t, expected } of cases) {
      const sqlEquivalent = returnedDate === null && dueDate !== null && dueDate < t;
      expect(sqlEquivalent).toBe(expected);
      expect(isOverdue(dueDate, returnedDate, t)).toBe(sqlEquivalent);
    }
  });

  it("is stable regardless of timezone (built from local Date components, not toISOString)", () => {
    // A date constructed with the local-timezone constructor at 23:30 local
    // time is the classic case where toISOString() shifts the calendar day
    // (converting to UTC pushes past midnight in negative-offset zones, or
    // pulls back a day in positive-offset zones near 00:xx). localDateStr
    // must report the *local* calendar day regardless of what toISOString()
    // would say.
    const lateLocal = new Date(2026, 2, 15, 23, 30, 0); // 2026-03-15 23:30 local
    expect(localDateStr(lateLocal)).toBe("2026-03-15");

    const earlyLocal = new Date(2026, 2, 15, 0, 15, 0); // 2026-03-15 00:15 local
    expect(localDateStr(earlyLocal)).toBe("2026-03-15");

    // Regression guard against ever swapping the implementation to
    // toISOString(): assert directly that the shared helper does NOT use it,
    // by confirming it matches the local getters rather than the UTC ones
    // whenever they'd disagree (any non-zero, non-multiple-of-24h offset
    // that crosses midnight would otherwise produce a mismatch here).
    const localBased = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    expect(localDateStr(lateLocal)).toBe(localBased(lateLocal));
    expect(localDateStr(earlyLocal)).toBe(localBased(earlyLocal));

    // todayStr() must agree with localDateStr(new Date()) at call time.
    expect(todayStr().length).toBe(10);
    expect(todayStr()).toBe(localDateStr(new Date()));
  });
});
