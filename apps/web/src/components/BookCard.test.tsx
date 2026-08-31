import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, it, expect } from "vitest";
import { BookCard, type LibraryBook } from "./BookCard.js";

const book: LibraryBook = {
  id: "b1",
  ownership: "owned",
  format: "hardcover",
  shelf_id: null,
  do_not_lend: false,
  wishlist_priority: null,
  notes: null,
  edition: { id: "e1", title: "Dune", authors: "Frank Herbert", cover_url: null, isbn: null, language: "en" },
};

function renderCard(unsynced?: boolean) {
  render(
    <MemoryRouter>
      <BookCard book={book} unsynced={unsynced} />
    </MemoryRouter>
  );
}

describe("BookCard unsynced badge (issue #16)", () => {
  it("shows an Unsynced badge when unsynced is true", () => {
    renderCard(true);
    expect(screen.getByText("Unsynced")).toBeInTheDocument();
  });

  it("does not show an Unsynced badge when unsynced is false or omitted", () => {
    renderCard(false);
    expect(screen.queryByText("Unsynced")).not.toBeInTheDocument();
  });
});
