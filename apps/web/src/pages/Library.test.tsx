import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi, beforeEach, beforeAll } from "vitest";
import { Library } from "./Library.js";
import { api } from "../lib/api.js";
import { useHousehold } from "../lib/household-context.js";

vi.mock("../lib/api.js", () => ({ api: vi.fn() }));
vi.mock("../lib/household-context.js", () => ({ useHousehold: vi.fn() }));

// Radix Select needs these DOM APIs, which jsdom doesn't implement, to open
// its popover and register clicks on options.
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

const bookA = {
  id: "b1",
  ownership: "owned" as const,
  format: "hardcover",
  shelf_id: null,
  do_not_lend: false,
  wishlist_priority: null,
  notes: null,
  edition: { id: "e1", title: "Dune", authors: "Frank Herbert", cover_url: null, isbn: null, language: "en" },
};

// Default mock: /api/tags resolves empty (populates the tag filter), and
// /api/books resolves via whatever handler the test passes in.
function mockApi(booksHandler: (path: string) => unknown, tags: { id: string; name: string; updated_at: string }[] = []) {
  vi.mocked(api).mockImplementation(async (path: string) => {
    if (path.startsWith("/api/tags")) return { tags };
    if (path.startsWith("/api/books")) return booksHandler(path);
    throw new Error(`unexpected call: ${path}`);
  });
}

function renderLibrary() {
  render(
    <MemoryRouter initialEntries={["/library"]}>
      <Library />
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.mocked(api).mockReset();
  vi.mocked(useHousehold).mockReturnValue({
    user: { id: "u1", email: "a@b.com", name: "Ada" },
    household,
  });
});

describe("Library", () => {
  it("renders a list of books from the API", async () => {
    mockApi(() => ({ books: [bookA] }));
    renderLibrary();

    expect(await screen.findByText("Dune")).toBeInTheDocument();
    expect(screen.getByText("Frank Herbert")).toBeInTheDocument();
    expect(api).toHaveBeenCalledWith(`/api/books?householdId=${household.id}`);
  });

  it("debounces the search input before calling the API with q", async () => {
    mockApi(() => ({ books: [] }));
    renderLibrary();

    // Initial fetch on mount.
    await waitFor(() => expect(api).toHaveBeenCalledWith(`/api/books?householdId=${household.id}`));

    await userEvent.type(screen.getByLabelText("Search books"), "dune");

    // Debounced: eventually (250ms later) fires with ?q=dune, not before.
    await waitFor(
      () => expect(api).toHaveBeenLastCalledWith(`/api/books?householdId=${household.id}&q=dune`),
      { timeout: 2000 }
    );
  });

  it("calls the API with ownership when a filter chip is selected", async () => {
    mockApi(() => ({ books: [] }));
    renderLibrary();
    await waitFor(() => expect(api).toHaveBeenCalledWith(`/api/books?householdId=${household.id}`));

    await userEvent.click(screen.getByRole("button", { name: "Owned" }));

    await waitFor(() =>
      expect(api).toHaveBeenLastCalledWith(`/api/books?householdId=${household.id}&ownership=owned`)
    );
  });

  it("calls the API with status when the status filter is changed", async () => {
    mockApi(() => ({ books: [] }));
    renderLibrary();
    await waitFor(() => expect(api).toHaveBeenCalledWith(`/api/books?householdId=${household.id}`));

    await userEvent.click(screen.getByRole("combobox", { name: "Status" }));
    await userEvent.click(await screen.findByRole("option", { name: "Reading" }));

    await waitFor(() =>
      expect(api).toHaveBeenLastCalledWith(`/api/books?householdId=${household.id}&status=reading`)
    );
  });

  it("calls the API with tag when the tag filter is changed, and resets to no param on 'All tags'", async () => {
    mockApi(() => ({ books: [] }), [{ id: "t1", name: "sci-fi", updated_at: "2026-01-01T00:00:00Z" }]);
    renderLibrary();
    await waitFor(() => expect(api).toHaveBeenCalledWith(`/api/books?householdId=${household.id}`));

    await userEvent.click(screen.getByRole("combobox", { name: "Tag" }));
    await userEvent.click(await screen.findByRole("option", { name: "sci-fi" }));

    await waitFor(() =>
      expect(api).toHaveBeenLastCalledWith(`/api/books?householdId=${household.id}&tag=sci-fi`)
    );

    await userEvent.click(screen.getByRole("combobox", { name: "Tag" }));
    await userEvent.click(await screen.findByRole("option", { name: "All tags" }));

    await waitFor(() => expect(api).toHaveBeenLastCalledWith(`/api/books?householdId=${household.id}`));
  });

  it("shows a Load more button when a full page comes back, and appends the next page on click", async () => {
    const fullPage = Array.from({ length: 100 }, (_, i) => ({
      ...bookA,
      id: `b${i}`,
      edition: { ...bookA.edition, title: `Book ${i}` },
    }));
    const secondPage = [{ ...bookA, id: "b100", edition: { ...bookA.edition, title: "Last Book" } }];

    mockApi((path) => (path.includes("offset=") ? { books: secondPage } : { books: fullPage }));
    renderLibrary();

    expect(await screen.findByText("Book 0")).toBeInTheDocument();
    const loadMoreButton = screen.getByRole("button", { name: "Load more" });

    await userEvent.click(loadMoreButton);

    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(`/api/books?householdId=${household.id}&offset=100`)
    );
    expect(await screen.findByText("Last Book")).toBeInTheDocument();
    // The second page was short (1 book, not a full 100), so there's no more to load.
    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
  });

  it("does not show a Load more button when fewer than a full page comes back", async () => {
    mockApi(() => ({ books: [bookA] }));
    renderLibrary();

    expect(await screen.findByText("Dune")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
  });

  it("shows an empty state with a link to /add when there are no books", async () => {
    mockApi(() => ({ books: [] }));
    renderLibrary();

    expect(await screen.findByText("No books yet.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Add your first book" })).toHaveAttribute("href", "/add");
  });

  it("shows a destructive alert when the fetch fails", async () => {
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path.startsWith("/api/tags")) return { tags: [] };
      throw new Error("Network error");
    });
    renderLibrary();

    expect(await screen.findByText(/Couldn't load your books: Network error/)).toBeInTheDocument();
  });
});
