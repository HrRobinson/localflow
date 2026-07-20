import type { IntegrationDescriptorDef } from '../../shared/integrations'
import {
  INTERCOM_TRIGGER_IDS,
  INTERCOM_READ_ACTION_IDS,
  INTERCOM_WRITE_ACTION_IDS
} from '../../shared/intercom'

/**
 * Intercom connector config surface (spec §5). Secret fields (`accessToken`,
 * `clientSecret`) route to the CredentialStore keychain and NEVER touch config.json;
 * non-secret refs (region, environment, ingress url) are config-as-code. The access
 * token is the SINGLE Bearer credential — the simplest auth of the support-desk
 * field (§2). Trigger/action ids are the pinned Intercom vocabulary (§6) the
 * flow-templates track consumes verbatim — a snapshot test guards them. Mirrors
 * `stripe-descriptor.ts`.
 */
export const intercomDescriptor: IntegrationDescriptorDef = {
  id: 'intercom',
  label: 'Intercom',
  configFields: [
    {
      key: 'accessToken',
      label: 'Intercom access token',
      secret: true,
      required: true,
      type: 'string',
      placeholder: 'intercom access token'
    },
    {
      key: 'clientSecret',
      label: 'App client secret (webhook signing)',
      secret: true,
      required: true,
      type: 'string',
      placeholder: 'app client secret'
    },
    {
      key: 'region',
      label: 'Intercom region (us | eu | au)',
      secret: false,
      required: false,
      type: 'string',
      placeholder: 'us'
    },
    {
      key: 'environment',
      label: 'localflow environment (1-9)',
      secret: false,
      required: true,
      type: 'number'
    },
    {
      key: 'webhookUrl',
      label: 'Ingress webhook URL',
      secret: false,
      required: false,
      type: 'string',
      placeholder: 'https://<tunnel>/intercom/webhook'
    }
  ],
  triggers: [
    { id: INTERCOM_TRIGGER_IDS[0], label: 'Customer replied' },
    { id: INTERCOM_TRIGGER_IDS[1], label: 'New conversation started' }
  ],
  actions: [
    { id: INTERCOM_READ_ACTION_IDS[0], label: 'Get a conversation' },
    { id: INTERCOM_READ_ACTION_IDS[1], label: 'Get a contact' },
    { id: INTERCOM_WRITE_ACTION_IDS[0], label: 'Reply to the customer' },
    { id: INTERCOM_WRITE_ACTION_IDS[1], label: 'Close the conversation' },
    { id: INTERCOM_WRITE_ACTION_IDS[2], label: 'Tag the conversation' }
  ]
}
