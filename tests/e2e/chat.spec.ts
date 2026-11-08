import { expect, test, type Page, type Route } from "@playwright/test";

import type { ChatEvent, ChatRequestInput } from "../../lib/chat/protocol";

/** A scripted answer: two sources, Markdown with a code block, citations [1] and [2]. */
const ANSWER: ChatEvent[] = [
  {
    type: "meta",
    question: "How do I revalidate fetched data every 60 seconds in Next.js?",
    frameworks: ["nextjs"],
    frameworksSource: "detected",
    sources: [
      {
        n: 1,
        chunkId: "c1",
        framework: "nextjs",
        title: "Caching and Revalidating",
        headingPath: "Caching and Revalidating > Time-based revalidation",
        url: "https://nextjs.org/docs/app/guides/caching#time-based-revalidation",
        excerpt:
          "To revalidate data after a time interval, use the next.revalidate option of fetch.",
      },
      {
        n: 2,
        chunkId: "c2",
        framework: "nextjs",
        title: "Route Segment Config",
        headingPath: "Route Segment Config > revalidate",
        url: "https://nextjs.org/docs/app/api-reference/file-conventions/route-segment-config#revalidate",
        excerpt: "Set the default revalidation time for a layout or page.",
      },
    ],
  },
  { type: "text", text: "Pass `next.revalidate` to `fetch` [1]:\n\n```ts\n" },
  { type: "text", text: "const res = await fetch(url, { next: { revalidate: 60 } })\n```\n\n" },
  { type: "text", text: "Or export `revalidate = 60` from the route [2]." },
  {
    type: "done",
    answered: true,
    outcome: "answered",
    citations: [
      {
        n: 1,
        chunkId: "c1",
        url: "https://nextjs.org/docs/app/guides/caching#time-based-revalidation",
      },
      {
        n: 2,
        chunkId: "c2",
        url: "https://nextjs.org/docs/app/api-reference/file-conventions/route-segment-config#revalidate",
      },
    ],
    usage: {
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      rewriteInputTokens: 1,
      rewriteOutputTokens: 1,
    },
    topSimilarity: 0.6,
    queryId: "query-1",
  },
];

const ndjson = (events: ChatEvent[]) => events.map((e) => `${JSON.stringify(e)}\n`).join("");

/** Fakes /api/chat and records each request body. */
async function fakeChat(page: Page, handler: (route: Route) => Promise<void>) {
  const requests: ChatRequestInput[] = [];
  await page.route("**/api/chat", async (route) => {
    requests.push(route.request().postDataJSON() as ChatRequestInput);
    await handler(route);
  });
  return requests;
}

const answerWith = (events: ChatEvent[]) => (route: Route) =>
  route.fulfill({ status: 200, contentType: "application/x-ndjson", body: ndjson(events) });

/**
 * Types and sends a question. Typing before React hydrates does nothing (the Send button stays
 * disabled), which happens on a cold dev server, so retry until the button reacts.
 */
async function ask(page: Page, question: string) {
  const box = page.getByRole("textbox", { name: "Ask a question about the docs" });
  const send = page.getByRole("button", { name: "Send" });
  await expect(async () => {
    await box.fill(question);
    await expect(send).toBeEnabled({ timeout: 1_000 });
  }).toPass({ timeout: 60_000 });
  await box.press("Enter");
}

test("asks a question and shows a streamed, cited answer", async ({ page }) => {
  const requests = await fakeChat(page, answerWith(ANSWER));
  await page.goto("/");

  await ask(page, "How do I revalidate fetched data every 60 seconds?");

  const answer = page.getByRole("list", { name: "Conversation" });
  await expect(answer.getByText("Or export")).toBeVisible();
  await expect(answer.getByText("Searched")).toBeVisible();
  await expect(answer.locator("code.language-ts")).toContainText("revalidate: 60");
  await expect(answer.getByRole("button", { name: "Copy code" })).toBeVisible();

  // Citation marker → popover with excerpt and a link to the exact docs section.
  await answer.getByRole("button", { name: "Source 1: Caching and Revalidating" }).click();
  const popover = page.getByRole("dialog", { name: "Source 1: Caching and Revalidating" });
  await expect(popover).toContainText("Time-based revalidation");
  await expect(popover).toContainText("use the next.revalidate option");
  await expect(popover.getByRole("link", { name: /Open in the docs/ })).toHaveAttribute(
    "href",
    "https://nextjs.org/docs/app/guides/caching#time-based-revalidation",
  );
  await page.keyboard.press("Escape");
  await expect(popover).toBeHidden();

  // Sources list under the answer.
  const sources = page.getByRole("region", { name: "Sources" });
  await expect(sources.getByRole("link")).toHaveCount(2);
  await expect(sources.getByRole("link").first()).toHaveAttribute(
    "href",
    /caching#time-based-revalidation$/,
  );

  expect(requests).toEqual([
    { question: "How do I revalidate fetched data every 60 seconds?", history: [], frameworks: [] },
  ]);
});

