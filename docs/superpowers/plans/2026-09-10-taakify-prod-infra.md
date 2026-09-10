# Production Infrastructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** make the existing docker-compose stack runnable on a real single VM (Oracle Cloud free-tier ARM) — container images for the API and web app, a production compose file where Electric is compose-internal only (per the shape proxy shipped in PR #32), a Cloudflare Tunnel service with no inbound ports, automated off-VM Postgres backups, and a deploy runbook. This is sequencing step 2 of the launch spec.

**Architecture:** two images built from the **repo root** context (both apps depend on the `@taakify/shared` workspace package, which is pure TypeScript source — there is no compiled artifact to copy). The API image runs `tsx src/index.ts` (see "Resolved open question" below); the web image builds the Vite bundle in a Node stage and serves it from nginx with an SPA fallback. `docker-compose.prod.yml` adds Postgres (`wal_level=logical`, named volume, no published ports), Electric (pinned 1.7.7, no published ports — the only client-reachable sync path is the authenticated `/api/sync/shape` proxy), a one-shot `migrate` service, `cloudflared` (behind a `tunnel` profile so local validation can skip it), and a `pg_dump` + rclone backup sidecar that alerts Sentry on failure. Secrets live in `.env.prod` (gitignored), consumed via `docker compose --env-file .env.prod` interpolation and explicit `environment:` entries — internal topology (service hostnames, ports) is fixed in compose, not in the env file.

**Tech Stack:** Docker + docker compose v2, nginx, cloudflared, rclone, POSIX sh.

**Spec:** `docs/superpowers/specs/2026-09-08-taakify-public-mvp-launch-design.md` (§3 topology, §4 Production Infrastructure, §5 firewall, §11 step 2)

## Global Constraints

- Electric is **never** given a `ports:` entry and is never routable from outside the compose network — the spec's ingress depends on it (§3). The same applies to Postgres.
- The only inbound path to the VM is SSH; all web traffic arrives via `cloudflared`'s outbound tunnel (§5). Nothing in this stack may require opening 80/443.
- Images must build for `linux/arm64` (Oracle ARM VM). Building on the VM itself via compose `build:` is the supported path — no registry, no multi-arch pipeline.
- Mirror the dev stack's verified facts exactly where they matter: `postgres:17-alpine` with `wal_level=logical` (Electric requires logical replication), `electricsql/electric:1.7.7` pinned (issue #28 comment in `docker-compose.dev.yml` — never float this tag).
- `ELECTRIC_INSECURE=true` stays on in prod **deliberately**: Electric is reachable only from the `api` container on the compose network, and authentication happens in the shape proxy (`requireUser` + server-derived `where`), not in Electric. Document this in the compose file so a future reader doesn't "fix" it into a broken state.
- No secrets in `docker-compose.prod.yml` or any committed file — everything secret comes from `.env.prod` via interpolation; `.env.prod` must be gitignored before the file can ever exist.
- Existing tests keep passing (`pnpm test` from repo root) — the only application-code touch is a `start` script in `apps/api/package.json`.

## Resolved open question (spec §12)

> "Whether `apps/api`'s existing build step (if any) needs adjustment for a production Docker image"

There is no build step, and adding one is not worth it: `@taakify/shared` is consumed as raw `.ts` source (`packages/shared/package.json` `main: ./src/index.ts`), imports use `.js` extensions that resolve to `.ts` files, and the repo's own `migrate` script already runs `tsx src/db/migrate.ts`. Compiling would mean introducing a build config for two packages to gain nothing at this scale. **Decision:** the production image runs the API exactly as dev does — `tsx src/index.ts` — via a new `start` script. tsx stays a devDependency and the image installs devDeps for the api+shared subset only (`pnpm install --filter`). Revisit only if cold-start transform cost ever matters (it doesn't: tsx caches, and the process is long-lived).

## File Structure

- **Create** `apps/api/Dockerfile` — Node 24 alpine, workspace-aware, filtered install, runs `pnpm --filter @taakify/api start`.
- **Create** `apps/web/Dockerfile` — Node 24 build stage → nginx alpine serving `dist/`.
- **Create** `apps/web/nginx.conf` — SPA `try_files`, gzip, immutable cache for hashed `/assets/`, `no-cache` for `index.html`.
- **Create** `infra/backup/Dockerfile` + `infra/backup/backup.sh` — `postgres:17-alpine` + rclone sidecar: nightly `pg_dump`, rotate, `rclone` off-VM, Sentry alert on failure (spec §9).
- **Create** `docker-compose.prod.yml` — postgres, electric, api, web, migrate (profile), cloudflared (profile `tunnel`), backup.
- **Create** `.env.prod.example` — every secret the compose file interpolates, with generation hints.
- **Create** `docs/deploy.md` — the runbook (provision → firewall → secrets → build → migrate → tunnel → verify → restore → update).
- **Create** `.dockerignore` (repo root — both images share the root context).
- **Modify** `apps/api/package.json` — add `"start": "tsx src/index.ts"`.
- **Modify** `.gitignore` — add `.env.prod`.

