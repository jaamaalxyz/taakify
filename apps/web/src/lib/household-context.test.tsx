import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { HouseholdProvider, useHousehold } from "./household-context.js";
import { api, ApiError } from "./api.js";

vi.mock("./api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api.js")>();
  return { ...actual, api: vi.fn() };
});

function Consumer() {
  const { user, household, refreshUser } = useHousehold();
  return (
    <div>
      Loaded: {household.name} / {user.name}
      <button onClick={() => refreshUser()}>refresh</button>
    </div>
  );
}

function renderProvider() {
  render(
    <MemoryRouter initialEntries={["/"]}>
      <HouseholdProvider>
        <Consumer />
      </HouseholdProvider>
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.mocked(api).mockReset();
});

describe("HouseholdProvider", () => {
  it("shows friendlyError()'s status-based copy when GET /api/me fails, not the raw server message", async () => {
    // Same rationale as BookDetail's load-error test: the raw "forbidden" /
    // "not found" server strings are ambiguous and shouldn't reach the user
    // as-is — see lib/error-messages.ts.
    vi.mocked(api).mockRejectedValue(new ApiError("forbidden", 403));
    renderProvider();

    expect(
      await screen.findByText(/Couldn't load your library: You don't have permission to do that\./)
    ).toBeInTheDocument();
  });

  it("exposes refreshUser, which re-fetches /api/me and updates the context's user", async () => {
    // Regression: after Profile.tsx changes the signed-in user's name/email,
    // this context must be able to re-fetch — otherwise the app keeps
    // showing the stale user until a full reload (and a second email change
    // is guaranteed to fail, since it verifies against the stale address).
    const me = {
      user: { id: "u1", email: "a@b.com", name: "Ada" },
      memberships: [{ household_id: "h1", role: "owner", household_name: "Family Library" }],
    };
    let meCallCount = 0;
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path === "/api/me") {
        meCallCount += 1;
        return meCallCount === 1 ? me : { ...me, user: { ...me.user, name: "Ada Lovelace" } };
      }
      if (path === "/api/households/h1/members") return { members: [] };
      throw new Error(`unexpected call: ${path}`);
    });
    renderProvider();

    expect(await screen.findByText("Loaded: Family Library / Ada")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "refresh" }));

    expect(await screen.findByText("Loaded: Family Library / Ada Lovelace")).toBeInTheDocument();
    expect(meCallCount).toBe(2);
  });
});
