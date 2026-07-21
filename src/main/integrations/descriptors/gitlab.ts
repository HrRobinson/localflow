import type { IntegrationDescriptorDef } from '../../../shared/integrations'

/**
 * GitLab connector config surface (spec §8). Secrets route to the CredentialStore
 * keychain (the PAT + the webhook secret — never config.json, §5); non-secret
 * refs to config.json. Field/trigger/action ids are the contract the flow
 * engine/canvas + the templates track depend on — kept PARALLEL to the GitHub
 * sibling where semantics match (PR→MR the one systematic rename, §6) — and a
 * snapshot test guards them.
 */
export const gitlabDescriptor: IntegrationDescriptorDef = {
  id: 'gitlab',
  label: 'GitLab',
  configFields: [
    {
      key: 'personalAccessToken',
      label: 'GitLab access token (PAT)',
      secret: true,
      required: true,
      type: 'string',
      placeholder: 'glpat-…'
    },
    {
      key: 'webhookSecret',
      label: 'Webhook secret token',
      secret: true,
      required: true,
      type: 'string'
    },
    {
      key: 'baseUrl',
      label: 'GitLab base URL',
      secret: false,
      required: true,
      type: 'string',
      placeholder: 'https://gitlab.com'
    },
    {
      key: 'projectPath',
      label: 'Project (path or id)',
      secret: false,
      required: true,
      type: 'string',
      placeholder: 'group/project'
    },
    {
      key: 'environment',
      label: 'saiife environment (1-9)',
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
      placeholder: '/gitlab/<random>'
    },
    {
      key: 'webhookUrl',
      label: 'Ingress webhook URL',
      secret: false,
      required: false,
      type: 'string',
      placeholder: 'https://<tunnel-or-lan>/gitlab/<random>'
    }
  ],
  triggers: [
    { id: 'issue.opened', label: 'Issue opened' },
    { id: 'mr.opened', label: 'Merge request opened' },
    { id: 'pipeline.failed', label: 'Pipeline failed' }
  ],
  actions: [
    // Reads — pure reads that write facts for conditions (§6.2).
    { id: 'getIssue', label: 'Get an issue' },
    { id: 'getMR', label: 'Get a merge request' },
    { id: 'getPipeline', label: 'Get a pipeline' },
    { id: 'searchIssues', label: 'Search issues' },
    // Gated writes — run ONLY because a flow action node reached them; `mergeMR`
    // MUST be gated (§9).
    { id: 'commentIssue', label: 'Comment on an issue' },
    { id: 'labelIssue', label: 'Set issue labels' },
    { id: 'createIssue', label: 'Create an issue' },
    { id: 'openMR', label: 'Open a merge request' },
    { id: 'mergeMR', label: 'Merge a merge request' }
  ]
}
