// Write-endpoint request/response contracts.
//
// These mirror the fields each handler in apps/api/src/routes/*.ts actually
// reads off `c.req.json<...>()` / writes back today — not an idealized
// shape. Keep in sync with the route file named in each comment.

import type {
  Book,
  Bookcase,
  Contact,
  Loan,
  LoanDirection,
  Ownership,
  ReadingStatus,
  ReadingStatusRow,
  Shelf,
  Tag,
  WishlistPriority,
} from "./types.js";

// --- books.ts -----------------------------------------------------------

export interface CreateBookRequest {
  householdId: string;
  editionId?: string;
  edition?: {
    isbn?: string;
    title: string;
    authors?: string;
    language?: string;
    cover_url?: string;
  };
  ownership: Ownership;
  shelf_id?: string;
  do_not_lend?: boolean;
  wishlist_priority?: WishlistPriority;
  notes?: string;
}

export interface CreateBookResponse {
  book: Book;
}

export interface UpdateBookRequest {
  shelf_id?: string | null;
  ownership?: Ownership;
  do_not_lend?: boolean;
  wishlist_priority?: WishlistPriority | null;
  notes?: string | null;
}

export interface UpdateBookResponse {
  book: Book;
}

export interface ListBooksResponse {
  books: Book[];
}

// --- shelves.ts / bookcases (mounted in shelves.ts) ---------------------

export interface CreateBookcaseRequest {
  householdId: string;
  name: string;
}

export interface CreateBookcaseResponse {
  bookcase: Bookcase;
}

export interface CreateShelfRequest {
  label?: string;
}

export interface CreateShelfResponse {
  shelf: Shelf;
}

export interface UpdateShelfRequest {
  label?: string;
  position?: number;
}

export interface UpdateShelfResponse {
  shelf: Shelf;
}

// --- reading-status.ts ----------------------------------------------------

export interface UpsertReadingStatusRequest {
  status: ReadingStatus;
  started_at?: string | null;
  finished_at?: string | null;
  rating?: number;
  review_note?: string | null;
}

export interface UpsertReadingStatusResponse {
  status: ReadingStatusRow;
}

export interface ListReadingStatusResponse {
  statuses: ReadingStatusRow[];
}

// --- tags.ts --------------------------------------------------------------

export interface CreateTagRequest {
  householdId: string;
  name: string;
}

export interface CreateTagResponse {
  tag: Tag;
}

export interface ListTagsResponse {
  tags: Tag[];
}

export interface AttachBookTagRequest {
  tagId: string;
}

export interface AttachBookTagResponse {
  bookTag: { id: string; book_id: string; tag_id: string; updated_at: string };
}

export interface ListBookTagsResponse {
  tags: Tag[];
}

// --- contacts.ts ----------------------------------------------------------

export interface CreateContactRequest {
  householdId: string;
  name: string;
  phone?: string;
  email?: string;
}

export interface UpdateContactRequest {
  name?: string;
  phone?: string | null;
  email?: string | null;
}

export interface ContactResponse {
  contact: Contact;
}

export interface ListContactsResponse {
  contacts: Contact[];
}

// --- loans.ts ---------------------------------------------------------

export interface CreateLoanRequest {
  bookId: string;
  contactId?: string;
  contactName?: string;
  direction: LoanDirection;
  dueDate?: string;
}

export interface UpdateLoanRequest {
  returned_date?: string | null;
  due_date?: string | null;
}

export interface LoanResponse {
  loan: Loan;
}

export interface ListLoansResponse {
  loans: Loan[];
}
