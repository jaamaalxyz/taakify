// Camera/photo cover preparation (Plan 7): reduce a picked photo to a
// cover-sized JPEG data URL BEFORE it is enqueued in the offline outbox —
// a phone photo is 3-8 MB and the outbox row must stay small enough to
// persist comfortably in PGlite, so ~60-150 KB after downscale is the
// target. The data URL (not multipart) is also what the upload API and the
// outbox's JSON replay path expect.
//
// The bitmap decode + canvas encode steps sit behind an injectable pipeline
// so jsdom tests can drive the sizing/error logic without real image
// decoding (same seam style as the repo-layer db mocks).
export const COVER_MAX_WIDTH = 800;

export interface BitmapPipeline {
  load: (file: File) => Promise<ImageBitmap | { width: number; height: number }>;
  draw: (
    bitmap: ImageBitmap | { width: number; height: number },
    targetWidth: number,
    targetHeight: number
  ) => Promise<string>;
}

let pipelineOverride: BitmapPipeline | undefined;

/** Tests only — inject a fake decode/encode pipeline. */
export function __setBitmapPipelineForTests(p: BitmapPipeline | undefined): void {
  pipelineOverride = p;
}

type AnyBitmap = ImageBitmap | { width: number; height: number };

// Safari (and older browsers) lack createImageBitmap; fall back to an
// <img> + object URL decode, which every target browser supports.
async function loadBitmapViaImg(file: File): Promise<AnyBitmap> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = "async";
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("image decode failed"));
      img.src = url;
    });
    return { width: img.naturalWidth, height: img.naturalHeight, img } as AnyBitmap;
  } finally {
    // Safe to revoke once decoded: the canvas draw below reads pixels from
    // the already-loaded element, not the URL.
    URL.revokeObjectURL(url);
  }
}

function canvasDraw(bitmap: AnyBitmap, width: number, height: number): string {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas unavailable");
  ctx.drawImage(bitmap as CanvasImageSource, 0, 0, width, height);
  return canvas.toDataURL("image/jpeg", 0.8);
}

const defaultPipeline: BitmapPipeline = {
  load: (file) =>
    typeof createImageBitmap === "function"
      ? createImageBitmap(file)
      : loadBitmapViaImg(file),
  draw: async (bitmap, w, h) => canvasDraw(bitmap, w, h),
};

/**
 * Downscale/compress a picked photo to a cover-sized JPEG data URL.
 * Rejects with a friendly, user-displayable message for non-images and
 * undecodable files.
 */
export async function toCoverDataUrl(file: File): Promise<string> {
  if (!file.type.startsWith("image/")) {
    throw new Error("Please choose an image file");
  }
  const pipeline = pipelineOverride ?? defaultPipeline;

  let bitmap: AnyBitmap;
  try {
    bitmap = await pipeline.load(file);
  } catch {
    throw new Error("Couldn't read that image — it may be corrupt");
  }

  try {
    const scale = Math.min(1, COVER_MAX_WIDTH / bitmap.width);
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    return await pipeline.draw(bitmap, width, height);
  } catch {
    throw new Error("Couldn't process that image");
  } finally {
    // ImageBitmaps hold native memory; close() is a no-op on the <img> path.
    (bitmap as ImageBitmap).close?.();
  }
}
