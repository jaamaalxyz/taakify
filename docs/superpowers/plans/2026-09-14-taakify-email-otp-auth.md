# Taakify Email-OTP Authentication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace email+password sign-in/sign-up with a single, unified email-OTP flow (one form, works for both new and returning users), keep Google sign-in as an alternate path, add email/name changes to Profile, and stand up real email delivery via Resend.

**Architecture:** better-auth's built-in `email-otp` server plugin + `emailOTPClient` client plugin do all OTP generation/storage/expiry/rate-limiting — no custom crypto or scheduling code is written. OTPs are stored in the existing `verification` table (no new migration). A new `apps/api/src/lib/email.ts` module sends via Resend when `RESEND_API_KEY` is set, else logs to the console (dev/test). A new NODE_ENV-gated test-only endpoint lets the Playwright E2E suite read back an OTP without needing a real inbox.

**Tech Stack:** better-auth 1.6.23 (already installed, both `apps/api` and `apps/web` resolve to this exact version via pnpm's dedup despite differing semver ranges — no version bump needed), new dependency `resend` (npm), existing Hono/React/Vitest/Playwright stack.

**Spec:** `docs/superpowers/specs/2026-09-14-taakify-email-otp-auth-design.md`

## Global Constraints

- No new database tables or migrations. The `verification` table (`migrations/0001_auth.sql`) already has the shape (`identifier`/`value`/`expiresAt`) the plugin needs.
- `emailAndPassword: { enabled: false }` in `apps/api/src/auth.ts` — password endpoints are fully disabled, not just hidden in the UI.
- Google sign-in (`authClient.signIn.social({ provider: "google", ... })`) is unchanged and stays available alongside OTP.
- `storeOTP: "hashed"` — OTP codes are never stored in plaintext in the `verification` table.
- `changeEmail: { enabled: true, verifyCurrentEmail: true }` — an email change requires proving control of the *current* email first, confirmed against the plugin's own source (`routes.mjs` line 641-644: `requestEmailChange` throws `BAD_REQUEST` if `verifyCurrentEmail` is true and no `otp` is supplied).
- The plugin's own per-endpoint rate limits (default `{ window: 60, max: 3 }` on send-otp/verify/sign-in endpoints) are gated by the exact same `ctx.rateLimit.enabled` flag as every other better-auth rate limit — confirmed by reading `node_modules/better-auth/dist/api/rate-limiter/index.mjs`: `onRequestRateLimit`'s first line is `if (!ctx.rateLimit.enabled) return;`, and plugin-declared rules are only consulted later inside `resolveRateLimitConfig`, which that early return skips entirely. The existing `rateLimit: { enabled: process.env.NODE_ENV === "production" }` in `auth.ts` therefore already suppresses these in dev/test — no separate test-only rate-limit workaround is needed anywhere in this plan.
- `apps/api/test/helpers.ts`'s exported `signUp(app, email?)` function keeps its exact existing signature (`Promise<{ cookie: string; email: string }>`) — its *internals* change to drive the OTP flow, but none of its 15 consuming test files need to change, because they only ever destructure `{ cookie, email }`.

---

### Task 1: Email delivery module

**Files:**
- Create: `apps/api/src/lib/email.ts`
- Create: `apps/api/test/email.test.ts`
- Modify: `apps/api/package.json` (add `resend` dependency)
- Modify: `apps/api/.env.example` (add `RESEND_API_KEY`, `EMAIL_FROM`)

**Interfaces:**
- Produces: `sendOtpEmail(data: { email: string; otp: string; type: "sign-in" | "email-verification" | "forget-password" | "change-email" }): Promise<void>` — matches the exact shape `emailOTP`'s `sendVerificationOTP` option expects, so it can be passed directly as that callback in Task 2.

- [ ] **Step 1: Add the `resend` dependency**

Run: `pnpm --filter @taakify/api add resend`

- [ ] **Step 2: Write the failing tests**

Create `apps/api/test/email.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("sendOtpEmail", () => {
  const originalApiKey = process.env.RESEND_API_KEY;
  const originalFrom = process.env.EMAIL_FROM;

  afterEach(() => {
    process.env.RESEND_API_KEY = originalApiKey;
    process.env.EMAIL_FROM = originalFrom;
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("logs the OTP to the console instead of sending when RESEND_API_KEY is unset", async () => {
    delete process.env.RESEND_API_KEY;
    const { sendOtpEmail } = await import("../src/lib/email.js");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await sendOtpEmail({ email: "a@b.com", otp: "123456", type: "sign-in" });
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("123456"));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("a@b.com"));
  });

  it("throws if RESEND_API_KEY is set but EMAIL_FROM is not", async () => {
    process.env.RESEND_API_KEY = "re_test_key";
    delete process.env.EMAIL_FROM;
    const { sendOtpEmail } = await import("../src/lib/email.js");
    await expect(sendOtpEmail({ email: "a@b.com", otp: "123456", type: "sign-in" })).rejects.toThrow(
      "EMAIL_FROM"
    );
  });
});
```

- [ ] **Step 2b: Run the tests to verify they fail**

Run: `pnpm --filter @taakify/api test -- email.test.ts`
Expected: FAIL — `apps/api/src/lib/email.ts` does not exist yet.

- [ ] **Step 3: Implement `apps/api/src/lib/email.ts`**

```ts
// Real OTP delivery via Resend when configured; otherwise logs to the
// console so local dev and the test suite never need a real Resend
// account. Mirrors the existing googleEnabled env-gating pattern in
// apps/api/src/auth.ts -- a missing key means "not configured", not an
// error, but a *present* key with no EMAIL_FROM is a misconfiguration and
// fails loudly rather than silently dropping the email.
type OtpType = "sign-in" | "email-verification" | "forget-password" | "change-email";

const SUBJECTS: Record<OtpType, string> = {
  "sign-in": "Your Taakify sign-in code",
  "email-verification": "Verify your Taakify email",
  "forget-password": "Your Taakify password reset code",
  "change-email": "Confirm your new Taakify email",
};

export async function sendOtpEmail(data: { email: string; otp: string; type: OtpType }): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.log(`[email-otp] ${data.type} code for ${data.email}: ${data.otp}`);
    return;
  }
  const from = process.env.EMAIL_FROM;
  if (!from) {
    throw new Error("EMAIL_FROM is not set (required whenever RESEND_API_KEY is set)");
  }
  const { Resend } = await import("resend");
  const resend = new Resend(apiKey);
  const { error } = await resend.emails.send({
    from,
    to: data.email,
    subject: SUBJECTS[data.type],
    text: `Your code is ${data.otp}. It expires in 5 minutes.`,
  });
  if (error) throw new Error(`Resend send failed: ${error.message}`);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @taakify/api test -- email.test.ts`
Expected: PASS

- [ ] **Step 5: Add the new env vars to `apps/api/.env.example`**

Append after the existing `GOOGLE_CLIENT_SECRET=` line:

```
# Email delivery for OTP sign-in (optional in dev — unset falls back to
# logging the code to the console instead of sending). EMAIL_FROM is
# required whenever RESEND_API_KEY is set.
RESEND_API_KEY=
EMAIL_FROM=
```

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/lib/email.ts apps/api/test/email.test.ts apps/api/package.json apps/api/.env.example pnpm-lock.yaml
git commit -m "feat(api): add Resend-backed OTP email delivery with a dev console fallback"
```

---

### Task 2: Server auth config — switch to email-OTP

**Files:**
- Modify: `apps/api/src/auth.ts`

**Interfaces:**
- Consumes: `sendOtpEmail` from `./lib/email.js` (Task 1).
- Produces: the `auth` export now exposes `/api/auth/email-otp/send-verification-otp`, `/api/auth/sign-in/email-otp`, `/api/auth/email-otp/verify-email`, `/api/auth/email-otp/request-email-change`, `/api/auth/email-otp/change-email` — consumed by Task 4 (client), Task 6 (web UI), Task 9 (Profile).

- [ ] **Step 1: Write the failing test**

Add this test inside the existing `describe("auth", ...)` block in `apps/api/test/auth.test.ts`, using only what the file already imports (`app`, `expect`, `it` — no new import needed):

```ts
  it("rejects password sign-up now that email+password is disabled", async () => {
    const res = await app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "nopass@test.local", password: "password-123", name: "Nope" }),
    });
    expect(res.status).not.toBe(200);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @taakify/api test -- auth.test.ts`
Expected: FAIL — password sign-up currently succeeds (returns 200).

- [ ] **Step 3: Update `apps/api/src/auth.ts`**

```ts
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @taakify/api test -- auth.test.ts`
Expected: FAIL differently, or PASS — `auth.test.ts`'s *other* two tests use the `signUp()` helper from `./helpers.js`, which still POSTs to the now-disabled `/api/auth/sign-up/email`. This is expected and fixed in Task 4 (the helpers.ts rewrite); do not attempt to fix `helpers.ts` from within this task. Confirm specifically that the new "rejects password sign-up" test passes; the pre-existing two tests in this file are allowed to fail until Task 4 lands. (Task 3, which comes next, is the test-only OTP read-back endpoint — unrelated to this failure.)

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/auth.ts apps/api/test/auth.test.ts
git commit -m "feat(api): switch better-auth to email-OTP, retire password sign-in"
```

