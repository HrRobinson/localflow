import type { IntegrationDescriptorDef } from '../../../shared/integrations'

/**
 * Email (Gmail) connector config surface (spec §7). `refreshToken` (and the
 * optional desktop `clientSecret`) route to the keychain; the mailbox address
 * and OAuth client NAME (not its secret) to config.json.
 */
export const emailDescriptor: IntegrationDescriptorDef = {
  id: 'email',
  label: 'Email',
  configFields: [
    {
      key: 'refreshToken',
      label: 'Gmail OAuth refresh token',
      secret: true,
      required: true,
      type: 'string'
    },
    {
      key: 'clientSecret',
      label: 'OAuth client secret (if desktop client)',
      secret: true,
      required: false,
      type: 'string'
    },
    {
      key: 'address',
      label: 'Mailbox address',
      secret: false,
      required: true,
      type: 'string',
      placeholder: 'me@example.com'
    },
    {
      key: 'oauthAppRef',
      label: 'OAuth client name',
      secret: false,
      required: true,
      type: 'string',
      placeholder: 'gmail-desktop'
    },
    {
      key: 'environment',
      label: 'localflow environment (1-9)',
      secret: false,
      required: true,
      type: 'number'
    },
    {
      key: 'scopeQuery',
      label: 'In-scope search filter',
      secret: false,
      required: false,
      type: 'string',
      placeholder: 'is:unread -category:promotions'
    }
  ],
  triggers: [{ id: 'mail.received', label: 'New mail in scope arrives' }],
  actions: [
    { id: 'draft.create', label: 'Draft a reply' },
    { id: 'draft.send', label: 'Send an approved draft' },
    { id: 'label.apply', label: 'Label / archive' }
  ]
}
