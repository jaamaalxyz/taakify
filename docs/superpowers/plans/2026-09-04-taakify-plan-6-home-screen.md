# Taakify Plan 6: Home Screen Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the fifth bottom-tab screen (Home) — a household landing page
aggregating currently-reading, recently-added, to-return, and overdue loans,
each section loading and erroring independently.

**Architecture:** One new read-only repo module (`lib/repo/home.ts`, four
functions querying the PGlite mirror directly, same pattern as
`loans.ts`/`books.ts`), one small shared hook (`use-home-section.ts`) giving
each section its own independent `loading`/`error`/`loaded` state machine
with retry, and one new page (`Home.tsx`) composing four such sections. No
backend changes. `/` becomes `Home` instead of redirecting to `/library`;
`AppShell`'s tab bar gains a 5th tab.

**Tech Stack:** React 19, TypeScript, Vite, PGlite (in-browser Postgres),
Vitest + Testing Library (jsdom), existing shadcn/radix UI primitives
(`Card`, `Alert`, `Skeleton`, `Button`).

**Spec:** `docs/superpowers/specs/2026-09-04-taakify-home-screen-design.md`

## Global Constraints

- No new backend routes, no new mirror tables — every query in `home.ts`
  reads existing mirror tables (`loan`, `book`, `edition`, `reading_status`)
  already kept live by the Electric shape stream.
- Every list is capped at 5 rows (`SECTION_CAP`), with a "See all" link
  shown only when a section is at its cap.
- Sections load and error **independently** — no `Promise.all`; one
  section's failure or slowness never blocks, hides, or delays another.
- Screen section order (deliberate deviation from the original design
  spec's "overdue, top"): **Currently reading → Recently added → To
  return → Overdue.** Overdue keeps its destructive/red styling regardless
  of position.
- Date columns read directly from PGlite must be cast to `::text` in SQL
  (a `date`-typed column otherwise comes back as a JS `Date` object, not a
  string — the same quirk fixed in `import.test.ts` during Plan 4).
- `Loan`, `Book`, `Edition` types come from `@taakify/shared` — reuse them,
  don't redefine.

---

### Task 1: Home repo layer (`lib/repo/home.ts`)

**Files:**
- Create: `apps/web/src/lib/repo/home.ts`
- Test: `apps/web/src/lib/repo/home.test.ts`

**Interfaces:**
- Consumes: `db`, `ready` from `apps/web/src/lib/db/pglite.js`; `Book`,
  `Loan` types from `@taakify/shared`.
- Produces (consumed by Task 3):
  ```ts
  export interface ReadingStatusWithBook {
    user_id: string;
    started_at: string | null;
    book: Book;
  }
  export async function listOverdueLoans(householdId: string): Promise<Loan[]>
  export async function listToReturnLoans(householdId: string): Promise<Loan[]>
  export async function listCurrentlyReading(householdId: string): Promise<ReadingStatusWithBook[]>
  export async function listRecentlyAdded(householdId: string, limit?: number): Promise<Book[]>
  export const SECTION_CAP = 5
  ```

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/lib/repo/home.test.ts`:

```ts
// Repo-layer tests against a real (in-memory) PGlite instance -- same
// pattern as loans.test.ts/import.test.ts: seed rows directly and assert
// on the actual filtering/ordering/limit behavior of each read function.
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

vi.mock("../db/pglite.js", async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const mirrorSchema = (await import("../db/mirror-schema.sql?raw")).default;
  const testDb = new PGlite();
  return { db: testDb, ready: testDb.exec(mirrorSchema) };
});

import { db, ready } from "../db/pglite.js";
import { listOverdueLoans, listToReturnLoans, listCurrentlyReading, listRecentlyAdded } from "./home.js";

