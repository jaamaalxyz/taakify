import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi, beforeEach, beforeAll } from "vitest";
import { Library } from "./Library.js";
import { listBooks, type ListBooksOptions } from "../lib/repo/books.js";
import { listTags } from "../lib/repo/tags.js";
import { useHousehold } from "../lib/household-context.js";
import { getSyncStalled } from "../lib/sync/shape.js";

vi.mock("../lib/repo/books.js", () => ({ listBooks: vi.fn() }));
vi.mock("../lib/repo/tags.js", () => ({ listTags: vi.fn() }));
vi.mock("../lib/household-context.js", () => ({ useHousehold: vi.fn() }));
// Library now subscribes to mirror-change notifications (Important finding,
// final whole-branch review) so remote edits refresh the list without a
// manual navigate-away-and-back. shape.js pulls in the real db/pglite.js
// singleton (idb://, browser-only) if not mocked -- stub it to a no-op
// subscription, since these tests only exercise the mount/filter-driven
// fetch, not mirror-change refresh itself.
vi.mock("../lib/sync/shape.js", () => ({
  onMirrorChange: () => () => {},
  getSyncStalled: vi.fn(() => false),
  onSyncStalledChange: () => () => {},
}));

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

// Default mock: listTags resolves empty (populates the tag filter), and
// listBooks resolves via whatever handler the test passes in.
function mockRepo(
  booksHandler: (opts: ListBooksOptions) => unknown,
  tags: { id: string; name: string; updated_at: string }[] = []
) {
  vi.mocked(listTags).mockResolvedValue(tags);
  vi.mocked(listBooks).mockImplementation(async (opts) => booksHandler(opts) as never);
}

function renderLibrary() {
  render(
    <MemoryRouter initialEntries={["/library"]}>
      <Library />
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.mocked(listBooks).mockReset();
  vi.mocked(listTags).mockReset();
  vi.mocked(getSyncStalled).mockReturnValue(false);
  vi.mocked(useHousehold).mockReturnValue({
    user: { id: "u1", email: "a@b.com", name: "Ada" },
    household,
    members: [],
  });
});

