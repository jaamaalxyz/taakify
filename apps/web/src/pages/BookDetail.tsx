import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { BookOpen, MoreVertical } from "lucide-react";
import { toast } from "sonner";
import { useHousehold } from "../lib/household-context.js";
import { getBook, updateBook, deleteBook } from "../lib/repo/books.js";
import { listReadingStatuses, upsertMyReadingStatus } from "../lib/repo/reading-status.js";
import { listBookTags, findOrCreateTag, attachBookTag, removeBookTag } from "../lib/repo/tags.js";
import { listBookcases } from "../lib/repo/shelves.js";
import { listTags } from "../lib/repo/tags.js";
import { listContacts } from "../lib/repo/contacts.js";
import { listLoans, createLoan, updateLoan } from "../lib/repo/loans.js";
import { onMirrorChange } from "../lib/sync/shape.js";
import { friendlyError } from "../lib/error-messages.js";
import { todayStr } from "../lib/local-date.js";
import type {
  Book,
  Bookcase,
  Contact,
  Loan,
  ReadingStatusRow as SharedReadingStatusRow,
  Tag,
} from "@taakify/shared";
import {
  LOAN_DIRECTION_LABELS,
  OWNERSHIP_LABELS,
  READING_STATUS_LABELS,
  READING_STATUS_ORDER,
  WISHLIST_PRIORITY_LABELS,
  type LoanDirection as Direction,
  type Ownership,
  type ReadingStatus,
  type WishlistPriority,
} from "../lib/labels.js";
import { StatusBadge } from "../components/StatusBadge.js";
import { Skeleton } from "../components/ui/skeleton.js";
import { Alert, AlertDescription } from "../components/ui/alert.js";
import { Badge } from "../components/ui/badge.js";
import { Button } from "../components/ui/button.js";
import { Label } from "../components/ui/label.js";
import { Input } from "../components/ui/input.js";
import { Textarea } from "../components/ui/textarea.js";
import { Switch } from "../components/ui/switch.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../components/ui/dialog.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu.js";

type Status = SharedReadingStatusRow;

const NO_SHELF = "none";
const NEW_CONTACT = "__new__";

