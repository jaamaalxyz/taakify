# Taakify Literary Theme Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the generic shadcn warm-orange/Nunito theme with a "home library" visual identity (warm paper palette, olive primary, terracotta accent, Cormorant Garamond serif reserved for book/shelf/household identity) derived from `preview.html`, applied through the existing design-token system — no new hardcoded colors, no component architecture changes.

**Architecture:** All color changes land in the CSS custom properties already defined in `apps/web/src/styles.css` (`:root` / `.dark`), which every component already consumes via Tailwind's `bg-*`/`text-*`/`border-*` utility classes — confirmed zero hardcoded hex/inline styles in `apps/web/src/{pages,components}`. Typography changes are additive `font-serif` classNames on a short, deliberately narrow list of "content identity" elements (household name, book titles, bookcase/shelf names, the "Taakify" wordmark) — page-chrome/nav labels ("Home", "Library", section eyebrows like "Wishlist"/"Active"/"History") stay on the sans body face. No text content, component props, or test-asserted strings change.

**Tech Stack:** Tailwind v4 (`@theme`/`@theme inline` blocks), Google Fonts (`Cormorant Garamond`), existing shadcn/ui primitives (untouched).

**Spec:** `preview.html` (design exploration, repo root) is the source of the token values; there is no separate written spec doc — this plan's Global Constraints section carries the concrete values forward.

## Global Constraints

- No hardcoded hex colors or inline `style={{...}}` in any `.tsx` file — every color must be a CSS custom property consumed via an existing Tailwind token class (`bg-background`, `text-primary`, etc.). This preserves the current state; do not regress it.
- Do not change any text content, component prop names, or DOM structure that existing tests assert on (`screen.getByText(...)`, `screen.findByText(...)`). Verified test-sensitive strings: `pages/Loans.test.tsx:127` (`/Lent out.*Alice/`), `pages/BookDetail.test.tsx:385,414,490,498` (`/Lent out · Alex.../`). This plan does not touch those lines' text — only wrapping `className`s elsewhere.
- Do not touch `--chart-*` or `--sidebar-*` tokens — confirmed unused by any component (`grep -rl "sidebar\|chart-1" apps/web/src --include=*.tsx` returns nothing); they're shadcn scaffolding, out of scope.
- Keep `--radius: 0.75rem` as the single radius token (do not introduce per-component radius overrides) — the multiple radii in `preview.html` (4/6/8/20px) were prototyping noise, not a decision to carry over.
- Both light (`:root`) and dark (`.dark`) palettes must be updated together and must each meet WCAG AA contrast (4.5:1) for `foreground`-on-`background` and `primary-foreground`-on-`primary`.
- `font-serif` is Cormorant Garamond; `font-sans` (unchanged) is the existing Nunito. Only add `font-serif` to: the "Taakify" wordmark (`pages/Landing.tsx`), the household name (`components/AppShell.tsx`, `pages/Profile.tsx`), book titles (`components/BookCard.tsx`, `pages/BookDetail.tsx`), and bookcase names (`pages/Bookcases.tsx`). Do not add it to page-nav h1s ("Home"/"Library"/"Loans"/"Bookcases" literal labels) or section-label h2s ("Wishlist"/"Household"/"Active"/"History"/"Currently reading"/"Recently added"/"Reading counts") — those stay sans, per the content-vs-chrome distinction this plan is built on.

---

### Task 1: Load Cormorant Garamond and wire the design tokens

**Correction from the original draft:** this task originally assumed Nunito
was never actually loaded (no `<link>`/`@import` found in `index.html` or
`styles.css`) and planned to fix that via a Google Fonts `<link>`. That was
wrong — `apps/web/src/main.tsx` already self-hosts Nunito via
`@fontsource/nunito/{400,600,700}.css` imports (a grep limited to
`index.html`/`styles.css` missed it). Nunito was never broken. Follow the
existing self-hosted-font pattern for Cormorant Garamond too, via
`@fontsource/cormorant-garamond`, not a Google Fonts CDN link — consistent
with the rest of this app being local-first/offline-capable.

