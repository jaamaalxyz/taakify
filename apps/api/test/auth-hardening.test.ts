import { describe, it, expect } from "vitest";
import { betterAuth } from "better-auth";
import { randomUUID } from "node:crypto";
import { adminPool } from "../src/db/pool.js";

const TEST_SECRET = "test-secret-test-secret-test-secret!";

function signUpRequest(baseURL: string, email: string): Request {
  return new Request(`${baseURL}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "password-123", name: "Test User" }),
  });
}

describe("auth hardening", () => {
  it("issues a Secure, SameSite=Lax session cookie under an https baseURL", async () => {
    // A throwaway instance, not the app's shared `auth` singleton -- proves
    // better-auth's own cookie derivation, isolated from any other test.
    const instance = betterAuth({
      database: adminPool,
      secret: TEST_SECRET,
      baseURL: "https://app.example.test",
      basePath: "/api/auth",
      emailAndPassword: { enabled: true },
    });

    const res = await instance.handler(
      signUpRequest("https://app.example.test", `${randomUUID()}@test.local`)
    );
    expect(res.status).toBe(200);

    const setCookie = res.headers.getSetCookie().join("; ");
    expect(setCookie).toMatch(/;\s*Secure\b/i);
    expect(setCookie).toMatch(/samesite=lax/i);
  });

  it("rejects sign-up attempts past the built-in rate limit", async () => {
    // rateLimit.enabled defaults to `isProduction` (NODE_ENV=production),
    // which is false in the test process -- enable it explicitly here to
    // prove the mechanism this app relies on in production actually works.
    // The 3-per-10s cap on /sign-up* comes from better-auth's own built-in
    // special rule, not from any config passed below.
    const instance = betterAuth({
      database: adminPool,
      secret: TEST_SECRET,
      baseURL: "http://localhost:9999",
      basePath: "/api/auth",
      emailAndPassword: { enabled: true },
      rateLimit: { enabled: true },
    });

    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      const res = await instance.handler(
        signUpRequest("http://localhost:9999", `${randomUUID()}@test.local`)
      );
      statuses.push(res.status);
    }

    expect(statuses.slice(0, 3)).toEqual([200, 200, 200]);
    expect(statuses[3]).toBe(429);
  });
});
