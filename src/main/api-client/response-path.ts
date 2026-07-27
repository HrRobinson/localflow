/**
 * The response-path grammar, in one place so the emitter (`response-shape.ts`)
 * and the reader (`response-store.ts`) can never drift.
 *
 * Paths are JSONPath bracket-string form — every object key is quoted, array
 * indices are bare:
 *
 *     $                        the root
 *     $['key']                 an object member
 *     $['data'][0]             a concrete index
 *     $['data'][*]             a collapsed homogeneous array
 *     $['<redacted:1>']        a redacted key placeholder
 *     $headers['content-type'] a response header
 *
 * WHY quoted (design §4.4a): the key alphabet is REMOTE-CONTROLLED. Unquoted,
 * `{"a.b":x}` and `{"a":{"b":y}}` produce the same path, and a remote can plant
 * a key that forges a segment boundary. Quoting makes every path a unique
 * address by construction — which `$ref` needs, because a chained path is
 * load-bearing for a WRITE into the next request, where "prefer the withheld
 * entry on a tie" no longer disambiguates anything.
 */

export const HEADERS_ROOT = '$headers'

export type PathStep =
  { kind: 'key'; key: string } | { kind: 'index'; index: number } | { kind: 'wild' }

/** `a.b` → `['a.b']`. Escapes `\` first, then `'`. */
export function quoteSegment(key: string): string {
  return `['${key.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}']`
}

export function appendKey(path: string, key: string): string {
  return `${path}${quoteSegment(key)}`
}

export function appendIndex(path: string, index: number | '*'): string {
  return `${path}[${index}]`
}

/**
 * Parse a path into steps, or null when malformed. Strict: anything that is not
 * exactly this grammar is rejected rather than coerced, so a bad path can never
 * be silently reinterpreted as a different address.
 */
export function parsePath(path: string): PathStep[] | null {
  let i: number
  if (path.startsWith(HEADERS_ROOT)) i = HEADERS_ROOT.length
  else if (path.startsWith('$')) i = 1
  else return null

  const steps: PathStep[] = []
  while (i < path.length) {
    if (path[i] !== '[') return null
    i++
    if (path[i] === "'") {
      i++
      let key = ''
      let closed = false
      while (i < path.length) {
        const c = path[i]
        if (c === '\\') {
          if (i + 1 >= path.length) return null
          key += path[i + 1]
          i += 2
          continue
        }
        if (c === "'") {
          closed = true
          i++
          break
        }
        key += c
        i++
      }
      if (!closed || path[i] !== ']') return null
      i++
      steps.push({ kind: 'key', key })
      continue
    }
    if (path[i] === '*') {
      if (path[i + 1] !== ']') return null
      i += 2
      steps.push({ kind: 'wild' })
      continue
    }
    let digits = ''
    while (i < path.length && path[i] >= '0' && path[i] <= '9') {
      digits += path[i]
      i++
    }
    if (digits.length === 0 || path[i] !== ']') return null
    i++
    steps.push({ kind: 'index', index: Number(digits) })
  }
  return steps
}

/**
 * Concrete indices → `[*]`, for matching a pulled path against a shape whose
 * homogeneous array collapsed. Operates on PARSED steps, never a regex over the
 * raw string, so an index-shaped KEY (`$['[0]']`) is never rewritten.
 */
export function collapseIndices(path: string): string {
  const steps = parsePath(path)
  if (steps === null) return path
  const root = path.startsWith(HEADERS_ROOT) ? HEADERS_ROOT : '$'
  return steps.reduce((acc, step) => {
    if (step.kind === 'key') return appendKey(acc, step.key)
    return appendIndex(acc, '*')
  }, root)
}
