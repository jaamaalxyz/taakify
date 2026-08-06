import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi, beforeEach, beforeAll } from "vitest";
import { Add } from "./Add.js";
import { api } from "../lib/api.js";
import { useHousehold } from "../lib/household-context.js";
import { toast } from "sonner";

vi.mock("../lib/api.js", () => ({ api: vi.fn() }));
vi.mock("../lib/household-context.js", () => ({ useHousehold: vi.fn() }));
vi.mock("sonner", () => ({ toast: vi.fn() }));

// Radix Select needs these DOM APIs, which jsdom doesn't implement, to open
// its popover and register clicks on options.
beforeAll(() => {
  Element.prototype.hasPointerCapture = Element.prototype.hasPointerCapture ?? (() => false);
  Element.prototype.setPointerCapture = Element.prototype.setPointerCapture ?? (() => {});
  Element.prototype.releasePointerCapture = Element.prototype.releasePointerCapture ?? (() => {});
  Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? (() => {});
  // jsdom has no ResizeObserver; Radix Select's internal size hook needs one.
  window.ResizeObserver =
    window.ResizeObserver ??
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
});

const household = { id: "h1", name: "Family Library", role: "owner" };

const bookcase = {
  id: "bc1",
  name: "Living Room",
  updated_at: "2026-01-01T00:00:00Z",
  shelves: [{ id: "s1", position: 0, label: "Top Shelf", updated_at: "2026-01-01T00:00:00Z" }],
};

function mockApi({
  lookup,
  books,
}: {
  lookup?: () => unknown;
  books?: (body: Record<string, unknown>) => unknown;
} = {}) {
  vi.mocked(api).mockImplementation(async (path: string, init?: RequestInit) => {
    if (path.startsWith("/api/bookcases")) return { bookcases: [bookcase] };
    if (path.startsWith("/api/editions/lookup")) {
      if (lookup) return lookup();
      throw new Error("not found");
    }
    if (path === "/api/books") {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      return books ? books(body) : { book: {} };
    }
    throw new Error(`unexpected path: ${path}`);
  });
}

function renderAdd() {
  render(
    <MemoryRouter initialEntries={["/add"]}>
      <Add />
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.mocked(api).mockReset();
  vi.mocked(toast).mockReset();
  vi.mocked(useHousehold).mockReturnValue({
    user: { id: "u1", email: "a@b.com", name: "Ada" },
    household,
  });
});

describe("Add", () => {
  it("looks up an ISBN and pre-fills the title on a hit", async () => {
    mockApi({
      lookup: () => ({
        isbn: "9780000000001",
        title: "Dune",
        authors: "Frank Herbert",
        language: "en",
        cover_url: "https://example.com/dune.jpg",
      }),
    });
    renderAdd();

    await userEvent.type(screen.getByLabelText("ISBN", { selector: "#add-isbn-lookup" }), "9780000000001");
    await userEvent.click(screen.getByRole("button", { name: "Look up" }));

    await waitFor(() =>
      expect(api).toHaveBeenCalledWith("/api/editions/lookup?isbn=9780000000001")
    );
    expect(await screen.findByLabelText("Title")).toHaveValue("Dune");
    expect(screen.getByLabelText("Authors")).toHaveValue("Frank Herbert");
  });

  it("reveals an empty manual form with a no-match notice on a lookup miss", async () => {
    mockApi(); // lookup rejects by default
    renderAdd();

    await userEvent.type(screen.getByLabelText("ISBN", { selector: "#add-isbn-lookup" }), "0000000000");
    await userEvent.click(screen.getByRole("button", { name: "Look up" }));

    expect(await screen.findByText("No match found — enter the details manually")).toBeInTheDocument();
    expect(screen.getByLabelText("Title")).toHaveValue("");
  });

  it("submits the manual form and shows a success toast", async () => {
    mockApi({ books: () => ({ book: { id: "b1" } }) });
    renderAdd();

    await userEvent.click(screen.getByRole("tab", { name: "Manual" }));
    await userEvent.type(screen.getByLabelText("Title"), "Dune");
    await userEvent.type(screen.getByLabelText("Authors"), "Frank Herbert");
    await userEvent.type(screen.getByLabelText("ISBN", { selector: "#add-manual-isbn" }), "9780000000001");

    await userEvent.click(screen.getByRole("button", { name: "Add book" }));

    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(
        "/api/books",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            householdId: "h1",
            edition: {
              isbn: "9780000000001",
              title: "Dune",
              authors: "Frank Herbert",
              language: undefined,
              cover_url: undefined,
            },
            ownership: "owned",
            shelf_id: undefined,
          }),
        })
      )
    );
    expect(toast).toHaveBeenCalledWith('Added "Dune"');
  });

  it("batch mode keeps the shelf and ownership selection while clearing book fields", async () => {
    mockApi({ books: () => ({ book: { id: "b1" } }) });
    renderAdd();

    await userEvent.click(screen.getByRole("tab", { name: "Manual" }));

    // Pick a shelf via the Select popover.
    await userEvent.click(screen.getByRole("combobox", { name: "Shelf" }));
    await userEvent.click(await screen.findByRole("option", { name: "Top Shelf" }));

    // Turn batch mode on.
    await userEvent.click(screen.getByRole("switch"));

    await userEvent.type(screen.getByLabelText("Title"), "Book One");
    await userEvent.click(screen.getByRole("button", { name: "Add book" }));

    await waitFor(() => expect(api).toHaveBeenCalledTimes(2)); // bookcases fetch + POST
    expect(screen.getByLabelText("Title")).toHaveValue("");
    expect(screen.getByRole("combobox", { name: "Shelf" })).toHaveTextContent("Top Shelf");

    await userEvent.type(screen.getByLabelText("Title"), "Book Two");
    await userEvent.click(screen.getByRole("button", { name: "Add book" }));

    await waitFor(() =>
      expect(api).toHaveBeenLastCalledWith(
        "/api/books",
        expect.objectContaining({
          body: expect.stringContaining('"shelf_id":"s1"'),
        })
      )
    );
  });
});
