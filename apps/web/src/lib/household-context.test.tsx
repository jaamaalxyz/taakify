import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { HouseholdProvider, useHousehold } from "./household-context.js";
import { api, ApiError } from "./api.js";

vi.mock("./api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api.js")>();
  return { ...actual, api: vi.fn() };
});

function Consumer() {
  const { household } = useHousehold();
  return <div>Loaded: {household.name}</div>;
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
});
