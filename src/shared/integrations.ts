// Pinned interface owned by sub-project #1 (Integrations Hub), CONSUMED by the
// Flow Canvas (#3). The `IntegrationId` / `IntegrationDescriptor` block below is
// declared VERBATIM (per the cross-project contract) so the three branches
// reconcile cleanly at merge — the canvas depends only on this shape.
//
// Until #1 lands, this file also carries a fixture registry (§9 of the flow-
// builder-canvas design): a stub `descriptors()` returning `linear` / `email` /
// `cloud`. When #1 ships, the type block stays and the fixture is deleted (the
// real Hub owns the registry); the canvas — which reads the registry only over
// the `integration:list` IPC seam — needs no change.

// --- PINNED (verbatim) -------------------------------------------------------
export type IntegrationId = 'linear' | 'email' | 'cloud'
export interface IntegrationDescriptor {
  id: IntegrationId
  label: string
  configFields: { key: string; label: string; secret: boolean; required: boolean; placeholder?: string }[]
  triggers: { id: string; label: string }[]
  actions: { id: string; label: string }[]
  status(): 'connected' | 'needs-config' | 'error'
}
// --- /PINNED -----------------------------------------------------------------

/** The connectedness a descriptor's `status()` reports. Named for reuse in the
 *  resolved-over-IPC shape and in validation. */
export type IntegrationStatus = 'connected' | 'needs-config' | 'error'

/**
 * `status()` is a method on the descriptor (§8), but a method cannot survive
 * structured-clone across the IPC boundary. The renderer therefore receives the
 * descriptor with `status` already RESOLVED to a value at fetch time. Both
 * `flow-palette.ts` and `flow-validate.ts` accept this resolved shape.
 */
export type ResolvedIntegrationDescriptor = Omit<IntegrationDescriptor, 'status'> & {
  status: IntegrationStatus
}

/** Resolve each descriptor's `status()` method to a plain value for transport. */
export function resolveDescriptors(
  descriptors: IntegrationDescriptor[]
): ResolvedIntegrationDescriptor[] {
  return descriptors.map(({ status, ...rest }) => ({ ...rest, status: status() }))
}

/**
 * FIXTURE registry (stub for #1). Two triggers/actions each for `linear` and
 * `email`; `cloud` is deliberately ACTION-ONLY (no triggers) — it exercises the
 * palette's "an integration may contribute only actions" path. Every fixture
 * reports `needs-config` so the "needs setup" palette marking and the
 * `integration-not-connected` validation rule are both live in a fresh install.
 */
export function fixtureIntegrationRegistry(): IntegrationDescriptor[] {
  return [
    {
      id: 'linear',
      label: 'Linear',
      configFields: [
        { key: 'apiKey', label: 'API key', secret: true, required: true },
        { key: 'team', label: 'Team', secret: false, required: true, placeholder: 'ENG' }
      ],
      triggers: [
        { id: 'issue.created', label: 'Issue created' },
        { id: 'issue.status_changed', label: 'Issue status changed' }
      ],
      actions: [
        { id: 'issue.create', label: 'Create issue' },
        { id: 'issue.comment', label: 'Comment on issue' }
      ],
      status: () => 'needs-config'
    },
    {
      id: 'email',
      label: 'Email',
      configFields: [
        { key: 'smtpUrl', label: 'SMTP URL', secret: true, required: true },
        { key: 'from', label: 'From address', secret: false, required: true, placeholder: 'you@example.com' }
      ],
      triggers: [{ id: 'message.received', label: 'Message received' }],
      actions: [{ id: 'message.send', label: 'Send email' }],
      status: () => 'needs-config'
    },
    {
      id: 'cloud',
      label: 'Cloud',
      configFields: [
        { key: 'serviceAccount', label: 'Service account JSON', secret: true, required: true },
        { key: 'project', label: 'Project id', secret: false, required: true, placeholder: 'my-project' }
      ],
      triggers: [],
      actions: [
        { id: 'run.deploy', label: 'Deploy service' },
        { id: 'run.job', label: 'Run job' }
      ],
      status: () => 'needs-config'
    }
  ]
}
