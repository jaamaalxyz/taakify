# Taakify: Production Deployment & Public MVP Validation Launch

**Date:** 2026-09-08
**Status:** Approved by user (brainstorming complete)

## 1. Overview

Taakify's feature set is V1-complete (per
`docs/superpowers/plans/2026-09-03-taakify-design-spec-gaps.md`: CSV import,
barcode scan, Home screen, and cover upload all shipped). Everything so far
has run against `docker-compose.dev.yml` on localhost. This spec covers what
it takes to run Taakify on real production infrastructure, secured and
monitored well enough to hand the URL to the author's own household plus a
handful of neighbors/friends — each getting their own isolated household via
the self-serve signup flow that already exists (`/signup` → `/onboarding` →
create household). This is explicitly **not** the V2 SaaS release described
in the original spec's §7 Release Plan (no billing, no cross-household
features, no dedicated marketing site) — it is "V1, deployed for real, safe
to hand to a few real households."

## 2. Goals & Non-Goals

Goals:

- Run the existing docker-compose stack on a real server (Oracle Cloud
  free-tier ARM VM), reachable over HTTPS at a real domain.
- Make the app safe to expose to strangers' data: firewalled VM, rate-limited
  auth endpoints, a security-review pass over the RLS/auth code path,
  automated off-VM database backups.
- Give unauthenticated visitors a minimal landing page instead of a bare
  sign-in form.
- Catch production errors (server and client) via self-hosted, open-source
  error tracking — consistent with the original spec's "every component
  open source, no proprietary services" principle where practical (see
  the Cloudflare Tunnel note in §3 for the one additional exception this
  pass accepts, alongside the existing R2 exception).
- Add the Playwright E2E suite (gap #5 from the 2026-09-03 audit) as both
  general regression coverage and a pre-launch smoke test against the
  production build.

Non-Goals (this pass):

- Billing/payments — unchanged from the original spec, deferred to V2.
- A dedicated marketing/landing site with its own build pipeline — one
  static page is enough.
- Cross-household features, public household directory, book-club
  households — V2.
- OpenTelemetry tracing/metrics stack (Grafana/Tempo/Loki/Prometheus) — the
  free-tier VM's RAM is better spent on GlitchTip (error tracking only) for
  now; revisit if real performance problems appear.
- High-availability/multi-VM setup — single VM, matching the original
  spec's $0/month hosting goal. Acceptable risk at this scale as long as
  backups are off-VM.

## 3. Architecture

### New components

| Component      | Choice                                                 | Role                                                                        |
| -------------- | ------------------------------------------------------ | --------------------------------------------------------------------------- |
| Edge/TLS       | Cloudflare Tunnel (`cloudflared`)                      | Outbound-only tunnel to Cloudflare's edge; Cloudflare terminates TLS and routes to the tunnel — no inbound ports needed on the VM |
| API runtime    | Docker image (Node), built from `apps/api/Dockerfile`  | Runs the existing Hono API in production                                    |
| Web runtime    | Docker image (nginx), built from `apps/web/Dockerfile` | Serves the Vite production build (static SPA)                               |
| Error tracking | GlitchTip (self-hosted, Sentry-SDK-compatible)         | Captures server + client exceptions with stack traces/context               |
| Backups        | `pg_dump` sidecar container + cron                     | Nightly dump, rotated, pushed off-VM                                        |
| E2E            | Playwright                                             | Smoke-tests the five screens + one offline scenario against a running build |

Everything else — PGlite, ElectricSQL, better-auth, RLS, the outbox sync
layer, the storage abstraction — is unchanged; this spec is purely the
"run it for real" layer around already-shipped application code.

**Note on the Cloudflare Tunnel choice:** the domain is already managed on
Cloudflare, which removes Tunnel's main setup cost (a nameserver
migration). In exchange for a closed firewall (no inbound 80/443 on the
VM at all — `cloudflared` only makes outbound connections) and no
in-house TLS/cert management, this accepts Cloudflare's edge as a second
proprietary-service dependency alongside R2 — unlike R2, it is not
swappable behind a small interface, since it's the network path itself,
and the app's reachability now depends on Cloudflare's availability in
addition to the VM's. This tradeoff was discussed and accepted explicitly
in favor of the self-hosted-Caddy alternative (fully open-source, but
requires 80/443 open on the VM and self-managed cert renewal).

### Deployment topology

```
Internet
   │
   ▼
 Cloudflare edge (TLS termination, DNS)
   │  outbound-only tunnel connection
   ▼
 cloudflared  ──────────────┬──────────────┐
   │ /api/* → api:3001                     │ everything else → web:80
   ▼                                        ▼
 apps/api container            apps/web container (nginx, static build)
   │
   ├──> Postgres container (adminPool + appPool, RLS)
   ├──> Electric container (shape streams, reads Postgres)
   └──> GlitchTip container (error events)
   │
   └──> pg_dump sidecar (cron, writes to volume, rclone off-VM)
```

