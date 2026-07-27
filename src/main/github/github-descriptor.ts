import type { IntegrationDescriptorDef } from '../../shared/integrations'
import {
  GITHUB_TRIGGER_IDS,
  GITHUB_READ_ACTION_IDS,
  GITHUB_WRITE_ACTION_IDS
} from '../../shared/github'

/**
 * GitHub connector config surface (§5). Secret fields (`pat`, `appPrivateKey`,
 * `webhookSecret`) route to the CredentialStore keychain and NEVER touch
 * config.json; non-secret refs (auth mode, App id/installation id, base URL,
 * owner/repo, environment, ingress url) are config-as-code. Trigger/action ids
 * are the pinned dev vocabulary (§6) the flow-templates track consumes verbatim
 * — a snapshot test guards them. Mirrors `shopify-descriptor.ts`.
 *
 * The `pat` / App-triple field requirements are CONDITIONAL on `authMode` (§5),
 * so they are marked `required: false` at the field level; the always-required
 * fields (`webhookSecret`, `owner`, `environment`, and the mode selector
 * `authMode`) drive the presence-derived `status()`.
 */
export const githubDescriptor: IntegrationDescriptorDef = {
  id: 'github',
  label: 'GitHub',
  configFields: [
    {
      key: 'authMode',
      label: 'Auth mode (app / pat)',
      secret: false,
      required: true,
      type: 'string',
      placeholder: 'pat'
    },
    {
      key: 'pat',
      label: 'Personal access token (fine-grained)',
      secret: true,
      required: false,
      type: 'string',
      placeholder: 'github_pat_…'
    },
    {
      key: 'appId',
      label: 'GitHub App id',
      secret: false,
      required: false,
      type: 'string'
    },
    {
      key: 'appPrivateKey',
      label: 'GitHub App private key (PEM)',
      secret: true,
      required: false,
      type: 'string'
    },
    {
      key: 'installationId',
      label: 'App installation id',
      secret: false,
      required: false,
      type: 'string'
    },
    {
      key: 'webhookSecret',
      label: 'Webhook signing secret',
      secret: true,
      required: true,
      type: 'string'
    },
    {
      key: 'baseUrl',
      label: 'API base URL (GHES)',
      secret: false,
      required: false,
      type: 'string',
      placeholder: 'https://api.github.com'
    },
    {
      key: 'owner',
      label: 'Default repo owner/org',
      secret: false,
      required: true,
      type: 'string',
      placeholder: 'acme'
    },
    {
      key: 'repo',
      label: 'Default repo',
      secret: false,
      required: false,
      type: 'string',
      placeholder: 'web'
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
      placeholder: 'https://<tunnel>/github/webhook'
    }
  ],
  triggers: [
    { id: GITHUB_TRIGGER_IDS[0], label: 'New issue opened' },
    { id: GITHUB_TRIGGER_IDS[1], label: 'Pull request opened' },
    { id: GITHUB_TRIGGER_IDS[2], label: 'A check failed' },
    { id: GITHUB_TRIGGER_IDS[3], label: 'A workflow run failed' }
  ],
  actions: [
    { id: GITHUB_READ_ACTION_IDS[0], label: 'Get an issue' },
    { id: GITHUB_READ_ACTION_IDS[1], label: 'Get a pull request' },
    { id: GITHUB_READ_ACTION_IDS[2], label: 'Get a check run' },
    { id: GITHUB_READ_ACTION_IDS[3], label: 'Search issues/PRs' },
    // Gated writes — run ONLY because a flow action node reached them (§9).
    { id: GITHUB_WRITE_ACTION_IDS[0], label: 'Comment on an issue/PR' },
    { id: GITHUB_WRITE_ACTION_IDS[1], label: 'Add labels' },
    { id: GITHUB_WRITE_ACTION_IDS[2], label: 'Create an issue' },
    { id: GITHUB_WRITE_ACTION_IDS[3], label: 'Close an issue' },
    { id: GITHUB_WRITE_ACTION_IDS[4], label: 'Open a pull request' },
    { id: GITHUB_WRITE_ACTION_IDS[5], label: 'Dispatch a workflow' },
    { id: GITHUB_WRITE_ACTION_IDS[6], label: 'Merge a pull request' }
  ]
}
