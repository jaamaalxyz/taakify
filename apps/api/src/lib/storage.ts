// Cover-image object storage behind a two-method interface (spec §2's one
// deliberate proprietary exception): Cloudflare R2 (or any S3 store, e.g.
// self-hosted MinIO) in production, a zero-config filesystem implementation
// for local dev so `pnpm dev` needs no external service. Nothing outside
// this module may import @aws-sdk/client-s3 or touch the fs storage root.
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { S3Client, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";

export interface Storage {
  put(key: string, contentType: string, bytes: Buffer): Promise<void>;
  /** Idempotent: deleting a missing key is a no-op. */
  delete(key: string): Promise<void>;
  /** Public URL for a stored object (bucket is public-read; no signing). */
  url(key: string): string;
}

// Key must stay inside the storage root: charset whitelist excludes `..`,
// leading `/`, spaces, and anything else that could escape or surprise an
// fs path join or an S3 key.
export function validateKey(key: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9/._-]*$/.test(key) || key.includes("..")) {
    throw new Error(`invalid storage key: ${JSON.stringify(key)}`);
  }
}

/** Object key for a new edition cover. UUID per upload so outbox replays never collide. */
export function coverKey(editionId: string): string {
  return `covers/${editionId}/${randomUUID()}.jpg`;
}

// Dev base: served by the GET /api/storage/* route (storage-dev.ts). When
// STORAGE_PUBLIC_BASE_URL is set (production), it wins for both impls.
const DEV_BASE = "/api/storage/";

function publicBase(): string {
  return (process.env.STORAGE_PUBLIC_BASE_URL ?? DEV_BASE).replace(/\/+$/, "") + "/";
}

/** True when a URL was produced by *our* storage (safe to delete on replace). */
export function isOurUrl(url: string): boolean {
  return url.startsWith(DEV_BASE) || url.startsWith(publicBase());
}

/** Inverse of url(): the storage key for one of our URLs, null for foreign URLs. */
export function keyFromUrl(url: string): string | null {
  const base = publicBase();
  if (url.startsWith(base)) return url.slice(base.length);
  if (url.startsWith(DEV_BASE)) return url.slice(DEV_BASE.length);
  return null;
}

// --- Filesystem implementation (dev default) --------------------------------

function fsRoot(): string {
  return process.env.STORAGE_FS_DIR ?? join(process.cwd(), ".storage");
}

function fsPath(key: string): string {
  validateKey(key);
  return join(fsRoot(), key);
}

class FsStorage implements Storage {
  async put(key: string, contentType: string, bytes: Buffer): Promise<void> {
    const path = fsPath(key);
    await mkdir(dirname(path), { recursive: true });
    await Promise.all([
      writeFile(path, bytes),
      writeFile(`${path}.meta.json`, JSON.stringify({ contentType })),
    ]);
  }

  async delete(key: string): Promise<void> {
    const path = fsPath(key);
    await Promise.all([rm(path, { force: true }), rm(`${path}.meta.json`, { force: true })]);
  }

  url(key: string): string {
    validateKey(key);
    return publicBase() + key;
  }
}

/** Read a stored object + its content type back (the dev GET route's backend). */
export async function readFsObject(
  key: string
): Promise<{ bytes: Buffer; contentType: string } | null> {
  const full = fsPath(key);
  try {
    const [bytes, meta] = await Promise.all([
      readFile(full),
      readFile(`${full}.meta.json`, "utf8").catch(() => null),
    ]);
    return {
      bytes,
      contentType: meta
        ? (JSON.parse(meta) as { contentType: string }).contentType
        : "application/octet-stream",
    };
  } catch {
    return null;
  }
}

// --- S3 implementation -------------------------------------------------------

// Minimal structural type over the AWS client so tests can inject a fake
// (capturing Put/Delete command args) without any network.
export interface S3ClientLike {
  send(command: unknown): Promise<unknown>;
}

interface S3Deps {
  client: S3ClientLike;
  bucket: string;
  publicBaseUrl: string;
}

class S3Storage implements Storage {
  constructor(private deps: S3Deps) {}

  async put(key: string, contentType: string, bytes: Buffer): Promise<void> {
    validateKey(key);
    await this.deps.client.send(
      new PutObjectCommand({
        Bucket: this.deps.bucket,
        Key: key,
        ContentType: contentType,
        Body: bytes,
      })
    );
  }

  async delete(key: string): Promise<void> {
    validateKey(key);
    await this.deps.client.send(new DeleteObjectCommand({ Bucket: this.deps.bucket, Key: key }));
  }

  url(key: string): string {
    validateKey(key);
    return this.deps.publicBaseUrl.replace(/\/+$/, "") + "/" + key;
  }
}

/** Direct constructor access for tests (fake-client injection, no network). */
export function createS3StorageForTests(deps: S3Deps): Storage {
  return new S3Storage(deps);
}

// --- Selection ---------------------------------------------------------------

let instance: Storage | undefined;
let kind: "fs" | "s3" | undefined;

export function storageKind(): "fs" | "s3" {
  if (!kind) void getStorage();
  return kind ?? "fs";
}

export function getStorage(): Storage {
  if (instance) return instance;
  const endpoint = process.env.STORAGE_ENDPOINT;
  const bucket = process.env.STORAGE_BUCKET;
  if (endpoint && bucket) {
    kind = "s3";
    const accessKeyId = process.env.STORAGE_ACCESS_KEY_ID;
    const secretAccessKey = process.env.STORAGE_SECRET_ACCESS_KEY;
    instance = new S3Storage({
      client: new S3Client({
        endpoint,
        region: process.env.STORAGE_REGION ?? "auto",
        forcePathStyle: true, // required by R2 and MinIO alike
        ...(accessKeyId && secretAccessKey
          ? { credentials: { accessKeyId, secretAccessKey } }
          : {}),
      }),
      bucket,
      publicBaseUrl: publicBase(),
    });
  } else {
    kind = "fs";
    instance = new FsStorage();
  }
  return instance;
}

export function __resetStorageForTests(): void {
  instance = undefined;
  kind = undefined;
}
