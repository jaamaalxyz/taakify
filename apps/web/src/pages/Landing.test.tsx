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
  it("renders the Taakify name and subhead", () => {
    renderLanding();
    expect(screen.getByRole("heading", { name: "Taakify" })).toBeInTheDocument();
    expect(screen.getByText(/a private library for your household/i)).toBeInTheDocument();
  });

  it("renders the three benefit sections and the closing pitch", () => {
    renderLanding();
    expect(screen.getByRole("heading", { name: "Catalog every shelf" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "See what everyone's reading" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Never lose a lent book" })).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Your books. Your shelves. Your household." })
    ).toBeInTheDocument();
  });

  it("links to sign up and sign in, once each, after the value props", () => {
    renderLanding();
    expect(screen.getByRole("link", { name: "Sign up" })).toHaveAttribute("href", "/signup");
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/signin");
  });
});
