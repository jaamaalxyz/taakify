import { describe, it, expect } from "vitest";
import { app } from "../src/app.js";
import { auth } from "../src/auth.js";

describe("test-only OTP endpoint", () => {
  it("returns the pending OTP for an email that requested one", async () => {
    const email = "test-only-otp@test.local";
    await auth.api.sendVerificationOTP({ body: { email, type: "sign-in" } });
    const res = await app.request(`/api/test-only/otp?email=${encodeURIComponent(email)}&type=sign-in`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.otp).toMatch(/^\d{6}$/);
  });

  it("returns null when no OTP is pending", async () => {
    const res = await app.request(
      `/api/test-only/otp?email=${encodeURIComponent("nobody@test.local")}&type=sign-in`
    );
    expect(res.status).toBe(200);
    expect((await res.json()).otp).toBeNull();
  });

  it("404s when NODE_ENV is production", async () => {
    const original = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const res = await app.request("/api/test-only/otp?email=a@b.com&type=sign-in");
      expect(res.status).toBe(404);
    } finally {
      process.env.NODE_ENV = original;
    }
  });
});