const HOUSEHOLD = "00000000-0000-0000-0000-00000000000a";
const OTHER_HOUSEHOLD = "00000000-0000-0000-0000-00000000000f";
const EDITION = "00000000-0000-0000-0000-00000000000b";
const USER = "user-1";

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function addDays(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

async function seedEdition(id: string, title: string) {
  await db.query(
    `INSERT INTO edition (id, title, authors, created_at, updated_at) VALUES ($1, $2, 'Author', now(), now())`,
    [id, title]
  );
}

async function seedBook(id: string, opts: { householdId?: string; editionId?: string; createdAt?: string } = {}) {
  await db.query(
    `INSERT INTO book (id, household_id, edition_id, ownership, created_by, created_at, updated_at)
     VALUES ($1, $2, $3, 'owned', $4, $5, now())`,
    [id, opts.householdId ?? HOUSEHOLD, opts.editionId ?? EDITION, USER, opts.createdAt ?? new Date().toISOString()]
  );
}

async function seedContact(id: string, name: string) {
  await db.query(
    `INSERT INTO contact (id, household_id, name, created_by, created_at, updated_at)
     VALUES ($1, $2, $3, $4, now(), now())`,
    [id, HOUSEHOLD, name, USER]
  );
}

async function seedLoan(
  id: string,
  bookId: string,
  contactId: string,
  opts: { direction?: "lent_out" | "borrowed_in"; dueDate?: string | null; returnedDate?: string | null } = {}
) {
  await db.query(
    `INSERT INTO loan (id, household_id, book_id, contact_id, direction, out_date, due_date, returned_date, created_by, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now(), now())`,
    [
      id,
      HOUSEHOLD,
      bookId,
      contactId,
      opts.direction ?? "lent_out",
      todayStr(),
      opts.dueDate ?? null,
      opts.returnedDate ?? null,
      USER,
    ]
  );
}

async function seedReadingStatus(id: string, bookId: string, userId: string, status: string) {
  await db.query(
    `INSERT INTO reading_status (id, household_id, book_id, user_id, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, now(), now())`,
    [id, HOUSEHOLD, bookId, userId, status]
  );
}

beforeEach(async () => {
  await ready;
  await db.exec("DELETE FROM reading_status");
  await db.exec("DELETE FROM loan");
  await db.exec("DELETE FROM contact");
  await db.exec("DELETE FROM book");
  await db.exec("DELETE FROM edition");
  await seedEdition(EDITION, "Default Edition");
});

afterAll(async () => {
  await db.close();
});

describe("listOverdueLoans", () => {
  it("returns only active loans past their due date, ordered most-overdue first, capped at 5", async () => {
    await seedBook("b1");
    await seedBook("b2");
    await seedBook("b3");
    await seedContact("c1", "Alex");
    await seedLoan("l1", "b1", "c1", { dueDate: addDays(-1) }); // overdue by 1 day
    await seedLoan("l2", "b2", "c1", { dueDate: addDays(-5) }); // overdue by 5 days -- most overdue
    await seedLoan("l3", "b3", "c1", { dueDate: addDays(1) }); // not yet due

    const result = await listOverdueLoans(HOUSEHOLD);

    expect(result.map((l) => l.id)).toEqual(["l2", "l1"]);
  });

  it("excludes returned loans, loans with no due date, and loans due today", async () => {
    await seedBook("b1");
    await seedBook("b2");
    await seedBook("b3");
    await seedContact("c1", "Alex");
    await seedLoan("l1", "b1", "c1", { dueDate: addDays(-1), returnedDate: todayStr() }); // returned
    await seedLoan("l2", "b2", "c1", { dueDate: null }); // no due date
    await seedLoan("l3", "b3", "c1", { dueDate: todayStr() }); // due today -- not overdue

    const result = await listOverdueLoans(HOUSEHOLD);

    expect(result).toEqual([]);
  });

  it("includes both loan directions", async () => {
    await seedBook("b1");
    await seedBook("b2");
    await seedContact("c1", "Alex");
    await seedLoan("l1", "b1", "c1", { direction: "lent_out", dueDate: addDays(-1) });
    await seedLoan("l2", "b2", "c1", { direction: "borrowed_in", dueDate: addDays(-1) });

    const result = await listOverdueLoans(HOUSEHOLD);

    expect(result.map((l) => l.direction).sort()).toEqual(["borrowed_in", "lent_out"]);
  });

  it("caps results at 5 even when more than 5 loans are overdue", async () => {
    await seedContact("c1", "Alex");
    for (let i = 0; i < 7; i++) {
      await seedBook(`b${i}`);
      await seedLoan(`l${i}`, `b${i}`, "c1", { dueDate: addDays(-1 - i) });
    }

    const result = await listOverdueLoans(HOUSEHOLD);

    expect(result).toHaveLength(5);
  });

  it("scopes to the given household", async () => {
    await seedBook("b1", { householdId: OTHER_HOUSEHOLD });
    await db.query(
      `INSERT INTO contact (id, household_id, name, created_by, created_at, updated_at) VALUES ($1, $2, 'Alex', $3, now(), now())`,
      ["c-other", OTHER_HOUSEHOLD, USER]
    );
    await db.query(
      `INSERT INTO loan (id, household_id, book_id, contact_id, direction, out_date, due_date, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'lent_out', $5, $6, $7, now(), now())`,
      ["l1", OTHER_HOUSEHOLD, "b1", "c-other", todayStr(), addDays(-1), USER]
    );

    const result = await listOverdueLoans(HOUSEHOLD);

    expect(result).toEqual([]);
  });
});

describe("listToReturnLoans", () => {
  it("returns active borrowed_in loans not yet overdue, nearest due date first", async () => {
    await seedBook("b1");
    await seedBook("b2");
    await seedBook("b3");
    await seedContact("c1", "Alex");
    await seedLoan("l1", "b1", "c1", { direction: "borrowed_in", dueDate: addDays(5) });
    await seedLoan("l2", "b2", "c1", { direction: "borrowed_in", dueDate: addDays(1) }); // soonest
    await seedLoan("l3", "b3", "c1", { direction: "borrowed_in", dueDate: null }); // no due date -- sorts last

    const result = await listToReturnLoans(HOUSEHOLD);

    expect(result.map((l) => l.id)).toEqual(["l2", "l1", "l3"]);
  });

  it("a loan due exactly today counts as to-return, not overdue", async () => {
    await seedBook("b1");
    await seedContact("c1", "Alex");
    await seedLoan("l1", "b1", "c1", { direction: "borrowed_in", dueDate: todayStr() });

    const toReturn = await listToReturnLoans(HOUSEHOLD);
    const overdue = await listOverdueLoans(HOUSEHOLD);

    expect(toReturn.map((l) => l.id)).toEqual(["l1"]);
    expect(overdue).toEqual([]);
  });

  it("excludes lent_out loans and overdue borrowed_in loans", async () => {
    await seedBook("b1");
    await seedBook("b2");
    await seedContact("c1", "Alex");
    await seedLoan("l1", "b1", "c1", { direction: "lent_out", dueDate: addDays(3) });
    await seedLoan("l2", "b2", "c1", { direction: "borrowed_in", dueDate: addDays(-1) }); // overdue

    const result = await listToReturnLoans(HOUSEHOLD);

    expect(result).toEqual([]);
  });
});

describe("listCurrentlyReading", () => {
  it("returns only status='reading' rows, most recently updated first", async () => {
    await seedBook("b1");
    await seedBook("b2");
    await seedBook("b3");
    await seedReadingStatus("r1", "b1", "user-a", "reading");
    await new Promise((r) => setTimeout(r, 5));
    await seedReadingStatus("r2", "b2", "user-a", "reading");
    await seedReadingStatus("r3", "b3", "user-a", "finished"); // excluded

    const result = await listCurrentlyReading(HOUSEHOLD);

    expect(result.map((r) => r.book.id)).toEqual(["b2", "b1"]);
  });

  it("includes rows from every member, not just one", async () => {
    await seedBook("b1");
    await seedBook("b2");
    await seedReadingStatus("r1", "b1", "user-a", "reading");
    await seedReadingStatus("r2", "b2", "user-b", "reading");

    const result = await listCurrentlyReading(HOUSEHOLD);

    expect(result.map((r) => r.user_id).sort()).toEqual(["user-a", "user-b"]);
  });
});

describe("listRecentlyAdded", () => {
  it("returns books newest-created first, respecting the limit", async () => {
    await seedBook("b1", { createdAt: "2026-01-01T00:00:00Z" });
    await seedBook("b2", { createdAt: "2026-03-01T00:00:00Z" }); // newest
    await seedBook("b3", { createdAt: "2026-02-01T00:00:00Z" });

    const result = await listRecentlyAdded(HOUSEHOLD, 2);

    expect(result.map((b) => b.id)).toEqual(["b2", "b3"]);
  });

  it("defaults to a limit of 5 when none is given", async () => {
    for (let i = 0; i < 7; i++) {
      await seedBook(`b${i}`, { createdAt: `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00Z` });
    }

    const result = await listRecentlyAdded(HOUSEHOLD);

    expect(result).toHaveLength(5);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @taakify/web test -- home.test.ts`
Expected: FAIL — `./home.js` has no exported member `listOverdueLoans` (module doesn't exist yet).

- [ ] **Step 3: Implement `home.ts`**

Create `apps/web/src/lib/repo/home.ts`:

```ts
// Home-screen repo layer (design-spec gap #3): read-only aggregation over
// the local PGlite mirror for the four Home sections -- overdue loans,
// to-return loans, per-member currently-reading, and recently-added books.
// Every function here only reads; nothing calls enqueue(). Mirrors the
// join/filter patterns in loans.ts/books.ts/reading-status.ts, but none of
// their exported functions cover these specific filter combinations, so
// this module owns its own (smaller) projections rather than reusing theirs.
import { db, ready } from "../db/pglite.js";
import type { Book, Loan } from "@taakify/shared";

export const SECTION_CAP = 5;

// due_date/out_date/returned_date are `date` columns -- PGlite can return
// these as a JS Date object rather than a string depending on how the
// value was written, so every date column here is cast to text in SQL
// (Postgres preserves the original column alias through a cast) rather
// than normalized client-side.
const LOAN_SELECT = `
  SELECT l.id, l.household_id, l.direction,
         l.out_date::text AS out_date, l.due_date::text AS due_date, l.returned_date::text AS returned_date,
         l.notes, l.updated_at,
         (l.returned_date IS NULL AND l.due_date IS NOT NULL AND l.due_date < CURRENT_DATE) AS overdue,
         b.id AS book_id, b.ownership, b.format, b.shelf_id, b.do_not_lend, b.wishlist_priority,
         e.id AS edition_id, e.title, e.authors, e.cover_url, e.isbn, e.language,
         c.id AS contact_id, c.name AS contact_name
  FROM loan l
  JOIN book b ON b.id = l.book_id
  JOIN edition e ON e.id = b.edition_id
  JOIN contact c ON c.id = l.contact_id
`;

type LoanRow = {
  id: string;
  household_id: string;
  direction: Loan["direction"];
  out_date: string | null;
  due_date: string | null;
  returned_date: string | null;
  notes: string | null;
  updated_at: string;
  overdue: boolean;
  book_id: string;
  ownership: Book["ownership"];
  format: string | null;
  shelf_id: string | null;
  do_not_lend: boolean;
  wishlist_priority: Book["wishlist_priority"];
  edition_id: string;
  title: string;
  authors: string;
  cover_url: string | null;
  isbn: string | null;
  language: string | null;
  contact_id: string;
  contact_name: string;
};

function mapLoanRow(row: LoanRow): Loan {
  return {
    id: row.id,
    household_id: row.household_id,
    direction: row.direction,
    out_date: row.out_date,
    due_date: row.due_date,
    returned_date: row.returned_date,
    notes: row.notes,
    updated_at: row.updated_at,
    overdue: row.overdue,
    book: {
      id: row.book_id,
      ownership: row.ownership,
      format: row.format,
      shelf_id: row.shelf_id,
      do_not_lend: row.do_not_lend,
      wishlist_priority: row.wishlist_priority,
      edition: {
        id: row.edition_id,
        title: row.title,
        authors: row.authors,
        cover_url: row.cover_url,
        isbn: row.isbn,
        language: row.language,
      },
    },
    contact: { id: row.contact_id, name: row.contact_name },
  };
}

export async function listOverdueLoans(householdId: string): Promise<Loan[]> {
  await ready;
  const { rows } = await db.query<LoanRow>(
    `${LOAN_SELECT}
     WHERE l.household_id = $1 AND l.deleted_at IS NULL AND l.returned_date IS NULL
       AND l.due_date IS NOT NULL AND l.due_date < CURRENT_DATE
     ORDER BY l.due_date ASC
     LIMIT $2`,
    [householdId, SECTION_CAP]
  );
  return rows.map(mapLoanRow);
}

// Deliberately excludes anything listOverdueLoans returns: the
// `due_date < CURRENT_DATE` cutoff there and `due_date >= CURRENT_DATE`
// here are mutually exclusive, so no loan appears in both sections.
export async function listToReturnLoans(householdId: string): Promise<Loan[]> {
  await ready;
  const { rows } = await db.query<LoanRow>(
    `${LOAN_SELECT}
     WHERE l.household_id = $1 AND l.deleted_at IS NULL AND l.returned_date IS NULL
       AND l.direction = 'borrowed_in'
       AND (l.due_date IS NULL OR l.due_date >= CURRENT_DATE)
     ORDER BY l.due_date ASC NULLS LAST
     LIMIT $2`,
    [householdId, SECTION_CAP]
  );
  return rows.map(mapLoanRow);
}

export interface ReadingStatusWithBook {
  user_id: string;
  started_at: string | null;
  book: Book;
}

type ReadingRow = {
  user_id: string;
  started_at: string | null;
  book_id: string;
  ownership: Book["ownership"];
  format: string | null;
  shelf_id: string | null;
  do_not_lend: boolean;
  wishlist_priority: Book["wishlist_priority"];
  edition_id: string;
  title: string;
  authors: string;
  cover_url: string | null;
  isbn: string | null;
  language: string | null;
};

// No LIMIT here -- results are grouped and capped per-member client-side
// (Home.tsx), since capping in SQL would risk starving a member with many
// active reads in favor of one with few.
export async function listCurrentlyReading(householdId: string): Promise<ReadingStatusWithBook[]> {
  await ready;
  const { rows } = await db.query<ReadingRow>(
    `SELECT rs.user_id, rs.started_at::text AS started_at,
            b.id AS book_id, b.ownership, b.format, b.shelf_id, b.do_not_lend, b.wishlist_priority,
            e.id AS edition_id, e.title, e.authors, e.cover_url, e.isbn, e.language
     FROM reading_status rs
     JOIN book b ON b.id = rs.book_id
     JOIN edition e ON e.id = b.edition_id
     WHERE rs.household_id = $1 AND rs.status = 'reading' AND rs.deleted_at IS NULL AND b.deleted_at IS NULL
     ORDER BY rs.updated_at DESC`,
    [householdId]
  );
  return rows.map((row) => ({
    user_id: row.user_id,
    started_at: row.started_at,
    book: {
      id: row.book_id,
      ownership: row.ownership,
      format: row.format,
      shelf_id: row.shelf_id,
      do_not_lend: row.do_not_lend,
      wishlist_priority: row.wishlist_priority,
      edition: {
        id: row.edition_id,
        title: row.title,
        authors: row.authors,
        cover_url: row.cover_url,
        isbn: row.isbn,
        language: row.language,
      },
    },
  }));
}

type RecentBookRow = {
  id: string;
  ownership: Book["ownership"];
  format: string | null;
  shelf_id: string | null;
  do_not_lend: boolean;
  wishlist_priority: Book["wishlist_priority"];
  notes: string | null;
  edition_id: string;
  title: string;
  authors: string;
  cover_url: string | null;
  isbn: string | null;
  language: string | null;
};

export async function listRecentlyAdded(householdId: string, limit: number = SECTION_CAP): Promise<Book[]> {
  await ready;
  const { rows } = await db.query<RecentBookRow>(
    `SELECT b.id, b.ownership, b.format, b.shelf_id, b.do_not_lend, b.wishlist_priority, b.notes,
            e.id AS edition_id, e.title, e.authors, e.cover_url, e.isbn, e.language
     FROM book b
     JOIN edition e ON e.id = b.edition_id
     WHERE b.household_id = $1 AND b.deleted_at IS NULL
     ORDER BY b.created_at DESC
     LIMIT $2`,
    [householdId, limit]
  );
  return rows.map((row) => ({
    id: row.id,
    ownership: row.ownership,
    format: row.format,
    shelf_id: row.shelf_id,
    do_not_lend: row.do_not_lend,
    wishlist_priority: row.wishlist_priority,
    notes: row.notes,
    edition: {
      id: row.edition_id,
      title: row.title,
      authors: row.authors,
      cover_url: row.cover_url,
      isbn: row.isbn,
      language: row.language,
    },
  }));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @taakify/web test -- home.test.ts`
Expected: PASS (all cases in `home.test.ts`)

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @taakify/web typecheck`
Expected: clean

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/repo/home.ts apps/web/src/lib/repo/home.test.ts
git commit -m "feat: Home screen repo layer (overdue/to-return/reading/recent)"
```

---

### Task 2: `useHomeSection` loading/error/retry hook

**Files:**
- Create: `apps/web/src/pages/use-home-section.ts`
- Test: `apps/web/src/pages/use-home-section.test.ts`

**Interfaces:**
- Consumes: `friendlyError` from `apps/web/src/lib/error-messages.js`.
- Produces (consumed by Task 3):
  ```ts
  export type HomeSectionStatus = "loading" | "error" | "loaded";
  export interface UseHomeSectionResult<T> {
    status: HomeSectionStatus;
    data: T[] | null;
    error: string | null;
    reload: () => void;
  }
  export function useHomeSection<T>(loader: () => Promise<T[]>, deps: readonly unknown[]): UseHomeSectionResult<T>
  ```

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/pages/use-home-section.test.ts`:

```ts
import { renderHook, waitFor, act } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useHomeSection } from "./use-home-section.js";

describe("useHomeSection", () => {
  it("starts in loading, then resolves to loaded with the loader's data", async () => {
    const loader = vi.fn().mockResolvedValue([{ id: "1" }]);
    const { result } = renderHook(() => useHomeSection(loader, []));

    expect(result.current.status).toBe("loading");
    expect(result.current.data).toBeNull();

    await waitFor(() => expect(result.current.status).toBe("loaded"));
    expect(result.current.data).toEqual([{ id: "1" }]);
    expect(result.current.error).toBeNull();
  });

  it("transitions to error, with a friendly message, on a rejected loader", async () => {
    const loader = vi.fn().mockRejectedValue(new Error("boom"));
    const { result } = renderHook(() => useHomeSection(loader, []));

    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.data).toBeNull();
    expect(result.current.error).toBeTruthy();
  });

  it("reload() re-invokes the loader and re-enters loading", async () => {
    const loader = vi.fn().mockResolvedValueOnce([{ id: "1" }]).mockResolvedValueOnce([{ id: "2" }]);
    const { result } = renderHook(() => useHomeSection(loader, []));
    await waitFor(() => expect(result.current.status).toBe("loaded"));

    act(() => result.current.reload());

    expect(result.current.status).toBe("loading");
    await waitFor(() => expect(result.current.data).toEqual([{ id: "2" }]));
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("re-runs the loader when a dep changes", async () => {
    const loader = vi.fn().mockResolvedValue([]);
    const { rerender } = renderHook(({ dep }: { dep: number }) => useHomeSection(loader, [dep]), {
      initialProps: { dep: 1 },
    });
    await waitFor(() => expect(loader).toHaveBeenCalledTimes(1));

    rerender({ dep: 2 });

    await waitFor(() => expect(loader).toHaveBeenCalledTimes(2));
  });

  it("ignores a stale response that resolves after a newer reload already resolved", async () => {
    let resolveFirst!: (v: { id: string }[]) => void;
    const first = new Promise<{ id: string }[]>((resolve) => {
      resolveFirst = resolve;
    });
    const loader = vi.fn().mockReturnValueOnce(first).mockResolvedValueOnce([{ id: "new" }]);
    const { result } = renderHook(() => useHomeSection(loader, []));

    act(() => result.current.reload()); // second call -- resolves before the first
    await waitFor(() => expect(result.current.data).toEqual([{ id: "new" }]));

    resolveFirst([{ id: "stale" }]); // first call resolves after the second already landed
    await new Promise((r) => setTimeout(r, 0));

    expect(result.current.data).toEqual([{ id: "new" }]); // stale result ignored
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @taakify/web test -- use-home-section.test.ts`
Expected: FAIL — `./use-home-section.js` module not found.

- [ ] **Step 3: Implement the hook**

Create `apps/web/src/pages/use-home-section.ts`:

```ts
// Shared loading/error/retry state machine for one Home-screen section.
// Each section calls this independently (own loader, own deps) rather than
// Home.tsx combining all four into one Promise.all -- a slow or failing
// section must never block, hide, or delay another (design-spec gap #3).
import { useCallback, useEffect, useRef, useState } from "react";
import { friendlyError } from "../lib/error-messages.js";

export type HomeSectionStatus = "loading" | "error" | "loaded";

export interface UseHomeSectionResult<T> {
  status: HomeSectionStatus;
  data: T[] | null;
  error: string | null;
  reload: () => void;
}

interface HomeSectionState<T> {
  status: HomeSectionStatus;
  data: T[] | null;
  error: string | null;
}

export function useHomeSection<T>(
  loader: () => Promise<T[]>,
  deps: readonly unknown[]
): UseHomeSectionResult<T> {
  const [state, setState] = useState<HomeSectionState<T>>({ status: "loading", data: null, error: null });
  // Read through a ref so `run` doesn't need `loader` in its own deps --
  // callers pass a fresh closure every render (same pattern as
  // BarcodeScanner's onDetectedRef, Plan 5).
  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  // Guards against a slow, superseded request overwriting a newer one's
  // result -- only the result whose id still matches the latest run wins.
  const runIdRef = useRef(0);

  const run = useCallback(() => {
    const runId = ++runIdRef.current;
    setState({ status: "loading", data: null, error: null });
    loaderRef
      .current()
      .then((data) => {
        if (runIdRef.current !== runId) return;
        setState({ status: "loaded", data, error: null });
      })
      .catch((err) => {
        if (runIdRef.current !== runId) return;
        setState({ status: "error", data: null, error: friendlyError(err) });
      });
  }, []);

  // eslint-disable-next-line react-hooks/exhaustive-deps -- `deps` IS the
  // caller-controlled dependency list; `run` is stable (empty deps above).
  useEffect(() => {
    run();
  }, deps);

  return { status: state.status, data: state.data, error: state.error, reload: run };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @taakify/web test -- use-home-section.test.ts`
Expected: PASS (all 5 cases)

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @taakify/web typecheck`
Expected: clean

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/pages/use-home-section.ts apps/web/src/pages/use-home-section.test.ts
git commit -m "feat: useHomeSection hook (independent per-section load/error/retry)"
```

---

### Task 3: `Home.tsx` screen

**Files:**
- Create: `apps/web/src/pages/Home.tsx`
- Test: `apps/web/src/pages/Home.test.tsx`

**Interfaces:**
- Consumes:
  - `useHousehold()` from `../lib/household-context.js` → `{ household: { id }, members: Member[] | null }` where `Member = { id: string; name: string; email: string; role: string }`.
  - `onMirrorChange` from `../lib/sync/shape.js`.
  - `listOverdueLoans`, `listToReturnLoans`, `listCurrentlyReading`, `listRecentlyAdded`, `SECTION_CAP`, `type ReadingStatusWithBook` from `../lib/repo/home.js` (Task 1).
  - `useHomeSection` from `./use-home-section.js` (Task 2).
  - `BookCard`, `type LibraryBook` from `../components/BookCard.js`.
  - `Loan`, `Book` types from `@taakify/shared`.
- Produces: `export function Home(): JSX.Element`, wired into routing in Task 4.

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/pages/Home.test.tsx`:

```tsx
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { Home } from "./Home.js";
import { useHousehold } from "../lib/household-context.js";
import {
  listOverdueLoans,
  listToReturnLoans,
  listCurrentlyReading,
  listRecentlyAdded,
} from "../lib/repo/home.js";
import type { Loan, Book } from "@taakify/shared";

vi.mock("../lib/repo/home.js", () => ({
  listOverdueLoans: vi.fn(),
  listToReturnLoans: vi.fn(),
  listCurrentlyReading: vi.fn(),
  listRecentlyAdded: vi.fn(),
  SECTION_CAP: 5,
}));
vi.mock("../lib/household-context.js", () => ({ useHousehold: vi.fn() }));
vi.mock("../lib/sync/shape.js", () => ({ onMirrorChange: () => () => {} }));

function makeLoan(overrides: Partial<Loan> = {}): Loan {
  return {
    id: "loan-1",
    household_id: "h1",
    direction: "lent_out",
    out_date: "2026-01-01",
    due_date: "2026-01-10",
    returned_date: null,
    notes: null,
    updated_at: "2026-01-01T00:00:00Z",
    overdue: false,
    book: {
      id: "book-1",
      ownership: "owned",
      format: null,
      shelf_id: null,
      do_not_lend: false,
      wishlist_priority: null,
      edition: { id: "ed-1", title: "Dune", authors: "Frank Herbert", cover_url: null, isbn: null, language: null },
    },
    contact: { id: "c1", name: "Alex" },
    ...overrides,
  };
}

function makeBook(overrides: Partial<Book> = {}): Book {
  return {
    id: "book-2",
    ownership: "owned",
    format: null,
    shelf_id: null,
    do_not_lend: false,
    wishlist_priority: null,
    notes: null,
    edition: { id: "ed-2", title: "1984", authors: "George Orwell", cover_url: null, isbn: null, language: null },
    ...overrides,
  };
}

function makeReading(userId: string, bookTitle: string, bookId = "book-3") {
  return {
    user_id: userId,
    started_at: "2026-01-01",
    book: makeBook({ id: bookId, edition: { id: "ed-3", title: bookTitle, authors: "Author", cover_url: null, isbn: null, language: null } }),
  };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const household = { id: "h1", name: "Family Library", role: "owner" };
const members = [
  { id: "u1", name: "Ada", email: "ada@example.com", role: "owner" },
  { id: "u2", name: "Bo", email: "bo@example.com", role: "member" },
];

beforeEach(() => {
  vi.mocked(useHousehold).mockReturnValue({ household, members, user: { id: "u1" } } as never);
  vi.mocked(listOverdueLoans).mockReset();
  vi.mocked(listToReturnLoans).mockReset();
  vi.mocked(listCurrentlyReading).mockReset();
  vi.mocked(listRecentlyAdded).mockReset();
});

function mockAllEmpty() {
  vi.mocked(listOverdueLoans).mockResolvedValue([]);
  vi.mocked(listToReturnLoans).mockResolvedValue([]);
  vi.mocked(listCurrentlyReading).mockResolvedValue([]);
  vi.mocked(listRecentlyAdded).mockResolvedValue([]);
}

describe("Home", () => {
  it("renders an overdue lent_out loan with 'Overdue from {contact}' phrasing", async () => {
    vi.mocked(listOverdueLoans).mockResolvedValue([makeLoan({ id: "l1", direction: "lent_out", due_date: "2020-01-01" })]);
    vi.mocked(listToReturnLoans).mockResolvedValue([]);
    vi.mocked(listCurrentlyReading).mockResolvedValue([]);
    vi.mocked(listRecentlyAdded).mockResolvedValue([]);

    render(<Home />);

    expect(await screen.findByText(/Overdue from Alex/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Overdue" })).toBeInTheDocument();
  });

  it("renders an overdue borrowed_in loan with 'Overdue — return to {contact}' phrasing", async () => {
    vi.mocked(listOverdueLoans).mockResolvedValue([makeLoan({ id: "l1", direction: "borrowed_in", due_date: "2020-01-01" })]);
    vi.mocked(listToReturnLoans).mockResolvedValue([]);
    vi.mocked(listCurrentlyReading).mockResolvedValue([]);
    vi.mocked(listRecentlyAdded).mockResolvedValue([]);

    render(<Home />);

    expect(await screen.findByText(/Overdue — return to Alex/)).toBeInTheDocument();
  });

  it("renders a non-overdue borrowed_in loan under To return, not Overdue", async () => {
    vi.mocked(listOverdueLoans).mockResolvedValue([]);
    vi.mocked(listToReturnLoans).mockResolvedValue([
      makeLoan({ id: "l1", direction: "borrowed_in", due_date: "2099-01-01", overdue: false }),
    ]);
    vi.mocked(listCurrentlyReading).mockResolvedValue([]);
    vi.mocked(listRecentlyAdded).mockResolvedValue([]);

    render(<Home />);

    expect(await screen.findByRole("heading", { name: "To return" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Overdue" })).not.toBeInTheDocument();
  });

  it("groups currently-reading items under each member's own strip by name", async () => {
    vi.mocked(listOverdueLoans).mockResolvedValue([]);
    vi.mocked(listToReturnLoans).mockResolvedValue([]);
    vi.mocked(listCurrentlyReading).mockResolvedValue([
      makeReading("u1", "Dune", "b1"),
      makeReading("u2", "1984", "b2"),
    ]);
    vi.mocked(listRecentlyAdded).mockResolvedValue([]);

    render(<Home />);

    await screen.findByText("Ada");
    expect(screen.getByText("Bo")).toBeInTheDocument();
    expect(screen.getByText("Dune")).toBeInTheDocument();
    expect(screen.getByText("1984")).toBeInTheDocument();
  });

  it("renders recently-added books in the order the repo function returns them", async () => {
    vi.mocked(listOverdueLoans).mockResolvedValue([]);
    vi.mocked(listToReturnLoans).mockResolvedValue([]);
    vi.mocked(listCurrentlyReading).mockResolvedValue([]);
    vi.mocked(listRecentlyAdded).mockResolvedValue([
      makeBook({ id: "b1", edition: { id: "e1", title: "Newest", authors: "A", cover_url: null, isbn: null, language: null } }),
      makeBook({ id: "b2", edition: { id: "e2", title: "Older", authors: "A", cover_url: null, isbn: null, language: null } }),
    ]);

    render(<Home />);

    const titles = await screen.findAllByText(/Newest|Older/);
    expect(titles.map((el) => el.textContent)).toEqual(["Newest", "Older"]);
  });

  it("shows a 'See all' link when a section is at its cap of 5, and not when it's under", async () => {
    vi.mocked(listOverdueLoans).mockResolvedValue(
      Array.from({ length: 5 }, (_, i) => makeLoan({ id: `l${i}`, due_date: "2020-01-01" }))
    );
    vi.mocked(listToReturnLoans).mockResolvedValue([makeLoan({ id: "t1", direction: "borrowed_in", due_date: "2099-01-01" })]);
    vi.mocked(listCurrentlyReading).mockResolvedValue([]);
    vi.mocked(listRecentlyAdded).mockResolvedValue([]);

    render(<Home />);

    await screen.findByRole("heading", { name: "Overdue" });
    const overdueSection = screen.getByRole("heading", { name: "Overdue" }).closest("section")!;
    expect(within(overdueSection).getByRole("link", { name: /See all/ })).toBeInTheDocument();

    const toReturnSection = screen.getByRole("heading", { name: "To return" }).closest("section")!;
    expect(within(toReturnSection).queryByRole("link", { name: /See all/ })).not.toBeInTheDocument();
  });

  it("renders the all-empty prompt when every section resolves with zero rows", async () => {
    mockAllEmpty();

    render(<Home />);

    expect(await screen.findByText(/Nothing here yet/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Add a book" })).toBeInTheDocument();
  });

  it("loads sections independently: a slow section stays on its skeleton while the other three render", async () => {
    const slow = deferred<Loan[]>();
    vi.mocked(listOverdueLoans).mockReturnValue(slow.promise);
    vi.mocked(listToReturnLoans).mockResolvedValue([]);
    vi.mocked(listCurrentlyReading).mockResolvedValue([]);
    vi.mocked(listRecentlyAdded).mockResolvedValue([
      makeBook({ edition: { id: "e1", title: "Recent Book", authors: "A", cover_url: null, isbn: null, language: null } }),
    ]);

    render(<Home />);

    expect(await screen.findByText("Recent Book")).toBeInTheDocument();
    // Overdue's own skeleton is still up -- no heading yet, no error.
    expect(screen.queryByRole("heading", { name: "Overdue" })).not.toBeInTheDocument();

    slow.resolve([makeLoan({ id: "l1", due_date: "2020-01-01" })]);
    expect(await screen.findByRole("heading", { name: "Overdue" })).toBeInTheDocument();
  });

  it("shows a scoped error with Retry for a failed section, without affecting the other three", async () => {
    vi.mocked(listOverdueLoans).mockRejectedValue(new Error("boom"));
    vi.mocked(listToReturnLoans).mockResolvedValue([]);
    vi.mocked(listCurrentlyReading).mockResolvedValue([]);
    vi.mocked(listRecentlyAdded).mockResolvedValue([
      makeBook({ edition: { id: "e1", title: "Recent Book", authors: "A", cover_url: null, isbn: null, language: null } }),
    ]);

    render(<Home />);

    expect(await screen.findByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(screen.getByText("Recent Book")).toBeInTheDocument(); // unaffected

    vi.mocked(listOverdueLoans).mockResolvedValue([makeLoan({ id: "l1", due_date: "2020-01-01" })]);
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByRole("heading", { name: "Overdue" })).toBeInTheDocument();
    expect(listToReturnLoans).toHaveBeenCalledTimes(1); // retry did not re-fetch other sections
  });

  it("does not show the all-empty prompt while one section is still loading or errored", async () => {
    vi.mocked(listOverdueLoans).mockResolvedValue([]);
    vi.mocked(listToReturnLoans).mockResolvedValue([]);
    vi.mocked(listCurrentlyReading).mockResolvedValue([]);
    const slow = deferred<Book[]>();
    vi.mocked(listRecentlyAdded).mockReturnValue(slow.promise);

    render(<Home />);

    await waitFor(() => expect(listOverdueLoans).toHaveBeenCalled());
    expect(screen.queryByText(/Nothing here yet/)).not.toBeInTheDocument();

    slow.resolve([]);
    expect(await screen.findByText(/Nothing here yet/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @taakify/web test -- Home.test.tsx`
Expected: FAIL — `./Home.js` module not found.

- [ ] **Step 3: Implement `Home.tsx`**

Create `apps/web/src/pages/Home.tsx`:

```tsx
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @taakify/web test -- Home.test.tsx`
Expected: PASS (all cases)

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @taakify/web typecheck`
Expected: clean

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/pages/Home.tsx apps/web/src/pages/Home.test.tsx
git commit -m "feat: Home screen (currently reading, recent, to return, overdue)"
```

---

### Task 4: Routing — `/` → Home, 5th tab

**Files:**
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/components/AppShell.tsx`
- Modify: `apps/web/src/App.test.tsx`

**Interfaces:**
- Consumes: `Home` from `./pages/Home.js` (Task 3); `lucide-react`'s `Home`
  icon (already a project dependency, used the same way `Library`/`Plus`/
  `HandCoins`/`User` icons are in `AppShell.tsx`).

- [ ] **Step 1: Update `App.test.tsx` for the new route (write first, expect it to fail)**

In `apps/web/src/App.test.tsx`, add a mock for the new repo module right
after the existing `listBooks`/`listTags` mocks:

```ts
vi.mock("./lib/repo/home.js", () => ({
  listOverdueLoans: vi.fn().mockResolvedValue([]),
  listToReturnLoans: vi.fn().mockResolvedValue([]),
  listCurrentlyReading: vi.fn().mockResolvedValue([]),
  listRecentlyAdded: vi.fn().mockResolvedValue([]),
}));
```

Replace the existing test:

```ts
  it("redirects authenticated users away from /signin, to /library within the AppShell", async () => {
    vi.mocked(authClient.useSession).mockReturnValue({ data: { user: {} }, isPending: false } as never);
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path === "/api/me") return me;
      if (path.startsWith("/api/tags")) return { tags: [] };
      if (path.includes("/members")) return { members: [] };
      return { books: [] };
    });
    renderApp("/signin");
    expect(await screen.findByRole("heading", { name: "Library" })).toBeInTheDocument();
    expect(screen.getByText("Family Library")).toBeInTheDocument();
  });
```

with:

```ts
  it("redirects authenticated users away from /signin, to Home within the AppShell", async () => {
    vi.mocked(authClient.useSession).mockReturnValue({ data: { user: {} }, isPending: false } as never);
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path === "/api/me") return me;
      if (path.startsWith("/api/tags")) return { tags: [] };
      if (path.includes("/members")) return { members: [] };
      return { books: [] };
    });
    renderApp("/signin");
    expect(await screen.findByRole("heading", { name: "Home" })).toBeInTheDocument();
    expect(screen.getByText("Family Library")).toBeInTheDocument();
  });

  it("renders the Home page at / when authed with a household", async () => {
    vi.mocked(authClient.useSession).mockReturnValue({ data: { user: {} }, isPending: false } as never);
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path === "/api/me") return me;
      if (path.includes("/members")) return { members: [] };
      return {};
    });
    renderApp("/");
    expect(await screen.findByRole("heading", { name: "Home" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Library/ })).toBeInTheDocument();
  });
```

Run: `pnpm --filter @taakify/web test -- App.test.tsx`
Expected: FAIL — both updated/new tests find "Library" instead of "Home"
(the redirect still goes to `/library`; `Home.tsx` doesn't exist as a route
yet).

- [ ] **Step 2: Wire the route in `App.tsx`**

In `apps/web/src/App.tsx`, add the import alongside the other page imports:

```ts
import { Home } from "./pages/Home.js";
```

Replace:

```tsx
        <Route path="/" element={<Navigate to="/library" />} />
```

with:

```tsx
        <Route path="/" element={<Home />} />
```

Update the comment above the authed-routes block (currently lists
`/library, /library/:bookId, /add, /import, /loans, /bookcases, and
/profile`) to also mention `/` (Home).

- [ ] **Step 3: Add the 5th tab in `AppShell.tsx`**

In `apps/web/src/components/AppShell.tsx`, update the icon import:

```ts
import { Home as HomeIcon, Library, Plus, HandCoins, User, LogOut } from "lucide-react";
```

(`Home` is aliased to `HomeIcon` to avoid colliding with the page component
of the same name if this file is ever touched alongside it — `AppShell.tsx`
doesn't import the page directly today, but the alias keeps the icon import
unambiguous regardless.)

Replace the `TabBar` function:

```tsx
function TabBar() {
  return (
    <nav className="fixed inset-x-0 bottom-0 z-10 grid grid-cols-4 border-t bg-background py-2">
      <TabLink to="/library" label="Library" icon={Library} />
      <TabLink to="/add" label="Add" icon={Plus} />
      <TabLink to="/loans" label="Loans" icon={HandCoins} />
      <TabLink to="/profile" label="Profile" icon={User} />
    </nav>
  );
}
```

with:

```tsx
function TabBar() {
  return (
    <nav className="fixed inset-x-0 bottom-0 z-10 grid grid-cols-5 border-t bg-background py-2">
      <TabLink to="/" label="Home" icon={HomeIcon} />
      <TabLink to="/library" label="Library" icon={Library} />
      <TabLink to="/add" label="Add" icon={Plus} />
      <TabLink to="/loans" label="Loans" icon={HandCoins} />
      <TabLink to="/profile" label="Profile" icon={User} />
    </nav>
  );
}
```

`TabLink`'s `NavLink` uses `end`, so `to="/"` only highlights active on an
exact `/` match, not on every nested route — consistent with how
`to="/library"` already behaves.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @taakify/web test -- App.test.tsx AppShell.test.tsx`
Expected: PASS. (`AppShell.test.tsx` registers only a `/library` route in
its own test router and never asserts on tab count/labels, so the 5th tab
doesn't require any change there — confirm this by reading the file if the
run surprises you.)

- [ ] **Step 5: Run the full web suite, typecheck, and build**

Run: `pnpm --filter @taakify/web test`
Expected: PASS, all files.

Run: `pnpm --filter @taakify/web typecheck`
Expected: clean.

Run: `pnpm --filter @taakify/web build`
Expected: clean build.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/App.tsx apps/web/src/App.test.tsx apps/web/src/components/AppShell.tsx
git commit -m "feat: wire Home into routing (/ -> Home, 5th tab)"
```

---

## Final Verification

After Task 4:

- [ ] Run `pnpm test` from the repo root — both `@taakify/api` and
      `@taakify/web` suites pass.
- [ ] Run `pnpm --filter @taakify/web typecheck` — clean.
- [ ] Run `pnpm --filter @taakify/web build` — clean.
- [ ] Manually sanity-check in the browser (`pnpm dev:api` + `pnpm dev:web`):
      sign in to a household with at least one overdue loan, one to-return
      loan, one currently-reading status, and one recently-added book; visit
      `/` and confirm all four sections render in the
      currently-reading → recently-added → to-return → overdue order, with
      the overdue section still styled red.
