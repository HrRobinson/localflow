// Integrations Hub interface — CONSUMED by the Flow Engine, OWNED by
// sub-project #1 (the Integrations Hub). The type bodies below are pinned
// VERBATIM against #1's canonical file: keeping the text byte-identical lets
// the two branches reconcile cleanly at merge. The Flow Engine only reads
// this surface (validate node refs, subscribe to triggers, invoke actions) and
// writes no external-API code of its own.
//
// `cloud` is action-only — its descriptor carries an empty `triggers[]`, so a
// flow's trigger node is never `cloud`. `status()` is synchronous.

export type IntegrationId = 'linear' | 'email' | 'cloud'
export interface IntegrationConfigField {
  key: string
  label: string
  secret: boolean
  required: boolean
  placeholder?: string
}
export interface IntegrationDescriptor {
  id: IntegrationId
  label: string
  configFields: IntegrationConfigField[]
  triggers: { id: string; label: string }[]
  actions: { id: string; label: string }[]
  status(): 'connected' | 'needs-config' | 'error'
}
export interface IntegrationRegistry {
  descriptors(): IntegrationDescriptor[]
  get(id: IntegrationId): IntegrationDescriptor | undefined
  invokeAction(
    id: IntegrationId,
    actionId: string,
    params: Record<string, unknown>
  ): Promise<unknown>
  subscribe(id: IntegrationId, triggerId: string, handler: (event: unknown) => void): () => void
}
