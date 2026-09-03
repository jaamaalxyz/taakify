import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { Bookcases } from "./Bookcases.js";
import { listBookcases, createBookcase, createShelf, updateShelf, reorderShelves } from "../lib/repo/shelves.js";
import { useHousehold } from "../lib/household-context.js";
import { toast } from "sonner";

vi.mock("../lib/repo/shelves.js", () => ({
  listBookcases: vi.fn(),
  createBookcase: vi.fn(),
  createShelf: vi.fn(),
  updateShelf: vi.fn(),
  reorderShelves: vi.fn(),
}));
vi.mock("../lib/household-context.js", () => ({ useHousehold: vi.fn() }));
// See Library.test.tsx's comment on the same mock — Bookcases now
// subscribes to mirror-change notifications too (Important finding, final
// whole-branch review).
vi.mock("../lib/sync/shape.js", () => ({ onMirrorChange: () => () => {} }));
vi.mock("sonner", () => ({ toast: vi.fn() }));

const household = { id: "h1", name: "Family Library", role: "owner" };
const user = { id: "u1", email: "a@b.com", name: "Ada" };

const bookcase = {
  id: "bc1",
  name: "Living Room",
  updated_at: "2026-01-01T00:00:00Z",
  shelves: [{ id: "s1", position: 1, label: "Top Shelf", updated_at: "2026-01-01T00:00:00Z" }],
};

const twoShelfBookcase = {
  id: "bc1",
  name: "Living Room",
  updated_at: "2026-01-01T00:00:00Z",
  shelves: [
    { id: "s1", position: 1, label: "Top Shelf", updated_at: "2026-01-01T00:00:00Z" },
    { id: "s2", position: 2, label: "Bottom Shelf", updated_at: "2026-01-01T00:00:00Z" },
  ],
};

function mockRepo({
  bookcases = [bookcase],
  reorderShelvesImpl,
}: {
  bookcases?: (typeof bookcase)[];
  reorderShelvesImpl?: (bookcaseId: string, shelfIds: string[]) => unknown;
} = {}) {
  vi.mocked(listBookcases).mockResolvedValue(bookcases);
  vi.mocked(createBookcase).mockResolvedValue("bc2");
  vi.mocked(createShelf).mockResolvedValue("s2");
  vi.mocked(updateShelf).mockResolvedValue(undefined);
  vi.mocked(reorderShelves).mockImplementation(async (bookcaseId, shelfIds) => {
    if (reorderShelvesImpl) reorderShelvesImpl(bookcaseId, shelfIds);
  });
}

function renderBookcases() {
  render(
    <MemoryRouter initialEntries={["/bookcases"]}>
      <Bookcases />
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.mocked(listBookcases).mockReset();
  vi.mocked(createBookcase).mockReset();
  vi.mocked(createShelf).mockReset();
  vi.mocked(updateShelf).mockReset();
  vi.mocked(reorderShelves).mockReset();
  vi.mocked(toast).mockReset();
  vi.mocked(useHousehold).mockReturnValue({ user, household, members: [] });
});

