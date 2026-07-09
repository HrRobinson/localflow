/**
 * Splits a CLI-argument string into argv, honoring single/double quotes so
 * `--prompt "a b"` stays one arg. Used to append per-agent extra args at
 * spawn (the local-LLM enabler). Minimal on purpose — no backslash escapes,
 * no env expansion; the shell that already ran the agent handles the rest.
 */
export function splitArgs(input: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote: '"' | "'" | null = null
  let has = false
  for (const ch of input) {
    if (quote) {
      if (ch === quote) quote = null
      else cur += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
      has = true
    } else if (/\s/.test(ch)) {
      if (has) {
        out.push(cur)
        cur = ''
        has = false
      }
    } else {
      cur += ch
      has = true
    }
  }
  if (has) out.push(cur)
  return out
}
