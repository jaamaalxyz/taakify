import { render, screen, waitFor, act } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { AppShell } from "./AppShell.js";
import { api } from "../lib/api.js";
import { authClient } from "../lib/auth.js";
import { db } from "../lib/db/pglite.js";
import { flush } from "../lib/sync/outbox.js";

vi.mock("../lib/auth.js", () => ({
  authClient: { signOut: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock("../lib/api.js", () => ({ api: vi.fn() }));

// Sign-out (Task 7) calls db.close() and deletes the PGlite IndexedDB
// database directly -- stub both out rather than touching a real (or even
// in-memory) PGlite instance here, since this file is about AppShell's
// routing/gating logic, not PGlite itself.
vi.mock("../lib/db/pglite.js", () => ({
  db: { close: vi.fn().mockResolvedValue(undefined) },
  IDB_DATABASE_NAME: "/pglite/taakify",
}));

vi.mock("../lib/sync/outbox.js", () => ({
  flush: vi.fn().mockResolvedValue(undefined),
}));

// Mutable in-test control over use-sync-status.js's reported pending count,
// so sign-out gating (Task 7 Step 3) can be exercised for both the
// no-pending (immediate sign-out) and pending (warning dialog) cases
// without a real outbox/PGlite round-trip.
const syncStatus = vi.hoisted(() => ({ online: true, pending: 0, dead: 0 }));

vi.mock("../lib/sync/use-sync-status.js", () => ({
  useSyncStatus: () => ({ ...syncStatus }),
}));

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
  syncStatus.online = true;
  syncStatus.pending = 0;
  syncStatus.dead = 0;
  vi.mocked(api).mockReset();
  vi.mocked(api).mockImplementation(async (path: string) => {
    if (path === "/api/me") return me;
    if (path.includes("/members")) return { members: [] };
    return {};
  });
  vi.mocked(authClient.signOut).mockClear();
  vi.mocked(db.close).mockClear();
  vi.mocked(flush).mockClear();
  vi.stubGlobal("indexedDB", { deleteDatabase: vi.fn() });
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

async function renderSyncedShell() {
  renderShell();
  act(() => {
    setSynced(true);
  });
  await screen.findByRole("heading", { name: "Library" });
}

describe("AppShell sign-out gating (Task 7)", () => {
  it("with an empty outbox, signs out immediately with no dialog", async () => {
    syncStatus.pending = 0;
    await renderSyncedShell();

    screen.getByRole("button", { name: "Sign out" }).click();

    await waitFor(() => expect(authClient.signOut).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/unsaved change/)).not.toBeInTheDocument();
    expect(db.close).toHaveBeenCalledTimes(1);
    expect(indexedDB.deleteDatabase).toHaveBeenCalledWith("/pglite/taakify");
  });

  it("with pending writes, opens a warning dialog instead of signing out immediately", async () => {
    syncStatus.pending = 3;
    await renderSyncedShell();

    screen.getByRole("button", { name: "Sign out" }).click();

    expect(await screen.findByText(/You have 3 unsaved changes\. Sign out anyway\?/)).toBeInTheDocument();
    expect(authClient.signOut).not.toHaveBeenCalled();
  });

  it("Cancel on the warning dialog leaves the user signed in and touches nothing", async () => {
    syncStatus.pending = 2;
    await renderSyncedShell();

    screen.getByRole("button", { name: "Sign out" }).click();
    const dialogTitle = await screen.findByText("Sign out?");
    expect(dialogTitle).toBeInTheDocument();

    screen.getByRole("button", { name: "Cancel" }).click();

    await waitFor(() => expect(screen.queryByText("Sign out?")).not.toBeInTheDocument());
    expect(authClient.signOut).not.toHaveBeenCalled();
    expect(db.close).not.toHaveBeenCalled();
    expect(indexedDB.deleteDatabase).not.toHaveBeenCalled();
  });

  it("Confirm on the warning dialog flushes, clears IndexedDB, and signs out", async () => {
    syncStatus.pending = 1;
    await renderSyncedShell();

    screen.getByRole("button", { name: "Sign out" }).click();
    await screen.findByText("Sign out?");

    screen.getByRole("button", { name: "Sign out anyway" }).click();

    await waitFor(() => expect(authClient.signOut).toHaveBeenCalledTimes(1));
    expect(flush).toHaveBeenCalled();
    expect(db.close).toHaveBeenCalledTimes(1);
    expect(indexedDB.deleteDatabase).toHaveBeenCalledWith("/pglite/taakify");
  });

  it("does not attempt to flush when offline (short-circuits the best-effort flush)", async () => {
    // performSignOut checks navigator.onLine directly (not the hook's
    // `online`, which only drives the badge) -- see AppShell.tsx.
    const onLineSpy = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    syncStatus.pending = 1;
    await renderSyncedShell();

    screen.getByRole("button", { name: "Sign out" }).click();
    await screen.findByText("Sign out?");
    screen.getByRole("button", { name: "Sign out anyway" }).click();

    await waitFor(() => expect(authClient.signOut).toHaveBeenCalledTimes(1));
    expect(flush).not.toHaveBeenCalled();
    onLineSpy.mockRestore();
  });
});
