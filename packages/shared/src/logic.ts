import type { Ownership, WishlistPriority } from "./types.js";

// --- Date-string helper -------------------------------------------------
//
// Mirrors apps/api/src/lib/date.ts's `dateStr()` and the duplicated
// `todayStr()` in apps/web/src/pages/Loans.tsx / BookDetail.tsx: build a
// YYYY-MM-DD string from a JS Date's *local* getFullYear/getMonth/getDate,
// never `toISOString()` (which renders in UTC and can shift the calendar
// day in non-UTC timezones — a bug this codebase has already hit).
//
// This is intentionally a fresh implementation, not a re-export of either
// existing copy: apps/api's version also accepts non-Date input coming
// back from `pg` (arbitrary `unknown`), which isn't a concern here, and
// consolidating all three call sites is out of scope for this task (see
// task-2-report.md).
export function localDateStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function todayStr(): string {
  return localDateStr(new Date());
}

// --- isOverdue ------------------------------------------------------------
//
// Must match the server's authoritative SQL exactly (apps/api/src/routes/
// loans.ts): `returned_date IS NULL AND due_date IS NOT NULL AND due_date
// < CURRENT_DATE`. Dates are compared as YYYY-MM-DD strings (lexicographic
// comparison is date-order-correct for this format), never as JS `Date`
// objects, to avoid any timezone-related drift from the SQL `date` type's
// semantics.
export function isOverdue(
  dueDate: string | null,
  returnedDate: string | null,
  today: string
): boolean {
  if (returnedDate !== null) return false;
  if (dueDate === null) return false;
  return dueDate < today;
}

// --- Ownership badge mapping ------------------------------------------

export const OWNERSHIP_LABELS: Record<Ownership, string> = {
  owned: "Owned",
  borrowed_in: "Borrowed",
  wishlist: "Wishlist",
};

export function ownershipLabel(ownership: Ownership): string {
  return OWNERSHIP_LABELS[ownership];
}

// Lower rank = higher priority. `null` (no priority set) sorts last.
const PRIORITY_RANK: Record<WishlistPriority, number> = { high: 0, medium: 1, low: 2 };
export function priorityRank(p: WishlistPriority | null): number {
  return p ? (PRIORITY_RANK[p] ?? 3) : 3;
}
