import type {
  HubSpotCompanyContext,
  HubSpotContactContext,
  HubSpotDealContext,
  HubSpotTriggerId,
  HubSpotTriggerPayload
} from '../../shared/hubspot'

/**
 * PURE normalization (§3.3, §5.6) — the correctness boundary the conditions +
 * agent tracks depend on. A raw HubSpot v3 object (`{ id, properties: {…} }`)
 * becomes the PINNED context shape: ids as strings, money/counts coerced to a
 * `number` (so `deal.amount gt 1000` compares numerically, not lexically),
 * enums lowercased to exact `eq`/`ne` values, absent properties → empty/zero.
 * And a raw (batched) subscription payload becomes ONE normalized trigger
 * payload per array element. Never throws — a sparse/garbage object normalizes
 * to safe defaults so a malformed read never crashes a run (mirrors
 * `wc-normalize.ts` / `shopify-normalize.ts`).
 */

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** The `properties` bag off a raw v3 object (everything HubSpot returns as a
 *  string lives in here). */
function props(raw: unknown): Record<string, unknown> {
  if (!isObject(raw)) return {}
  return isObject(raw.properties) ? raw.properties : {}
}

function objectId(raw: unknown): string {
  if (!isObject(raw)) return ''
  return str(raw.id)
}

function str(v: unknown): string {
  if (typeof v === 'string') return v
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  return ''
}

/** Lowercased enum string (`dealstage`, `lifecyclestage`, `hs_lead_status`) so
 *  `eq`/`ne` compares are exact against the pinned lowercase values. */
function lower(v: unknown): string {
  return str(v).toLowerCase()
}

/** HubSpot reports numbers as strings inside `properties` (`amount: "4200"`);
 *  coerce to a finite Number, garbage/absent → 0. Major units — no conversion. */
function num(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim().length > 0) {
    const n = Number(v)
    if (Number.isFinite(n)) return n
  }
  return 0
}

/** HubSpot booleans arrive as the STRINGS "true"/"false" (or a real boolean). */
function bool(v: unknown): boolean {
  return v === true || v === 'true'
}

function fullName(first: unknown, last: unknown): string {
  return [str(first), str(last)].filter((s) => s.length > 0).join(' ')
}

/** The top-level `createdAt` HubSpot returns, falling back to the `createdate`
 *  property when only the bag carries it. */
function createdAt(raw: unknown, p: Record<string, unknown>): string {
  if (isObject(raw) && typeof raw.createdAt === 'string' && raw.createdAt.length > 0) {
    return raw.createdAt
  }
  return str(p.createdate)
}

export function normalizeContact(raw: unknown): HubSpotContactContext {
  const p = props(raw)
  return {
    contact: {
      id: objectId(raw),
      email: str(p.email),
      firstName: str(p.firstname),
      lastName: str(p.lastname),
      name: fullName(p.firstname, p.lastname),
      company: str(p.company),
      jobTitle: str(p.jobtitle),
      lifecycleStage: lower(p.lifecyclestage),
      leadStatus: lower(p.hs_lead_status),
      createdAt: createdAt(raw, p),
      lastActivityAt: str(p.hs_last_activity_date)
    }
  }
}

export function normalizeDeal(raw: unknown): HubSpotDealContext {
  const p = props(raw)
  return {
    deal: {
      id: objectId(raw),
      name: str(p.dealname),
      stage: lower(p.dealstage),
      pipeline: str(p.pipeline),
      amount: num(p.amount),
      currency: str(p.deal_currency_code),
      ownerId: str(p.hubspot_owner_id),
      closeDate: str(p.closedate),
      isClosed: bool(p.hs_is_closed),
      isWon: bool(p.hs_is_closed_won),
      createdAt: createdAt(raw, p)
    }
  }
}

export function normalizeCompany(raw: unknown): HubSpotCompanyContext {
  const p = props(raw)
  return {
    company: {
      id: objectId(raw),
      name: str(p.name),
      domain: str(p.domain),
      industry: str(p.industry),
      numEmployees: num(p.numberofemployees),
      annualRevenue: num(p.annualrevenue),
      country: str(p.country)
    }
  }
}

// ── Subscription batch → trigger payloads (§5.6) ─────────────────────────────

/** One normalized subscription event: the localflow trigger it fires + its
 *  `{ eventId, payload }` SeedEvent ingredients. */
export interface HubSpotWebhookEvent {
  eventId: string
  triggerId: HubSpotTriggerId
  payload: HubSpotTriggerPayload
}

/** Map one raw HubSpot subscription event → a localflow trigger id, or null when
 *  it is unsupported OR a `deal.propertyChange` that is NOT a `dealstage` move
 *  (filtered connector-side so no wasted run is seeded — §9.3). */
function triggerFor(subscriptionType: string, propertyName: string): HubSpotTriggerId | null {
  switch (subscriptionType) {
    case 'contact.creation':
      return 'contact.created'
    case 'deal.propertyChange':
      return propertyName === 'dealstage' ? 'deal.stageChanged' : null
    case 'form.submission':
    case 'form.submitted':
      return 'form.submitted'
    default:
      return null
  }
}

/**
 * Normalize a raw (untrusted) HubSpot webhook body — a single subscription event
 * or a BATCHED array of them — into one `HubSpotWebhookEvent` per usable event.
 * An unsupported subscription type, a non-`dealstage` deal change, or an event
 * with no object id is dropped (so no run is ever seeded on noise — §5.6).
 */
export function normalizeSubscriptionBatch(raw: unknown): HubSpotWebhookEvent[] {
  const events = Array.isArray(raw) ? raw : isObject(raw) ? [raw] : []
  const out: HubSpotWebhookEvent[] = []
  for (const item of events) {
    if (!isObject(item)) continue
    const subscriptionType = str(item.subscriptionType)
    const propertyName = str(item.propertyName)
    const triggerId = triggerFor(subscriptionType, propertyName)
    if (!triggerId) continue

    const id = str(item.objectId)
    if (id.length === 0) continue

    const payload: HubSpotTriggerPayload = { objectId: id, subscriptionType }
    if (triggerId === 'contact.created') payload.contactId = id
    if (triggerId === 'deal.stageChanged') {
      payload.dealId = id
      payload.propertyName = propertyName
      payload.propertyValue = str(item.propertyValue)
    }
    const occurredAt = str(item.occurredAt)
    if (occurredAt.length > 0) payload.occurredAt = occurredAt

    const eventId = str(item.eventId)
    out.push({ eventId: eventId.length > 0 ? eventId : id, triggerId, payload })
  }
  return out
}
