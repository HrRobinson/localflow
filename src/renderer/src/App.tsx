import { useCallback, useEffect, useState } from 'react'
import TerminalPane from './components/TerminalPane'
import Landing from './components/Landing'
import Brand from './components/Brand'
import type { AgentId, SessionInfo } from '../../shared/types'

export default function App(): React.JSX.Element {
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [enlarged, setEnlarged] = useState<string | null>(null)
  const [homeRequested, setHomeRequested] = useState(false)

  const refresh = useCallback(async () => {
    setSessions(await window.localflow.listSessions())
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch on mount
    void refresh()
    const offStatus = window.localflow.onStatus((id, status) => {
      setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, status } : s)))
    })
    const onKey = (e: KeyboardEvent): void => {
      // Bare Escape belongs to the agents (Claude uses it to interrupt);
      // cmd-esc is localflow's "go up": shrink if enlarged, else go home.
      if (e.key === 'Escape' && e.metaKey) {
        e.preventDefault()
        setEnlarged((cur) => {
          if (cur !== null) return null
          setHomeRequested(true)
          return cur
        })
      }
    }
    window.addEventListener('keydown', onKey)
    // Session state arrives via two paths: pushed onStatus events (fast path
    // for status transitions) and this 1s poll (catches everything else,
    // e.g. sessions created/removed elsewhere). Both write into the same
    // `sessions` state, so they must stay reconcilable — poll results should
    // never regress a status a pushed event has already advanced past.
    const iv = setInterval(() => void refresh(), 1000)
    return () => {
      offStatus()
      window.removeEventListener('keydown', onKey)
      clearInterval(iv)
    }
  }, [refresh])

  const createSession = async (agentId: AgentId, customCommand?: string): Promise<void> => {
    const created = await window.localflow.createSession(agentId, undefined, customCommand)
    if (created) {
      setHomeRequested(false)
      await refresh()
    }
  }
  const restart = async (id: string): Promise<void> => {
    await window.localflow.restartSession(id)
    await refresh()
  }
  const close = async (id: string): Promise<void> => {
    await window.localflow.killSession(id)
    setEnlarged((cur) => (cur === id ? null : cur))
    await refresh()
  }

  const showHome = sessions.length === 0 || homeRequested

  return (
    <>
      <div className="toolbar">
        <Brand />
        <span className="toolbar-spacer" />
        {sessions.length > 0 && showHome && (
          <button className="toolbar-btn" onClick={() => setHomeRequested(false)}>
            back to sessions
          </button>
        )}
        {sessions.length > 0 && !showHome && (
          <button className="toolbar-btn" onClick={() => setHomeRequested(true)} title="cmd+esc">
            + new session
          </button>
        )}
      </div>
      {showHome ? (
        <Landing onCreate={(agentId, cmd) => void createSession(agentId, cmd)} />
      ) : (
        <div className="grid">
          {sessions.map((s) => (
            <TerminalPane
              key={s.id}
              session={s}
              enlarged={enlarged === s.id}
              onToggleEnlarge={() => setEnlarged((cur) => (cur === s.id ? null : s.id))}
              onRestart={() => void restart(s.id)}
              onClose={() => void close(s.id)}
            />
          ))}
        </div>
      )}
    </>
  )
}
