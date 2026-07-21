//! Guard-pack catalog and default-on resolution (the TS mirror of the Rust
//! `profile::select_active`).
//
// saiifeguard packs come in two flavours:
//
//   - **default-on** (`core.*`): the catastrophic-only filesystem/git guards.
//     They enforce for every pane WITHOUT being listed in config — the guard
//     binary applies them unconditionally (see `builtin_packs` + `main.rs`), so
//     they never need to be passed as `--pack`.
//   - **opt-in** (everything else — `cloud.*`, `db.*`, `container.*`, `iac.*`):
//     inactive until explicitly enabled per environment, then handed to the
//     binary as `--pack <id>` (additive to the default-on set).
//
// This module is the single source of truth in the TS layer for which packs are
// which. It MUST stay in sync with the registration list in
// `guard/crates/saiifeguard/src/builtins.rs`; the `default_on` flag here mirrors the
// `default_on` field in each pack's TOML. Keeping the mapping in one place means
// the resolution logic (`resolveOptInPackArgs`) can strip default-on ids the
// binary already applies and drop unknown/typo ids, rather than forwarding
// whatever happens to be sitting in config.

/** One catalog entry: a known pack id and whether it enforces by default. */
export interface GuardPackSpec {
  id: string
  /** `true` for `core.*` packs the binary always applies; `false` for opt-in. */
  defaultOn: boolean
}

/**
 * Every built-in pack, in the same order as `builtins.rs`. `core.*` are
 * default-on; the rest are opt-in.
 */
export const GUARD_PACKS: readonly GuardPackSpec[] = [
  { id: 'core.filesystem', defaultOn: true },
  { id: 'core.git', defaultOn: true },
  { id: 'cloud.gcloud', defaultOn: false },
  { id: 'cloud.aws', defaultOn: false },
  { id: 'iac.terraform', defaultOn: false },
  { id: 'db.postgres', defaultOn: false },
  { id: 'cloud.azure', defaultOn: false },
  { id: 'db.mysql', defaultOn: false },
  { id: 'db.mongo', defaultOn: false },
  { id: 'container.docker', defaultOn: false },
  { id: 'container.k8s', defaultOn: false }
]

/** Ids that enforce by default (the binary applies these unconditionally). */
export const DEFAULT_ON_PACK_IDS: readonly string[] = GUARD_PACKS.filter((p) => p.defaultOn).map(
  (p) => p.id
)

/** Ids that must be explicitly enabled to enforce. */
export const OPT_IN_PACK_IDS: readonly string[] = GUARD_PACKS.filter((p) => !p.defaultOn).map(
  (p) => p.id
)

const KNOWN_IDS = new Set(GUARD_PACKS.map((p) => p.id))
const OPT_IN_IDS = new Set(OPT_IN_PACK_IDS)

/**
 * The full set of packs that enforce for a pane, given the per-environment
 * `enabled` list — the TS mirror of Rust `select_active`: every default-on pack,
 * plus any enabled id that is a known opt-in pack. Unknown ids are ignored.
 * Deterministic order (catalog order) and de-duplicated. Not used to build CLI
 * args (the binary adds default-on itself); it exists so callers/tests can ask
 * "what actually enforces here?" without re-deriving the rule.
 */
export function resolveActivePacks(enabled: readonly string[]): string[] {
  const on = new Set<string>(DEFAULT_ON_PACK_IDS)
  for (const id of enabled) {
    if (OPT_IN_IDS.has(id)) on.add(id)
  }
  return GUARD_PACKS.filter((p) => on.has(p.id)).map((p) => p.id)
}

/**
 * The pack ids to pass to the guard binary as `--pack <id>` for a pane: the
 * known **opt-in** packs from `enabled`, de-duplicated, in catalog order.
 * Default-on (`core.*`) ids are omitted — the binary applies them regardless, so
 * forwarding them is redundant — and unknown/typo ids are dropped so a stale
 * config entry can never become a bogus `--pack` argument.
 */
export function resolveOptInPackArgs(enabled: readonly string[]): string[] {
  const wanted = new Set<string>()
  for (const id of enabled) {
    if (OPT_IN_IDS.has(id)) wanted.add(id)
  }
  return OPT_IN_PACK_IDS.filter((id) => wanted.has(id))
}

/** True if `id` names a pack the catalog knows about (default-on or opt-in). */
export function isKnownGuardPack(id: string): boolean {
  return KNOWN_IDS.has(id)
}
