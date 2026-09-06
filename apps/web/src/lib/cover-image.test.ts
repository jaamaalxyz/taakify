// toCoverDataUrl tests. jsdom has no real bitmap decoding or canvas
// encoding, so the pixel work sits behind two injectable seams (loadBitmap /
// drawToJpeg); the tests drive those with fakes and assert the sizing,
// format, and error behavior around them.
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  toCoverDataUrl,
  COVER_MAX_WIDTH,
  __setBitmapPipelineForTests,
} from "./cover-image.js";

function fakeBitmap(width: number, height: number) {
  return { width, height, close: vi.fn() };
}

beforeEach(() => {
  __setBitmapPipelineForTests(undefined);
});

describe("toCoverDataUrl", () => {
  it("downscales to COVER_MAX_WIDTH preserving aspect ratio", async () => {
    const bitmap = fakeBitmap(3000, 1500);
    const drawn: Array<{ w: number; h: number }> = [];
    __setBitmapPipelineForTests({
      load: async () => bitmap,
      draw: async (bmp, w) => {
        drawn.push({ w, h: Math.round((bmp.height / bmp.width) * w) });
        return "data:image/jpeg;base64,downscaled";
      },
    });

    const result = await toCoverDataUrl(new File([], "photo.jpg", { type: "image/jpeg" }));

    expect(result).toBe("data:image/jpeg;base64,downscaled");
    expect(drawn).toEqual([{ w: COVER_MAX_WIDTH, h: Math.round((1500 / 3000) * COVER_MAX_WIDTH) }]);
    expect(bitmap.close).toHaveBeenCalled();
  });

  it("keeps smaller images at their original dimensions", async () => {
    const bitmap = fakeBitmap(400, 600);
    const drawn: number[] = [];
    __setBitmapPipelineForTests({
      load: async () => bitmap,
      draw: async (_bmp, w) => {
        drawn.push(w);
        return "data:image/jpeg;base64,small";
      },
    });

    await toCoverDataUrl(new File([], "photo.png", { type: "image/png" }));

    expect(drawn).toEqual([400]);
  });

  it("rejects non-image files before any decoding", async () => {
    const load = vi.fn();
    __setBitmapPipelineForTests({ load, draw: vi.fn() });

    await expect(
      toCoverDataUrl(new File([], "notes.txt", { type: "text/plain" }))
    ).rejects.toThrow(/choose an image/i);
    expect(load).not.toHaveBeenCalled();
  });

  it("rejects with a friendly message when decoding fails (corrupt file)", async () => {
    __setBitmapPipelineForTests({
      load: async () => {
        throw new Error("decode failed");
      },
      draw: vi.fn(),
    });

    await expect(
      toCoverDataUrl(new File([], "corrupt.jpg", { type: "image/jpeg" }))
    ).rejects.toThrow(/couldn't read|read that image/i);
  });

  it("always closes the bitmap, even when drawing throws", async () => {
    const bitmap = fakeBitmap(1200, 800);
    __setBitmapPipelineForTests({
      load: async () => bitmap,
      draw: async () => {
        throw new Error("canvas error");
      },
    });

    await expect(
      toCoverDataUrl(new File([], "photo.jpg", { type: "image/jpeg" }))
    ).rejects.toThrow();
    expect(bitmap.close).toHaveBeenCalled();
  });
});
