import { describe, it, expect, vi, afterEach } from "vitest";
import { app } from "../src/app.js";
import { signUp } from "./helpers.js";

const OPEN_LIBRARY_HIT = {
  "ISBN:9780141439518": {
    title: "Pride and Prejudice",
    authors: [{ name: "Jane Austen", url: "https://openlibrary.org/authors/OL23919A" }],
    publishers: [{ name: "Penguin Classics" }],
    publish_date: "January 1, 2003",
    cover: { small: "s.jpg", medium: "m.jpg", large: "l.jpg" },
  },
};

function jsonResponse(body: unknown, ok = true) {
  return {
    ok,
    status: ok ? 200 : 500,
    json: async () => body,
  } as Response;
}

describe("editions lookup", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("requires auth", async () => {
    const res = await app.request("/api/editions/lookup?isbn=9780141439518");
    expect(res.status).toBe(401);
  });

  it("returns a mapped payload on an Open Library hit", async () => {
    const { cookie } = await signUp(app);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      expect(String(url)).toContain("openlibrary.org");
      return jsonResponse(OPEN_LIBRARY_HIT);
    });

    const res = await app.request("/api/editions/lookup?isbn=9780141439518", { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      isbn: "9780141439518",
      title: "Pride and Prejudice",
      authors: "Jane Austen",
      publisher: "Penguin Classics",
      published_year: 2003,
      cover_url: "m.jpg",
    });
  });

  it("returns 404 when both providers miss", async () => {
    const { cookie } = await signUp(app);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      if (String(url).includes("openlibrary.org")) return jsonResponse({});
      return jsonResponse({ totalItems: 0 });
    });

    const res = await app.request("/api/editions/lookup?isbn=0000000000", { headers: { cookie } });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("not found");
  });

  it("falls through to 404 when fetch rejects/aborts (timeout)", async () => {
    const { cookie } = await signUp(app);
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      const err = new Error("The operation was aborted");
      err.name = "AbortError";
      throw err;
    });

    const res = await app.request("/api/editions/lookup?isbn=9780141439518", { headers: { cookie } });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("not found");
  });

  it("falls through to Google Books when Open Library misses", async () => {
    const { cookie } = await signUp(app);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      if (String(url).includes("openlibrary.org")) return jsonResponse({});
      return jsonResponse({
        totalItems: 1,
        items: [
          {
            volumeInfo: {
              title: "Dune",
              authors: ["Frank Herbert"],
              publisher: "Ace Books",
              publishedDate: "1990-06-01",
              language: "en",
              imageLinks: { thumbnail: "thumb.jpg", smallThumbnail: "small.jpg" },
            },
          },
        ],
      });
    });

    const res = await app.request("/api/editions/lookup?isbn=9780441172719", { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      isbn: "9780441172719",
      title: "Dune",
      authors: "Frank Herbert",
      language: "en",
      publisher: "Ace Books",
      published_year: 1990,
      cover_url: "thumb.jpg",
    });
  });

  it("returns 400 when isbn is missing", async () => {
    const { cookie } = await signUp(app);
    const res = await app.request("/api/editions/lookup", { headers: { cookie } });
    expect(res.status).toBe(400);
  });
});
