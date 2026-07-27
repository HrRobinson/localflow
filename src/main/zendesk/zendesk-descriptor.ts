import type { IntegrationDescriptorDef } from '../../shared/integrations'
import {
  ZENDESK_TRIGGER_IDS,
  ZENDESK_READ_ACTION_IDS,
  ZENDESK_MUTATION_ACTION_IDS
} from '../../shared/zendesk'

/**
 * Zendesk connector config surface (spec §5). Secret fields (`apiToken`,
 * `webhookSecret`) route to the CredentialStore keychain and NEVER touch
 * config.json; non-secret refs (subdomain, agent email, environment, ingress url)
 * are config-as-code. Trigger/action ids are the pinned Zendesk vocabulary (§6)
 * the flow-templates track consumes verbatim — a snapshot test guards them.
 * Mirrors `stripe-descriptor.ts`.
 */
export const zendeskDescriptor: IntegrationDescriptorDef = {
  id: 'zendesk',
  label: 'Zendesk',
  configFields: [
    {
      key: 'apiToken',
      label: 'Zendesk API token',
      secret: true,
      required: true,
      type: 'string',
      placeholder: 'API token from Admin Center'
    },
    {
      key: 'webhookSecret',
      label: 'Webhook signing secret',
      secret: true,
      required: true,
      type: 'string',
      placeholder: "the webhook's Show Signing Secret"
    },
    {
      key: 'subdomain',
      label: 'Zendesk subdomain',
      secret: false,
      required: true,
      type: 'string',
      placeholder: 'your-co'
    },
    {
      key: 'agentEmail',
      label: 'Agent email',
      secret: false,
      required: true,
      type: 'string',
      placeholder: 'agent@your-co.com'
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
      placeholder: 'https://<tunnel>/zendesk/webhook'
    }
  ],
  triggers: [
    { id: ZENDESK_TRIGGER_IDS[0], label: 'Customer replied on a ticket' },
    { id: ZENDESK_TRIGGER_IDS[1], label: 'New ticket created' },
    { id: ZENDESK_TRIGGER_IDS[2], label: 'Ticket updated' },
    { id: ZENDESK_TRIGGER_IDS[3], label: 'Ticket escalated' }
  ],
  actions: [
    { id: ZENDESK_READ_ACTION_IDS[0], label: 'Get a ticket' },
    { id: ZENDESK_READ_ACTION_IDS[1], label: 'Get the ticket conversation' },
    { id: ZENDESK_READ_ACTION_IDS[2], label: 'Search tickets' },
    { id: ZENDESK_READ_ACTION_IDS[3], label: 'Get the requester' },
    { id: ZENDESK_MUTATION_ACTION_IDS[0], label: 'Public reply to the customer' },
    { id: ZENDESK_MUTATION_ACTION_IDS[1], label: 'Add an internal note' },
    { id: ZENDESK_MUTATION_ACTION_IDS[2], label: 'Set ticket status' },
    { id: ZENDESK_MUTATION_ACTION_IDS[3], label: 'Assign the ticket' },
    { id: ZENDESK_MUTATION_ACTION_IDS[4], label: 'Tag the ticket' }
  ]
}
