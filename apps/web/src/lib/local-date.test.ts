import { describe, it, expect, afterEach, vi } from "vitest";
import { todayStr } from "./local-date.js";

describe("todayStr", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("formats today's date as YYYY-MM-DD using local (not UTC) components", () => {
    // 2026-01-05T23:30:00 local time is already 2026-01-06 in UTC -- if
    // todayStr() used toISOString() (UTC-based) it would report the wrong
    // (later) day here.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 5, 23, 30, 0));

    expect(todayStr()).toBe("2026-01-05");
  });

  it("zero-pads single-digit months and days", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 2, 4, 10, 0, 0)); // March 4th

    expect(todayStr()).toBe("2026-03-04");
  });
});
