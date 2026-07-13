import { homedir } from 'node:os'
import type { AddPaneRequest, AgentId, SessionInfo } from '../shared/types'
import type { SessionManager, SpawnSpec } from './session-manager'
import { normalizeHttpUrl } from '../shared/urls'

// Re-exported so callers only need one import path (this module owns the
// operation); the canonical definition lives in shared/types.ts because
// api.ts/preload (renderer-visible) also need the shape.
export type { AddPaneRequest }

/**
 * Adds a companion pane next to `sourcePaneId`: reuses its group, or wraps a
 * solo source into a fresh group named after it. cwd/environment come from
 * the SOURCE RECORD, never from the caller. Returns the new pane or null
 * (unknown source, invalid request).
 */
export function addCompanionPane(
  manager: SessionManager,
  specFor: (agentId: AgentId, customCommand?: string) => SpawnSpec,
  sourcePaneId: string,
  req: AddPaneRequest
): SessionInfo | null {
  const source = manager.get(sourcePaneId)
  if (!source) return null
  // Validate the request BEFORE touching group state — an invalid request
  // (e.g. a bad browser URL) must be a pure no-op, not leave the source
  // wrapped in a freshly minted group with nothing added to it.
  if (req.kind === 'browser' && normalizeHttpUrl(req.url) === null) return null
  if (req.kind !== 'terminal' && req.kind !== 'browser') return null

  const groupId = source.groupId ?? manager.createGroup(source.name, source.environment).id
  if (!source.groupId) {
    manager.assignToGroup(source.id, groupId)
  }

  const companion =
    req.kind === 'terminal'
      ? // Browser sources have no cwd; a terminal companion falls back to the
        // user's home directory rather than spawning at ''.
        manager.create(
          source.cwd || homedir(),
          specFor(req.agentId, req.customCommand),
          source.environment
        )
      : manager.createBrowser(req.url, source.environment)

  const grouped = manager.assignToGroup(companion.id, groupId)
  return grouped ?? companion
}
