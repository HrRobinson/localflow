import { useEffect, useState } from 'react'
import type { AgentId, AgentInfo } from '../../../shared/types'
import KeybindingsEditor from './KeybindingsEditor'

const card =
  'bg-surface-raised flex flex-col gap-2.5 rounded-[10px] border border-white/10 p-3.5 text-left'
const rowBtn =
  'cursor-pointer rounded-md border border-white/10 bg-white/[0.07] px-2.5 py-1 text-xs text-gray-300 hover:bg-white/[0.13] hover:text-white'

export default function Settings(): React.JSX.Element {
  const [agents, setAgents] = useState<AgentInfo[] | null>(null)
  const [lastAgentId, setLastAgentId] = useState<AgentId | null>(null)

  useEffect(() => {
    let cancelled = false
    void window.localflow.listAgents().then((list) => {
      if (!cancelled) setAgents(list)
    })
    void window.localflow.getLastAgent().then((last) => {
      if (!cancelled) setLastAgentId(last?.agentId ?? null)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const setPath = async (agentId: AgentId): Promise<void> => {
    const updated = await window.localflow.setAgentPath(agentId)
    if (updated) setAgents(updated)
  }

  return (
    <div className="mx-auto flex w-full max-w-[720px] flex-1 flex-col items-stretch gap-7 overflow-auto px-6 py-8 text-left">
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
            <div key={agent.id} className={`${card} flex-row items-center justify-between gap-3`}>
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
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h3 className="m-0 text-[15px] font-semibold tracking-[-0.01em]">Keybindings</h3>
        <KeybindingsEditor />
      </section>

      <section className={`${card} opacity-60`}>
        <h3 className="m-0 text-[15px] font-semibold tracking-[-0.01em]">Themes</h3>
        <p className="m-0 text-[13px] text-gray-500">
          App and terminal color themes. Coming in M4.
        </p>
      </section>
    </div>
  )
}
