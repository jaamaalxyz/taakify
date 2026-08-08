// Shared book-domain enums and their human-readable labels.
//
// These mirror the DB CHECK constraints and the API's VALID_STATUSES
// (reading-status.ts) / ownership / wishlist_priority values. Centralizing
// them here keeps the title-casing consistent across screens (a raw
// `book.ownership` renders "owned"; the label map renders "Owned") and
// removes the per-screen re-definitions that had started to drift.

export type Ownership = "owned" | "borrowed_in" | "wishlist";

export const OWNERSHIP_LABELS: Record<Ownership, string> = {
  owned: "Owned",
  borrowed_in: "Borrowed",
  wishlist: "Wishlist",
};

export type ReadingStatus =
  | "unread"
  | "want_to_read"
  | "reading"
  | "finished"
  | "abandoned";

export const READING_STATUS_LABELS: Record<ReadingStatus, string> = {
  unread: "Unread",
  want_to_read: "Want to Read",
  reading: "Reading",
  finished: "Finished",
  abandoned: "Abandoned",
};

// Ordered for Select option lists (matches the reading lifecycle progression).
export const READING_STATUS_ORDER: ReadingStatus[] = [
  "unread",
  "want_to_read",
  "reading",
  "finished",
  "abandoned",
];

export type WishlistPriority = "high" | "medium" | "low";

export const WISHLIST_PRIORITY_LABELS: Record<WishlistPriority, string> = {
  high: "High",
  medium: "Medium",
  low: "Low",
};

// Lower rank = higher priority. Used by Profile's wishlist sort and any
// future priority-weighted view. `null` (no priority set) sorts last.
const PRIORITY_RANK: Record<WishlistPriority, number> = { high: 0, medium: 1, low: 2 };
export function priorityRank(p: WishlistPriority | null): number {
  return p ? (PRIORITY_RANK[p] ?? 3) : 3;
}
