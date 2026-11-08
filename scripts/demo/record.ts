/**
 * Records docs/demo.gif's source video: a real question in the running app (default
 * http://localhost:3002), the streamed answer, a citation popover and the sources list.
 *
 *   pnpm dev:webpack --port 3002            # in another terminal (needs ingested docs + keys)
 *   pnpm tsx scripts/demo/record.ts         # writes .cache/demo/*.webm
 *   docker run --rm -v "$PWD/.cache/demo:/in" -v "$PWD/docs:/out" linuxserver/ffmpeg \
 *     -i /in/demo.webm -vf "fps=12,scale=900:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer" /out/demo.gif
 */
import { mkdir, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";

import { chromium, type Browser } from "@playwright/test";

const BASE = process.env["DEMO_URL"] ?? "http://localhost:3002";
const OUT = path.resolve(".cache/demo");
const QUESTION = "How do I revalidate fetched data every 60 seconds?";
const SIZE = { width: 1100, height: 720 };

async function main(): Promise<void> {
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });

  const browser = await chromium.launch();
  try {
    await record(browser);
  } finally {
    await browser.close();
  }

  const [video] = (await readdir(OUT)).filter((f) => f.endsWith(".webm"));
  if (!video) throw new Error("No video was recorded");
  await rename(path.join(OUT, video), path.join(OUT, "demo.webm"));
  console.log(`Recorded ${path.join(OUT, "demo.webm")}`);
}

async function record(browser: Browser): Promise<void> {
  const context = await browser.newContext({
    viewport: SIZE,
    colorScheme: "light",
    recordVideo: { dir: OUT, size: SIZE },
  });
  const page = await context.newPage();
  const pause = (ms: number) => page.waitForTimeout(ms);

  await page.goto(BASE);
  const box = page.getByRole("textbox", { name: "Ask a question about the docs" });
  // Wait until React is interactive (typing earlier is ignored).
  await page.waitForFunction(() =>
    Object.keys(document.querySelector("textarea") ?? {}).some((k) => k.startsWith("__react")),
  );
  await pause(800);
  await box.pressSequentially(QUESTION, { delay: 35 });
  await pause(400);
  await box.press("Enter");

  // Fail fast (and visibly) if the answer errors instead of showing sources.
  await Promise.race([
    page.getByRole("region", { name: "Sources" }).waitFor({ timeout: 60_000 }),
    page
      .getByRole("alert")
      .filter({ hasText: /w/ })
      .waitFor({ timeout: 60_000 })
      .then(async () => {
        throw new Error(
          `The app showed an error: ${await page.getByRole("alert").filter({ hasText: /w/ }).innerText()}`,
        );
      }),
  ]);
  await pause(1200);

  // Open the first citation's popover.
  const marker = page.locator("button[data-citation]").first();
  await marker.scrollIntoViewIfNeeded();
  await pause(600);
  await marker.click();
  await pause(2500);
  await page.keyboard.press("Escape");
  await pause(500);

  // Show the sources list.
  await page.getByRole("region", { name: "Sources" }).scrollIntoViewIfNeeded();
  await pause(2000);

  await context.close();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
