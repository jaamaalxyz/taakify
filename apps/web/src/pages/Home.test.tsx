import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { MemoryRouter } from "react-router-dom";
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

function renderHome() {
  return render(
    <MemoryRouter>
      <Home />
    </MemoryRouter>
  );
}

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

    renderHome();

    expect(await screen.findByText(/Overdue from Alex/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Overdue" })).toBeInTheDocument();
  });

  it("renders an overdue borrowed_in loan with 'Overdue — return to {contact}' phrasing", async () => {
    vi.mocked(listOverdueLoans).mockResolvedValue([makeLoan({ id: "l1", direction: "borrowed_in", due_date: "2020-01-01" })]);
    vi.mocked(listToReturnLoans).mockResolvedValue([]);
    vi.mocked(listCurrentlyReading).mockResolvedValue([]);
    vi.mocked(listRecentlyAdded).mockResolvedValue([]);

    renderHome();

    expect(await screen.findByText(/Overdue — return to Alex/)).toBeInTheDocument();
  });

  it("renders a non-overdue borrowed_in loan under To return, not Overdue", async () => {
    vi.mocked(listOverdueLoans).mockResolvedValue([]);
    vi.mocked(listToReturnLoans).mockResolvedValue([
      makeLoan({ id: "l1", direction: "borrowed_in", due_date: "2099-01-01", overdue: false }),
    ]);
    vi.mocked(listCurrentlyReading).mockResolvedValue([]);
    vi.mocked(listRecentlyAdded).mockResolvedValue([]);

    renderHome();

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

    renderHome();

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

    renderHome();

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

    renderHome();

    await screen.findByRole("heading", { name: "Overdue" });
    const overdueSection = screen.getByRole("heading", { name: "Overdue" }).closest("section")!;
    expect(within(overdueSection).getByRole("link", { name: /See all/ })).toBeInTheDocument();

    const toReturnSection = screen.getByRole("heading", { name: "To return" }).closest("section")!;
    expect(within(toReturnSection).queryByRole("link", { name: /See all/ })).not.toBeInTheDocument();
  });

  it("renders the all-empty prompt when every section resolves with zero rows", async () => {
    mockAllEmpty();

    renderHome();

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

    renderHome();

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

    renderHome();

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

    renderHome();

    await waitFor(() => expect(listOverdueLoans).toHaveBeenCalled());
    expect(screen.queryByText(/Nothing here yet/)).not.toBeInTheDocument();

    slow.resolve([]);
    expect(await screen.findByText(/Nothing here yet/)).toBeInTheDocument();
  });
});