export function BookDetail() {
  const { bookId } = useParams<{ bookId: string }>();
  const { household, user, members } = useHousehold();
  const navigate = useNavigate();

  const [book, setBook] = useState<Book | null>(null);
  const [statuses, setStatuses] = useState<Status[] | null>(null);
  const [loadError, setLoadError] = useState("");

  // My-status editor fields. started_at/finished_at have no UI on this
  // screen yet, but PUT /:bookId/status is a full-replace upsert (every
  // column gets overwritten with EXCLUDED.*, not just the ones sent) — so
  // we still have to capture and echo them back unmodified on every save,
  // or saving status/rating/note here would silently null out any dates
  // already on the row.
  const [myStatus, setMyStatus] = useState<ReadingStatus>("unread");
  const [myRating, setMyRating] = useState<string>("");
  const [myNote, setMyNote] = useState("");
  const [myStartedAt, setMyStartedAt] = useState<string | null>(null);
  const [myFinishedAt, setMyFinishedAt] = useState<string | null>(null);
  const [savingStatus, setSavingStatus] = useState(false);
  const [statusError, setStatusError] = useState("");

  // Tags. bookTags is the server-side source of truth for what's currently
  // on this book (GET /api/books/:bookId/tags), refetched after every
  // add/remove so it stays accurate across page reloads and other members'
  // changes — unlike the old "tags added this session" local-state
  // workaround this replaced.
  const [householdTags, setHouseholdTags] = useState<Tag[]>([]);
  const [bookTags, setBookTags] = useState<Tag[] | null>(null);
  const [selectedTagId, setSelectedTagId] = useState<string>("");
  const [newTagName, setNewTagName] = useState("");
  const [tagError, setTagError] = useState("");
  const [addingTag, setAddingTag] = useState(false);

  // Actions: move shelf, edit fields, delete.
  const [bookcases, setBookcases] = useState<Bookcase[]>([]);
  const [moveShelfId, setMoveShelfId] = useState<string>(NO_SHELF);
  const [moveShelfOpen, setMoveShelfOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [editOwnership, setEditOwnership] = useState<Ownership>("owned");
  const [editNotes, setEditNotes] = useState("");
  const [editDoNotLend, setEditDoNotLend] = useState(false);
  const [editPriority, setEditPriority] = useState<WishlistPriority | "none">("none");
  // Separate error/loading state per dialog — sharing one pair between
  // move-shelf and edit-details meant an error from one dialog stayed
  // visible after closing it and opening the other.
  const [savingShelf, setSavingShelf] = useState(false);
  const [shelfError, setShelfError] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);
  const [editError, setEditError] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");

  // Active loan status + "Lend out" dialog.
  const [activeLoan, setActiveLoan] = useState<Loan | null>(null);
  const [loanLoadError, setLoanLoadError] = useState("");
  const [returningLoan, setReturningLoan] = useState(false);
  const [returnError, setReturnError] = useState("");
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [contactsLoadError, setContactsLoadError] = useState("");
  const [lendOpen, setLendOpen] = useState(false);
  const [lendContactSelection, setLendContactSelection] = useState<string>(NEW_CONTACT);
  const [lendNewContactName, setLendNewContactName] = useState("");
  const [lendDirection, setLendDirection] = useState<Direction>("lent_out");
  const [lendDueDate, setLendDueDate] = useState("");
  const [savingLoan, setSavingLoan] = useState(false);
  const [lendError, setLendError] = useState("");
  // A do-not-lend book can still be lent, but the user must acknowledge the
  // warning first — the dialog opens on the warning, then reveals the form.
  const [doNotLendConfirmed, setDoNotLendConfirmed] = useState(false);

  function loadActiveLoan() {
    if (!bookId) return;
    setLoanLoadError("");
    listLoans({ householdId: household.id, bookId, active: true })
      .then((loans) => setActiveLoan(loans[0] ?? null))
      .catch((e) => setLoanLoadError(friendlyError(e)));
  }

  function loadBook() {
    if (!bookId) return;
    setBook(null);
    setLoadError("");
    // See lib/error-messages.ts for how errors are mapped to user-facing copy.
    getBook(bookId)
      .then((data) => setBook(data))
      .catch((e) => setLoadError(friendlyError(e)));
  }

  function loadStatuses() {
    if (!bookId) return;
    listReadingStatuses(bookId)
      .then((data) => {
        setStatuses(data);
        const mine = data.find((s) => s.user_id === user.id);
        if (mine) {
          setMyStatus(mine.status);
          setMyRating(mine.rating ? String(mine.rating) : "");
          setMyNote(mine.review_note ?? "");
          setMyStartedAt(mine.started_at);
          setMyFinishedAt(mine.finished_at);
        }
      })
      .catch((e) => setLoadError(friendlyError(e)));
  }

  function loadBookTags() {
    if (!bookId) return;
    listBookTags(bookId)
      .then((data) => setBookTags(data))
      .catch((e) => setTagError(friendlyError(e)));
  }

  // Only loaded lazily when the "Lend out" menu item is chosen (see its
  // onSelect below, which opens this controlled dialog directly rather than
  // through Radix's own open/close transitions — onOpenChange doesn't fire
  // for that, so the fetch has to be triggered there) — unlike
  // bookcases/tags above, which every page view needs for always-visible
  // UI, contacts are only used inside this dialog, which most book-detail
  // visits never open.
  function loadContacts() {
    setContactsLoadError("");
    listContacts(household.id)
      .then((data) => setContacts(data))
      .catch((e) => {
        setContacts([]);
        setContactsLoadError(friendlyError(e));
      });
  }

  // Bumped whenever the local mirror changes underneath us (a remote edit
  // streaming in via Electric, or our own optimistic write) -- re-runs the
  // four loaders below so e.g. another household member's status/tag/loan
  // change on this book shows up without a manual navigate-away-and-back
  // (Important finding, final whole-branch review).
  const [mirrorTick, setMirrorTick] = useState(0);
  useEffect(() => onMirrorChange(() => setMirrorTick((t) => t + 1)), []);

  useEffect(() => {
    loadBook();
    loadStatuses();
    loadBookTags();
    loadActiveLoan();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId, mirrorTick]);

  useEffect(() => {
    if (book) {
      setEditOwnership(book.ownership);
      setEditNotes(book.notes ?? "");
      setEditDoNotLend(book.do_not_lend);
      setEditPriority(book.wishlist_priority ?? "none");
      setMoveShelfId(book.shelf_id ?? NO_SHELF);
    }
  }, [book]);

  useEffect(() => {
    listBookcases(household.id)
      .then((data) => setBookcases(data))
      .catch(() => setBookcases([]));
    listTags(household.id)
      .then((data) => setHouseholdTags(data))
      .catch(() => setHouseholdTags([]));
  }, [household.id]);

  async function handleStatusSubmit(e: FormEvent) {
    e.preventDefault();
    if (!bookId) return;
    setStatusError("");
    setSavingStatus(true);
    try {
      await upsertMyReadingStatus(bookId, user.id, {
        status: myStatus,
        rating: myRating ? Number(myRating) : undefined,
        review_note: myNote.trim() || undefined,
        started_at: myStartedAt ?? undefined,
        finished_at: myFinishedAt ?? undefined,
      });
      toast("Status updated");
      loadStatuses();
    } catch (err) {
      setStatusError(friendlyError(err));
    } finally {
      setSavingStatus(false);
    }
  }

  async function handleAddTag() {
    if (!bookId) return;
    setTagError("");
    setAddingTag(true);
    try {
      let tagId = selectedTagId;
      let tag: Tag;
      if (!tagId && newTagName.trim()) {
        tag = await findOrCreateTag(household.id, newTagName.trim(), user.id);
        tagId = tag.id;
        setHouseholdTags((prev) => (prev.some((t) => t.id === tag.id) ? prev : [...prev, tag]));
      } else {
        const found = householdTags.find((t) => t.id === tagId);
        if (!found) {
          setTagError("Pick a tag or enter a new name.");
          setAddingTag(false);
          return;
        }
        tag = found;
      }

      await attachBookTag(bookId, household.id, tagId);
      loadBookTags();
      toast(`Added tag "${tag.name}"`);
      setSelectedTagId("");
      setNewTagName("");
    } catch (err) {
      setTagError(friendlyError(err));
    } finally {
      setAddingTag(false);
    }
  }

  async function handleRemoveTag(tag: Tag) {
    if (!bookId) return;
    try {
      await removeBookTag(bookId, tag.id);
      loadBookTags();
      toast(`Removed tag "${tag.name}"`);
    } catch (err) {
      setTagError(friendlyError(err));
    }
  }

  async function handleMoveShelf() {
    if (!bookId) return;
    setShelfError("");
    setSavingShelf(true);
    try {
      const newShelfId = moveShelfId === NO_SHELF ? null : moveShelfId;
      await updateBook(bookId, { shelf_id: newShelfId });
      setBook((prev) => (prev ? { ...prev, shelf_id: newShelfId } : prev));
      toast("Shelf updated");
      setMoveShelfOpen(false);
    } catch (err) {
      setShelfError(friendlyError(err));
    } finally {
      setSavingShelf(false);
    }
  }

  async function handleEditSubmit(e: FormEvent) {
    e.preventDefault();
    if (!bookId) return;
    setEditError("");
    setSavingEdit(true);
    try {
      const notes = editNotes.trim() || null;
      const wishlistPriority = editPriority === "none" ? null : editPriority;
      await updateBook(bookId, {
        ownership: editOwnership,
        notes,
        do_not_lend: editDoNotLend,
        wishlist_priority: wishlistPriority,
      });
      setBook((prev) =>
        prev
          ? {
              ...prev,
              ownership: editOwnership,
              notes,
              do_not_lend: editDoNotLend,
              wishlist_priority: wishlistPriority,
            }
          : prev
      );
      toast("Book updated");
      setEditOpen(false);
    } catch (err) {
      setEditError(friendlyError(err));
    } finally {
      setSavingEdit(false);
    }
  }

  async function handleDelete() {
    if (!bookId) return;
    setDeleteError("");
    setDeleting(true);
    try {
      await deleteBook(bookId);
      toast("Book deleted");
      navigate("/library");
    } catch (err) {
      setDeleteError(friendlyError(err));
      setDeleting(false);
    }
  }

  async function handleCreateLoan(e: FormEvent) {
    e.preventDefault();
    if (!bookId) return;
    // Defense in depth: the form is only rendered once the warning is
    // acknowledged (see the dialog below), but keep the guard so a stale
    // doNotLendConfirmed can never let a do-not-lend loan slip through.
    if (book?.do_not_lend && !doNotLendConfirmed) return;
    if (lendContactSelection === NEW_CONTACT && !lendNewContactName.trim()) {
      setLendError("Choose a contact or enter a new contact name.");
      return;
    }
    setLendError("");
    setSavingLoan(true);
    try {
      await createLoan({
        bookId,
        direction: lendDirection,
        dueDate: lendDueDate || undefined,
        contactId: lendContactSelection === NEW_CONTACT ? undefined : lendContactSelection,
        contactName: lendContactSelection === NEW_CONTACT ? lendNewContactName.trim() : undefined,
        createdBy: user.id,
      });
      toast("Loan recorded");
      setLendOpen(false);
      setLendContactSelection(NEW_CONTACT);
      setLendNewContactName("");
      setLendDirection("lent_out");
      setLendDueDate("");
      setDoNotLendConfirmed(false);
      loadActiveLoan();
      // Picks up a brand-new "+ New contact" contact so it's selectable in
      // this dialog without a full page reload.
      loadContacts();
    } catch (err) {
      setLendError(friendlyError(err));
    } finally {
      setSavingLoan(false);
    }
  }

  async function handleMarkReturned() {
    if (!activeLoan) return;
    setReturnError("");
    setReturningLoan(true);
    try {
      await updateLoan(activeLoan.id, { returned_date: todayStr() });
      toast("Marked as returned");
      loadActiveLoan();
    } catch (err) {
      setReturnError(friendlyError(err));
    } finally {
      setReturningLoan(false);
    }
  }

  if (loadError) {
    return (
      <Alert variant="destructive">
        <AlertDescription>Couldn't load this book: {loadError}</AlertDescription>
      </Alert>
    );
  }

  if (!book) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-48 w-32" />
        <Skeleton className="h-6 w-2/3" />
        <Skeleton className="h-4 w-1/2" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3">
        <div className="flex gap-4">
          <div className="flex h-40 w-28 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted">
            {book.edition.cover_url ? (
              <img src={book.edition.cover_url} alt="" className="h-full w-full object-cover" />
            ) : (
              <BookOpen className="h-8 w-8 text-muted-foreground" aria-hidden="true" />
            )}
          </div>
          <div className="space-y-1">
            <h1 className="text-lg font-semibold">{book.edition.title}</h1>
            <p className="text-sm text-muted-foreground">{book.edition.authors}</p>
            {book.edition.isbn && (
              <p className="text-xs text-muted-foreground">ISBN: {book.edition.isbn}</p>
            )}
            {book.edition.language && (
              <p className="text-xs text-muted-foreground">Language: {book.edition.language}</p>
            )}
            <Badge variant="outline">{OWNERSHIP_LABELS[book.ownership]}</Badge>
            {loanLoadError && (
              <p className="text-xs text-muted-foreground">Couldn't load loan status: {loanLoadError}</p>
            )}
            {activeLoan && (
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-xs text-muted-foreground">
                  {LOAN_DIRECTION_LABELS[activeLoan.direction]} · {activeLoan.contact.name}
                  {activeLoan.due_date && ` · due ${activeLoan.due_date}`}
                </p>
                {activeLoan.overdue && <Badge variant="destructive">Overdue</Badge>}
                <Button size="sm" variant="outline" onClick={handleMarkReturned} disabled={returningLoan}>
                  {returningLoan ? "Saving…" : "Mark returned"}
                </Button>
              </div>
            )}
            {returnError && (
              <Alert variant="destructive">
                <AlertDescription>{returnError}</AlertDescription>
              </Alert>
            )}
          </div>
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="Actions">
              <MoreVertical className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => setMoveShelfOpen(true)}>Move shelf</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setEditOpen(true)}>Edit details</DropdownMenuItem>
            {!activeLoan && (
              <DropdownMenuItem
                onSelect={() => {
                  setLendOpen(true);
                  loadContacts();
                }}
              >
                Lend out
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              onSelect={() => setDeleteOpen(true)}
              className="text-destructive focus:text-destructive"
            >
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">Household statuses</h2>
        {statuses === null && <Skeleton className="h-6 w-full" />}
        {statuses !== null && statuses.length === 0 && (
          <p className="text-sm text-muted-foreground">No one has set a status yet.</p>
        )}
        {statuses !== null && statuses.length > 0 && (
          <ul className="space-y-1">
            {statuses.map((s) => {
              // The status response carries user_id, not a display name.
              // Resolve it against the household roster from HouseholdProvider
              // (one shared GET /api/households/:id/members). The caller's own
              // row is always "You"; if the roster is still loading or a member
              // somehow isn't in it, fall back to a bare "Member" rather than
              // flashing the raw uuid.
              const member = members?.find((m) => m.id === s.user_id);
              const label = s.user_id === user.id ? "You" : member?.name ?? "Member";
              return (
                <li key={s.id} className="flex items-center gap-2 text-sm">
                  <span className="text-muted-foreground">{label}:</span>
                  <StatusBadge status={s.status} />
                  {s.rating != null && <span className="text-xs text-muted-foreground">{s.rating}/5</span>}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="space-y-3 rounded-lg border p-3">
        <h2 className="text-sm font-semibold">My status</h2>
        <form onSubmit={handleStatusSubmit} className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="my-status">Status</Label>
            <Select value={myStatus} onValueChange={(v) => setMyStatus(v as ReadingStatus)}>
              <SelectTrigger id="my-status" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {READING_STATUS_ORDER.map((s) => (
                  <SelectItem key={s} value={s}>
                    {READING_STATUS_LABELS[s]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="my-rating">Rating (1-5)</Label>
            <Input
              id="my-rating"
              type="number"
              min={1}
              max={5}
              value={myRating}
              onChange={(e) => setMyRating(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="my-note">Review note</Label>
            <Textarea id="my-note" value={myNote} onChange={(e) => setMyNote(e.target.value)} />
          </div>
          {statusError && (
            <Alert variant="destructive">
              <AlertDescription>{statusError}</AlertDescription>
            </Alert>
          )}
          <Button type="submit" disabled={savingStatus}>
            {savingStatus ? "Saving…" : "Save status"}
          </Button>
        </form>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">Tags</h2>
        {bookTags === null && <Skeleton className="h-6 w-32" />}
        {bookTags !== null && bookTags.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {bookTags.map((tag) => (
              <Badge key={tag.id} variant="secondary" className="gap-1">
                {tag.name}
                <button
                  type="button"
                  aria-label={`Remove tag ${tag.name}`}
                  onClick={() => handleRemoveTag(tag)}
                  className="ml-1"
                >
                  ×
                </button>
              </Badge>
            ))}
          </div>
        )}
        {bookTags !== null && bookTags.length === 0 && (
          <p className="text-sm text-muted-foreground">No tags on this book yet.</p>
        )}
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1">
            <Label htmlFor="tag-select">Existing tag</Label>
            <Select
              value={selectedTagId}
              onValueChange={(v) => {
                setSelectedTagId(v);
                setNewTagName("");
              }}
            >
              <SelectTrigger id="tag-select" className="w-40">
                <SelectValue placeholder="Choose tag" />
              </SelectTrigger>
              <SelectContent>
                {householdTags.map((tag) => (
                  <SelectItem key={tag.id} value={tag.id}>
                    {tag.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="tag-new">Or new tag</Label>
            <Input
              id="tag-new"
              value={newTagName}
              onChange={(e) => {
                setNewTagName(e.target.value);
                setSelectedTagId("");
              }}
              placeholder="New tag name"
            />
          </div>
          <Button
            type="button"
            onClick={handleAddTag}
            disabled={addingTag || (!selectedTagId && !newTagName.trim())}
          >
            {addingTag ? "Adding…" : "Add tag"}
          </Button>
        </div>
        {tagError && (
          <Alert variant="destructive">
            <AlertDescription>{tagError}</AlertDescription>
          </Alert>
        )}
      </section>

      {/* Move shelf dialog */}
      <Dialog
        open={moveShelfOpen}
        onOpenChange={(open) => {
          setMoveShelfOpen(open);
          if (!open) setShelfError("");
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Move shelf</DialogTitle>
            <DialogDescription>Choose a new shelf for this book.</DialogDescription>
          </DialogHeader>
          <Select value={moveShelfId} onValueChange={setMoveShelfId}>
            <SelectTrigger className="w-full" aria-label="Shelf">
              <SelectValue placeholder="No shelf" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_SHELF}>No shelf</SelectItem>
              {bookcases.flatMap((bc) =>
                bc.shelves.map((shelf) => (
                  <SelectItem key={shelf.id} value={shelf.id}>
                    {bc.name} — {shelf.label}
                  </SelectItem>
                ))
              )}
            </SelectContent>
          </Select>
          {shelfError && (
            <Alert variant="destructive">
              <AlertDescription>{shelfError}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button onClick={handleMoveShelf} disabled={savingShelf}>
              {savingShelf ? "Saving…" : "Move"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit details dialog */}
      <Dialog
        open={editOpen}
        onOpenChange={(open) => {
          setEditOpen(open);
          if (!open) setEditError("");
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit book</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleEditSubmit} className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="edit-ownership">Ownership</Label>
              <Select value={editOwnership} onValueChange={(v) => setEditOwnership(v as Ownership)}>
                <SelectTrigger id="edit-ownership" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="owned">Owned</SelectItem>
                  <SelectItem value="borrowed_in">Borrowed</SelectItem>
                  <SelectItem value="wishlist">Wishlist</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="edit-priority">Wishlist priority</Label>
              <Select
                value={editPriority}
                onValueChange={(v) => setEditPriority(v as WishlistPriority | "none")}
              >
                <SelectTrigger id="edit-priority" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None</SelectItem>
                  {(["high", "medium", "low"] as const).map((p) => (
                    <SelectItem key={p} value={p}>
                      {WISHLIST_PRIORITY_LABELS[p]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center gap-2">
              <Switch id="edit-do-not-lend" checked={editDoNotLend} onCheckedChange={setEditDoNotLend} />
              <Label htmlFor="edit-do-not-lend">Do not lend</Label>
            </div>
            <div className="space-y-1">
              <Label htmlFor="edit-notes">Notes</Label>
              <Textarea id="edit-notes" value={editNotes} onChange={(e) => setEditNotes(e.target.value)} />
            </div>
            {editError && (
              <Alert variant="destructive">
                <AlertDescription>{editError}</AlertDescription>
              </Alert>
            )}
            <DialogFooter>
              <Button type="submit" disabled={savingEdit}>
                {savingEdit ? "Saving…" : "Save changes"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Lend out dialog */}
      <Dialog
        open={lendOpen}
        onOpenChange={(open) => {
          setLendOpen(open);
          if (!open) {
            setLendError("");
            setDoNotLendConfirmed(false);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Lend out</DialogTitle>
          </DialogHeader>
          {book.do_not_lend && !doNotLendConfirmed ? (
            // Two-phase dialog: a do-not-lend book must be acknowledged
            // before the lend form is revealed. The user can still override
            // — this is a warning, not a hard block.
            <div className="space-y-3">
              <Alert variant="destructive">
                <AlertDescription>
                  This book is marked “do not lend.” Lend it anyway?
                </AlertDescription>
              </Alert>
              <DialogFooter>
                <Button variant="outline" onClick={() => setLendOpen(false)}>
                  Cancel
                </Button>
                <Button onClick={() => setDoNotLendConfirmed(true)}>Lend anyway</Button>
              </DialogFooter>
            </div>
          ) : (
          <form onSubmit={handleCreateLoan} className="space-y-3">
            {contactsLoadError && (
              <p className="text-xs text-muted-foreground">
                Couldn't load contacts, so the contact picker may be empty — try reopening this dialog.
              </p>
            )}
            <div className="space-y-1">
              <Label htmlFor="lend-direction">Direction</Label>
              <Select value={lendDirection} onValueChange={(v) => setLendDirection(v as Direction)}>
                <SelectTrigger id="lend-direction" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="lent_out">Lent out</SelectItem>
                  <SelectItem value="borrowed_in">Borrowed in</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="lend-contact">Contact</Label>
              <Select value={lendContactSelection} onValueChange={setLendContactSelection}>
                <SelectTrigger id="lend-contact" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NEW_CONTACT}>+ New contact</SelectItem>
                  {contacts.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {lendContactSelection === NEW_CONTACT && (
              <div className="space-y-1">
                <Label htmlFor="lend-new-contact-name">New contact name</Label>
                <Input
                  id="lend-new-contact-name"
                  value={lendNewContactName}
                  onChange={(e) => setLendNewContactName(e.target.value)}
                />
              </div>
            )}
            <div className="space-y-1">
              <Label htmlFor="lend-due-date">Due date</Label>
              <Input
                id="lend-due-date"
                type="date"
                value={lendDueDate}
                onChange={(e) => setLendDueDate(e.target.value)}
              />
            </div>
            {lendError && (
              <Alert variant="destructive">
                <AlertDescription>{lendError}</AlertDescription>
              </Alert>
            )}
            <DialogFooter>
              <Button type="submit" disabled={savingLoan}>
                {savingLoan ? "Saving…" : "Record loan"}
              </Button>
            </DialogFooter>
          </form>
          )}
        </DialogContent>
      </Dialog>

      {/* Delete confirmation dialog */}
      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete this book?</DialogTitle>
            <DialogDescription>
              This removes "{book.edition.title}" from your library. This can't be undone from here.
            </DialogDescription>
          </DialogHeader>
          {deleteError && (
            <Alert variant="destructive">
              <AlertDescription>{deleteError}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button variant="destructive" onClick={handleDelete} disabled={deleting}>
              {deleting ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
