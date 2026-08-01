# Taakify UI Restyle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle Taakify's five existing web pages with Tailwind CSS v4 + shadcn/ui + lucide-react (playful-family direction, warm coral accent, light/dark theming) and add frontend test coverage from zero.

**Architecture:** `apps/web` is a Vite + React 19 + react-router SPA with no component library today (9-line hand-rolled `styles.css`). This plan adds Tailwind v4 (CSS-first config, no `tailwind.config.js`) and installs shadcn/ui components as editable source under `src/components/ui/`, then restyles each page in place — same routes, same props, same API contracts. Frontend testing is added with Vitest (matching the API package) + React Testing Library, mocking `authClient` and `api()` at the module boundary.

**Tech Stack:** Tailwind CSS v4, `@tailwindcss/vite`, shadcn/ui CLI, lucide-react, `@fontsource/nunito`, Vitest, `@testing-library/react`, `@testing-library/jest-dom`, `@testing-library/user-event`, jsdom.

## Global Constraints

- Node >=24, pnpm workspaces (per root `package.json` `engines`).
- TypeScript `strict: true`; relative imports use explicit `.js` extensions (moduleResolution `bundler`, `"type": "module"`) — every new/modified file must follow this, including imports of the new `src/components/ui/*` and `src/lib/*` files.
- No routes, component props, or API contracts change (spec §5). `src/lib/api.ts`, `src/lib/auth.ts`, `src/lib/safe-next.ts` are not modified.
- No decorative icon usage — lucide icons only at functional spots (spec §2).
- Playwright/E2E is explicitly out of scope for this plan (spec §6).

---

## File Structure

- `apps/web/vite.config.ts` — add Tailwind Vite plugin + `@/*` path alias.
- `apps/web/tsconfig.json` — add `baseUrl`/`paths` for the `@/*` alias.
- `apps/web/components.json` — shadcn/ui config (created by CLI).
- `apps/web/src/lib/utils.ts` — `cn()` helper (created by shadcn CLI).
- `apps/web/src/lib/use-theme.ts` — light/dark theme hook (new).
- `apps/web/src/styles.css` — replaced with Tailwind entrypoint + `@theme` tokens (light/dark CSS variables, coral primary, Nunito font).
- `apps/web/src/components/ui/*.tsx` — Button, Input, Label, Card, Dialog, Alert, Avatar, Skeleton (created by shadcn CLI).
- `apps/web/src/pages/{SignIn,SignUp,Onboarding,InviteAccept,Home}.tsx` — restyled in place.
- `apps/web/src/App.tsx` — loading state restyled, `useTheme()` wired in.
- `apps/web/vitest.config.ts` — new Vitest config for the web package.
- `apps/web/src/test/setup.ts` — jest-dom matchers + `window.location.reload` stub.
- `apps/web/src/pages/*.test.tsx`, `apps/web/src/App.test.tsx` — new test files, one per page plus routing.
- `package.json` (root) — `test` script extended to also run the web package's tests.

---

### Task 1: Tailwind CSS v4 setup

**Files:**
- Modify: `apps/web/vite.config.ts`
- Modify: `apps/web/tsconfig.json`
- Modify: `apps/web/package.json`
- Modify: `apps/web/src/styles.css`

**Interfaces:**
- Produces: `@/*` path alias resolving to `apps/web/src/*` (consumed by shadcn components and all pages from Task 3 onward). Tailwind utility classes available globally via `styles.css`.

- [ ] **Step 1: Install Tailwind and Node types**

```bash
cd apps/web
pnpm add tailwindcss @tailwindcss/vite
pnpm add -D @types/node
```

- [ ] **Step 2: Add the path alias to `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "baseUrl": ".",
    "paths": { "@/*": ["./src/*"] }
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Add the Tailwind plugin and alias to `vite.config.ts`**

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  server: {
    proxy: { "/api": "http://localhost:3001" },
  },
});
```

- [ ] **Step 4: Replace `styles.css` with the Tailwind entrypoint**

```css
@import "tailwindcss";
```

- [ ] **Step 5: Verify the build picks up Tailwind**

Run: `pnpm --filter @taakify/web build`
Expected: build succeeds (this compiles `styles.css` through the Tailwind plugin; no visible output change yet since no components use Tailwind classes).

- [ ] **Step 6: Commit**

```bash
git add apps/web/vite.config.ts apps/web/tsconfig.json apps/web/package.json apps/web/pnpm-lock.yaml apps/web/src/styles.css
git commit -m "chore(web): add Tailwind CSS v4"
```

---

### Task 2: shadcn/ui init, lucide-react, Nunito font

**Files:**
- Create: `apps/web/components.json`
- Create: `apps/web/src/lib/utils.ts`
- Modify: `apps/web/src/styles.css`
- Modify: `apps/web/src/main.tsx`
- Modify: `apps/web/package.json`

**Interfaces:**
- Consumes: `@/*` alias from Task 1.
- Produces: `cn()` from `@/lib/utils.js` (consumed by every shadcn component in Task 3). `font-sans` Tailwind utility mapped to Nunito (consumed globally).

- [ ] **Step 1: Run the shadcn/ui init CLI**

```bash
cd apps/web
pnpm dlx shadcn@latest init -d --base-color neutral
```

This detects the Vite + Tailwind v4 setup from Task 1, creates `components.json`, writes `src/lib/utils.ts` with a `cn()` helper (built on `clsx` + `tailwind-merge`, added as dependencies), and appends shadcn's default CSS variable theme (`:root` / `.dark` blocks using `oklch()`) into `src/styles.css`. We override those variables with the coral/cream palette in Task 4 — this step just gets the plumbing in place with shadcn's neutral defaults.

- [ ] **Step 2: Verify the alias in `components.json`**

