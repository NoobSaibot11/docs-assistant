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
pnpm dev:webpack       # same, with webpack + WASM SWC (use on this machine; see Chat UI notes)
pnpm typecheck         # tsc --noEmit
pnpm lint              # eslint
pnpm format            # prettier --write
pnpm test              # vitest run: unit + integration (integration needs TEST_DATABASE_URL)
pnpm test:unit         # unit tests only (no database)
pnpm test:integration  # real Postgres; creates + migrates the test db automatically
pnpm test:e2e          # Playwright smoke tests (fakes /api/chat; starts its own server on :3100)
pnpm ingest            # fetch, chunk, embed, store (needs VOYAGE_API_KEY)
pnpm ingest --framework jest --dry-run   # chunk only: counts, est. tokens, removed JSX
pnpm run search "question" --mode hybrid --framework jest   # top chunks with scores (`run` is required: `pnpm search` is pnpm's registry search)
pnpm db:migrate        # prisma migrate dev (create + apply a migration)
pnpm db:deploy         # prisma migrate deploy (apply only)
pnpm db:generate       # regenerate the Prisma client into generated/prisma
docker compose up      # db + app (app runs migrate deploy, then next start)
curl -N -X POST localhost:3001/api/chat -H 'content-type: application/json' -d '{"question":"How do I mock timers?"}'
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

## Retrieval (Phase 2)

- `lib/retrieval/search.ts` is the entry point: `search({db, embedder}, {question, mode, frameworks})`.
  Modes live in `vector.ts`, `keyword.ts` and `hybrid.ts` (RRF in `rrf.ts`); constants (`topK`,
  `candidates`, `rrfK`, `efSearch`) in `RETRIEVAL` in `lib/config.ts`.
- Questions are embedded with Voyage input type `query` (documents use `document`).
- Every mode returns cosine `similarity` per chunk, and `topSimilarity` is what the "not found"
  threshold compares against. Mode scores (cosine, ts_rank, RRF sum) aren't comparable.
- Vector queries set `hnsw.ef_search` and `hnsw.iterative_scan = relaxed_order` with
  `set_config(..., true)` inside a transaction, so framework-filtered queries still fill the
  limit; the outer query re-sorts by exact distance. Small filtered sets may use the framework
  index plus an exact sort instead, which is also correct.
- Keyword search ORs the question's lexemes (`plainto_tsquery` output with `&` → `|`), because
  ANDing every word of a natural-language question matches almost nothing.
- Tests use `tests/helpers/fake-embedder.ts` (hashed bag-of-words, so similar text gets similar
  vectors) and `tests/helpers/test-db.ts` (fixture sources, test db URL).

## Chat API (Phase 3)

- `POST /api/chat` (`app/api/chat/route.ts`) is a thin wrapper: Zod-validates the body, builds
  the real clients once, and returns `runChat()` from `lib/chat/pipeline.ts`. Route files may only
  export handlers and route config (no test hooks); tests use `vi.resetModules()` instead.
- Wire format lives in `lib/chat/protocol.ts` (shared with the UI): NDJSON events
  `meta → text* → done`, or `error` last on failure. No error event after a user abort.
- Pipeline dependencies (`rewriter`, `search`, `answerModel`, `logQuery`) are interfaces, so unit
  tests use plain fakes. The route test mocks only `getAnthropic` and `createVoyageQueryEmbedder`.
- Rewrite + framework tagging uses `CLAUDE_FAST_MODEL` with structured output (`messages.parse` +
  `zodOutputFormat`); any failure falls back to the original question and all frameworks. It's
  skipped when the user picked a framework and there's no history.
- The answer uses `CLAUDE_MODEL` via `client.beta.messages.stream` with `CLAUDE_EFFORT` and the
  `fallbacks: "default"` refusal fallback (beta `server-side-fallback-2026-07-01`). Don't send
  `thinking: {type: "disabled"}`, `budget_tokens` or sampling params: Sonnet 5.5 rejects them.
- "Not found" = `topSimilarity < NOT_FOUND_THRESHOLD` (no Claude call), or the answer starts with
  `NOT_FOUND_ANSWER`. Citations are only markers that appear in the answer outside code.
- Every request writes one `QueryLog` row (`outcome`: answered | not_found | aborted | error).
- On this machine, Windows Application Control blocks Next's native SWC binary, so `pnpm build`
  fails locally; build in Docker (`docker compose build app`) or CI instead.

## Chat UI (Phase 4)

- `app/page.tsx` renders `components/chat/chat.tsx` (client). State lives in `use-chat.ts`:
  turns of question → answer, streamed via `readChatEvents` (`lib/chat/read-stream.ts`), with
  text deltas applied once per animation frame. Stop aborts the fetch; Retry resends the last
  turn's exact request; history = completed turns only.
- `StreamingMarkdown` = react-markdown + remark-gfm + `remarkCitations` + rehype-highlight
  (only the languages registered there). `skipHtml` is on: never render model HTML. Only absolute
  http(s) links stay clickable (chunks contain repo-relative links like `ManualMocks.md`).
- Citation markers: `lib/citations/remark-citations.ts` turns `[n]` in prose (not code or link
  text) into `<sup data-citation>`, rendered by `CitationMarker` with a portal popover. Keep it
  consistent with `citedNumbers` in `parse.ts`. Tailwind's preflight gives `sup` `line-height: 0`,
  so the marker button needs an explicit line height (otherwise it has zero height).
- Popover excerpts are plain text (`lib/citations/excerpt.ts`), made on the server in `toSources`.
- Styles for answer Markdown and highlight.js tokens are hand-written in `app/globals.css`.
- E2E tests fake `/api/chat` with `page.route` and NDJSON fixtures; no keys or database needed.
  Next 16 allows only one `next dev` per project directory, so stop other dev servers first.
- `next dev` writes `AGENTS.md`; it's committed so the tree stays clean.
- On this machine Windows Application Control blocks Next's native SWC binary: `pnpm dev` and
  `pnpm build` fail locally. Use `pnpm dev:webpack`, and build in Docker or CI.