---

### Task 1: API image

**Files:**
- Create: `apps/api/Dockerfile`, `.dockerignore`
- Modify: `apps/api/package.json`

- [ ] **Step 1: Add the `start` script** to `apps/api/package.json` (next to `dev`): `"start": "tsx src/index.ts"` — same entry as dev, no watch.

- [ ] **Step 2: Write `.dockerignore`** at the repo root (both images build from the root context because of the pnpm workspace): exclude `.git`, `node_modules` (all levels), `.env` files, `.storage`, `dist`, `.worktrees`, `.claude`, `spike`, `docs`.

- [ ] **Step 3: Write `apps/api/Dockerfile`**

```dockerfile
FROM node:24-alpine
WORKDIR /app

# corepack ships the pnpm version pinned by packageManager/corepack defaults
RUN corepack enable

# Manifests first for layer caching: root + every workspace member the API
# needs (api + shared; web's manifest is included so the filtered install can
# resolve the full workspace graph without copying web's sources).
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/

# Filtered install: api's deps (incl. its workspace dep @taakify/shared) and
# their devDependencies (tsx is a devDep and IS needed at runtime -- see the
# plan's "Resolved open question").
RUN pnpm install --frozen-lockfile --filter @taakify/api...

COPY apps/api apps/api
COPY packages/shared packages/shared

ENV NODE_ENV=production
EXPOSE 3001
CMD ["pnpm", "--filter", "@taakify/api", "start"]
```

- [ ] **Step 4: Build and smoke it**

Run: `docker build -f apps/api/Dockerfile -t taakify-api:dev .`
Expected: build succeeds. Then, with the dev stack's Postgres reachable from the host network — run the container long enough to see `API listening on :3001` in its logs (it will fail DB connections if pointed nowhere; listening line proves the entry point). A full functional smoke happens in Task 4 against the prod compose.

---

### Task 2: Web image

**Files:**
- Create: `apps/web/Dockerfile`, `apps/web/nginx.conf`

- [ ] **Step 1: Write `apps/web/nginx.conf`**

```nginx
server {
  listen 80;
  server_name _;
  root /usr/share/nginx/html;
  index index.html;

  gzip on;
  gzip_types text/css application/javascript application/json image/svg+xml;
  gzip_min_length 1024;

  # Vite emits content-hashed filenames under /assets — safe to cache hard.
  location /assets/ {
    add_header Cache-Control "public, max-age=31536000, immutable";
    try_files $uri =404;
  }

  # The SPA shell must always be re-fetched so JS/CSS hash bumps are picked up.
  location = /index.html {
    add_header Cache-Control "no-cache";
  }

  # Client-side routing: every unknown path falls back to the shell.
  location / {
    try_files $uri $uri/ /index.html;
  }
}
```

- [ ] **Step 2: Write `apps/web/Dockerfile`** (multi-stage, root context)

```dockerfile
FROM node:24-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
# Build needs devDeps (tsc, vite) for web + shared.
RUN pnpm install --frozen-lockfile --filter @taakify/web... --filter @taakify/shared...
COPY apps/web apps/web
COPY packages/shared packages/shared
# `build` = tsc --noEmit && vite build -- typecheck included, same as CI-less
# repo convention.
RUN pnpm --filter @taakify/web build

FROM nginx:1.27-alpine
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
```

- [ ] **Step 3: Build and smoke it**

Run: `docker build -f apps/web/Dockerfile -t taakify-web:dev . && docker run --rm -d -p 127.0.0.1:8099:80 taakify-web:dev`
Expected: build succeeds (typecheck included); `curl -s localhost:8099/` returns the SPA shell; `curl -s -o /dev/null -w '%{http_code}' localhost:8099/some/client/route` is 200 (SPA fallback); the shell references hashed `/assets/` URLs. Stop and remove the container after.

---

### Task 3: Production compose file

**Files:**
- Create: `docker-compose.prod.yml`

- [ ] **Step 1: Write `docker-compose.prod.yml`**

