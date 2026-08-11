import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { describe, expect, it, vi, beforeEach, beforeAll } from "vitest";
import { BookDetail } from "./BookDetail.js";
import { getBook, updateBook, deleteBook } from "../lib/repo/books.js";
import { listReadingStatuses, upsertMyReadingStatus } from "../lib/repo/reading-status.js";
import { listBookTags, findOrCreateTag, attachBookTag, removeBookTag } from "../lib/repo/tags.js";
import { listBookcases } from "../lib/repo/shelves.js";
import { listTags } from "../lib/repo/tags.js";
import { listContacts } from "../lib/repo/contacts.js";
import { listLoans, createLoan, updateLoan } from "../lib/repo/loans.js";
import { useHousehold } from "../lib/household-context.js";
import { toast } from "sonner";

vi.mock("../lib/repo/books.js", () => ({
  getBook: vi.fn(),
  updateBook: vi.fn(),
  deleteBook: vi.fn(),
}));
vi.mock("../lib/repo/reading-status.js", () => ({
  listReadingStatuses: vi.fn(),
  upsertMyReadingStatus: vi.fn(),
}));
vi.mock("../lib/repo/tags.js", () => ({
  listBookTags: vi.fn(),
  findOrCreateTag: vi.fn(),
  attachBookTag: vi.fn(),
  removeBookTag: vi.fn(),
  listTags: vi.fn(),
}));
vi.mock("../lib/repo/shelves.js", () => ({ listBookcases: vi.fn() }));
vi.mock("../lib/repo/contacts.js", () => ({ listContacts: vi.fn() }));
vi.mock("../lib/repo/loans.js", () => ({
  listLoans: vi.fn(),
  createLoan: vi.fn(),
  updateLoan: vi.fn(),
}));
vi.mock("../lib/household-context.js", () => ({ useHousehold: vi.fn() }));
vi.mock("sonner", () => ({ toast: vi.fn() }));

const navigateMock = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return { ...actual, useNavigate: () => navigateMock };
});

// Radix Select/Dialog/DropdownMenu need these DOM APIs, which jsdom doesn't
// implement, to open their popovers and register clicks on options.
beforeAll(() => {
  Element.prototype.hasPointerCapture = Element.prototype.hasPointerCapture ?? (() => false);
  Element.prototype.setPointerCapture = Element.prototype.setPointerCapture ?? (() => {});
  Element.prototype.releasePointerCapture = Element.prototype.releasePointerCapture ?? (() => {});
  Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? (() => {});
  window.ResizeObserver =
    window.ResizeObserver ??
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
});

const household = { id: "h1", name: "Family Library", role: "owner" };
const user = { id: "u1", email: "a@b.com", name: "Ada" };
const members = [
  { id: "u1", name: "Ada", email: "a@b.com", role: "owner" },
  { id: "u2", name: "Grace", email: "g@b.com", role: "member" },
];

const book = {
  id: "b1",
  ownership: "owned" as const,
  format: null,
  shelf_id: null,
  do_not_lend: false,
  wishlist_priority: null,
  notes: null,
  updated_at: "2026-01-01T00:00:00Z",
  edition: {
    id: "e1",
    title: "Dune",
    authors: "Frank Herbert",
    cover_url: null,
    isbn: "9780000000001",
    language: "en",
  },
};

const statuses = [
  {
    id: "rs1",
    book_id: "b1",
    user_id: "u1",
    status: "reading" as const,
    started_at: null,
    finished_at: null,
    rating: null,
    review_note: null,
    updated_at: "2026-01-01T00:00:00Z",
  },
  {
    id: "rs2",
    book_id: "b1",
    user_id: "u2",
    status: "finished" as const,
    started_at: null,
    finished_at: null,
    rating: 5,
    review_note: null,
    updated_at: "2026-01-01T00:00:00Z",
  },
];

const bookcase = {
  id: "bc1",
  name: "Living Room",
  updated_at: "2026-01-01T00:00:00Z",
  shelves: [{ id: "s1", position: 0, label: "Top Shelf", updated_at: "2026-01-01T00:00:00Z" }],
};

