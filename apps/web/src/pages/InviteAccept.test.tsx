import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { InviteAccept } from "./InviteAccept.js";
import { api } from "../lib/api.js";

vi.mock("../lib/api.js", () => ({ api: vi.fn() }));

function renderInvite(authed: boolean) {
  render(
    <MemoryRouter initialEntries={["/invite/tok123"]}>
      <Routes>
        <Route path="/invite/:token" element={<InviteAccept authed={authed} />} />
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.mocked(api).mockReset();
});

describe("InviteAccept", () => {
  it("shows the household name and role once the invite loads", async () => {
    vi.mocked(api).mockResolvedValueOnce({ householdName: "Family Library", email: "a@b.com", role: "member" });
    renderInvite(true);
    expect(await screen.findByText('Join "Family Library"')).toBeInTheDocument();
  });

  it("accepts the invite and calls the accept endpoint", async () => {
    vi.mocked(api).mockResolvedValueOnce({ householdName: "Family Library", email: "a@b.com", role: "member" });
    renderInvite(true);
    await screen.findByText('Join "Family Library"');

    vi.mocked(api).mockResolvedValueOnce({});
    await userEvent.click(screen.getByRole("button", { name: "Accept invite" }));
    expect(api).toHaveBeenLastCalledWith("/api/invites/tok123/accept", { method: "POST" });
  });

  it("shows an error alert when the invite fails to load", async () => {
    vi.mocked(api).mockRejectedValueOnce(new Error("Invite expired"));
    renderInvite(true);
    expect(await screen.findByText(/Invite expired/)).toBeInTheDocument();
  });
});
