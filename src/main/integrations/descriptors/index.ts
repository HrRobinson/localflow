import type { IntegrationDescriptorDef, IntegrationId } from '../../../shared/integrations'
import { INTEGRATION_IDS } from '../../../shared/integrations'
import { linearDescriptor } from './linear'
import { emailDescriptor } from './email'
import { cloudDescriptor } from './cloud'
import { shopifyDescriptor } from '../../shopify/shopify-descriptor'
import { woocommerceDescriptor } from './woocommerce'
import { posthogDescriptor } from './posthog'
import { gitlabDescriptor } from './gitlab'
import { slackDescriptor } from '../../slack/slack-descriptor'
import { httpDescriptor } from '../../http/http-descriptor'
import { stripeDescriptor } from '../../stripe/stripe-descriptor'
import { githubDescriptor } from '../../github/github-descriptor'
import { sentryDescriptor } from '../../sentry/sentry-descriptor'
import { hubspotDescriptor } from '../../hubspot/hubspot-descriptor'
import { airtableDescriptor } from '../../airtable/airtable-descriptor'
import { discordDescriptor } from '../../discord/discord-descriptor'
import { intercomDescriptor } from '../../intercom/intercom-descriptor'
import { pagerdutyDescriptor } from '../../pagerduty/pagerduty-descriptor'
import { salesforceDescriptor } from '../../salesforce/salesforce-descriptor'
import { segmentDescriptor } from '../../segment/segment-descriptor'
import { zendeskDescriptor } from '../../zendesk/zendesk-descriptor'

/** The static descriptor defs, keyed by id. The registry composes the full
 * `IntegrationDescriptor` (attaching `status()`) from these. */
export const DESCRIPTOR_DEFS: Record<IntegrationId, IntegrationDescriptorDef> = {
  linear: linearDescriptor,
  email: emailDescriptor,
  cloud: cloudDescriptor,
  shopify: shopifyDescriptor,
  woocommerce: woocommerceDescriptor,
  posthog: posthogDescriptor,
  gitlab: gitlabDescriptor,
  slack: slackDescriptor,
  http: httpDescriptor,
  stripe: stripeDescriptor,
  github: githubDescriptor,
  sentry: sentryDescriptor,
  hubspot: hubspotDescriptor,
  airtable: airtableDescriptor,
  discord: discordDescriptor,
  intercom: intercomDescriptor,
  pagerduty: pagerdutyDescriptor,
  salesforce: salesforceDescriptor,
  segment: segmentDescriptor,
  zendesk: zendeskDescriptor
}

/** In the pinned stable order (§11) sub-projects 2/3 rely on. */
export const descriptorDefs: IntegrationDescriptorDef[] = INTEGRATION_IDS.map(
  (id) => DESCRIPTOR_DEFS[id]
)
