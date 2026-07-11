import type { SessionInfo } from '../shared/types'
import type { PaneView } from '../shared/operator'

/** The slice of SessionManager the registry needs (kept narrow for testing). */
interface SessionSource {
  list(): SessionInfo[]
  get(id: string): SessionInfo | null
}

/** Project a session to its control-API view. */
export function toPaneView(info: SessionInfo): PaneView {
  return {
    handle: info.id,
    kind: info.kind,
    title: info.name,
    cwd: info.cwd,
    url: info.url,
    status: info.status
  }
}

/**
 * Assigns stable pane handles (a pane's handle IS its session id, already a
 * stable UUID) and — critically — resolves a handle ONLY within a given
 * environment. This is where the cross-environment isolation guarantee lives:
 * an operator granted on environment A can never resolve an environment-B
 * handle, no matter what string it sends.
 */
export class PaneRegistry {
  constructor(private source: SessionSource) {}

  /** Panes in `environment`, projected to control-API views. */
  list(environment: number): PaneView[] {
    return this.source
      .list()
      .filter((s) => s.environment === environment)
      .map(toPaneView)
  }

  /** The session for `handle` iff it lives in `environment`; else null. */
  resolve(handle: string, environment: number): SessionInfo | null {
    const s = this.source.get(handle)
    return s && s.environment === environment ? s : null
  }
}
