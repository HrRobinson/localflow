import type { IntegrationDescriptorDef } from '../../../shared/integrations'

/**
 * Cloud (AWS) connector config surface (spec §7). The keyless model holds NO
 * long-lived secret, so `configFields` is entirely non-secret and `status()`
 * means "the required identity refs are present" — the all-non-secret case the
 * descriptor model deliberately supports (§3). Cloud is action-only: no
 * triggers in MVP.
 */
export const cloudDescriptor: IntegrationDescriptorDef = {
  id: 'cloud',
  label: 'Cloud (AWS)',
  configFields: [
    {
      key: 'roleArn',
      label: 'Sandbox role ARN',
      secret: false,
      required: true,
      type: 'string',
      placeholder: 'arn:aws:iam::<acct>:role/saiife-agent-sandbox'
    },
    {
      key: 'externalId',
      label: 'External id (non-secret)',
      secret: false,
      required: true,
      type: 'string'
    },
    {
      key: 'region',
      label: 'AWS region',
      secret: false,
      required: true,
      type: 'string',
      placeholder: 'us-east-1'
    },
    {
      key: 'sandboxAccountId',
      label: 'Sandbox account id',
      secret: false,
      required: false,
      type: 'string'
    },
    {
      key: 'durationSeconds',
      label: 'Session duration (≤1800)',
      secret: false,
      required: false,
      type: 'number'
    },
    {
      key: 'packs',
      label: 'saiifeguard packs (comma-separated)',
      secret: false,
      required: false,
      type: 'string[]'
    }
  ],
  triggers: [],
  actions: [
    { id: 'mintCredential', label: 'Assume the sandbox role' },
    { id: 'terraform.plan', label: 'Run a plan' },
    { id: 'terraform.applyApproved', label: 'Apply an approved plan' }
  ]
}