Open `apps/web/components.json` and confirm the aliases block matches:

```json
{
  "aliases": {
    "components": "@/components",
    "utils": "@/lib/utils",
    "ui": "@/components/ui",
    "lib": "@/lib",
    "hooks": "@/hooks"
  }
}
```

If the CLI produced different values (e.g. relative paths without `@/`), edit them to match — later tasks import from `@/components/ui/...` and `@/lib/utils.js`.

- [ ] **Step 3: Install lucide-react and the Nunito font**

```bash
pnpm add lucide-react @fontsource/nunito
```

- [ ] **Step 4: Load Nunito in `main.tsx`**

```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App.js";
import "@fontsource/nunito/400.css";
import "@fontsource/nunito/600.css";
import "@fontsource/nunito/700.css";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>
);
```

- [ ] **Step 5: Set Nunito as the default sans font**

Add to the top of `apps/web/src/styles.css` (after the `@import "tailwindcss";` line the CLI already added, before the CSS variable blocks):

```css
@theme {
  --font-sans: "Nunito", ui-sans-serif, system-ui, sans-serif;
}

@layer base {
  body {
    @apply font-sans;
  }
}
```

- [ ] **Step 6: Verify**

Run: `pnpm --filter @taakify/web build`
Expected: build succeeds.

- [ ] **Step 7: Commit**

```bash
git add apps/web/components.json apps/web/src/lib/utils.ts apps/web/src/styles.css apps/web/src/main.tsx apps/web/package.json apps/web/pnpm-lock.yaml
git commit -m "chore(web): init shadcn/ui, lucide-react, Nunito font"
```

---

### Task 3: Install baseline shadcn/ui components

**Files:**
- Create: `apps/web/src/components/ui/button.tsx`
- Create: `apps/web/src/components/ui/input.tsx`
- Create: `apps/web/src/components/ui/label.tsx`
- Create: `apps/web/src/components/ui/card.tsx`
- Create: `apps/web/src/components/ui/dialog.tsx`
- Create: `apps/web/src/components/ui/alert.tsx`
- Create: `apps/web/src/components/ui/avatar.tsx`
- Create: `apps/web/src/components/ui/skeleton.tsx`
- Modify: `apps/web/package.json` (adds Radix primitives as dependencies)

**Interfaces:**
- Consumes: `cn()` from `@/lib/utils.js` (Task 2).
- Produces: `Button`, `Input`, `Label`, `Card`/`CardHeader`/`CardTitle`/`CardDescription`/`CardContent`/`CardFooter`, `Dialog`/`DialogContent`/`DialogHeader`/`DialogTitle`/`DialogDescription`/`DialogTrigger`, `Alert`/`AlertDescription`, `Avatar`/`AvatarFallback`, `Skeleton` — all consumed by pages from Task 6 onward.

- [ ] **Step 1: Install the components**

```bash
cd apps/web
pnpm dlx shadcn@latest add button input label card dialog alert avatar skeleton
```

- [ ] **Step 2: Verify each file was created**

```bash
ls src/components/ui/
```

Expected: `alert.tsx avatar.tsx button.tsx card.tsx dialog.tsx input.tsx label.tsx skeleton.tsx` (plus any shared files the CLI adds, e.g. none expected beyond these for this set).

- [ ] **Step 3: Verify the build**

Run: `pnpm --filter @taakify/web build`
Expected: build succeeds with no unresolved imports.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/ui apps/web/package.json apps/web/pnpm-lock.yaml
git commit -m "chore(web): install baseline shadcn/ui components"
```

---

### Task 4: Coral/cream theme tokens + dark mode hook

**Files:**
- Modify: `apps/web/src/styles.css`
- Create: `apps/web/src/lib/use-theme.ts`

**Interfaces:**
- Produces: `useTheme(): void` from `@/lib/use-theme.js` — applies the `dark` class to `<html>` based on `localStorage` (`"theme"` key) or `prefers-color-scheme`, and persists the resolved value. Consumed by `App.tsx` in Task 11.
- Produces: CSS variables `--background`, `--foreground`, `--card`, `--card-foreground`, `--primary`, `--primary-foreground`, `--muted`, `--muted-foreground`, `--destructive`, `--destructive-foreground`, `--border`, `--input`, `--ring` in both `:root` and `.dark` — consumed by every shadcn component installed in Task 3 (they reference these variables via Tailwind's `bg-primary`, `text-muted-foreground`, etc. utilities, wired up automatically by the `@theme inline` block shadcn's init added in Task 2).

- [ ] **Step 1: Replace the CSS variable values in `styles.css`**

Find the `:root { ... }` and `.dark { ... }` blocks that `shadcn init` added in Task 2, and replace their variable values with:

```css
:root {
  --background: #fff8f0;
  --foreground: #2b211b;
  --card: #ffffff;
  --card-foreground: #2b211b;
  --popover: #ffffff;
  --popover-foreground: #2b211b;
  --primary: #e8622d;
  --primary-foreground: #ffffff;
  --secondary: #f5e9dd;
  --secondary-foreground: #2b211b;
  --muted: #f5e9dd;
  --muted-foreground: #6b5b4e;
  --accent: #f5e9dd;
  --accent-foreground: #2b211b;
  --destructive: #dc2626;
  --destructive-foreground: #ffffff;
  --border: #e8ddd0;
  --input: #e8ddd0;
  --ring: #e8622d;
  --radius: 0.75rem;
}

