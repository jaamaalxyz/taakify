# Taakify Landing Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give unauthenticated visitors a minimal landing page at `/` instead of the current bounce straight to `/signin`, per the Public MVP Launch spec's §6.

**Architecture:** One new page component (`apps/web/src/pages/Landing.tsx`) rendered in place of the existing `<Navigate to="/signin" />` for the root route, but only for the root path — every other authed-only route (`/library`, `/add`, etc.) keeps bouncing unauthenticated visitors to `/signin` exactly as today. No new routing library, no separate build pipeline, no new framework: this is one more component in the existing React Router v6 route table in `App.tsx`, styled with the same Tailwind/shadcn primitives (`Button`, `Card`) already used by `SignIn.tsx`/`SignUp.tsx`.

**Tech Stack:** React 19, react-router-dom v7, Tailwind v4, shadcn/ui components (`Button`, existing `lucide-react` icons), Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-09-08-taakify-public-mvp-launch-design.md` (§6 Minimal Landing Page)

## Global Constraints

- Spec §6, verbatim: "A single static page at `/` ... shown to unauthenticated visitors instead of the current bounce to `/signin`: a few lines on what Taakify is, and two buttons — Sign up, Sign in — linking into the existing `SignUp`/`SignIn` pages. No separate build pipeline, no new framework; it's one more component/route in the existing `apps/web` app. Authenticated visitors keep being redirected straight into the app as today."
- Authenticated visitors' behavior must not change at all: `/` continues to render `Home` inside `AppShell` exactly as it does today, and navigating between `/` and any other authed route must not remount `AppShell` (it currently doesn't, because all authed routes share one `<Route element={<AppShell />}>` wrapper — this plan must not break that sharing).
- Every non-root authed-only route (`/library`, `/library/:bookId`, `/add`, `/import`, `/loans`, `/bookcases`, `/profile`) must keep redirecting an unauthenticated visitor to `/signin`, unchanged — only `/` gets the new landing behavior.
- No new dependencies. Use the same `Button` (`apps/web/src/components/ui/button.tsx`) and icon library (`lucide-react`, already a dependency) the rest of the app uses.

---

## Task 1: Landing page component and route wiring

**Files:**
- Create: `apps/web/src/pages/Landing.tsx`
- Create: `apps/web/src/pages/Landing.test.tsx`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/App.test.tsx:97-100` (the now-outdated "redirects unauthenticated users from / to /signin" test)

**Interfaces:**
- Produces: `Landing` — a React component with no props (`export function Landing(): JSX.Element`), rendering a `<main>` with a heading, one sentence of description, and two `<Link>`-wrapped `Button`s pointing at `/signup` and `/signin`.
- Consumes: `Button` from `../components/ui/button.js` (existing), `Link` from `react-router-dom` (existing dependency, already used in `SignIn.tsx`).

- [ ] **Step 1: Write the failing test for `Landing`**

Create `apps/web/src/pages/Landing.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { Landing } from "./Landing.js";

function renderLanding() {
  render(
    <MemoryRouter>
      <Landing />
    </MemoryRouter>
  );
}

describe("Landing", () => {
  it("renders the Taakify name and a one-line description", () => {
    renderLanding();
    expect(screen.getByRole("heading", { name: "Taakify" })).toBeInTheDocument();
    expect(
      screen.getByText(/track what your household is reading/i)
    ).toBeInTheDocument();
  });

  it("links to sign up and sign in", () => {
    renderLanding();
    expect(screen.getByRole("link", { name: "Sign up" })).toHaveAttribute("href", "/signup");
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/signin");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @taakify/web test -- Landing.test.tsx`
Expected: FAIL — `apps/web/src/pages/Landing.js` (or `.tsx`) does not exist yet.

- [ ] **Step 3: Create the `Landing` component**

Create `apps/web/src/pages/Landing.tsx`:

```tsx
import { Link } from "react-router-dom";
import { BookOpen } from "lucide-react";
import { Button } from "../components/ui/button.js";

export function Landing() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-8 p-4 text-center">
      <div className="flex flex-col items-center gap-3">
        <BookOpen className="h-10 w-10 text-primary" aria-hidden="true" />
        <h1 className="text-3xl font-semibold tracking-tight">Taakify</h1>
        <p className="max-w-sm text-muted-foreground">
          Track what your household is reading, catalog your shelves, and
          remember who borrowed what — all in one shared family library.
        </p>
      </div>
      <div className="flex w-full max-w-xs flex-col gap-3">
        <Button asChild className="w-full">
          <Link to="/signup">Sign up</Link>
        </Button>
        <Button asChild variant="outline" className="w-full">
          <Link to="/signin">Sign in</Link>
        </Button>
      </div>
    </main>
  );
}
```

Check `apps/web/src/components/ui/button.tsx` before writing this step's real code — confirm it supports an `asChild` prop (shadcn's `Button` typically does, via Radix's `Slot`). If it does not, replace the two `<Button asChild>...<Link>...</Link></Button>` blocks with `<Button asChild={false}>` removed and instead render `<Link to="/signup" className={buttonVariants({ className: "w-full" })}>Sign up</Link>` — match whatever pattern this codebase already uses elsewhere for a link that must look like a button (grep the codebase for `asChild` before deciding; do not guess).

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @taakify/web test -- Landing.test.tsx`
Expected: PASS

- [ ] **Step 5: Wire the route in `App.tsx`**

The current root route lives inside the shared AppShell-wrapper group:

```tsx
<Route element={authed ? <AppShell /> : <Navigate to="/signin" />}>
  <Route path="/" element={<Home />} />
  <Route path="/library" element={<Library />} />
  ...
