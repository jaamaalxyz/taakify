// Dev-only object serving for the filesystem storage implementation. When
// the S3 implementation is active (production), objects are served straight
// from R2/MinIO via their public base URL and this route 404s — it exists
// so `pnpm dev` needs no external storage service, nothing more.
import { Hono } from "hono";
import { readFsObject, storageKind } from "../lib/storage.js";

export const storageDev = new Hono();

storageDev.get("/*", async (c) => {
  if (storageKind() !== "fs") return c.json({ error: "not found" }, 404);
  const key = c.req.path.replace(/^\/api\/storage\//, "");
  const object = await readFsObject(key);
  if (!object) return c.json({ error: "not found" }, 404);
  return c.body(new Uint8Array(object.bytes), 200, { "content-type": object.contentType });
});