function mockRepo({
  bookOverride,
  statusList = statuses,
  tags = [],
  bookTags: initialBookTags = [],
  bookcases = [bookcase],
  loans = [] as unknown[],
  contacts = [],
}: {
  bookOverride?: Partial<typeof book>;
  statusList?: typeof statuses;
  tags?: { id: string; name: string; updated_at: string }[];
  bookTags?: { id: string; name: string; updated_at: string }[];
  bookcases?: (typeof bookcase)[];
  loans?: unknown[];
  contacts?: { id: string; name: string }[];
} = {}) {
  const book1 = bookOverride ? { ...book, ...bookOverride } : book;
  vi.mocked(getBook).mockResolvedValue(book1);
  vi.mocked(listReadingStatuses).mockResolvedValue(statusList);
  vi.mocked(listTags).mockResolvedValue(tags);
  vi.mocked(listBookcases).mockResolvedValue(bookcases);
  vi.mocked(listLoans).mockResolvedValue(loans as never);
  vi.mocked(listContacts).mockResolvedValue(contacts as never);
  vi.mocked(updateBook).mockResolvedValue(undefined);
  vi.mocked(deleteBook).mockResolvedValue(undefined);
  vi.mocked(upsertMyReadingStatus).mockResolvedValue(undefined);
  vi.mocked(updateLoan).mockResolvedValue(undefined);

  // Tracks the book's currently-attached tags across listBookTags,
  // findOrCreateTag, attachBookTag, and removeBookTag calls, mirroring how
  // the real mirror table would reflect an add/remove immediately —
  // BookDetail.tsx refetches via listBookTags() after each mutation.
  const tagsById = new Map(tags.map((t) => [t.id, t]));
  let currentBookTags = [...initialBookTags];
  for (const t of initialBookTags) tagsById.set(t.id, t);

  vi.mocked(listBookTags).mockImplementation(async () => currentBookTags);
  vi.mocked(findOrCreateTag).mockImplementation(async (_h, name) => {
    const existing = [...tagsById.values()].find((t) => t.name === name);
    if (existing) return existing;
    const tag = { id: "t1", name, updated_at: "2026-01-01T00:00:00Z" };
    tagsById.set(tag.id, tag);
    return tag;
  });
  vi.mocked(attachBookTag).mockImplementation(async (_bookId, _householdId, tagId) => {
    const tag = tagsById.get(tagId);
    if (tag && !currentBookTags.some((t) => t.id === tag.id)) currentBookTags = [...currentBookTags, tag];
  });
  vi.mocked(removeBookTag).mockImplementation(async (_bookId, tagId) => {
    currentBookTags = currentBookTags.filter((t) => t.id !== tagId);
  });
  vi.mocked(createLoan).mockResolvedValue("l1");
}

function renderBookDetail() {
  render(
    <MemoryRouter initialEntries={["/library/b1"]}>
      <Routes>
        <Route path="/library/:bookId" element={<BookDetail />} />
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.mocked(getBook).mockReset();
  vi.mocked(updateBook).mockReset();
  vi.mocked(deleteBook).mockReset();
  vi.mocked(listReadingStatuses).mockReset();
  vi.mocked(upsertMyReadingStatus).mockReset();
  vi.mocked(listBookTags).mockReset();
  vi.mocked(findOrCreateTag).mockReset();
  vi.mocked(attachBookTag).mockReset();
  vi.mocked(removeBookTag).mockReset();
  vi.mocked(listBookcases).mockReset();
  vi.mocked(listTags).mockReset();
  vi.mocked(listContacts).mockReset();
  vi.mocked(listLoans).mockReset();
  vi.mocked(createLoan).mockReset();
  vi.mocked(updateLoan).mockReset();
  vi.mocked(toast).mockReset();
  navigateMock.mockReset();
  vi.mocked(useHousehold).mockReturnValue({ user, household, members });
});

