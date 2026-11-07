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
COPY --chown=node:node package.json pnpm-workspace.yaml next.config.ts prisma.config.ts tsconfig.json sources.config.ts ./
COPY --chown=node:node prisma ./prisma
# Ingestion runs in the container too: `docker compose run --rm app pnpm ingest`.
COPY --chown=node:node lib ./lib
COPY --chown=node:node scripts ./scripts
# Before every `pnpm run`, pnpm 12 fetches registry metadata for the "packageManager" version and
# re-verifies node_modules (which, holding prod deps only, looks out of date): ~95s of network calls
# per command. The image has a fixed pnpm and fixed deps, so turn both off here (image only).
RUN node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync('package.json'));delete p.packageManager;fs.writeFileSync('package.json',JSON.stringify(p,null,2))" \
 && printf '\nverifyDepsBeforeRun: false\n' >> pnpm-workspace.yaml
# .cache/ is bind-mounted from the host in docker-compose.yml; when run without a mount, the
# non-root user still needs to be able to create it.
RUN mkdir -p /app/.cache && chown node:node /app /app/.cache
USER node
EXPOSE 3000
# Apply pending migrations, then start the server. Binaries are called directly (not via pnpm):
# pnpm 12 tries to write a lockfile at startup, which the non-root user can't do.
CMD ["sh", "-c", "node_modules/.bin/prisma migrate deploy && exec node_modules/.bin/next start"]
