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

Latest run: 2026-11-08 (commit `7378a95`), 68 questions, top-5, not-found threshold 0.4. Answers: `claude-sonnet-5-5` (effort low); judge: `claude-opus-5-5`; embeddings: `voyage-4`.

| Mode              | Hit@5 | MRR   | Framework acc. | Must-mention | Faithfulness | Refusal acc. | TTFT p50 | TTFT p95 | Cost / question |
| ----------------- | ----- | ----- | -------------- | ------------ | ------------ | ------------ | -------- | -------- | --------------- |
| vector            | 91.4% | 0.754 | 93.1%          | 95.7%        | 99.6%        | 100.0%       | 2.0 s    | 3.1 s    | $0.0093         |
| vector + rerank-3 | 98.3% | 0.868 | 93.8%          | 100.0%       | —            | 100.0%       | 2.5 s    | 3.8 s    | $0.0102         |
| keyword           | 67.2% | 0.427 | 88.6%          | 71.6%        | —            | 91.2%        | 1.9 s    | 3.6 s    | $0.0077         |
| hybrid            | 91.4% | 0.736 | 92.4%          | 93.1%        | —            | 100.0%       | 1.9 s    | 3.1 s    | $0.0092         |

Hit@5 by framework:

| Mode              | React Native | Next.js | Angular | Jest   |
| ----------------- | ------------ | ------- | ------- | ------ |
| vector            | 87.5%        | 93.3%   | 93.3%   | 93.3%  |
| vector + rerank-3 | 100.0%       | 100.0%  | 93.3%   | 100.0% |
| keyword           | 75.0%        | 73.3%   | 46.7%   | 80.0%  |
| hybrid            | 81.3%        | 93.3%   | 93.3%   | 100.0% |

<!-- eval-results:end -->

What the eval changed (retrieval-only runs and a threshold sweep, then the full run above):

- **Vector is the default mode, not hybrid.** With plain Reciprocal Rank Fusion (equal weights),
  hybrid found the right page for 84.5% of questions against vector's 93.1%: keyword search is
  weak on everyday phrasing, and chunks that both lists half-agreed on pushed vector's best hits
  out of the top 5. Weighting keyword results down (`HYBRID_KEYWORD_WEIGHT`: 0.5 → 86.2%,
  0.25 → 86.2%, 0.1 → 89.7%) closes most of the gap; at 0.1 hybrid ties vector on hit@5 but
  still trails on MRR and must-mention.
- **A reranker made the biggest difference.** Retrieving the top 20 by vector similarity and
  letting Voyage `rerank-3` pick the best 5 raised hit@5 from 93.1% to 98.3% (React Native
  87.5% → 100%), MRR from 0.774 to 0.868 and must-mention from 95.7% to 100%, for about 0.5 s
  more before the first token and $0.001 more per question. It's on by default
  (`RERANK_MODEL=none` turns it off); `rerank-3-lite` scored the same but wasn't faster here.
- **The not-found threshold is a pre-filter, not the refusal mechanism.** With the threshold at
  0, Claude alone answered all 58 answerable questions and refused all 10 off-topic ones.
  Similarity can't separate the two groups (off-topic questions scored 0.35–0.67, answerable ones
  0.44–0.80), so the threshold is set to 0.40, just under the lowest answerable score: obvious
  off-topic questions skip the answer call, and no answerable one is lost.
- Faithfulness (99.6%) was graded by `claude-opus-5-5` on the default mode only, to keep the run
  cheap. A full tuning pass (retrieval sweeps, threshold sweep, final three-mode run) cost about $4.

## Stack

Next.js (App Router) + TypeScript, PostgreSQL 16 + pgvector, Prisma 7, Claude API, Voyage AI
embeddings, Tailwind CSS, Vitest, Docker Compose, GitHub Actions.

## Attribution

Documentation content belongs to its respective projects. Next.js, Jest and Angular docs are
MIT-licensed; React Native docs are licensed under
[CC BY 4.0](https://github.com/react/react-native-website/blob/main/LICENSE-docs). The app's
footer credits each source with a link to its license. Doc files are downloaded at ingest time
and are not committed to this repository.
