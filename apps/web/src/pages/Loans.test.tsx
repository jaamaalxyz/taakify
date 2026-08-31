import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi, beforeEach, beforeAll } from "vitest";
import { Loans } from "./Loans.js";
import { listLoans, createLoan, updateLoan } from "../lib/repo/loans.js";
import { listContacts, createContact, updateContact } from "../lib/repo/contacts.js";
import { listBooks } from "../lib/repo/books.js";
import { useHousehold } from "../lib/household-context.js";
import { toast } from "sonner";

vi.mock("../lib/repo/loans.js", () => ({
  listLoans: vi.fn(),
  createLoan: vi.fn(),
  updateLoan: vi.fn(),
}));
vi.mock("../lib/repo/contacts.js", () => ({
  listContacts: vi.fn(),
  createContact: vi.fn(),
  updateContact: vi.fn(),
}));
vi.mock("../lib/repo/books.js", () => ({ listBooks: vi.fn() }));
vi.mock("../lib/household-context.js", () => ({ useHousehold: vi.fn() }));
// See Library.test.tsx's comment on the same mock — Loans now subscribes to
// mirror-change notifications too (Important finding, final whole-branch
// review).
vi.mock("../lib/sync/shape.js", () => ({ onMirrorChange: () => () => {} }));
// Issue #16's "Unsynced" badge -- mocked to a controllable Set, same
// rationale as Library.test.tsx.
const unsyncedLoanIds = vi.hoisted(() => new Set<string>());
vi.mock("../lib/sync/use-unsynced-ids.js", () => ({ useUnsyncedIds: () => unsyncedLoanIds }));
vi.mock("sonner", () => ({ toast: vi.fn() }));

// Radix Select/Dialog need these DOM APIs, which jsdom doesn't implement.
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

const activeLoan = {
  id: "l1",
  household_id: "h1",
  direction: "lent_out" as const,
  out_date: "2026-01-01",
  due_date: "2026-01-10",
  returned_date: null as string | null,
  notes: null,
  updated_at: "2026-01-01T00:00:00Z",
  overdue: true,
  book: {
    id: "b1",
    ownership: "owned" as const,
    format: null,
    shelf_id: null,
    do_not_lend: false,
    wishlist_priority: null,
    edition: { id: "e1", title: "Dune", authors: "Frank Herbert", cover_url: null, isbn: null, language: "en" },
  },
  contact: { id: "c1", name: "Alice" },
};

const returnedLoan = {
  ...activeLoan,
  id: "l2",
  returned_date: "2026-01-05",
  overdue: false,
  book: { ...activeLoan.book, id: "b2", edition: { ...activeLoan.book.edition, title: "Foundation" } },
};

function mockRepo({
  loans = [activeLoan],
  contacts = [{ id: "c1", name: "Alice", phone: null, email: null }],
  books = [{ id: "b1", edition: { title: "Dune", authors: "Frank Herbert" } }],
}: {
  loans?: (typeof activeLoan)[];
  contacts?: { id: string; name: string; phone: string | null; email: string | null }[];
  books?: { id: string; edition: { title: string; authors: string } }[];
} = {}) {
  vi.mocked(listLoans).mockResolvedValue(loans as never);
  vi.mocked(listContacts).mockResolvedValue(contacts as never);
  vi.mocked(listBooks).mockResolvedValue(books as never);
  vi.mocked(createLoan).mockResolvedValue("l3");
  vi.mocked(updateLoan).mockResolvedValue(undefined);
  vi.mocked(createContact).mockResolvedValue("c2");
  vi.mocked(updateContact).mockResolvedValue(undefined);
}

function renderLoans() {
  render(
    <MemoryRouter initialEntries={["/loans"]}>
      <Loans />
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.mocked(listLoans).mockReset();
  vi.mocked(createLoan).mockReset();
  vi.mocked(updateLoan).mockReset();
  vi.mocked(listContacts).mockReset();
  vi.mocked(createContact).mockReset();
  vi.mocked(updateContact).mockReset();
  vi.mocked(listBooks).mockReset();
  vi.mocked(toast).mockReset();
  vi.mocked(useHousehold).mockReturnValue({ user, household, members: [] });
  unsyncedLoanIds.clear();
});

