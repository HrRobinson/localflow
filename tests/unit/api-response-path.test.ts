import { describe, it, expect } from 'vitest'
import {
  appendIndex,
  appendKey,
  collapseIndices,
  parsePath,
  quoteSegment
} from '../../src/main/api-client/response-path'

describe('quoteSegment', () => {
  it('always brackets and quotes a key', () => {
    expect(quoteSegment('id')).toBe("['id']")
  })
  it('keeps a dotted key in one segment', () => {
    expect(quoteSegment('a.b')).toBe("['a.b']")
  })
  it('escapes backslash before quote', () => {
    expect(quoteSegment("it's")).toBe("['it\\'s']")
    expect(quoteSegment('back\\slash')).toBe("['back\\\\slash']")
    expect(quoteSegment("both\\'")).toBe("['both\\\\\\'']")
  })
})

describe('appendKey / appendIndex', () => {
  it('builds nested paths', () => {
    expect(appendKey('$', 'data')).toBe("$['data']")
    expect(appendKey(appendKey('$', 'a'), 'b')).toBe("$['a']['b']")
  })
  it('appends concrete and wildcard indices bare', () => {
    expect(appendIndex(appendKey('$', 'data'), 0)).toBe("$['data'][0]")
    expect(appendIndex(appendKey('$', 'data'), '*')).toBe("$['data'][*]")
  })
})

describe('parsePath', () => {
  it('parses the root', () => {
    expect(parsePath('$')).toEqual([])
  })
  it('parses keys and indices', () => {
    expect(parsePath("$['data'][0]['id']")).toEqual([
      { kind: 'key', key: 'data' },
      { kind: 'index', index: 0 },
      { kind: 'key', key: 'id' }
    ])
  })
  it('round-trips a dotted key without splitting it', () => {
    expect(parsePath("$['a.b']")).toEqual([{ kind: 'key', key: 'a.b' }])
  })
  it('round-trips escaped quotes and backslashes', () => {
    expect(parsePath("$['it\\'s']")).toEqual([{ kind: 'key', key: "it's" }])
    expect(parsePath("$['back\\\\slash']")).toEqual([{ kind: 'key', key: 'back\\slash' }])
  })
  it('parses a wildcard', () => {
    expect(parsePath("$['data'][*]")).toEqual([{ kind: 'key', key: 'data' }, { kind: 'wild' }])
  })
  it('parses a redacted placeholder as an ordinary quoted key', () => {
    expect(parsePath("$['<redacted:1>']")).toEqual([{ kind: 'key', key: '<redacted:1>' }])
  })
  it('rejects malformed paths', () => {
    expect(parsePath('')).toBeNull()
    expect(parsePath('data')).toBeNull()
    expect(parsePath('$.data')).toBeNull()
    expect(parsePath("$['unterminated")).toBeNull()
    expect(parsePath('$[]')).toBeNull()
    expect(parsePath('$[abc]')).toBeNull()
    expect(parsePath("$['a']junk")).toBeNull()
  })
  it('a remote-chosen key cannot forge a segment boundary', () => {
    // The whole point of quoting: this is ONE key, not two segments.
    const evil = "a']['b"
    const path = appendKey('$', evil)
    expect(parsePath(path)).toEqual([{ kind: 'key', key: evil }])
  })
})

describe('collapseIndices', () => {
  it('turns concrete indices into wildcards', () => {
    expect(collapseIndices("$['data'][0]['n']")).toBe("$['data'][*]['n']")
  })
  it('leaves an index-shaped key alone', () => {
    // `[0]` inside quotes is a KEY, not an index — it must not be collapsed.
    expect(collapseIndices("$['[0]']")).toBe("$['[0]']")
  })
})
