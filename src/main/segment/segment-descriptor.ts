import type { IntegrationDescriptorDef } from '../../shared/integrations'
import { SEGMENT_TRIGGER_IDS, SEGMENT_ACTION_IDS } from '../../shared/segment'

/**
 * Segment connector config surface (spec §5). Secret fields (`sharedSecret`,
 * `writeKey`) route to the CredentialStore keychain and NEVER touch config.json;
 * non-secret refs (environment, ingress path/url, data-plane region) are
 * config-as-code. The `writeKey` is OPTIONAL — a trigger-only connector is fully
 * usable without it (§5, §13.2), so only `sharedSecret` + `environment` are
 * required. Trigger/action ids are the pinned Segment vocabulary (§6) the
 * flow-templates track consumes verbatim — a snapshot test guards them. Mirrors
 * `stripe-descriptor.ts`.
 */
export const segmentDescriptor: IntegrationDescriptorDef = {
  id: 'segment',
  label: 'Segment',
  configFields: [
    {
      key: 'sharedSecret',
      label: 'Webhook shared secret',
      secret: true,
      required: true,
      type: 'string',
      placeholder: 'the Segment Webhook destination shared secret'
    },
    {
      key: 'writeKey',
      label: 'Source write key',
      secret: true,
      // OPTIONAL: only needed when a track/identify action is used (§5, §13.2).
      required: false,
      type: 'string',
      placeholder: 'the source write key (Tracking API)'
    },
    {
      key: 'environment',
      label: 'localflow environment (1-9)',
      secret: false,
      required: true,
      type: 'number'
    },
    {
      key: 'webhookPath',
      label: 'Ingress webhook path',
      secret: false,
      required: false,
      type: 'string',
      placeholder: '/segment/webhook'
    },
    {
      key: 'webhookUrl',
      label: 'Ingress webhook URL',
      secret: false,
      required: false,
      type: 'string',
      placeholder: 'https://<tunnel>/segment/webhook'
    },
    {
      key: 'dataPlaneUrl',
      label: 'Tracking API region base',
      secret: false,
      required: false,
      type: 'string',
      placeholder: 'https://api.segment.io'
    }
  ],
  triggers: [{ id: SEGMENT_TRIGGER_IDS[0], label: 'A Segment event fired (from any source)' }],
  actions: [
    { id: SEGMENT_ACTION_IDS[0], label: 'Emit a track event' },
    { id: SEGMENT_ACTION_IDS[1], label: 'Emit an identify' }
  ]
}