describe("Loans", () => {
  it("renders the active loans list with an overdue badge", async () => {
    mockRepo();
    renderLoans();

    expect(await screen.findByText("Dune")).toBeInTheDocument();
    expect(screen.getByText(/Lent out.*Alice/)).toBeInTheDocument();
    expect(screen.getByText("Overdue")).toBeInTheDocument();
  });

  it("shows an Unsynced badge on a loan whose id is in the unsynced set (issue #16)", async () => {
    unsyncedLoanIds.add("l1");
    mockRepo();
    renderLoans();

    const loanItem = (await screen.findByText("Dune")).closest("li");
    expect(loanItem).not.toBeNull();
    expect(loanItem!.textContent).toContain("Unsynced");
  });

  it("marking a loan returned calls updateLoan and moves it out of the active list", async () => {
    mockRepo();
    renderLoans();
    await screen.findByText("Dune");

    await userEvent.click(screen.getByRole("button", { name: "Mark returned" }));

    await waitFor(() =>
      expect(updateLoan).toHaveBeenCalledWith(
        "l1",
        expect.objectContaining({ returned_date: expect.any(String) })
      )
    );
    expect(toast).toHaveBeenCalledWith("Marked as returned");
  });

  it("marking a loan returned builds the date from local Date components, not toISOString()", async () => {
    // toISOString() renders in UTC, which can be the wrong calendar day in
    // any non-UTC timezone. Assert the implementation never calls it, and
    // that the payload matches a date built the same way dateStr() does
    // server-side (local getFullYear/getMonth/getDate), not a UTC slice.
    const isoSpy = vi.spyOn(Date.prototype, "toISOString");
    mockRepo();
    renderLoans();
    await screen.findByText("Dune");

    await userEvent.click(screen.getByRole("button", { name: "Mark returned" }));

    const now = new Date();
    const expected = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(
      now.getDate()
    ).padStart(2, "0")}`;

    await waitFor(() => expect(updateLoan).toHaveBeenCalledWith("l1", { returned_date: expected }));
    expect(isoSpy).not.toHaveBeenCalled();
    isoSpy.mockRestore();
  });

  it("shows returned loans in history, not active", async () => {
    mockRepo({ loans: [returnedLoan] });
    renderLoans();

    expect(await screen.findByText("Foundation")).toBeInTheDocument();
    expect(screen.getByText("No active loans.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Mark returned" })).not.toBeInTheDocument();
  });

  it("shows a destructive alert when loading loans fails", async () => {
    // A repo-layer failure renders friendlyError()'s generic "couldn't
    // connect" fallback, not the raw error message.
    vi.mocked(listLoans).mockRejectedValue(new Error("boom"));
    vi.mocked(listContacts).mockResolvedValue([]);
    vi.mocked(listBooks).mockResolvedValue([]);
    renderLoans();

    expect(await screen.findByText(/Couldn't load loans: Couldn't connect/)).toBeInTheDocument();
  });

  it("creating a new contact calls createContact", async () => {
    mockRepo();
    renderLoans();
    await screen.findByText("Dune");

    await userEvent.click(screen.getByRole("button", { name: "Contacts" }));
    await userEvent.type(await screen.findByLabelText("Name"), "Bob");
    await userEvent.click(screen.getByRole("button", { name: "Add contact" }));

    await waitFor(() =>
      expect(createContact).toHaveBeenCalledWith({
        householdId: "h1",
        name: "Bob",
        phone: undefined,
        email: undefined,
        createdBy: "u1",
      })
    );
    expect(toast).toHaveBeenCalledWith('Added contact "Bob"');
  });

  it("editing an existing contact calls updateContact with the updated fields", async () => {
    mockRepo();
    renderLoans();
    await screen.findByText("Dune");

    await userEvent.click(screen.getByRole("button", { name: "Contacts" }));
    // Clicking an existing contact in the list pre-fills the same form for
    // editing rather than opening a second dialog.
    await userEvent.click(await screen.findByRole("button", { name: "Alice" }));
    expect(screen.getByLabelText("Name")).toHaveValue("Alice");

    const nameInput = screen.getByLabelText("Name");
    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, "Alice Cooper");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() =>
      expect(updateContact).toHaveBeenCalledWith("c1", { name: "Alice Cooper", phone: null, email: null })
    );
    expect(toast).toHaveBeenCalledWith('Updated contact "Alice Cooper"');
  });

  it("shows an inline notice in the Add loan dialog when the book/contact pickers fail to load", async () => {
    vi.mocked(listLoans).mockResolvedValue([activeLoan] as never);
    vi.mocked(listContacts).mockRejectedValue(new Error("contacts down"));
    vi.mocked(listBooks).mockResolvedValue([]);
    renderLoans();
    await screen.findByText("Dune");

    await userEvent.click(screen.getByRole("button", { name: "Add loan" }));

    expect(
      await screen.findByText(/Couldn't load contacts, so the contact picker may be empty/)
    ).toBeInTheDocument();
  });

  it("recording a loan calls createLoan", async () => {
    mockRepo();
    renderLoans();
    await screen.findByText("Dune");

    await userEvent.click(screen.getByRole("button", { name: "Add loan" }));

    await userEvent.click(await screen.findByRole("combobox", { name: "Book" }));
    await userEvent.click(await screen.findByRole("option", { name: "Dune" }));

    await userEvent.click(screen.getByRole("combobox", { name: "Contact" }));
    await userEvent.click(await screen.findByRole("option", { name: "Alice" }));

    await userEvent.click(screen.getByRole("button", { name: "Record loan" }));

    await waitFor(() =>
      expect(createLoan).toHaveBeenCalledWith({
        bookId: "b1",
        direction: "lent_out",
        dueDate: undefined,
        contactId: "c1",
        contactName: undefined,
        createdBy: "u1",
      })
    );
    expect(toast).toHaveBeenCalledWith("Loan recorded");
  });
});
