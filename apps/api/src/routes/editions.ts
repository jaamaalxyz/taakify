import { Hono } from "hono";
import { requireUser, type SessionUser } from "../middleware/session.js";
import { withUser } from "../db/tenant.js";
import { getStorage, coverKey, keyFromUrl } from "../lib/storage.js";

export const editions = new Hono<{ Variables: { user: SessionUser } }>();

editions.use("*", requireUser);

type EditionPayload = {
  isbn: string;
  title: string;
  authors: string;
  language?: string;
  publisher?: string;
  published_year?: number;
  cover_url?: string;
};

// Wraps a single external call: 5s timeout via AbortController, and any
// rejection (abort, network error, non-2xx, malformed JSON) is swallowed and
// treated as "no data" rather than thrown — callers just see `null`.
async function fetchJson(url: string): Promise<any | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function extractYear(dateStr: string | undefined | null): number | undefined {
  if (!dateStr) return undefined;
  const match = dateStr.match(/\d{4}/);
  return match ? Number(match[0]) : undefined;
}

async function lookupOpenLibrary(isbn: string): Promise<EditionPayload | null> {
  const data = await fetchJson(
    `https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&format=json&jscmd=data`
  );
  if (!data) return null;
  const entry = data[`ISBN:${isbn}`];
  if (!entry) return null;

  const authors = Array.isArray(entry.authors)
    ? entry.authors.map((a: { name?: string }) => a.name).filter(Boolean).join(", ")
    : "";
  const publisher = Array.isArray(entry.publishers) ? entry.publishers[0]?.name : undefined;
  const cover_url = entry.cover?.medium ?? entry.cover?.large ?? undefined;

  return {
    isbn,
    title: entry.title,
    authors,
    publisher,
    published_year: extractYear(entry.publish_date),
    cover_url,
  };
}

async function lookupGoogleBooks(isbn: string): Promise<EditionPayload | null> {
  const data = await fetchJson(
    `https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn}`
  );
  if (!data || !data.totalItems || !data.items?.length) return null;
  const info = data.items[0]?.volumeInfo;
  if (!info) return null;

  const authors = Array.isArray(info.authors) ? info.authors.join(", ") : "";
  const cover_url = info.imageLinks?.thumbnail ?? info.imageLinks?.smallThumbnail ?? undefined;

  return {
    isbn,
    title: info.title,
    authors,
    language: info.language,
    publisher: info.publisher,
    published_year: extractYear(info.publishedDate),
    cover_url,
  };
}

// GET /api/editions/lookup?isbn=...
editions.get("/lookup", async (c) => {
  const isbn = c.req.query("isbn");
  if (!isbn) return c.json({ error: "isbn is required" }, 400);

  let result: EditionPayload | null = null;
  try {
    result = await lookupOpenLibrary(isbn);
  } catch {
    result = null;
  }
  if (!result) {
    try {
      result = await lookupGoogleBooks(isbn);
    } catch {
      result = null;
    }
  }
  if (!result || !result.title) return c.json({ error: "not found" }, 404);

  return c.json(result);
});

// POST /api/editions/:id/cover (Plan 7) — attach a camera/photo cover to an
// edition that has no online cover. Body is JSON `{ data_url }` (a base64
// data URL), NOT multipart, deliberately: the web client enqueues this
// through the offline outbox, which replays plain JSON requests — binary
// upload would bypass that queue and lose offline support (spec §7: photos
// taken offline queue in the outbox).
//
// Editions are the global shared catalog (open RLS by design), so any
// authenticated member can improve a cover for everyone; no household
// scoping beyond requireUser.
const COVER_DATA_URL_RE = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/;

// Defense in depth: the web client already downscales to a cover-sized JPEG
// (~60-150 KB) before enqueueing, but the API is reachable by anything with
// a session, so it enforces its own decoded-size cap.
export const MAX_COVER_BYTES = 2 * 1024 * 1024;

editions.post("/:id/cover", async (c) => {
  const user = c.get("user");
  const body = await c.req.json().catch(() => null) as { data_url?: string } | null;
  const match = body?.data_url?.match(COVER_DATA_URL_RE);
  if (!match) return c.json({ error: "data_url must be a base64 image/(jpeg|png|webp) data URL" }, 400);
  const [, contentType, base64] = match;
  const bytes = Buffer.from(base64, "base64");
  if (bytes.byteLength === 0) return c.json({ error: "data_url is empty" }, 400);
  if (bytes.byteLength > MAX_COVER_BYTES) return c.json({ error: "cover image too large" }, 413);

  const editionId = c.req.param("id");
  if (!/^[0-9a-fA-F-]{36}$/.test(editionId)) return c.json({ error: "invalid edition id" }, 400);

  const storage = getStorage();
  const key = coverKey(editionId);

  try {
    // Fetch + update via the RLS app role like every other edition write.
    // `FOR UPDATE` pins the old cover_url so two racing uploads can't both
    // see (and both delete) the same previous object.
    const newUrl = await withUser(user.id, async (client) => {
      const { rows } = await client.query(
        "SELECT id, cover_url FROM edition WHERE id = $1 AND deleted_at IS NULL FOR UPDATE",
        [editionId]
      );
      if (rows.length === 0) return null;
      const oldUrl: string | null = rows[0].cover_url;

      // Upload first, update second: a failed put must leave the edition
      // pointing at its old cover.
      await storage.put(key, contentType, bytes);
      const url = storage.url(key);
      await client.query(
        "UPDATE edition SET cover_url = $2, updated_at = now() WHERE id = $1",
        [editionId, url]
      );
      return { url, oldUrl };
    });
    if (!newUrl) return c.json({ error: "edition not found" }, 404);

    // Best-effort cleanup of the object we just replaced — never external
    // URLs (Open Library / Google Books covers aren't ours to delete) and
    // never a reason to fail an otherwise-successful upload.
    const oldKey = newUrl.oldUrl ? keyFromUrl(newUrl.oldUrl) : null;
    if (oldKey) {
      await storage.delete(oldKey).catch((err) => {
        console.error("[storage] failed to delete replaced cover", oldKey, err);
      });
    }

    return c.json({ cover_url: newUrl.url });
  } catch (err) {
    console.error("[editions] cover upload failed", err);
    return c.json({ error: "cover upload failed" }, 500);
  }
});
