import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { Onboarding } from "./Onboarding.js";
import { api } from "../lib/api.js";

vi.mock("../lib/api.js", () => ({ api: vi.fn() }));

function renderOnboarding() {
  render(
    <MemoryRouter initialEntries={["/onboarding"]}>
      <Routes>
        <Route path="/onboarding" element={<Onboarding />} />
        <Route path="/" element={<div>Home page</div>} />
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.mocked(api).mockReset();
});

describe("Onboarding", () => {
  it("creates the household and navigates home on success", async () => {
    vi.mocked(api).mockResolvedValueOnce({});
    renderOnboarding();

    await userEvent.type(screen.getByLabelText("Library name"), "Our Family Library");
    await userEvent.click(screen.getByRole("button", { name: "Create library" }));

    expect(api).toHaveBeenCalledWith("/api/households", {
      method: "POST",
      body: JSON.stringify({ name: "Our Family Library" }),
    });
    expect(await screen.findByText("Home page")).toBeInTheDocument();
  });

  it("shows an alert when household creation fails", async () => {
    vi.mocked(api).mockRejectedValueOnce(new Error("Name taken"));
    renderOnboarding();

    await userEvent.type(screen.getByLabelText("Library name"), "Dup");
    await userEvent.click(screen.getByRole("button", { name: "Create library" }));

    expect(await screen.findByText("Name taken")).toBeInTheDocument();
  });
});
