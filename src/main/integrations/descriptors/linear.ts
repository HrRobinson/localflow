import type { IntegrationDescriptorDef } from '../../../shared/integrations'

/**
 * Linear connector config surface (spec §7). Secret fields route to the
 * CredentialStore keychain; non-secret refs to config.json. Field/trigger/
 * action ids are the contract sub-projects 2/3 depend on — a snapshot test
 * guards them.
 */
export const linearDescriptor: IntegrationDescriptorDef = {
  id: 'linear',
  label: 'Linear',
  configFields: [
    {
      key: 'oauthToken',
      label: 'Linear access token',
      secret: true,
      required: true,
      type: 'string',
      placeholder: 'lin_oauth_… (interim: a personal API key)'
    },
    {
      key: 'webhookSecret',
      label: 'Webhook signing secret',
      secret: true,
      required: true,
      type: 'string'
    },
    {
      key: 'workspaceId',
      label: 'Workspace / org id',
      secret: false,
      required: true,
      type: 'string'
    },
    {
      key: 'teamIds',
      label: 'Team ids (comma-separated)',
      secret: false,
      required: false,
      type: 'string[]'
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
      placeholder: 'https://<tunnel>/linear/webhook'
    }
  ],
  triggers: [
    { id: 'issue.delegated', label: 'Issue delegated to saiife' },
    { id: 'issue.prompted', label: 'Human replied in the issue' }
  ],
  actions: [
    { id: 'activity.emit', label: 'Post agent activity' },
    { id: 'issue.updateState', label: 'Move issue to a workflow state' },
    { id: 'comment.create', label: 'Comment on the issue' },
    { id: 'issue.reassign', label: 'Reassign the issue' }
  ]
}
