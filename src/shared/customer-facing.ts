/**
 * Customer-facing action registry — the source of truth for "which connector
 * actions send something a customer sees" (§9, never-auto-send). The predicate
 * is consumed by the main-process strict validator (`flow-model.ts`), which
 * refuses to bring a flow live if a customer-facing send is reachable with no
 * human-approval `gate` upstream. Each connector OWNS its own list; this map is
 * seeded FROM those exports so the truth stays with the connector, not here.
 */

import type { IntegrationId } from './integrations'
import { INTERCOM_CUSTOMER_FACING_ACTION_IDS } from './intercom'
import { ZENDESK_PUBLIC_REPLY_ACTION_ID } from './zendesk'

/**
 * Per-integration set of action refs that are customer-facing sends. Seeded from
 * each connector's own exported id list so there is one source of truth.
 */
const CUSTOMER_FACING_ACTIONS: Partial<Record<IntegrationId, ReadonlySet<string>>> = {
  intercom: new Set<string>(INTERCOM_CUSTOMER_FACING_ACTION_IDS),
  zendesk: new Set<string>([ZENDESK_PUBLIC_REPLY_ACTION_ID])
}

/**
 * True when `(integration, ref)` names a customer-facing send that must sit
 * downstream of a human-approval gate. Unknown integrations / refs are not
 * customer-facing.
 */
export function isCustomerFacingAction(
  integration: IntegrationId,
  ref: string | undefined
): boolean {
  if (ref === undefined) return false
  return CUSTOMER_FACING_ACTIONS[integration]?.has(ref) ?? false
}
