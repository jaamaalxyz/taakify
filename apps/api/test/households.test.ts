import { describe, it, expect } from "vitest";
import { app } from "../src/app.js";
import { signUp } from "./helpers.js";

describe("households", () => {
  it("creates a household with the creator as owner", async () => {
    const { cookie } = await signUp(app);
    const res = await app.request("/api/households", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "Test Family Library" }),
    });
    expect(res.status).toBe(201);
    const { household } = await res.json();
    expect(household.name).toBe("Test Family Library");

    const me = await (await app.request("/api/me", { headers: { cookie } })).json();
    expect(me.memberships).toHaveLength(1);
    expect(me.memberships[0].role).toBe("owner");
    expect(me.memberships[0].household_id).toBe(household.id);
  });

  it("rejects empty names", async () => {
    const { cookie } = await signUp(app);
    const res = await app.request("/api/households", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "   " }),
    });
    expect(res.status).toBe(400);
  });

  it("requires auth", async () => {
    const res = await app.request("/api/households", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "X" }),
    });
    expect(res.status).toBe(401);
  });
});
