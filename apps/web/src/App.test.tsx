import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { App } from "./App.js";
import { authClient } from "./lib/auth.js";

vi.mock("./lib/auth.js", () => ({
  authClient: {
    useSession: vi.fn(),
    signIn: { email: vi.fn(), social: vi.fn() },
    signOut: vi.fn(),
  },
}));

vi.mock("./lib/api.js", () => ({
  api: vi.fn().mockResolvedValue({
    user: { id: "u1", email: "a@b.com", name: "Ada" },
    memberships: [],
  }),
}));

function renderApp(initialEntry: string) {
  render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <App />
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.mocked(authClient.useSession).mockReset();
});

describe("App routing", () => {
  it("redirects unauthenticated users from / to /signin", () => {
    vi.mocked(authClient.useSession).mockReturnValue({ data: null, isPending: false } as never);
    renderApp("/");
    expect(screen.getByRole("heading", { name: "Sign in to Taakify" })).toBeInTheDocument();
  });

  it("redirects authenticated users away from /signin", async () => {
    vi.mocked(authClient.useSession).mockReturnValue({ data: { user: {} }, isPending: false } as never);
    renderApp("/signin");
    expect(await screen.findByText("You're not in a library yet.")).toBeInTheDocument();
  });

  it("shows a loading skeleton while the session is pending", () => {
    vi.mocked(authClient.useSession).mockReturnValue({ data: null, isPending: true } as never);
    renderApp("/");
    expect(document.querySelector(".animate-pulse")).toBeInTheDocument();
  });
});
