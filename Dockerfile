# syntax=docker/dockerfile:1.7

FROM node:22-alpine AS base
WORKDIR /app
RUN corepack enable pnpm

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm run build

FROM node:22-alpine AS runner
WORKDIR /app

# poppler-utils provides pdftoppm, used by /api/zvg-thumb to render PDF previews.
# wget is used by the healthcheck.
RUN apk add --no-cache poppler-utils wget

ENV NODE_ENV=production \
    NITRO_HOST=0.0.0.0 \
    NITRO_PORT=3000

# Nitro's node-server preset bundles all runtime deps into .output, so the
# runner stage doesn't need node_modules or pnpm.
COPY --from=builder /app/.output ./.output

# Cache directory — mount as a named volume in compose to persist across
# restarts. process.cwd() is /app at runtime, matching the paths in
# server/utils/geocode.ts and server/api/zvg-thumb.get.ts.
RUN mkdir -p /app/.cache_zvg/geocode /app/.cache_zvg/thumbs \
    && chown -R node:node /app

USER node
EXPOSE 3000

# Verifies BOTH the API layer (/api/regions) and the server-rendered homepage
# (/). The homepage check exists because a broken SSR render — like the i18n
# regression that 500'd only "/" — left the old /api-only healthcheck reporting
# "healthy" while the site was actually down. Timeout is generous: "/" does a
# full SSR render.
HEALTHCHECK --interval=30s --timeout=15s --start-period=40s --retries=3 \
    CMD wget -qO- http://localhost:3000/api/regions > /dev/null 2>&1 \
        && wget -qO- http://localhost:3000/ > /dev/null 2>&1 || exit 1

CMD ["node", ".output/server/index.mjs"]
