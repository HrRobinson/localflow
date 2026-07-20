import { describe, it, expect } from 'vitest'
import {
  AirtableHttpApi,
  type AirtableTransport,
  type AirtableResponse
} from '../../src/main/airtable/airtable-api'

/**
 * The Web API client's throttle + error mapping (spec §2.2, §9), driven off an
 * INJECTED CLOCK + sleep so the 5 req/sec token bucket and the 30-second 429
 * lockout are asserted deterministically with no real waiting and no network.
 */

function harness(responder: (n: number) => AirtableResponse) {
  let clock = 0
  const sleeps: number[] = []
  let n = 0
  const transport: AirtableTransport = { send: () => Promise.resolve(responder(n++)) }
  const api = new AirtableHttpApi({
    transport,
    baseId: 'app1',
    tableId: 'tblIntake',
    reveal: () => 'patTEST',
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms)
      clock += ms
    }
  })
  return { api, sleeps, calls: () => n }
}

const ok = (body: unknown): AirtableResponse => ({ status: 200, body: JSON.stringify(body) })

describe('per-base token bucket — 5 requests/second (spec §2.2)', () => {
  it('spaces a 6th rapid request by waiting ~1s for the window to age out', async () => {
    const { api, sleeps } = harness(() => ok({ records: [] }))
    for (let i = 0; i < 6; i++) await api.listRecords({})
    // The first 5 fit the 1-second window; the 6th waits for the oldest to age out.
    expect(sleeps).toContain(1000)
    expect(sleeps.length).toBe(1)
  })
})

describe('429 + 30-second lockout (spec §2.2, §9)', () => {
  it('waits out the 30s lockout and retries, then succeeds', async () => {
    // First send 429, then 200.
    const { api, sleeps } = harness((n) =>
      n === 0 ? { status: 429, body: '' } : ok({ id: 'rec1', createdTime: '', fields: {} })
    )
    const out = await api.getRecord('rec1')
    expect(sleeps).toContain(30_000)
    expect(out).toMatchObject({ id: 'rec1' })
  })

  it('rejects with the actionable throttle message after exhausting retries', async () => {
    const { api } = harness(() => ({ status: 429, body: '' }))
    await expect(api.getRecord('rec1')).rejects.toThrow(/throttled base 'app1'.*gave up/)
  })
})

describe('error mapping forwards Airtable’s real cause (spec §9)', () => {
  it('maps a 422 to a legible write error carrying the field message', async () => {
    const { api } = harness(() => ({
      status: 422,
      body: JSON.stringify({
        error: { type: 'INVALID_REQUEST_UNKNOWN', message: "unknown field 'Statuss'" }
      })
    }))
    await expect(api.updateRecord('rec1', { fields: { Statuss: 'x' } })).rejects.toThrow(
      /unknown field 'Statuss'.*INVALID_REQUEST_UNKNOWN/
    )
  })

  it('maps a 401 to a re-enter-the-token message (never echoing auth)', async () => {
    const { api } = harness(() => ({ status: 401, body: '' }))
    await expect(api.getRecord('rec1')).rejects.toThrow(
      /rejected the personal access token \(401\)/
    )
  })

  it('maps a 404 to an actionable not-found (not a bare 404)', async () => {
    const { api } = harness(() => ({ status: 404, body: '' }))
    await expect(api.getRecord('recGONE')).rejects.toThrow(/no such record in table 'tblIntake'/)
  })
})

describe('listWebhookPayloads — the /payloads cursor read (spec §4)', () => {
  it('parses payloads + the next cursor + mightHaveMore', async () => {
    const { api } = harness(() =>
      ok({ payloads: [{ timestamp: 't' }], cursor: 12, mightHaveMore: true })
    )
    const page = await api.listWebhookPayloads('achW', 11)
    expect(page).toEqual({ payloads: [{ timestamp: 't' }], cursor: 12, mightHaveMore: true })
  })
})
