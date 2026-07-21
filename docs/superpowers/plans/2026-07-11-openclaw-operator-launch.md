# OpenClaw operator launch — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Launch OpenClaw as an operator agent so saiife auto-grants the pane's environment and injects the control-API credential at spawn, revoking on close — zero manual wiring.

**Architecture:** Add an `openclaw` agent preset that spawns like any other agent. In the `session:create` path, when `agentId === 'openclaw'`, grant the pane's environment (existing `OperatorGrantStore`), merge the grant's endpoint+token into the spawn spec's `env` (which `session-manager` already injects into the pty), and track the launch so the grant is revoked when the last launched OpenClaw session in that environment is gone — but only if the launch created the grant. The shipped `openclaw/skills/saiife/` skill + CLI are untouched (v1 injects exactly the two env vars they already read).

**Tech Stack:** Electron main (TypeScript), node-pty, vitest (unit), Playwright `_electron` (e2e).

## Global Constraints

- Conventional Commits, subject ≤ 50 chars, body lines ≤ 100 chars.
- `npm run check` (eslint + prettier + tsc + vitest) green before every commit; `npm run e2e` for the e2e task.
- Work in the `feat/openclaw-launch` branch; `node_modules` is already installed — do NOT run `npm ci`.
- **Public repo:** no personal notes / names in any committed file.
- **Opt-in, revocable, never ambient** stays true: launching is an explicit user action; grants remain revocable; every pane stays human-drivable.
- **Shipped skill unchanged:** do NOT modify `openclaw/skills/saiife/**`. v1 single-environment injection targets `SAIIFE_ENDPOINT` + `SAIIFE_TOKEN`, exactly what the CLI reads.
- **Single-environment v1**, credential modelled as a grant set for additive multi later.
- **Isolation unchanged:** the injected token is per-grant and env-scoped (from the shipped control API).

---

### Task 1: `openclaw` agent preset + e2e bin override

**Files:**
- Modify: `src/shared/types.ts` (`AgentId` union)
- Modify: `src/shared/agents.ts` (`AGENT_PRESETS`)
- Modify: `src/main/index.ts` (`VALID_AGENTS`)
- Modify: `src/main/agent-registry.ts` (mirror the `SAIIFE_CLAUDE_BIN` e2e override for openclaw)
- Test: `tests/unit/agents.test.ts` (create if absent; else extend)

**Interfaces:**
- Produces: `AgentId` gains `'openclaw'`; `presetFor('openclaw')` returns a preset with `bin: 'openclaw'`, `hookAdapter: 'none'`; `VALID_AGENTS` includes `'openclaw'`.

- [ ] **Step 1: Write the failing preset test**

Create/extend `tests/unit/agents.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { AGENT_PRESETS, presetFor } from '../../src/shared/agents'

describe('openclaw preset', () => {
  it('is a registered preset with no hook adapter', () => {
    const p = presetFor('openclaw')
    expect(p).toBeDefined()
    expect(p!.bin).toBe('openclaw')
    expect(p!.hookAdapter).toBe('none')
    expect(AGENT_PRESETS.some((x) => x.id === 'openclaw')).toBe(true)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/unit/agents.test.ts`
Expected: FAIL — `presetFor('openclaw')` is `undefined` / `'openclaw'` not assignable to `AgentId`.

- [ ] **Step 3: Add `'openclaw'` to the `AgentId` union**

In `src/shared/types.ts`, change:

```ts
export type AgentId = 'claude' | 'codex' | 'gemini' | 'custom'
```
to:
```ts
export type AgentId = 'claude' | 'codex' | 'gemini' | 'openclaw' | 'custom'
```

- [ ] **Step 4: Add the preset**

In `src/shared/agents.ts`, add to `AGENT_PRESETS` (after the `gemini` entry):

```ts
  {
    id: 'openclaw',
    label: 'OpenClaw',
    bin: 'openclaw',
    resumeArgs: [],
    hookAdapter: 'none'
  }
```

- [ ] **Step 5: Add to `VALID_AGENTS`**

In `src/main/index.ts`:

```ts
const VALID_AGENTS: AgentId[] = ['claude', 'codex', 'gemini', 'openclaw', 'custom']
```

- [ ] **Step 6: Mirror the e2e bin override**

