import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { describe, expect, it, vi, beforeEach, beforeAll } from "vitest";
import { BookDetail } from "./BookDetail.js";
import { api, ApiError } from "../lib/api.js";
import { useHousehold } from "../lib/household-context.js";
import { toast } from "sonner";

vi.mock("../lib/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api.js")>();
  return { ...actual, api: vi.fn() };
});
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
  {
    id: "rs2",
    book_id: "b1",
    user_id: "u2",
    status: "finished",
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

function mockApi({
  statusList = statuses,
  putStatus,
  tags = [],
  bookTags: initialBookTags = [],
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
  bookTags?: { id: string; name: string; updated_at: string }[];
  postTag?: (body: Record<string, unknown>) => unknown;
  postBookTag?: (body: Record<string, unknown>) => unknown;
  del?: () => unknown;
  delTag?: () => unknown;
  bookcases?: (typeof bookcase)[];
  patchBook?: (body: Record<string, unknown>) => unknown;
} = {}) {
  // Tracks tag id -> tag across both /api/tags (household tags) and any
  // freshly created tags, so /api/books/b1/tags can echo back real names
  // after a POST — mirrors the real server's book_tag/tag join.
  const tagsById = new Map(tags.map((t) => [t.id, t]));
  let currentBookTags = [...initialBookTags];
  for (const t of initialBookTags) tagsById.set(t.id, t);

  vi.mocked(api).mockImplementation(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (path === "/api/books/b1" && method === "GET") return { book };
    if (path === "/api/books/b1/status" && method === "GET") return { statuses: statusList };
    if (path === "/api/books/b1/status" && method === "PUT") {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      return putStatus ? putStatus(body) : { status: { ...statuses[0], ...body } };
    }
    if (path.startsWith("/api/bookcases")) return { bookcases };
    if (path === "/api/books/b1/tags" && method === "GET") return { tags: currentBookTags };
    if (path.startsWith("/api/tags") && method === "GET") return { tags };
    if (path === "/api/tags" && method === "POST") {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      const result = (
        postTag ? postTag(body) : { tag: { id: "t1", name: body.name, updated_at: "2026-01-01T00:00:00Z" } }
      ) as { tag: { id: string; name: string; updated_at: string } };
      tagsById.set(result.tag.id, result.tag);
      return result;
    }
    if (path === "/api/books/b1/tags" && method === "POST") {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      const result = postBookTag ? postBookTag(body) : { bookTag: { id: "bt1", tag_id: body.tagId } };
      const tag = tagsById.get(body.tagId);
      if (tag && !currentBookTags.some((t) => t.id === tag.id)) currentBookTags = [...currentBookTags, tag];
      return result;
    }
    if (path.startsWith("/api/books/b1/tags/") && method === "DELETE") {
      const tagId = path.split("/").pop();
      currentBookTags = currentBookTags.filter((t) => t.id !== tagId);
      return delTag ? delTag() : { ok: true };
    }
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
  vi.mocked(useHousehold).mockReturnValue({ user, household, members });
});

describe("BookDetail", () => {
  it("loads the book and all members' statuses and renders them", async () => {
    mockApi();
    renderBookDetail();

    expect(await screen.findByText("Dune")).toBeInTheDocument();
    expect(screen.getByText("Frank Herbert")).toBeInTheDocument();
    expect(screen.getByText(/9780000000001/)).toBeInTheDocument();
    // The caller's own row is labeled "You"; another member's row resolves to
    // their roster name (not a raw uuid) via the household members list.
    expect(await screen.findByText("You:")).toBeInTheDocument();
    expect(screen.getByText("Grace:")).toBeInTheDocument();
    expect(screen.queryByText(/Member \(/)).not.toBeInTheDocument();
  });

  it("shows a load error when the book fetch fails", async () => {
    // A 404 from the API renders friendlyError()'s status-based copy, not
    // the raw ("not found" is reused across unrelated routes and can't be
    // shown to the user as-is — see lib/error-messages.ts).
    vi.mocked(api).mockRejectedValue(new ApiError("not found", 404));
    renderBookDetail();

    expect(
      await screen.findByText(/Couldn't load this book: That doesn't exist anymore/)
    ).toBeInTheDocument();
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

  it("loads tags already on the book from GET /api/books/:id/tags (persists across reload)", async () => {
    mockApi({ bookTags: [{ id: "t9", name: "classic", updated_at: "2026-01-01T00:00:00Z" }] });
    renderBookDetail();
    await screen.findByText("Dune");

    expect(await screen.findByText("classic")).toBeInTheDocument();
  });

  it("shows an empty-tags message when the book has no tags yet", async () => {
    mockApi();
    renderBookDetail();
    await screen.findByText("Dune");

    expect(await screen.findByText("No tags on this book yet.")).toBeInTheDocument();
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
