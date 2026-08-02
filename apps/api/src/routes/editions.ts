import { Hono } from "hono";
import { requireUser, type SessionUser } from "../middleware/session.js";

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
