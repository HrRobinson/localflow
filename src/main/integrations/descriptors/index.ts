import type { IntegrationDescriptorDef, IntegrationId } from '../../../shared/integrations'
import { INTEGRATION_IDS } from '../../../shared/integrations'
import { linearDescriptor } from './linear'
import { emailDescriptor } from './email'
import { cloudDescriptor } from './cloud'

/** The three static descriptor defs, keyed by id. The registry composes the
 * full `IntegrationDescriptor` (attaching `status()`) from these. */
export const DESCRIPTOR_DEFS: Record<IntegrationId, IntegrationDescriptorDef> = {
  linear: linearDescriptor,
  email: emailDescriptor,
  cloud: cloudDescriptor
}

/** In the pinned stable order (§11) sub-projects 2/3 rely on. */
export const descriptorDefs: IntegrationDescriptorDef[] = INTEGRATION_IDS.map(
  (id) => DESCRIPTOR_DEFS[id]
)