</Route>
```

Do **not** split `/` out into its own `<Route>` — that would give it a separate `<AppShell />` element instance from the other authed routes, remounting `AppShell` (and its `/api/me` fetch, sync-gate, etc.) every time an authenticated user navigates between `/` and `/library`. Instead, make the wrapper element itself location-aware, since only the unauthenticated case needs to differ by path:

```tsx
import { Routes, Route, Navigate, useLocation } from "react-router-dom";
import { Landing } from "./pages/Landing.js";
// ...existing imports unchanged...

export function App() {
  useTheme();
  const { data: session, isPending } = authClient.useSession();
  const location = useLocation();

  if (isPending)
    return (
      <main className="flex min-h-dvh items-center justify-center p-4">
        <Skeleton className="h-8 w-40" />
      </main>
    );

  const authed = Boolean(session);
  // Only the root path gets the landing page when unauthenticated; every
  // other authed-only route keeps bouncing to /signin as before.
  const unauthedRootElement = location.pathname === "/" ? <Landing /> : <Navigate to="/signin" />;

  return (
    <Routes>
      <Route path="/signup" element={authed ? <Navigate to="/" /> : <SignUp />} />
      <Route path="/signin" element={authed ? <Navigate to="/" /> : <SignIn />} />
      <Route path="/invite/:token" element={<InviteAccept authed={authed} />} />
      <Route path="/onboarding" element={authed ? <Onboarding /> : <Navigate to="/signin" />} />
      {/*
        Authed routes nest under AppShell, which owns fetching /api/me and
        redirecting to /onboarding when the user has no household yet (see
        lib/household-context.tsx). Only routes for pages that exist land
        here — / (Home), /library, /library/:bookId, /add, /import, /loans,
        /bookcases, and /profile. When unauthenticated, / shows Landing
        (spec §6); every other path here still bounces to /signin.
      */}
      <Route element={authed ? <AppShell /> : unauthedRootElement}>
        <Route path="/" element={<Home />} />
        <Route path="/library" element={<Library />} />
        <Route path="/library/:bookId" element={<BookDetail />} />
        <Route path="/add" element={<Add />} />
        <Route path="/import" element={<Import />} />
        <Route path="/loans" element={<Loans />} />
        <Route path="/bookcases" element={<Bookcases />} />
        <Route path="/profile" element={<Profile />} />
      </Route>
    </Routes>
  );
}
```

- [ ] **Step 6: Update the now-outdated test in `App.test.tsx`**

`App.test.tsx:97-100` currently reads:

```tsx
it("redirects unauthenticated users from / to /signin", () => {
  vi.mocked(authClient.useSession).mockReturnValue({ data: null, isPending: false } as never);
  renderApp("/");
  expect(screen.getByRole("heading", { name: "Sign in to Taakify" })).toBeInTheDocument();
});
```

Replace it with two tests — one proving the new landing behavior at `/`, one proving every other authed-only route is unaffected:

```tsx
it("shows the landing page for unauthenticated visitors at /", () => {
  vi.mocked(authClient.useSession).mockReturnValue({ data: null, isPending: false } as never);
  renderApp("/");
  expect(screen.getByRole("heading", { name: "Taakify" })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Sign up" })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Sign in" })).toBeInTheDocument();
});

it("still redirects unauthenticated users from /library to /signin", () => {
  vi.mocked(authClient.useSession).mockReturnValue({ data: null, isPending: false } as never);
  renderApp("/library");
  expect(screen.getByRole("heading", { name: "Sign in to Taakify" })).toBeInTheDocument();
});
```

- [ ] **Step 7: Run the full web test suite**

Run: `pnpm --filter @taakify/web test`
Expected: PASS — all prior tests (including "renders the Home page at / when authed with a household", which exercises the unchanged authed path) still pass; the two new/updated tests above pass.

- [ ] **Step 8: Manual check in the browser**

Start the dev servers (`pnpm dev:api` and `pnpm dev:web`, per `CLAUDE.md`), open `http://localhost:5173/` in a private/incognito window (no session cookie), and confirm:
- The landing page renders (heading "Taakify", description, two buttons).
- Clicking "Sign up" navigates to `/signup`; clicking "Sign in" navigates to `/signin`.
- After signing in, visiting `/` again shows the authenticated `Home` page, not the landing page (confirms the `authed` branch is untouched).
- Visiting `/library` while signed out still redirects to `/signin` (confirms the non-root authed routes are untouched).

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/pages/Landing.tsx apps/web/src/pages/Landing.test.tsx apps/web/src/App.tsx apps/web/src/App.test.tsx
git commit -m "feat: add minimal landing page for unauthenticated visitors at /"
```

---

## Self-Review

**Spec coverage:** Spec §6 asks for exactly one thing — a static `/` landing page with a short description and Sign up/Sign in buttons, replacing the bounce-to-`/signin`, with authenticated visitors unaffected. Task 1 covers all of it in one task since it's a single small page with no independent sub-parts to split across tasks.

**Placeholder scan:** No TBD/TODO markers. Step 3 includes one explicit "check before writing" instruction (verify `Button`'s `asChild` support) rather than guessing, with a concrete fallback described — this is a genuine unknown in the current codebase state, not a placeholder for missing plan content.

**Type consistency:** `Landing` is a zero-prop component, matching how it's rendered in both the test file and `App.tsx` (`<Landing />`, no props passed anywhere). `unauthedRootElement`'s type (`JSX.Element`) matches what `Navigate`/`Landing` both return, consistent with the existing `authed ? <AppShell /> : <Navigate to="/signin" />` pattern it replaces.

---

**Plan complete and saved to `docs/superpowers/plans/2026-09-11-taakify-landing-page.md`. Two execution options:**

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
