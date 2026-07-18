import type { IntegrationDescriptorDef } from '../../shared/integrations'
import { HTTP_ACTION_IDS, HTTP_TRIGGER_IDS } from '../../shared/http'

/**
 * The generic HTTP / webhook connector descriptor (spec §5, §6). Unlike every
 * fixed-vendor connector, `http` owns NO per-id secret — its secrets are PER
 * NODE (§7), so the descriptor-level config block is deliberately thin: it only
 * carries the opt-in `environment` and the (incoming-half) `ingressBaseUrl`, and
 * `status('http')` derives from those alone (§5). Per-node readiness ("does THIS
 * node have its secret?") is a run-time check inside the connector, not a
 * descriptor status. The trigger/action ids are the PINNED generic-HTTP
 * vocabulary (§6) the palette + templates track consume verbatim — a snapshot
 * test guards them. Mirrors `shopify-descriptor.ts`.
 */
export const httpDescriptor: IntegrationDescriptorDef = {
  id: 'http',
  label: 'HTTP / Webhook',
  configFields: [
    {
      key: 'environment',
      label: 'localflow environment (1-9)',
      secret: false,
      required: true,
      type: 'number'
    },
    {
      key: 'ingressBaseUrl',
      label: 'Webhook ingress base URL (incoming only)',
      secret: false,
      required: false,
      type: 'string',
      placeholder: 'https://<tunnel>'
    }
  ],
  triggers: [{ id: HTTP_TRIGGER_IDS[0], label: 'An external system POSTed to my webhook URL' }],
  actions: [
    { id: HTTP_ACTION_IDS[0], label: 'Fetch JSON from a URL (read)' },
    { id: HTTP_ACTION_IDS[1], label: 'Send a body to a URL (gated write)' }
  ]
}
