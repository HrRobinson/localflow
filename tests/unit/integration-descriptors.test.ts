import { describe, it, expect } from 'vitest'
import { descriptorDefs, DESCRIPTOR_DEFS } from '../../src/main/integrations/descriptors'
import { INTEGRATION_IDS } from '../../src/shared/integrations'

describe('integration descriptors', () => {
  it('exposes all ids in the pinned stable order', () => {
    expect(descriptorDefs.map((d) => d.id)).toEqual([
      'linear',
      'email',
      'cloud',
      'shopify',
      'woocommerce',
      'posthog',
      'gitlab',
      'slack',
      'http',
      'stripe',
      'github',
      'sentry',
      'hubspot',
      'segment'
    ])
    expect([...INTEGRATION_IDS]).toEqual([
      'linear',
      'email',
      'cloud',
      'shopify',
      'woocommerce',
      'posthog',
      'gitlab',
      'slack',
      'http',
      'stripe',
      'github',
      'sentry',
      'hubspot',
      'segment'
    ])
  })

  it('marks the exact secret fields per §7', () => {
    const secretKeys = (id: (typeof INTEGRATION_IDS)[number]): string[] =>
      DESCRIPTOR_DEFS[id].configFields.filter((f) => f.secret).map((f) => f.key)
    expect(secretKeys('linear')).toEqual(['oauthToken', 'webhookSecret'])
    expect(secretKeys('email')).toEqual(['refreshToken', 'clientSecret'])
    expect(secretKeys('cloud')).toEqual([]) // keyless model — zero secret fields
    // WooCommerce: consumer key/secret + webhook secret are keychain-only; the
    // store URL is a non-secret ref (spec §5).
    expect(secretKeys('woocommerce')).toEqual(['consumerKey', 'consumerSecret', 'webhookSecret'])
    // PostHog: ONLY the personal API key is a secret; the project key + host are
    // non-secret refs (spec §8).
    expect(secretKeys('posthog')).toEqual(['personalApiKey'])
    // HTTP owns NO per-id secret — every secret is PER NODE, in the keychain
    // under the composite key `http:<nodeId>:<secretRef>` (§7).
    expect(secretKeys('http')).toEqual([])
    // GitHub: the PAT, the App private key, and the webhook secret are keychain-
    // only; auth mode / App id / installation id / base URL / owner are refs (§5).
    expect(secretKeys('github')).toEqual(['pat', 'appPrivateKey', 'webhookSecret'])
    // Sentry: bearer token + webhook Client Secret are keychain-only; the org/
    // project slugs and self-host baseUrl are non-secret refs (spec §5, §8).
    expect(secretKeys('sentry')).toEqual(['authToken', 'webhookSecret'])
  })

  it('marks the exact required fields per §7', () => {
    const requiredKeys = (id: (typeof INTEGRATION_IDS)[number]): string[] =>
      DESCRIPTOR_DEFS[id].configFields.filter((f) => f.required).map((f) => f.key)
    expect(requiredKeys('linear')).toEqual([
      'oauthToken',
      'webhookSecret',
      'workspaceId',
      'environment'
    ])
    expect(requiredKeys('email')).toEqual(['refreshToken', 'address', 'oauthAppRef', 'environment'])
    expect(requiredKeys('cloud')).toEqual(['roleArn', 'externalId', 'region'])
    expect(requiredKeys('woocommerce')).toEqual([
      'storeUrl',
      'consumerKey',
      'consumerSecret',
      'webhookSecret',
      'environment'
    ])
    // PostHog: personal key + project key + host + environment; pollSeconds is
    // optional (defaults in the poller, spec §7.3).
    expect(requiredKeys('posthog')).toEqual([
      'personalApiKey',
      'projectApiKey',
      'host',
      'environment'
    ])
    expect(requiredKeys('http')).toEqual(['environment'])
    // GitHub: the auth-mode selector + the always-required webhook secret, owner,
    // and environment. The mode-specific secrets (pat / App triple) are
    // conditional on `authMode`, so `required: false` at the field level (§5).
    expect(requiredKeys('github')).toEqual(['authMode', 'webhookSecret', 'owner', 'environment'])
    expect(requiredKeys('sentry')).toEqual(['authToken', 'webhookSecret', 'orgSlug', 'environment'])
  })

  it('leaves cloud action-only (no triggers) and keeps trigger/action ids stable', () => {
    expect(DESCRIPTOR_DEFS.cloud.triggers).toEqual([])
    // Snapshot the flow-facing surface 2/3 consume.
    const surface = descriptorDefs.map((d) => ({
      id: d.id,
      triggers: d.triggers.map((t) => t.id),
      actions: d.actions.map((a) => a.id)
    }))
    expect(surface).toEqual([
      {
        id: 'linear',
        triggers: ['issue.delegated', 'issue.prompted'],
        actions: ['activity.emit', 'issue.updateState', 'comment.create', 'issue.reassign']
      },
      {
        id: 'email',
        triggers: ['mail.received'],
        actions: ['draft.create', 'draft.send', 'label.apply']
      },
      {
        id: 'cloud',
        triggers: [],
        actions: ['mintCredential', 'terraform.plan', 'terraform.applyApproved']
      },
      {
        id: 'shopify',
        triggers: ['order.created', 'order.refundRequested', 'order.flagged'],
        actions: [
          'getOrder',
          'getCustomer',
          'searchOrders',
          'refundOrder',
          'cancelOrder',
          'updateShippingAddress',
          'addOrderNote'
        ]
      },
      {
        id: 'woocommerce',
        triggers: ['order.created', 'order.refundRequested'],
        actions: [
          'getOrder',
          'getCustomer',
          'searchOrders',
          'refundOrder',
          'cancelOrder',
          'updateShippingAddress',
          'addOrderNote'
        ]
      },
      {
        id: 'posthog',
        // POLLED triggers — not webhooks (spec §6.1, §7).
        triggers: ['event.matched', 'cohort.entered', 'insight.threshold'],
        actions: ['queryEvents', 'getInsight', 'getFeatureFlag', 'getCohort', 'updateFeatureFlag']
      },
      {
        id: 'gitlab',
        triggers: ['issue.opened', 'mr.opened', 'pipeline.failed'],
        actions: [
          'getIssue',
          'getMR',
          'getPipeline',
          'searchIssues',
          'commentIssue',
          'labelIssue',
          'createIssue',
          'openMR',
          'mergeMR'
        ]
      },
      {
        id: 'slack',
        triggers: ['message.received', 'slash.command', 'approval.responded'],
        actions: ['postMessage', 'postApproval', 'replyInThread']
      },
      {
        id: 'http',
        triggers: ['webhook.received'],
        actions: ['http.get', 'http.send']
      },
      {
        id: 'stripe',
        triggers: ['charge.dispute.created', 'charge.refunded', 'invoice.payment_failed'],
        actions: [
          'getCharge',
          'getCustomer',
          'getDispute',
          'getSubscription',
          'createRefund',
          'respondToDispute',
          'cancelSubscription'
        ]
      },
      {
        id: 'github',
        triggers: ['issue.opened', 'pr.opened', 'check.failed', 'workflow.failed'],
        actions: [
          'getIssue',
          'getPR',
          'getCheckRun',
          'searchIssues',
          'commentIssue',
          'labelIssue',
          'createIssue',
          'closeIssue',
          'openPR',
          'dispatchWorkflow',
          'mergePR'
        ]
      },
      {
        id: 'sentry',
        triggers: ['issue.created', 'issue.regressed', 'alert.triggered'],
        actions: [
          'getIssue',
          'getEvent',
          'searchIssues',
          'resolveIssue',
          'assignIssue',
          'ignoreIssue',
          'commentIssue'
        ]
      },
      {
        id: 'hubspot',
        triggers: ['contact.created', 'deal.stageChanged', 'form.submitted'],
        actions: [
          'getContact',
          'getDeal',
          'getCompany',
          'searchContacts',
          'createContact',
          'updateDeal',
          'logActivity',
          'createTask'
        ]
      },
      {
        id: 'segment',
        triggers: ['event.tracked'],
        actions: ['track', 'identify']
      }
    ])
  })

  it('gives every field a valid FieldType', () => {
    for (const def of descriptorDefs) {
      for (const f of def.configFields) {
        expect(['string', 'string[]', 'number']).toContain(f.type)
      }
    }
  })
})
