import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { Import } from "./Import.js";
import { importGoodreadsCsv } from "../lib/repo/import.js";
import { useHousehold } from "../lib/household-context.js";

vi.mock("../lib/repo/import.js", () => ({ importGoodreadsCsv: vi.fn() }));
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
  vi.mocked(useHousehold).mockReturnValue({
    user: { id: "u1", email: "a@b.com", name: "Ada" },
    household,
    members: [],
  });
});

describe("Import", () => {
  it("imports the selected file and shows a success summary", async () => {
    vi.mocked(importGoodreadsCsv).mockResolvedValue({ totalRows: 2, imported: 2, failures: [] });
    renderImport();

    const input = screen.getByLabelText("Goodreads CSV export");
    await userEvent.upload(input, csvFile("Title\nDune\n1984"));

    await waitFor(() =>
      expect(importGoodreadsCsv).toHaveBeenCalledWith("Title\nDune\n1984", {
        householdId: "h1",
        userId: "u1",
        onProgress: expect.any(Function),
      })
    );
    expect(await screen.findByText("Imported 2 of 2 rows.")).toBeInTheDocument();
  });

  it("renders a per-row failure table when some rows fail", async () => {
    vi.mocked(importGoodreadsCsv).mockResolvedValue({
      totalRows: 2,
      imported: 1,
      failures: [{ rowNumber: 3, title: "", message: "missing Title" }],
    });
    renderImport();

    await userEvent.upload(screen.getByLabelText("Goodreads CSV export"), csvFile("Title\nDune\n"));

    expect(await screen.findByText("missing Title")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText(/1 row\(s\) had errors/)).toBeInTheDocument();
  });

  it("shows a friendly error banner when the import call itself throws", async () => {
    vi.mocked(importGoodreadsCsv).mockRejectedValue(new TypeError("network down"));
    renderImport();

    await userEvent.upload(screen.getByLabelText("Goodreads CSV export"), csvFile("Title\nDune\n"));

    expect(await screen.findByText("Couldn't connect. Check your connection and try again.")).toBeInTheDocument();
  });
});
