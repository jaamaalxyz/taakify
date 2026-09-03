import { describe, it, expect } from "vitest";
import { mapGoodreadsCsv } from "../src/goodreads-import.js";

const HEADER =
  "Book Id,Title,Author,ISBN,ISBN13,My Rating,Publisher,Binding,Date Read,Bookshelves,Exclusive Shelf,My Review,Private Notes";

function csv(...dataRows: string[]): string {
  return [HEADER, ...dataRows].join("\n");
}

describe("mapGoodreadsCsv", () => {
  it("maps a finished ('read') row with rating, ISBN, and a carried-over Date Read", () => {
    const result = mapGoodreadsCsv(
      csv(
        '1,Dune,Frank Herbert,="",="9780441172719",5,,,2023/05/12,read,read,,'
      )
    );
    expect(result.errors).toEqual([]);
    expect(result.books).toEqual([
      {
        rowNumber: 2,
        title: "Dune",
        authors: "Frank Herbert",
        isbn: "9780441172719",
        ownership: "owned",
        status: "finished",
        rating: 5,
        finished_at: "2023-05-12",
        notes: null,
      },
    ]);
  });

  it("maps 'currently-reading' to reading and ignores Date Read for a non-finished row", () => {
    const result = mapGoodreadsCsv(
      csv('2,Emma,Jane Austen,,,0,,,2023/05/12,currently-reading,currently-reading,,')
    );
    expect(result.books[0]).toMatchObject({ status: "reading", finished_at: null, rating: null });
  });

  it("maps 'to-read' to want_to_read", () => {
    const result = mapGoodreadsCsv(csv('3,1984,George Orwell,,,0,,,,to-read,to-read,,'));
    expect(result.books[0]).toMatchObject({ status: "want_to_read" });
  });

  it("falls back to unread for an unrecognized Exclusive Shelf, and folds the shelf name into notes", () => {
    const result = mapGoodreadsCsv(csv('4,Foundation,Isaac Asimov,,,0,,,,favorites,favorites,,'));
    expect(result.books[0].status).toBe("unread");
    expect(result.books[0].notes).toContain("Goodreads shelf: favorites");
  });

  it("prefers ISBN13 over ISBN and strips the Excel-guard quoting", () => {
    const result = mapGoodreadsCsv(
      csv('5,Dune,Frank Herbert,="0441172717",="9780441172719",0,,,,to-read,to-read,,')
    );
    expect(result.books[0].isbn).toBe("9780441172719");
  });

  it("falls back to ISBN when ISBN13 is blank", () => {
    const result = mapGoodreadsCsv(csv('6,Dune,Frank Herbert,="0441172717",="",0,,,,to-read,to-read,,'));
    expect(result.books[0].isbn).toBe("0441172717");
  });

  it("folds unmapped, non-empty columns into notes as 'Header: value' lines", () => {
    const result = mapGoodreadsCsv(
      csv('7,Dune,Frank Herbert,,,0,Ace,Paperback,,to-read,to-read,So good,Gift from Sam')
    );
    expect(result.books[0].notes).toBe(
      ["Publisher: Ace", "Binding: Paperback", "My Review: So good", "Private Notes: Gift from Sam"].join("\n")
    );
  });

  it("omits notes entirely when there is nothing unmapped to preserve", () => {
    const result = mapGoodreadsCsv(csv('8,Dune,Frank Herbert,,,0,,,,to-read,to-read,,'));
    expect(result.books[0].notes).toBeNull();
  });

  it("treats My Rating of 0 (Goodreads' 'no rating') as null", () => {
    const result = mapGoodreadsCsv(csv('9,Dune,Frank Herbert,,,0,,,,to-read,to-read,,'));
    expect(result.books[0].rating).toBeNull();
  });

  it("ignores a malformed Date Read rather than failing the row", () => {
    const result = mapGoodreadsCsv(csv('10,Dune,Frank Herbert,,,5,,,not-a-date,read,read,,'));
    expect(result.errors).toEqual([]);
    expect(result.books[0].finished_at).toBeNull();
  });

  it("reports a missing Title as a per-row error instead of a partial book", () => {
    const result = mapGoodreadsCsv(csv('11,,Frank Herbert,,,0,,,,to-read,to-read,,'));
    expect(result.books).toEqual([]);
    expect(result.errors).toEqual([{ rowNumber: 2, message: "missing Title" }]);
  });

  it("assigns rowNumber starting at 2 (row 1 is the header) and continues past a bad row", () => {
    const result = mapGoodreadsCsv(
      csv(
        '11,,Missing Title,,,0,,,,to-read,to-read,,', // row 2: error
        '12,Valid Book,Someone,,,0,,,,to-read,to-read,,' // row 3: ok
      )
    );
    expect(result.errors).toEqual([{ rowNumber: 2, message: "missing Title" }]);
    expect(result.books).toEqual([expect.objectContaining({ rowNumber: 3, title: "Valid Book" })]);
  });

  it("preserves non-ASCII titles and authors unchanged", () => {
    const result = mapGoodreadsCsv(csv('13,百年孤独,Gabriel García Márquez,,,0,,,,to-read,to-read,,'));
    expect(result.books[0]).toMatchObject({ title: "百年孤独", authors: "Gabriel García Márquez" });
  });
});
