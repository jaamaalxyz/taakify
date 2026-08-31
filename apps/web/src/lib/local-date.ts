// toISOString() renders in UTC, so in any non-UTC timezone it can report
// tomorrow's (or yesterday's) date depending on time of day -- the same bug
// class apps/api/src/lib/date.ts's dateStr() was created to fix server-side.
// Build the string from local Date components instead. Shared by
// Loans.tsx, BookDetail.tsx, and repo/loans.ts's createLoan (previously
// three independent copies of this same logic).
export function todayStr(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
