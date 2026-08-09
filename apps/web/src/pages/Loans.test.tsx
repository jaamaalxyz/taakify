import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi, beforeEach, beforeAll } from "vitest";
import { Loans } from "./Loans.js";
import { api, ApiError } from "../lib/api.js";
import { useHousehold } from "../lib/household-context.js";
import { toast } from "sonner";

vi.mock("../lib/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api.js")>();
  return { ...actual, api: vi.fn() };
});
vi.mock("../lib/household-context.js", () => ({ useHousehold: vi.fn() }));
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
    ownership: "owned",
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

function mockApi({
  loans = [activeLoan],
  contacts = [{ id: "c1", name: "Alice", phone: null, email: null }],
  books = [{ id: "b1", edition: { title: "Dune", authors: "Frank Herbert" } }],
  patchLoan,
  postLoan,
  postContact,
  patchContact,
}: {
  loans?: (typeof activeLoan)[];
  contacts?: { id: string; name: string; phone: string | null; email: string | null }[];
  books?: { id: string; edition: { title: string; authors: string } }[];
  patchLoan?: (body: Record<string, unknown>) => unknown;
  postLoan?: (body: Record<string, unknown>) => unknown;
  postContact?: (body: Record<string, unknown>) => unknown;
  patchContact?: (body: Record<string, unknown>) => unknown;
} = {}) {
  vi.mocked(api).mockImplementation(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (path.startsWith("/api/loans") && method === "GET") return { loans };
    if (path.startsWith("/api/contacts") && method === "GET") return { contacts };
    if (path.startsWith("/api/books") && method === "GET") return { books };
    if (path.startsWith("/api/loans/") && method === "PATCH") {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      return patchLoan ? patchLoan(body) : { loan: { ...loans[0], ...body } };
    }
    if (path === "/api/loans" && method === "POST") {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      return postLoan ? postLoan(body) : { loan: { ...activeLoan, ...body } };
    }
    if (path === "/api/contacts" && method === "POST") {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      return postContact
        ? postContact(body)
        : { contact: { id: "c2", name: body.name, phone: body.phone ?? null, email: body.email ?? null } };
    }
    if (path.startsWith("/api/contacts/") && method === "PATCH") {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      return patchContact
        ? patchContact(body)
        : { contact: { ...contacts[0], ...body } };
    }
    throw new Error(`unexpected call: ${method} ${path}`);
  });
}

function renderLoans() {
  render(
    <MemoryRouter initialEntries={["/loans"]}>
      <Loans />
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.mocked(api).mockReset();
  vi.mocked(toast).mockReset();
  vi.mocked(useHousehold).mockReturnValue({ user, household, members: [] });
});

describe("Loans", () => {
  it("renders the active loans list with an overdue badge", async () => {
    mockApi();
    renderLoans();

    expect(await screen.findByText("Dune")).toBeInTheDocument();
    expect(screen.getByText(/Lent out.*Alice/)).toBeInTheDocument();
    expect(screen.getByText("Overdue")).toBeInTheDocument();
  });

  it("marking a loan returned calls PATCH and moves it out of the active list", async () => {
    mockApi();
    renderLoans();
    await screen.findByText("Dune");

    await userEvent.click(screen.getByRole("button", { name: "Mark returned" }));

    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(
        "/api/loans/l1",
        expect.objectContaining({
          method: "PATCH",
          body: expect.stringContaining('"returned_date"'),
        })
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
    mockApi();
    renderLoans();
    await screen.findByText("Dune");

    await userEvent.click(screen.getByRole("button", { name: "Mark returned" }));

    const now = new Date();
    const expected = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(
      now.getDate()
    ).padStart(2, "0")}`;

    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(
        "/api/loans/l1",
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ returned_date: expected }),
        })
      )
    );
    expect(isoSpy).not.toHaveBeenCalled();
    isoSpy.mockRestore();
  });

  it("shows returned loans in history, not active", async () => {
    mockApi({ loans: [returnedLoan] });
    renderLoans();

    expect(await screen.findByText("Foundation")).toBeInTheDocument();
    expect(screen.getByText("No active loans.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Mark returned" })).not.toBeInTheDocument();
  });

  it("shows a destructive alert when loading loans fails", async () => {
    // An unmapped 500 renders friendlyError()'s generic fallback, not the
    // raw server message.
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path.startsWith("/api/loans")) throw new ApiError("boom", 500);
      if (path.startsWith("/api/contacts")) return { contacts: [] };
      if (path.startsWith("/api/books")) return { books: [] };
      throw new Error("unexpected");
    });
    renderLoans();

    expect(await screen.findByText(/Couldn't load loans: Something went wrong/)).toBeInTheDocument();
  });

  it("creating a new contact calls POST /api/contacts", async () => {
    mockApi();
    renderLoans();
    await screen.findByText("Dune");

    await userEvent.click(screen.getByRole("button", { name: "Contacts" }));
    await userEvent.type(await screen.findByLabelText("Name"), "Bob");
    await userEvent.click(screen.getByRole("button", { name: "Add contact" }));

    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(
        "/api/contacts",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ householdId: "h1", name: "Bob" }),
        })
      )
    );
    expect(toast).toHaveBeenCalledWith('Added contact "Bob"');
  });

  it("editing an existing contact calls PATCH /api/contacts/:id with the updated fields", async () => {
    mockApi();
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
      expect(api).toHaveBeenCalledWith(
        "/api/contacts/c1",
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ name: "Alice Cooper", phone: null, email: null }),
        })
      )
    );
    expect(toast).toHaveBeenCalledWith('Updated contact "Alice Cooper"');
  });

  it("shows an inline notice in the Add loan dialog when the book/contact pickers fail to load", async () => {
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path.startsWith("/api/loans")) return { loans: [activeLoan] };
      if (path.startsWith("/api/contacts")) throw new Error("contacts down");
      if (path.startsWith("/api/books")) return { books: [] };
      throw new Error("unexpected");
    });
    renderLoans();
    await screen.findByText("Dune");

    await userEvent.click(screen.getByRole("button", { name: "Add loan" }));

    expect(
      await screen.findByText(/Couldn't load contacts, so the contact picker may be empty/)
    ).toBeInTheDocument();
  });

  it("recording a loan calls POST /api/loans", async () => {
    mockApi();
    renderLoans();
    await screen.findByText("Dune");

    await userEvent.click(screen.getByRole("button", { name: "Add loan" }));

    await userEvent.click(await screen.findByRole("combobox", { name: "Book" }));
    await userEvent.click(await screen.findByRole("option", { name: "Dune" }));

    await userEvent.click(screen.getByRole("combobox", { name: "Contact" }));
    await userEvent.click(await screen.findByRole("option", { name: "Alice" }));

    await userEvent.click(screen.getByRole("button", { name: "Record loan" }));

    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(
        "/api/loans",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ bookId: "b1", direction: "lent_out", contactId: "c1" }),
        })
      )
    );
    expect(toast).toHaveBeenCalledWith("Loan recorded");
  });
});