.dark {
  --background: #221812;
  --foreground: #f5ede4;
  --card: #2b2019;
  --card-foreground: #f5ede4;
  --popover: #2b2019;
  --popover-foreground: #f5ede4;
  --primary: #f2783f;
  --primary-foreground: #1a1210;
  --secondary: #382a21;
  --secondary-foreground: #f5ede4;
  --muted: #382a21;
  --muted-foreground: #c4b3a4;
  --accent: #382a21;
  --accent-foreground: #f5ede4;
  --destructive: #f87171;
  --destructive-foreground: #1a1210;
  --border: #3d2d23;
  --input: #3d2d23;
  --ring: #f2783f;
}
```

Keep any `@theme inline { ... }` block the CLI generated below these (it maps the variables above to Tailwind utility names like `--color-primary: var(--primary);` — don't remove it, only the raw variable values change).

- [ ] **Step 2: Write the theme hook**

```ts
// apps/web/src/lib/use-theme.ts
import { useEffect } from "react";

export function useTheme(): void {
  useEffect(() => {
    const stored = localStorage.getItem("theme");
    const theme =
      stored === "light" || stored === "dark"
        ? stored
        : window.matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light";
    document.documentElement.classList.toggle("dark", theme === "dark");
    localStorage.setItem("theme", theme);
  }, []);
}
```

- [ ] **Step 3: Verify the build**

Run: `pnpm --filter @taakify/web build`
Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/styles.css apps/web/src/lib/use-theme.ts
git commit -m "feat(web): coral/cream theme tokens and light/dark mode hook"
```

---

### Task 5: Frontend test tooling

**Files:**
- Create: `apps/web/vitest.config.ts`
- Create: `apps/web/src/test/setup.ts`
- Modify: `apps/web/package.json`
- Modify: `package.json` (root)

**Interfaces:**
- Produces: `pnpm --filter @taakify/web test` runs Vitest in jsdom mode with jest-dom matchers loaded. Root `pnpm test` runs both `@taakify/api` and `@taakify/web` suites.

- [ ] **Step 1: Install test dependencies**

```bash
cd apps/web
pnpm add -D vitest jsdom @testing-library/react @testing-library/jest-dom @testing-library/user-event
```

- [ ] **Step 2: Add the `test` script to `apps/web/package.json`**

```json
{
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  }
}
```

- [ ] **Step 3: Write `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
  },
});
```

- [ ] **Step 4: Write the shared test setup**

```ts
// apps/web/src/test/setup.ts
import "@testing-library/jest-dom/vitest";
import { vi } from "vitest";

Object.defineProperty(window, "location", {
  configurable: true,
  value: { ...window.location, reload: vi.fn() },
});
```

`Home.tsx`'s sign-out handler calls `location.reload()`; jsdom's real `reload()` throws "Not implemented" unless stubbed, so every test file gets this stub for free via `setupFiles`.

- [ ] **Step 5: Extend the root `test` script**

```json
{
  "scripts": {
    "dev:api": "pnpm --filter @taakify/api dev",
    "dev:web": "pnpm --filter @taakify/web dev",
    "migrate": "pnpm --filter @taakify/api migrate",
    "test": "pnpm --filter @taakify/api test && pnpm --filter @taakify/web test"
  },
  "engines": { "node": ">=24" }
}
```

- [ ] **Step 6: Verify with a smoke test**

Create a throwaway test to confirm the harness works, run it, then delete it:

```bash
mkdir -p apps/web/src/test
cat > apps/web/src/test/smoke.test.ts <<'EOF'
import { describe, expect, it } from "vitest";
describe("smoke", () => { it("runs", () => expect(1 + 1).toBe(2)); });
EOF
pnpm --filter @taakify/web test
rm apps/web/src/test/smoke.test.ts
```

Expected: `1 passed`.

- [ ] **Step 7: Commit**

```bash
git add apps/web/vitest.config.ts apps/web/src/test/setup.ts apps/web/package.json apps/web/pnpm-lock.yaml package.json
git commit -m "chore(web): add Vitest + React Testing Library"
```

---

### Task 6: Restyle SignIn

**Files:**
- Modify: `apps/web/src/pages/SignIn.tsx`
- Create: `apps/web/src/pages/SignIn.test.tsx`

**Interfaces:**
- Consumes: `Button`, `Input`, `Label`, `Card`/`CardHeader`/`CardTitle`/`CardDescription`/`CardContent`/`CardFooter`, `Alert`/`AlertDescription` (Task 3); `Mail`, `Lock` icons from `lucide-react`.

- [ ] **Step 1: Write the failing test**

```tsx
// apps/web/src/pages/SignIn.test.tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { SignIn } from "./SignIn.js";
import { authClient } from "../lib/auth.js";

vi.mock("../lib/auth.js", () => ({
  authClient: {
    signIn: { email: vi.fn(), social: vi.fn() },
    getSession: vi.fn(),
  },
}));

function renderSignIn() {
  render(
    <MemoryRouter>
      <SignIn />
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.mocked(authClient.signIn.email).mockReset();
  vi.mocked(authClient.signIn.social).mockReset();
  vi.mocked(authClient.getSession).mockReset();
});

describe("SignIn", () => {
  it("submits email and password to authClient.signIn.email", async () => {
    vi.mocked(authClient.signIn.email).mockResolvedValue({ error: null } as never);
    vi.mocked(authClient.getSession).mockResolvedValue({} as never);
    renderSignIn();

    await userEvent.type(screen.getByLabelText("Email"), "a@b.com");
    await userEvent.type(screen.getByLabelText("Password"), "hunter2");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(authClient.signIn.email).toHaveBeenCalledWith({ email: "a@b.com", password: "hunter2" });
  });

  it("shows an alert when sign-in fails", async () => {
    vi.mocked(authClient.signIn.email).mockResolvedValue({
      error: { message: "Invalid credentials" },
    } as never);
    renderSignIn();

    await userEvent.type(screen.getByLabelText("Email"), "a@b.com");
    await userEvent.type(screen.getByLabelText("Password"), "wrong");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByText("Invalid credentials")).toBeInTheDocument();
  });

  it("triggers Google sign-in on button click", async () => {
    renderSignIn();
    await userEvent.click(screen.getByRole("button", { name: "Continue with Google" }));
    expect(authClient.signIn.social).toHaveBeenCalledWith({ provider: "google", callbackURL: "/" });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @taakify/web test -- SignIn`
