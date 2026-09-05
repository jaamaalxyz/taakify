import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { BookOpen } from "lucide-react";
import { useHousehold } from "../lib/household-context.js";
import { onMirrorChange } from "../lib/sync/shape.js";
import {
  listOverdueLoans,
  listToReturnLoans,
  listCurrentlyReading,
  listRecentlyAdded,
  SECTION_CAP,
  type ReadingStatusWithBook,
} from "../lib/repo/home.js";
import { useHomeSection, type UseHomeSectionResult } from "./use-home-section.js";
import { BookCard, type LibraryBook } from "../components/BookCard.js";
import { Card, CardContent } from "../components/ui/card.js";
import { Alert, AlertDescription } from "../components/ui/alert.js";
import { Skeleton } from "../components/ui/skeleton.js";
import { Button } from "../components/ui/button.js";
import type { Loan } from "@taakify/shared";

function daysOverdue(dueDate: string): number {
  const due = new Date(`${dueDate}T00:00:00`);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.max(1, Math.round((today.getTime() - due.getTime()) / 86_400_000));
}

function SectionSkeleton({ rows = 2 }: { rows?: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-14 w-full" />
      ))}
    </div>
  );
}

function SectionError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <Alert variant="destructive">
      <AlertDescription className="flex items-center justify-between gap-3">
        <span>{message}</span>
        <Button size="sm" variant="outline" onClick={onRetry}>
          Retry
        </Button>
      </AlertDescription>
    </Alert>
  );
}

function LoanListItem({ loan, overdue }: { loan: Loan; overdue: boolean }) {
  let detail: string;
  if (overdue) {
    const days = daysOverdue(loan.due_date as string);
    const who =
      loan.direction === "lent_out"
        ? `Overdue from ${loan.contact.name}`
        : `Overdue — return to ${loan.contact.name}`;
    detail = `${who} · ${days} day${days === 1 ? "" : "s"} overdue`;
  } else {
    detail = loan.due_date ? `Due ${loan.due_date}` : "No due date";
  }

  return (
    <li className="flex items-center gap-3 rounded-lg border p-3">
      <div className="flex h-14 w-10 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted">
        {loan.book.edition.cover_url ? (
          <img src={loan.book.edition.cover_url} alt="" className="h-full w-full object-cover" />
        ) : (
          <BookOpen className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        )}
      </div>
      <div className="min-w-0 flex-1 space-y-1">
        <Link to={`/library/${loan.book.id}`} className="text-sm font-medium hover:underline">
          {loan.book.edition.title}
        </Link>
        <p className={overdue ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>{detail}</p>
      </div>
    </li>
  );
}

function LoanSection({
  title,
  destructive,
  section,
  seeAllHref,
}: {
  title: string;
  destructive: boolean;
  section: UseHomeSectionResult<Loan>;
  seeAllHref: string;
}) {
  if (section.status === "loading") return <SectionSkeleton />;
  if (section.status === "error") return <SectionError message={section.error!} onRetry={section.reload} />;
  if (section.data!.length === 0) return null;

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className={destructive ? "text-sm font-semibold text-destructive" : "text-sm font-semibold text-muted-foreground"}>
          {title}
        </h2>
        {section.data!.length === SECTION_CAP && (
          <Link to={seeAllHref} className="text-xs text-primary hover:underline">
            See all →
          </Link>
        )}
      </div>
      <ul className="space-y-2">
        {section.data!.map((loan) => (
          <LoanListItem key={loan.id} loan={loan} overdue={destructive} />
        ))}
      </ul>
    </section>
  );
}

function ReadingStrip({ name, rows, href }: { name: string; rows: ReadingStatusWithBook[]; href: string }) {
  const capped = rows.slice(0, SECTION_CAP);
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium">{name}</p>
        {rows.length > SECTION_CAP && (
          <Link to={href} className="text-xs text-primary hover:underline">
            See all →
          </Link>
        )}
      </div>
      <div className="flex gap-3 overflow-x-auto">
        {capped.map((row) => (
          <Link key={row.book.id} to={`/library/${row.book.id}`} className="w-20 shrink-0 space-y-1">
            <div className="flex aspect-[2/3] items-center justify-center overflow-hidden rounded-md bg-muted">
              {row.book.edition.cover_url ? (
                <img src={row.book.edition.cover_url} alt="" className="h-full w-full object-cover" />
              ) : (
                <BookOpen className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
              )}
            </div>
            <p className="line-clamp-2 text-xs">{row.book.edition.title}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}

export function Home() {
  const { household, members } = useHousehold();
  const [mirrorTick, setMirrorTick] = useState(0);
  useEffect(() => onMirrorChange(() => setMirrorTick((t) => t + 1)), []);

  const reading = useHomeSection(() => listCurrentlyReading(household.id), [household.id, mirrorTick]);
  const recent = useHomeSection(() => listRecentlyAdded(household.id, SECTION_CAP), [household.id, mirrorTick]);
  const toReturn = useHomeSection(() => listToReturnLoans(household.id), [household.id, mirrorTick]);
  const overdue = useHomeSection(() => listOverdueLoans(household.id), [household.id, mirrorTick]);

  const allEmpty =
    reading.status === "loaded" &&
    reading.data!.length === 0 &&
    recent.status === "loaded" &&
    recent.data!.length === 0 &&
    toReturn.status === "loaded" &&
    toReturn.data!.length === 0 &&
    overdue.status === "loaded" &&
    overdue.data!.length === 0;

  const byMember = new Map<string, ReadingStatusWithBook[]>();
  if (reading.status === "loaded") {
    for (const row of reading.data!) {
      const list = byMember.get(row.user_id) ?? [];
      list.push(row);
      byMember.set(row.user_id, list);
    }
  }

  return (
    <div className="space-y-6">
      <h1 className="text-lg font-semibold">Home</h1>

      {allEmpty && (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-8 text-center">
            <p className="text-sm text-muted-foreground">Nothing here yet. Add your first book to get started.</p>
            <Button asChild>
              <Link to="/add">Add a book</Link>
            </Button>
          </CardContent>
        </Card>
      )}

      {reading.status === "loading" && <SectionSkeleton />}
      {reading.status === "error" && <SectionError message={reading.error!} onRetry={reading.reload} />}
      {reading.status === "loaded" && byMember.size > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold text-muted-foreground">Currently reading</h2>
          {[...byMember.entries()].map(([userId, rows]) => (
            <ReadingStrip
              key={userId}
              name={members?.find((m) => m.id === userId)?.name ?? "Household member"}
              rows={rows}
              href={`/library?status=reading&statusUserId=${userId}`}
            />
          ))}
        </section>
      )}

      {recent.status === "loading" && <SectionSkeleton />}
      {recent.status === "error" && <SectionError message={recent.error!} onRetry={recent.reload} />}
      {recent.status === "loaded" && recent.data!.length > 0 && (
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-muted-foreground">Recently added</h2>
            <Link to="/library" className="text-xs text-primary hover:underline">
              See all →
            </Link>
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {(recent.data as LibraryBook[]).map((book) => (
              <BookCard key={book.id} book={book} />
            ))}
          </div>
        </section>
      )}

      <LoanSection title="To return" destructive={false} section={toReturn} seeAllHref="/loans" />
      <LoanSection title="Overdue" destructive section={overdue} seeAllHref="/loans" />
    </div>
  );
}
