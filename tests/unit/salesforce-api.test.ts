import { describe, it, expect } from 'vitest'
import {
  SalesforceHttpApi,
  buildReconcileSoql,
  mapError,
  type SalesforceTransport,
  type SalesforceRequest,
  type SalesforceResponse
} from '../../src/main/salesforce/salesforce-api'
import { SalesforceAuth, type TokenMinter } from '../../src/main/salesforce/salesforce-auth'

/**
 * The api owns EVERY Salesforce shape (spec §4.2): the SOQL reconcile string, the
 * REST paths, and the error-array mapping. The user-supplied instance URL runs
 * through the SHARED SSRF guard before any request (spec §4.4). Driven with a
 * fake transport + a mock token minter — no live org, no network.
 */

const minter: TokenMinter = {
  mint: () =>
    Promise.resolve({
      accessToken: 'TOK',
      instanceUrl: 'https://acme.my.salesforce.com',
      expiresInSeconds: 3600
    })
}
function auth(): SalesforceAuth {
  return new SalesforceAuth({ minter, now: () => 0 })
}
function fakeTransport(handler: (req: SalesforceRequest) => SalesforceResponse): {
  transport: SalesforceTransport
  reqs: SalesforceRequest[]
} {
  const reqs: SalesforceRequest[] = []
  return {
    reqs,
    transport: {
      send: (req) => {
        reqs.push(req)
        return Promise.resolve(handler(req))
      }
    }
  }
}

describe('buildReconcileSoql (spec §7.2)', () => {
  it('builds `WHERE <ts> >= :cursor ORDER BY <ts>, Id` with the reserved SELECT', () => {
    const soql = buildReconcileSoql({
      object: 'Lead',
      timestampField: 'LastModifiedDate',
      fields: ['Company', 'AnnualRevenue'],
      afterTs: '2026-07-18T10:00:00Z'
    })
    expect(soql).toBe(
      'SELECT Id, CreatedDate, LastModifiedDate, Company, AnnualRevenue FROM Lead ' +
        'WHERE LastModifiedDate >= 2026-07-18T10:00:00Z ORDER BY LastModifiedDate, Id'
    )
  })

  it('folds the author WHERE and omits the cursor clause on the first (baseline) tick', () => {
    const soql = buildReconcileSoql({
      object: 'Opportunity',
      timestampField: 'CreatedDate',
      where: "StageName = 'Prospecting'"
    })
    expect(soql).toBe(
      "SELECT Id, CreatedDate, LastModifiedDate FROM Opportunity WHERE (StageName = 'Prospecting') " +
        'ORDER BY CreatedDate, Id'
    )
  })
})

describe('SalesforceHttpApi — SSRF guard on the instance URL (spec §4.4)', () => {
  it('REFUSES a private/loopback/metadata instance URL before any request is sent', async () => {
    const { transport, reqs } = fakeTransport(() => ({ status: 200, body: '{}' }))
    for (const bad of [
      'https://127.0.0.1',
      'https://10.1.2.3',
      'https://169.254.169.254',
      'http://acme.my.salesforce.com' // non-https
    ]) {
      const api = new SalesforceHttpApi({ transport, auth: auth(), instanceUrl: bad })
      await expect(api.getRecord('Lead', '00Q000000000001')).rejects.toThrow(
        /Salesforce instance URL|https|private|loopback|cloud-metadata/i
      )
    }
    expect(reqs).toHaveLength(0) // nothing ever hit the transport
  })

  it('allows a public My Domain instance URL and builds the versioned REST path', async () => {
    const { transport, reqs } = fakeTransport(() => ({
      status: 200,
      body: JSON.stringify({ attributes: { type: 'Lead' }, Id: '00Q000000000001' })
    }))
    const api = new SalesforceHttpApi({
      transport,
      auth: auth(),
      instanceUrl: 'https://acme.my.salesforce.com',
      apiVersion: 'v62.0'
    })
    await api.getRecord('Lead', '00Q000000000001')
    expect(reqs[0].url).toBe(
      'https://acme.my.salesforce.com/services/data/v62.0/sobjects/Lead/00Q000000000001'
    )
    expect(reqs[0].headers.Authorization).toBe('Bearer TOK')
  })

  it('submitForApproval POSTs a Submit request to the process/approvals resource', async () => {
    const { transport, reqs } = fakeTransport(() => ({ status: 200, body: '[{"success":true}]' }))
    const api = new SalesforceHttpApi({
      transport,
      auth: auth(),
      instanceUrl: 'https://acme.my.salesforce.com'
    })
    await api.submitForApproval({ recordId: '00Q000000000001', comments: 'go' })
    expect(reqs[0].method).toBe('POST')
    expect(reqs[0].url).toMatch(/\/process\/approvals\/$/)
    expect(JSON.parse(reqs[0].body!)).toEqual({
      requests: [{ actionType: 'Submit', contextId: '00Q000000000001', comments: 'go' }]
    })
  })
})

describe("mapError — forwards Salesforce's own error array verbatim (spec §11)", () => {
  it('maps `[{ message, errorCode }]` to a legible reject carrying both', () => {
    const err = mapError(
      {
        status: 400,
        body: JSON.stringify([
          { message: 'Company: bad value', errorCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION' }
        ])
      },
      '/sobjects/Lead'
    )
    expect(err.message).toMatch(/FIELD_CUSTOM_VALIDATION_EXCEPTION/)
    expect(err.message).toMatch(/Company: bad value/)
  })

  it('maps an OAuth-style `{ error, error_description }` body', () => {
    const err = mapError(
      {
        status: 400,
        body: JSON.stringify({ error: 'invalid_grant', error_description: "user hasn't approved" })
      },
      '/services/oauth2/token'
    )
    expect(err.message).toMatch(/invalid_grant/)
  })

  it('a bare 404 becomes a legible not-found, not a raw status', () => {
    const err = mapError({ status: 404, body: '' }, '/sobjects/Lead/00Q000000000001')
    expect(err.message).toMatch(/no such resource \(404/)
  })

  it('surfaces INVALID_SESSION_ID so salesforce-auth can re-mint', async () => {
    const { transport } = fakeTransport(() => ({
      status: 401,
      body: JSON.stringify([{ message: 'Session expired', errorCode: 'INVALID_SESSION_ID' }])
    }))
    const api = new SalesforceHttpApi({
      transport,
      auth: auth(),
      instanceUrl: 'https://acme.my.salesforce.com'
    })
    // The 401 body carries INVALID_SESSION_ID; withAuth re-mints once then the
    // second 401 rejects with the same code (not an infinite loop).
    await expect(api.getRecord('Lead', 'x')).rejects.toThrow(/INVALID_SESSION_ID/)
  })
})
