import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { Landing } from "./Landing.js";

function renderLanding() {
  render(
    <MemoryRouter>
      <Landing />
    </MemoryRouter>
  );
}

describe("Landing", () => {
  it("renders the Taakify name and a one-line description", () => {
    renderLanding();
    expect(screen.getByRole("heading", { name: "Taakify" })).toBeInTheDocument();
    expect(
      screen.getByText(/track what your household is reading/i)
    ).toBeInTheDocument();
  });

  it("links to sign up and sign in", () => {
    renderLanding();
    expect(screen.getByRole("link", { name: "Sign up" })).toHaveAttribute("href", "/signup");
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/signin");
  });
});
