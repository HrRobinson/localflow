/**
 * Quote-aware command-line tokenizer shared by every caller that turns a
 * user-configured string into an argv array. Single/double-quoted spans keep
 * their spaces as one token (macOS editor paths routinely contain spaces —
 * "/Applications/Visual Studio Code.app/..."), adjacent quoted/bare spans
 * join shell-style. Minimal on purpose — no backslash escapes, no env
 * expansion; the tokens are handed to spawn as an argv array, no shell ever
 * sees the string.
 *
 * The two exports differ only in unbalanced-quote handling, and both
 * behaviors are load-bearing at their call sites (see each doc comment).
 */
function tokenize(input: string): { tokens: string[]; unbalanced: boolean } {
  const tokens: string[] = []
  let current = ''
  let inToken = false
  let quote: '"' | "'" | null = null
  for (const ch of input) {
    if (quote) {
      if (ch === quote) quote = null
      else current += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
      inToken = true
    } else if (/\s/.test(ch)) {
      if (inToken) {
        tokens.push(current)
        current = ''
        inToken = false
      }
    } else {
      current += ch
      inToken = true
    }
  }
  if (inToken) tokens.push(current)
  return { tokens, unbalanced: quote !== null }
}

/**
 * Lenient split, used to append per-agent extra args at spawn (the local-LLM
 * enabler). An unterminated quote keeps consuming to the end of the string
 * and the partial token is flushed as one arg — no crash, no dropped input.
 */
export function splitArgs(input: string): string[] {
  return tokenize(input).tokens
}

/**
 * Strict split, used for the configured editor command. An unbalanced quote
 * returns null so the caller treats the command as unavailable rather than
 * guessing at the user's intent.
 */
export function splitCommandLine(raw: string): string[] | null {
  const { tokens, unbalanced } = tokenize(raw)
  return unbalanced ? null : tokens
}
