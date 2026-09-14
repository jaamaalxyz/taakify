# Taakify Email-OTP Authentication Design

**Status:** Draft, pending user review
**Date:** 2026-09-14

## Motivation

The user got locked out of their own test account after forgetting their password, with no recovery path (no forgot-password flow exists). Rather than bolt a password-reset flow onto password auth, the decision (made in brainstorming) is to remove password auth entirely: email is the identity, a one-time code proves control of it, and there is nothing to forget. Passkeys and MFA were explicitly requested too, but are scoped **out** of this project — see "Non-goals" below — to keep this to one coherent, shippable change.

## Goals

- Replace `emailAndPassword` sign-in/sign-up with a single, unified email-OTP flow: the same form and the same "enter the email, enter the code" steps work whether the visitor already has an account or not.
- Keep Google sign-in as an alternate path (no regression for it).
- Let a signed-in user change their email (re-verified via OTP to the new address) and name from the Profile page.
- Stand up real email delivery (Resend) — today the app sends no email at all; invites are hand-shared links (see `CLAUDE.md`'s own note on `invite.email` being "informational only").

## Non-goals (this project)

- Passkeys / WebAuthn (`@better-auth/passkey`, a separate package not yet installed, likely requiring a bump of `better-auth` core past the currently-resolved 1.6.23).
- Multi-factor authentication (better-auth's `two-factor` plugin, already bundled but unused).
- Any change to the invite flow's token-based, email-agnostic acceptance model (`apps/api/src/routes/invites.ts`) — accepting an invite is unaffected by how the acceptor authenticates.
- Any change to session/RLS model — `app.user_id` is still set from the authenticated user's id exactly as today; only how that identity is established changes.

Passkeys/MFA are the natural follow-up project once this ships.

## Architecture

better-auth (already a dependency, resolves to 1.6.23) ships an `email-otp` server plugin and a matching `emailOTPClient` client plugin. Both are used as-is — no custom OTP generation/storage/expiry logic needs to be written.

**No new database tables.** The plugin stores OTPs in the existing `verification` table (`migrations/0001_auth.sql`: `identifier`/`value`/`expiresAt`), the same table better-auth already uses for other verification flows. `storeOTP: "hashed"` is used so a `SELECT * FROM verification` doesn't reveal a live code in plaintext.

### Server (`apps/api/src/auth.ts`)

- `emailAndPassword: { enabled: false }` — turns off password endpoints entirely. Existing `account` rows with a `password` column just go unused; not deleted (no destructive migration needed — deleting them would serve no purpose since RLS/session identity is keyed on `user.id`, not on which credential type exists).
- Add the `emailOTP` plugin:

  ```ts
  emailOTP({
    sendVerificationOTP: sendOtpEmail, // see "Email delivery" below
    otpLength: 6,
    expiresIn: 300, // 5 minutes, matches the plugin default; stated explicitly rather than left implicit
    allowedAttempts: 3,
    storeOTP: "hashed",
    changeEmail: { enabled: true, verifyCurrentEmail: true },
  })
  ```

  `changeEmail.verifyCurrentEmail: true` requires proving control of the *current* email before switching to a new one — the safer default for a household app where a stolen session token shouldn't be enough to silently redirect an account's email to an attacker's address.
- `socialProviders.google` config is untouched.

### Client (`apps/web/src/lib/auth.ts`)

- Add `emailOTPClient()` to `createAuthClient`'s `plugins` array, which types `authClient.emailOtp.sendVerificationOtp(...)` and `authClient.signIn.emailOtp(...)`.

### Email delivery (new: `apps/api/src/lib/email.ts`)

- Uses Resend's API (new dependency: `resend` npm package) when `RESEND_API_KEY` is set.
- When unset (dev/test, matching the existing `googleEnabled`-style env-gating pattern already used for Google OAuth in `auth.ts`), logs the OTP to the server console instead of sending — so local development and the test suite never need a real Resend account.
- One function, `sendOtpEmail({ email, otp, type })`, passed directly as the plugin's `sendVerificationOTP` callback. Copy varies slightly by `type` ("sign-in" vs "change-email") but the mechanism is identical.
- New env vars: `RESEND_API_KEY` (optional — unset falls back to console logging), `EMAIL_FROM` (required whenever `RESEND_API_KEY` is set — the verified sending address/domain).

## Web flow

### New unified page: `apps/web/src/pages/Auth.tsx` (replaces `SignIn.tsx` and `SignUp.tsx`)

Both `/signin` and `/signup` routes render this same component — there is no meaningful difference between the two once "sign in" and "sign up" are the same operation. Both routes are kept (rather than deleting one) so existing links/bookmarks to either still work; see "Landing.tsx changes" below for how the marketing page itself links in.

Two-step form, one component, local state for which step is showing:

1. **Email step:** email field, optional "Your name" field (the plugin's own doc comment confirms `name` is "Only used if the user is registering for the first time" — safe to always show, it can't clobber an existing user's name), "Continue with email" button. A separate "Continue with Google" button below it (unchanged Google flow).
2. **Code step:** shows the email being verified, a 6-digit code input, "Verify" button, and a "Resend code" link (calls `sendVerificationOtp` again). A "use a different email" link goes back to step 1.

On successful verification (`authClient.signIn.emailOtp({ email, otp, name })`), navigate exactly where `SignIn.tsx`/`SignUp.tsx` do today: `safeNext(searchParams.get("next"), "/")` for sign-in-shaped entry, falling into the existing `/onboarding` redirect for a user with no household yet (that logic lives in `household-context`/`App.tsx` already and is untouched).

### `Landing.tsx` changes

The current closing section has two separate buttons, "Sign up" and "Sign in," because those used to be two different flows. With one unified flow there is nothing left for a visitor to choose between, so that choice — and the friction of making it — goes away:

- Replace both buttons with a single primary CTA button, copy **"Get started"**, linking to `/signin` (the canonical route; `/signup` still exists and renders the same page, per above, for anyone who lands on it directly from an old link).
- No other copy on the page changes — the hero, subhead, and three benefit sections are unaffected by this switch; this is purely the final call-to-action.
- `Landing.test.tsx`'s existing assertion that checks for a "Sign up" link and a separate "Sign in" link is replaced with one assertion: a single link named "Get started" pointing at `/signin`.

### `Profile.tsx` additions

- **Change email:** a form calling `authClient.emailOtp.requestEmailChange({ newEmail })` (name TBD against the actual client plugin's exposed method — confirm exact name during implementation), which — per `verifyCurrentEmail: true` — first sends an OTP to the *current* email, then (after that's entered) sends one to the *new* email, then calls the change endpoint with that second OTP. Two short inline steps, not a separate page.
- **Change name:** a plain field + save, via better-auth's existing `updateUser` client method (no OTP needed — this isn't a security-sensitive identity change).

## Rollout / migration

- No data migration. Existing `user` rows are untouched; a user who signed up with a password before this ships logs in afterward with the same email via OTP and lands in the same account, same household memberships, same everything — identity is the `user.id`, never the credential type.
- Orphaned password credentials in `account` are left in place, not cleaned up (harmless, and deleting them is a separate, unrelated bit of housekeeping this project doesn't need to do).
- `docker-compose.dev.yml`/`apps/api/.env.example` gain `RESEND_API_KEY` (commented out / blank by default) and `EMAIL_FROM`.

## Open questions to resolve during planning (not blocking spec approval)

1. **Plugin-level rate limits vs. the app's `rateLimit.enabled` toggle.** `auth.ts`'s existing comment notes the top-level `rateLimit.enabled` is off in dev/test specifically so the test suite's rapid account creation isn't throttled. The `email-otp` plugin ships its *own* per-endpoint rate limit list (default `{ window: 60, max: 3 }` on send-otp/verify endpoints) — it needs verifying whether that master `rateLimit.enabled: false` switch actually suppresses the plugin's own rules too, or whether they fire unconditionally. If the latter, the test suite needs either a much higher configured limit in test, or a per-request bypass — this is an implementation-time investigation, not a design fork.
2. **Exact client method name** for requesting an email change (`authClient.emailOtp.requestEmailChange` vs. some other name) — verify against the installed version's actual client typings rather than guessing further in this document.
3. **Copy for the OTP email itself** (subject line, body wording) — small, deferred to implementation; should match the existing brand voice (plain, concrete, no marketing fluff — see `Landing.tsx`'s copy for the established tone).

## Testing impact

- Every test that currently drives password sign-up (`apps/api/test`'s helpers, `apps/web/src/pages/SignIn.test.tsx`, `SignUp.test.tsx`, and any E2E spec under `e2e/` using `signUpAndOnboard`-style helpers) needs rewriting against the OTP flow. In test, `sendOtpEmail` never calls Resend (no `RESEND_API_KEY`) — tests read the OTP straight from wherever the console-log fallback puts it, or (cleaner) the test helper calls the plugin's `getVerificationOTP` endpoint directly (visible in the plugin's own type surface) rather than scraping logs.
- `SignIn.test.tsx`/`SignUp.test.tsx` are deleted, replaced by one `Auth.test.tsx` covering: email-step validation, code-step verification (both "existing user logs in" and "new user is created" cases), resend, and the Google button still being present.
- `App.test.tsx`'s two landing-adjacent routing tests (`/signup`, `/signin` both rendering *something* for an unauthenticated visitor) still hold structurally, just now assert against `Auth`'s rendered content instead of the old `SignIn`/`SignUp` copy.
- `Landing.test.tsx`'s CTA assertion updates per "Landing.tsx changes" above: one "Get started" link to `/signin`, not separate "Sign up"/"Sign in" links.
