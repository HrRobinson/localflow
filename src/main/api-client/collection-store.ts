import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import type { Collection } from '../../shared/api-client'

/**
 * Non-secret collection data (design §1), persisted as JSON in userData. Holds
 * NO secret — only `auth.secretRef`, a keychain field NAME.
 *
 * `get`/`list`/`remove` are ENVIRONMENT-SCOPED: a collection is invisible —
 * and, for `remove`, untouchable — outside its owning environment, so a
 * caller scoped to environment A can never read OR delete a collection owned
 * by B. This is the M3.5 isolation guarantee applied to credentials, enforced
 * in the store rather than the UI.
 */
export class CollectionStore {
  private readonly file: string
  private map: Record<string, Collection>

  constructor(deps: { file: string }) {
    this.file = deps.file
    this.map = load(deps.file)
  }

  list(environment: number): Collection[] {
    return Object.values(this.map).filter((c) => c.environment === environment)
  }

  /** Undefined when absent OR owned by a different environment — never leaks
   *  a foreign collection's existence. */
  get(id: string, environment: number): Collection | undefined {
    const c = this.map[id]
    return c && c.environment === environment ? c : undefined
  }

  upsert(collection: Collection): void {
    this.persist({ ...this.map, [collection.id]: collection })
  }

  /** No-op when absent OR owned by a different environment — same scoping as
   *  `get`, so a caller in environment A can never delete B's collection. */
  remove(id: string, environment: number): void {
    const c = this.map[id]
    if (!c || c.environment !== environment) return
    const next = { ...this.map }
    delete next[id]
    this.persist(next)
  }

  private persist(next: Record<string, Collection>): void {
    const tmp = `${this.file}.tmp`
    try {
      writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n')
      renameSync(tmp, this.file)
    } catch (err) {
      throw new Error(
        `Couldn't save collections — ${(err as Error).message}. Nothing was stored; try again.`,
        { cause: err }
      )
    }
    this.map = next
  }
}

/** A missing/garbage file is the normal first-run case — start empty. */
function load(file: string): Record<string, Collection> {
  if (!existsSync(file)) return {}
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    return parsed as Record<string, Collection>
  } catch {
    return {}
  }
}
