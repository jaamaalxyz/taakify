import { render, screen, waitFor, act } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { AppShell } from "./AppShell.js";
import { api } from "../lib/api.js";

vi.mock("../lib/auth.js", () => ({
  authClient: { signOut: vi.fn() },
}));

vi.mock("../lib/api.js", () => ({ api: vi.fn() }));

// Mutable in-test control over the sync module's `synced` signal, so we can
// exercise both the "still syncing" loading state and the "synced ->
// renders children" transition without a real ShapeStream/network call.
// `vi.hoisted` is required here: vi.mock factories are hoisted above plain
// `let`/`const` declarations in this file, so a factory closing over an
// ordinary outer variable would close over a not-yet-initialized binding.
const syncState = vi.hoisted(() => ({
  synced: false,
  listeners: new Set<() => void>(),
}));

vi.mock("../lib/sync/shape.js", () => ({
  startSync: vi.fn(),
  getSynced: () => syncState.synced,
  onSyncedChange: (cb: () => void) => {
    syncState.listeners.add(cb);
    return () => syncState.listeners.delete(cb);
  },
}));

function setSynced(value: boolean) {
  syncState.synced = value;
  for (const l of syncState.listeners) l();
}

const me = {
  user: { id: "u1", email: "a@b.com", name: "Ada" },
  memberships: [{ household_id: "h1", role: "owner", household_name: "Family Library" }],
};

beforeEach(() => {
  syncState.synced = false;
  syncState.listeners.clear();
  vi.mocked(api).mockReset();
  vi.mocked(api).mockImplementation(async (path: string) => {
    if (path === "/api/me") return me;
    if (path.includes("/members")) return { members: [] };
    return {};
  });
});

function renderShell() {
  render(
    <MemoryRouter initialEntries={["/library"]}>
      <Routes>
        <Route element={<AppShell />}>
          <Route path="/library" element={<h1>Library</h1>} />
        </Route>
      </Routes>
    </MemoryRouter>
  );
}

describe("AppShell sync gate", () => {
  it("shows a loading skeleton instead of the route content while !synced", async () => {
    renderShell();

    // Household resolves (async /api/me) but sync hasn't caught up yet --
    // the gate should show its Skeleton loading state, not the route or the
    // header (which reads household.name, only rendered once past the gate).
    await waitFor(() => expect(document.querySelector(".animate-pulse")).toBeInTheDocument());
    expect(screen.queryByRole("heading", { name: "Library" })).not.toBeInTheDocument();
    expect(screen.queryByText("Family Library")).not.toBeInTheDocument();
  });

  it("renders the route content and header once synced flips true", async () => {
    renderShell();
    await waitFor(() => expect(document.querySelector(".animate-pulse")).toBeInTheDocument());
    expect(screen.queryByRole("heading", { name: "Library" })).not.toBeInTheDocument();

    act(() => {
      setSynced(true);
    });

    expect(await screen.findByRole("heading", { name: "Library" })).toBeInTheDocument();
    expect(screen.getByText("Family Library")).toBeInTheDocument();
  });
});
