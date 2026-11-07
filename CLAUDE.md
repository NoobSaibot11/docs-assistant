# CLAUDE.md

Framework Docs Assistant: cited, streaming answers over the React Native, Next.js, Angular and
Jest docs. Full spec in `SPEC.md`; build plan is phased (see "Build plan" there).

## How to work

- Work one phase at a time. Before coding a phase, list the files you'll create or change and wait for approval.
- After each phase, run typecheck, lint and tests, and report the acceptance criteria as met or not met.
- Check current package APIs (Anthropic SDK, Voyage, pgvector, Next.js, Prisma) in their official docs rather than from memory; versions change.
- Don't add a dependency without saying why. No LangChain, LlamaIndex or vector-DB SaaS.

## Code rules

- TypeScript strict; no `any`. Zod at every boundary (env, request bodies, eval files).
- All raw SQL in `lib/retrieval/` using Prisma's tagged-template `$queryRaw`; never build SQL with string concatenation or `$queryRawUnsafe`. (Exception: the `SELECT 1` ping in `lib/db.ts`.)
- API keys only on the server. The Claude and Voyage clients are created in `lib/` and never imported into Client Components. Server-only modules start with `import "server-only"`.
- Read env through `getEnv()` / `requireKey()` from `lib/env.ts`, never `process.env` directly (except `prisma.config.ts`).
- Model name, chunk size, top-k and thresholds come from config or env, not hard-coded in several places.
- The system prompt lives in `lib/llm/prompts.ts`. It tells Claude to answer only from the numbered context, cite with [n], and say it couldn't find the answer when the context doesn't cover it.
- Tests must not call real APIs; mock the clients. Only `pnpm eval` uses real keys.
- Small, focused commits with clear messages.

## Commands

```bash
pnpm dev               # Next dev server (needs the db: docker compose up -d db)
pnpm typecheck         # tsc --noEmit
pnpm lint              # eslint
pnpm format            # prettier --write
pnpm test              # vitest run: unit + integration (integration needs TEST_DATABASE_URL)
pnpm test:unit         # unit tests only (no database)
pnpm test:integration  # real Postgres; creates + migrates the test db automatically
pnpm ingest            # fetch, chunk, embed, store (needs VOYAGE_API_KEY)
pnpm ingest --framework jest --dry-run   # chunk only: counts, est. tokens, removed JSX
pnpm db:migrate        # prisma migrate dev (create + apply a migration)
pnpm db:deploy         # prisma migrate deploy (apply only)
pnpm db:generate       # regenerate the Prisma client into generated/prisma
docker compose up      # db + app (app runs migrate deploy, then next start)
```

## Stack notes (verified Nov 2026)

- **Prisma 7**: uses `prisma.config.ts` for the CLI connection URL and a driver adapter
  (`@prisma/adapter-pg`) at runtime. The client is generated to `generated/prisma` and imported
  from `@/generated/prisma/client`. Use `getDb()` from `lib/db.ts`.
- **Raw-SQL schema objects**: the init migration creates the `vector` extension, the generated
  `Chunk.tsv` column, a GIN index on `tsv` and an HNSW (`vector_cosine_ops`) index on `embedding`.
  `schema.prisma` mirrors `tsv` and both indexes so `prisma migrate dev` doesn't generate DROPs.
  Don't remove those declarations. After any schema change, run
  `pnpm prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script`
  and make sure it doesn't touch them (CI enforces this with `--exit-code`).
- **Embeddings**: `voyage-4`, 1024 dimensions. If the model or dimension changes, the column type
  and the HNSW index must change in a new migration.
- **Versions held back on purpose**: TypeScript 6.0 (typescript-eslint doesn't support TS 7 yet),
  ESLint 9 (eslint-plugin-react/import/jsx-a11y don't support ESLint 10 yet).
- **pnpm 12** blocks dependency build scripts by default; allowed ones are listed under
  `allowBuilds` in `pnpm-workspace.yaml`.
- **Scripts** run with `tsx --conditions=react-server` so `import "server-only"` resolves to a
  no-op outside Next.js. Vitest aliases `server-only` to `tests/stubs/server-only.ts`.

## Ingestion (Phase 1)

- Sources and their pinned refs live in `sources.config.ts`. Files are listed with one GitHub
  trees API call per source and downloaded from raw.githubusercontent.com into `.cache/docs/`
  (gitignored; bind-mounted into the app container, so host and container share it). Pinned refs
  never change, so the cache never expires. Requests time out after 30s and retry 5 times.
- On this dev machine, Docker Desktop's outbound network is intermittently flaky (requests from
  containers stall; the host is fine). Prefer `pnpm ingest` on the host, or let the host fill
  `.cache/` first. The runtime image also disables pnpm's per-run registry/deps checks (see the
  Dockerfile), which otherwise added ~95s to every `pnpm` command in the container.
- `lib/ingest/mdx-clean.ts` works on the mdast syntax tree, never regexes on raw files (Jest docs
  have `import` lines inside code blocks). Add component names to `DROP_JSX` / `REPLACE_JSX`
  there; the `--dry-run` report lists every JSX component it removed.
- Chunks: split at h1–h3, small sections absorb their own sub-sections only (never siblings, so
  anchors stay correct), 300–500 tokens with ~50-token prose overlap (constants in
  `lib/config.ts`). Tokens are estimated from length (`lib/ingest/tokens.ts`).
- **Bump `CHUNKER_VERSION`** in `lib/config.ts` whenever cleaning or chunking output changes;
  it's part of the content hash, so the next ingest re-embeds everything.
- Fixtures in `tests/fixtures/` are hand-written imitations of each docs format (not copies of
  the real docs) and are excluded from Prettier.
- **Ports**: compose host ports are `DB_PORT` (default 5432) and `APP_PORT` (default 3000).
  On this dev machine they're 5434 and 3001 (5432, 5433 and 3000 are used by other projects).
