import { render, screen, waitFor, act } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { AppShell, signOutWarningMessage } from "./AppShell.js";
import { api } from "../lib/api.js";
import { authClient } from "../lib/auth.js";
import { db } from "../lib/db/pglite.js";
import { flush, startOutboxWorker } from "../lib/sync/outbox.js";
import { startSync, bootstrap } from "../lib/sync/shape.js";

vi.mock("../lib/auth.js", () => ({
  authClient: { signOut: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock("../lib/api.js", () => ({ api: vi.fn() }));

// Sign-out (Task 7) calls db.close() and deletes the PGlite IndexedDB
// database directly -- stub both out rather than touching a real (or even
// in-memory) PGlite instance here, since this file is about AppShell's
// routing/gating logic, not PGlite itself.
vi.mock("../lib/db/pglite.js", () => ({
  db: {
    close: vi.fn().mockResolvedValue(undefined),
    // SyncGate's existing-data escape hatch (Critical 2 fix) probes this --
    // default to "no local data yet" so existing gate tests (which drive
    // release purely via synced/stalled) aren't affected by this query
    // resolving early.
    query: vi.fn().mockResolvedValue({ rows: [] }),
  },
  ready: Promise.resolve(),
  IDB_DATABASE_NAME: "/pglite/taakify",
}));

vi.mock("../lib/sync/outbox.js", () => ({
  flush: vi.fn().mockResolvedValue(undefined),
  startOutboxWorker: vi.fn(),
}));

// Mutable in-test control over use-sync-status.js's reported pending count,
// so sign-out gating (Task 7 Step 3) can be exercised for both the
// no-pending (immediate sign-out) and pending (warning dialog) cases
// without a real outbox/PGlite round-trip.
const syncStatus = vi.hoisted(() => ({ online: true, pending: 0, dead: 0, stalled: false }));

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
  stalled: false,
  listeners: new Set<() => void>(),
  stallListeners: new Set<() => void>(),
}));

vi.mock("../lib/sync/shape.js", () => ({
  startSync: vi.fn(),
  bootstrap: vi.fn().mockResolvedValue(undefined),
  getSynced: () => syncState.synced,
  onSyncedChange: (cb: () => void) => {
    syncState.listeners.add(cb);
    return () => syncState.listeners.delete(cb);
  },
  getSyncStalled: () => syncState.stalled,
  onSyncStalledChange: (cb: () => void) => {
    syncState.stallListeners.add(cb);
    return () => syncState.stallListeners.delete(cb);
  },
}));

function setSynced(value: boolean) {
  syncState.synced = value;
  for (const l of syncState.listeners) l();
}

function setStalled(value: boolean) {
  syncState.stalled = value;
  // useSyncStatus is mocked independently of shape.js in this file (see
  // `syncStatus` above) -- SyncBadge reads the former, SyncGate reads the
  // latter, so both need updating to exercise the "stalled" state
  // end-to-end the way the real app wires them together via
  // use-sync-status.ts.
  syncStatus.stalled = value;
  for (const l of syncState.stallListeners) l();
}

const me = {
  user: { id: "u1", email: "a@b.com", name: "Ada" },
  memberships: [{ household_id: "h1", role: "owner", household_name: "Family Library" }],
};

beforeEach(() => {
  syncState.synced = false;
  syncState.stalled = false;
  syncState.listeners.clear();
  syncState.stallListeners.clear();
  syncStatus.online = true;
  syncStatus.pending = 0;
  syncStatus.dead = 0;
  syncStatus.stalled = false;
  vi.mocked(api).mockReset();
  vi.mocked(api).mockImplementation(async (path: string) => {
    if (path === "/api/me") return me;
    if (path.includes("/members")) return { members: [] };
    return {};
  });
  vi.mocked(authClient.signOut).mockClear();
  vi.mocked(db.close).mockClear();
  vi.mocked(flush).mockClear();
  // performSignOut (Important 2 fix) now wraps indexedDB.deleteDatabase in
  // a Promise and awaits its onsuccess -- the mock needs to actually fire
  // that callback (asynchronously, like the real IndexedDB API) rather than
  // just being a bare vi.fn(), or `await deleteIndexedDb(...)` would hang.
  vi.stubGlobal("indexedDB", {
    deleteDatabase: vi.fn(() => {
      const request: { onsuccess?: () => void; onerror?: () => void; onblocked?: () => void } = {};
      setTimeout(() => request.onsuccess?.(), 0);
      return request;
    }),
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

  it("fires bootstrap() alongside startSync() for the cold-start household, not after synced (Task 8)", async () => {
    renderShell();
    await waitFor(() => expect(document.querySelector(".animate-pulse")).toBeInTheDocument());

    expect(startSync).toHaveBeenCalledWith("h1");
    expect(bootstrap).toHaveBeenCalledWith("h1");
  });

  it("starts the outbox background worker alongside startSync/bootstrap (Critical 1 fix)", async () => {
    renderShell();
    await waitFor(() => expect(document.querySelector(".animate-pulse")).toBeInTheDocument());

    expect(startOutboxWorker).toHaveBeenCalled();
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

  it("releases the gate when the shape stream is reported stalled, even though synced never became true (Critical 2 fix)", async () => {
    renderShell();
    await waitFor(() => expect(document.querySelector(".animate-pulse")).toBeInTheDocument());
    expect(screen.queryByRole("heading", { name: "Library" })).not.toBeInTheDocument();

    act(() => {
      setStalled(true);
    });

    expect(await screen.findByRole("heading", { name: "Library" })).toBeInTheDocument();
    // synced never became true -- SyncBadge should surface this as "Sync
    // unavailable" rather than looking like a normal, fully-synced app.
    expect(await screen.findByText("Sync unavailable")).toBeInTheDocument();
  });

  it("releases the gate immediately when the local mirror already has data, without waiting on synced/stalled (Critical 2 fix)", async () => {
    vi.mocked(db.query).mockResolvedValueOnce({ rows: [{ "?column?": 1 }] } as never);

    renderShell();

    expect(await screen.findByRole("heading", { name: "Library" })).toBeInTheDocument();
    expect(startSync).toHaveBeenCalledWith("h1");
  });
});

async function renderSyncedShell() {
  renderShell();
  act(() => {
    setSynced(true);
  });
  await screen.findByRole("heading", { name: "Library" });
}

describe("signOutWarningMessage (code review finding: pending/dead can both drop to 0 while the dialog is open)", () => {
  it("never renders the literal string 'undefined' when both counts are 0", () => {
    expect(signOutWarningMessage(0, 0)).not.toMatch(/undefined/);
  });
});

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

  it("with only dead-lettered writes (no pending), still warns instead of signing out immediately", async () => {
    syncStatus.pending = 0;
    syncStatus.dead = 2;
    await renderSyncedShell();

    screen.getByRole("button", { name: "Sign out" }).click();

    expect(await screen.findByText(/2 changes failed to save\. Sign out anyway\?/)).toBeInTheDocument();
    expect(authClient.signOut).not.toHaveBeenCalled();
  });

  it("with both pending and dead-lettered writes, mentions both counts in the warning", async () => {
    syncStatus.pending = 3;
    syncStatus.dead = 1;
    await renderSyncedShell();

    screen.getByRole("button", { name: "Sign out" }).click();

    expect(
      await screen.findByText(/You have 3 unsaved changes and 1 change failed to save\. Sign out anyway\?/)
    ).toBeInTheDocument();
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

  it("awaits indexedDB.deleteDatabase's onsuccess before signing out (Important 2 fix)", async () => {
    let resolveDelete: (() => void) | undefined;
    vi.stubGlobal("indexedDB", {
      deleteDatabase: vi.fn(() => {
        const request: { onsuccess?: () => void } = {};
        // Deliberately never auto-fire onsuccess -- the test controls when
        // the "delete" completes, so it can assert signOut hasn't been
        // called yet while it's still pending.
        resolveDelete = () => request.onsuccess?.();
        return request;
      }),
    });
    syncStatus.pending = 0;
    await renderSyncedShell();

    screen.getByRole("button", { name: "Sign out" }).click();

    // Give any (incorrect) fire-and-forget code a chance to race ahead.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(authClient.signOut).not.toHaveBeenCalled();

    resolveDelete?.();
    await waitFor(() => expect(authClient.signOut).toHaveBeenCalledTimes(1));
  });

  it("proceeds with sign-out after a grace period when deleteDatabase is blocked by another tab", async () => {
    vi.stubGlobal("indexedDB", {
      deleteDatabase: vi.fn(() => {
        const request: { onblocked?: () => void } = {};
        setTimeout(() => request.onblocked?.(), 0);
        return request;
      }),
    });
    syncStatus.pending = 0;
    await renderSyncedShell();

    screen.getByRole("button", { name: "Sign out" }).click();

    await waitFor(() => expect(authClient.signOut).toHaveBeenCalledTimes(1), { timeout: 3000 });
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
