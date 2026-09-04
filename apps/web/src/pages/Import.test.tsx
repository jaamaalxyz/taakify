import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { Import } from "./Import.js";
import { importGoodreadsCsv, previewGoodreadsCsv } from "../lib/repo/import.js";
import { useHousehold } from "../lib/household-context.js";

vi.mock("../lib/repo/import.js", () => ({
  importGoodreadsCsv: vi.fn(),
  previewGoodreadsCsv: vi.fn(),
}));
vi.mock("../lib/household-context.js", () => ({ useHousehold: vi.fn() }));

const household = { id: "h1", name: "Family Library", role: "owner" };

function renderImport() {
  render(
    <MemoryRouter initialEntries={["/import"]}>
      <Import />
    </MemoryRouter>
  );
}

function csvFile(text: string): File {
  return new File([text], "goodreads.csv", { type: "text/csv" });
}

beforeEach(() => {
  vi.mocked(importGoodreadsCsv).mockReset();
  vi.mocked(previewGoodreadsCsv).mockReset();
  vi.mocked(useHousehold).mockReturnValue({
    user: { id: "u1", email: "a@b.com", name: "Ada" },
    household,
    members: [],
  });
});

async function selectFile(text: string) {
  await userEvent.upload(screen.getByLabelText("Goodreads CSV export"), csvFile(text));
}

describe("Import", () => {
  it("asks for confirmation before importing, then shows a success summary with a library link", async () => {
    vi.mocked(previewGoodreadsCsv).mockReturnValue({ fileError: null, bookCount: 2, errorCount: 0 });
    vi.mocked(importGoodreadsCsv).mockResolvedValue({
      totalRows: 2,
      imported: 2,
      failures: [],
      cancelled: false,
    });
    renderImport();

    await selectFile("Title\nDune\n1984");

    // Nothing imported until the user confirms.
    expect(importGoodreadsCsv).not.toHaveBeenCalled();
    expect(await screen.findByText("Found 2 books in goodreads.csv.")).toBeInTheDocument();
    expect(screen.getByText("Import them into Family Library?")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Import 2 books" }));

    await waitFor(() =>
      expect(importGoodreadsCsv).toHaveBeenCalledWith("Title\nDune\n1984", {
        householdId: "h1",
        userId: "u1",
        onProgress: expect.any(Function),
        shouldCancel: expect.any(Function),
      })
    );
    expect(await screen.findByText("Imported 2 of 2 rows.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Go to your library/ })).toHaveAttribute("href", "/library");
  });

  it("rejects a file that isn't a Goodreads export with a friendly message, without importing", async () => {
    vi.mocked(previewGoodreadsCsv).mockReturnValue({ fileError: "not_goodreads", bookCount: 0, errorCount: 0 });
    renderImport();

    await selectFile("Name,Creator\nDune,Frank Herbert\n");

    expect(await screen.findByText(/doesn't look like a Goodreads export/i)).toBeInTheDocument();
    expect(importGoodreadsCsv).not.toHaveBeenCalled();
  });

  it("tells the user when the file contains no books", async () => {
    vi.mocked(previewGoodreadsCsv).mockReturnValue({ fileError: "no_books", bookCount: 0, errorCount: 0 });
    renderImport();

    await selectFile("Title,Author\n");

    expect(await screen.findByText("No books found in this file.")).toBeInTheDocument();
    expect(importGoodreadsCsv).not.toHaveBeenCalled();
  });

  it("renders a per-row report when rows are skipped or fail", async () => {
    vi.mocked(previewGoodreadsCsv).mockReturnValue({ fileError: null, bookCount: 2, errorCount: 0 });
    vi.mocked(importGoodreadsCsv).mockResolvedValue({
      totalRows: 2,
      imported: 1,
      failures: [{ rowNumber: 3, title: "Dune", message: "Already in your library — skipped" }],
      cancelled: false,
    });
    renderImport();

    await selectFile("Title\nDune\n1984");
    await userEvent.click(await screen.findByRole("button", { name: /Import 2 books/ }));

    expect(await screen.findByText("Already in your library — skipped")).toBeInTheDocument();
    expect(screen.getByText(/1 row\(s\) were skipped or had errors/)).toBeInTheDocument();
  });

  it("reports a cancelled import without treating it as an error", async () => {
    vi.mocked(previewGoodreadsCsv).mockReturnValue({ fileError: null, bookCount: 3, errorCount: 0 });
    vi.mocked(importGoodreadsCsv).mockResolvedValue({
      totalRows: 3,
      imported: 1,
      failures: [],
      cancelled: true,
    });
    renderImport();

    await selectFile("Title\nDune\n1984\nEmma");
    await userEvent.click(await screen.findByRole("button", { name: /Import 3 books/ }));

    expect(await screen.findByText(/Import cancelled — 1 book\(s\) were imported/)).toBeInTheDocument();
  });

  it("shows a friendly error banner when the import call itself throws", async () => {
    vi.mocked(previewGoodreadsCsv).mockReturnValue({ fileError: null, bookCount: 1, errorCount: 0 });
    vi.mocked(importGoodreadsCsv).mockRejectedValue(new TypeError("network down"));
    renderImport();

    await selectFile("Title\nDune\n");
    await userEvent.click(await screen.findByRole("button", { name: /Import 1 book/ }));

    expect(await screen.findByText("Couldn't connect. Check your connection and try again.")).toBeInTheDocument();
  });
});
