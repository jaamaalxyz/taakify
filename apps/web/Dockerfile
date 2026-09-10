FROM node:24-alpine AS build
WORKDIR /app

RUN corepack enable

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/

# Build needs devDeps (tsc, vite) for web and its workspace dep shared.
RUN pnpm install --frozen-lockfile --filter @taakify/web... --filter @taakify/shared...

COPY apps/web apps/web
COPY packages/shared packages/shared

# package.json build = tsc --noEmit && vite build -- the typecheck is part of
# the image build, matching this repo's no-CI convention.
RUN pnpm --filter @taakify/web build

FROM nginx:1.27-alpine
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
