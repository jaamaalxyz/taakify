import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { UnsyncedBadge } from "./UnsyncedBadge.js";

describe("UnsyncedBadge", () => {
  it("renders the Unsynced label with a subject-specific title", () => {
    render(<UnsyncedBadge subject="book" />);
    const badge = screen.getByText("Unsynced");
    expect(badge).toHaveAttribute("title", "A local change to this book never reached the server");
  });

  it("varies the title text by subject", () => {
    render(<UnsyncedBadge subject="loan" />);
    expect(screen.getByText("Unsynced")).toHaveAttribute(
      "title",
      "A local change to this loan never reached the server"
    );
  });
});
