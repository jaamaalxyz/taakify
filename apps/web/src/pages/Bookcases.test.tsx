import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { Bookcases } from "./Bookcases.js";
import { listBookcases, createBookcase, createShelf, updateShelf } from "../lib/repo/shelves.js";
import { useHousehold } from "../lib/household-context.js";
import { toast } from "sonner";

vi.mock("../lib/repo/shelves.js", () => ({
  listBookcases: vi.fn(),
  createBookcase: vi.fn(),
  createShelf: vi.fn(),
  updateShelf: vi.fn(),
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
  updateShelfImpl,
}: {
  bookcases?: (typeof bookcase)[];
  updateShelfImpl?: (id: string, input: Record<string, unknown>) => unknown;
} = {}) {
  vi.mocked(listBookcases).mockResolvedValue(bookcases);
  vi.mocked(createBookcase).mockResolvedValue("bc2");
  vi.mocked(createShelf).mockResolvedValue("s2");
  vi.mocked(updateShelf).mockImplementation(async (id, input) => {
    if (updateShelfImpl) updateShelfImpl(id, input as Record<string, unknown>);
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

  it("clicking the down arrow on the first shelf swaps positions via two updateShelf calls", async () => {
    mockRepo({ bookcases: [twoShelfBookcase] });
    renderBookcases();
    await screen.findByText("Living Room");

    await userEvent.click(screen.getByRole("button", { name: "Move Top Shelf down" }));

    await waitFor(() => expect(updateShelf).toHaveBeenCalledWith("s1", { position: 2 }));
    expect(updateShelf).toHaveBeenCalledWith("s2", { position: 1 });
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

  it("shows a friendly error when a swap fails", async () => {
    mockRepo({
      bookcases: [twoShelfBookcase],
      updateShelfImpl: () => {
        throw new Error("boom");
      },
    });
    renderBookcases();
    await screen.findByText("Living Room");

    await userEvent.click(screen.getByRole("button", { name: "Move Top Shelf down" }));

    expect(await screen.findByText("Couldn't connect. Check your connection and try again.")).toBeInTheDocument();
  });

  it("blocks a second swap while the first is still in flight", async () => {
    let resolvePatch: () => void = () => {};
    const pending = new Promise<void>((resolve) => {
      resolvePatch = resolve;
    });
    vi.mocked(listBookcases).mockResolvedValue([twoShelfBookcase]);
    vi.mocked(updateShelf).mockImplementation(async () => {
      await pending;
    });
    renderBookcases();
    await screen.findByText("Living Room");

    const downButton = screen.getByRole("button", { name: "Move Top Shelf down" });
    await userEvent.click(downButton);
    // The first swap's writes haven't resolved yet, so every reorder button
    // (including this one) should now be disabled — a second click here is a
    // no-op since a disabled native button doesn't fire onClick.
    expect(downButton).toBeDisabled();
    await userEvent.click(downButton);
    await userEvent.click(screen.getByRole("button", { name: "Move Bottom Shelf up" }));

    resolvePatch();
    await waitFor(() => expect(downButton).not.toBeDisabled());

    expect(vi.mocked(updateShelf).mock.calls).toHaveLength(2);
  });

  it("refetches after a partial swap failure (one write succeeds, one rejects)", async () => {
    vi.mocked(listBookcases).mockResolvedValue([twoShelfBookcase]);
    vi.mocked(updateShelf).mockImplementation(async (_id, input) => {
      if ((input as { position?: number }).position === 2) throw new Error("boom");
    });
    renderBookcases();
    await screen.findByText("Living Room");

    await userEvent.click(screen.getByRole("button", { name: "Move Top Shelf down" }));

    expect(await screen.findByText("Couldn't connect. Check your connection and try again.")).toBeInTheDocument();

    // One initial load on mount, plus a second refetch after the failed
    // swap — the UI re-syncs even though the swap errored, since one of the
    // two writes may have actually succeeded.
    await waitFor(() => {
      expect(vi.mocked(listBookcases).mock.calls.length).toBe(2);
    });
  });

  it("blocks a second swap while the post-swap refetch is still in flight", async () => {
    // Both writes resolve immediately, but the refetch stays pending until
    // we release it — this targets the window between "writes resolved" and
    // "refetch resolved," which is where the in-flight guard must still be
    // held: releasing it early lets a second click compute a swap from stale
    // (pre-refetch) local positions and corrupt the ordering.
    let resolveGet: () => void = () => {};
    const pendingGet = new Promise<void>((resolve) => {
      resolveGet = resolve;
    });
    let getCallCount = 0;
    vi.mocked(listBookcases).mockImplementation(async () => {
      getCallCount++;
      if (getCallCount > 1) await pendingGet;
      return [twoShelfBookcase];
    });
    vi.mocked(updateShelf).mockResolvedValue(undefined);
    renderBookcases();
    await screen.findByText("Living Room");

    const downButton = screen.getByRole("button", { name: "Move Top Shelf down" });
    await userEvent.click(downButton);

    // The two swap writes have resolved, but the refetch triggered by the
    // swap is still pending — the guard must still be held, so the button
    // stays disabled and a click here is a no-op.
    await waitFor(() => expect(vi.mocked(updateShelf).mock.calls).toHaveLength(2));
    expect(downButton).toBeDisabled();
    await userEvent.click(downButton);
    await userEvent.click(screen.getByRole("button", { name: "Move Bottom Shelf up" }));

    resolveGet();
    await waitFor(() => expect(downButton).not.toBeDisabled());

    expect(vi.mocked(updateShelf).mock.calls).toHaveLength(2);
  });
});