describe("Library", () => {
  it("renders a list of books from the repo", async () => {
    mockRepo(() => [bookA]);
    renderLibrary();

    expect(await screen.findByText("Dune")).toBeInTheDocument();
    expect(screen.getByText("Frank Herbert")).toBeInTheDocument();
    expect(listBooks).toHaveBeenCalledWith(
      expect.objectContaining({ householdId: household.id, q: undefined, offset: undefined })
    );
  });

  it("debounces the search input before calling listBooks with q", async () => {
    mockRepo(() => []);
    renderLibrary();

    // Initial fetch on mount.
    await waitFor(() =>
      expect(listBooks).toHaveBeenCalledWith(expect.objectContaining({ q: undefined }))
    );

    await userEvent.type(screen.getByLabelText("Search books"), "dune");

    // Debounced: eventually (250ms later) fires with q: "dune", not before.
    await waitFor(
      () => expect(listBooks).toHaveBeenLastCalledWith(expect.objectContaining({ q: "dune" })),
      { timeout: 2000 }
    );
  });

  it("calls listBooks with ownership when a filter chip is selected", async () => {
    mockRepo(() => []);
    renderLibrary();
    await waitFor(() => expect(listBooks).toHaveBeenCalled());

    await userEvent.click(screen.getByRole("button", { name: "Owned" }));

    await waitFor(() =>
      expect(listBooks).toHaveBeenLastCalledWith(expect.objectContaining({ ownership: "owned" }))
    );
  });

  it("calls listBooks with status and statusUserId when the status filter is changed", async () => {
    mockRepo(() => []);
    renderLibrary();
    await waitFor(() => expect(listBooks).toHaveBeenCalled());

    await userEvent.click(screen.getByRole("combobox", { name: "Status" }));
    await userEvent.click(await screen.findByRole("option", { name: "Reading" }));

    await waitFor(() =>
      expect(listBooks).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: "reading", statusUserId: "u1" })
      )
    );
  });

  it("calls listBooks with tag when the tag filter is changed, and resets to no tag on 'All tags'", async () => {
    mockRepo(() => [], [{ id: "t1", name: "sci-fi", updated_at: "2026-01-01T00:00:00Z" }]);
    renderLibrary();
    await waitFor(() => expect(listBooks).toHaveBeenCalled());

    await userEvent.click(screen.getByRole("combobox", { name: "Tag" }));
    await userEvent.click(await screen.findByRole("option", { name: "sci-fi" }));

    await waitFor(() =>
      expect(listBooks).toHaveBeenLastCalledWith(expect.objectContaining({ tag: "sci-fi" }))
    );

    await userEvent.click(screen.getByRole("combobox", { name: "Tag" }));
    await userEvent.click(await screen.findByRole("option", { name: "All tags" }));

    await waitFor(() =>
      expect(listBooks).toHaveBeenLastCalledWith(expect.objectContaining({ tag: undefined }))
    );
  });

  it("shows a Load more button when a full page comes back, and appends the next page on click", async () => {
    const fullPage = Array.from({ length: 100 }, (_, i) => ({
      ...bookA,
      id: `b${i}`,
      edition: { ...bookA.edition, title: `Book ${i}` },
    }));
    const secondPage = [{ ...bookA, id: "b100", edition: { ...bookA.edition, title: "Last Book" } }];

    mockRepo((opts) => (opts.offset ? secondPage : fullPage));
    renderLibrary();

    expect(await screen.findByText("Book 0")).toBeInTheDocument();
    const loadMoreButton = screen.getByRole("button", { name: "Load more" });

    await userEvent.click(loadMoreButton);

    await waitFor(() => expect(listBooks).toHaveBeenCalledWith(expect.objectContaining({ offset: 100 })));
    expect(await screen.findByText("Last Book")).toBeInTheDocument();
    // The second page was short (1 book, not a full 100), so there's no more to load.
    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
  });

  it("disables Load more while a filter-change refetch is in flight, so it can't fetch the old filter's next page against new results", async () => {
    const fullPage = Array.from({ length: 100 }, (_, i) => ({
      ...bookA,
      id: `b${i}`,
      edition: { ...bookA.edition, title: `Book ${i}` },
    }));

    let resolveRefetch!: (books: unknown[]) => void;
    let callCount = 0;
    vi.mocked(listTags).mockResolvedValue([]);
    vi.mocked(listBooks).mockImplementation(async () => {
      callCount += 1;
      if (callCount === 1) return fullPage as never;
      return new Promise((resolve) => {
        resolveRefetch = resolve as never;
      }) as never;
    });
    renderLibrary();
    expect(await screen.findByText("Book 0")).toBeInTheDocument();
    const loadMoreButton = screen.getByRole("button", { name: "Load more" });
    expect(loadMoreButton).toBeEnabled();

    // Trigger a refetch via an ownership filter change; it never resolves in
    // this test, simulating the window where the new filter's results
    // haven't landed yet.
    await userEvent.click(screen.getByRole("button", { name: "Owned" }));
    await waitFor(() => expect(callCount).toBe(2));

    expect(screen.getByRole("button", { name: "Load more" })).toBeDisabled();

    resolveRefetch([]);
  });

  it("does not show a Load more button when fewer than a full page comes back", async () => {
    mockRepo(() => [bookA]);
    renderLibrary();

    expect(await screen.findByText("Dune")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
  });

  it("shows an empty state with a link to /add when there are no books", async () => {
    mockRepo(() => []);
    renderLibrary();

    expect(await screen.findByText("No books yet.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Add your first book" })).toHaveAttribute("href", "/add");
  });

  it("shows a 'couldn't reach the server' empty state instead of 'No books yet' when sync is stalled", async () => {
    vi.mocked(getSyncStalled).mockReturnValue(true);
    mockRepo(() => []);
    renderLibrary();

    expect(await screen.findByText(/Couldn't reach the server/)).toBeInTheDocument();
    expect(screen.queryByText("No books yet.")).not.toBeInTheDocument();
  });

  it("keeps previously loaded books visible during a refetch instead of flashing back to skeletons", async () => {
    let resolveSecondFetch!: (books: unknown[]) => void;
    let callCount = 0;
    vi.mocked(listTags).mockResolvedValue([]);
    vi.mocked(listBooks).mockImplementation(async () => {
      callCount += 1;
      if (callCount === 1) return [bookA] as never;
      return new Promise((resolve) => {
        resolveSecondFetch = resolve as never;
      }) as never;
    });
    renderLibrary();
    expect(await screen.findByText("Dune")).toBeInTheDocument();

    // Trigger a refetch (ownership filter change re-runs the data-loading effect).
    await userEvent.click(screen.getByRole("button", { name: "Owned" }));
    await waitFor(() => expect(callCount).toBe(2));

    // The second fetch is still pending -- the previously loaded book (and
    // no skeleton grid) should still be showing, not a flash back to loading.
    expect(screen.getByText("Dune")).toBeInTheDocument();
    expect(document.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(0);

    resolveSecondFetch([]);
    await waitFor(() => expect(screen.getByText("No books yet.")).toBeInTheDocument());
  });

  it("shows a destructive alert when the fetch fails", async () => {
    // A plain (non-ApiError) failure renders friendlyError()'s "couldn't
    // connect" copy, not the raw error message.
    vi.mocked(listTags).mockResolvedValue([]);
    vi.mocked(listBooks).mockRejectedValue(new TypeError("PGlite error"));
    renderLibrary();

    expect(
      await screen.findByText(/Couldn't load your books: Couldn't connect/)
    ).toBeInTheDocument();
  });
});
