import { describe, it, expect } from "vitest";
import { parseCsv } from "../src/csv.js";

describe("parseCsv", () => {
  it("parses a simple header + data rows", () => {
    const result = parseCsv("Title,Author\nDune,Frank Herbert\nEmma,Jane Austen\n");
    expect(result.headers).toEqual(["Title", "Author"]);
    expect(result.rows).toEqual([
      ["Dune", "Frank Herbert"],
      ["Emma", "Jane Austen"],
    ]);
  });

  it("handles a quoted field containing a comma", () => {
    const result = parseCsv('Title,Notes\n"Dune, Book One",great');
    expect(result.rows).toEqual([["Dune, Book One", "great"]]);
  });

  it("handles a quoted field containing an embedded newline", () => {
    const result = parseCsv('Title,Review\nDune,"Line one\nLine two"');
    expect(result.rows).toEqual([["Dune", "Line one\nLine two"]]);
  });

  it("handles an escaped double-quote inside a quoted field", () => {
    const result = parseCsv('Title,Notes\nDune,"She said ""wow"""');
    expect(result.rows).toEqual([["Dune", 'She said "wow"']]);
  });

  it("handles CRLF line endings", () => {
    const result = parseCsv("Title,Author\r\nDune,Frank Herbert\r\n");
    expect(result.headers).toEqual(["Title", "Author"]);
    expect(result.rows).toEqual([["Dune", "Frank Herbert"]]);
  });

  it("ignores a trailing blank line", () => {
    const result = parseCsv("Title\nDune\nEmma\n\n");
    expect(result.rows).toEqual([["Dune"], ["Emma"]]);
  });

  it("returns empty headers and rows for empty input", () => {
    const result = parseCsv("");
    expect(result).toEqual({ headers: [], rows: [] });
  });

  it("handles a header-only file with no data rows", () => {
    const result = parseCsv("Title,Author\n");
    expect(result.headers).toEqual(["Title", "Author"]);
    expect(result.rows).toEqual([]);
  });
});
