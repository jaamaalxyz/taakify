# Taakify production deploy runbook

Single-VM deployment per
`docs/superpowers/specs/2026-09-08-taakify-public-mvp-launch-design.md`.
Everything below assumes the repo is cloned on the VM itself (images are
built there — Oracle ARM, so builds are native `linux/arm64`).

Throughout, the compose invocation is:

```sh
docker compose --env-file .env.prod -f docker-compose.prod.yml <cmd>
```

## 1. Provision the VM

- Oracle Cloud free-tier ARM (Ampere A1, 1/8 of an OCPU up — 4 GB RAM is
  comfortable for this stack), Ubuntu LTS image.
- **Firewall: only SSH.** Two layers must agree:
  - The Oracle **security list** for the VCN/subnet: the default allows only
    22 — leave it that way. Do **not** open 80/443; all web traffic arrives
    through `cloudflared`'s outbound tunnel.
  - The OS: `ufw default deny incoming && ufw allow OpenSSH && ufw enable`.
- Harden SSH while you're there (key-only auth; consider a non-default port
  and fail2ban — the box is internet-facing now).
- Install Docker Engine + the compose plugin (`apt` repo per Docker's docs).

## 2. Secrets

```sh
cp .env.prod.example .env.prod
# fill in POSTGRES_PASSWORD, BETTER_AUTH_SECRET, BETTER_AUTH_URL,
# CLOUDFLARE_TUNNEL_TOKEN (after step 6), and optionally STORAGE_*/SENTRY_DSN
```

`.env.prod` is gitignored. Internal topology (service hostnames, DB URLs,
`ELECTRIC_INTERNAL_URL`) lives in `docker-compose.prod.yml` — the env file
carries secrets only.

`APP_DB_PASSWORD` sets the RLS-scoped `taakify_app` role's password (applied
by `pnpm migrate` via `ALTER ROLE`, not baked into the migration SQL) — set
it to a real secret, distinct from `POSTGRES_PASSWORD`. To rotate it later:
update `.env.prod`, then re-run step 4 (`... run --rm migrate`) — the next
migrate pass applies the new password immediately.

## 3. Build and start the data tier

```sh
docker compose --env-file .env.prod -f docker-compose.prod.yml build
docker compose --env-file .env.prod -f docker-compose.prod.yml up -d postgres electric
```

## 4. Migrate

```sh
docker compose --env-file .env.prod -f docker-compose.prod.yml run --rm migrate
```

One-shot service (`restart: no`, only runs under the `migrate` profile). Run
it again after every pull that includes new migrations. Use `run --rm`, not
`up --exit-code-from migrate` — the latter implies `--abort-on-container-exit`
and would stop the rest of the stack when the migration finishes.

## 5. Start the app

```sh
docker compose --env-file .env.prod -f docker-compose.prod.yml up -d
```

Brings up `api`, `web`, and `backup` (the tunnel is a separate profile, next
step). Verify locally on the VM before exposing anything:

```sh
docker compose --env-file .env.prod -f docker-compose.prod.yml ps   # api healthy, postgres/electric healthy
docker compose --env-file .env.prod -f docker-compose.prod.yml logs api
docker run --rm --network taakify-prod_default curlimages/curl -fsS http://api:3001/api/health
# -> {"ok":true}
```

## 6. Cloudflare Tunnel (the only ingress)

1. Cloudflare dashboard → Zero Trust → **Networks → Tunnels → Create a
   tunnel** (cloudflared type). Copy the tunnel token into `.env.prod` as
   `CLOUDFLARE_TUNNEL_TOKEN`.
2. Configure the tunnel's **Public Hostnames** (dashboard-managed — the token
   carries the config, no local `config.yml` needed). Two rules, in this
   order (first match wins):
   - hostname `app.example.com`, **path** `^/api/.*` → service `http://api:3001`
   - hostname `app.example.com` (no path) → service `http://web:80`
3. Start it:

   ```sh
   docker compose --env-file .env.prod -f docker-compose.prod.yml --profile tunnel up -d cloudflared
   ```

4. The dashboard's tunnel health indicator should go green, then
   `https://app.example.com/api/health` should return `{"ok":true}` from the
   public internet.

Why the ordering matters: without the `/api/` path rule first, every API call
would hit nginx, which has no `/api` location and would return the SPA shell
with 200 — a confusing failure mode, not a loud one.

Enable 2FA on the Cloudflare account: it is now the sole path to the app
(spec §5) — anyone with dashboard access can reroute or disable the tunnel.

## 7. Pre-announce smoke pass

Before handing the URL to anyone (spec §10): sign up a fresh household, add a
book, lend it, go offline/online and confirm sync — in a real browser against
the public URL. The Playwright E2E suite (spec §11 step 6) will formalize
this once it exists.

## Backups

The `backup` sidecar is always on: immediately on start, then every 24h, it
`pg_dump`s to `/backups` (the `taakify_backups` volume), keeps the newest
`BACKUP_RETENTION_DAYS` dumps, and — when `RCLONE_REMOTE` is set — pushes
them off the VM via rclone (R2 config in `.env.prod.example`). Failures alert
to Sentry when `SENTRY_DSN` is set; **without `RCLONE_REMOTE` it logs a loud
warning every cycle — treat that as "not backed up"** (losing the VM loses
on-VM backups with it).

Restore drill (do one before trusting the setup):

```sh
docker compose --env-file .env.prod -f docker-compose.prod.yml exec postgres sh -c \
  'gunzip -c /dev/stdin | psql -U postgres taakify' \
  < <(docker run --rm -v taakify-prod_taakify_backups:/backups alpine cat /backups/taakify_<DATE>.sql.gz)
```

(Or copy the dump off the volume first — the shape of the command matters
more than the exact plumbing: `gunzip -c dump.sql.gz | psql` into the
`postgres` container.)

## Updating

```sh
git pull
docker compose --env-file .env.prod -f docker-compose.prod.yml build
docker compose --env-file .env.prod -f docker-compose.prod.yml run --rm migrate
docker compose --env-file .env.prod -f docker-compose.prod.yml up -d
```

(That middle line is just the migrate command from step 4.) `pnpm audit` in
both workspaces is a standing pre-deploy step per spec §5. Cloudflared
follows the image it was started with — recreate it after image bumps:
`... --profile tunnel up -d --force-recreate cloudflared`.

## Troubleshooting

- `api` unhealthy → `logs api`; the two startup refusals by design are a
  missing `BETTER_AUTH_SECRET` and an unreachable Postgres.
- Sync broken but the app loads → check the `/api/` path rule is **above**
  the catch-all in the tunnel config (step 6), then `logs electric`.
- Signup/sign-in 500s → `logs postgres`, and confirm migrations ran (step 4)
  — better-auth's tables come from the migration set.
- Container crash-looping → `docker compose ... ps` shows `Restarting`;
  `logs <service>` for the reason; `restart: unless-stopped` keeps trying.