Expected: FAIL — `SignIn` still renders the old bare `<input>` markup without `Label`-associated fields, so `getByLabelText` finds nothing.

- [ ] **Step 3: Restyle the page**

```tsx
// apps/web/src/pages/SignIn.tsx
import { useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Mail, Lock } from "lucide-react";
import { authClient } from "../lib/auth.js";
import { safeNext } from "../lib/safe-next.js";
import { Button } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";
import { Label } from "../components/ui/label.js";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "../components/ui/card.js";
import { Alert, AlertDescription } from "../components/ui/alert.js";

export function SignIn() {
  const [error, setError] = useState("");
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const { error } = await authClient.signIn.email({
      email: String(data.get("email")),
      password: String(data.get("password")),
    });
    if (error) return setError(error.message ?? "Sign-in failed");
    await authClient.getSession();
    navigate(safeNext(searchParams.get("next"), "/"));
  }

  return (
    <main className="flex min-h-dvh items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Sign in to Taakify</CardTitle>
          <CardDescription>Welcome back to your family library.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <form onSubmit={onSubmit} className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="email">Email</Label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input id="email" name="email" type="email" placeholder="you@example.com" required className="pl-9" />
              </div>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="password">Password</Label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input id="password" name="password" type="password" placeholder="••••••••" required className="pl-9" />
              </div>
            </div>
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <Button type="submit" className="w-full">
              Sign in
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
        </CardContent>
        <CardFooter className="justify-center text-sm text-muted-foreground">
          New here?&nbsp;
          <Link to="/signup" className="text-primary underline-offset-4 hover:underline">
            Create an account
          </Link>
        </CardFooter>
      </Card>
    </main>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @taakify/web test -- SignIn`
Expected: `3 passed`.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/SignIn.tsx apps/web/src/pages/SignIn.test.tsx
git commit -m "feat(web): restyle SignIn with shadcn/ui, add tests"
```

---

### Task 7: Restyle SignUp

**Files:**
- Modify: `apps/web/src/pages/SignUp.tsx`
- Create: `apps/web/src/pages/SignUp.test.tsx`

**Interfaces:**
- Consumes: same shadcn components as Task 6 plus `User` icon from `lucide-react`.

- [ ] **Step 1: Write the failing test**

```tsx
// apps/web/src/pages/SignUp.test.tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { SignUp } from "./SignUp.js";
import { authClient } from "../lib/auth.js";

vi.mock("../lib/auth.js", () => ({
  authClient: {
    signUp: { email: vi.fn() },
    signIn: { social: vi.fn() },
    getSession: vi.fn(),
  },
}));

function renderSignUp() {
  render(
    <MemoryRouter>
      <SignUp />
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.mocked(authClient.signUp.email).mockReset();
  vi.mocked(authClient.signIn.social).mockReset();
  vi.mocked(authClient.getSession).mockReset();
});