`src/main/agent-registry.ts` has an env override that forces the `claude` preset's command for tests/e2e (`SAIIFE_CLAUDE_BIN`). Add the analogous `SAIIFE_OPENCLAW_BIN` override for the `openclaw` preset, following the exact same pattern already in that file (read the env var; if set, it wins as the resolved command for `openclaw`). Do not change the claude override.

- [ ] **Step 7: Full check + commit**

Run: `npm run check` — expected PASS. (If tsc flags an exhaustive `switch` on `AgentId` that doesn't handle `'openclaw'`, add the case following the neighbouring branches — most code treats non-`custom` agents uniformly via `presetFor`, so this is unlikely.)

```bash
git add src/shared/types.ts src/shared/agents.ts src/main/index.ts src/main/agent-registry.ts tests/unit/agents.test.ts
git commit -m "feat: openclaw agent preset"
```

---

### Task 2: Credential env + launch tracker (pure)

**Files:**
- Create: `src/main/operator-launch.ts`
- Create: `tests/unit/operator-launch.test.ts`

**Interfaces:**
- Produces:
  - `credentialEnv(endpoint: string, token: string): Record<string, string>` — `{ SAIIFE_ENDPOINT, SAIIFE_TOKEN }`.
  - `class OperatorLaunchTracker` with `onLaunch(environment, sessionId, wasGrantedBefore): void`, `onClose(sessionId): number | null` (env to revoke, or null), `trackedIds(): string[]`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/operator-launch.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { credentialEnv, OperatorLaunchTracker } from '../../src/main/operator-launch'

describe('credentialEnv', () => {
  it('flattens a grant to the shipped skill env vars', () => {
    expect(credentialEnv('http://127.0.0.1:5000', 'tok')).toEqual({
      SAIIFE_ENDPOINT: 'http://127.0.0.1:5000',
      SAIIFE_TOKEN: 'tok'
    })
  })
})

describe('OperatorLaunchTracker', () => {
  it('revokes a launch-created grant when its last session closes', () => {
    const t = new OperatorLaunchTracker()
    t.onLaunch(1, 's1', false) // launch created the grant on env 1
    expect(t.trackedIds()).toEqual(['s1'])
    expect(t.onClose('s1')).toBe(1)
  })

  it('does NOT revoke a pre-existing grant', () => {
    const t = new OperatorLaunchTracker()
    t.onLaunch(2, 's1', true) // env 2 was already granted
    expect(t.onClose('s1')).toBeNull()
  })

  it('revokes only after the LAST launched session in the env closes', () => {
    const t = new OperatorLaunchTracker()
    t.onLaunch(1, 's1', false)
    t.onLaunch(1, 's2', true) // second launch reuses the existing grant
    expect(t.onClose('s1')).toBeNull() // s2 still live
    expect(t.onClose('s2')).toBe(1) // last one closes → revoke
  })

  it('returns null for an unknown session', () => {
    expect(new OperatorLaunchTracker().onClose('nope')).toBeNull()
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/unit/operator-launch.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/main/operator-launch.ts`**

```ts
/**
 * Helpers for launching OpenClaw as an operator agent: flatten a grant to the
 * env the shipped skill reads, and track launched sessions so saiife revokes
 * a grant when the last launched OpenClaw session in an environment is gone —
 * but only if the launch created the grant (never one granted manually).
 */

/** v1 single-environment credential → the env vars the shipped CLI reads. */
export function credentialEnv(endpoint: string, token: string): Record<string, string> {
  return { SAIIFE_ENDPOINT: endpoint, SAIIFE_TOKEN: token }
}

export class OperatorLaunchTracker {
  private live = new Map<number, Set<string>>()
  private launchOwned = new Set<number>()

  /**
   * Record a launched OpenClaw session in `environment`. `wasGrantedBefore` is
   * whether the environment already had an operator BEFORE this launch granted
   * it — a launch only owns (and later revokes) a grant it created.
   */
  onLaunch(environment: number, sessionId: string, wasGrantedBefore: boolean): void {
    if (!wasGrantedBefore) this.launchOwned.add(environment)
    const set = this.live.get(environment) ?? new Set<string>()
    set.add(sessionId)
    this.live.set(environment, set)
  }

  /**
   * Note a tracked session as gone. Returns the environment to revoke (the last
   * launch-created session in it just closed) or null.
   */
  onClose(sessionId: string): number | null {
    for (const [env, set] of this.live) {
      if (!set.has(sessionId)) continue
      set.delete(sessionId)
      if (set.size === 0) {
        this.live.delete(env)
        if (this.launchOwned.delete(env)) return env
      }
      return null
    }
    return null
  }

  /** All currently-tracked launched session ids. */
  trackedIds(): string[] {
    return [...this.live.values()].flatMap((s) => [...s])
  }
}
```

- [ ] **Step 4: Run to verify green**

Run: `npx vitest run tests/unit/operator-launch.test.ts`
Expected: PASS.

- [ ] **Step 5: Full check + commit**

Run: `npm run check` — expected PASS.

```bash
git add src/main/operator-launch.ts tests/unit/operator-launch.test.ts
git commit -m "feat: operator launch credential and tracker"
```

---

### Task 3: Wire launch-grant-inject + revoke-on-close into main

**Files:**
- Modify: `src/main/index.ts`

**Interfaces:**
- Consumes: Task 2 (`credentialEnv`, `OperatorLaunchTracker`); existing `grants` (`OperatorGrantStore`), `control` (`ControlEndpoint` with `.port`), `manager`, `specFor`, `clampEnvironment`.

**Note:** No new unit test — the tracker/credential logic is unit-tested in Task 2, and the end-to-end wiring is covered by Task 4's e2e. Gate is `npm run check`.

- [ ] **Step 1: Construct the tracker next to the operator wiring**

In `src/main/index.ts`, add the import next to the other operator imports:

```ts
import { credentialEnv, OperatorLaunchTracker } from './operator-launch'
```

Inside `whenReady`, next to the `grants` / `control` construction, add:

```ts
  const launchTracker = new OperatorLaunchTracker()
```

- [ ] **Step 2: Grant + inject on an `openclaw` create**

In the `session:create` handler, build the spec, then special-case `openclaw` BEFORE `manager.create`, and record the launch AFTER. Replace the existing spec/create region so it reads:

```ts
      let spec = specFor(agentId, customCommand?.trim())
      let launch: { environment: number; wasGranted: boolean } | null = null
      if (agentId === 'openclaw') {
        const env = clampEnvironment(environment)
        const wasGranted = grants.isGranted(env)
        const token = grants.grant(env)
        spec = {
          ...spec,
          env: { ...spec.env, ...credentialEnv(`http://127.0.0.1:${control.port}`, token) }
        }
        launch = { environment: env, wasGranted }
      }
      const created = manager.create(cwd ?? homedir(), spec, clampEnvironment(environment))
      if (launch) launchTracker.onLaunch(launch.environment, created.id, launch.wasGranted)
```

Keep whatever `cwd` default and post-create bookkeeping (e.g. `recordLastAgent`, the return value) the existing handler already used — only the `openclaw` grant/inject and the `onLaunch` call are new. (If the existing create used a different default than `homedir()`, keep that default; `homedir()` is already imported for other uses — verify before adding an import.)

- [ ] **Step 3: Revoke on close via the sessions-changed diff**

There is already an `onSessionsChanged` handler that pushes the session list to the window. **Add the revoke-diff INSIDE that same callback** (do not register a second `onSessionsChanged`, which may overwrite the first). At the top of that callback add:

```ts
    const currentIds = new Set(manager.list().map((s) => s.id))
    for (const id of launchTracker.trackedIds()) {
      if (!currentIds.has(id)) {
        const env = launchTracker.onClose(id)
        if (env !== null) grants.revoke(env)
      }
    }
```

This revokes a launch-created grant whenever its last launched OpenClaw session is removed (`deleteSession`), regardless of how it was removed.

- [ ] **Step 4: Full check + commit**

Run: `npm run check` — expected PASS.

```bash
git add src/main/index.ts
git commit -m "feat: launch openclaw grants and injects creds"
```

---

### Task 4: End-to-end — launch, inject, drive, revoke-on-close

**Files:**
- Create: `tests/fixtures/fake-openclaw.sh`
- Create: `tests/e2e/operator-launch.spec.ts`

**Interfaces:**
- Consumes: the app under `SAIIFE_E2E=1` with `SAIIFE_OPENCLAW_BIN` pointed at the fixture (Task 1's override); the launched session's injected env; Node `fetch` as a scripted control-API client.

- [ ] **Step 1: Create the fixture**

Create `tests/fixtures/fake-openclaw.sh` (mark it executable — `chmod +x`):

```sh
#!/bin/sh
# Stands in for the `openclaw` binary in e2e. Writes the operator credential it
# received via env to a marker file the test reads, then stays alive reading
# stdin (like fake-claude.sh) until the pty closes.
printf 'endpoint=%s\ntoken=%s\n' "$SAIIFE_ENDPOINT" "$SAIIFE_TOKEN" > "$PWD/openclaw-env-marker"
echo "fake-openclaw started"
while IFS= read -r _line; do
  echo "fake-openclaw got input"
done
```

- [ ] **Step 2: Write the e2e spec**

Create `tests/e2e/operator-launch.spec.ts`, modelled on `tests/e2e/operator.spec.ts` and `smoke.spec.ts` (reuse the `launchApp` launch/teardown shape). Add `SAIIFE_OPENCLAW_BIN: join(here, '../fixtures/fake-openclaw.sh')` to the launch env. Structure (fill each step with real Playwright + `fetch`, using `expect.poll`/`toPass` for every async wait — NO `waitForTimeout` substitutes; close the app in a `finally`):

```ts
// 1. Launch the app (SAIIFE_E2E=1, SAIIFE_OPENCLAW_BIN=fixture).
// 2. Create an OpenClaw session in env 1 via the session:create IPC
//    (createSession('openclaw', cwd, undefined, 1)); capture the returned id + cwd.
// 3. expect.poll: read `<cwd>/openclaw-env-marker` until it exists; parse
//    endpoint= and token= from it. Assert both are non-empty (creds were injected).
// 4. Scripted client with the injected token: GET <endpoint>/panes with the
//    Bearer token → 200 (the injected credential really drives env 1). The
//    OpenClaw pane itself is a terminal in env 1, so its own handle appears.
// 5. Assert the cockpit reflects env 1 granted: enter the Cockpit view for env 1,
//    expect `.operator-status[data-connected]` present and the env-1
//    `.operator-indicator[data-environment="1"]` visible in the sidebar.
// 6. Revoke-on-close: delete the OpenClaw session (deleteSession IPC). Then
//    expect.poll: GET <endpoint>/panes with the old token → 403 (grant revoked
//    when the launched session was removed).
```

- [ ] **Step 3: Run the e2e**

Run: `npm run e2e -- operator-launch.spec.ts`
Expected: PASS. Run it a second time to check for flakiness; harden any race with `expect.poll` rather than a sleep.

- [ ] **Step 4: Full check + commit**

Run: `npm run check` — expected PASS.

```bash
git add tests/fixtures/fake-openclaw.sh tests/e2e/operator-launch.spec.ts
git commit -m "test: openclaw launch e2e loop"
```

---

## Self-Review

**Spec coverage:**
- OpenClaw as a launchable agent → Task 1.
- Launch flow (grant → credential → inject → track) → Tasks 2, 3.
- Credential model (grant set, v1 flatten) → Task 2 (`credentialEnv`).
- Injection mechanism (process env via `spec.env`) → Task 3; the config-block fallback is out of scope for v1 (documented in the spec) and only needed if a real OpenClaw does not forward process env to its skill — a small additive follow-up.
- Grant ownership & lifecycle (revoke on close iff launch-created; pre-existing left alone; refcount for multiple sessions) → Task 2 (`OperatorLaunchTracker`) + Task 3 (diff).
- Revoke-while-live → already the shipped 403 behavior (no work).
- Testing (unit + e2e + injection proof) → Tasks 2, 4.

**Type consistency:** `AgentId` gains `'openclaw'` in one place (`types.ts`) used everywhere; `credentialEnv` / `OperatorLaunchTracker` defined once in `operator-launch.ts`.

**Placeholder scan:** none. The injection-mechanism verification is resolved to process-env (the natural fit given `spec.env` already reaches the pty); the config-block fallback is explicitly out of v1 scope.

**Known v1 limitation (documented):** restarting a dead OpenClaw session reuses the spec's baked env with a token that may have been revoked on the preceding exit; the fix is to re-launch fresh. Acceptable for v1; a follow-up can re-grant on restart.
