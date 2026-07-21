import type { IntegrationDescriptorDef } from '../../shared/integrations'
import {
  AIRTABLE_TRIGGER_IDS,
  AIRTABLE_READ_ACTION_IDS,
  AIRTABLE_WRITE_ACTION_IDS
} from '../../shared/airtable'

/**
 * Airtable connector config surface (spec §8). Secret fields
 * (`personalAccessToken`, and the phase-2 `webhookMacSecret`) route to the
 * CredentialStore keychain and NEVER touch config.json; non-secret refs (base id,
 * table, view, webhook id, poll cadence, environment) are config-as-code.
 * Trigger/action ids are the pinned structured-data vocabulary (§3) the
 * flow-templates track consumes verbatim — a snapshot test guards them.
 * Mirrors `descriptors/posthog.ts` (the poll-connector template).
 */
export const airtableDescriptor: IntegrationDescriptorDef = {
  id: 'airtable',
  label: 'Airtable',
  configFields: [
    {
      key: 'personalAccessToken',
      label: 'Airtable personal access token',
      secret: true,
      required: true,
      type: 'string',
      placeholder: 'pat…'
    },
    {
      key: 'webhookMacSecret',
      label: 'Webhook MAC secret (phase 2)',
      secret: true,
      required: false,
      type: 'string'
    },
    {
      key: 'baseId',
      label: 'Base id',
      secret: false,
      required: true,
      type: 'string',
      placeholder: 'appXXXXXXXXXXXXXX'
    },
    {
      key: 'tableId',
      label: 'Table (id or name)',
      secret: false,
      required: true,
      type: 'string',
      placeholder: 'tblXXXXXXXXXXXXXX'
    },
    {
      key: 'viewId',
      label: 'View (optional)',
      secret: false,
      required: false,
      type: 'string',
      placeholder: 'viwXXXXXXXXXXXXXX'
    },
    {
      key: 'webhookId',
      label: 'Webhook id (poll cursor stream)',
      secret: false,
      required: false,
      type: 'string',
      placeholder: 'achXXXXXXXXXXXXXX'
    },
    {
      key: 'pollSeconds',
      label: 'Poll cadence (seconds)',
      secret: false,
      required: false,
      type: 'number',
      placeholder: '60'
    },
    {
      key: 'environment',
      label: 'saiife environment (1-9)',
      secret: false,
      required: true,
      type: 'number'
    }
  ],
  // POLL-backed triggers — NOT webhook-payload (spec §3.1, §4). Each is a poll of
  // the `/payloads` cursor stream in `airtable-poller.ts`.
  triggers: [
    { id: AIRTABLE_TRIGGER_IDS[0], label: 'New record created' },
    { id: AIRTABLE_TRIGGER_IDS[1], label: 'Record changed' }
  ],
  actions: [
    // Reads (no gate — pure reads write facts for conditions, spec §3.2).
    { id: AIRTABLE_READ_ACTION_IDS[0], label: 'List records' },
    { id: AIRTABLE_READ_ACTION_IDS[1], label: 'Get a record' },
    // Gated writes — run ONLY because a flow action node reached them, behind the
    // author's gate (spec §3.2, §7.3).
    { id: AIRTABLE_WRITE_ACTION_IDS[0], label: 'Create a record' },
    { id: AIRTABLE_WRITE_ACTION_IDS[1], label: 'Update a record' }
  ]
}
