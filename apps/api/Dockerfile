# Runs the API exactly as dev does (tsx, no compile step) -- see
# docs/superpowers/plans/2026-09-10-taakify-prod-infra.md, "Resolved open
# question": @taakify/shared is consumed as raw TS source, so a tsc build
# would need build config for two packages to gain nothing at this scale.
FROM node:24-alpine
WORKDIR /app

RUN corepack enable

# Manifests first for layer caching: root + every workspace member (web's
# manifest is needed so the filtered install can resolve the workspace graph
# without copying web's sources).
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/

# Prod-only install: the runtime image carries just the api + shared
# dependency closures (tsx lives in dependencies -- it IS the runtime, see
# the plan's "Resolved open question"). Test tooling stays out via --prod
# plus the workspace's autoInstallPeers=false (see pnpm-workspace.yaml).
RUN pnpm install --frozen-lockfile --filter @taakify/api... --prod

COPY apps/api apps/api
COPY packages/shared packages/shared

ENV NODE_ENV=production
EXPOSE 3001
CMD ["pnpm", "--filter", "@taakify/api", "start"]
