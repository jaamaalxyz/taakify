import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { Home } from "./Home.js";
import { api } from "../lib/api.js";
import { authClient } from "../lib/auth.js";

vi.mock("../lib/api.js", () => ({ api: vi.fn() }));
vi.mock("../lib/auth.js", () => ({ authClient: { signOut: vi.fn() } }));

const me = {
  user: { id: "u1", email: "a@b.com", name: "Ada Lovelace" },
  memberships: [{ household_id: "h1", role: "owner", household_name: "Family Library" }],
};

function renderHome() {
  render(
    <MemoryRouter>
      <Home />
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.mocked(api).mockReset();
  vi.mocked(authClient.signOut).mockReset();
});

describe("Home", () => {
  it("renders the household name, role, and avatar initials once loaded", async () => {
    vi.mocked(api).mockResolvedValueOnce(me);
    renderHome();
    expect(await screen.findByText("Family Library")).toBeInTheDocument();
    expect(screen.getByText(/owner/)).toBeInTheDocument();
    expect(screen.getByText("AL")).toBeInTheDocument();
  });

  it("shows the empty state when the user has no memberships", async () => {
    vi.mocked(api).mockResolvedValueOnce({ ...me, memberships: [] });
    renderHome();
    expect(await screen.findByText("You're not in a library yet.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Create your library" })).toHaveAttribute("href", "/onboarding");
  });

  it("opens the invite dialog, submits, and shows the returned link", async () => {
    vi.mocked(api).mockResolvedValueOnce(me);
    renderHome();
    await screen.findByText("Family Library");

    await userEvent.click(screen.getByRole("button", { name: /Invite a family member/ }));
    vi.mocked(api).mockResolvedValueOnce({ url: "/invite/tok123" });
    await userEvent.type(screen.getByLabelText("Email"), "friend@example.com");
    await userEvent.click(screen.getByRole("button", { name: "Send invite" }));

    expect(await screen.findByDisplayValue(/\/invite\/tok123$/)).toBeInTheDocument();
    expect(api).toHaveBeenLastCalledWith("/api/households/h1/invites", {
      method: "POST",
      body: JSON.stringify({ email: "friend@example.com", role: "member" }),
    });
  });

  it("copies the invite link to the clipboard when the copy button is clicked", async () => {
    vi.mocked(api).mockResolvedValueOnce(me);
    renderHome();
    await screen.findByText("Family Library");

    await userEvent.click(screen.getByRole("button", { name: /Invite a family member/ }));
    vi.mocked(api).mockResolvedValueOnce({ url: "/invite/tok123" });
    await userEvent.type(screen.getByLabelText("Email"), "friend@example.com");
    await userEvent.click(screen.getByRole("button", { name: "Send invite" }));
    await screen.findByDisplayValue(/\/invite\/tok123$/);

    await userEvent.click(screen.getByRole("button", { name: "Copy invite link" }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(`${location.origin}/invite/tok123`);
    expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();
  });

  it("signs out when the sign-out button is clicked", async () => {
    vi.mocked(api).mockResolvedValueOnce(me);
    vi.mocked(authClient.signOut).mockResolvedValue(undefined as never);
    renderHome();
    await screen.findByText("Family Library");

    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(authClient.signOut).toHaveBeenCalled();
  });
});