---

### Task 3: Test-only OTP-read endpoint (for E2E)

**Files:**
- Create: `apps/api/src/routes/test-only.ts`
- Create: `apps/api/test/test-only.test.ts`
- Modify: `apps/api/src/app.ts`

**Interfaces:**
- Produces: `GET /api/test-only/otp?email=<email>&type=sign-in` → `{ otp: string | null }` when `process.env.NODE_ENV !== "production"`; `404` otherwise. Consumed by Task 10 (`e2e/helpers.ts`).
- Consumes: `auth.api.getVerificationOTP` (better-auth's own server-only method, confirmed present via `createAuthEndpoint.serverOnly` in `node_modules/better-auth/dist/plugins/email-otp/routes.mjs`).

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/test-only.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @taakify/api test -- test-only.test.ts`
Expected: FAIL — `apps/api/src/routes/test-only.ts` does not exist yet.

- [ ] **Step 3: Implement `apps/api/src/routes/test-only.ts`**

```ts
// Test/E2E-only escape hatch to read back a pending OTP without a real
// inbox. Mirrors storage-dev.ts's env-gating style: always mounted, but
// functionally inert (404) outside non-production environments. Never
// reachable in production regardless of how NODE_ENV is set on this
// container -- see the throw in auth.ts for the project's convention of
// never trusting a soft default for anything security-sensitive.
import { Hono } from "hono";
import { auth } from "../auth.js";

export const testOnly = new Hono();

testOnly.get("/otp", async (c) => {
  if (process.env.NODE_ENV === "production") return c.json({ error: "not found" }, 404);
  const email = c.req.query("email");
  const type = c.req.query("type");
  if (!email || !type) return c.json({ error: "email and type query params required" }, 400);
  const result = await auth.api.getVerificationOTP({ query: { email, type: type as never } });
  return c.json(result);
});
```

- [ ] **Step 4: Mount the route in `apps/api/src/app.ts`**

```ts
import { storageDev } from "./routes/storage-dev.js";
import { testOnly } from "./routes/test-only.js";
```

Add near the bottom, after the existing `app.route("/api/storage", storageDev);` line:

```ts
// Dev/test/E2E-only OTP read-back -- see test-only.ts.
app.route("/api/test-only", testOnly);
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @taakify/api test -- test-only.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/test-only.ts apps/api/test/test-only.test.ts apps/api/src/app.ts
git commit -m "test(api): add NODE_ENV-gated OTP read-back endpoint for E2E"
```

---

### Task 4: Rewrite `apps/api/test/helpers.ts`'s `signUp` internals

**Files:**
- Modify: `apps/api/test/helpers.ts`

**Interfaces:**
- Produces: `signUp(app: Hono, email?: string): Promise<{ cookie: string; email: string }>` — **signature unchanged** from before this task. This is the entire point: 15 other test files call this and none of them need to change.
- Consumes: `getPendingOtp` from `apps/api/src/lib/otp-capture.ts` (added by Task 3 — a deviation from Task 3's original brief, discovered and fixed during Task 3's implementation: `auth.api.getVerificationOTP` cannot work here because `auth.ts` configures `storeOTP: "hashed"` (Task 2) and better-auth's own store never holds a recoverable plaintext OTP once hashed — that method throws "OTP is hashed, cannot return the plain text OTP" unconditionally. `otp-capture.ts` captures the plaintext at send time instead, in an env-gated in-memory map, and is the only way to read an OTP back in this codebase now).

**Correction from the original plan draft:** this task originally called
`auth.api.getVerificationOTP` directly, which was written before Task 3's
implementation discovered it cannot work under `storeOTP: "hashed"`. Use
`getPendingOtp` from `../src/lib/otp-capture.js` instead, as shown below.

- [ ] **Step 1: Run the full API test suite to capture the current failure baseline**

Run: `pnpm --filter @taakify/api test`
Expected: many failures — every file using `signUp()` now fails because it POSTs to the disabled `/api/auth/sign-up/email` (Task 2 disabled it). This is the expected, temporary state this task fixes.

- [ ] **Step 2: Rewrite `apps/api/test/helpers.ts`**

```ts
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
```

- [ ] **Step 3: Run the full API test suite**

Run: `pnpm --filter @taakify/api test`
Expected: PASS for every file except `apps/api/test/auth-hardening.test.ts` (fixed in Task 5) — all 15 files that call `signUp()` should now pass unchanged.

- [ ] **Step 4: Commit**

```bash
git add apps/api/test/helpers.ts
git commit -m "test(api): rewrite the shared signUp test helper to drive email-OTP internally"
```

---

### Task 5: Update `auth-hardening.test.ts` to exercise email-OTP mechanics

**Files:**
- Modify: `apps/api/test/auth-hardening.test.ts`

**Interfaces:**
- Consumes: `emailOTP` from `better-auth/plugins`, `adminPool` from `../src/db/pool.js` (already imported).

**Context:** this file builds throwaway `betterAuth()` instances (not the app's shared singleton) purely to prove cookie-security attributes and rate-limiting work in general. It currently proves this using `emailAndPassword`, a mechanism the real app no longer uses — rewrite both throwaway instances to use `emailOTP` instead, so the test proves the mechanism the app actually relies on now.

- [ ] **Step 1: Run the file to confirm current pass state (baseline)**

Run: `pnpm --filter @taakify/api test -- auth-hardening.test.ts`
Expected: PASS (unaffected by Tasks 2-4 since it builds its own isolated instances) — this step is just to confirm the starting point before you change it.

- [ ] **Step 2: Rewrite the file**

```ts
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
```

- [ ] **Step 3: Run the file to verify it passes**

Run: `pnpm --filter @taakify/api test -- auth-hardening.test.ts`
Expected: PASS

- [ ] **Step 4: Run the entire API test suite**

Run: `pnpm --filter @taakify/api test`
Expected: PASS, all files.

- [ ] **Step 5: Commit**

```bash
git add apps/api/test/auth-hardening.test.ts
git commit -m "test(api): exercise email-OTP mechanics in auth-hardening tests instead of the retired password endpoint"
```

---

### Task 6: Client wiring

**Files:**
- Modify: `apps/web/src/lib/auth.ts`

**Interfaces:**
- Produces: `authClient.emailOtp.sendVerificationOtp({ email, type })`, `authClient.signIn.emailOtp({ email, otp, name? })`, `authClient.emailOtp.requestEmailChange({ newEmail, otp? })`, `authClient.emailOtp.changeEmail({ newEmail, otp })` — all consumed by Task 7 (`Auth.tsx`) and Task 9 (`Profile.tsx`).

- [ ] **Step 1: Update `apps/web/src/lib/auth.ts`**

```ts
import { createAuthClient } from "better-auth/react";
import { emailOTPClient } from "better-auth/client/plugins";

// Same origin in dev (vite proxy) and prod (nginx) — no baseURL needed
// beyond the path prefix.
export const authClient = createAuthClient({
  basePath: "/api/auth",
  plugins: [emailOTPClient()],
});
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @taakify/web typecheck`
Expected: PASS (this file alone introduces no consumers yet — Task 7 is next).

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/lib/auth.ts
git commit -m "feat(web): add emailOTPClient to the better-auth client"
```

---

### Task 7: Unified `Auth.tsx` page, routing, and test rewrite

**Files:**
- Create: `apps/web/src/pages/Auth.tsx`
- Create: `apps/web/src/pages/Auth.test.tsx`
- Delete: `apps/web/src/pages/SignIn.tsx`, `apps/web/src/pages/SignIn.test.tsx`, `apps/web/src/pages/SignUp.tsx`, `apps/web/src/pages/SignUp.test.tsx`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/App.test.tsx`

**Interfaces:**
- Consumes: `authClient.emailOtp.sendVerificationOtp`, `authClient.signIn.emailOtp`, `authClient.signIn.social` (Task 6); `safeNext` from `../lib/safe-next.js` (unchanged); `Logo` from `../components/Logo.js` (unchanged).
- Produces: `Auth` — zero-prop component, rendered at both `/signin` and `/signup`.

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/pages/Auth.test.tsx`:

```tsx
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { Auth } from "./Auth.js";
import { authClient } from "../lib/auth.js";

vi.mock("../lib/auth.js", () => ({
  authClient: {
    emailOtp: { sendVerificationOtp: vi.fn(), verifyEmail: vi.fn() },
    signIn: { emailOtp: vi.fn(), social: vi.fn() },
    getSession: vi.fn(),
  },
}));

function renderAuth() {
  render(
    <MemoryRouter>
      <Auth />
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.mocked(authClient.emailOtp.sendVerificationOtp).mockReset().mockResolvedValue({ error: null } as never);
  vi.mocked(authClient.signIn.emailOtp).mockReset();
  vi.mocked(authClient.signIn.social).mockReset();
});

describe("Auth", () => {
  it("sends a code, then verifies it and signs in", async () => {
    const user = userEvent.setup();
    vi.mocked(authClient.signIn.emailOtp).mockResolvedValue({
      data: { token: "t", user: { id: "u1" } },
      error: null,
    } as never);
    renderAuth();

    await user.type(screen.getByLabelText("Email"), "ada@example.com");
    await user.click(screen.getByRole("button", { name: "Continue with email" }));

    await waitFor(() =>
      expect(authClient.emailOtp.sendVerificationOtp).toHaveBeenCalledWith({
        email: "ada@example.com",
        type: "sign-in",
      })
    );
    expect(await screen.findByLabelText(/6-digit code/i)).toBeInTheDocument();

    await user.type(screen.getByLabelText(/6-digit code/i), "123456");
    await user.click(screen.getByRole("button", { name: "Verify" }));

    await waitFor(() =>
      expect(authClient.signIn.emailOtp).toHaveBeenCalledWith({
        email: "ada@example.com",
        otp: "123456",
        name: "",
      })
    );
  });

  it("shows an error when sending the code fails", async () => {
    const user = userEvent.setup();
    vi.mocked(authClient.emailOtp.sendVerificationOtp).mockResolvedValue({
      error: { message: "Too many requests" },
    } as never);
    renderAuth();

    await user.type(screen.getByLabelText("Email"), "ada@example.com");
    await user.click(screen.getByRole("button", { name: "Continue with email" }));

    expect(await screen.findByText("Too many requests")).toBeInTheDocument();
  });

  it("offers Google sign-in", async () => {
    const user = userEvent.setup();
    renderAuth();
    await user.click(screen.getByRole("button", { name: "Continue with Google" }));
    expect(authClient.signIn.social).toHaveBeenCalledWith({ provider: "google", callbackURL: "/" });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @taakify/web test -- Auth.test.tsx`
Expected: FAIL — `apps/web/src/pages/Auth.tsx` does not exist yet.

- [ ] **Step 3: Create `apps/web/src/pages/Auth.tsx`**

```tsx
import { useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Mail, KeyRound } from "lucide-react";
import { authClient } from "../lib/auth.js";
import { safeNext } from "../lib/safe-next.js";
import { Button } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";
import { Label } from "../components/ui/label.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card.js";
import { Alert, AlertDescription } from "../components/ui/alert.js";
import { Logo } from "../components/Logo.js";

export function Auth() {
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  async function sendCode() {
    setError("");
    setSending(true);
    try {
      const { error } = await authClient.emailOtp.sendVerificationOtp({ email, type: "sign-in" });
      if (error) return setError(error.message ?? "Couldn't send the code");
      setStep("code");
    } finally {
      setSending(false);
    }
  }

  async function onEmailSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    await sendCode();
  }

  async function onCodeSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError("");
    setVerifying(true);
    try {
      const { error } = await authClient.signIn.emailOtp({ email, otp: code, name });
      if (error) return setError(error.message ?? "That code didn't work");
      await authClient.getSession();
      navigate(safeNext(searchParams.get("next"), "/"));
    } finally {
      setVerifying(false);
    }
  }

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-6 p-4">
      <Logo className="h-10 w-10" />
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>{step === "email" ? "Sign in to Taakify" : "Enter your code"}</CardTitle>
          <CardDescription>
            {step === "email"
              ? "One code, sent to your email — no password to remember."
              : `We sent a 6-digit code to ${email}.`}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {step === "email" ? (
            <>
              <form onSubmit={onEmailSubmit} className="grid gap-4">
                <div className="grid gap-2">
                  <Label htmlFor="email">Email</Label>
                  <div className="relative">
                    <Mail className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      id="email"
                      type="email"
                      placeholder="you@example.com"
                      required
                      className="pl-9"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                    />
                  </div>
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="name">Your name (only needed the first time)</Label>
                  <Input
                    id="name"
                    placeholder="Ada Lovelace"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </div>
                {error && (
                  <Alert variant="destructive">
                    <AlertDescription>{error}</AlertDescription>
                  </Alert>
                )}
                <Button type="submit" className="w-full" disabled={sending}>
                  {sending ? "Sending…" : "Continue with email"}
                </Button>
              </form>
              <Button
                type="button"
                variant="outline"
                className="w-full"
                onClick={() => authClient.signIn.social({ provider: "google", callbackURL: "/" })}
              >
                Continue with Google
              </Button>
            </>
          ) : (
            <form onSubmit={onCodeSubmit} className="grid gap-4">
              <div className="grid gap-2">
                <Label htmlFor="code">6-digit code</Label>
                <div className="relative">
                  <KeyRound className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    id="code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    placeholder="123456"
                    required
                    className="pl-9"
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                  />
                </div>
              </div>
              {error && (
                <Alert variant="destructive">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}
              <Button type="submit" className="w-full" disabled={verifying}>
                {verifying ? "Verifying…" : "Verify"}
              </Button>
              <div className="flex justify-between text-sm text-muted-foreground">
                <button
                  type="button"
                  className="underline-offset-4 hover:underline"
                  onClick={() => setStep("email")}
                >
                  Use a different email
                </button>
                <button type="button" className="underline-offset-4 hover:underline" onClick={sendCode}>
                  Resend code
                </button>
              </div>
            </form>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @taakify/web test -- Auth.test.tsx`
Expected: PASS

- [ ] **Step 5: Delete the old pages and their tests**

```bash
git rm apps/web/src/pages/SignIn.tsx apps/web/src/pages/SignIn.test.tsx apps/web/src/pages/SignUp.tsx apps/web/src/pages/SignUp.test.tsx
```

- [ ] **Step 6: Update `apps/web/src/App.tsx`**

Change the imports:

```tsx
import { Auth } from "./pages/Auth.js";
```

(Remove the `SignUp`/`SignIn` imports.)

Change the two auth routes:

```tsx
      <Route path="/signup" element={authed ? <Navigate to="/" /> : <Auth />} />
      <Route path="/signin" element={authed ? <Navigate to="/" /> : <Auth />} />
```

Everything else in `App.tsx` is unchanged — `unauthedRootElement`'s fallback still reads `<Navigate to="/signin" />`, which still renders `Auth` via the route above.

- [ ] **Step 7: Update `apps/web/src/App.test.tsx`**

Change the mock at the top of the file:

```tsx
vi.mock("./lib/auth.js", () => ({
  authClient: {
    useSession: vi.fn(),
    emailOtp: { sendVerificationOtp: vi.fn(), verifyEmail: vi.fn() },
    signIn: { emailOtp: vi.fn(), social: vi.fn() },
    signOut: vi.fn(),
  },
}));
```

Update the one test that asserts on the old `SignIn` copy (the other, "shows the landing page...", is intentionally left untouched by this task — see the note below):

```tsx
  it("still redirects unauthenticated users from /library to /signin", () => {
    vi.mocked(authClient.useSession).mockReturnValue({ data: null, isPending: false } as never);
    renderApp("/library");
    expect(screen.getByRole("heading", { name: "Sign in to Taakify" })).toBeInTheDocument();
  });
```

This heading text is unchanged — `Auth.tsx`'s email-step title is still "Sign in to Taakify" — so this test actually needs no edit at all; it's called out here only to confirm it still passes with the new `Auth` component in place.

**Do not touch the "shows the landing page for unauthenticated visitors at /" test in this task.** It currently asserts `screen.getByRole("link", { name: "Sign up" })` and `{ name: "Sign in" })`, matching `Landing.tsx`'s *current* two-button state — `Landing.tsx` isn't changed until Task 8. Updating this assertion here would make it fail from this task's commit until Task 8 lands. Task 8 owns this specific assertion change (to a single "Get started" link) because Task 8 is what actually changes `Landing.tsx`'s buttons.

- [ ] **Step 8: Run the full web test suite**

Run: `pnpm --filter @taakify/web test`
Expected: PASS. (`Landing.test.tsx` will still fail at this point — that's Task 8, not this one.)

- [ ] **Step 9: Typecheck and build**

Run: `pnpm --filter @taakify/web typecheck && pnpm --filter @taakify/web build`
Expected: PASS

- [ ] **Step 10: Commit**

```bash
git add apps/web/src/pages/Auth.tsx apps/web/src/pages/Auth.test.tsx apps/web/src/App.tsx apps/web/src/App.test.tsx
git commit -m "feat(web): replace SignIn/SignUp with a unified email-OTP Auth page"
```

---

### Task 8: Landing page CTA

**Files:**
- Modify: `apps/web/src/pages/Landing.tsx`
- Modify: `apps/web/src/pages/Landing.test.tsx`
- Modify: `apps/web/src/App.test.tsx` (one assertion — see Step 5)

**Interfaces:** none new — pure copy/markup change in the closing section.

- [ ] **Step 1: Update the failing assertion first**

In `apps/web/src/pages/Landing.test.tsx`, replace:

```tsx
  it("links to sign up and sign in, once each, after the value props", () => {
    renderLanding();
    expect(screen.getByRole("link", { name: "Sign up" })).toHaveAttribute("href", "/signup");
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/signin");
  });
```

with:

```tsx
  it("links to the unified sign-in flow with a single CTA", () => {
    renderLanding();
    expect(screen.getByRole("link", { name: "Get started" })).toHaveAttribute("href", "/signin");
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @taakify/web test -- Landing.test.tsx`
Expected: FAIL — `Landing.tsx` still renders two buttons named "Sign up"/"Sign in".

- [ ] **Step 3: Update `apps/web/src/pages/Landing.tsx`**

Replace the closing section's button block:

```tsx
        <div className="flex w-full max-w-xs flex-col gap-3">
          <Button asChild className="w-full">
            <Link to="/signup">Sign up</Link>
          </Button>
          <Button asChild variant="outline" className="w-full">
            <Link to="/signin">Sign in</Link>
          </Button>
        </div>
```

with:

```tsx
        <div className="flex w-full max-w-xs flex-col gap-3">
          <Button asChild className="w-full">
            <Link to="/signin">Get started</Link>
          </Button>
        </div>
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @taakify/web test -- Landing.test.tsx`
Expected: PASS

- [ ] **Step 5: Update `apps/web/src/App.test.tsx`'s landing-page assertion**

Task 7 deliberately left this one test's assertion on the old copy, since `Landing.tsx` hadn't changed yet at that point. Now that Step 3 above has landed, update it:

```tsx
  it("shows the landing page for unauthenticated visitors at /", () => {
    vi.mocked(authClient.useSession).mockReturnValue({ data: null, isPending: false } as never);
    renderApp("/");
    expect(screen.getByRole("heading", { name: "Taakify" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Get started" })).toBeInTheDocument();
  });
```

- [ ] **Step 6: Run the full web test suite**

Run: `pnpm --filter @taakify/web test`
Expected: PASS, all files — this confirms Step 5's `App.test.tsx` change lines up with Step 3's `Landing.tsx` change.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/pages/Landing.tsx apps/web/src/pages/Landing.test.tsx apps/web/src/App.test.tsx
git commit -m "feat(web): collapse Landing's Sign up/Sign in buttons into one Get started CTA"
```

---

### Task 9: Profile page — change email and name

**Files:**
- Modify: `apps/web/src/pages/Profile.tsx`
- Modify: `apps/web/src/pages/Profile.test.tsx`

**Interfaces:**
- Consumes: `authClient.emailOtp.sendVerificationOtp`, `authClient.emailOtp.requestEmailChange`, `authClient.emailOtp.changeEmail`, `authClient.updateUser` (better-auth core client method, already available without a plugin).

**Context:** per Task 2's `verifyCurrentEmail: true` and the plugin source (`routes.mjs` lines 630-660), changing email is a three-step handshake: (1) send an OTP to the *current* email (`type: "email-verification"`), (2) submit that OTP plus the new email to `requestEmailChange` — which, on success, sends a *second* OTP to the new email, (3) submit that second OTP plus the new email to `changeEmail` to finalize.

- [ ] **Step 1: Write the failing tests**

Add to `apps/web/src/pages/Profile.test.tsx` (check the existing file's mock setup first and extend it — it already mocks `useHousehold`, `listBooks`, and `api`; add mocks for the three `authClient.emailOtp.*` methods and `authClient.updateUser` following the same `vi.mock` pattern already used for other modules in that file):

```tsx
describe("Profile account settings", () => {
  it("changes the display name", async () => {
    const user = userEvent.setup();
    vi.mocked(authClient.updateUser).mockResolvedValue({ error: null } as never);
    renderProfile();

    await user.click(screen.getByRole("button", { name: "Edit name" }));
    const nameInput = screen.getByLabelText("Name");
    await user.clear(nameInput);
    await user.type(nameInput, "Grace Hopper");
    await user.click(screen.getByRole("button", { name: "Save name" }));

    await waitFor(() =>
      expect(authClient.updateUser).toHaveBeenCalledWith({ name: "Grace Hopper" })
    );
  });

  it("walks through the three-step email change", async () => {
    const user = userEvent.setup();
    vi.mocked(authClient.emailOtp.sendVerificationOtp).mockResolvedValue({ error: null } as never);
    vi.mocked(authClient.emailOtp.requestEmailChange).mockResolvedValue({ error: null } as never);
    vi.mocked(authClient.emailOtp.changeEmail).mockResolvedValue({ error: null } as never);
    renderProfile();

    await user.click(screen.getByRole("button", { name: "Change email" }));
    await user.click(screen.getByRole("button", { name: "Send code to current email" }));
    await waitFor(() =>
      expect(authClient.emailOtp.sendVerificationOtp).toHaveBeenCalledWith({
        email: expect.any(String),
        type: "email-verification",
      })
    );

    await user.type(screen.getByLabelText("Code sent to your current email"), "111111");
    await user.type(screen.getByLabelText("New email"), "new@example.com");
    await user.click(screen.getByRole("button", { name: "Send code to new email" }));
    await waitFor(() =>
      expect(authClient.emailOtp.requestEmailChange).toHaveBeenCalledWith({
        newEmail: "new@example.com",
        otp: "111111",
      })
    );

    await user.type(screen.getByLabelText("Code sent to your new email"), "222222");
    await user.click(screen.getByRole("button", { name: "Confirm new email" }));
    await waitFor(() =>
      expect(authClient.emailOtp.changeEmail).toHaveBeenCalledWith({
        newEmail: "new@example.com",
        otp: "222222",
      })
    );
  });
});
```

(Match this repo's existing test conventions exactly — check how `renderProfile()`, `authClient` mocking, and `userEvent`/`waitFor` imports are already set up at the top of `Profile.test.tsx` before adding these, rather than assuming import names.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @taakify/web test -- Profile.test.tsx`
Expected: FAIL — no such UI exists yet in `Profile.tsx`.

- [ ] **Step 3: Add the account-settings section to `apps/web/src/pages/Profile.tsx`**

Add to the imports:

```tsx
import { authClient } from "../lib/auth.js";
```

Add new state (alongside the existing invite-dialog state):

```tsx
  const [nameOpen, setNameOpen] = useState(false);
  const [nameValue, setNameValue] = useState(user.name);
  const [nameError, setNameError] = useState("");
  const [savingName, setSavingName] = useState(false);

  const [emailOpen, setEmailOpen] = useState(false);
  const [emailStep, setEmailStep] = useState<"start" | "current-otp" | "new-otp">("start");
  const [currentOtp, setCurrentOtp] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [newOtp, setNewOtp] = useState("");
  const [emailError, setEmailError] = useState("");
  const [emailBusy, setEmailBusy] = useState(false);
```

Add the handlers (alongside `handleInvite`/`handleCopyInviteUrl`):

```tsx
  async function handleSaveName(e: FormEvent) {
    e.preventDefault();
    setNameError("");
    setSavingName(true);
    try {
      const { error } = await authClient.updateUser({ name: nameValue });
      if (error) return setNameError(error.message ?? "Couldn't save your name");
      toast("Name updated");
      setNameOpen(false);
    } finally {
      setSavingName(false);
    }
  }

  async function handleSendCurrentEmailOtp() {
    setEmailError("");
    setEmailBusy(true);
    try {
      const { error } = await authClient.emailOtp.sendVerificationOtp({
        email: user.email,
        type: "email-verification",
      });
      if (error) return setEmailError(error.message ?? "Couldn't send the code");
      setEmailStep("current-otp");
    } finally {
      setEmailBusy(false);
    }
  }

  async function handleRequestEmailChange(e: FormEvent) {
    e.preventDefault();
    setEmailError("");
    setEmailBusy(true);
    try {
      const { error } = await authClient.emailOtp.requestEmailChange({ newEmail, otp: currentOtp });
      if (error) return setEmailError(error.message ?? "Couldn't verify that code");
      setEmailStep("new-otp");
    } finally {
      setEmailBusy(false);
    }
  }

  async function handleConfirmEmailChange(e: FormEvent) {
    e.preventDefault();
    setEmailError("");
    setEmailBusy(true);
    try {
      const { error } = await authClient.emailOtp.changeEmail({ newEmail, otp: newOtp });
      if (error) return setEmailError(error.message ?? "Couldn't verify that code");
      toast("Email updated");
      setEmailOpen(false);
    } finally {
      setEmailBusy(false);
    }
  }

  function resetEmailDialog(open: boolean) {
    setEmailOpen(open);
    if (!open) {
      setEmailStep("start");
      setCurrentOtp("");
      setNewEmail("");
      setNewOtp("");
      setEmailError("");
    }
  }
```

Add the JSX section (place it right after the household-name header block, before the "Reading counts" section):

```tsx
      <section className="space-y-2">
        <h2 className="text-sm font-semibold">Account</h2>
        <div className="flex flex-wrap gap-2">
          <Dialog open={nameOpen} onOpenChange={setNameOpen}>
            <DialogTrigger asChild>
              <Button size="sm" variant="outline">
                Edit name
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Edit name</DialogTitle>
              </DialogHeader>
              <form onSubmit={handleSaveName} className="space-y-3">
                <div className="space-y-1">
                  <Label htmlFor="profile-name">Name</Label>
                  <Input
                    id="profile-name"
                    value={nameValue}
                    onChange={(e) => setNameValue(e.target.value)}
                    required
                  />
                </div>
                {nameError && (
                  <Alert variant="destructive">
                    <AlertDescription>{nameError}</AlertDescription>
                  </Alert>
                )}
                <DialogFooter>
                  <Button type="submit" disabled={savingName}>
                    {savingName ? "Saving…" : "Save name"}
                  </Button>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>

          <Dialog open={emailOpen} onOpenChange={resetEmailDialog}>
            <DialogTrigger asChild>
              <Button size="sm" variant="outline">
                Change email
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Change email</DialogTitle>
              </DialogHeader>
              {emailStep === "start" && (
                <div className="space-y-3">
                  <p className="text-sm text-muted-foreground">
                    We'll send a code to your current email ({user.email}) first, to confirm it's you.
                  </p>
                  {emailError && (
                    <Alert variant="destructive">
                      <AlertDescription>{emailError}</AlertDescription>
                    </Alert>
                  )}
                  <DialogFooter>
                    <Button onClick={handleSendCurrentEmailOtp} disabled={emailBusy}>
                      {emailBusy ? "Sending…" : "Send code to current email"}
                    </Button>
                  </DialogFooter>
                </div>
              )}
              {emailStep === "current-otp" && (
                <form onSubmit={handleRequestEmailChange} className="space-y-3">
                  <div className="space-y-1">
                    <Label htmlFor="current-otp">Code sent to your current email</Label>
                    <Input
                      id="current-otp"
                      value={currentOtp}
                      onChange={(e) => setCurrentOtp(e.target.value)}
                      required
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="new-email">New email</Label>
                    <Input
                      id="new-email"
                      type="email"
                      value={newEmail}
                      onChange={(e) => setNewEmail(e.target.value)}
                      required
                    />
                  </div>
                  {emailError && (
                    <Alert variant="destructive">
                      <AlertDescription>{emailError}</AlertDescription>
                    </Alert>
                  )}
                  <DialogFooter>
                    <Button type="submit" disabled={emailBusy}>
                      {emailBusy ? "Sending…" : "Send code to new email"}
                    </Button>
                  </DialogFooter>
                </form>
              )}
              {emailStep === "new-otp" && (
                <form onSubmit={handleConfirmEmailChange} className="space-y-3">
                  <div className="space-y-1">
                    <Label htmlFor="new-otp">Code sent to your new email</Label>
                    <Input id="new-otp" value={newOtp} onChange={(e) => setNewOtp(e.target.value)} required />
                  </div>
                  {emailError && (
                    <Alert variant="destructive">
                      <AlertDescription>{emailError}</AlertDescription>
                    </Alert>
                  )}
                  <DialogFooter>
                    <Button type="submit" disabled={emailBusy}>
                      {emailBusy ? "Confirming…" : "Confirm new email"}
                    </Button>
                  </DialogFooter>
                </form>
              )}
            </DialogContent>
          </Dialog>
        </div>
      </section>
```

Also add `import { useState, type FormEvent, ... }` — `FormEvent` is already imported in this file per its existing `handleInvite` signature, so no new type import is needed there; only the `authClient` import above is new.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @taakify/web test -- Profile.test.tsx`
Expected: PASS

- [ ] **Step 5: Run the full web suite, typecheck, and build**

Run: `pnpm --filter @taakify/web typecheck && pnpm --filter @taakify/web test && pnpm --filter @taakify/web build`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/pages/Profile.tsx apps/web/src/pages/Profile.test.tsx
git commit -m "feat(web): let users change their name and email from Profile"
```

---

### Task 10: E2E suite — OTP-aware sign-up helper

**Files:**
- Modify: `e2e/helpers.ts`

**Interfaces:**
- Consumes: `GET /api/test-only/otp` (Task 3).
- Produces: `signUpAndOnboard(page)` — same return shape as before (`{ email, householdId }`), internals rewritten.

- [ ] **Step 1: Read the current `signUpAndOnboard` implementation**

Before editing, re-read `e2e/helpers.ts` in full — this plan was written against a snapshot of it; confirm line numbers and exact surrounding code haven't drifted before making the edit below.

- [ ] **Step 2: Rewrite the sign-up portion of `signUpAndOnboard`**

Replace the block that fills "Your name"/"Email"/"Password" and clicks "Sign up" with:

```ts
  await page.goto("/signup");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel(/Your name/).fill("E2E Test User");
  await page.getByRole("button", { name: "Continue with email" }).click();

  await page.getByLabel(/6-digit code/i).waitFor();
  const otpRes = await page.request.get(
    `/api/test-only/otp?email=${encodeURIComponent(email)}&type=sign-in`
  );
  const { otp } = await otpRes.json();
  if (!otp) throw new Error(`no OTP pending for ${email}`);
  await page.getByLabel(/6-digit code/i).fill(otp);
  await page.getByRole("button", { name: "Verify" }).click();
```

Leave everything after this (the onboarding heading wait, "Library name" fill, "Create library" click, `/api/me` read-back) unchanged — that part of the flow doesn't involve auth and is unaffected.

- [ ] **Step 3: Run one E2E spec to verify the helper works**

Run: `pnpm test:e2e e2e/home.spec.ts` (requires `docker compose -f docker-compose.dev.yml up -d`, `pnpm migrate`, and `pnpm dev:api`/`pnpm dev:web` runnable per `CLAUDE.md` — or let Playwright's own `webServer` config start them)
Expected: PASS

- [ ] **Step 4: Run the full E2E suite**

Run: `pnpm test:e2e`
Expected: PASS, all spec files (this suite runs serially and takes several minutes — see `playwright.config.ts`'s own comment on why).

- [ ] **Step 5: Commit**

```bash
git add e2e/helpers.ts
git commit -m "test(e2e): drive email-OTP sign-up via the test-only OTP endpoint"
```

---

### Task 11: Full verification pass

**Files:** none (verification only)

- [ ] **Step 1: Full API suite**

Run: `pnpm --filter @taakify/api typecheck && pnpm --filter @taakify/api test`
Expected: PASS

- [ ] **Step 2: Full web suite**

Run: `pnpm --filter @taakify/web typecheck && pnpm --filter @taakify/web test && pnpm --filter @taakify/web build`
Expected: PASS

- [ ] **Step 3: Full E2E suite**

Run: `pnpm test:e2e`
Expected: PASS

- [ ] **Step 4: Manual check in the browser**

Start `pnpm dev:api`/`pnpm dev:web`, open `http://localhost:5173/` in a private window:
- Click "Get started" → lands on the email step.
- Enter an email, submit → code step appears; the OTP is printed to the API server's console (no `RESEND_API_KEY` set in dev by default).
- Enter the printed code → lands on `/onboarding` (new account) or `/` (existing account).
- From Profile, change your name and confirm it updates.
- From Profile, walk through the email-change flow (checking each OTP in the API server's console) and confirm the email updates.
- Confirm "Continue with Google" still works if `GOOGLE_CLIENT_ID`/`SECRET` are set locally, or is at least present and clickable if not.

- [ ] **Step 5: Report back**

Summarize what was verified and any deviations made from the plan. No commit needed for this task — it's verification-only.
