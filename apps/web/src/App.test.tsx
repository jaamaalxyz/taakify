import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { App } from "./App.js";
import { authClient } from "./lib/auth.js";
import { api } from "./lib/api.js";

vi.mock("./lib/auth.js", () => ({
  authClient: {
    useSession: vi.fn(),
    signIn: { email: vi.fn(), social: vi.fn() },
    signOut: vi.fn(),
  },
}));

vi.mock("./lib/api.js", () => ({ api: vi.fn() }));

// App.tsx's route table imports every page module eagerly (no route-level
// code splitting), so rendering App here transitively imports every
// repo/*.js file — each of which imports the real db/pglite.js singleton
// (`idb://` IndexedDB storage, browser-only). Mock it the same way
// shape.test.ts does, purely to avoid an unhandled IndexedDB-open rejection
// during import; no test here exercises repo reads/writes directly.
vi.mock("./lib/db/pglite.js", () => ({ db: undefined, ready: Promise.resolve() }));

// The Library route (rendered by several tests below) reads via
// repo/books.js and repo/tags.js, not api() — mock them so those tests get
// deterministic empty results instead of hanging on the stubbed `ready`.
vi.mock("./lib/repo/books.js", () => ({ listBooks: vi.fn().mockResolvedValue([]) }));
vi.mock("./lib/repo/tags.js", () => ({ listTags: vi.fn().mockResolvedValue([]) }));

// AppShell wires an Electric shape sync gate (Task 4) that blocks its
// children until `synced` is true. Real ShapeStreams would hit the network
// (no Electric container in the test environment) and never resolve, so
// routing tests default to "already synced" here -- the gate's own
// loading-state behavior is covered separately in AppShell.test.tsx.
vi.mock("./lib/sync/shape.js", () => ({
  startSync: vi.fn(),
  bootstrap: vi.fn().mockResolvedValue(undefined),
  getSynced: () => true,
  onSyncedChange: () => () => {},
}));

// AppShell's header (Task 7) renders SyncBadge and gates sign-out on
// use-sync-status.js's outbox counts -- both of which read the real PGlite
// outbox table via db/pglite.js, which is stubbed to `undefined` above.
// None of the tests in this file exercise sync status or sign-out
// specifically (see AppShell.test.tsx / SyncBadge.test.tsx for that), so
// stub the hook to a fixed "all clear" state, purely to avoid an unhandled
// `db.query` rejection when the header mounts.
vi.mock("./lib/sync/use-sync-status.js", () => ({
  useSyncStatus: () => ({ online: true, pending: 0, dead: 0 }),
}));

const me = {
  user: { id: "u1", email: "a@b.com", name: "Ada" },
  memberships: [{ household_id: "h1", role: "owner", household_name: "Family Library" }],
};

function renderApp(initialEntry: string) {
  render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <App />
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.mocked(authClient.useSession).mockReset();
  vi.mocked(api).mockReset();
});

describe("App routing", () => {
  it("redirects unauthenticated users from / to /signin", () => {
    vi.mocked(authClient.useSession).mockReturnValue({ data: null, isPending: false } as never);
    renderApp("/");
    expect(screen.getByRole("heading", { name: "Sign in to Taakify" })).toBeInTheDocument();
  });

  it("redirects authenticated users with no household from / to /onboarding", async () => {
    vi.mocked(authClient.useSession).mockReturnValue({ data: { user: {} }, isPending: false } as never);
    vi.mocked(api).mockResolvedValueOnce({ ...me, memberships: [] });
    renderApp("/");
    expect(await screen.findByRole("heading", { name: "Name your library" })).toBeInTheDocument();
  });

  it("redirects authenticated users away from /signin, to /library within the AppShell", async () => {
    vi.mocked(authClient.useSession).mockReturnValue({ data: { user: {} }, isPending: false } as never);
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path === "/api/me") return me;
      if (path.startsWith("/api/tags")) return { tags: [] };
      if (path.includes("/members")) return { members: [] };
      return { books: [] };
    });
    renderApp("/signin");
    expect(await screen.findByRole("heading", { name: "Library" })).toBeInTheDocument();
    expect(screen.getByText("Family Library")).toBeInTheDocument();
  });

  it("renders the Library page under AppShell when authed with a household", async () => {
    vi.mocked(authClient.useSession).mockReturnValue({ data: { user: {} }, isPending: false } as never);
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path === "/api/me") return me;
      if (path.startsWith("/api/tags")) return { tags: [] };
      if (path.includes("/members")) return { members: [] };
      return { books: [] };
    });
    renderApp("/library");
    expect(await screen.findByRole("heading", { name: "Library" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Library/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Profile/ })).toBeInTheDocument();
  });

  it("shows a loading skeleton while the session is pending", () => {
    vi.mocked(authClient.useSession).mockReturnValue({ data: null, isPending: true } as never);
    renderApp("/");
    expect(document.querySelector(".animate-pulse")).toBeInTheDocument();
  });
});