describe("Bookcases", () => {
  it("renders bookcases with their nested shelves", async () => {
    mockRepo();
    renderBookcases();

    expect(await screen.findByText("Living Room")).toBeInTheDocument();
    expect(screen.getByText("Top Shelf")).toBeInTheDocument();
  });

  it("shows a destructive alert when loading fails", async () => {
    vi.mocked(listBookcases).mockRejectedValue(new Error("boom"));
    renderBookcases();

    expect(
      await screen.findByText(/Couldn't load bookcases: Couldn't connect/)
    ).toBeInTheDocument();
  });

  it("creating a bookcase calls createBookcase", async () => {
    mockRepo();
    renderBookcases();
    await screen.findByText("Living Room");

    await userEvent.click(screen.getByRole("button", { name: "Add bookcase" }));
    await userEvent.type(await screen.findByLabelText("Name"), "Bedroom");
    await userEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() => expect(createBookcase).toHaveBeenCalledWith("h1", "Bedroom", "u1"));
    expect(toast).toHaveBeenCalledWith('Added bookcase "Bedroom"');
  });

  it("adding a shelf calls createShelf", async () => {
    mockRepo();
    renderBookcases();
    await screen.findByText("Living Room");

    await userEvent.click(screen.getByRole("button", { name: "Add shelf" }));
    await userEvent.type(await screen.findByLabelText("Label"), "Bottom Shelf");
    await userEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() => expect(createShelf).toHaveBeenCalledWith("bc1", "h1", "Bottom Shelf", "u1"));
    expect(toast).toHaveBeenCalledWith("Shelf added");
  });

  it("editing a shelf label calls updateShelf", async () => {
    mockRepo();
    renderBookcases();
    await screen.findByText("Living Room");

    await userEvent.click(screen.getByText("Top Shelf"));
    const input = await screen.findByLabelText("Label", { selector: "#edit-shelf-label" });
    await userEvent.clear(input);
    await userEvent.type(input, "Renamed Shelf");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(updateShelf).toHaveBeenCalledWith("s1", { label: "Renamed Shelf" }));
    expect(toast).toHaveBeenCalledWith("Shelf updated");
  });

  it("clicking the down arrow on the first shelf calls reorderShelves with the swapped order (issue #13)", async () => {
    mockRepo({ bookcases: [twoShelfBookcase] });
    renderBookcases();
    await screen.findByText("Living Room");

    await userEvent.click(screen.getByRole("button", { name: "Move Top Shelf down" }));

    await waitFor(() => expect(reorderShelves).toHaveBeenCalledWith("bc1", ["s2", "s1"]));
  });

  it("clicking the up arrow on the second shelf calls reorderShelves with the swapped order", async () => {
    mockRepo({ bookcases: [twoShelfBookcase] });
    renderBookcases();
    await screen.findByText("Living Room");

    await userEvent.click(screen.getByRole("button", { name: "Move Bottom Shelf up" }));

    await waitFor(() => expect(reorderShelves).toHaveBeenCalledWith("bc1", ["s2", "s1"]));
  });

  it("refetches after a successful reorder", async () => {
    mockRepo({ bookcases: [twoShelfBookcase] });
    renderBookcases();
    await screen.findByText("Living Room");

    await userEvent.click(screen.getByRole("button", { name: "Move Top Shelf down" }));

    await waitFor(() => expect(reorderShelves).toHaveBeenCalled());
    // One initial load on mount, plus a refetch after the reorder.
    await waitFor(() => expect(vi.mocked(listBookcases).mock.calls.length).toBe(2));
  });

  it("disables the up arrow on the first shelf and the down arrow on the last shelf", async () => {
    mockRepo({ bookcases: [twoShelfBookcase] });
    renderBookcases();
    await screen.findByText("Living Room");

    expect(screen.getByRole("button", { name: "Move Top Shelf up" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Move Bottom Shelf down" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Move Top Shelf down" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Move Bottom Shelf up" })).toBeEnabled();
  });

  it("shows a friendly error when a reorder fails", async () => {
    mockRepo({
      bookcases: [twoShelfBookcase],
      reorderShelvesImpl: () => {
        throw new Error("boom");
      },
    });
    renderBookcases();
    await screen.findByText("Living Room");

    await userEvent.click(screen.getByRole("button", { name: "Move Top Shelf down" }));

    expect(await screen.findByText("Couldn't connect. Check your connection and try again.")).toBeInTheDocument();
  });

  it("blocks a second reorder while the first is still in flight", async () => {
    let resolveReorder: () => void = () => {};
    const pending = new Promise<void>((resolve) => {
      resolveReorder = resolve;
    });
    vi.mocked(listBookcases).mockResolvedValue([twoShelfBookcase]);
    vi.mocked(reorderShelves).mockImplementation(async () => {
      await pending;
    });
    renderBookcases();
    await screen.findByText("Living Room");

    const downButton = screen.getByRole("button", { name: "Move Top Shelf down" });
    await userEvent.click(downButton);
    // The first reorder hasn't resolved yet, so every reorder button
    // (including this one) should now be disabled — a second click here is a
    // no-op since a disabled native button doesn't fire onClick.
    expect(downButton).toBeDisabled();
    await userEvent.click(downButton);
    await userEvent.click(screen.getByRole("button", { name: "Move Bottom Shelf up" }));

    resolveReorder();
    await waitFor(() => expect(downButton).not.toBeDisabled());

    expect(vi.mocked(reorderShelves).mock.calls).toHaveLength(1);
  });
});
