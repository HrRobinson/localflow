import { useEffect, useState } from 'react'
import type { AgentId, AgentInfo } from '../../../shared/types'
import { looksLikeTypedPath } from '../../../shared/paths'
import { applyTypedPathResult } from './settingsLogic'
import KeybindingsEditor from './KeybindingsEditor'

const card =
  'bg-surface-raised flex flex-col gap-2.5 rounded-[10px] border border-white/10 p-3.5 text-left'
const rowBtn =
  'cursor-pointer rounded-md border border-white/10 bg-white/[0.07] px-2.5 py-1 text-xs text-gray-300 hover:bg-white/[0.13] hover:text-white'

const parseEnvLines = (text: string): Record<string, string> => {
  const env: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    const value = line.slice(eq + 1).trim()
    if (key) env[key] = value
  }
  return env
}
const envToLines = (env: Record<string, string>): string =>
  Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')

export default function Settings(): React.JSX.Element {
  const [agents, setAgents] = useState<AgentInfo[] | null>(null)
  const [lastAgentId, setLastAgentId] = useState<AgentId | null>(null)
  // Reserved env keys rejected by main for each agent's last save attempt.
  const [reservedErrors, setReservedErrors] = useState<Partial<Record<AgentId, string[]>>>({})
  const [themes, setThemes] = useState<string[]>([])
  const [themeName, setThemeName] = useState<string>('dark')
  const [themeError, setThemeError] = useState<string | null>(null)
  const [guardPacks, setGuardPacks] = useState<string[]>([])
  const [guardPacksNotice, setGuardPacksNotice] = useState<string | null>(null)
  const [allowTypedPaths, setAllowTypedPaths] = useState(false)
  // Per-agent typed-path input drafts (Paths section, opt-in). Controlled so
  // the "Use path" button can be disabled until the draft looks like a path.
  const [typedPathDrafts, setTypedPathDrafts] = useState<Partial<Record<AgentId, string>>>({})
  // Main's authoritative expandTypedPath check rejected a draft the
  // renderer's looser looksLikeTypedPath pre-check accepted (e.g.
  // ~otheruser/proj, a typo) — the reason surfaces here instead of the
  // "Use path" click silently doing nothing.
  const [typedPathErrors, setTypedPathErrors] = useState<Partial<Record<AgentId, string>>>({})

  useEffect(() => {
    let cancelled = false
    void window.localflow.listAgents().then((list) => {
      if (!cancelled) setAgents(list)
    })
    void window.localflow.getLastAgent().then((last) => {
      if (!cancelled) setLastAgentId(last?.agentId ?? null)
    })
    void window.localflow.listThemes().then((list) => {
      if (!cancelled) setThemes(list)
    })
    void window.localflow.getTheme().then((t) => {
      if (!cancelled) {
        setThemeName(t.name)
        setThemeError(t.error ?? null)
      }
    })
    void window.localflow.getGuardPacks().then((p) => {
      if (!cancelled) setGuardPacks(p)
    })
    void window.localflow.getAllowTypedPaths().then((allow) => {
      if (!cancelled) setAllowTypedPaths(allow)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const setPath = async (agentId: AgentId): Promise<void> => {
    const updated = await window.localflow.setAgentPath(agentId)
    if (updated) setAgents(updated)
  }

  const setPathTyped = async (agentId: AgentId): Promise<void> => {
    const draft = typedPathDrafts[agentId] ?? ''
    if (!looksLikeTypedPath(draft)) return
    const result = await window.localflow.setAgentPathTyped(agentId, draft)
    const applied = applyTypedPathResult(result)
    if (applied.agents) setAgents(applied.agents)
    // Keep the draft in place on rejection so the user can fix it in place,
    // rather than clearing (or leaving stuck-but-unexplained) input.
    setTypedPathErrors((prev) => ({ ...prev, [agentId]: applied.error ?? undefined }))
    if (applied.clearDraft) setTypedPathDrafts((prev) => ({ ...prev, [agentId]: '' }))
  }

  const toggleAllowTypedPaths = (): void => {
    const next = !allowTypedPaths
    setAllowTypedPaths(next)
    window.localflow.setAllowTypedPaths(next)
  }

  const saveOverride = async (
    agentId: AgentId,
    extraArgs: string,
    env: Record<string, string>
  ): Promise<void> => {
    const result = await window.localflow.setAgentOverride(agentId, { extraArgs, env })
    if (!result) return
    if (result.ok) {
      setAgents(result.agents)
      setReservedErrors((prev) => ({ ...prev, [agentId]: undefined }))
    } else {
      // Rejected: leave agents (and the uncontrolled inputs' text) as they
      // are so the user can fix the offending line, and name the keys.
      setReservedErrors((prev) => ({ ...prev, [agentId]: result.reserved }))
    }
  }
  const makeDefault = async (agentId: AgentId): Promise<void> => {
    const updated = await window.localflow.setDefaultAgent(agentId)
    if (updated) setAgents(updated)
  }

  const OPT_IN = ['cloud.gcloud', 'db.postgres'] as const
  const togglePack = async (id: string): Promise<void> => {
    const previous = guardPacks
    const next = guardPacks.includes(id) ? guardPacks.filter((p) => p !== id) : [...guardPacks, id]
    // Optimistic, like the rest of this file's toggles — but this one guards
    // a security setting, so a rejected write rolls the checkbox back rather
    // than leaving it showing "on" while nothing was actually persisted.
    setGuardPacks(next)
    setGuardPacksNotice(null)
    const result = await window.localflow.setGuardPacks(next)
    if (!result.ok) {
      setGuardPacks(previous)
      setGuardPacksNotice(
        `Couldn't save guard pack change: ${result.reason}. Protection may not be active — check Settings again.`
      )
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-[720px] flex-1 flex-col items-stretch gap-7 overflow-auto px-6 py-8 text-left">
      <section className="flex flex-col gap-3">
        <h3 className="m-0 text-[15px] font-semibold tracking-[-0.01em]">Paths</h3>
        <p className="m-0 text-[13px] text-gray-500">
          By default, paths below are chosen only via the Finder picker. Turn this on to also type
          or paste one — handy for dotfolder binaries like ~/.volta/bin/openclaw.
        </p>
        <label className="flex items-center gap-2 text-[13px] text-gray-300">
          <input
            type="checkbox"
            className="allow-typed-paths"
            checked={allowTypedPaths}
            onChange={toggleAllowTypedPaths}
          />
          Allow typing paths, in addition to the Finder picker
        </label>
      </section>

      <section className="flex flex-col gap-3">
        <h3 className="m-0 text-[15px] font-semibold tracking-[-0.01em]">Agents</h3>
        <p className="m-0 text-[13px] text-gray-500">
          Detected agent binaries and manual path overrides. Custom commands are entered when
          starting a session from Overview.
        </p>
        <div className="flex flex-col gap-2.5">
          {agents === null && (
            <p className="m-0 text-[13px] text-gray-400">Detecting installed agents…</p>
          )}
          {agents?.map((agent) => (
            <div key={agent.id} className={`agent-card ${card}`} data-agent={agent.id}>
              <div className="flex flex-row items-center justify-between gap-3">
                <div className="flex min-w-0 flex-1 items-center gap-2.5">
                  <span
                    className={`h-2 w-2 flex-none rounded-full ${agent.resolvedPath ? 'bg-idle' : 'bg-exited'}`}
                  />
                  <span className="text-sm font-semibold">{agent.label}</span>
                  {lastAgentId === agent.id && (
                    <span className="border-idle/50 text-idle rounded-full border px-2 py-px text-[10px] whitespace-nowrap">
                      last used
                    </span>
                  )}
                  {agent.statusFidelity === 'full' && (
                    <span
                      className="border-idle/50 text-idle rounded-full border px-2 py-px text-[10px] whitespace-nowrap"
                      title="Reports working / needs-you / done"
                    >
                      live status
                    </span>
                  )}
                  {agent.statusFidelity === 'done-only' && (
                    <span
                      className="border-idle/50 text-idle rounded-full border px-2 py-px text-[10px] whitespace-nowrap"
                      title="Reports done only — idle is accurate as of the last turn-complete, working/needs-you are not distinguished"
                    >
                      done signal
                    </span>
                  )}
                  <span
                    className="min-w-0 flex-1 overflow-hidden font-mono text-[11px] text-ellipsis whitespace-nowrap text-gray-400"
                    title={agent.resolvedPath ?? undefined}
                  >
                    {agent.resolvedPath ?? `not found (${agent.command})`}
                  </span>
                </div>
                <button
                  className={rowBtn}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => void setPath(agent.id)}
                >
                  {agent.resolvedPath ? 'Change path…' : 'Set path…'}
                </button>
              </div>
              {allowTypedPaths && (
                <div className="flex flex-col gap-1">
                  <div className="flex items-center gap-2">
                    <input
                      className="agent-path-typed bg-surface min-w-0 flex-1 rounded-md border border-white/[0.14] px-2.5 py-1.5 font-mono text-[11px] text-gray-200 outline-none focus:border-white/40"
                      placeholder="e.g. ~/.volta/bin/openclaw"
                      value={typedPathDrafts[agent.id] ?? ''}
                      onChange={(e) => {
                        const value = e.target.value
                        setTypedPathDrafts((prev) => ({ ...prev, [agent.id]: value }))
                        // Editing after a rejection clears the stale error —
                        // it re-appears (with a fresh reason, if any) only
                        // after the next "Use path" attempt.
                        setTypedPathErrors((prev) => ({ ...prev, [agent.id]: undefined }))
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void setPathTyped(agent.id)
                      }}
                    />
                    <button
                      className={`${rowBtn} disabled:cursor-default disabled:opacity-[0.45]`}
                      disabled={!looksLikeTypedPath(typedPathDrafts[agent.id] ?? '')}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => void setPathTyped(agent.id)}
                    >
                      Use path
                    </button>
                  </div>
                  {typedPathErrors[agent.id] && (
                    <p className="agent-path-typed-error m-0 text-[11px] text-red-400">
                      {typedPathErrors[agent.id]}
                    </p>
                  )}
                </div>
              )}
              <label className="flex items-center gap-2 text-[12px] text-gray-400">
                <input
                  type="radio"
                  className="agent-default"
                  data-agent={agent.id}
                  name="default-agent"
                  checked={agent.isDefault}
                  onChange={() => void makeDefault(agent.id)}
                />
                Default for new sessions
              </label>
              <label className="flex flex-col gap-1 text-[12px] text-gray-400">
                Extra args
                <input
                  className="agent-args bg-surface rounded-md border border-white/[0.14] px-2.5 py-1.5 font-mono text-[11px] text-gray-200 outline-none focus:border-white/40"
                  placeholder="e.g. --model llama3"
                  defaultValue={agent.extraArgs}
                  onBlur={(e) => void saveOverride(agent.id, e.target.value, agent.env)}
                />
              </label>
              <label className="flex flex-col gap-1 text-[12px] text-gray-400">
                Env overrides (KEY=VALUE per line)
                <textarea
                  className="agent-env bg-surface min-h-[52px] rounded-md border border-white/[0.14] px-2.5 py-1.5 font-mono text-[11px] text-gray-200 outline-none focus:border-white/40"
                  placeholder="OLLAMA_HOST=http://127.0.0.1:11434"
                  defaultValue={envToLines(agent.env)}
                  onBlur={(e) =>
                    void saveOverride(agent.id, agent.extraArgs, parseEnvLines(e.target.value))
                  }
                />
                {(reservedErrors[agent.id]?.length ?? 0) > 0 && (
                  <p className="env-error m-0 text-[11px] text-red-400">
                    {reservedErrors[agent.id]!.join(', ')}{' '}
                    {reservedErrors[agent.id]!.length > 1 ? 'are' : 'is'} managed by
                    localflow&apos;s status feed and can&apos;t be overridden. The other values were
                    not saved either — remove the line to save.
                  </p>
                )}
              </label>
            </div>
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h3 className="m-0 text-[15px] font-semibold tracking-[-0.01em]">Keybindings</h3>
        <KeybindingsEditor />
      </section>

      <section className="flex flex-col gap-3">
        <h3 className="m-0 text-[15px] font-semibold tracking-[-0.01em]">Themes</h3>
        <p className="m-0 text-[13px] text-gray-500">
          App and terminal colors. Themes are JSON files in your themes folder — edit or add your
          own; changes apply live.
        </p>
        <div className="flex items-center gap-2.5">
          <select
            className="theme-select bg-surface-raised focus:border-working rounded-md border border-white/[0.14] px-2.5 py-2 text-[13px] text-gray-200 outline-none"
            value={themeName}
            aria-label="Theme"
            onChange={(e) => {
              const name = e.target.value
              void window.localflow.setTheme(name).then((t) => {
                setThemeName(t.name)
                setThemeError(t.error ?? null)
              })
            }}
          >
            {themes.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
          <button
            className={`theme-open-folder ${rowBtn}`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => window.localflow.openThemesFolder()}
          >
            Open themes folder
          </button>
        </div>
        {themeError && <p className="theme-notice m-0 text-[13px] text-yellow-400">{themeError}</p>}
      </section>

      <section className="flex flex-col gap-3">
        <h3>Command guard (lfguard)</h3>
        <p className="text-[12px] opacity-70">
          Blocks destructive commands agents try to run. Changes apply to newly-launched panes.
        </p>
        <label className="flex items-center gap-2 opacity-60">
          <input type="checkbox" checked disabled /> core.filesystem (always on)
        </label>
        <label className="flex items-center gap-2 opacity-60">
          <input type="checkbox" checked disabled /> core.git (always on)
        </label>
        {OPT_IN.map((id) => (
          <label key={id} className="flex items-center gap-2" data-guard-pack={id}>
            <input
              type="checkbox"
              checked={guardPacks.includes(id)}
              onChange={() => void togglePack(id)}
            />
            {id}
          </label>
        ))}
        {guardPacksNotice && (
          <p className="guard-packs-notice m-0 text-[11px] text-red-400">{guardPacksNotice}</p>
        )}
      </section>
    </div>
  )
}
