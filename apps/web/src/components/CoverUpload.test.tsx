import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { CoverUpload } from "./CoverUpload.js";

vi.mock("../lib/cover-image.js", () => ({
  toCoverDataUrl: vi.fn(),
}));
vi.mock("../lib/repo/editions.js", () => ({
  uploadEditionCover: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: vi.fn() }));

import { toast } from "sonner";
import { toCoverDataUrl } from "../lib/cover-image.js";
import { uploadEditionCover } from "../lib/repo/editions.js";

beforeEach(() => {
  vi.mocked(toCoverDataUrl).mockReset();
  vi.mocked(uploadEditionCover).mockReset();
  vi.mocked(toast).mockReset();
});

describe("CoverUpload", () => {
  it("renders an accessible add-cover button", () => {
    render(<CoverUpload editionId="ed-1" />);
    expect(screen.getByRole("button", { name: "Add cover photo" })).toBeInTheDocument();
  });

  it("downscales the picked file and uploads for the right edition", async () => {
    vi.mocked(toCoverDataUrl).mockResolvedValue("data:image/jpeg;base64,abc");
    vi.mocked(uploadEditionCover).mockResolvedValue();
    render(<CoverUpload editionId="ed-1" />);

    const input = screen.getByRole("button", { name: "Add cover photo" }).querySelector("input")!;
    await userEvent.upload(input, new File(["x"], "p.jpg", { type: "image/jpeg" }));

    await waitFor(() => expect(uploadEditionCover).toHaveBeenCalledWith("ed-1", "data:image/jpeg;base64,abc"));
    expect(toCoverDataUrl).toHaveBeenCalledTimes(1);
  });

  it("shows a friendly toast and does not enqueue when the file can't be processed", async () => {
    vi.mocked(toCoverDataUrl).mockRejectedValue(new Error("Couldn't read that image — it may be corrupt"));
    render(<CoverUpload editionId="ed-1" />);

    const input = screen.getByRole("button", { name: "Add cover photo" }).querySelector("input")!;
    await userEvent.upload(input, new File(["x"], "bad.jpg", { type: "image/jpeg" }));

    // friendlyError maps the raw error to a user-facing message; assert a
    // toast happened and nothing was enqueued, without coupling to its copy.
    await waitFor(() => expect(toast).toHaveBeenCalledTimes(1));
    expect(vi.mocked(toast).mock.calls[0][0]).toEqual(expect.any(String));
    expect(uploadEditionCover).not.toHaveBeenCalled();
    // Button re-enabled for a retry.
    expect(screen.getByRole("button", { name: "Add cover photo" })).toBeEnabled();
  });
});
