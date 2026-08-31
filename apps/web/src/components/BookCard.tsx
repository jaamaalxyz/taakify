import { Link } from "react-router-dom";
import { BookOpen } from "lucide-react";
import { Badge } from "./ui/badge.js";
import { UnsyncedBadge } from "./UnsyncedBadge.js";
import { OWNERSHIP_LABELS, type Ownership, type WishlistPriority } from "../lib/labels.js";

export type LibraryBook = {
  id: string;
  ownership: Ownership;
  format: string | null;
  shelf_id: string | null;
  do_not_lend: boolean;
  wishlist_priority: WishlistPriority | null;
  notes: string | null;
  edition: {
    id: string;
    title: string;
    authors: string;
    cover_url: string | null;
    isbn: string | null;
    language: string | null;
  };
};

export function BookCard({ book, unsynced }: { book: LibraryBook; unsynced?: boolean }) {
  return (
    <Link
      to={`/library/${book.id}`}
      className="flex flex-col gap-2 rounded-lg border p-2 transition-colors hover:bg-accent"
    >
      <div className="flex aspect-[2/3] items-center justify-center overflow-hidden rounded-md bg-muted">
        {book.edition.cover_url ? (
          <img
            src={book.edition.cover_url}
            alt=""
            className="h-full w-full object-cover"
          />
        ) : (
          <BookOpen className="h-8 w-8 text-muted-foreground" aria-hidden="true" />
        )}
      </div>
      <div className="space-y-1">
        <p className="line-clamp-2 text-sm font-medium">{book.edition.title}</p>
        <p className="line-clamp-1 text-xs text-muted-foreground">{book.edition.authors}</p>
        <Badge variant="outline">{OWNERSHIP_LABELS[book.ownership]}</Badge>
        {unsynced && <UnsyncedBadge subject="book" />}
      </div>
    </Link>
  );
}
