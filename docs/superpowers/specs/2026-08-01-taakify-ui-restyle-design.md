# Taakify UI Restyle: Design Spec

**Status:** Approved for planning
**Scope:** `apps/web` only — no API or schema changes.

## 1. Overview

Plan 1 (Foundation) shipped a fully working auth/household/invite flow with
placeholder styling (9-line `styles.css`, no component library, no icons).
This spec restyles the five existing pages (SignIn, SignUp, Onboarding,
InviteAccept, Home) using Tailwind CSS + shadcn/ui + lucide-react, and adds
frontend test coverage from zero. It does not add new pages, routes, or
backend functionality — it is a visual and testing pass over Plan 1's
existing surface area.

Not part of a previously-planned Plan 2 (ElectricSQL sync) or Plan 3 (books
domain) — this is new, unplanned work that gives those future plans a real
design system and component library to build on.

## 2. Visual Direction

- **Tone:** playful family — friendly and approachable, not a generic SaaS
  dashboard, not childish/toyish.
- **Accent color:** warm coral/orange as `--primary`, paired with a
  cream/off-white background in light mode.
- **Typography:** "Nunito" (rounded sans) loaded via `@fontsource/nunito` (or
  a `<link>` in `index.html`), used for all headings and body text — replaces
  the current `system-ui` stack everywhere.
- **Theming:** light and dark mode both supported from the start, using
  shadcn/ui's standard CSS-variable convention (`--background`, `--primary`,
  `--destructive`, etc.) defined in `:root` and `.dark`. A `useTheme` hook
  reads/writes `localStorage`, defaulting to `prefers-color-scheme`, and
  toggles a `dark` class on `<html>`.
- **Icons:** lucide-react, functional spots only (email/password field
  icons, copy, invite, log-out, book/empty-state icon) — not decorative
  icons on every button.

## 3. Tooling & Setup

- **Tailwind CSS v4** via the `@tailwindcss/vite` plugin. CSS-first config —
  no `tailwind.config.js`; theme tokens defined with `@theme` in
  `apps/web/src/styles.css`.
- **shadcn/ui** initialized via `npx shadcn@latest init`, producing
  `apps/web/components.json` and `src/lib/utils.ts` (the `cn()` helper).
  Components are installed as editable source files under
  `src/components/ui/` (not an npm dependency) so the coral/rounded-sans
  palette can be applied directly to them.
- **lucide-react** added as a direct dependency.
- Existing `apps/web/src/styles.css` is replaced by the Tailwind
  entrypoint + `@theme` tokens; the old hand-rolled rules (`.error`,
  `.muted`, bare `input`/`button` styles) are removed once their shadcn
  equivalents are in place.

## 4. Component Set

Installed via shadcn CLI: **Button, Input, Label, Card, Dialog, Alert,
Avatar, Skeleton**.

## 5. Page-by-Page Changes

- **SignIn / SignUp** (`src/pages/SignIn.tsx`, `SignUp.tsx`): form wrapped in
  a `Card` (title + description), `Input`+`Label` pairs with `Mail`/`Lock`
  lucide icons, `Button` for submit and "Continue with Google". Errors
  render in a destructive `Alert` instead of `<p className="error">`.
- **Onboarding** (`src/pages/Onboarding.tsx`): same `Card`-based form
  treatment as sign in/up, for visual consistency across the auth funnel.
- **InviteAccept** (`src/pages/InviteAccept.tsx`): household name and accept
  action shown in a `Card`; loading state uses `Skeleton` instead of a
  "Loading…" text node.
- **Home** (`src/pages/Home.tsx`):
  - Header: `Avatar` (initials derived from `me.user.name`), household name
    and role, plus a `LogOut`-icon `Button` for sign-out.
  - Invite flow: clicking "Invite a family member" opens a `Dialog`
    containing an `Input` for the invitee's email — replaces the current
    `prompt()` call. On success the dialog shows the invite link with a
    `Copy`-icon button (replaces the bare `<code>` text); on failure the
    dialog shows a destructive `Alert` instead of `alert()`.
  - Empty state ("you're not in a library yet"): `Card` with a `BookOpen`
    icon and the "Create your library" `Button`/link.
  - Loading state: `Skeleton` rows instead of "Loading…" text.
- **App.tsx**: the top-level `isPending` loading state also swaps from plain
  muted text to a `Skeleton`/spinner.

No routes, props, or API contracts change. `src/lib/api.ts`, `auth.ts`, and
`safe-next.ts` are untouched.

## 6. Testing

- **New tooling:** Vitest (matching the API's existing test runner) +
  `@testing-library/react` + `@testing-library/user-event` + `jsdom`,
  configured via `apps/web/vitest.config.ts`. The root `pnpm test` script is
  extended to run both `@taakify/api` and `@taakify/web` test suites.
- **Coverage — one test file per page/behavior:**
  - `SignIn.test.tsx` / `SignUp.test.tsx` — renders the form; submitting
    valid input calls the corresponding `authClient` method; a returned
    error renders in the `Alert`; "Continue with Google" triggers
    `authClient.signIn.social`.
  - `Onboarding.test.tsx` — submitting a household name calls the create
    API and navigates on success.
  - `InviteAccept.test.tsx` — renders the household name from a loaded
    invite; accepting calls the API; a load/accept error renders an
    `Alert`.
  - `Home.test.tsx` — renders the membership state and the empty state;
    the invite `Dialog` opens, submits, and shows the returned link; the
    copy button works; sign-out calls `authClient.signOut`.
  - `App.test.tsx` — route guarding: unauthenticated users are redirected
    to `/signin`; authenticated users are redirected away from
    `/signin`/`/signup`.
- `authClient` (`src/lib/auth.ts`) and the `api()` helper (`src/lib/api.ts`)
  are mocked at the module boundary with `vi.mock` — these are
  component/unit tests, not integration tests against a real server.
- **Deferred:** Playwright end-to-end tests covering the full sign-up →
  household → invite → accept journey through a real browser and API are
  explicitly out of scope for this pass, noted here as a follow-up once
  there's more app surface area to justify the E2E harness.

## 7. Out of Scope

- New pages, routes, or backend/API changes.
- Per-member accent colors (considered, deferred — see Section 2).
- Decorative (non-functional) icon usage.
- Playwright/E2E test coverage.
- Mobile app / PWA-specific chrome (that's Plan 1's existing PWA setup,
  untouched here).
