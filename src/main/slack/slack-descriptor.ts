import type { IntegrationDescriptorDef } from '../../shared/integrations'
import { SLACK_TRIGGER_IDS, SLACK_ACTION_IDS } from '../../shared/slack'

/**
 * Slack connector config surface (spec §5). Secret fields (`botToken`,
 * `appToken`, `signingSecret`) route to the CredentialStore keychain and NEVER
 * touch config.json; non-secret refs (default channel, ingress mode,
 * environment, events url) are config-as-code. Trigger/action ids are the pinned
 * Slack vocabulary (§6) the flow-templates track consumes verbatim — a snapshot
 * test guards them. Mirrors `shopify-descriptor.ts`.
 *
 * NOTE on the two `no*` secrets (§5): `appToken` (Socket Mode) and
 * `signingSecret` (Events mode) are conditionally required by `mode`; the static
 * `required` flag stays `false` and a thin Slack-specific readiness check owns
 * the mode-conditional requirement (§13.6) so the shared hub schema is untouched.
 */
export const slackDescriptor: IntegrationDescriptorDef = {
  id: 'slack',
  label: 'Slack',
  configFields: [
    {
      key: 'botToken',
      label: 'Slack bot token',
      secret: true,
      required: true,
      type: 'string',
      placeholder: 'xoxb-…'
    },
    {
      key: 'appToken',
      label: 'Slack app-level token',
      secret: true,
      required: false,
      type: 'string',
      placeholder: 'xapp-…'
    },
    {
      key: 'signingSecret',
      label: 'Signing secret',
      secret: true,
      required: false,
      type: 'string'
    },
    {
      key: 'defaultChannel',
      label: 'Approvals / notify channel',
      secret: false,
      required: true,
      type: 'string',
      placeholder: 'C0123ABCD or #approvals'
    },
    {
      key: 'mode',
      label: 'Ingress mode',
      secret: false,
      required: false,
      type: 'string',
      placeholder: 'socket'
    },
    {
      key: 'environment',
      label: 'localflow environment (1-9)',
      secret: false,
      required: true,
      type: 'number'
    },
    {
      key: 'eventsUrl',
      label: 'Events request URL',
      secret: false,
      required: false,
      type: 'string',
      placeholder: 'https://<tunnel>/slack/events'
    }
  ],
  triggers: [
    { id: SLACK_TRIGGER_IDS[0], label: 'Message received' },
    { id: SLACK_TRIGGER_IDS[1], label: 'Slash command' },
    { id: SLACK_TRIGGER_IDS[2], label: 'Approval responded' }
  ],
  actions: [
    { id: SLACK_ACTION_IDS[0], label: 'Post a message' },
    { id: SLACK_ACTION_IDS[1], label: 'Post an approval and await' },
    { id: SLACK_ACTION_IDS[2], label: 'Reply in a thread' }
  ]
}