`cloudflared` dials out to Cloudflare — no port is opened on the VM for
inbound web traffic at all (80/443 stay closed; see §5). All other
containers communicate over the compose-internal Docker network, matching
the existing dev Postgres/Electric relationship.

### Data flow changes

None at the application level. Client PGlite mirrors, Electric shape
streams, and the outbox queue behave identically against a production
Postgres as they do against the dev one — the only change is the network
path (HTTPS via Cloudflare's edge + the tunnel instead of the Vite dev
proxy) and that `BETTER_AUTH_URL` / cookie flags now reflect a real HTTPS
origin (`Secure`, `SameSite=Lax` — verify this differs from whatever the
dev config currently assumes for `http://localhost`).

## 4. Production Infrastructure

- **`apps/api/Dockerfile`** — multi-stage: install deps, build (if a build
  step exists), run `node` against the compiled/entry file. Reads all
  config from environment, matching the existing `.env.example` shape.
- **`apps/web/Dockerfile`** — multi-stage: `pnpm --filter @taakify/web
build` in a Node stage, copy `dist/` into an nginx stage. nginx serves
  the SPA with a catch-all `try_files ... /index.html` for client-side
  routing.
- **`docker-compose.prod.yml`** — Postgres (named volume for data),
  Electric, api, web, `cloudflared`, GlitchTip (plus GlitchTip's own
  dependencies — it needs its own Postgres + Redis; check current
  GlitchTip docker-compose reference at implementation time and either
  run a second lightweight Postgres or point it at the same instance in a
  separate database), and the backup sidecar.
- **Cloudflare setup (one-time, outside the compose stack)** — create a
  Tunnel in the Cloudflare dashboard (or `cloudflared tunnel create`),
  add a CNAME record pointing the domain at `<tunnel-id>.cfargotunnel.com`,
  and write the tunnel's `config.yml` (ingress rules mapping the hostname
  and `/api/*` path to the `web`/`api` containers). The tunnel token goes
  into `.env.prod` alongside the other secrets.
- **`.env.prod.example`** — production secrets template: `DATABASE_URL`,
  `APP_DATABASE_URL`, `BETTER_AUTH_SECRET` (must not use the dev fallback —
  `auth.ts` already throws if unset, so this is enforced), `BETTER_AUTH_URL`
  (the real domain), `GOOGLE_CLIENT_ID`/`SECRET` (optional), `STORAGE_*`
  (optional — falls back to local-disk storage per the existing
  `storage.ts` logic if unset), `GLITCHTIP_DSN` (server), a
  client-exposed GlitchTip DSN for the web build, `CLOUDFLARE_TUNNEL_TOKEN`.
