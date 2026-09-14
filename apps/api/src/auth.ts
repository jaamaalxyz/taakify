import { betterAuth } from "better-auth";
import { emailOTP } from "better-auth/plugins";
import { adminPool } from "./db/pool.js";
import { sendOtpEmail } from "./lib/email.js";

const googleEnabled = Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);

if (!process.env.BETTER_AUTH_SECRET) {
  // better-auth silently falls back to a well-known dev secret — never allow that.
  throw new Error("BETTER_AUTH_SECRET is not set");
}

export const auth = betterAuth({
  database: adminPool,
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: process.env.BETTER_AUTH_URL,
  basePath: "/api/auth",
  // Password auth is retired in favor of email-OTP (see the 2026-09-14
  // design doc) -- there's nothing to forget, and sign-in/sign-up become
  // the same flow. Existing `account` rows with a password column are left
  // in place, unused; deleting them serves no purpose since identity is
  // keyed on user.id, not on which credential type exists.
  emailAndPassword: { enabled: false },
  plugins: [
    emailOTP({
      sendVerificationOTP: sendOtpEmail,
      otpLength: 6,
      expiresIn: 300,
      allowedAttempts: 3,
      storeOTP: "hashed",
      changeEmail: { enabled: true, verifyCurrentEmail: true },
    }),
  ],
  socialProviders: googleEnabled
    ? {
        google: {
          clientId: process.env.GOOGLE_CLIENT_ID!,
          clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
        },
      }
    : undefined,
  trustedOrigins: ["http://localhost:5173"],
  // Spelled out rather than left to better-auth's own `isProduction` default
  // so the production behavior is visible here, not buried in a library
  // default: /sign-in* and /sign-up* are capped at 3 requests per 10s by
  // better-auth's built-in special rules once enabled (see
  // apps/api/test/auth-hardening.test.ts). The email-otp plugin's own
  // per-endpoint rate limits are gated by this exact same flag (confirmed
  // against better-auth's rate-limiter source -- see this plan's Global
  // Constraints) so this one switch covers both. Off in dev/test
  // (NODE_ENV unset) so the test suite's many rapid signUp() calls aren't
  // throttled.
  rateLimit: { enabled: process.env.NODE_ENV === "production" },
  advanced: {
    // Production topology (docs/deploy.md) is Cloudflare edge -> outbound
    // cloudflared tunnel -> this container, with no ports published
    // directly to the internet. Cloudflare's edge reliably sets
    // cf-connecting-ip to a single trustworthy client IP in that topology,
    // so prefer it over x-forwarded-for (better-auth's default), whose
    // value depends on how many hops it passes through and may not
    // reliably resolve to exactly one IP -- if it doesn't, better-auth
    // falls back to one shared rate-limit bucket for every client.
    ipAddress: { ipAddressHeaders: ["cf-connecting-ip", "x-forwarded-for"] },
  },
});
