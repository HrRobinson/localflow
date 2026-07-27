import { describe, it, expect } from 'vitest'
import { chainScrubCandidates, scrub, scrubForms, REDACTED } from '../../src/main/api-client/redact'
import type { RefValue } from '../../src/main/api-client/request-resolve'

const SECRET = 'sk_live_abc123'

describe('scrubForms', () => {
  it('includes the raw, base64 and url-encoded forms', () => {
    const forms = scrubForms('a b+c')
    expect(forms).toContain('a b+c')
    expect(forms).toContain(Buffer.from('a b+c', 'utf8').toString('base64'))
    expect(forms).toContain(encodeURIComponent('a b+c'))
  })

  it('returns nothing for an empty secret', () => {
    expect(scrubForms('')).toEqual([])
  })
})

describe('scrub - form-urlencoded (+ for space) leak', () => {
  it('replaces a secret containing a space encoded with + instead of %20', () => {
    const secret = 'sk live'
    // The literal bytes an application/x-www-form-urlencoded body would carry,
    // e.g. echoed back by a server in a validation-error response.
    const body = `client_secret=${secret.replace(/ /g, '+')}`
    expect(scrub(body, scrubForms(secret))).not.toContain(secret)
    expect(scrub(body, scrubForms(secret))).toBe(`client_secret=${REDACTED}`)
  })

  it('replaces a secret containing ! encoded per the real form serializer', () => {
    const secret = 'sk!live'
    // Build the expected wire bytes with URLSearchParams itself, not a
    // hardcoded %21, so the test tracks the serializer, not an assumption.
    const wireForm = new URLSearchParams([['x', secret]]).toString().slice(2)
    const body = `client_secret=${wireForm}`
    expect(encodeURIComponent(secret)).toBe(secret) // sanity: escapes differ
    expect(scrub(body, scrubForms(secret))).not.toContain(wireForm)
    expect(scrub(body, scrubForms(secret))).toBe(`client_secret=${REDACTED}`)
  })
})

describe('scrub', () => {
  it('replaces every occurrence of the raw secret', () => {
    const body = `{"echo":"${SECRET}","again":"${SECRET}"}`
    expect(scrub(body, scrubForms(SECRET))).toBe(`{"echo":"${REDACTED}","again":"${REDACTED}"}`)
    expect(scrub(body, scrubForms(SECRET))).not.toContain(SECRET)
  })

  it('replaces the base64 form', () => {
    const b64 = Buffer.from(SECRET, 'utf8').toString('base64')
    expect(scrub(`{"basic":"${b64}"}`, scrubForms(SECRET))).not.toContain(b64)
  })

  it('replaces the url-encoded form', () => {
    const secret = 'tok/with+chars'
    const enc = encodeURIComponent(secret)
    expect(scrub(`?t=${enc}`, scrubForms(secret))).not.toContain(enc)
  })

  it('handles regex metacharacters in the secret literally', () => {
    const secret = 'a.*b(c)[d]'
    expect(scrub(`x${secret}y`, scrubForms(secret))).toBe(`x${REDACTED}y`)
    // Must not have been treated as a pattern.
    expect(scrub('aXXXbc', scrubForms(secret))).toBe('aXXXbc')
  })

  it('scrubs the longest form first so no partial survives', () => {
    // 'abc' is a substring of 'abcdef'; replacing the short one first would
    // leave 'def' dangling next to a [redacted].
    expect(scrub('abcdef', ['abc', 'abcdef'])).toBe(REDACTED)
  })

  it('is a no-op for an empty secret list', () => {
    expect(scrub('untouched', [])).toBe('untouched')
  })
})

const ref = (value: string, withheld: boolean): RefValue => ({ value, withheld })

describe('chainScrubCandidates (finding 2)', () => {
  // Length was the wrong axis (a prior fix's 8-character minimum both missed
  // short withheld fields and needlessly risked corrupting a response for a
  // long NON-withheld one). The axis is withheld-ness alone.

  it('drops every non-withheld value, however long', () => {
    expect(
      chainScrubCandidates([
        ref('1', false),
        ref('a', false),
        ref('sk_live_but_not_actually_withheld', false)
      ])
    ).toEqual([])
  })

  it('keeps every withheld value, however short', () => {
    expect(chainScrubCandidates([ref('a', true), ref('1', true)])).toEqual(['a', '1'])
  })

  it('keeps a long withheld value and drops a short non-withheld one together', () => {
    const long = 'sk_live_abc123'
    expect(chainScrubCandidates([ref('1', false), ref(long, true)])).toEqual([long])
  })
})
