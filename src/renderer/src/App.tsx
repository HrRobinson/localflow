import { useCallback, useEffect, useState } from 'react'
import TerminalPane from './components/TerminalPane'
import type { SessionInfo } from '../../shared/types'

export default function App(): React.JSX.Element {
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [enlarged, setEnlarged] = useState<string | null>(null)

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
      if (e.key === 'Escape') setEnlarged(null)
    }
    window.addEventListener('keydown', onKey)
    const iv = setInterval(() => void refresh(), 1000)
    return () => {
      offStatus()
      window.removeEventListener('keydown', onKey)
      clearInterval(iv)
    }
  }, [refresh])

  const createSession = async (): Promise<void> => {
    const created = await window.localflow.createSession()
    if (created) await refresh()
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

  return (
    <>
      <div className="toolbar">
        <h1>localflow</h1>
        <button className="new-session" onClick={() => void createSession()}>
          + New session
        </button>
      </div>
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
    </>
  )
}