test("sends the framework filter and the previous turn as history", async ({ page }) => {
  const requests = await fakeChat(page, answerWith(ANSWER));
  await page.goto("/");

  await page.getByRole("radio", { name: "Jest" }).click();
  await ask(page, "First question");
  await expect(page.getByRole("region", { name: "Sources" })).toBeVisible();
  await ask(page, "Follow-up");
  await expect(page.getByRole("region", { name: "Sources" })).toHaveCount(2);

  expect(requests[0]?.frameworks).toEqual(["jest"]);
  const history = requests[1]?.history ?? [];
  expect(history).toHaveLength(2);
  expect(history[0]).toEqual({ role: "user", content: "First question" });
  expect(history[1]?.role).toBe("assistant");
  expect(history[1]?.content).toContain("Or export");
});

test("stops a pending answer and retries it", async ({ page }) => {
  let calls = 0;
  await fakeChat(page, async (route) => {
    calls++;
    // First call never answers (until the browser aborts it); the retry answers normally.
    if (calls === 1) return new Promise(() => undefined);
    return answerWith(ANSWER)(route);
  });
  await page.goto("/");

  await ask(page, "A slow question");
  await expect(page.getByText("Searching the docs…")).toBeVisible();
  await page.getByRole("button", { name: "Stop" }).click();

  await expect(page.getByRole("status").filter({ hasText: "Stopped." })).toBeVisible();
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible();

  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByText("Or export")).toBeVisible();
  expect(calls).toBe(2);
});

test("shows a server error with a retry button", async ({ page }) => {
  await fakeChat(
    page,
    answerWith([{ type: "error", message: "Something went wrong while answering." }]),
  );
  await page.goto("/");

  await ask(page, "Anything");
  // (Next.js also renders an empty role="alert" route announcer, so match by text.)
  const alert = page.getByRole("alert").filter({ hasText: "Something went wrong" });
  await expect(alert).toContainText("Something went wrong while answering.");
  await expect(alert.getByRole("button", { name: "Retry" })).toBeVisible();
});

test("shows the not-found answer without sources", async ({ page }) => {
  await fakeChat(
    page,
    answerWith([
      { ...ANSWER[0]!, frameworksSource: "all", frameworks: [] } as ChatEvent,
      { type: "text", text: "I couldn't find this in the docs." },
      {
        ...(ANSWER.at(-1) as Extract<ChatEvent, { type: "done" }>),
        answered: false,
        outcome: "not_found",
        citations: [],
      },
    ]),
  );
  await page.goto("/");

  await ask(page, "How do I write a Remix loader?");
  await expect(page.getByText("I couldn't find this in the docs.")).toBeVisible();
  await expect(page.getByRole("region", { name: "Sources" })).toHaveCount(0);
});

test("sends thumbs up/down feedback for an answer", async ({ page }) => {
  await fakeChat(page, answerWith(ANSWER));
  const feedback: unknown[] = [];
  await page.route("**/api/feedback", async (route) => {
    feedback.push(route.request().postDataJSON());
    await route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' });
  });
  await page.goto("/");

  await ask(page, "How do I revalidate fetched data every 60 seconds?");
  const helpful = page.getByRole("button", { name: "Helpful", exact: true });
  await helpful.click();
  await expect(helpful).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("Thanks for the feedback.")).toBeVisible();

  await page.getByRole("button", { name: "Not helpful" }).click();
  await expect(helpful).toHaveAttribute("aria-pressed", "false");
  expect(feedback).toEqual([
    { queryId: "query-1", rating: "up" },
    { queryId: "query-1", rating: "down" },
  ]);
});

test("shows the stats page", async ({ page }) => {
  await page.goto("/stats");
  await expect(page.getByRole("heading", { name: "Stats" })).toBeVisible();
  await expect(page.getByText("Time to first token")).toBeVisible();
  await expect(page.getByRole("link", { name: "← Back to chat" })).toHaveAttribute("href", "/");
});
