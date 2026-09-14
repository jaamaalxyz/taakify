import { describe, it, expect } from "vitest";
import { betterAuth } from "better-auth";
import { emailOTP } from "better-auth/plugins";
import { randomUUID } from "node:crypto";
import { adminPool } from "../src/db/pool.js";

const TEST_SECRET = "test-secret-test-secret-test-secret!";

function noopSendOtp() {
  return Promise.resolve();
}

function sendOtpRequest(baseURL: string, email: string): Request {
  return new Request(`${baseURL}/api/auth/email-otp/send-verification-otp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, type: "sign-in" }),
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
      emailAndPassword: { enabled: false },
      plugins: [emailOTP({ sendVerificationOTP: noopSendOtp })],
    });

    const email = `${randomUUID()}@test.local`;
    await instance.handler(sendOtpRequest("https://app.example.test", email));
    const { otp } = await instance.api.getVerificationOTP({ query: { email, type: "sign-in" } });
    if (!otp) throw new Error("no OTP pending");

    const res = await instance.handler(
      new Request("https://app.example.test/api/auth/sign-in/email-otp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, otp, name: "Test User" }),
      })
    );
    expect(res.status).toBe(200);

    const setCookie = res.headers.getSetCookie().join("; ");
    expect(setCookie).toMatch(/;\s*Secure\b/i);
    expect(setCookie).toMatch(/samesite=lax/i);
  });

  it("rejects OTP requests past the plugin's built-in rate limit", async () => {
    // rateLimit.enabled defaults to `isProduction` (NODE_ENV=production),
    // which is false in the test process -- enable it explicitly here to
    // prove the mechanism this app relies on in production actually works.
    // The email-otp plugin's default rate limit on send-verification-otp
    // is 3 requests per 60s window (see EmailOTPOptions.rateLimit default
    // in node_modules/better-auth/dist/plugins/email-otp/types.d.mts) --
    // this is a plugin-declared rule, not one of better-auth's core
    // special-cased path rules, but it's gated by the exact same
    // `rateLimit.enabled` flag (see this plan's Global Constraints).
    const instance = betterAuth({
      database: adminPool,
      secret: TEST_SECRET,
      baseURL: "http://localhost:9999",
      basePath: "/api/auth",
      emailAndPassword: { enabled: false },
      plugins: [emailOTP({ sendVerificationOTP: noopSendOtp })],
      rateLimit: { enabled: true },
    });

    const email = `${randomUUID()}@test.local`;
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      const res = await instance.handler(sendOtpRequest("http://localhost:9999", email));
      statuses.push(res.status);
    }

    expect(statuses.slice(0, 3)).toEqual([200, 200, 200]);
    expect(statuses[3]).toBe(429);
  });
});
