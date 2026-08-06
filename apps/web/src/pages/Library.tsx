import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { BookOpen } from "lucide-react";
import { useHousehold } from "../lib/household-context.js";
import { api } from "../lib/api.js";
import { BookCard, type LibraryBook } from "../components/BookCard.js";
import { Input } from "../components/ui/input.js";
import { Badge } from "../components/ui/badge.js";
import { Skeleton } from "../components/ui/skeleton.js";
import { Alert, AlertDescription } from "../components/ui/alert.js";
import { Card, CardContent } from "../components/ui/card.js";

type Ownership = "owned" | "borrowed_in" | "wishlist";

const OWNERSHIP_FILTERS: { label: string; value: Ownership | "" }[] = [
  { label: "All", value: "" },
  { label: "Owned", value: "owned" },
  { label: "Borrowed", value: "borrowed_in" },
  { label: "Wishlist", value: "wishlist" },
];

export function Library() {
  const { household } = useHousehold();
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [ownership, setOwnership] = useState<Ownership | "">("");
  const [books, setBooks] = useState<LibraryBook[] | null>(null);
  const [loadError, setLoadError] = useState("");

  // Debounce the search box: wait 250ms after the user stops typing before
  // updating debouncedSearch, which is what actually drives the fetch below.
  useEffect(() => {
    const timeout = setTimeout(() => setDebouncedSearch(search), 250);
    return () => clearTimeout(timeout);
  }, [search]);

  useEffect(() => {
    setBooks(null);
    setLoadError("");
    const params = new URLSearchParams({ householdId: household.id });
    if (debouncedSearch) params.set("q", debouncedSearch);
    if (ownership) params.set("ownership", ownership);

    let cancelled = false;
    api<{ books: LibraryBook[] }>(`/api/books?${params.toString()}`)
      .then((data) => {
        if (!cancelled) setBooks(data.books);
      })
      .catch((e) => {
        if (!cancelled) setLoadError((e as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [household.id, debouncedSearch, ownership]);

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

      {!loadError && books !== null && books.length === 0 && (
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
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {books.map((book) => (
            <BookCard key={book.id} book={book} />
          ))}
        </div>
      )}
    </div>
  );
}
