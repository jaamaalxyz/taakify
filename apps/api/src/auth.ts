import { betterAuth } from "better-auth";
import { emailOTP } from "better-auth/plugins";
import { adminPool } from "./db/pool.js";
import { sendOtpEmail, OTP_EXPIRES_IN_SECONDS } from "./lib/email.js";

const googleEnabled = Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);

if (!process.env.BETTER_AUTH_SECRET) {
  // better-auth silently falls back to a well-known dev secret — never allow that.
  throw new Error("BETTER_AUTH_SECRET is not set");
}

// better-auth's internal `runInBackgroundOrAwait` swallows any error
// `sendVerificationOTP` throws (logs it, nothing more) -- so email.ts's own
// runtime check for this exact misconfiguration (RESEND_API_KEY set without
// EMAIL_FROM) never reaches the client: send-verification-otp still returns
// { success: true } and the user is left waiting forever for a code that was
// never sent. With password auth retired, that's a full, silent lockout.
// Fail loudly at boot instead, matching this file's BETTER_AUTH_SECRET
// convention. email.ts keeps its own check too (defense in depth, and it's
// exercised directly by email.test.ts) -- this is a second, earlier gate.
if (process.env.RESEND_API_KEY && !process.env.EMAIL_FROM) {
  throw new Error("EMAIL_FROM is not set (required whenever RESEND_API_KEY is set)");
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
      expiresIn: OTP_EXPIRES_IN_SECONDS,
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
