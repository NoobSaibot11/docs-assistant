# Docs Assistant

Ask questions about the official **React Native, Next.js, Angular and Jest** docs and get a
streamed, Markdown answer that cites the exact doc sections it used.

> Work in progress: Phase 0 (project setup) is done. See [SPEC.md](SPEC.md) for the full plan.

## Run it

Requirements: Docker. For local development, also Node 24+ and pnpm.

```bash
cp .env.example .env      # add ANTHROPIC_API_KEY and VOYAGE_API_KEY (not needed yet)
docker compose up --build
```

The app starts on http://localhost:3000 and applies database migrations on boot. Health check:
http://localhost:3000/api/health.

If ports 5432 or 3000 are already in use, set `DB_PORT` / `APP_PORT` in `.env` (and keep the
port in `DATABASE_URL` in sync with `DB_PORT`).

## Develop

```bash
pnpm install
docker compose up -d db
pnpm db:deploy
pnpm dev
```

Checks: `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test`.

## Stack

Next.js (App Router) + TypeScript, PostgreSQL 16 + pgvector, Prisma 7, Claude API, Voyage AI
embeddings, Tailwind CSS, Vitest, Docker Compose, GitHub Actions.

## Attribution

Documentation content belongs to its respective projects and is used under their licenses
(details added with ingestion in Phase 1).
