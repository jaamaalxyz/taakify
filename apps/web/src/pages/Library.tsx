import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { BookOpen } from "lucide-react";
import { useHousehold } from "../lib/household-context.js";
import { listBooks } from "../lib/repo/books.js";
import { listTags } from "../lib/repo/tags.js";
import { getSyncStalled, onMirrorChange, onSyncStalledChange } from "../lib/sync/shape.js";
import { friendlyError } from "../lib/error-messages.js";
import {
  OWNERSHIP_LABELS,
  READING_STATUS_LABELS,
  READING_STATUS_ORDER,
  type Ownership,
  type ReadingStatus,
} from "../lib/labels.js";
import { BookCard, type LibraryBook } from "../components/BookCard.js";
import { Input } from "../components/ui/input.js";
import { Badge } from "../components/ui/badge.js";
import { Button } from "../components/ui/button.js";
import { Skeleton } from "../components/ui/skeleton.js";
import { Alert, AlertDescription } from "../components/ui/alert.js";
import { Card, CardContent } from "../components/ui/card.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select.js";

type Tag = { id: string; name: string; updated_at: string };

// "All" + one chip per ownership value, labels from the shared map.
const OWNERSHIP_FILTERS: { label: string; value: Ownership | "" }[] = [
  { label: "All", value: "" },
  ...(["owned", "borrowed_in", "wishlist"] as const).map((v) => ({
    label: OWNERSHIP_LABELS[v],
    value: v,
  })),
];

// Fixed enum matching reading-status.ts's VALID_STATUSES — no fetch needed.
const STATUS_FILTERS: { label: string; value: ReadingStatus }[] =
  READING_STATUS_ORDER.map((v) => ({ label: READING_STATUS_LABELS[v], value: v }));

// Radix Select doesn't allow an empty-string item value, so "cleared" state
// is represented with sentinels and mapped to "no query param" at fetch time.
const ALL_STATUSES = "all";
const ALL_TAGS = "all";

// Matches the API's default LIMIT (books.ts) — used both as the page size we
// request and as the heuristic for whether a "Load more" page might exist.
const PAGE_SIZE = 100;

