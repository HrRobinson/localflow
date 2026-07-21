import type { IntegrationDescriptorDef } from '../../shared/integrations'
import {
  STRIPE_TRIGGER_IDS,
  STRIPE_READ_ACTION_IDS,
  STRIPE_MUTATION_ACTION_IDS
} from '../../shared/stripe'

/**
 * Stripe connector config surface (spec §5). Secret fields (`restrictedKey`,
 * `webhookSecret`) route to the CredentialStore keychain and NEVER touch
 * config.json; non-secret refs (account id, api version, environment, ingress
 * url, mode) are config-as-code. The restricted key (`rk_…`) is least-privilege —
 * we NEVER store a full-access secret key (`sk_…`) (§8). Trigger/action ids are
 * the pinned Stripe vocabulary (§6) the flow-templates track consumes verbatim —
 * a snapshot test guards them. Mirrors `shopify-descriptor.ts`.
 */
export const stripeDescriptor: IntegrationDescriptorDef = {
  id: 'stripe',
  label: 'Stripe',
  configFields: [
    {
      key: 'restrictedKey',
      label: 'Stripe restricted API key',
      secret: true,
      required: true,
      type: 'string',
      placeholder: 'rk_live_…'
    },
    {
      key: 'webhookSecret',
      label: 'Webhook signing secret',
      secret: true,
      required: true,
      type: 'string',
      placeholder: 'whsec_…'
    },
    {
      key: 'accountId',
      label: 'Stripe account id',
      secret: false,
      required: false,
      type: 'string',
      placeholder: 'acct_…'
    },
    {
      key: 'apiVersion',
      label: 'Stripe API version',
      secret: false,
      required: false,
      type: 'string',
      placeholder: '2025-06-30'
    },
    {
      key: 'environment',
      label: 'saiife environment (1-9)',
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
      placeholder: 'https://<tunnel>/stripe/webhook'
    },
    {
      key: 'mode',
      label: 'Stripe mode (test | live)',
      secret: false,
      required: false,
      type: 'string',
      placeholder: 'test'
    }
  ],
  triggers: [
    { id: STRIPE_TRIGGER_IDS[0], label: 'Dispute (chargeback) opened' },
    { id: STRIPE_TRIGGER_IDS[1], label: 'Charge refunded' },
    { id: STRIPE_TRIGGER_IDS[2], label: 'Invoice payment failed' }
  ],
  actions: [
    { id: STRIPE_READ_ACTION_IDS[0], label: 'Get a charge' },
    { id: STRIPE_READ_ACTION_IDS[1], label: 'Get a customer' },
    { id: STRIPE_READ_ACTION_IDS[2], label: 'Get a dispute' },
    { id: STRIPE_READ_ACTION_IDS[3], label: 'Get a subscription' },
    { id: STRIPE_MUTATION_ACTION_IDS[0], label: 'Refund a charge' },
    { id: STRIPE_MUTATION_ACTION_IDS[1], label: 'Respond to a dispute' },
    { id: STRIPE_MUTATION_ACTION_IDS[2], label: 'Cancel a subscription' }
  ]
}
