import { describe, it, expect } from 'vitest'
import { normalizeHttpUrl, isHttpUrl } from '../../src/shared/urls'

describe('normalizeHttpUrl', () => {
  it('passes through valid http/https URLs (normalized href)', () => {
    expect(normalizeHttpUrl('https://example.com')).toBe('https://example.com/')
    expect(normalizeHttpUrl('http://localhost:5173/app')).toBe('http://localhost:5173/app')
  })
  it('prefixes https:// when the scheme is missing', () => {
    expect(normalizeHttpUrl('example.com')).toBe('https://example.com/')
    expect(normalizeHttpUrl('localhost:5173')).toBe('https://localhost:5173/')
  })
  it('trims surrounding whitespace', () => {
    expect(normalizeHttpUrl('  example.com  ')).toBe('https://example.com/')
  })
  it('rejects non-http(s) schemes outright', () => {
    expect(normalizeHttpUrl('file:///etc/passwd')).toBeNull()
    expect(normalizeHttpUrl('javascript:alert(1)')).toBeNull()
    expect(normalizeHttpUrl('data:text/html,<b>x</b>')).toBeNull()
    expect(normalizeHttpUrl('ftp://example.com')).toBeNull()
  })
  it('rejects empty and unparseable input', () => {
    expect(normalizeHttpUrl('')).toBeNull()
    expect(normalizeHttpUrl('   ')).toBeNull()
    expect(normalizeHttpUrl('http://')).toBeNull()
  })
  it('treats host:port as a port, not a scheme', () => {
    expect(normalizeHttpUrl('localhost:5173')).toBe('https://localhost:5173/')
    expect(normalizeHttpUrl('127.0.0.1:3000/app')).toBe('https://127.0.0.1:3000/app')
  })
  it('does not rewrite explicit non-numeric schemes into hosts', () => {
    expect(normalizeHttpUrl('mailto:x@y.z')).toBeNull()
  })
})

describe('isHttpUrl', () => {
  it('accepts exactly http and https', () => {
    expect(isHttpUrl('https://example.com/x')).toBe(true)
    expect(isHttpUrl('http://127.0.0.1:8080')).toBe(true)
  })
  it('rejects everything else, including unparseable strings', () => {
    expect(isHttpUrl('file:///tmp')).toBe(false)
    expect(isHttpUrl('about:blank')).toBe(false)
    expect(isHttpUrl('not a url')).toBe(false)
    expect(isHttpUrl('')).toBe(false)
  })
})
