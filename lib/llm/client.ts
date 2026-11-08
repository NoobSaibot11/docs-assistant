import "server-only";

import Anthropic from "@anthropic-ai/sdk";

import { requireKey } from "@/lib/env";

let client: Anthropic | undefined;

/** Shared Anthropic client (the SDK retries 408/409/429/5xx and connection errors twice). */
export function getAnthropic(): Anthropic {
  client ??= new Anthropic({ apiKey: requireKey("ANTHROPIC_API_KEY") });
  return client;
}
