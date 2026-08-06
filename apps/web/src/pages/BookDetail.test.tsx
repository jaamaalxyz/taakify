import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { describe, expect, it, vi, beforeEach, beforeAll } from "vitest";
import { BookDetail } from "./BookDetail.js";
import { api } from "../lib/api.js";
import { useHousehold } from "../lib/household-context.js";
import { toast } from "sonner";

vi.mock("../lib/api.js", () => ({ api: vi.fn() }));
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

const book = {
  id: "b1",
  ownership: "owned",
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
    status: "reading",
    started_at: null,
    finished_at: null,
    rating: null,
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

function mockApi({
  statusList = statuses,
  putStatus,
  tags = [],
  postTag,
  postBookTag,
  del,
  delTag,
  bookcases = [bookcase],
  patchBook,
}: {
  statusList?: typeof statuses;
  putStatus?: (body: Record<string, unknown>) => unknown;
  tags?: { id: string; name: string; updated_at: string }[];
  postTag?: (body: Record<string, unknown>) => unknown;
  postBookTag?: (body: Record<string, unknown>) => unknown;
  del?: () => unknown;
  delTag?: () => unknown;
  bookcases?: (typeof bookcase)[];
  patchBook?: (body: Record<string, unknown>) => unknown;
} = {}) {
  vi.mocked(api).mockImplementation(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (path === "/api/books/b1" && method === "GET") return { book };
    if (path === "/api/books/b1/status" && method === "GET") return { statuses: statusList };
    if (path === "/api/books/b1/status" && method === "PUT") {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      return putStatus ? putStatus(body) : { status: { ...statuses[0], ...body } };
    }
    if (path.startsWith("/api/bookcases")) return { bookcases };
    if (path.startsWith("/api/tags") && method === "GET") return { tags };
    if (path === "/api/tags" && method === "POST") {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      return postTag ? postTag(body) : { tag: { id: "t1", name: body.name, updated_at: "2026-01-01T00:00:00Z" } };
    }
    if (path === "/api/books/b1/tags" && method === "POST") {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      return postBookTag ? postBookTag(body) : { bookTag: { id: "bt1", tag_id: body.tagId } };
    }
    if (path.startsWith("/api/books/b1/tags/") && method === "DELETE") return delTag ? delTag() : { ok: true };
    if (path === "/api/books/b1" && method === "PATCH") {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      return patchBook ? patchBook(body) : { book: { ...book, ...body } };
    }
    if (path === "/api/books/b1" && method === "DELETE") return del ? del() : { ok: true };
    throw new Error(`unexpected call: ${method} ${path}`);
  });
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
  vi.mocked(api).mockReset();
  vi.mocked(toast).mockReset();
  navigateMock.mockReset();
  vi.mocked(useHousehold).mockReturnValue({ user, household });
});

describe("BookDetail", () => {
  it("loads the book and all members' statuses and renders them", async () => {
    mockApi();
    renderBookDetail();

    expect(await screen.findByText("Dune")).toBeInTheDocument();
    expect(screen.getByText("Frank Herbert")).toBeInTheDocument();
    expect(screen.getByText(/9780000000001/)).toBeInTheDocument();
    expect(await screen.findByText("You:")).toBeInTheDocument();
  });

  it("shows a load error when the book fetch fails", async () => {
    vi.mocked(api).mockRejectedValue(new Error("not found"));
    renderBookDetail();

    expect(await screen.findByText(/Couldn't load this book: not found/)).toBeInTheDocument();
  });

  it("editing my status calls PUT /api/books/:id/status", async () => {
    mockApi();
    renderBookDetail();
    await screen.findByText("Dune");

    await userEvent.clear(screen.getByLabelText("Rating (1-5)"));
    await userEvent.type(screen.getByLabelText("Rating (1-5)"), "4");
    await userEvent.type(screen.getByLabelText("Review note"), "Great book");
    await userEvent.click(screen.getByRole("button", { name: "Save status" }));

    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(
        "/api/books/b1/status",
        expect.objectContaining({
          method: "PUT",
          body: expect.stringContaining('"rating":4'),
        })
      )
    );
    expect(toast).toHaveBeenCalledWith("Status updated");
  });

  it("adding a tag calls POST /api/tags then POST /api/books/:id/tags", async () => {
    mockApi();
    renderBookDetail();
    await screen.findByText("Dune");

    await userEvent.type(screen.getByLabelText("Or new tag"), "sci-fi");
    await userEvent.click(screen.getByRole("button", { name: "Add tag" }));

    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(
        "/api/tags",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ householdId: "h1", name: "sci-fi" }),
        })
      )
    );
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(
        "/api/books/b1/tags",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ tagId: "t1" }),
        })
      )
    );
    expect(await screen.findByText("sci-fi")).toBeInTheDocument();
  });

  it("removing an added tag calls DELETE /api/books/:id/tags/:tagId", async () => {
    mockApi();
    renderBookDetail();
    await screen.findByText("Dune");

    await userEvent.type(screen.getByLabelText("Or new tag"), "sci-fi");
    await userEvent.click(screen.getByRole("button", { name: "Add tag" }));
    expect(await screen.findByText("sci-fi")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Remove tag sci-fi" }));

    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(
        "/api/books/b1/tags/t1",
        expect.objectContaining({ method: "DELETE" })
      )
    );
    expect(toast).toHaveBeenCalledWith('Removed tag "sci-fi"');
  });

  it("move-shelf action calls PATCH /api/books/:id with the selected shelf_id", async () => {
    mockApi();
    renderBookDetail();
    await screen.findByText("Dune");

    await userEvent.click(screen.getByRole("button", { name: "Actions" }));
    await userEvent.click(await screen.findByText("Move shelf"));

    await userEvent.click(await screen.findByRole("combobox", { name: "Shelf" }));
    await userEvent.click(await screen.findByRole("option", { name: /Top Shelf/ }));
    await userEvent.click(screen.getByRole("button", { name: "Move" }));

    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(
        "/api/books/b1",
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ shelf_id: "s1" }),
        })
      )
    );
    expect(toast).toHaveBeenCalledWith("Shelf updated");
  });

  it("edit-details action calls PATCH /api/books/:id with the edited fields", async () => {
    mockApi();
    renderBookDetail();
    await screen.findByText("Dune");

    await userEvent.click(screen.getByRole("button", { name: "Actions" }));
    await userEvent.click(await screen.findByText("Edit details"));

    await userEvent.type(await screen.findByLabelText("Notes"), "Great condition");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(
        "/api/books/b1",
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({
            ownership: "owned",
            notes: "Great condition",
            do_not_lend: false,
            wishlist_priority: null,
          }),
        })
      )
    );
    expect(toast).toHaveBeenCalledWith("Book updated");
  });

  it("delete action calls DELETE and navigates to /library", async () => {
    mockApi();
    renderBookDetail();
    await screen.findByText("Dune");

    await userEvent.click(screen.getByRole("button", { name: "Actions" }));
    await userEvent.click(await screen.findByText("Delete"));
    await userEvent.click(await screen.findByRole("button", { name: "Delete" }));

    await waitFor(() =>
      expect(api).toHaveBeenCalledWith("/api/books/b1", expect.objectContaining({ method: "DELETE" }))
    );
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith("/library"));
  });
});
