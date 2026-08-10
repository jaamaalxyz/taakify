// Enums and row types shared between @taakify/api and @taakify/web.
//
// The single source of truth for every enum below is the CHECK constraint
// in apps/api/migrations/0002_core.sql — not route code, not the web app's
// previous ad-hoc unions. If a migration ever changes a CHECK constraint,
// update the corresponding array/type here first, then let both apps pick
// up the change through their existing imports from this package.

// --- book.ownership: CHECK (ownership IN ('owned', 'borrowed_in', 'wishlist')) ---
export const OWNERSHIP_VALUES = ["owned", "borrowed_in", "wishlist"] as const;
export type Ownership = (typeof OWNERSHIP_VALUES)[number];

// --- book.wishlist_priority: CHECK (wishlist_priority IN ('high', 'medium', 'low')) ---
export const WISHLIST_PRIORITY_VALUES = ["high", "medium", "low"] as const;
export type WishlistPriority = (typeof WISHLIST_PRIORITY_VALUES)[number];

// --- reading_status.status: CHECK (status IN ('unread', 'want_to_read', 'reading', 'finished', 'abandoned')) ---
export const READING_STATUS_VALUES = [
  "unread",
  "want_to_read",
  "reading",
  "finished",
  "abandoned",
] as const;
export type ReadingStatus = (typeof READING_STATUS_VALUES)[number];

// Ordered for Select option lists (matches the reading lifecycle progression).
export const READING_STATUS_ORDER: ReadingStatus[] = [...READING_STATUS_VALUES];

// --- loan.direction: CHECK (direction IN ('lent_out', 'borrowed_in')) ---
export const LOAN_DIRECTION_VALUES = ["lent_out", "borrowed_in"] as const;
export type LoanDirection = (typeof LOAN_DIRECTION_VALUES)[number];

// --- membership.role: CHECK (role IN ('owner', 'admin', 'member')) ---
export const MEMBERSHIP_ROLE_VALUES = ["owner", "admin", "member"] as const;
export type MembershipRole = (typeof MEMBERSHIP_ROLE_VALUES)[number];

// --- invite.role: CHECK (role IN ('admin', 'member')) ---
export const INVITE_ROLE_VALUES = ["admin", "member"] as const;
export type InviteRole = (typeof INVITE_ROLE_VALUES)[number];

// book.format has no CHECK constraint in the migration (free-text column);
// left as `string | null` rather than a fabricated enum.
export type BookFormat = string | null;

// --- Row types --------------------------------------------------------
// These mirror the columns each route actually selects/returns today
// (apps/api/src/routes/*.ts), not the full DB schema — e.g. `book.notes`
// is nullable everywhere it's read.

export interface Edition {
  id: string;
  isbn: string | null;
  title: string;
  authors: string;
  language: string | null;
  cover_url: string | null;
}

export interface Book {
  id: string;
  household_id?: string;
  ownership: Ownership;
  format: BookFormat;
  shelf_id: string | null;
  do_not_lend: boolean;
  wishlist_priority: WishlistPriority | null;
  notes?: string | null;
  updated_at?: string;
  edition: Edition;
}

export interface ReadingStatusRow {
  id: string;
  book_id: string;
  user_id: string;
  status: ReadingStatus;
  started_at: string | null;
  finished_at: string | null;
  rating: number | null;
  review_note: string | null;
  updated_at: string;
}

export interface Contact {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  linked_user_id?: string | null;
  updated_at?: string;
}

export interface Loan {
  id: string;
  household_id: string;
  direction: LoanDirection;
  out_date: string | null;
  due_date: string | null;
  returned_date: string | null;
  notes: string | null;
  updated_at: string;
  overdue: boolean;
  book: Book;
  contact: { id: string; name: string };
}

export interface Shelf {
  id: string;
  position: number;
  label: string | null;
  updated_at: string;
}

export interface Bookcase {
  id: string;
  name: string;
  updated_at: string;
  shelves: Shelf[];
}

export interface Tag {
  id: string;
  name: string;
  updated_at: string;
}
