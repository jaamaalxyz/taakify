import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { Bookcases } from "./Bookcases.js";
import { api, ApiError } from "../lib/api.js";
import { useHousehold } from "../lib/household-context.js";
import { toast } from "sonner";

vi.mock("../lib/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api.js")>();
  return { ...actual, api: vi.fn() };
});
vi.mock("../lib/household-context.js", () => ({ useHousehold: vi.fn() }));
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

function mockApi({
  bookcases = [bookcase],
  postBookcase,
  postShelf,
  patchShelf,
}: {
  bookcases?: (typeof bookcase)[];
  postBookcase?: (body: Record<string, unknown>) => unknown;
  postShelf?: (path: string, body: Record<string, unknown>) => unknown;
  patchShelf?: (body: Record<string, unknown>) => unknown;
} = {}) {
  vi.mocked(api).mockImplementation(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (path.startsWith("/api/bookcases") && method === "GET") return { bookcases };
    if (path === "/api/bookcases" && method === "POST") {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      return postBookcase
        ? postBookcase(body)
        : { bookcase: { id: "bc2", name: body.name, updated_at: "2026-01-01T00:00:00Z", shelves: [] } };
    }
    if (path.match(/^\/api\/bookcases\/.+\/shelves$/) && method === "POST") {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      return postShelf
        ? postShelf(path, body)
        : { shelf: { id: "s2", position: 2, label: body.label ?? null, updated_at: "2026-01-01T00:00:00Z" } };
    }
    if (path.startsWith("/api/shelves/") && method === "PATCH") {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      return patchShelf ? patchShelf(body) : { shelf: { ...bookcase.shelves[0], ...body } };
    }
    throw new Error(`unexpected call: ${method} ${path}`);
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
  vi.mocked(api).mockReset();
  vi.mocked(toast).mockReset();
  vi.mocked(useHousehold).mockReturnValue({ user, household, members: [] });
});

