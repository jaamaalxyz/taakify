import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { Profile } from "./Profile.js";
import { api } from "../lib/api.js";
import { useHousehold } from "../lib/household-context.js";
import { toast } from "sonner";

vi.mock("../lib/api.js", () => ({ api: vi.fn() }));
vi.mock("../lib/household-context.js", () => ({ useHousehold: vi.fn() }));
vi.mock("sonner", () => ({ toast: vi.fn() }));

const household = { id: "h1", name: "Family Library", role: "owner" };
const user = { id: "u1", email: "a@b.com", name: "Ada" };

const books = [
  { id: "b1", ownership: "owned", wishlist_priority: null, edition: { id: "e1", title: "Dune", authors: "Frank Herbert" } },
  { id: "b2", ownership: "borrowed_in", wishlist_priority: null, edition: { id: "e2", title: "Emma", authors: "Jane Austen" } },
  { id: "b3", ownership: "wishlist", wishlist_priority: "low", edition: { id: "e3", title: "Low Pick", authors: "X" } },
  { id: "b4", ownership: "wishlist", wishlist_priority: "high", edition: { id: "e4", title: "High Pick", authors: "Y" } },
];

// jsdom doesn't implement clipboard by default, and navigator.clipboard is a
// read-only accessor — Object.assign can't set it, so define the property.
beforeEach(() => {
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    configurable: true,
  });
});

function mockApi({ postInvite }: { postInvite?: (body: Record<string, unknown>) => unknown } = {}) {
  vi.mocked(api).mockImplementation(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (path.startsWith("/api/books") && method === "GET") return { books };
    if (path === "/api/households/h1/invites" && method === "POST") {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      return postInvite ? postInvite(body) : { url: "/invite/tok123" };
    }
    throw new Error(`unexpected call: ${method} ${path}`);
  });
}

function renderProfile() {
  render(
    <MemoryRouter initialEntries={["/profile"]}>
      <Profile />
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.mocked(api).mockReset();
  vi.mocked(toast).mockReset();
  vi.mocked(useHousehold).mockReturnValue({ user, household, members: [] });
});

describe("Profile", () => {
  it("renders household name/role and reading counts", async () => {
    mockApi();
    renderProfile();

    expect(screen.getByText("Family Library")).toBeInTheDocument();
    expect(screen.getByText(/owner/)).toBeInTheDocument();
    // owned=1, borrowed_in=1, wishlist=2 — "1" appears for both the Owned
    // and Borrowed stat cards, so assert on count rather than uniqueness.
    await waitFor(() => expect(screen.getAllByText("1")).toHaveLength(2));
    expect(screen.getByText("2")).toBeInTheDocument();
  });

  it("renders the wishlist sorted by priority (high before low)", async () => {
    mockApi();
    renderProfile();

    const highEl = await screen.findByText("High Pick");
    const lowEl = await screen.findByText("Low Pick");
    expect(highEl.compareDocumentPosition(lowEl) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("invite dialog opens and creates an invite, showing the shareable URL", async () => {
    mockApi();
    renderProfile();
    await screen.findByText("High Pick");

    await userEvent.click(screen.getByRole("button", { name: "Invite a family member" }));
    await userEvent.type(await screen.findByLabelText("Email"), "friend@example.com");
    await userEvent.click(screen.getByRole("button", { name: "Create invite" }));

    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(
        "/api/households/h1/invites",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ email: "friend@example.com", role: "member" }),
        })
      )
    );
    expect(await screen.findByDisplayValue(`${location.origin}/invite/tok123`)).toBeInTheDocument();
    expect(toast).toHaveBeenCalledWith("Invite created");
  });
});
