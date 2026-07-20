import type { IntegrationDescriptorDef } from '../../shared/integrations'

/**
 * Salesforce connector config surface (spec §5, §6). The MVP auth fork pins
 * client-credentials (spec §13.1), so the required secret is the connected-app
 * consumer secret (`clientSecret`) → the CredentialStore keychain; the JWT
 * private key (`privateKey`) is the designed-for alternate fork behind the same
 * `salesforce-auth` seam (optional at the field level, spec §8). Every non-secret
 * ref (client id, login/instance URL, integration username, api version) → the
 * config.json `salesforce` block. The instance/login URL is user-supplied → run
 * through the shared SSRF guard (spec §4.4). Field/trigger/action ids are the
 * CONTRACT the flow engine/canvas + the templates track consume verbatim
 * (spec §6) — a snapshot test guards them.
 */
export const salesforceDescriptor: IntegrationDescriptorDef = {
  id: 'salesforce',
  label: 'Salesforce',
  configFields: [
    {
      key: 'clientSecret',
      label: 'Connected-app consumer secret',
      secret: true,
      required: true,
      type: 'string'
    },
    {
      key: 'privateKey',
      label: 'Connected-app JWT private key (PEM)',
      secret: true,
      required: false,
      type: 'string'
    },
    {
      key: 'clientId',
      label: 'Connected-app consumer key (client id)',
      secret: false,
      required: true,
      type: 'string'
    },
    {
      key: 'loginUrl',
      label: 'Login / token host (https://…)',
      secret: false,
      required: true,
      type: 'string',
      placeholder: 'https://login.salesforce.com'
    },
    {
      key: 'instanceUrl',
      label: 'Org instance URL (https://…)',
      secret: false,
      required: false,
      type: 'string',
      placeholder: 'https://acme.my.salesforce.com'
    },
    {
      key: 'username',
      label: 'Integration User username',
      secret: false,
      required: false,
      type: 'string'
    },
    {
      key: 'apiVersion',
      label: 'REST API version',
      secret: false,
      required: false,
      type: 'string',
      placeholder: 'v62.0'
    },
    {
      key: 'defaultObject',
      label: 'Default sObject for triggers',
      secret: false,
      required: false,
      type: 'string',
      placeholder: 'Lead'
    },
    {
      key: 'pollSeconds',
      label: 'Poll cadence (seconds)',
      secret: false,
      required: false,
      type: 'number',
      placeholder: '120'
    },
    {
      key: 'environment',
      label: 'localflow environment (1-9)',
      secret: false,
      required: true,
      type: 'number'
    }
  ],
  // POLLED triggers — not webhooks (spec §6.1, §7). Both share the one SOQL
  // reconcile backbone in `salesforce-poller.ts`, differing only in the timestamp
  // field they cursor on (`CreatedDate` vs `LastModifiedDate`).
  triggers: [
    { id: 'record.created', label: 'New record created' },
    { id: 'record.updated', label: 'Record created or modified' }
  ],
  actions: [
    // Reads (no gate — pure reads write facts for conditions, spec §6.2).
    { id: 'query', label: 'Run a SOQL query' },
    { id: 'getRecord', label: 'Get a record' },
    // Gated writes — run ONLY because a flow action node reached them, behind the
    // author's gate (spec §6.2, §9). `submitForApproval` additionally hands the
    // human decision to the org's native Approval Process (the distinctive fit).
    { id: 'createRecord', label: 'Create a record' },
    { id: 'createTask', label: 'Create a follow-up Task' },
    { id: 'updateRecord', label: 'Update a record' },
    { id: 'submitForApproval', label: "Submit to the org's Approval Process" }
  ]
}