- **Backups** — nightly `pg_dump` of the primary Postgres database (not
  GlitchTip's) to a mounted volume, rotated (e.g. keep 14 daily), then
  synced off-VM via `rclone` to an R2 bucket or similar. A single VM with
  only on-VM backups is not a real backup — losing the VM loses the backups
  too, so the off-VM push is required, not optional.
- **Deploy runbook** — a new `docs/deploy.md`: provision VM → configure
  firewall (see §5) → clone repo → populate `.env.prod` (including the
  Cloudflare tunnel token) → `docker compose -f docker-compose.prod.yml
  up -d` → run `pnpm migrate` against the prod DB → confirm the tunnel
  shows "healthy" in the Cloudflare dashboard → smoke-test with
  Playwright (§7) before announcing the URL to anyone.

## 5. Security Hardening Pass

- **VM firewall** — 80 and 443 stay **closed**; only SSH is open (key-only
  auth, consider a non-default port and/or fail2ban given the box is now
  internet-facing). This is stricter than a Caddy-based setup would allow,
  since all web traffic reaches the VM exclusively through the outbound
  `cloudflared` tunnel — nothing needs to accept inbound web connections.
- **Auth rate limiting** — `/api/auth/*` (sign-in, sign-up) currently has
  no rate limit; add one (e.g. a small in-memory or Redis-backed limiter
  keyed on IP) before going public, since credential-stuffing/guessing
  against an open signup endpoint is a realistic risk once the URL is not
  secret.
- **Security-review pass** — run the `security-review` skill against the
  current branch/diff before launch, with particular attention to the
  RLS policies (`migrations/0003_rls.sql`) and `withUser`/session code
  (`middleware/session.ts`, `db/tenant.ts`) — this is the code that
  guarantees household isolation once real strangers' data is on the box.
- **Dependency audit** — `pnpm audit` (both workspaces) as a standing step
  in the deploy checklist, not just a one-time check.
- **Cookie/session flags** — confirm better-auth's session cookie is
  issued with `Secure` and an appropriate `SameSite` value under the real
  HTTPS origin; this may currently be implicit/permissive under
  `http://localhost` in dev and needs explicit verification in prod.
- **Cloudflare account security** — since the tunnel is now the sole path
  to the app, treat the Cloudflare account itself as a security boundary:
  enable 2FA on it and scope the tunnel token as narrowly as Cloudflare
  allows, since anyone with dashboard/token access could reroute or
  disable the tunnel.

## 6. Minimal Landing Page

A single static page at `/` (or a new top-level route, whichever fits the
existing router more cleanly) shown to unauthenticated visitors instead of
the current bounce to `/signin`: a few lines on what Taakify is, and two
buttons — Sign up, Sign in — linking into the existing `SignUp`/`SignIn`
pages. No separate build pipeline, no new framework; it's one more
component/route in the existing `apps/web` app. Authenticated visitors keep
being redirected straight into the app as today.

## 7. Playwright E2E Suite

- Playwright config at the repo root or in `apps/web`, run against
  `pnpm dev:api` + `pnpm dev:web` (and, before each production deploy, run
  once against the production build as a launch gate).
- One spec per screen: Home, Library, Add, Loans, Profile — covering the
  primary action on each (e.g. Add: search-and-add a book; Loans: lend a
  book and see it appear as active).
- One offline scenario: go offline (Playwright's network condition
  emulation), add a book, go back online, verify the outbox flushes and
  the book appears via sync — mirroring the original spec's §9 testing
  requirement ("E2E: Playwright smoke tests across the five screens,
  including one offline scenario").

## 8. Observability

- GlitchTip container added to `docker-compose.prod.yml` (with its own
  Postgres/Redis dependencies as required by its own compose reference).
- Server: wrap the Hono API with the Sentry Node SDK (GlitchTip is
  protocol-compatible), pointed at the self-hosted DSN via
  `GLITCHTIP_DSN`.
- Client: initialize the Sentry browser SDK in `apps/web` with a
  client-safe DSN, capturing unhandled exceptions and (optionally) the
  outbox's dead-letter events, since a silently-dead-lettered offline
  write is exactly the kind of bug that's invisible without error
  tracking.
- No OTel tracing/metrics in this pass (see Non-Goals) — GlitchTip gives
  error visibility, which is the immediate need; tracing/metrics are
  deferred until there's a concrete performance question to answer.

## 9. Error Handling

- Deploy runbook failures (migration error, container crash-loop) are
  operator-visible via `docker compose logs` and GlitchTip; no new
  in-app error handling paths are introduced by this spec beyond wiring
  existing errors into GlitchTip.
- Backup failures — the `pg_dump` cron should alert (at minimum, fail
  loudly into GlitchTip or an equivalent notification) rather than fail
  silently, since a backup that quietly stops running is worse than no
  backup at all (false confidence).

## 10. Testing

- Playwright suite (§7) is the primary new automated coverage from this
  spec, run in CI-equivalent fashion locally before each deploy.
- Manual smoke pass after each production deploy: sign up a fresh test
  household, add a book, lend it, go offline/online, confirm sync —
  before announcing the URL to any neighbor/friend.
- Security-review skill run (§5) is a one-time gate before the first
  public launch, then re-run before major auth/RLS-touching changes.

## 11. Sequencing

1. **Infrastructure** — Dockerfiles, `docker-compose.prod.yml`, deploy
   runbook, backups. (Prerequisite for everything else — nothing below
   can be validated without a running production stack.)
2. **Security hardening pass** — firewall, rate limiting, security-review,
   cookie flags. (Must happen before real strangers' data lands on the
   box.)
3. **GlitchTip** — wired in alongside the security pass since error
   visibility from day one of real traffic is valuable, and it's an
   isolated addition to the compose stack.
4. **Landing page** — cheap, no dependencies on the above beyond having a
   deployed app to link into.
5. **Playwright E2E** — most valuable once there's a production build to
   smoke-test against; also serves as the final pre-launch gate.

## 12. Open Questions for Implementation Time

- GlitchTip's own dependency footprint (Postgres + Redis) on a free-tier
  ARM VM should be checked against actual available RAM before commit —
  if too heavy, a lighter alternative (e.g. plain structured logging to a
  file, revisited later) may be substituted, but GlitchTip is the
  default per this spec.
- Whether `apps/api`'s existing build step (if any) needs adjustment for
  a production Docker image — check current `package.json` build script
  during implementation.
