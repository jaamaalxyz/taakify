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
  // Optional client-supplied id for the book row itself — lets an
  // optimistic local-mirror insert (apps/web/src/lib/repo/books.ts) and the
  // eventual server row converge on the same id instead of permanently
  // duplicating once Electric syncs the server's row down. Omit to let the
  // server generate one, as before.
  id?: string;
  householdId: string;
  editionId?: string;
  edition?: {
    // Same client-supplied-id story as the book id above, for the edition
    // row this request creates inline when editionId is absent.
    id?: string;
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
  // See CreateBookRequest.id's comment — same client-supplied-id story.
  id?: string;
  householdId: string;
  name: string;
}

export interface CreateBookcaseResponse {
  bookcase: Bookcase;
}

export interface CreateShelfRequest {
  // See CreateBookRequest.id's comment — same client-supplied-id story.
  id?: string;
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
  // Only meaningful for the FIRST write for a given (book_id, user_id) —
  // the ON CONFLICT (book_id, user_id) target is the real upsert key for
  // updates, so this only lets the initial INSERT's id converge with the
  // optimistic local mirror row's id. See CreateBookRequest.id's comment.
  id?: string;
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
  // See CreateBookRequest.id's comment — same client-supplied-id story, but
  // note the residual gap documented in tags.ts: this only dedupes a retry
  // of the exact same create (same id). A genuine same-name-different-id
  // collision (e.g. two members create "sci-fi" independently while
  // offline) still resolves via the existing get-existing-by-name fallback,
  // which can't reconcile the loser's local optimistic id.
  id?: string;
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
  // See CreateBookRequest.id's comment — same client-supplied-id story, for
  // the book_tag row this request creates. Added in the final review fix
  // round (Critical 3): the optimistic local book_tag INSERT
  // (repo/tags.ts's attachBookTag) always generated this id, but it never
  // reached the server until now, so the synced-down row landed under a
  // different id and permanently duplicated.
  id?: string;
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
  // See CreateBookRequest.id's comment — same client-supplied-id story.
  id?: string;
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
  // See CreateBookRequest.id's comment — same client-supplied-id story, for
  // the loan row itself.
  id?: string;
  bookId: string;
  contactId?: string;
  contactName?: string;
  // id to assign the contact this request creates inline when contactName
  // (not contactId) is given — distinct from contactId, which always means
  // "reference an existing contact." Same "inline-created row" client-id
  // pattern as CreateBookRequest.edition.id.
  newContactId?: string;
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

// Plan 7: cover image upload. JSON body (a base64 data URL), not multipart,
// so the request replays through the web client's offline outbox unchanged.
export interface UploadCoverRequest {
  data_url: string;
}

export interface UploadCoverResponse {
  cover_url: string;
}
