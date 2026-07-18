import type { IntegrationDescriptorDef } from '../../shared/integrations'
import {
  HUBSPOT_READ_ACTION_IDS,
  HUBSPOT_TRIGGER_IDS,
  HUBSPOT_WRITE_ACTION_IDS
} from '../../shared/hubspot'

/**
 * HubSpot connector config surface + pinned CRM vocabulary (§3, §8). Secrets —
 * the private-app Bearer token and the webhook app CLIENT SECRET — go to the
 * CredentialStore keychain, never config.json (§4). Non-secret refs (portal id,
 * api base, environment, the public webhook URL) live in config.json, validated
 * at the boundary. The trigger/action ids are the contract the flow engine,
 * canvas palette, and templates track consume verbatim — a snapshot test guards
 * them.
 *
 * NOTE (§5.5): `webhookClientSecret` is the HubSpot APP's client secret used
 * only to verify `X-HubSpot-Signature-v3`, DISTINCT from `privateAppToken`
 * (which authorizes read/write). The trigger path needs the app; read/judge/act
 * need only the token.
 */
export const hubspotDescriptor: IntegrationDescriptorDef = {
  id: 'hubspot',
  label: 'HubSpot',
  configFields: [
    {
      key: 'privateAppToken',
      label: 'HubSpot private-app token',
      secret: true,
      required: true,
      type: 'string',
      placeholder: 'pat-na1-…'
    },
    {
      key: 'webhookClientSecret',
      label: 'Webhook app client secret',
      secret: true,
      required: true,
      type: 'string'
    },
    {
      key: 'portalId',
      label: 'HubSpot portal (hub) id',
      secret: false,
      required: false,
      type: 'string'
    },
    {
      key: 'apiBase',
      label: 'CRM API base',
      secret: false,
      required: false,
      type: 'string',
      placeholder: 'https://api.hubapi.com'
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
      placeholder: 'https://<tunnel>/hubspot/webhook'
    }
  ],
  triggers: [
    { id: 'contact.created', label: 'New contact created' },
    { id: 'deal.stageChanged', label: 'Deal moved to a new stage' },
    { id: 'form.submitted', label: 'A form was submitted' }
  ],
  actions: [
    // Reads — pure, no gate needed (write facts for conditions + the agent).
    { id: 'getContact', label: 'Get a contact' },
    { id: 'getDeal', label: 'Get a deal' },
    { id: 'getCompany', label: 'Get a company' },
    { id: 'searchContacts', label: 'Search contacts' },
    // Gated writes — run ONLY because a flow action node reached them (§7.3).
    { id: 'createContact', label: 'Create a contact' },
    { id: 'updateDeal', label: 'Update a deal' },
    { id: 'logActivity', label: 'Log an activity (note)' },
    { id: 'createTask', label: 'Create a follow-up task' }
  ]
}

// Compile-time proof the descriptor ids stay in lockstep with the shared
// vocabulary arrays (a drift is a deliberate, reviewed edit in both places).
const _triggerIds: readonly string[] = HUBSPOT_TRIGGER_IDS
const _actionIds: readonly string[] = [...HUBSPOT_READ_ACTION_IDS, ...HUBSPOT_WRITE_ACTION_IDS]
void _triggerIds
void _actionIds
