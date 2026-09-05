// POST /api/editions/:id/cover route tests, against the real app + test
// Postgres and the real filesystem storage implementation (STORAGE_FS_DIR
// pointed at a temp dir) — no storage mocking, so the put/update/delete
// sequence is exercised end to end.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app } from "../src/app.js";
import { signUp } from "./helpers.js";
import { __resetStorageForTests } from "../src/lib/storage.js";

// 1x1 red JPEG.
const TINY_JPEG_BASE64 =
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oADAMBAAIRAxEAPwCdABmX/9k=";
const TINY_JPEG = `data:image/jpeg;base64,${TINY_JPEG_BASE64}`;

let dir: string;
let cookie: string;
let editionId: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "taakify-covers-"));
  vi.stubEnv("STORAGE_FS_DIR", dir);
  __resetStorageForTests();

  cookie = (await signUp(app)).cookie;
  const household = await (
    await app.request("/api/households", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "Cover Test House" }),
    })
  ).json();
  const book = await (
    await app.request("/api/books", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        householdId: household.household.id,
        edition: { title: "Local Book", authors: "A" },
        ownership: "owned",
      }),
    })
  ).json();
  editionId = book.book.edition.id;
});

afterEach(() => {
  vi.unstubAllEnvs();
  __resetStorageForTests();
  rmSync(dir, { recursive: true, force: true });
});

async function postCover(body: unknown, asCookie = cookie) {
  return app.request(`/api/editions/${editionId}/cover`, {
    method: "POST",
    headers: { cookie: asCookie, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function storedKeys(): string[] {
  const covers = join(dir, "covers", editionId);
  return existsSync(covers) ? readdirSync(covers).filter((f) => !f.endsWith(".meta.json")) : [];
}

describe("POST /api/editions/:id/cover", () => {
  it("requires auth", async () => {
    const res = await app.request(`/api/editions/${editionId}/cover`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ data_url: TINY_JPEG }),
    });
    expect(res.status).toBe(401);
  });

  it("stores the object, updates the edition, and returns the public url", async () => {
    const res = await postCover({ data_url: TINY_JPEG });
    expect(res.status).toBe(200);
    const { cover_url } = await res.json();
    expect(cover_url).toMatch(new RegExp(`^/api/storage/covers/${editionId}/[a-f0-9-]+\\.jpg$`));
    expect(storedKeys()).toHaveLength(1);

    // The dev GET route serves the stored bytes back.
    const served = await app.request(cover_url);
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/jpeg");

    // The edition row itself was updated (visible via a fresh book read).
    const books = await (
      await app.request(`/api/books?householdId=${(await (await app.request("/api/me", { headers: { cookie } })).json()).memberships[0].household_id}`, { headers: { cookie } })
    ).json();
    expect(books.books.some((b: { edition: { cover_url: string | null } }) => b.edition.cover_url === cover_url)).toBe(true);
  });

  it("deletes the previous OUR-storage object on replace, after a successful put", async () => {
    const first = (await (await postCover({ data_url: TINY_JPEG })).json()).cover_url;
    expect(storedKeys()).toHaveLength(1);

    await postCover({ data_url: TINY_JPEG });
    expect(storedKeys()).toHaveLength(1); // old gone, new in its place
    const oldRes = await app.request(first);
    expect(oldRes.status).toBe(404);
  });

  it("does NOT delete an external cover url on replace", async () => {
    // Seed an Open Library-style external cover directly on the edition.
    const admin = await import("../src/db/pool.js");
    await admin.adminPool.query("UPDATE edition SET cover_url = $1 WHERE id = $2", [
      "https://covers.openlibrary.org/b/id/123-M.jpg",
      editionId,
    ]);

    await postCover({ data_url: TINY_JPEG });

    // Nothing under storage to begin with; still exactly one object (the new
    // one), and no error from attempting an external delete.
    expect(storedKeys()).toHaveLength(1);
  });

  it("returns 400 for malformed payloads", async () => {
    for (const bad of [
      {},
      { data_url: "not-a-data-url" },
      { data_url: "data:image/gif;base64,R0lGODlh" },
      { data_url: "data:image/jpeg;base64," },
    ]) {
      const res = await postCover(bad);
      expect(res.status).toBe(400);
    }
    // Invalid edition id shape.
    const res = await app.request("/api/editions/not-a-uuid/cover", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ data_url: TINY_JPEG }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 404 for an unknown edition", async () => {
    const res = await app.request("/api/editions/00000000-0000-0000-0000-0000000000ee/cover", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ data_url: TINY_JPEG }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 413 when the decoded image exceeds MAX_COVER_BYTES", async () => {
    const { MAX_COVER_BYTES } = await import("../src/routes/editions.js");
    const huge = `data:image/jpeg;base64,${"A".repeat(Math.ceil((MAX_COVER_BYTES + 1024) * 4 / 3))}`;
    const res = await postCover({ data_url: huge });
    expect(res.status).toBe(413);
  });
});
