import type { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { getPendingOtp } from "../src/lib/otp-capture.js";

// Signs up a fresh user via the real OTP endpoints; returns its session
// cookie. Kept as one function with this exact signature so every existing
// caller (15 test files) needed zero changes when auth switched from
// password to email-OTP -- only this function's internals changed.
export async function signUp(
  app: Hono,
  email = `${randomUUID()}@test.local`
): Promise<{ cookie: string; email: string }> {
  const sendRes = await app.request("/api/auth/email-otp/send-verification-otp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, type: "sign-in" }),
  });
  if (sendRes.status !== 200) throw new Error(`send-otp failed: ${sendRes.status} ${await sendRes.text()}`);

  // auth.ts configures storeOTP: "hashed" (Task 2), so better-auth's own
  // store never holds a recoverable plaintext OTP -- there is no email
  // inbox here either (RESEND_API_KEY is unset in test, see
  // apps/api/test/env-setup.ts), so otp-capture.ts's send-time capture is
  // the only way to read the code back.
  const otp = getPendingOtp(email, "sign-in");
  if (!otp) throw new Error(`no OTP pending for ${email}`);

  const res = await app.request("/api/auth/sign-in/email-otp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, otp, name: "Test User" }),
  });
  if (res.status !== 200) throw new Error(`otp sign-in failed: ${res.status} ${await res.text()}`);
  const cookies = res.headers.getSetCookie();
  if (cookies.length === 0) throw new Error("no session cookie returned");
  const cookie = cookies.map((c) => c.split(";")[0]).join("; ");
  return { cookie, email };
}
