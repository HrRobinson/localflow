import { describe, it, expect } from 'vitest'
import {
  normalizeCompany,
  normalizeContact,
  normalizeDeal,
  normalizeSubscriptionBatch
} from '../../src/main/hubspot/hubspot-normalize'

describe('normalizeContact', () => {
  it('flattens the properties bag, builds a display name, lowercases enums', () => {
    const raw = {
      id: '501',
      createdAt: '2026-07-01T00:00:00Z',
      properties: {
        email: 'ada@example.com',
        firstname: 'Ada',
        lastname: 'Lovelace',
        company: 'Analytical Engines',
        jobtitle: 'Engineer',
        lifecyclestage: 'MarketingQualifiedLead',
        hs_lead_status: 'NEW',
        hs_last_activity_date: '2026-07-10T12:00:00Z'
      }
    }
    expect(normalizeContact(raw)).toEqual({
      contact: {
        id: '501',
        email: 'ada@example.com',
        firstName: 'Ada',
        lastName: 'Lovelace',
        name: 'Ada Lovelace',
        company: 'Analytical Engines',
        jobTitle: 'Engineer',
        lifecycleStage: 'marketingqualifiedlead',
        leadStatus: 'new',
        createdAt: '2026-07-01T00:00:00Z',
        lastActivityAt: '2026-07-10T12:00:00Z'
      }
    })
  })

  it('defaults absent properties to empty strings and a sparse object never throws', () => {
    const out = normalizeContact({ id: '9', properties: {} })
    expect(out.contact).toMatchObject({ id: '9', email: '', name: '', lifecycleStage: '' })
    expect(normalizeContact(undefined).contact.id).toBe('')
  })
})

describe('normalizeDeal', () => {
  it('coerces amount string→number and closed flags string→boolean', () => {
    const raw = {
      id: '77',
      properties: {
        dealname: 'Big Deal',
        dealstage: 'ClosedWon',
        pipeline: 'default',
        amount: '4200',
        deal_currency_code: 'USD',
        hubspot_owner_id: '12',
        closedate: '2026-08-01T00:00:00Z',
        hs_is_closed: 'true',
        hs_is_closed_won: 'true',
        createdate: '2026-06-01T00:00:00Z'
      }
    }
    expect(normalizeDeal(raw).deal).toEqual({
      id: '77',
      name: 'Big Deal',
      stage: 'closedwon',
      pipeline: 'default',
      amount: 4200,
      currency: 'USD',
      ownerId: '12',
      closeDate: '2026-08-01T00:00:00Z',
      isClosed: true,
      isWon: true,
      createdAt: '2026-06-01T00:00:00Z'
    })
  })

  it('absent amount → 0 and absent flags → false', () => {
    const out = normalizeDeal({ id: '1', properties: { dealstage: 'appointmentscheduled' } })
    expect(out.deal).toMatchObject({ amount: 0, isClosed: false, isWon: false })
  })
})

describe('normalizeCompany', () => {
  it('coerces employee/revenue counts to numbers', () => {
    const raw = {
      id: '900',
      properties: {
        name: 'Globex',
        domain: 'globex.com',
        industry: 'COMPUTER_SOFTWARE',
        numberofemployees: '250',
        annualrevenue: '5000000',
        country: 'United States'
      }
    }
    expect(normalizeCompany(raw).company).toEqual({
      id: '900',
      name: 'Globex',
      domain: 'globex.com',
      industry: 'COMPUTER_SOFTWARE',
      numEmployees: 250,
      annualRevenue: 5000000,
      country: 'United States'
    })
  })
})

describe('normalizeSubscriptionBatch', () => {
  it('maps contact.creation → contact.created with a contactId payload', () => {
    const events = normalizeSubscriptionBatch([
      { eventId: 111, subscriptionType: 'contact.creation', objectId: 501, occurredAt: 1234 }
    ])
    expect(events).toEqual([
      {
        eventId: '111',
        triggerId: 'contact.created',
        payload: {
          objectId: '501',
          contactId: '501',
          subscriptionType: 'contact.creation',
          occurredAt: '1234'
        }
      }
    ])
  })

  it('maps deal.propertyChange on dealstage → deal.stageChanged with the new value', () => {
    const events = normalizeSubscriptionBatch([
      {
        eventId: 222,
        subscriptionType: 'deal.propertyChange',
        objectId: 77,
        propertyName: 'dealstage',
        propertyValue: 'closedwon'
      }
    ])
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      triggerId: 'deal.stageChanged',
      payload: { dealId: '77', propertyName: 'dealstage', propertyValue: 'closedwon' }
    })
  })

  it('DROPS a deal.propertyChange on a non-dealstage property (filtered connector-side)', () => {
    const events = normalizeSubscriptionBatch([
      { eventId: 1, subscriptionType: 'deal.propertyChange', objectId: 77, propertyName: 'amount' }
    ])
    expect(events).toEqual([])
  })

  it('maps a form submission → form.submitted', () => {
    const events = normalizeSubscriptionBatch([
      { eventId: 3, subscriptionType: 'form.submission', objectId: 42 }
    ])
    expect(events[0]).toMatchObject({ triggerId: 'form.submitted', payload: { objectId: '42' } })
  })

  it('emits ONE event per array element and drops unsupported / id-less events', () => {
    const events = normalizeSubscriptionBatch([
      { eventId: 1, subscriptionType: 'contact.creation', objectId: 1 },
      { eventId: 2, subscriptionType: 'contact.deletion', objectId: 2 }, // unsupported
      { eventId: 3, subscriptionType: 'contact.creation' }, // no objectId
      { eventId: 4, subscriptionType: 'contact.creation', objectId: 4 }
    ])
    expect(events.map((e) => e.payload.objectId)).toEqual(['1', '4'])
  })

  it('accepts a single (non-array) event object and falls back to objectId for a missing eventId', () => {
    const events = normalizeSubscriptionBatch({
      subscriptionType: 'contact.creation',
      objectId: 55
    })
    expect(events[0]).toMatchObject({ eventId: '55', triggerId: 'contact.created' })
  })

  it('garbage → no events (never throws)', () => {
    expect(normalizeSubscriptionBatch('nonsense')).toEqual([])
    expect(normalizeSubscriptionBatch(null)).toEqual([])
  })
})