describe("Bookcases", () => {
  it("renders bookcases with their nested shelves", async () => {
    mockApi();
    renderBookcases();

    expect(await screen.findByText("Living Room")).toBeInTheDocument();
    expect(screen.getByText("Top Shelf")).toBeInTheDocument();
  });

  it("shows a destructive alert when loading fails", async () => {
    // An unmapped 500 renders friendlyError()'s generic fallback, not the
    // raw server message.
    vi.mocked(api).mockRejectedValue(new ApiError("boom", 500));
    renderBookcases();

    expect(
      await screen.findByText(/Couldn't load bookcases: Something went wrong/)
    ).toBeInTheDocument();
  });

  it("creating a bookcase calls POST /api/bookcases", async () => {
    mockApi();
    renderBookcases();
    await screen.findByText("Living Room");

    await userEvent.click(screen.getByRole("button", { name: "Add bookcase" }));
    await userEvent.type(await screen.findByLabelText("Name"), "Bedroom");
    await userEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(
        "/api/bookcases",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ householdId: "h1", name: "Bedroom" }),
        })
      )
    );
    expect(toast).toHaveBeenCalledWith('Added bookcase "Bedroom"');
  });

  it("adding a shelf calls POST /api/bookcases/:id/shelves", async () => {
    mockApi();
    renderBookcases();
    await screen.findByText("Living Room");

    await userEvent.click(screen.getByRole("button", { name: "Add shelf" }));
    await userEvent.type(await screen.findByLabelText("Label"), "Bottom Shelf");
    await userEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(
        "/api/bookcases/bc1/shelves",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ label: "Bottom Shelf" }),
        })
      )
    );
    expect(toast).toHaveBeenCalledWith("Shelf added");
  });

  it("editing a shelf label calls PATCH /api/shelves/:id", async () => {
    mockApi();
    renderBookcases();
    await screen.findByText("Living Room");

    await userEvent.click(screen.getByText("Top Shelf"));
    const input = await screen.findByLabelText("Label", { selector: "#edit-shelf-label" });
    await userEvent.clear(input);
    await userEvent.type(input, "Renamed Shelf");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(
        "/api/shelves/s1",
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ label: "Renamed Shelf" }),
        })
      )
    );
    expect(toast).toHaveBeenCalledWith("Shelf updated");
  });

  it("clicking the down arrow on the first shelf swaps positions via two PATCH calls", async () => {
    mockApi({ bookcases: [twoShelfBookcase] });
    renderBookcases();
    await screen.findByText("Living Room");

    await userEvent.click(screen.getByRole("button", { name: "Move Top Shelf down" }));

    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(
        "/api/shelves/s1",
        expect.objectContaining({ method: "PATCH", body: JSON.stringify({ position: 2 }) })
      )
    );
    expect(api).toHaveBeenCalledWith(
      "/api/shelves/s2",
      expect.objectContaining({ method: "PATCH", body: JSON.stringify({ position: 1 }) })
    );
  });

  it("disables the up arrow on the first shelf and the down arrow on the last shelf", async () => {
    mockApi({ bookcases: [twoShelfBookcase] });
    renderBookcases();
    await screen.findByText("Living Room");

    expect(screen.getByRole("button", { name: "Move Top Shelf up" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Move Bottom Shelf down" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Move Top Shelf down" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Move Bottom Shelf up" })).toBeEnabled();
  });

  it("shows a friendly error when a swap fails", async () => {
    mockApi({
      bookcases: [twoShelfBookcase],
      patchShelf: () => {
        throw new ApiError("boom", 500);
      },
    });
    renderBookcases();
    await screen.findByText("Living Room");

    await userEvent.click(screen.getByRole("button", { name: "Move Top Shelf down" }));

    expect(await screen.findByText("Something went wrong. Please try again.")).toBeInTheDocument();
  });

  it("blocks a second swap while the first is still in flight", async () => {
    let resolvePatch: () => void = () => {};
    const pending = new Promise<void>((resolve) => {
      resolvePatch = resolve;
    });
    vi.mocked(api).mockImplementation(async (path: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (path.startsWith("/api/bookcases") && method === "GET") return { bookcases: [twoShelfBookcase] };
      if (path.startsWith("/api/shelves/") && method === "PATCH") {
        await pending;
        const body = init?.body ? JSON.parse(init.body as string) : {};
        return { shelf: { ...twoShelfBookcase.shelves[0], ...body } };
      }
      throw new Error(`unexpected call: ${method} ${path}`);
    });
    renderBookcases();
    await screen.findByText("Living Room");

    const downButton = screen.getByRole("button", { name: "Move Top Shelf down" });
    await userEvent.click(downButton);
    // The first swap's PATCHes haven't resolved yet, so every reorder
    // button (including this one) should now be disabled — a second click
    // here is a no-op since a disabled native button doesn't fire onClick.
    expect(downButton).toBeDisabled();
    await userEvent.click(downButton);
    await userEvent.click(screen.getByRole("button", { name: "Move Bottom Shelf up" }));

    resolvePatch();
    await waitFor(() => expect(downButton).not.toBeDisabled());

    const patchCalls = vi
      .mocked(api)
      .mock.calls.filter(([p, i]) => p.startsWith("/api/shelves/") && (i as RequestInit)?.method === "PATCH");
    expect(patchCalls).toHaveLength(2);
  });

  it("refetches after a partial swap failure (one PATCH succeeds, one rejects)", async () => {
    mockApi({
      bookcases: [twoShelfBookcase],
      patchShelf: (body) => {
        if (body.position === 2) throw new ApiError("boom", 500);
        return { shelf: { ...twoShelfBookcase.shelves[1], ...body } };
      },
    });
    renderBookcases();
    await screen.findByText("Living Room");

    await userEvent.click(screen.getByRole("button", { name: "Move Top Shelf down" }));

    expect(await screen.findByText("Something went wrong. Please try again.")).toBeInTheDocument();

    // One initial GET on mount, plus a second GET refetch after the failed
    // swap — the UI re-syncs with the server even though the swap errored,
    // since one of the two PATCHes may have actually succeeded server-side.
    await waitFor(() => {
      const getCalls = vi
        .mocked(api)
        .mock.calls.filter(([p, i]) => p.startsWith("/api/bookcases") && (i as RequestInit | undefined)?.method === undefined);
      expect(getCalls.length).toBe(2);
    });
  });
});
