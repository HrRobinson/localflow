// PURE palette model builder. Turns the resolved integration registry + the
// built-in node types into a flat list of palette rows. No React, no DOM — so
// it's testable with fixture descriptors. NodePalette.tsx renders whatever this
// returns.
//
// Order: built-ins first (agent / gate / router), then one `trigger` row per
// descriptor trigger and one `action` row per descriptor action, in registry
// order. A row whose integration isn't `connected` is marked `needsSetup` (it
// stays draggable — you can author against a not-yet-connected integration; the
// validator flags it, §5/§6.2).
import { BUILTIN_NODE_TYPES, type FlowNodeType } from '../../../shared/flows'
import type { IntegrationId, ResolvedIntegrationDescriptor } from '../../../shared/integrations'

export interface PaletteRow {
  /** Stable, unique key for React lists and drag payloads. */
  key: string
  type: FlowNodeType
  /** Row label shown in the palette. */
  label: string
  /** Present only for integration-sourced rows. */
  integration?: IntegrationId
  integrationLabel?: string
  /** Trigger/action id for integration rows; absent for built-ins. */
  ref?: string
  /** True when the sourcing integration is not `connected`. */
  needsSetup: boolean
}

const BUILTIN_LABELS: Record<string, string> = {
  agent: 'Agent',
  gate: 'Gate',
  router: 'Router'
}

export function buildPalette(registry: ResolvedIntegrationDescriptor[]): PaletteRow[] {
  const rows: PaletteRow[] = []

  for (const type of BUILTIN_NODE_TYPES) {
    rows.push({
      key: `builtin:${type}`,
      type,
      label: BUILTIN_LABELS[type] ?? type,
      needsSetup: false
    })
  }

  for (const d of registry) {
    const needsSetup = d.status !== 'connected'
    for (const t of d.triggers) {
      rows.push({
        key: `trigger:${d.id}:${t.id}`,
        type: 'trigger',
        label: t.label,
        integration: d.id,
        integrationLabel: d.label,
        ref: t.id,
        needsSetup
      })
    }
    for (const a of d.actions) {
      rows.push({
        key: `action:${d.id}:${a.id}`,
        type: 'action',
        label: a.label,
        integration: d.id,
        integrationLabel: d.label,
        ref: a.id,
        needsSetup
      })
    }
  }

  return rows
}