describe("SignUp", () => {
  it("submits name, email, and password to authClient.signUp.email", async () => {
    vi.mocked(authClient.signUp.email).mockResolvedValue({ error: null } as never);
    vi.mocked(authClient.getSession).mockResolvedValue({} as never);
    renderSignUp();

    await userEvent.type(screen.getByLabelText("Your name"), "Ada Lovelace");
    await userEvent.type(screen.getByLabelText("Email"), "ada@example.com");
    await userEvent.type(screen.getByLabelText("Password"), "hunter22");
    await userEvent.click(screen.getByRole("button", { name: "Sign up" }));

    expect(authClient.signUp.email).toHaveBeenCalledWith({
      name: "Ada Lovelace",
      email: "ada@example.com",
      password: "hunter22",
    });
  });

  it("shows an alert when sign-up fails", async () => {
    vi.mocked(authClient.signUp.email).mockResolvedValue({
      error: { message: "Email already in use" },
    } as never);
    renderSignUp();

    await userEvent.type(screen.getByLabelText("Your name"), "Ada");
    await userEvent.type(screen.getByLabelText("Email"), "ada@example.com");
    await userEvent.type(screen.getByLabelText("Password"), "hunter22");
    await userEvent.click(screen.getByRole("button", { name: "Sign up" }));

    expect(await screen.findByText("Email already in use")).toBeInTheDocument();
  });

  it("triggers Google sign-in on button click", async () => {
    renderSignUp();
    await userEvent.click(screen.getByRole("button", { name: "Continue with Google" }));
    expect(authClient.signIn.social).toHaveBeenCalledWith({ provider: "google", callbackURL: "/" });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @taakify/web test -- SignUp`
Expected: FAIL — no `Label`-associated "Your name" field exists yet.

- [ ] **Step 3: Restyle the page**

```tsx
// apps/web/src/pages/SignUp.tsx
import { useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { User, Mail, Lock } from "lucide-react";
import { authClient } from "../lib/auth.js";
import { safeNext } from "../lib/safe-next.js";
import { Button } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";
import { Label } from "../components/ui/label.js";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "../components/ui/card.js";
import { Alert, AlertDescription } from "../components/ui/alert.js";

export function SignUp() {
  const [error, setError] = useState("");
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const { error } = await authClient.signUp.email({
      name: String(data.get("name")),
      email: String(data.get("email")),
      password: String(data.get("password")),
    });
    if (error) return setError(error.message ?? "Sign-up failed");
    await authClient.getSession();
    navigate(safeNext(searchParams.get("next"), "/onboarding"));
  }

  return (
    <main className="flex min-h-dvh items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Create your Taakify account</CardTitle>
          <CardDescription>Start your family's shared bookshelf.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <form onSubmit={onSubmit} className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="name">Your name</Label>
              <div className="relative">
                <User className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input id="name" name="name" placeholder="Ada Lovelace" required className="pl-9" />
              </div>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="email">Email</Label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input id="email" name="email" type="email" placeholder="you@example.com" required className="pl-9" />
              </div>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="password">Password</Label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="password"
                  name="password"
                  type="password"
                  placeholder="8+ characters"
                  minLength={8}
                  required
                  className="pl-9"
                />
              </div>
            </div>
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <Button type="submit" className="w-full">
              Sign up
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
        </CardContent>
        <CardFooter className="justify-center text-sm text-muted-foreground">
          Already have an account?&nbsp;
          <Link to="/signin" className="text-primary underline-offset-4 hover:underline">
            Sign in
          </Link>
        </CardFooter>
      </Card>
    </main>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @taakify/web test -- SignUp`
Expected: `3 passed`.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/SignUp.tsx apps/web/src/pages/SignUp.test.tsx
git commit -m "feat(web): restyle SignUp with shadcn/ui, add tests"
```

---

### Task 8: Restyle Onboarding

**Files:**
- Modify: `apps/web/src/pages/Onboarding.tsx`
- Create: `apps/web/src/pages/Onboarding.test.tsx`

**Interfaces:**
- Consumes: `Button`, `Input`, `Label`, `Card`/`CardHeader`/`CardTitle`/`CardDescription`/`CardContent`, `Alert`/`AlertDescription` (Task 3).

- [ ] **Step 1: Write the failing test**

```tsx
// apps/web/src/pages/Onboarding.test.tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { Onboarding } from "./Onboarding.js";
import { api } from "../lib/api.js";

vi.mock("../lib/api.js", () => ({ api: vi.fn() }));

function renderOnboarding() {
  render(
    <MemoryRouter initialEntries={["/onboarding"]}>
      <Routes>
        <Route path="/onboarding" element={<Onboarding />} />
        <Route path="/" element={<div>Home page</div>} />
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.mocked(api).mockReset();
});

describe("Onboarding", () => {
  it("creates the household and navigates home on success", async () => {
    vi.mocked(api).mockResolvedValueOnce({});
    renderOnboarding();

    await userEvent.type(screen.getByLabelText("Library name"), "Our Family Library");
    await userEvent.click(screen.getByRole("button", { name: "Create library" }));

    expect(api).toHaveBeenCalledWith("/api/households", {
      method: "POST",
      body: JSON.stringify({ name: "Our Family Library" }),
    });
    expect(await screen.findByText("Home page")).toBeInTheDocument();
  });

  it("shows an alert when household creation fails", async () => {
    vi.mocked(api).mockRejectedValueOnce(new Error("Name taken"));
    renderOnboarding();

    await userEvent.type(screen.getByLabelText("Library name"), "Dup");
    await userEvent.click(screen.getByRole("button", { name: "Create library" }));

    expect(await screen.findByText("Name taken")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @taakify/web test -- Onboarding`
Expected: FAIL — no `Label`-associated "Library name" field exists yet.

- [ ] **Step 3: Restyle the page**

```tsx
// apps/web/src/pages/Onboarding.tsx
import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api.js";
import { Button } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";
import { Label } from "../components/ui/label.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card.js";
import { Alert, AlertDescription } from "../components/ui/alert.js";

export function Onboarding() {
  const [error, setError] = useState("");
  const navigate = useNavigate();

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const name = String(new FormData(e.currentTarget).get("name"));
    try {
      await api("/api/households", { method: "POST", body: JSON.stringify({ name }) });
      navigate("/");
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <main className="flex min-h-dvh items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Name your library</CardTitle>
          <CardDescription>This is your household's shared bookshelf. You can invite family after.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="name">Library name</Label>
              <Input id="name" name="name" placeholder="e.g. Our Family Library" required />
            </div>
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <Button type="submit" className="w-full">
              Create library
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @taakify/web test -- Onboarding`
Expected: `2 passed`.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/Onboarding.tsx apps/web/src/pages/Onboarding.test.tsx
git commit -m "feat(web): restyle Onboarding with shadcn/ui, add tests"
```

---

### Task 9: Restyle InviteAccept

**Files:**
- Modify: `apps/web/src/pages/InviteAccept.tsx`
- Create: `apps/web/src/pages/InviteAccept.test.tsx`

**Interfaces:**
- Consumes: `Button`, `Card`/`CardHeader`/`CardTitle`/`CardDescription`/`CardContent`, `Alert`/`AlertDescription`, `Skeleton` (Task 3).

- [ ] **Step 1: Write the failing test**

```tsx
// apps/web/src/pages/InviteAccept.test.tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { InviteAccept } from "./InviteAccept.js";
import { api } from "../lib/api.js";

vi.mock("../lib/api.js", () => ({ api: vi.fn() }));

function renderInvite(authed: boolean) {
  render(
    <MemoryRouter initialEntries={["/invite/tok123"]}>
      <Routes>
        <Route path="/invite/:token" element={<InviteAccept authed={authed} />} />
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.mocked(api).mockReset();
});

describe("InviteAccept", () => {
  it("shows the household name and role once the invite loads", async () => {
    vi.mocked(api).mockResolvedValueOnce({ householdName: "Family Library", email: "a@b.com", role: "member" });
    renderInvite(true);
    expect(await screen.findByText('Join "Family Library"')).toBeInTheDocument();
  });

  it("accepts the invite and calls the accept endpoint", async () => {
    vi.mocked(api).mockResolvedValueOnce({ householdName: "Family Library", email: "a@b.com", role: "member" });
    renderInvite(true);
    await screen.findByText('Join "Family Library"');

    vi.mocked(api).mockResolvedValueOnce({});
    await userEvent.click(screen.getByRole("button", { name: "Accept invite" }));
    expect(api).toHaveBeenLastCalledWith("/api/invites/tok123/accept", { method: "POST" });
  });

  it("shows an error alert when the invite fails to load", async () => {
    vi.mocked(api).mockRejectedValueOnce(new Error("Invite expired"));
    renderInvite(true);
    expect(await screen.findByText(/Invite expired/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @taakify/web test -- InviteAccept`
Expected: FAIL — no `Card`/`Skeleton`-based markup exists yet, so `screen.findByText('Join "Family Library"')` times out against the current plain-`<h1>` structure.

- [ ] **Step 3: Restyle the page**

```tsx
// apps/web/src/pages/InviteAccept.tsx
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../lib/api.js";
import { Button } from "../components/ui/button.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card.js";
import { Alert, AlertDescription } from "../components/ui/alert.js";
import { Skeleton } from "../components/ui/skeleton.js";

type Info = { householdName: string; email: string; role: string };

export function InviteAccept({ authed }: { authed: boolean }) {
  const { token } = useParams();
  const [info, setInfo] = useState<Info | null>(null);
  const [error, setError] = useState("");
  const navigate = useNavigate();

  useEffect(() => {
    api<Info>(`/api/invites/${token}`).then(setInfo).catch((e) => setError(e.message));
  }, [token]);

  async function accept() {
    try {
      await api(`/api/invites/${token}/accept`, { method: "POST" });
      navigate("/");
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <main className="flex min-h-dvh items-center justify-center p-4">
      {error ? (
        <Alert variant="destructive" className="w-full max-w-sm">
          <AlertDescription>Invite problem: {error}</AlertDescription>
        </Alert>
      ) : !info ? (
        <div className="w-full max-w-sm space-y-3">
          <Skeleton className="h-8 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      ) : (
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle>Join &quot;{info.householdName}&quot;</CardTitle>
            <CardDescription>
              You've been invited as {info.role} ({info.email}).
            </CardDescription>
          </CardHeader>
          <CardContent>
            {authed ? (
              <Button className="w-full" onClick={accept}>
                Accept invite
              </Button>
            ) : (
              <p className="text-sm text-muted-foreground">
                First{" "}
                <Link to={`/signup?next=/invite/${token}`} className="text-primary underline-offset-4 hover:underline">
                  create an account
                </Link>{" "}
                or{" "}
                <Link to={`/signin?next=/invite/${token}`} className="text-primary underline-offset-4 hover:underline">
                  sign in
                </Link>{" "}
                — you'll come right back here.
              </p>
            )}
          </CardContent>
        </Card>
      )}
    </main>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @taakify/web test -- InviteAccept`
Expected: `3 passed`.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/InviteAccept.tsx apps/web/src/pages/InviteAccept.test.tsx
git commit -m "feat(web): restyle InviteAccept with shadcn/ui, add tests"
```

---

### Task 10: Restyle Home (avatar, invite dialog, empty/loading states)

**Files:**
- Modify: `apps/web/src/pages/Home.tsx`
- Create: `apps/web/src/pages/Home.test.tsx`

**Interfaces:**
- Consumes: `Button`, `Input`, `Label`, `Card`/`CardHeader`/`CardTitle`/`CardDescription`/`CardContent`, `Alert`/`AlertDescription`, `Avatar`/`AvatarFallback`, `Skeleton`, `Dialog`/`DialogContent`/`DialogHeader`/`DialogTitle`/`DialogDescription`/`DialogTrigger` (Task 3); `Copy`, `LogOut`, `UserPlus`, `BookOpen` icons from `lucide-react`.
- Replaces `prompt()`/`alert()` with the `Dialog` per spec §5 — this is the one behavioral change in this plan, everything else is visual.

- [ ] **Step 1: Write the failing test**

```tsx
// apps/web/src/pages/Home.test.tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { Home } from "./Home.js";
import { api } from "../lib/api.js";
import { authClient } from "../lib/auth.js";

vi.mock("../lib/api.js", () => ({ api: vi.fn() }));
vi.mock("../lib/auth.js", () => ({ authClient: { signOut: vi.fn() } }));

const me = {
  user: { id: "u1", email: "a@b.com", name: "Ada Lovelace" },
  memberships: [{ household_id: "h1", role: "owner", household_name: "Family Library" }],
};

function renderHome() {
  render(
    <MemoryRouter>
      <Home />
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.mocked(api).mockReset();
  vi.mocked(authClient.signOut).mockReset();
});

describe("Home", () => {
  it("renders the household name, role, and avatar initials once loaded", async () => {
    vi.mocked(api).mockResolvedValueOnce(me);
    renderHome();
    expect(await screen.findByText("Family Library")).toBeInTheDocument();
    expect(screen.getByText(/owner/)).toBeInTheDocument();
    expect(screen.getByText("AL")).toBeInTheDocument();
  });

  it("shows the empty state when the user has no memberships", async () => {
    vi.mocked(api).mockResolvedValueOnce({ ...me, memberships: [] });
    renderHome();
    expect(await screen.findByText("You're not in a library yet.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Create your library" })).toHaveAttribute("href", "/onboarding");
  });

  it("opens the invite dialog, submits, and shows the returned link", async () => {
    vi.mocked(api).mockResolvedValueOnce(me);
    renderHome();
    await screen.findByText("Family Library");

    await userEvent.click(screen.getByRole("button", { name: /Invite a family member/ }));
    vi.mocked(api).mockResolvedValueOnce({ url: "/invite/tok123" });
    await userEvent.type(screen.getByLabelText("Email"), "friend@example.com");
    await userEvent.click(screen.getByRole("button", { name: "Send invite" }));

    expect(await screen.findByDisplayValue(/\/invite\/tok123$/)).toBeInTheDocument();
    expect(api).toHaveBeenLastCalledWith("/api/households/h1/invites", {
      method: "POST",
      body: JSON.stringify({ email: "friend@example.com", role: "member" }),
    });
  });

  it("signs out when the sign-out button is clicked", async () => {
    vi.mocked(api).mockResolvedValueOnce(me);
    vi.mocked(authClient.signOut).mockResolvedValue(undefined as never);
    renderHome();
    await screen.findByText("Family Library");

    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(authClient.signOut).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @taakify/web test -- Home`
Expected: FAIL — no invite `Dialog`, `Avatar`, or accessible "Sign out" button exists yet (current code uses `prompt()`/`alert()` and unlabeled buttons).

- [ ] **Step 3: Restyle the page**

```tsx
// apps/web/src/pages/Home.tsx
import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { Copy, LogOut, UserPlus, BookOpen } from "lucide-react";
import { api, type Me } from "../lib/api.js";
import { authClient } from "../lib/auth.js";
import { Button } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";
import { Label } from "../components/ui/label.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card.js";
import { Alert, AlertDescription } from "../components/ui/alert.js";
import { Avatar, AvatarFallback } from "../components/ui/avatar.js";
import { Skeleton } from "../components/ui/skeleton.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../components/ui/dialog.js";

function initials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .map((word) => word[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

export function Home() {
  const [me, setMe] = useState<Me | null>(null);
  const [loadError, setLoadError] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [inviteUrl, setInviteUrl] = useState("");
  const [inviteError, setInviteError] = useState("");

  useEffect(() => {
    api<Me>("/api/me").then(setMe).catch((e) => setLoadError((e as Error).message));
  }, []);

  async function invite(e: FormEvent<HTMLFormElement>, householdId: string) {
    e.preventDefault();
    const email = String(new FormData(e.currentTarget).get("email"));
    setInviteError("");
    try {
      const { url } = await api<{ url: string }>(`/api/households/${householdId}/invites`, {
        method: "POST",
        body: JSON.stringify({ email, role: "member" }),
      });
      setInviteUrl(`${location.origin}${url}`);
    } catch (err) {
      setInviteError((err as Error).message);
    }
  }

  function onDialogOpenChange(open: boolean) {
    setDialogOpen(open);
    if (!open) {
      setInviteUrl("");
      setInviteError("");
    }
  }

  if (loadError)
    return (
      <main className="flex min-h-dvh items-center justify-center p-4">
        <Alert variant="destructive" className="max-w-sm">
          <AlertDescription>Couldn't load your library: {loadError}</AlertDescription>
        </Alert>
      </main>
    );

  if (!me)
    return (
      <main className="flex min-h-dvh items-center justify-center p-4">
        <div className="w-full max-w-sm space-y-3">
          <Skeleton className="h-8 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-10 w-full" />
        </div>
      </main>
    );

  if (me.memberships.length === 0)
    return (
      <main className="flex min-h-dvh items-center justify-center p-4">
        <Card className="w-full max-w-sm text-center">
          <CardHeader>
            <BookOpen className="mx-auto h-10 w-10 text-primary" />
            <CardTitle>Welcome, {me.user.name}</CardTitle>
            <CardDescription>You're not in a library yet.</CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild className="w-full">
              <Link to="/onboarding">Create your library</Link>
            </Button>
          </CardContent>
        </Card>
      </main>
    );

  const membership = me.memberships[0];

  return (
    <main className="mx-auto flex min-h-dvh max-w-lg flex-col gap-6 p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Avatar>
            <AvatarFallback>{initials(me.user.name)}</AvatarFallback>
          </Avatar>
          <div>
            <h1 className="text-lg font-semibold">{membership.household_name}</h1>
            <p className="text-sm text-muted-foreground">
              {me.user.email} · {membership.role}
            </p>
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Sign out"
          onClick={() => authClient.signOut().finally(() => location.reload())}
        >
          <LogOut className="h-4 w-4" />
        </Button>
      </div>

      <Dialog open={dialogOpen} onOpenChange={onDialogOpenChange}>
        <DialogTrigger asChild>
          <Button className="w-full sm:w-auto">
            <UserPlus className="h-4 w-4" />
            Invite a family member
          </Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Invite a family member</DialogTitle>
            <DialogDescription>They'll get a link to join {membership.household_name}.</DialogDescription>
          </DialogHeader>
          {inviteUrl ? (
            <div className="flex items-center gap-2">
              <Input readOnly value={inviteUrl} />
              <Button
                type="button"
                variant="outline"
                size="icon"
                aria-label="Copy invite link"
                onClick={() => navigator.clipboard.writeText(inviteUrl)}
              >
                <Copy className="h-4 w-4" />
              </Button>
            </div>
          ) : (
            <form onSubmit={(e) => invite(e, membership.household_id)} className="grid gap-4">
              <div className="grid gap-2">
                <Label htmlFor="invite-email">Email</Label>
                <Input id="invite-email" name="email" type="email" placeholder="member@example.com" required />
              </div>
              {inviteError && (
                <Alert variant="destructive">
                  <AlertDescription>{inviteError}</AlertDescription>
                </Alert>
              )}
              <Button type="submit">Send invite</Button>
            </form>
          )}
        </DialogContent>
      </Dialog>

      <p className="text-sm text-muted-foreground">Books arrive in Plan 3. Sync arrives in Plan 2.</p>
    </main>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @taakify/web test -- Home`
Expected: `4 passed`.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/Home.tsx apps/web/src/pages/Home.test.tsx
git commit -m "feat(web): restyle Home, replace invite prompt/alert with Dialog, add tests"
```

---

### Task 11: App.tsx loading skeleton, theme hook wiring, routing tests

**Files:**
- Modify: `apps/web/src/App.tsx`
- Create: `apps/web/src/App.test.tsx`

**Interfaces:**
- Consumes: `useTheme()` (Task 4), `Skeleton` (Task 3).

- [ ] **Step 1: Write the failing test**

```tsx
// apps/web/src/App.test.tsx
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { App } from "./App.js";
import { authClient } from "./lib/auth.js";

vi.mock("./lib/auth.js", () => ({
  authClient: {
    useSession: vi.fn(),
    signIn: { email: vi.fn(), social: vi.fn() },
    signOut: vi.fn(),
  },
}));

vi.mock("./lib/api.js", () => ({
  api: vi.fn().mockResolvedValue({
    user: { id: "u1", email: "a@b.com", name: "Ada" },
    memberships: [],
  }),
}));

function renderApp(initialEntry: string) {
  render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <App />
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.mocked(authClient.useSession).mockReset();
});

describe("App routing", () => {
  it("redirects unauthenticated users from / to /signin", () => {
    vi.mocked(authClient.useSession).mockReturnValue({ data: null, isPending: false } as never);
    renderApp("/");
    expect(screen.getByRole("heading", { name: "Sign in to Taakify" })).toBeInTheDocument();
  });

  it("redirects authenticated users away from /signin", async () => {
    vi.mocked(authClient.useSession).mockReturnValue({ data: { user: {} }, isPending: false } as never);
    renderApp("/signin");
    expect(await screen.findByText("You're not in a library yet.")).toBeInTheDocument();
  });

  it("shows a loading skeleton while the session is pending", () => {
    vi.mocked(authClient.useSession).mockReturnValue({ data: null, isPending: true } as never);
    renderApp("/");
    expect(document.querySelector(".animate-pulse")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @taakify/web test -- App`
Expected: FAIL — `App.tsx` still renders `<main className="muted">Loading…</main>` (no `.animate-pulse` element) and the routed pages haven't been restyled with matching headings yet (this task must run after Tasks 6–10).

- [ ] **Step 3: Update `App.tsx`**

```tsx
// apps/web/src/App.tsx
import { Routes, Route, Navigate } from "react-router-dom";
import { authClient } from "./lib/auth.js";
import { SignUp } from "./pages/SignUp.js";
import { SignIn } from "./pages/SignIn.js";
import { Onboarding } from "./pages/Onboarding.js";
import { InviteAccept } from "./pages/InviteAccept.js";
import { Home } from "./pages/Home.js";
import { Skeleton } from "./components/ui/skeleton.js";
import { useTheme } from "./lib/use-theme.js";

export function App() {
  useTheme();
  const { data: session, isPending } = authClient.useSession();

  if (isPending)
    return (
      <main className="flex min-h-dvh items-center justify-center p-4">
        <Skeleton className="h-8 w-40" />
      </main>
    );

  const authed = Boolean(session);

  return (
    <Routes>
      <Route path="/signup" element={authed ? <Navigate to="/" /> : <SignUp />} />
      <Route path="/signin" element={authed ? <Navigate to="/" /> : <SignIn />} />
      <Route path="/invite/:token" element={<InviteAccept authed={authed} />} />
      <Route path="/onboarding" element={authed ? <Onboarding /> : <Navigate to="/signin" />} />
      <Route path="/" element={authed ? <Home /> : <Navigate to="/signin" />} />
    </Routes>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @taakify/web test -- App`
Expected: `3 passed`.

- [ ] **Step 5: Run the full web suite**

Run: `pnpm --filter @taakify/web test`
Expected: all test files pass (SignIn, SignUp, Onboarding, InviteAccept, Home, App).

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/App.tsx apps/web/src/App.test.tsx
git commit -m "feat(web): loading skeleton and dark-mode hook in App, add routing tests"
```

---

### Task 12: Final cleanup and full verification

**Files:**
- Modify: `apps/web/src/styles.css` (remove any now-unused legacy rules, if `shadcn init` didn't already fully replace them)

**Interfaces:** None — this is a verification-only task.

- [ ] **Step 1: Confirm no leftover hand-rolled CSS classes are referenced**

```bash
cd apps/web
grep -rn 'className="error"\|className="muted"' src/ || echo "none found"
```

Expected: `none found` (every page was rewritten in Tasks 6–11 to use Tailwind/shadcn classes instead of `.error`/`.muted`).

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @taakify/web typecheck`
Expected: no errors.

- [ ] **Step 3: Run the full monorepo test suite**

Run: `pnpm test`
Expected: all API tests pass (health, auth, RLS, households, invites) and all web tests pass (SignIn, SignUp, Onboarding, InviteAccept, Home, App).

- [ ] **Step 4: Manual smoke test**

```bash
docker compose -f docker-compose.dev.yml up -d
pnpm dev:api &
pnpm dev:web
```

Open `http://localhost:5173/signin` and confirm: Nunito font loads, coral primary button color, Card-based form layout, and (if your OS is in dark mode) the dark theme variables apply. Walk the sign-up → onboarding → invite-dialog → accept flow once to confirm the restyled `Dialog` invite flow works end-to-end (this repeats Plan 1's Task 11 manual journey, now against the restyled UI).

- [ ] **Step 5: Commit any final cleanup**

```bash
git add -A
git commit -m "chore(web): final cleanup after UI restyle"
```

(Skip this commit if Step 1 found nothing to clean up and no other files changed.)
