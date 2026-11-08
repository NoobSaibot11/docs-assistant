# Eval questions

`questions.json` holds the hand-written questions that `pnpm eval` scores. They're the basis of
the numbers in the main README, so write them yourself from real reading of the docs, not from
a model.

## Targets

- **15 answerable questions per framework** (React Native, Next.js, Angular, Jest), covering each
  one's core topics. Include a few that **span two frameworks**, e.g. testing a Next.js component
  with Jest.
- **10 unanswerable questions**: things these docs don't cover, such as Remix or SvelteKit, plain
  React hooks with nothing framework-specific, or a made-up API (`useServerCache` in Next.js).

`pnpm eval:check` shows the current counts against these targets.

## One entry

```json
{
  "id": "q017",
  "framework": "nextjs",
  "question": "How do I revalidate fetched data every 60 seconds?",
  "expectedSourcePaths": ["nextjs/01-app/03-api-reference/04-functions/fetch.mdx"],
  "mustMention": ["revalidate: 60"],
  "answerable": true,
  "notes": "Per-request option; the segment config is a second valid answer."
}
```

| Field                 | What to put                                                                                                                                                                                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                  | `q001`, `q002`, … unique.                                                                                                                                                                                                                                     |
| `framework`           | `"react-native"`, `"nextjs"`, `"angular"` or `"jest"`; a list for cross-framework questions (`["nextjs", "jest"]`); `null` for off-topic unanswerable ones.                                                                                                   |
| `question`            | Phrase it the way a developer would ask, not with the docs' heading text. Vary the wording: some short, some with context, a few with a typo or a vague term.                                                                                                 |
| `expectedSourcePaths` | Every doc page that properly answers it, as `framework/path`. Hit@5 counts a hit if any chunk from any of these pages is in the top 5.                                                                                                                        |
| `mustMention`         | 1–3 key facts the answer has to contain: an API name, an option, a value. Plain text matches case-insensitively and ignores extra spaces; `/regex/flags` for alternatives (`/revalidate\\s*[:=]\\s*60/`). Keep them short and specific; the check is literal. |
| `answerable`          | `false` for questions the docs don't cover (then no sources or must-mention).                                                                                                                                                                                 |
| `notes`               | Optional: why it's interesting, or an alternative valid answer.                                                                                                                                                                                               |

## Finding source paths

Ask the question (or a sharper version of it) and read the `source:` line under each result:

```bash
pnpm run search "revalidate fetch every 60 seconds" --framework nextjs --limit 8
```

Open the page (the URL is printed too) to confirm it really answers the question. If retrieval
doesn't surface the right page, that's fine: find it in the docs and add it anyway. That's
exactly the kind of question the eval should catch.

## Workflow

```bash
pnpm eval:check                                  # schema, paths exist, facts appear in sources
pnpm eval --retrieval-only                       # retrieval metrics only (nearly free)
pnpm eval --ids q001,q002 --mode hybrid          # spot-check a few with real answers
pnpm eval                                        # full run: 3 modes, answers, judge (~$5–7)
pnpm eval:report                                 # write the README table
pnpm eval --mode hybrid --threshold 0 --label sweep && \
  pnpm eval:report --sweep eval/results/<date>-hybrid-sweep.json   # tune NOT_FOUND_THRESHOLD
```

Results are written to `eval/results/<date>-<mode>[-label].json` with every question's
retrieved chunks, answer, matched facts and the judge's claim-by-claim verdict, so a surprising
number can be traced back to the questions behind it.
