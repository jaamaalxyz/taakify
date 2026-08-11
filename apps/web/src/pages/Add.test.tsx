import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi, beforeEach, beforeAll } from "vitest";
import { Add } from "./Add.js";
import { api } from "../lib/api.js";
import { listBookcases } from "../lib/repo/shelves.js";
import { createBook } from "../lib/repo/books.js";
import { useHousehold } from "../lib/household-context.js";
import { toast } from "sonner";

// The ISBN lookup (/api/editions/lookup) stays on api() — it's an external
// catalog proxy, not household-scoped data — so api() is still mocked here,
// alongside the repo modules for bookcases/book-creation.
vi.mock("../lib/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api.js")>();
  return { ...actual, api: vi.fn() };
});
vi.mock("../lib/repo/shelves.js", () => ({ listBookcases: vi.fn() }));
vi.mock("../lib/repo/books.js", () => ({ createBook: vi.fn() }));
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

function mockDeps({ lookup }: { lookup?: () => unknown } = {}) {
  vi.mocked(listBookcases).mockResolvedValue([bookcase]);
  vi.mocked(createBook).mockResolvedValue("b1");
  vi.mocked(api).mockImplementation(async (path: string) => {
    if (path.startsWith("/api/editions/lookup")) {
      if (lookup) return lookup();
      throw new Error("not found");
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
  vi.mocked(listBookcases).mockReset();
  vi.mocked(createBook).mockReset();
  vi.mocked(toast).mockReset();
  vi.mocked(useHousehold).mockReturnValue({
    user: { id: "u1", email: "a@b.com", name: "Ada" },
    household,
    members: [],
  });
});

describe("Add", () => {
  it("looks up an ISBN and pre-fills the title on a hit", async () => {
    mockDeps({
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
    mockDeps(); // lookup rejects by default
    renderAdd();

    await userEvent.type(screen.getByLabelText("ISBN", { selector: "#add-isbn-lookup" }), "0000000000");
    await userEvent.click(screen.getByRole("button", { name: "Look up" }));

    expect(await screen.findByText("No match found — enter the details manually")).toBeInTheDocument();
    expect(screen.getByLabelText("Title")).toHaveValue("");
  });

  it("submits the manual form and shows a success toast", async () => {
    mockDeps();
    renderAdd();

    await userEvent.click(screen.getByRole("tab", { name: "Manual" }));
    await userEvent.type(screen.getByLabelText("Title"), "Dune");
    await userEvent.type(screen.getByLabelText("Authors"), "Frank Herbert");
    await userEvent.type(screen.getByLabelText("ISBN", { selector: "#add-manual-isbn" }), "9780000000001");

    await userEvent.click(screen.getByRole("button", { name: "Add book" }));

    await waitFor(() =>
      expect(createBook).toHaveBeenCalledWith({
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
        createdBy: "u1",
      })
    );
    expect(toast).toHaveBeenCalledWith('Added "Dune"');
  });

  it("batch mode keeps the shelf and ownership selection while clearing book fields", async () => {
    mockDeps();
    renderAdd();

    await userEvent.click(screen.getByRole("tab", { name: "Manual" }));

    // Pick a shelf via the Select popover.
    await userEvent.click(screen.getByRole("combobox", { name: "Shelf" }));
    await userEvent.click(await screen.findByRole("option", { name: "Top Shelf" }));

    // Turn batch mode on.
    await userEvent.click(screen.getByRole("switch"));

    await userEvent.type(screen.getByLabelText("Title"), "Book One");
    await userEvent.click(screen.getByRole("button", { name: "Add book" }));

    await waitFor(() => expect(createBook).toHaveBeenCalledTimes(1));
    expect(screen.getByLabelText("Title")).toHaveValue("");
    expect(screen.getByRole("combobox", { name: "Shelf" })).toHaveTextContent("Top Shelf");

    await userEvent.type(screen.getByLabelText("Title"), "Book Two");
    await userEvent.click(screen.getByRole("button", { name: "Add book" }));

    await waitFor(() =>
      expect(createBook).toHaveBeenLastCalledWith(expect.objectContaining({ shelf_id: "s1" }))
    );
  });
});
