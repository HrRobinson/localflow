import type { FlowNode } from '../../../shared/flows'
import type { IntegrationRegistry } from '../../../shared/integrations'
import type { RunContext } from '../context'
import { templateParams } from '../context'
import type { NodeOutcome } from '../types'

export interface ActionRunnerDeps {
  registry: IntegrationRegistry
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * Runs an `action` node: `registry.invokeAction(integration, ref, params)` with
 * params templated from run context, writing the returned output into context
 * under the node id. A not-connected integration fails the node BEFORE any call
 * (never a silent no-op), and a rejected `invokeAction` forwards the REAL
 * exception message rather than minting a vaguer one (design §3.3, §9).
 */
export async function runAction(
  deps: ActionRunnerDeps,
  node: FlowNode,
  context: RunContext
): Promise<NodeOutcome> {
  const integrationId = node.integration
  const actionId = node.ref
  if (!integrationId || !actionId) {
    return {
      status: 'failed',
      message: `Flow node '${node.id}' is misconfigured: an action node needs an integration and a ref.`
    }
  }

  const descriptor = deps.registry.get(integrationId)
  if (!descriptor) {
    return {
      status: 'failed',
      message: `Flow node '${node.id}' targets an unknown integration '${integrationId}'.`
    }
  }
  if (descriptor.status() !== 'connected') {
    return {
      status: 'failed',
      message: `Flow needs ${descriptor.label} connected — action '${actionId}' can't run. Connect it in Settings.`
    }
  }

  const rawParams = isObject(node.config.params) ? node.config.params : node.config
  const params = templateParams(rawParams, context)
  try {
    // FAILURE CONVENTION: an action signals failure by REJECTING the promise
    // (throwing). A resolved promise — ANY value, including `undefined` — is
    // treated as SUCCESS here (its value becomes the node's context output).
    // This matches the pinned `IntegrationRegistry.invokeAction(): Promise<unknown>`
    // contract; a connector that wants to fail must throw, never resolve a
    // sentinel this runner would have to special-case.
    const output = await deps.registry.invokeAction(integrationId, actionId, params)
    return { status: 'done', context: { [node.id]: output } }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    return {
      status: 'failed',
      message: `Flow action '${actionId}' on ${descriptor.label} failed: ${detail}`
    }
  }
}
