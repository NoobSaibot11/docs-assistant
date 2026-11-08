# Docs Assistant

Ask questions about the official **React Native, Next.js, Angular and Jest** docs and get a
streamed, Markdown answer that cites the exact doc sections it used.

> Work in progress: Phases 1–4 (ingestion, retrieval, chat API, chat UI) are done. See [SPEC.md](SPEC.md) for the full plan.

## Run it

Requirements: Docker. For local development, also Node 24+ and pnpm.

```bash
cp .env.example .env      # add VOYAGE_API_KEY (and ANTHROPIC_API_KEY, used from Phase 3)
docker compose up --build
docker compose run --rm app pnpm ingest
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

Checks: `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test`, `pnpm test:e2e`
(Playwright; run `pnpm exec playwright install chromium` once).

## Ingestion

`pnpm ingest` downloads each framework's docs at a pinned version, strips MDX/JSX and
frontmatter, splits pages by heading into ~300–500-token chunks (keeping the heading path and
anchor for citations), embeds them with Voyage (`voyage-4`, 1024 dimensions) and stores them in
Postgres with pgvector. Re-running it skips files whose content hasn't changed.

```bash
pnpm ingest --framework nextjs --dry-run   # chunk only; prints counts and estimated tokens
pnpm ingest --framework nextjs --framework jest
```

| Framework    | Docs source                                                        | Version |
| ------------ | ------------------------------------------------------------------ | ------- |
| Next.js      | `vercel/next.js` `docs/01-app`, `docs/03-architecture`             | 16.4.5  |
| Jest         | `jestjs/jest` `website/versioned_docs/version-30.5`                | 30.5    |
| React Native | `react/react-native-website` `website/versioned_docs/version-0.88` | 0.88    |
| Angular      | `angular/angular` `adev/src/content`                               | 22.2.5  |

React Native and Angular are configured and will be ingested in Phase 5.

## Retrieval

Three modes, each with an optional framework filter:

- **vector**: cosine similarity on the Voyage embeddings (HNSW index).
- **keyword**: Postgres full-text search (`ts_rank` over a generated `tsvector` column).
- **hybrid** (default): both, fused with Reciprocal Rank Fusion (k = 60) over the top 20 of each.

```bash
pnpm run search "How do I revalidate data every 60 seconds?" --mode hybrid --framework nextjs
```

(`pnpm run search`, not `pnpm search`, which is pnpm's own registry search.)

## Chat UI

Open http://localhost:3000 and ask a question. Answers stream in as Markdown with highlighted
code blocks (with a copy button). Each [n] marker opens the cited section's title, heading path
and excerpt with a link to the official docs, and a Sources list follows each answer. The filter
limits a question to one framework; with **All**, frameworks are detected from the question.
Stop cancels an answer mid-stream (and the Claude request behind it); Retry resends it.

## Chat API

`POST /api/chat` takes `{ question, history?, frameworks? }` and streams NDJSON:

```bash
curl -N -X POST http://localhost:3000/api/chat   -H 'content-type: application/json'   -d '{"question":"How do I revalidate fetched data every 60 seconds?"}'
```

```text
{"type":"meta","question":"…","frameworks":["nextjs"],"frameworksSource":"detected","sources":[{"n":1,…}]}
{"type":"text","text":"Set "}
{"type":"text","text":"`next: { revalidate: 60 }` [1] …"}
{"type":"done","answered":true,"outcome":"answered","citations":[{"n":1,"chunkId":"…","url":"…"}],"usage":{…},"topSimilarity":0.54}
```

1. With history, a fast Claude model (`claude-haiku-5-5`) rewrites the question to stand alone
   and tags its frameworks (unless the request sets `frameworks`).
2. Hybrid retrieval picks the top 5 chunks. If the best cosine similarity is under
   `NOT_FOUND_THRESHOLD`, the answer is "I couldn't find this in the docs." and Claude isn't called.
3. Otherwise `claude-sonnet-5-5` answers from the numbered chunks only, citing them as [1]–[5].
4. The final event maps each cited marker to its chunk and docs URL and reports token usage.
   Every request is logged to `QueryLog` (latency, tokens, top score, outcome). Closing the
   connection aborts the Claude request.

## Evaluation

68 questions (`eval/questions.json`: 15+ per framework, 5 of them cross-framework, plus 10 the
docs don't cover; drafted by Claude from the pinned docs and machine-checked, see
[eval/README.md](eval/README.md)) are run through the real pipeline in each retrieval mode and scored for retrieval
(hit@5, MRR, framework accuracy), answers (must-mention facts, faithfulness graded claim by claim
by a stronger Claude model, refusal accuracy), latency and cost. See [eval/README.md](eval/README.md).

<!-- eval-results:start -->

_No eval run yet._

<!-- eval-results:end -->

## Stack

Next.js (App Router) + TypeScript, PostgreSQL 16 + pgvector, Prisma 7, Claude API, Voyage AI
embeddings, Tailwind CSS, Vitest, Docker Compose, GitHub Actions.

## Attribution

Documentation content belongs to its respective projects. Next.js, Jest and Angular docs are
MIT-licensed; React Native docs are licensed under
[CC BY 4.0](https://github.com/react/react-native-website/blob/main/LICENSE-docs). The app's
footer credits each source with a link to its license. Doc files are downloaded at ingest time
and are not committed to this repository.
