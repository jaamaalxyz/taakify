import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { BookOpen, MoreVertical } from "lucide-react";
import { toast } from "sonner";
import { useHousehold } from "../lib/household-context.js";
import { api } from "../lib/api.js";
import { StatusBadge, type ReadingStatus } from "../components/StatusBadge.js";
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

type Ownership = "owned" | "borrowed_in" | "wishlist";
type WishlistPriority = "high" | "medium" | "low";

type Book = {
  id: string;
  ownership: Ownership;
  format: string | null;
  shelf_id: string | null;
  do_not_lend: boolean;
  wishlist_priority: WishlistPriority | null;
  notes: string | null;
  updated_at: string;
  edition: {
    id: string;
    title: string;
    authors: string;
    cover_url: string | null;
    isbn: string | null;
    language: string | null;
  };
};

type Status = {
  id: string;
  book_id: string;
  user_id: string;
  status: ReadingStatus;
  started_at: string | null;
  finished_at: string | null;
  rating: number | null;
  review_note: string | null;
  updated_at: string;
};

type Shelf = { id: string; position: number; label: string; updated_at: string };
type Bookcase = { id: string; name: string; updated_at: string; shelves: Shelf[] };
type Tag = { id: string; name: string; updated_at: string };

const NO_SHELF = "none";
const STATUS_OPTIONS: ReadingStatus[] = ["unread", "want_to_read", "reading", "finished", "abandoned"];

export function BookDetail() {
  const { bookId } = useParams<{ bookId: string }>();
  const { household, user } = useHousehold();
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

  function loadBook() {
    if (!bookId) return;
    setBook(null);
    setLoadError("");
    // api() throws the same shape of Error for a 404 as for any other
    // failure (network error, 500, etc.) — it only carries the server's
    // `error` message text, not the status code. We deliberately don't
    // string-match on that message to special-case "not found"; showing
    // whatever message came back covers both cases correctly, if less
    // precisely than a dedicated 404 UI would.
    api<{ book: Book }>(`/api/books/${bookId}`)
      .then((data) => setBook(data.book))
      .catch((e) => setLoadError((e as Error).message));
  }

  function loadStatuses() {
    if (!bookId) return;
    api<{ statuses: Status[] }>(`/api/books/${bookId}/status`)
      .then((data) => {
        setStatuses(data.statuses);
        const mine = data.statuses.find((s) => s.user_id === user.id);
        if (mine) {
          setMyStatus(mine.status);
          setMyRating(mine.rating ? String(mine.rating) : "");
          setMyNote(mine.review_note ?? "");
          setMyStartedAt(mine.started_at);
          setMyFinishedAt(mine.finished_at);
        }
      })
      .catch((e) => setLoadError((e as Error).message));
  }

  function loadBookTags() {
    if (!bookId) return;
    api<{ tags: Tag[] }>(`/api/books/${bookId}/tags`)
      .then((data) => setBookTags(data.tags))
      .catch((e) => setTagError((e as Error).message));
  }

  useEffect(() => {
    loadBook();
    loadStatuses();
    loadBookTags();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId]);

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
    api<{ bookcases: Bookcase[] }>(`/api/bookcases?householdId=${household.id}`)
      .then((data) => setBookcases(data.bookcases))
      .catch(() => setBookcases([]));
    api<{ tags: Tag[] }>(`/api/tags?householdId=${household.id}`)
      .then((data) => setHouseholdTags(data.tags))
      .catch(() => setHouseholdTags([]));
  }, [household.id]);

  async function handleStatusSubmit(e: FormEvent) {
    e.preventDefault();
    if (!bookId) return;
    setStatusError("");
    setSavingStatus(true);
    try {
      await api(`/api/books/${bookId}/status`, {
        method: "PUT",
        body: JSON.stringify({
          status: myStatus,
          rating: myRating ? Number(myRating) : undefined,
          review_note: myNote.trim() || undefined,
          started_at: myStartedAt ?? undefined,
          finished_at: myFinishedAt ?? undefined,
        }),
      });
      toast("Status updated");
      loadStatuses();
    } catch (err) {
      setStatusError((err as Error).message);
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
        tag = await api<{ tag: Tag }>("/api/tags", {
          method: "POST",
          body: JSON.stringify({ householdId: household.id, name: newTagName.trim() }),
        }).then((d) => d.tag);
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

      await api(`/api/books/${bookId}/tags`, {
        method: "POST",
        body: JSON.stringify({ tagId }),
      });
      loadBookTags();
      toast(`Added tag "${tag.name}"`);
      setSelectedTagId("");
      setNewTagName("");
    } catch (err) {
      setTagError((err as Error).message);
    } finally {
      setAddingTag(false);
    }
  }

  async function handleRemoveTag(tag: Tag) {
    if (!bookId) return;
    try {
      await api(`/api/books/${bookId}/tags/${tag.id}`, { method: "DELETE" });
      loadBookTags();
      toast(`Removed tag "${tag.name}"`);
    } catch (err) {
      setTagError((err as Error).message);
    }
  }

  async function handleMoveShelf() {
    if (!bookId) return;
    setShelfError("");
    setSavingShelf(true);
    try {
      const data = await api<{ book: Book }>(`/api/books/${bookId}`, {
        method: "PATCH",
        body: JSON.stringify({ shelf_id: moveShelfId === NO_SHELF ? null : moveShelfId }),
      });
      setBook(data.book);
      toast("Shelf updated");
      setMoveShelfOpen(false);
    } catch (err) {
      setShelfError((err as Error).message);
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
      const data = await api<{ book: Book }>(`/api/books/${bookId}`, {
        method: "PATCH",
        body: JSON.stringify({
          ownership: editOwnership,
          notes: editNotes.trim() || null,
          do_not_lend: editDoNotLend,
          wishlist_priority: editPriority === "none" ? null : editPriority,
        }),
      });
      setBook(data.book);
      toast("Book updated");
      setEditOpen(false);
    } catch (err) {
      setEditError((err as Error).message);
    } finally {
      setSavingEdit(false);
    }
  }

  async function handleDelete() {
    if (!bookId) return;
    setDeleteError("");
    setDeleting(true);
    try {
      await api(`/api/books/${bookId}`, { method: "DELETE" });
      toast("Book deleted");
      navigate("/library");
    } catch (err) {
      setDeleteError((err as Error).message);
      setDeleting(false);
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
            <Badge variant="outline">{book.ownership}</Badge>
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
            {statuses.map((s) => (
              <li key={s.id} className="flex items-center gap-2 text-sm">
                {/* The status response only carries user_id, not a display
                    name — there's no household-members list API to resolve
                    it against. We label the caller's own row "You" and fall
                    back to the raw user_id for everyone else, noted here as
                    a known gap rather than inventing a members API. */}
                <span className="text-muted-foreground">
                  {s.user_id === user.id ? "You" : `Member (${s.user_id})`}:
                </span>
                <StatusBadge status={s.status} />
                {s.rating != null && <span className="text-xs text-muted-foreground">{s.rating}/5</span>}
              </li>
            ))}
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
                {STATUS_OPTIONS.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s}
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
                  <SelectItem value="high">High</SelectItem>
                  <SelectItem value="medium">Medium</SelectItem>
                  <SelectItem value="low">Low</SelectItem>
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