**Files:**
- Modify: `apps/web/package.json` (add `@fontsource/cormorant-garamond` dependency)
- Modify: `apps/web/src/main.tsx` (import the weight CSS files)
- Modify: `apps/web/src/styles.css:1-127` (`@theme` font override, `:root` and `.dark` color tokens)

**Interfaces:**
- Produces: `--font-serif` resolving to `'Cormorant Garamond', serif` (consumed via Tailwind's `font-serif` utility class in Tasks 2-3); updated `--background`/`--foreground`/`--card`/`--popover`/`--primary`/`--primary-foreground`/`--secondary`/`--secondary-foreground`/`--muted`/`--muted-foreground`/`--accent`/`--accent-foreground`/`--destructive`/`--destructive-foreground`/`--border`/`--input`/`--ring` in both `:root` and `.dark` (consumed automatically everywhere — no other file needs to change for the color swap to take effect).

- [ ] **Step 1: Install `@fontsource/cormorant-garamond` and self-host it like Nunito**

Run: `pnpm --filter @taakify/web add @fontsource/cormorant-garamond@^5.3.0`

In `apps/web/src/main.tsx`, add three weight imports next to the existing Nunito ones (500/600/700 cover every serif use added in Tasks 2-3: `font-semibold` headings and the wordmark's `font-semibold`):

```tsx
import "@fontsource/nunito/400.css";
import "@fontsource/nunito/600.css";
import "@fontsource/nunito/700.css";
import "@fontsource/cormorant-garamond/500.css";
import "@fontsource/cormorant-garamond/600.css";
import "@fontsource/cormorant-garamond/700.css";
import "./styles.css";
```

- [ ] **Step 2: Override `--font-serif` in the `@theme` block of `apps/web/src/styles.css`**

```css
@theme {
  --font-sans: "Nunito", ui-sans-serif, system-ui, sans-serif;
  --font-serif: "Cormorant Garamond", ui-serif, Georgia, serif;
}
```

- [ ] **Step 3: Replace the `:root` color tokens**

```css
:root {
    --radius: 0.75rem;
    --background: #f4efe6;
    --foreground: #1e221a;
    --card: #ffffff;
    --card-foreground: #1e221a;
    --popover: #ffffff;
    --popover-foreground: #1e221a;
    --primary: #38423b;
    --primary-foreground: #f4efe6;
    --secondary: #eae3d2;
    --secondary-foreground: #4a4033;
    --muted: #efe8da;
    --muted-foreground: #706b63;
    --accent: #f3e5df;
    --accent-foreground: #94482c;
    --destructive: #b3261e;
    --destructive-foreground: #ffffff;
    --border: #e3d9c9;
    --input: #e3d9c9;
    --ring: #38423b;
    --chart-1: oklch(0.87 0 0);
    --chart-2: oklch(0.556 0 0);
    --chart-3: oklch(0.439 0 0);
    --chart-4: oklch(0.371 0 0);
    --chart-5: oklch(0.269 0 0);
    --sidebar: oklch(0.985 0 0);
    --sidebar-foreground: oklch(0.145 0 0);
    --sidebar-primary: oklch(0.205 0 0);
    --sidebar-primary-foreground: oklch(0.985 0 0);
    --sidebar-accent: oklch(0.97 0 0);
    --sidebar-accent-foreground: oklch(0.205 0 0);
    --sidebar-border: oklch(0.922 0 0);
    --sidebar-ring: oklch(0.708 0 0);
}
```

(`--chart-*`/`--sidebar-*` are left byte-for-byte identical to today — listed here only so the full block is copy-pasteable without hunting for the unchanged lines.)

- [ ] **Step 4: Replace the `.dark` color tokens**

```css
.dark {
    --background: #1c1f18;
    --foreground: #f0ead9;
    --card: #242820;
    --card-foreground: #f0ead9;
    --popover: #242820;
    --popover-foreground: #f0ead9;
    --primary: #7c8d6b;
    --primary-foreground: #1c1f18;
    --secondary: #333829;
    --secondary-foreground: #f0ead9;
    --muted: #2e3226;
    --muted-foreground: #b9ae98;
    --accent: #3a2b23;
    --accent-foreground: #e0916b;
    --destructive: #e5584a;
    --destructive-foreground: #1c1f18;
    --border: #3a3d31;
    --input: #3a3d31;
    --ring: #7c8d6b;
    --chart-1: oklch(0.87 0 0);
    --chart-2: oklch(0.556 0 0);
    --chart-3: oklch(0.439 0 0);
    --chart-4: oklch(0.371 0 0);
    --chart-5: oklch(0.269 0 0);
    --sidebar: oklch(0.205 0 0);
    --sidebar-foreground: oklch(0.985 0 0);
    --sidebar-primary: oklch(0.488 0.243 264.376);
    --sidebar-primary-foreground: oklch(0.985 0 0);
    --sidebar-accent: oklch(0.269 0 0);
    --sidebar-accent-foreground: oklch(0.985 0 0);
    --sidebar-border: oklch(1 0 0 / 10%);
    --sidebar-ring: oklch(0.556 0 0);
}
```

- [ ] **Step 5: Typecheck and build to confirm no CSS/HTML syntax errors**

Run: `pnpm --filter @taakify/web typecheck && pnpm --filter @taakify/web build`
Expected: both PASS (this task changes no `.tsx`, so typecheck passing is really just confirming nothing else broke; build passing confirms the CSS is syntactically valid and Vite can bundle it).

- [ ] **Step 6: Commit**

```bash
git add apps/web/package.json apps/web/src/main.tsx apps/web/src/styles.css pnpm-lock.yaml
git commit -m "feat(web): switch to warm-literary color palette and load Cormorant Garamond"
```

---

### Task 2: Apply serif treatment to book and shelf identity

**Files:**
- Modify: `apps/web/src/components/BookCard.tsx:40`
- Modify: `apps/web/src/pages/BookDetail.tsx:462`
- Modify: `apps/web/src/pages/Bookcases.tsx:215`

**Interfaces:**
- Consumes: `--font-serif` from Task 1 (via Tailwind's `font-serif` utility class — no import needed, it's a global utility).
- Produces: nothing new consumed by later tasks; this task is leaf-level styling only.

- [ ] **Step 1: Add `font-serif` to the book title in `BookCard.tsx`**

In `apps/web/src/components/BookCard.tsx`, change:

```tsx
<p className="line-clamp-2 text-sm font-medium">{book.edition.title}</p>
```

to:

```tsx
<p className="line-clamp-2 font-serif text-base font-semibold">{book.edition.title}</p>
```

(Bumping `text-sm font-medium` → `text-base font-semibold` because Cormorant Garamond reads noticeably smaller/lighter than Nunito at the same pixel size and weight — matching the preview's `.book-info h4` treatment, which uses a larger serif size than its sans body text.)

- [ ] **Step 2: Add `font-serif` to the book title in `BookDetail.tsx`**

In `apps/web/src/pages/BookDetail.tsx`, change:

```tsx
<h1 className="text-lg font-semibold">{book.edition.title}</h1>
```

to:

```tsx
<h1 className="font-serif text-2xl font-semibold">{book.edition.title}</h1>
```

- [ ] **Step 3: Add `font-serif` to the bookcase name in `Bookcases.tsx`**

In `apps/web/src/pages/Bookcases.tsx`, change:

```tsx
<CardTitle className="text-sm">{bc.name}</CardTitle>
```

to:

```tsx
<CardTitle className="font-serif text-lg">{bc.name}</CardTitle>
```

- [ ] **Step 4: Run the web test suite to confirm no test regressions**

Run: `pnpm --filter @taakify/web test -- BookCard.test.tsx BookDetail.test.tsx Bookcases.test.tsx`
Expected: all PASS — these are className-only changes, no text content or DOM structure changed, so no test should be sensitive to them. If any test fails, read the failure: a test asserting `className` (unlikely — none were found in the earlier `grep`) would need updating; a test failing for any other reason means this task introduced an unintended change and must be investigated, not papered over.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/BookCard.tsx apps/web/src/pages/BookDetail.tsx apps/web/src/pages/Bookcases.tsx
git commit -m "feat(web): set book and bookcase titles in Cormorant Garamond"
```

---

### Task 3: Apply serif treatment to household identity and the wordmark

**Files:**
- Modify: `apps/web/src/components/AppShell.tsx:173`
- Modify: `apps/web/src/pages/Profile.tsx:95`
- Modify: `apps/web/src/pages/Landing.tsx:10`

**Interfaces:**
- Consumes: `--font-serif` from Task 1.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Add `font-serif` to the household name in the app header**

In `apps/web/src/components/AppShell.tsx`, change:

```tsx
<h1 className="truncate text-lg font-semibold">{household.name}</h1>
```

to:

```tsx
<h1 className="truncate font-serif text-lg font-semibold">{household.name}</h1>
```

- [ ] **Step 2: Add `font-serif` to the household name in `Profile.tsx`**

In `apps/web/src/pages/Profile.tsx`, change:

```tsx
<h1 className="text-lg font-semibold">{household.name}</h1>
```

to:

```tsx
<h1 className="font-serif text-lg font-semibold">{household.name}</h1>
```

- [ ] **Step 3: Add `font-serif` to the "Taakify" wordmark on the landing page**

In `apps/web/src/pages/Landing.tsx`, change:

```tsx
<h1 className="text-3xl font-semibold tracking-tight">Taakify</h1>
```

to:

```tsx
<h1 className="font-serif text-4xl font-semibold tracking-tight">Taakify</h1>
```

- [ ] **Step 4: Run the affected test files**

Run: `pnpm --filter @taakify/web test -- AppShell.test.tsx Profile.test.tsx Landing.test.tsx`
Expected: all PASS, same reasoning as Task 2 Step 4 — className-only changes.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/AppShell.tsx apps/web/src/pages/Profile.tsx apps/web/src/pages/Landing.tsx
git commit -m "feat(web): set household name and wordmark in Cormorant Garamond"
```

---

### Task 4: Full verification pass

**Files:** none (verification only)

**Interfaces:** none.

- [ ] **Step 1: Run the full web test suite**

Run: `pnpm --filter @taakify/web test`
Expected: PASS (all files, not just the ones touched — confirms the token swap didn't break any snapshot/contrast-sensitive assertion elsewhere).

- [ ] **Step 2: Typecheck and production build**

Run: `pnpm --filter @taakify/web typecheck && pnpm --filter @taakify/web build`
Expected: PASS.

- [ ] **Step 3: Visually verify in the running app**

Run: `pnpm dev:web` (from repo root; requires `docker compose -f docker-compose.dev.yml up -d` and `pnpm dev:api` already running per `CLAUDE.md`), then open `http://localhost:5173` in a browser.

Check, in both light and the `.dark`-toggled theme (via whatever control `use-theme.ts` wires up in `Profile.tsx` — confirm the toggle location if not obvious):
- Landing page: wordmark renders in Cormorant Garamond, buttons olive with correct hover state, background is warm cream not white.
- Home / Library / Bookcases / Loans: page nav h1 ("Home" etc.) stays sans; household name in the header and book/bookcase titles render serif; body text and section labels stay sans and legible against the new background/muted tokens.
- BookDetail: book title serif and clearly larger than the author/metadata lines below it; badges (ownership, overdue) still readable — `--destructive` red must not clash badly with the terracotta `--accent`.
- Contrast: muted-foreground text on the new `--muted`/`--background` is comfortably readable, not washed out.

If anything looks wrong (contrast failure, a missed hardcoded color you didn't know about, a component that looks broken with the new radius/palette combo), fix it before calling this done — this step is the actual acceptance check for a visual-design task; the automated tests only confirm nothing broke mechanically.

**Contrast check already run (WCAG AA, 4.5:1 minimum) during implementation:** every `*-foreground`/`*` pair in both `:root` and `.dark` was computed. One pair initially failed — light-mode `--accent-foreground` (`#a85334`) on `--accent` (`#f3e5df`) was 4.32:1 — and was darkened to `#94482c` (5.3:1) to pass. All other pairs passed at 4.32+ before that fix and remain well clear of 4.5 after it (worst case afterward: dark-mode `primary-foreground`/`primary` at 4.67:1).

- [ ] **Step 4: Report back**

Summarize what was verified and any deviations made from the plan (e.g., contrast tweaks) — no commit needed for this task since it's verification-only, unless Step 3 required a fix, in which case commit that fix separately with its own message.