describe("BookDetail", () => {
  it("loads the book and all members' statuses and renders them", async () => {
    mockRepo();
    renderBookDetail();

    expect(await screen.findByText("Dune")).toBeInTheDocument();
    expect(screen.getByText("Frank Herbert")).toBeInTheDocument();
    expect(screen.getByText(/9780000000001/)).toBeInTheDocument();
    expect(await screen.findByText("You:")).toBeInTheDocument();
    expect(screen.getByText("Grace:")).toBeInTheDocument();
    expect(screen.queryByText(/Member \(/)).not.toBeInTheDocument();
  });

  it("shows a load error when the book fetch fails", async () => {
    mockRepo();
    vi.mocked(getBook).mockRejectedValue(new Error("boom"));
    renderBookDetail();

    expect(
      await screen.findByText(/Couldn't load this book: Couldn't connect/)
    ).toBeInTheDocument();
  });

  it("editing my status calls upsertMyReadingStatus", async () => {
    mockRepo();
    renderBookDetail();
    await screen.findByText("Dune");

    await userEvent.clear(screen.getByLabelText("Rating (1-5)"));
    await userEvent.type(screen.getByLabelText("Rating (1-5)"), "4");
    await userEvent.type(screen.getByLabelText("Review note"), "Great book");
    await userEvent.click(screen.getByRole("button", { name: "Save status" }));

    await waitFor(() =>
      expect(upsertMyReadingStatus).toHaveBeenCalledWith(
        "b1",
        "u1",
        expect.objectContaining({ rating: 4 })
      )
    );
    expect(toast).toHaveBeenCalledWith("Status updated");
  });

  it("loads tags already on the book from listBookTags (persists across reload)", async () => {
    mockRepo({ bookTags: [{ id: "t9", name: "classic", updated_at: "2026-01-01T00:00:00Z" }] });
    renderBookDetail();
    await screen.findByText("Dune");

    expect(await screen.findByText("classic")).toBeInTheDocument();
  });

  it("shows an empty-tags message when the book has no tags yet", async () => {
    mockRepo();
    renderBookDetail();
    await screen.findByText("Dune");

    expect(await screen.findByText("No tags on this book yet.")).toBeInTheDocument();
  });

  it("adding a tag calls findOrCreateTag then attachBookTag", async () => {
    mockRepo();
    renderBookDetail();
    await screen.findByText("Dune");

    await userEvent.type(screen.getByLabelText("Or new tag"), "sci-fi");
    await userEvent.click(screen.getByRole("button", { name: "Add tag" }));

    await waitFor(() => expect(findOrCreateTag).toHaveBeenCalledWith("h1", "sci-fi", "u1"));
    await waitFor(() => expect(attachBookTag).toHaveBeenCalledWith("b1", "h1", "t1"));
    expect(await screen.findByText("sci-fi")).toBeInTheDocument();
  });

  it("removing an added tag calls removeBookTag", async () => {
    mockRepo();
    renderBookDetail();
    await screen.findByText("Dune");

    await userEvent.type(screen.getByLabelText("Or new tag"), "sci-fi");
    await userEvent.click(screen.getByRole("button", { name: "Add tag" }));
    expect(await screen.findByText("sci-fi")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Remove tag sci-fi" }));

    await waitFor(() => expect(removeBookTag).toHaveBeenCalledWith("b1", "t1"));
    expect(toast).toHaveBeenCalledWith('Removed tag "sci-fi"');
  });

  it("move-shelf action calls updateBook with the selected shelf_id", async () => {
    mockRepo();
    renderBookDetail();
    await screen.findByText("Dune");

    await userEvent.click(screen.getByRole("button", { name: "Actions" }));
    await userEvent.click(await screen.findByText("Move shelf"));

    await userEvent.click(await screen.findByRole("combobox", { name: "Shelf" }));
    await userEvent.click(await screen.findByRole("option", { name: /Top Shelf/ }));
    await userEvent.click(screen.getByRole("button", { name: "Move" }));

    await waitFor(() => expect(updateBook).toHaveBeenCalledWith("b1", { shelf_id: "s1" }));
    expect(toast).toHaveBeenCalledWith("Shelf updated");
  });

  it("edit-details action calls updateBook with the edited fields", async () => {
    mockRepo();
    renderBookDetail();
    await screen.findByText("Dune");

    await userEvent.click(screen.getByRole("button", { name: "Actions" }));
    await userEvent.click(await screen.findByText("Edit details"));

    await userEvent.type(await screen.findByLabelText("Notes"), "Great condition");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() =>
      expect(updateBook).toHaveBeenCalledWith("b1", {
        ownership: "owned",
        notes: "Great condition",
        do_not_lend: false,
        wishlist_priority: null,
      })
    );
    expect(toast).toHaveBeenCalledWith("Book updated");
  });

  it("delete action calls deleteBook and navigates to /library", async () => {
    mockRepo();
    renderBookDetail();
    await screen.findByText("Dune");

    await userEvent.click(screen.getByRole("button", { name: "Actions" }));
    await userEvent.click(await screen.findByText("Delete"));
    await userEvent.click(await screen.findByRole("button", { name: "Delete" }));

    await waitFor(() => expect(deleteBook).toHaveBeenCalledWith("b1"));
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith("/library"));
  });

  it("shows the active loan status with contact, due date, and overdue badge", async () => {
    mockRepo({
      loans: [
        {
          id: "l1",
          direction: "lent_out",
          due_date: "2026-01-01",
          returned_date: null,
          overdue: true,
          contact: { id: "c1", name: "Alex" },
        },
      ],
    });
    renderBookDetail();
    await screen.findByText("Dune");

    expect(await screen.findByText(/Lent out · Alex · due 2026-01-01/)).toBeInTheDocument();
    expect(screen.getByText("Overdue")).toBeInTheDocument();
  });

  it("no active loan: no loan banner, and 'Lend out' menu item is present", async () => {
    mockRepo();
    renderBookDetail();
    await screen.findByText("Dune");

    expect(screen.queryByText("Overdue")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Actions" }));
    expect(await screen.findByText("Lend out")).toBeInTheDocument();
  });

  it("with an active loan: 'Lend out' menu item is absent", async () => {
    mockRepo({
      loans: [
        {
          id: "l1",
          direction: "lent_out",
          due_date: null,
          returned_date: null,
          overdue: false,
          contact: { id: "c1", name: "Alex" },
        },
      ],
    });
    renderBookDetail();
    await screen.findByText("Dune");
    await screen.findByText(/Lent out · Alex/);

    await userEvent.click(screen.getByRole("button", { name: "Actions" }));
    expect(screen.queryByText("Lend out")).not.toBeInTheDocument();
  });

  it("submitting the lend dialog calls createLoan with bookId and no book picker", async () => {
    mockRepo();
    renderBookDetail();
    await screen.findByText("Dune");

    await userEvent.click(screen.getByRole("button", { name: "Actions" }));
    await userEvent.click(await screen.findByText("Lend out"));

    expect(screen.queryByLabelText("Book")).not.toBeInTheDocument();
    await userEvent.type(await screen.findByLabelText("New contact name"), "Alex");
    await userEvent.click(screen.getByRole("button", { name: "Record loan" }));

    await waitFor(() =>
      expect(createLoan).toHaveBeenCalledWith({
        bookId: "b1",
        direction: "lent_out",
        dueDate: undefined,
        contactId: undefined,
        contactName: "Alex",
        createdBy: "u1",
      })
    );
    expect(toast).toHaveBeenCalledWith("Loan recorded");
  });

  it("contacts are only fetched when the lend dialog opens, and a newly-created contact is selectable without a reload", async () => {
    mockRepo({ contacts: [{ id: "c1", name: "Alex" }] });
    renderBookDetail();
    await screen.findByText("Dune");

    // Contacts must not be fetched just from mounting the page.
    expect(listContacts).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Actions" }));
    await userEvent.click(await screen.findByText("Lend out"));

    // Choosing "Lend out" triggers the (now lazy) contacts fetch.
    await waitFor(() => expect(listContacts).toHaveBeenCalledWith("h1"));

    await userEvent.type(await screen.findByLabelText("New contact name"), "Sam");
    await userEvent.click(screen.getByRole("button", { name: "Record loan" }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Loan recorded"));

    await waitFor(() => {
      expect(vi.mocked(listContacts).mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });

  it("clicking 'Mark returned' calls updateLoan and the active-loan banner disappears", async () => {
    let returned = false;
    mockRepo();
    vi.mocked(listLoans).mockImplementation(async () =>
      returned
        ? []
        : ([
            {
              id: "l1",
              direction: "lent_out",
              due_date: null,
              returned_date: null,
              overdue: false,
              contact: { id: "c1", name: "Alex" },
            },
          ] as never)
    );
    vi.mocked(updateLoan).mockImplementation(async () => {
      returned = true;
    });
    renderBookDetail();
    await screen.findByText("Dune");
    await screen.findByText(/Lent out · Alex/);

    await userEvent.click(screen.getByRole("button", { name: "Mark returned" }));

    await waitFor(() =>
      expect(updateLoan).toHaveBeenCalledWith("l1", expect.objectContaining({ returned_date: expect.any(String) }))
    );
    expect(toast).toHaveBeenCalledWith("Marked as returned");
    await waitFor(() => expect(screen.queryByText(/Lent out · Alex/)).not.toBeInTheDocument());
  });

  it("lending a do-not-lend book shows a warning and hides the form until acknowledged", async () => {
    mockRepo({ bookOverride: { do_not_lend: true } });
    renderBookDetail();
    await screen.findByText("Dune");

    await userEvent.click(screen.getByRole("button", { name: "Actions" }));
    await userEvent.click(await screen.findByText("Lend out"));

    expect(screen.getByText(/marked “do not lend.” Lend it anyway\?/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Direction")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Contact")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Record loan" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Lend anyway" })).toBeInTheDocument();
  });

  it("confirming the do-not-lend warning reveals the form and allows the loan", async () => {
    mockRepo({ bookOverride: { do_not_lend: true } });
    renderBookDetail();
    await screen.findByText("Dune");

    await userEvent.click(screen.getByRole("button", { name: "Actions" }));
    await userEvent.click(await screen.findByText("Lend out"));

    await userEvent.click(screen.getByRole("button", { name: "Lend anyway" }));

    await userEvent.type(await screen.findByLabelText("New contact name"), "Alex");
    await userEvent.click(screen.getByRole("button", { name: "Record loan" }));

    await waitFor(() => expect(createLoan).toHaveBeenCalled());
    expect(toast).toHaveBeenCalledWith("Loan recorded");
  });
});
