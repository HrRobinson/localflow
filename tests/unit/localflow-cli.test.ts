import { describe, it, expect } from 'vitest'
import { buildRequest } from '../../openclaw/skills/localflow/bin/localflow-control.mjs'

describe('buildRequest', () => {
  const base = 'http://127.0.0.1:5000'
  it('maps panes to GET /panes', () => {
    expect(buildRequest(base, ['panes'])).toMatchObject({ method: 'GET', path: '/panes' })
  })
  it('maps navigate to POST /panes/:h/navigate with a url body', () => {
    const r = buildRequest(base, ['navigate', 'h1', 'http://localhost:3000'])
    expect(r).toMatchObject({
      method: 'POST',
      path: '/panes/h1/navigate',
      body: { url: 'http://localhost:3000' }
    })
  })
  it('maps prompt joining the remaining args as text', () => {
    const r = buildRequest(base, ['prompt', 'term1', 'fix', 'the', 'bug'])
    expect(r).toMatchObject({
      method: 'POST',
      path: '/panes/term1/prompt',
      body: { text: 'fix the bug' }
    })
  })
  it('maps output with a maxLines query', () => {
    const r = buildRequest(base, ['output', 'term1', '10'])
    expect(r).toMatchObject({ method: 'GET', path: '/panes/term1/output?maxLines=10' })
  })
  it('maps checkpoint --halt to a captures POST flagged halted', () => {
    const r = buildRequest(base, ['checkpoint', 'wp1', '--halt'])
    expect(r).toMatchObject({
      method: 'POST',
      path: '/captures',
      body: { watchpointId: 'wp1', halted: true }
    })
  })
})
