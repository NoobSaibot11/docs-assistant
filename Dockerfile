# syntax=docker/dockerfile:1

# ---- base: Node + pnpm (Node 25+ no longer ships corepack) ----
FROM node:26-slim AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    NEXT_TELEMETRY_DISABLED=1 \
    CI=true
RUN npm install -g pnpm@12.16.1
WORKDIR /app

# ---- deps: full install (dev deps needed for the build) ----
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml prisma.config.ts ./
COPY prisma ./prisma
RUN pnpm install --frozen-lockfile

# ---- build ----
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm db:generate && pnpm build

# ---- prod-deps: runtime-only node_modules (includes the Prisma CLI for migrate deploy) ----
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml prisma.config.ts ./
COPY prisma ./prisma
RUN pnpm install --frozen-lockfile --prod

# ---- runner ----
FROM base AS runner
ENV NODE_ENV=production \
    PORT=3000
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/.next ./.next
COPY --from=build --chown=node:node /app/generated ./generated
COPY --chown=node:node package.json next.config.ts prisma.config.ts ./
COPY --chown=node:node prisma ./prisma
USER node
EXPOSE 3000
# Apply pending migrations, then start the server. Binaries are called directly (not via pnpm):
# pnpm 12 tries to write a lockfile at startup, which the non-root user can't do.
CMD ["sh", "-c", "node_modules/.bin/prisma migrate deploy && exec node_modules/.bin/next start"]
