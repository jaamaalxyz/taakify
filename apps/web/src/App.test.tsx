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
