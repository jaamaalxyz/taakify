# Taakify

A local-first home bookshelf organizer: catalog your books, track each family
member's reading, lend books out (and get them back), and remember what you
borrowed. Multi-tenant from day one.

**Spec:** docs/superpowers/specs/2026-07-16-taakify-bookshelf-design.md
**Plans:** docs/superpowers/plans/

## Stack

React + Vite PWA · PGlite (in-browser Postgres) · ElectricSQL (sync) ·
Hono API · better-auth (email/password + Google) · Postgres ·
Docker Compose on a single VM · Cloudflare R2 for cover images.

## Development

Prereqs: Docker, Node 24, pnpm.

    docker compose -f docker-compose.dev.yml up -d   # postgres :5433, electric :3010
    pnpm install
    cp apps/api/.env.example apps/api/.env
    pnpm migrate
    pnpm dev:api    # :3001
    pnpm dev:web    # :5173

Tests: `pnpm test` (uses the taakify_test database on the same Postgres).

Google sign-in (optional in dev): create an OAuth client in Google Cloud
Console with redirect URI `http://localhost:5173/api/auth/callback/google`
and set `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` in `apps/api/.env`.
