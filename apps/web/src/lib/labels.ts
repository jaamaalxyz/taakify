// Human-readable labels for the book-domain enums.
//
// The enums themselves (and their DB-CHECK-constraint-backed values) now
// live in @taakify/shared, which is the single source of truth per
// packages/shared/src/types.ts. This module re-exports them for existing
// call sites and keeps the presentation-only label maps (title-casing,
// ordering, priority ranking) local to the web app.
export type {
  Ownership,
  LoanDirection,
  ReadingStatus,
  WishlistPriority,
} from "@taakify/shared";
export { READING_STATUS_ORDER, priorityRank, OWNERSHIP_LABELS } from "@taakify/shared";
import type {
  LoanDirection,
  ReadingStatus,
  WishlistPriority,
} from "@taakify/shared";

export const LOAN_DIRECTION_LABELS: Record<LoanDirection, string> = {
  lent_out: "Lent out",
  borrowed_in: "Borrowed in",
};

export const READING_STATUS_LABELS: Record<ReadingStatus, string> = {
  unread: "Unread",
  want_to_read: "Want to Read",
  reading: "Reading",
  finished: "Finished",
  abandoned: "Abandoned",
};

export const WISHLIST_PRIORITY_LABELS: Record<WishlistPriority, string> = {
  high: "High",
  medium: "Medium",
  low: "Low",
};
