import { describe, it, expect } from "vitest";
import { app } from "../src/app.js";
import { signUp } from "./helpers.js";

describe("auth", () => {
  it("signs up and establishes a session", async () => {
    const { cookie, email } = await signUp(app);
    const res = await app.request("/api/me", { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user.email).toBe(email);
    expect(body.memberships).toEqual([]);
  });

  it("rejects unauthenticated /api/me", async () => {
    const res = await app.request("/api/me");
    expect(res.status).toBe(401);
  });

  it("sign-out invalidates the session", async () => {
    const { cookie } = await signUp(app);
    const out = await app.request("/api/auth/sign-out", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: "{}",
    });
    expect(out.status).toBe(200);
    const me = await app.request("/api/me", { headers: { cookie } });
    expect(me.status).toBe(401);
  });
});
