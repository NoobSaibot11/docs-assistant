# Framework Docs Assistant — Project Spec

Nov 5, 2026 · @Majahar

## Overview

A web app that answers questions about the official docs for React Native, Next.js, Angular and Jest, streams answers from the Claude API as Markdown, and cites the exact doc sections it used. It is a personal portfolio project built from scratch, with a measured evaluation suite as its main differentiator.

**Who it's for:** developers working across the JavaScript and TypeScript ecosystem who want a direct, cited answer instead of searching through pages.

**Example questions:** "How do I revalidate a fetch request every 60 seconds?" (Next.js), "How do I handle the Android back button?" (React Native), "When should I use a signal instead of an observable?" (Angular), "How do I mock a module?" (Jest), "How do I test a Next.js page component with Jest?" (Next.js + Jest).

**Goals**

- Answers stream token by token, render as Markdown (code blocks with syntax highlighting), and cite their sources as clickable \[1\] \[2\] markers.
- The app says "I couldn't find this in the docs" when retrieval is weak, instead of guessing, and keeps frameworks apart (a React Native navigation question doesn't get Next.js routing docs).
- Retrieval and answer quality are measured with a fixed eval set, and the numbers are reported in the README.
- Anyone can clone the repo and run it with one `docker compose up` plus API keys.

**Non-goals (for v1)**

- User accounts and login
- Several versions of the same framework (one pinned version per framework)
- Fine-tuning or training any model
- LangChain, LlamaIndex or similar frameworks: retrieval is written by hand so every step can be explained in an interview

**Source documents:** the official docs of all four frameworks, listed below. Most live as Markdown or MDX in public GitHub repos; for example, the Next.js docs are in the `docs/` folder of the public `vercel/next.js` GitHub repo. Pin one release tag per framework (for example a Next.js 15.x or 16.x tag) so answers and eval questions don't drift. Check each repo's license before committing any doc files; if unsure, have the ingestion script download them at a pinned tag instead of committing them.

| Framework | Docs repo (verify path at setup) | Public site for citations | Notes |
| --- | --- | --- | --- |
| React Native | `facebook/react-native-website` | reactnative.dev | Versioned docs folders; pick one version |
| Next.js | `vercel/next.js` (`docs/`) | nextjs.org | MDX |
| Angular | `angular/angular` (`adev/` content) | angular.dev | Modern Angular, not AngularJS 1.x |
| Jest | `jestjs/jest` (website docs) | jestjs.io | Versioned docs; pick one version |

Each entry lives in `sources.config.ts` (repo, path, tag, file glob, base URL, framework id). Licenses differ between these repos, so check each one and show attribution in the app's footer where required.

## Tech stack

One Next.js app plus PostgreSQL, so the whole thing runs in two containers. Use the latest stable version of each package at setup time.

| Layer | Choice | Why |
| --- | --- | --- |
| Framework | Next.js (App Router) + TypeScript (strict) | Streaming route handlers, Server and Client Components |
| LLM | Claude API via `@anthropic-ai/sdk`, model `claude-sonnet-5-5` | Streaming, prompt caching; model name kept in one config constant |
| Embeddings | Voyage AI (`voyageai` package) | Claude has no embeddings endpoint; Voyage is the provider Anthropic's docs recommend. Pick the current general model and dimension from Voyage's docs. |
| Database | PostgreSQL 16 + `pgvector` extension | Vector and full-text search in one database |
| ORM | Prisma | Schema and migrations; similarity search via `$queryRaw` because Prisma has no native vector type |
| Server state | TanStack Query | Fetching document list and ingestion status |
| Markdown | `react-markdown` + `remark-gfm` + a syntax highlighter (e.g. `shiki`) | Safe rendering of streamed Markdown and code blocks |
| Validation | Zod | Request bodies, env vars, LLM output parsing |
| Tests | Vitest (unit + integration against real Postgres), Playwright (one E2E smoke test) | Same tools as the e-commerce project, plus E2E |
| DevOps | Docker Compose, GitHub Actions | One-command local run; CI on every PR |
| Styling | Tailwind CSS | Fast, no component library needed |

Use the official `pgvector/pgvector` Docker image so the extension is already installed.

## Architecture and workflow

There are two pipelines: ingestion runs once per docs version and fills PostgreSQL; the query pipeline runs on every question and streams a cited answer back.

&#91;embedded content: architecture · ingestion and query pipelines\]

**Ingestion pipeline** (`pnpm ingest`)

1. For each entry in the sources config, read that framework's Markdown/MDX files at its pinned tag.
2. Strip frontmatter and JSX components; keep headings, prose and code blocks.
3. Split by heading, then into 300–500-token chunks with overlap. Record each chunk's framework, heading path, anchor and public docs URL.
4. Embed chunks in batches with Voyage (input type "document").
5. Upsert Document and Chunk rows; the full-text `tsv` column fills itself.

**Query pipeline** (`POST /api/chat`)

1. The browser sends the question plus the last few turns.
2. If there is history, a fast Claude model (e.g. `claude-haiku-5-5`) rewrites it as a standalone question. The same call (made even without history) tags which frameworks the question is about, unless the user picked one in the filter.
3. Embed the question (input type "query"), run vector and keyword search filtered to those frameworks, fuse with Reciprocal Rank Fusion, and keep the top 5 chunks.
4. If the top score is under the threshold, return "not found" without generating an answer.
5. Build the prompt: system rules, chunks numbered \[1\]–\[5\], then the question. Stream the answer from Claude.
6. The server forwards text as it arrives, then sends a final event with citations (marker → chunk → URL) and token usage, and writes a QueryLog row.
7. The browser renders the streamed Markdown and turns each \[n\] into a clickable citation.

## Data model

Five tables: documents, their chunks (with embeddings), conversations, messages, and a query log for latency and cost. Embedding dimension must match the chosen Voyage model. Every document and chunk carries a framework id so retrieval can filter by it.

```prisma
model Document {
  id          String   @id @default(cuid())
  framework   String              // "react-native" | "nextjs" | "angular" | "jest"
  sourcePath  String              // path inside that framework's docs repo
  title       String
  url         String              // public docs URL for the citation link
  docsVersion String              // pinned tag for that framework
  contentHash String              // skip re-embedding unchanged files
  chunks      Chunk[]
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  @@unique([framework, sourcePath])
}

model Chunk {
  id          String   @id @default(cuid())
  documentId  String
  document    Document @relation(fields: [documentId], references: [id], onDelete: Cascade)
  framework   String              // copied from Document for fast filtering
  ordinal     Int                 // position within the document
  headingPath String              // "Caching > Data Cache > Revalidating"
  anchor      String?             // #revalidating, for deep links
  content     String
  tokenCount  Int
  embedding   Unsupported("vector(1024)")?
  // tsv column added in a raw SQL migration (see below)
  @@unique([documentId, ordinal])
  @@index([framework])
}

model Conversation {
  id        String    @id @default(cuid())
  messages  Message[]
  createdAt DateTime  @default(now())
}

model Message {
  id             String       @id @default(cuid())
  conversationId String
  conversation   Conversation @relation(fields: [conversationId], references: [id], onDelete: Cascade)
  role           String       // "user" | "assistant"
  content        String
  citations      Json?        // [{ n: 1, chunkId, url, headingPath }]
  createdAt      DateTime     @default(now())
}

model QueryLog {
  id               String   @id @default(cuid())
  question         String
  retrievalMode    String   // "vector" | "keyword" | "hybrid"
  frameworks       String[] // selected by the user or detected
  topChunkIds      String[]
  topScore         Float
  answered         Boolean  // false when the "not found" path was taken
  ttftMs           Int      // time to first token
  totalMs          Int
  inputTokens      Int
  outputTokens     Int
  cacheReadTokens  Int
  createdAt        DateTime @default(now())
}
```

**Raw SQL migration** (Prisma can't express these, so add them in a migration file by hand):

- `CREATE EXTENSION IF NOT EXISTS vector;`
- A generated full-text column: `ALTER TABLE "Chunk" ADD COLUMN tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', "headingPath" || ' ' || content)) STORED;`
- A GIN index on `tsv` and an HNSW index on `embedding` using `vector_cosine_ops`.

All vector and full-text queries live in one module (`lib/retrieval/`) using `$queryRaw` with tagged templates, never string concatenation.

## Features

The MVP is a working, cited, streaming chat over the pinned docs. Stretch features come only after the eval suite is in CI.

**MVP**

1. **Ingestion CLI** (`pnpm ingest`): reads each framework's Markdown/MDX files as listed in the sources config, strips JSX components and frontmatter, splits by headings, then into chunks of about 300–500 tokens with \~50 tokens of overlap. Keeps the heading path and anchor on each chunk. Skips files whose content hash is unchanged.
2. **Chat page**: input box, streamed answer, stop button, retry button, clear loading and error states, and a framework filter (All, React Native, Next.js, Angular, Jest). With All selected, the frameworks are detected from the question.
3. **Streaming Markdown rendering**: renders partial Markdown safely while chunks arrive (an unclosed code fence must not break the layout), with syntax-highlighted code blocks and a copy button.
4. **Citations**: answers contain markers like \[1\] and \[2\]. Each marker is clickable and shows the doc title, heading path, a short excerpt, and a framework badge, and a link to the matching page and anchor on the official docs site. A "Sources" list sits under each answer.
5. **"Not found" path**: if the best retrieval score is under a tuned threshold, skip or constrain the model call and answer that the docs don't cover it.
6. **Follow-up questions**: the last few turns are sent with the new question; the retrieval query is rewritten into a standalone question first (one cheap Claude call).
7. **Query logging**: every request writes a QueryLog row (latency, tokens, retrieval mode, top score).

**Stretch (after eval is in CI)**

- **Hybrid search**: combine vector and Postgres full-text results with Reciprocal Rank Fusion, and report the before/after numbers.
- **Reranking**: rerank the top 20 candidates with a reranker model (e.g. Voyage rerank) before taking the top 5.
- **Prompt caching**: cache the system prompt and instructions; record cache-read tokens and the cost difference.
- **Stats page** (`/stats`): p50/p95 time-to-first-token, average cost per query, "not found" rate, from QueryLog.
- **Feedback buttons**: thumbs up/down on each answer, stored for later review.
- **Version switcher**: ingest two docs versions and filter by the selected one.

## Evaluation and testing

The eval suite is the core of the project: about 70 hand-written questions with known answers, scored automatically, with results committed and shown in the README.

**Eval dataset** (`eval/questions.json`), written by you, not generated:

```json
{
  "id": "q017",
  "framework": "nextjs",
  "question": "How do I revalidate fetched data every 60 seconds?",
  "expectedSourcePaths": ["docs/01-app/.../caching.mdx"],
  "mustMention": ["next: { revalidate: 60 }"],
  "answerable": true
}
```

- About 15 answerable questions per framework (60 total), covering each one's core topics, including a few that span two (e.g. testing a Next.js component with Jest).
- About 10 unanswerable questions (e.g. about Remix, plain React hooks, or a made-up API) to test the "not found" path.

**Metrics** (`pnpm eval`)

| Metric | What it measures | How |
| --- | --- | --- |
| Hit rate @5 | Right document appears in the top 5 chunks | Compare retrieved source paths to `expectedSourcePaths` |
| MRR | How high the right document ranks | Mean of 1 / rank of first correct hit |
| Must-mention rate | Answer contains the key fact | String or regex check on `mustMention` |
| Faithfulness | Answer claims are supported by the cited chunks | LLM-as-judge with a fixed rubric, scored 0–1 |
| Refusal accuracy | Unanswerable questions get "not found"; answerable ones don't | Compare `answered` with `answerable` |
| Latency / cost | p50 TTFT, tokens per query | From QueryLog |

Results are also broken down per framework, with a framework-accuracy score (did the top chunks come from the right framework?). Each run writes `eval/results/<date>-<mode>.json` and a summary table to the console. Run it in `vector`, `keyword` and `hybrid` modes to get the comparison numbers for the README.

**Tests**

- **Unit (Vitest):** chunker (heading paths, overlap, MDX stripping), citation parser, streaming Markdown handling of partial input, RRF scoring.
- **Integration (Vitest + real Postgres):** ingest a small fixture corpus of 2 docs per framework, then check that vector, keyword and hybrid queries return expected chunks.
- **API:** chat route with the Claude and Voyage clients mocked; checks the stream format, citations and the "not found" path.
- **E2E (Playwright):** one smoke test that asks a question and sees a streamed answer with at least one citation, against mocked model responses.

**CI rules:** unit, integration and E2E tests run on every PR with mocks (no API keys needed). The full eval needs real API calls, so it runs on a manual workflow trigger or nightly, using repository secrets.

## Repo structure, environment and CI

A single Next.js app with clear folders for ingestion, retrieval, and LLM calls, so each part can be tested on its own.

```text
docs-assistant/
├── app/
│   ├── page.tsx                 # chat UI
│   ├── stats/page.tsx           # stretch: latency/cost dashboard
│   └── api/
│       ├── chat/route.ts        # POST: retrieve + stream answer
│       └── health/route.ts
├── components/
│   ├── chat/                    # MessageList, MessageInput, StreamingMarkdown
│   └── citations/               # CitationMarker, SourcesList, SourcePopover
├── lib/
│   ├── ingest/                  # mdx-clean.ts, chunker.ts, embed.ts
│   ├── retrieval/               # vector.ts, keyword.ts, hybrid.ts (RRF)
│   ├── llm/                     # client.ts, prompts.ts, rewrite-query.ts
│   ├── citations/               # parse [n] markers, map to chunks
│   ├── db.ts                    # Prisma client
│   └── env.ts                   # Zod-validated env vars
├── scripts/
│   ├── ingest.ts                # pnpm ingest
│   └── eval.ts                  # pnpm eval
├── eval/
│   ├── questions.json
│   └── results/
├── prisma/
│   ├── schema.prisma
│   └── migrations/
├── tests/
│   ├── unit/  integration/  e2e/
│   └── fixtures/                # 2 small docs per framework
├── sources.config.ts            # one entry per framework
├── docker-compose.yml
├── Dockerfile
├── .github/workflows/ci.yml
├── .env.example
├── CLAUDE.md
└── README.md
```

**Environment variables** (`.env.example`, validated at startup by `lib/env.ts`)

```bash
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/docs_assistant
ANTHROPIC_API_KEY=
VOYAGE_API_KEY=
CLAUDE_MODEL=claude-sonnet-5-5
INGEST_FRAMEWORKS=all         # or a comma list, e.g. nextjs,jest
RETRIEVAL_MODE=hybrid         # vector | keyword | hybrid
NOT_FOUND_THRESHOLD=0.35      # tune using the eval set
```

**Docker Compose:** two services, `db` (`pgvector/pgvector` image with a volume and healthcheck) and `app` (Next.js production build). `docker compose up` starts both; `docker compose run app pnpm ingest` loads the docs.

**GitHub Actions (`ci.yml`), on every PR:** install, typecheck, lint, Prisma migrate against a Postgres service container, unit + integration tests, Playwright smoke test, production build. A separate `eval.yml` runs the full eval on manual trigger with API keys from secrets.

## Build plan

Seven phases, each ending in a working, committed state. Give Claude Code one phase at a time and check the acceptance criteria before moving on.

**Phase 0: Setup**

- [ ] Next.js + TypeScript strict, Tailwind, ESLint, Prettier, pnpm
- [ ] Docker Compose with Postgres + pgvector; Prisma schema and first migration (including the raw SQL for extension, `tsv` column and indexes)
- [ ] `lib/env.ts` with Zod; `.env.example`; `CLAUDE.md`
- [ ] CI workflow running typecheck, lint and an empty test suite

* Done when: `docker compose up` works and CI is green.

**Phase 1: Ingestion**

- [ ] Sources config for all four frameworks; ingest Next.js and Jest first (strip MDX/JSX and frontmatter)
- [ ] Heading-aware chunker with overlap, heading path and anchor
- [ ] Batch embeddings with Voyage, retries with backoff, content-hash skipping
- [ ] Unit tests for the chunker; integration test on the 5-doc fixture

* Done when: `pnpm ingest` loads the full docs, and re-running it skips unchanged files.

**Phase 2: Retrieval**

- [ ] Vector search (cosine) and keyword search (`ts_rank` on `tsv`)
- [ ] Hybrid with Reciprocal Rank Fusion; every mode accepts a framework filter
- [ ] A `pnpm search "question"` script that prints the top 5 chunks with scores

* Done when: integration tests pass for all three modes.

**Phase 3: Chat API with streaming**

- [ ] `POST /api/chat`: rewrite query and tag frameworks → retrieve → build prompt with numbered chunks → stream from Claude
- [ ] Stream format: text deltas, then a final event with citations and usage (Server-Sent Events or a typed NDJSON stream)
- [ ] "Not found" path below the threshold; QueryLog row on every request
- [ ] Handles client abort (stop button) by aborting the Claude request

* Done when: API tests pass with mocked clients, and a curl request streams a cited answer.

**Phase 4: Chat UI**

- [ ] Message list, input, stop and retry, loading and error states
- [ ] Streaming Markdown component that tolerates partial input; code highlighting with copy button
- [ ] Framework filter; citation markers, popover with excerpt and framework badge, Sources list linking to the official docs
- [ ] Playwright smoke test

* Done when: a real question shows a streamed, cited answer in the browser.

**Phase 5: Evaluation**

- [ ] Ingest React Native and Angular, then write about 70 questions yourself (15 per framework, 10 unanswerable)
- [ ] `pnpm eval` computing all metrics for each retrieval mode, saving JSON results
- [ ] Tune chunk size, top-k and the not-found threshold using the results
- [ ] Manual `eval.yml` workflow

* Done when: README has a results table comparing vector, keyword and hybrid.

**Phase 6: Polish and stretch**

- [ ] Prompt caching, with cost before/after recorded
- [ ] Reranking, `/stats` page, feedback buttons (pick what time allows)
- [ ] README: demo GIF, architecture diagram, eval results, design decisions, how to run
- [ ] Deploy (e.g. Vercel + a hosted Postgres with pgvector such as Neon or Supabase)

* Done when: there's a live link and the README tells the full story.

## Instructions for Claude Code

Save this whole spec as `SPEC.md` in the repo root, and put the rules below in `CLAUDE.md` so they apply to every session.

**How to work**

- Work one phase at a time. Before coding a phase, list the files you'll create or change and wait for approval.
- After each phase, run typecheck, lint and tests, and report the acceptance criteria as met or not met.
- Check current package APIs (Anthropic SDK, Voyage, pgvector, Next.js) in their official docs rather than from memory; versions change.
- Don't add a dependency without saying why. No LangChain, LlamaIndex or vector-DB SaaS.

**Code rules**

- TypeScript strict; no `any`. Zod at every boundary (env, request bodies, eval files).
- All raw SQL in `lib/retrieval/` using Prisma tagged templates; never build SQL with string concatenation.
- API keys only on the server. The Claude and Voyage clients are created in `lib/` and never imported into Client Components.
- Model name, chunk size, top-k and thresholds come from config or env, not hard-coded in several places.
- The system prompt lives in `lib/llm/prompts.ts`. It tells Claude to answer only from the numbered context, cite with \[n\], and say it couldn't find the answer when the context doesn't cover it.
- Tests must not call real APIs; mock the clients. Only `pnpm eval` uses real keys.
- Small, focused commits with clear messages.

**First prompt to give Claude Code**

```text
Read SPEC.md. We're building this project from scratch, one phase at a time.
Start with Phase 0 only. First list the files you plan to create and the
packages you'll install (with reasons), then wait for my go-ahead.
```
