/**
 * Approximate token count. Voyage only ships its tokenizer for Python, and chunk sizing only needs
 * to be roughly right, so we estimate from length. ~4 chars/token is slightly conservative for
 * Voyage (their docs suggest ~5) and close to Claude's tokenizer for English prose and code.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Characters that correspond to roughly `tokens` tokens (inverse of estimateTokens). */
export function tokensToChars(tokens: number): number {
  return tokens * 4;
}