Structure (see file for the authoritative version):

- `postgres` — `postgres:17-alpine`, `command: ["postgres","-c","wal_level=logical"]` (Electric requires logical replication — mirror dev exactly), credentials via `${POSTGRES_USER}`/`${POSTGRES_PASSWORD}`/`${POSTGRES_DB}` interpolation, named volume `taakify_pgdata`, `pg_isready` healthcheck, `restart: unless-stopped`, **no `ports:`**.
- `electric` — `electricsql/electric:1.7.7` (pinned, issue #28), internal `DATABASE_URL` pointing at the `postgres` service, `ELECTRIC_INSECURE: "true"` with a comment explaining why that is correct behind the authenticated proxy, `depends_on: postgres: service_healthy`, `restart: unless-stopped`, **no `ports:`**.
- `api` — `build: {context: ., dockerfile: apps/api/Dockerfile}` (shared anchor with `migrate`), explicit `environment:` mapping: internal `DATABASE_URL`/`APP_DATABASE_URL` (service hostname `postgres`, port 5432, the interpolated password; the app-role password is the one migration `0003_rls.sql` creates — flagged for the step-3 security pass), `ELECTRIC_INTERNAL_URL: http://electric:3000/v1/shape`, `PORT: 3001`, plus pass-throughs of `${BETTER_AUTH_SECRET}` (required), `${BETTER_AUTH_URL}`, `${GOOGLE_CLIENT_ID}`/`${GOOGLE_CLIENT_SECRET}`/`${STORAGE_*}`/`${SENTRY_DSN}` (optional). Healthcheck: `node -e "fetch('http://localhost:3001/api/health')..."`. `restart: unless-stopped`. **no `ports:`**.
- `web` — `build: {context: ., dockerfile: apps/web/Dockerfile}`, `restart: unless-stopped`, **no `ports:`** (cloudflared reaches it as `web:80`).
- `migrate` — same build anchor as `api`, `command: pnpm --filter @taakify/api migrate`, `profiles: ["migrate"]` so it never runs under plain `up`, `depends_on: postgres: service_healthy`.
- `cloudflared` — `cloudflare/cloudflared` (pin the tag after first deploy), `command: tunnel --no-autoupdate run --token ${CLOUDFLARE_TUNNEL_TOKEN}`, `profiles: ["tunnel"]`, `depends_on: [api, web]`, `restart: unless-stopped`.
- `backup` — `build: ./infra/backup` (Task 4), internal `DATABASE_URL`, `${BACKUP_RETENTION_DAYS}`/`${RCLONE_REMOTE}`/rclone config pass-through/`${SENTRY_DSN}`, `taakify_backups` volume, `depends_on: postgres: service_healthy`, `restart: unless-stopped`.

- [ ] **Step 2: Validate the file**

Run: `POSTGRES_PASSWORD=x BETTER_AUTH_SECRET=y CLOUDFLARE_TUNNEL_TOKEN=z docker compose -f docker-compose.prod.yml --env-file /dev/null config >/dev/null`
Expected: exits 0, no warnings about unset variables beyond deliberately optional ones (declare optional ones with `:-` defaults in the interpolation).

---

### Task 4: Backup sidecar

**Files:**
- Create: `infra/backup/Dockerfile`, `infra/backup/backup.sh`

- [ ] **Step 1: Write `infra/backup/Dockerfile`** — `FROM postgres:17-alpine` (same major as the server, so `pg_dump` format matches), `apk add rclone`, copy `backup.sh` as entrypoint.

- [ ] **Step 2: Write `infra/backup/backup.sh`** — POSIX sh:
  - `wait_for_pg`: `pg_isready` loop before the first dump.
  - `alert()`: if `SENTRY_DSN` is set, POST a minimal Sentry event envelope to the DSN's `/api/<project>/envelope/` endpoint with `X-Sentry-Key` (spec §9: backup failures must not be silent). Parse host/key/project from the DSN with `sed`.
  - main loop: dump immediately, then every 24h: `pg_dump "$DATABASE_URL" -f /backups/taakify_$(date -u +%Y%m%d_%H%M%S).sql` then `gzip` it (separate steps so pg_dump's exit code is visible — POSIX sh has no `pipefail`); rotate keeping `${BACKUP_RETENTION_DAYS:-14}` newest; if `RCLONE_REMOTE` is set, `rclone copy` the dumps off-VM, else log a loud warning that backups are on-VM only. Any failure → `alert` + keep looping (a dead backup container is worse than one that failed loudly and retried).

- [ ] **Step 3: Verify locally**

Run the sidecar against the dev compose's Postgres (`docker build -t taakify-backup:dev infra/backup && docker run --rm -v /tmp/backup-test:/backups -e DATABASE_URL=postgresql://postgres:postgres@host.docker.internal:5433/taakify taakify-backup:dev` with a short sleep).
Expected: a `.sql.gz` appears in `/tmp/backup-test`, rotation respects the cap (set `BACKUP_RETENTION_DAYS=1` and run twice), missing `RCLONE_REMOTE` logs the warning without failing, and a bogus `SENTRY_DSN` exercises `alert()` without crashing the loop. Stop it after one cycle (it sleeps 24h — `docker run --rm -i` + Ctrl-C or `timeout`).

---

### Task 5: Env template, gitignore, deploy runbook

**Files:**
- Create: `.env.prod.example`, `docs/deploy.md`
- Modify: `.gitignore`

- [ ] **Step 1: `.gitignore`** — add `.env.prod` (the existing `.env` pattern does **not** match it).

- [ ] **Step 2: `.env.prod.example`** — one commented block per concern: Postgres (`POSTGRES_PASSWORD` — generate with `openssl rand -base64 24`; user/db fixed defaults), auth (`BETTER_AUTH_SECRET` — `openssl rand -base64 32`, no dev fallback; `BETTER_AUTH_URL` — the real HTTPS origin), optional Google OAuth, optional R2 `STORAGE_*` (falls back to container-local disk — note that book covers then live in the api container's filesystem and vanish on image replacement), `SENTRY_DSN` (unused until step 4, backup sidecar reads it first), `CLOUDFLARE_TUNNEL_TOKEN`, backup settings (`BACKUP_RETENTION_DAYS`, optional `RCLONE_REMOTE` + `RCLONE_CONFIG_REMOTE_*` vars for R2 as s3).

- [ ] **Step 3: `docs/deploy.md`** — the runbook, covering: VM provisioning notes (Oracle ARM, Ubuntu), **firewall: only SSH** (both the OS-level rules and the Oracle security list — the default list already allows only 22; do not open 80/443), Docker + compose plugin install, clone + `cp .env.prod.example .env.prod` + fill secrets, `docker compose --env-file .env.prod -f docker-compose.prod.yml build`, `up -d postgres electric` then `run --rm migrate` then full `up -d`, Cloudflare Zero Trust tunnel creation (token → `.env.prod`, public hostname rules with the `/api/` path rule **before** the catch-all → `http://api:3001` and `http://web:80`), verification (`compose ps`, `compose logs`, `curl https://domain/api/health`, a real signup), backup/restore (`gunzip -c dump | docker compose exec -T postgres psql -U postgres taakify` — restore drill belongs in the runbook, not just backups), and the update procedure (`git pull` → build → `up -d` → migrate). Include the app-role-password caveat (hardcoded in migration 0003 today; compose-internal exposure only; fix scheduled for the security pass).

---

### Task 6: Full verification pass

- [ ] **Step 1: Static validation** — `docker compose -f docker-compose.prod.yml config` with dummy env renders cleanly.

- [ ] **Step 2: Local stack smoke (no tunnel profile)** — `docker compose --env-file <dummy env> -f docker-compose.prod.yml up -d postgres electric api web backup`, then `--profile migrate` once.
  Expected: postgres + electric healthy, migrate exits 0, `api` healthy; from a one-off container on the compose network: `GET /api/health` → `{"ok":true}` through `api:3001`, a real `POST /api/auth/sign-up/email` works, `GET /api/sync/shape?table=edition` through the **prod** api container returns Electric protocol headers (proving `ELECTRIC_INTERNAL_URL=http://electric:3000/...` wiring end to end), and `GET /` on `web:80` returns the SPA shell. `backup` writes a dump into its volume.

- [ ] **Step 3: Regression** — `pnpm test` from repo root (restart the dev stack first if it's down; stop it again afterwards if it was down) and both typechecks. Expected: all green — this PR's only application-code change is the `start` script.

- [ ] **Step 4: Grep hygiene** — no committed file contains a real secret: `git diff --check` + review `.env.prod.example` is all placeholders; `docker-compose.prod.yml` only interpolates.

- [ ] **Step 5: Commit** — logical commits: `feat: production Docker images for api and web`, `feat: production docker-compose stack (Electric internal-only)`, `feat: nightly pg_dump backup sidecar with Sentry alerting`, `docs: production deploy runbook + env template`, `docs: add production infrastructure implementation plan`.
