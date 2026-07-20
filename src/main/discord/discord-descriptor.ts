import type { IntegrationDescriptorDef } from '../../shared/integrations'
import { DISCORD_TRIGGER_IDS, DISCORD_ACTION_IDS } from '../../shared/discord'

/**
 * Discord connector config surface (spec §5). The ONE secret (`botToken`) routes
 * to the CredentialStore keychain and NEVER touches config.json; non-secret refs
 * (guild, channel, application id, PUBLIC key, mode, environment, ingress url)
 * are config-as-code. Trigger/action ids are the pinned Discord vocabulary (§6)
 * the flow-templates track consumes verbatim — a snapshot test guards them.
 * Mirrors `slack-descriptor.ts`.
 *
 * NOTE the asymmetry vs Slack (§5, §8): Discord needs ONE secret (the bot
 * token). The interaction `publicKey` is a PUBLIC Ed25519 key, so it is NOT
 * secret and lives in config; it is conditionally required by `mode: 'http'`, so
 * the static `required` flag stays `false` and a thin Discord-specific readiness
 * check owns the mode-conditional requirement (§13.7) — the shared hub schema is
 * untouched.
 */
export const discordDescriptor: IntegrationDescriptorDef = {
  id: 'discord',
  label: 'Discord',
  configFields: [
    {
      key: 'botToken',
      label: 'Discord bot token',
      secret: true,
      required: true,
      type: 'string',
      placeholder: 'the bot token from the Developer Portal'
    },
    {
      key: 'guildId',
      label: 'Server (guild) id',
      secret: false,
      required: true,
      type: 'string',
      placeholder: 'a server snowflake'
    },
    {
      key: 'defaultChannel',
      label: 'Approvals / notify channel',
      secret: false,
      required: true,
      type: 'string',
      placeholder: 'a channel snowflake'
    },
    {
      key: 'applicationId',
      label: 'Application id',
      secret: false,
      required: false,
      type: 'string'
    },
    {
      key: 'publicKey',
      label: 'Application public key',
      secret: false,
      required: false,
      type: 'string'
    },
    {
      key: 'mode',
      label: 'Ingress mode',
      secret: false,
      required: false,
      type: 'string',
      placeholder: 'gateway'
    },
    {
      key: 'environment',
      label: 'localflow environment (1-9)',
      secret: false,
      required: true,
      type: 'number'
    },
    {
      key: 'interactionsUrl',
      label: 'Interactions endpoint URL',
      secret: false,
      required: false,
      type: 'string',
      placeholder: 'https://<tunnel>/discord/interactions'
    }
  ],
  triggers: [
    { id: DISCORD_TRIGGER_IDS[0], label: 'Message received' },
    { id: DISCORD_TRIGGER_IDS[1], label: 'Interaction' },
    { id: DISCORD_TRIGGER_IDS[2], label: 'Approval responded' }
  ],
  actions: [
    { id: DISCORD_ACTION_IDS[0], label: 'Post a message' },
    { id: DISCORD_ACTION_IDS[1], label: 'Post an approval and await' },
    { id: DISCORD_ACTION_IDS[2], label: 'Reply in a thread' }
  ]
}