export function Library() {
  const { household, user } = useHousehold();
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [ownership, setOwnership] = useState<Ownership | "">("");
  const [statusFilter, setStatusFilter] = useState<string>(ALL_STATUSES);
  const [tagFilter, setTagFilter] = useState<string>(ALL_TAGS);
  const [tags, setTags] = useState<Tag[]>([]);
  const [books, setBooks] = useState<LibraryBook[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  // True while the base (offset-0) query is in flight. Distinct from
  // `books === null` (that no longer resets on refetch -- see the SWR
  // comment below): guards `handleLoadMore` against firing mid-refetch with
  // a stale `books.length` from the OLD filter's results against the NEW
  // filter's params, which mixed the two filters' books together in the
  // grid (Code review finding, PR #15 polish batch).
  const [refetching, setRefetching] = useState(true);
  // Bumped whenever the local mirror changes underneath us (a remote edit
  // streaming in via Electric, or our own optimistic write) -- included in
  // the data-loading effect's deps below so a book added on another device
  // shows up here without the user having to navigate away and back
  // (Important finding, final whole-branch review).
  const [mirrorTick, setMirrorTick] = useState(0);
  // Distinguishes a true "no books" empty state from "Electric is
  // unreachable" -- otherwise a stalled first run reads as "your data is
  // gone" instead of "we can't reach the server" (Minor finding, PR #15
  // review).
  const [stalled, setStalled] = useState(getSyncStalled);

  useEffect(() => onMirrorChange(() => setMirrorTick((t) => t + 1)), []);
  useEffect(() => onSyncStalledChange(() => setStalled(getSyncStalled())), []);

  // Debounce the search box: wait 250ms after the user stops typing before
  // updating debouncedSearch, which is what actually drives the fetch below.
  useEffect(() => {
    const timeout = setTimeout(() => setDebouncedSearch(search), 250);
    return () => clearTimeout(timeout);
  }, [search]);

  useEffect(() => {
    listTags(household.id)
      .then((data) => setTags(data))
      .catch(() => setTags([]));
  }, [household.id]);

  function buildOptions(offset: number) {
    return {
      householdId: household.id,
      q: debouncedSearch || undefined,
      ownership: ownership || undefined,
      status: statusFilter !== ALL_STATUSES ? statusFilter : undefined,
      statusUserId: statusFilter !== ALL_STATUSES ? user.id : undefined,
      tag: tagFilter !== ALL_TAGS ? tagFilter : undefined,
      offset: offset > 0 ? offset : undefined,
    };
  }

  useEffect(() => {
    // Stale-while-revalidate: don't blank `books` here. A shape-stream
    // catch-up (mirrorTick) or a filter change re-runs this effect, and
    // resetting to null flashed the grid back to skeletons on every refetch
    // even though the previous results are still valid to show while the
    // new query is in flight (Minor finding, PR #15 review).
    setLoadError("");
    setRefetching(true);

    let cancelled = false;
    listBooks(buildOptions(0))
      .then((data) => {
        if (cancelled) return;
        setBooks(data as LibraryBook[]);
        setHasMore(data.length === PAGE_SIZE);
      })
      .catch((e) => {
        if (!cancelled) setLoadError(friendlyError(e));
      })
      .finally(() => {
        if (!cancelled) setRefetching(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [household.id, debouncedSearch, ownership, statusFilter, tagFilter, mirrorTick]);

  function handleLoadMore() {
    if (!books || refetching) return;
    setLoadingMore(true);
    listBooks(buildOptions(books.length))
      .then((data) => {
        setBooks((prev) => [...(prev ?? []), ...(data as LibraryBook[])]);
        setHasMore(data.length === PAGE_SIZE);
      })
      .catch((e) => setLoadError(friendlyError(e)))
      .finally(() => setLoadingMore(false));
  }

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">Library</h1>

      <Input
        type="search"
        placeholder="Search by title or author"
        aria-label="Search books"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />

      <div className="flex flex-wrap gap-2">
        {OWNERSHIP_FILTERS.map((filter) => (
          <Badge
            key={filter.value || "all"}
            variant={ownership === filter.value ? "default" : "outline"}
            role="button"
            tabIndex={0}
            onClick={() => setOwnership(filter.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") setOwnership(filter.value);
            }}
            className="cursor-pointer"
          >
            {filter.label}
          </Badge>
        ))}
      </div>

      <div className="flex flex-wrap gap-2">
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-40" aria-label="Status">
            <SelectValue placeholder="All statuses" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_STATUSES}>All statuses</SelectItem>
            {STATUS_FILTERS.map((s) => (
              <SelectItem key={s.value} value={s.value}>
                {s.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={tagFilter} onValueChange={setTagFilter}>
          <SelectTrigger className="w-40" aria-label="Tag">
            <SelectValue placeholder="All tags" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_TAGS}>All tags</SelectItem>
            {tags.map((tag) => (
              <SelectItem key={tag.id} value={tag.name}>
                {tag.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {loadError && (
        <Alert variant="destructive">
          <AlertDescription>Couldn't load your books: {loadError}</AlertDescription>
        </Alert>
      )}

      {!loadError && books === null && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="aspect-[2/3] w-full" />
          ))}
        </div>
      )}

      {!loadError && books !== null && books.length === 0 && stalled && (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-8 text-center">
            <BookOpen className="h-8 w-8 text-muted-foreground" aria-hidden="true" />
            <p className="text-sm text-muted-foreground">
              Couldn't reach the server — your library will appear when reconnected.
            </p>
          </CardContent>
        </Card>
      )}

      {!loadError && books !== null && books.length === 0 && !stalled && (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-8 text-center">
            <BookOpen className="h-8 w-8 text-muted-foreground" aria-hidden="true" />
            <p className="text-sm text-muted-foreground">No books yet.</p>
            <Link to="/add" className="text-sm font-medium text-primary underline-offset-4 hover:underline">
              Add your first book
            </Link>
          </CardContent>
        </Card>
      )}

      {!loadError && books !== null && books.length > 0 && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {books.map((book) => (
              <BookCard key={book.id} book={book} />
            ))}
          </div>
          {hasMore && (
            <div className="flex justify-center">
              <Button variant="outline" onClick={handleLoadMore} disabled={loadingMore || refetching}>
                {loadingMore ? "Loading…" : "Load more"}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
