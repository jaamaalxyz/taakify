// Storage interface tests. The filesystem implementation is exercised
// against a real temp dir; the S3 implementation against an injected fake
// client (no live R2/MinIO in CI) -- see storage.ts's S3ClientLike seam.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getStorage,
  isOurUrl,
  storageKind,
  validateKey,
  __resetStorageForTests,
} from "../src/lib/storage.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "taakify-storage-"));
  vi.stubEnv("STORAGE_FS_DIR", dir);
  vi.unstubAllEnvs();
  vi.stubEnv("STORAGE_FS_DIR", dir);
  __resetStorageForTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
  __resetStorageForTests();
  rmSync(dir, { recursive: true, force: true });
});

describe("filesystem storage (dev default)", () => {
  it("is the active implementation when no STORAGE_ENDPOINT/BUCKET are set", () => {
    expect(storageKind()).toBe("fs");
  });

  it("put writes the bytes under the key path with the content type in a sidecar", async () => {
    const storage = getStorage();
    await storage.put("covers/abc/cover.jpg", "image/jpeg", Buffer.from("jpeg-bytes"));

    expect(readFileSync(join(dir, "covers/abc/cover.jpg")).toString()).toBe("jpeg-bytes");
    expect(JSON.parse(readFileSync(join(dir, "covers/abc/cover.jpg.meta.json"), "utf8"))).toEqual({
      contentType: "image/jpeg",
    });
  });

  it("url prefixes the key with the dev base /api/storage/", () => {
    expect(getStorage().url("covers/abc/cover.jpg")).toBe("/api/storage/covers/abc/cover.jpg");
  });

  it("url uses STORAGE_PUBLIC_BASE_URL when set, with exactly one slash at the join", async () => {
    vi.stubEnv("STORAGE_PUBLIC_BASE_URL", "https://cdn.example.com/covers/");
    __resetStorageForTests();
    expect(getStorage().url("k.jpg")).toBe("https://cdn.example.com/covers/k.jpg");

    vi.stubEnv("STORAGE_PUBLIC_BASE_URL", "https://cdn.example.com/covers");
    __resetStorageForTests();
    expect(getStorage().url("k.jpg")).toBe("https://cdn.example.com/covers/k.jpg");
    vi.unstubAllEnvs();
  });

  it("delete removes the object and its sidecar; deleting a missing key is a no-op", async () => {
    const storage = getStorage();
    await storage.put("k.jpg", "image/jpeg", Buffer.from("x"));
    await storage.delete("k.jpg");
    expect(existsSync(join(dir, "k.jpg"))).toBe(false);
    expect(existsSync(join(dir, "k.jpg.meta.json"))).toBe(false);

    await expect(storage.delete("k.jpg")).resolves.toBeUndefined();
  });

  it("isOurUrl accepts dev URLs and rejects external https URLs", async () => {
    vi.stubEnv("STORAGE_PUBLIC_BASE_URL", "https://cdn.example.com/covers/");
    __resetStorageForTests();
    expect(isOurUrl("/api/storage/covers/abc/k.jpg")).toBe(true);
    expect(isOurUrl("https://cdn.example.com/covers/abc/k.jpg")).toBe(true);
    expect(isOurUrl("https://covers.openlibrary.org/b/id/123-M.jpg")).toBe(false);
    expect(isOurUrl("https://example.com/anything")).toBe(false);
  });
});

describe("key validation (both implementations)", () => {
  it("accepts normal cover keys", () => {
    expect(() => validateKey("covers/00000000-0000-0000-0000-000000000000/abc123.jpg")).not.toThrow();
  });

  it("rejects traversal, absolute, and malformed keys", () => {
    expect(() => validateKey("../etc/passwd")).toThrow();
    expect(() => validateKey("a/../../b")).toThrow();
    expect(() => validateKey("/leading/slash")).toThrow();
    expect(() => validateKey("spaced key.jpg")).toThrow();
    expect(() => validateKey("semi;colon")).toThrow();
  });
});

describe("s3 storage", () => {
  it("put/delete issue the right commands via the injected client", async () => {
    const commands: Array<Record<string, unknown>> = [];
    const fakeClient = {
      async send(cmd: Record<string, unknown>) {
        commands.push(cmd);
        return {};
      },
    };
    const { createS3StorageForTests } = await import("../src/lib/storage.js");
    const storage = createS3StorageForTests({
      client: fakeClient,
      bucket: "taakify-covers",
      publicBaseUrl: "https://cdn.example.com/",
    });

    await storage.put("covers/abc/k.jpg", "image/jpeg", Buffer.from("bytes"));
    await storage.delete("covers/abc/k.jpg");

    expect(commands).toHaveLength(2);
    const put = commands[0] as { input: Record<string, unknown> };
    const del = commands[1] as { input: Record<string, unknown> };
    expect(put.input.Bucket).toBe("taakify-covers");
    expect(put.input.Key).toBe("covers/abc/k.jpg");
    expect(put.input.ContentType).toBe("image/jpeg");
    expect(put.input.Body).toEqual(Buffer.from("bytes"));
    expect(del.input.Bucket).toBe("taakify-covers");
    expect(del.input.Key).toBe("covers/abc/k.jpg");

    expect(storage.url("k.jpg")).toBe("https://cdn.example.com/k.jpg");
  });

  it("getStorage selects s3 when STORAGE_ENDPOINT and STORAGE_BUCKET are set", () => {
    vi.stubEnv("STORAGE_ENDPOINT", "https://abc.r2.cloudflarestorage.com");
    vi.stubEnv("STORAGE_BUCKET", "taakify-covers");
    vi.stubEnv("STORAGE_PUBLIC_BASE_URL", "https://cdn.example.com/");
    __resetStorageForTests();
    expect(storageKind()).toBe("s3");
    vi.unstubAllEnvs();
  });
});
