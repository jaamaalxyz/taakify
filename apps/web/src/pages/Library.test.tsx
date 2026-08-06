import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { Library } from "./Library.js";
import { api } from "../lib/api.js";
import { useHousehold } from "../lib/household-context.js";

vi.mock("../lib/api.js", () => ({ api: vi.fn() }));
vi.mock("../lib/household-context.js", () => ({ useHousehold: vi.fn() }));

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
    vi.mocked(api).mockResolvedValueOnce({ books: [bookA] });
    renderLibrary();

    expect(await screen.findByText("Dune")).toBeInTheDocument();
    expect(screen.getByText("Frank Herbert")).toBeInTheDocument();
    expect(api).toHaveBeenCalledWith(`/api/books?householdId=${household.id}`);
  });

  it("debounces the search input before calling the API with q", async () => {
    vi.mocked(api).mockResolvedValue({ books: [] });
    renderLibrary();

    // Initial fetch on mount.
    await waitFor(() => expect(api).toHaveBeenCalledTimes(1));

    await userEvent.type(screen.getByLabelText("Search books"), "dune");

    // Debounced: eventually (250ms later) fires with ?q=dune, not before.
    await waitFor(
      () => expect(api).toHaveBeenLastCalledWith(`/api/books?householdId=${household.id}&q=dune`),
      { timeout: 2000 }
    );
  });

  it("calls the API with ownership when a filter chip is selected", async () => {
    vi.mocked(api).mockResolvedValue({ books: [] });
    renderLibrary();
    await waitFor(() => expect(api).toHaveBeenCalledTimes(1));

    await userEvent.click(screen.getByRole("button", { name: "Owned" }));

    await waitFor(() =>
      expect(api).toHaveBeenLastCalledWith(`/api/books?householdId=${household.id}&ownership=owned`)
    );
  });

  it("shows an empty state with a link to /add when there are no books", async () => {
    vi.mocked(api).mockResolvedValueOnce({ books: [] });
    renderLibrary();

    expect(await screen.findByText("No books yet.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Add your first book" })).toHaveAttribute("href", "/add");
  });

  it("shows a destructive alert when the fetch fails", async () => {
    vi.mocked(api).mockRejectedValueOnce(new Error("Network error"));
    renderLibrary();

    expect(await screen.findByText(/Couldn't load your books: Network error/)).toBeInTheDocument();
  });
});
