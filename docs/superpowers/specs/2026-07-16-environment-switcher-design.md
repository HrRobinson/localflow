# Environment switcher UX — design

Date: 2026-07-16. Status: approved design.

## Problem

localflow has 9 virtual environments (`ENVIRONMENT_MIN..ENVIRONMENT_MAX`,
`src/shared/environment.ts`), used as per-project/customer containers.
Switching between them today works via `cmd+1`..`cmd+9` (`environment-N`
keybinding actions dispatched to `switchEnvironment` in `App.tsx`), which is
invisible to a non-technical user — there's no on-screen hint that other
environments exist or how to reach them, and no way to start a *new* one
without knowing to press an unclaimed number.

## What's already there (verified by reading the code, not assumed)

The Sidebar's `ENVIRONMENTS` section (`Sidebar.tsx` L147-178) already renders
a **clickable** list — `visibleEnvironments(sessions, environment)` (non-empty
environments plus the current one, ascending) — as buttons with:

- a rollup status dot (`worstStatus` over the environment's session
  statuses), matching the sidebar's working/needs-you/done/running legend
- the environment number plus its config name (`envNames[n]`, from
  `getEnvironmentNames()` / `config.json`'s `environments` map)
- the operator-granted indicator dot
- a session count
- `onClick={() => onSwitchEnvironment(n)}`, which is `App.tsx`'s
  `switchEnvironment` — the exact same function the `cmd+1..9` keybindings
  call (`environment-N` action in the keydown dispatcher, `App.tsx` L564-566)
- the active environment styled bold/white via `n === environment`

This is confirmed end-to-end by the existing e2e test `tests/e2e/smoke.spec.ts`
("environments: switch, move, rollup dot, persistence", L653+): "Clicking the
environment row switches the grid to it" is already asserted (L743-748).

So **part 1 of the ask (clickable switcher, active state, rollup dots,
shared switch path) is already shipped** — nothing to build there. The actual
gap, matching the dogfooding complaint ("no visible 'Add environment'
affordance"), is: **environments with zero sessions are invisible** (they're
excluded from `visibleEnvironments` unless they're the current one) and
**there is no way to discover or reach an unused environment without already
knowing its number**. That's what this change adds.

## What this change adds

An **"+ add environment"** row in the sidebar's Environments section (same
visual language as the existing "+ new session" row at the bottom of the
session list), that:

1. Computes the lowest unused environment number in 1-9 — "unused" meaning
   no session currently has that environment (independent of which one is
   "current"; matches the sidebar list's own notion of "non-empty").
2. If one exists, calls the **same `onSwitchEnvironment` prop** (the same
   `switchEnvironment` path clicks and `cmd+1..9` already use) with that
   number. This does not create a session — it just makes that (currently
   empty) environment the visible one, exactly like `cmd+N` on an unused
   slot already does today (see `smoke.spec.ts`'s "cmd+2: switch to (empty)
   environment 2 — grid empties back to the landing"). From there the user
   creates a session the normal way (Landing screen, "+ new session"), which
   is consistent with how every other empty environment already behaves —
   no new session-creation code path needed.
3. If all 9 are in use, the button is **disabled** (`disabled` attribute +
   existing `disabled:opacity-40` styling already used by other nav buttons)
   rather than hidden, so its presence doesn't flicker in and out as the 9th
   environment fills up/empties — matches the existing pattern (`Environment`
   / `Activity` nav buttons are disabled-not-hidden when empty).

### Enumeration

New pure helper in `src/shared/environment.ts`, next to `visibleEnvironments`
and `worstStatus` (same module, same test file gets new cases):

```ts
/** Lowest environment number 1-9 with no session on it, or null if all nine
 *  are occupied. */
export function nextUnusedEnvironment(sessions: { environment: number }[]): number | null
```

Implementation: build the set of `sessions.map(s => s.environment)`, scan
`ENVIRONMENT_MIN..ENVIRONMENT_MAX` ascending, return the first number not in
the set, or `null`.

Deliberately **not** scoped by "current" — the current environment, if it has
no sessions, is already visible and selected; there's no reason for "add" to
special-case it, and always scanning from 1 keeps the result deterministic
and match the ascending order the sidebar already sorts by.

### Naming

No new naming behavior: the newly-switched-to environment picks up whatever
name (if any) is already configured for that number in `config.json`'s
`environments` map (read via the existing `getEnvironmentNames()` IPC, same
`envNames` state Sidebar already holds) — same as every other environment
row. This feature does not add environment renaming; that's still the M4
Settings-GUI item noted in `environment-names.ts`'s doc comment.

### What's NOT changing

- `cmd+1..9` keybindings: untouched.
- `switchEnvironment` in `App.tsx`: untouched, reused as-is.
- `visibleEnvironments`: untouched — the "+ add" row is a sibling appended
  after the mapped list, not a change to which rows that function produces.
- No new IPC, no new main-process state — `nextUnusedEnvironment` is pure
  client-side arithmetic over the `sessions` prop Sidebar already receives.

## Testing

- **Unit** (`tests/unit/environment.test.ts`, TDD): `nextUnusedEnvironment` —
  empty sessions → 1; some occupied → lowest gap; all nine occupied → `null`;
  order-independence of input.
- **Manual/e2e note** (not faked as an automated assertion): Sidebar wiring
  (the new button rendering, its disabled state at 9/9, and its click
  invoking `onSwitchEnvironment`) is UI composition already exercised by the
  same pattern as the existing environment-row click assertion in
  `smoke.spec.ts`. Given this PR's scope, the new button is covered by a
  manual check (see PR report) rather than a new Playwright spec, to keep
  this change small; a follow-up can extend `smoke.spec.ts`'s environments
  test with an "add environment via the sidebar button" step if desired.
