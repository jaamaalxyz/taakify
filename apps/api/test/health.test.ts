import { describe, it, expect } from "vitest";
import { app } from "../src/app.js";

describe("health", () => {
  it("responds ok", async () => {
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
