import type { IntegrationDescriptorDef } from '../../shared/integrations'
import {
  SHOPIFY_TRIGGER_IDS,
  SHOPIFY_READ_ACTION_IDS,
  SHOPIFY_MUTATION_ACTION_IDS
} from '../../shared/shopify'

/**
 * Shopify connector config surface (spec §5). Secret fields (`adminToken`,
 * `webhookSecret`) route to the CredentialStore keychain and NEVER touch
 * config.json; non-secret refs (shop domain, api version, environment, ingress
 * url) are config-as-code. Trigger/action ids are the pinned ecom vocabulary
 * (§6) the flow-templates track consumes verbatim — a snapshot test guards them.
 * Mirrors `descriptors/linear.ts`.
 */
export const shopifyDescriptor: IntegrationDescriptorDef = {
  id: 'shopify',
  label: 'Shopify',
  configFields: [
    {
      key: 'adminToken',
      label: 'Shopify Admin API access token',
      secret: true,
      required: true,
      type: 'string',
      placeholder: 'shpat_…'
    },
    {
      key: 'webhookSecret',
      label: 'Webhook signing secret',
      secret: true,
      required: true,
      type: 'string'
    },
    {
      key: 'shopDomain',
      label: 'Store domain',
      secret: false,
      required: true,
      type: 'string',
      placeholder: 'your-store.myshopify.com'
    },
    {
      key: 'apiVersion',
      label: 'Admin API version',
      secret: false,
      required: false,
      type: 'string',
      placeholder: '2025-07'
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
      placeholder: 'https://<tunnel>/shopify/webhook'
    }
  ],
  triggers: [
    { id: SHOPIFY_TRIGGER_IDS[0], label: 'New order placed' },
    { id: SHOPIFY_TRIGGER_IDS[1], label: 'Customer requested a refund' },
    { id: SHOPIFY_TRIGGER_IDS[2], label: 'Order flagged for review' }
  ],
  actions: [
    { id: SHOPIFY_READ_ACTION_IDS[0], label: 'Get an order' },
    { id: SHOPIFY_READ_ACTION_IDS[1], label: 'Get a customer' },
    { id: SHOPIFY_READ_ACTION_IDS[2], label: 'Search orders' },
    { id: SHOPIFY_MUTATION_ACTION_IDS[0], label: 'Refund an order' },
    { id: SHOPIFY_MUTATION_ACTION_IDS[1], label: 'Cancel an order' },
    { id: SHOPIFY_MUTATION_ACTION_IDS[2], label: 'Update shipping address' },
    { id: SHOPIFY_MUTATION_ACTION_IDS[3], label: 'Add an order note' }
  ]
}
