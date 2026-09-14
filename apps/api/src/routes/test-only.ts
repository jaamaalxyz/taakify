// Test/E2E-only escape hatch to read back a pending OTP without a real
// inbox. Mirrors storage-dev.ts's env-gating style: always mounted, but
// functionally inert (404) outside non-production environments. Never
// reachable in production regardless of how NODE_ENV is set on this
// container -- see the throw in auth.ts for the project's convention of
// never trusting a soft default for anything security-sensitive.
//
// Reads from lib/otp-capture.ts rather than better-auth's own
// `auth.api.getVerificationOTP`: auth.ts configures the email-otp plugin
// with `storeOTP: "hashed"` (Task 2's deliberate choice), so better-auth's
// own store never holds a recoverable plaintext OTP -- that endpoint always
// throws "OTP is hashed, cannot return the plain text OTP" regardless of
// env. otp-capture.ts instead grabs the plaintext at send time (the one
// place it still exists), itself gated to never populate outside
// non-production, so hashed storage stays the only copy in production.
import { Hono } from "hono";
import { getPendingOtp } from "../lib/otp-capture.js";

export const testOnly = new Hono();

testOnly.get("/otp", async (c) => {
  if (process.env.NODE_ENV === "production") return c.json({ error: "not found" }, 404);
  const email = c.req.query("email");
  const type = c.req.query("type");
  if (!email || !type) return c.json({ error: "email and type query params required" }, 400);
  return c.json({ otp: getPendingOtp(email, type) });
});
