import { describe, it, expect, vi } from 'vitest'
import {
  SlackControlBridge,
  type EngineControlSeam,
  type ControlRunSnapshot
} from '../../src/main/slack/slack-control-bridge'
import type { SlackSlashPayload } from '../../src/shared/slack'

const slash = (text: string): SlackSlashPayload => ({
  command: '/saiife',
  text,
  channel: 'C1',
  user: 'U1',
  responseUrl: 'https://hooks.slack/x'
})

function seam(overrides: Partial<EngineControlSeam> = {}): EngineControlSeam {
  return {
    startRun: vi.fn().mockReturnValue({ ok: true, runId: 'run-77' }),
    listRuns: vi.fn().mockReturnValue([] as ControlRunSnapshot[]),
    requestStop: vi.fn().mockReturnValue({ ok: true }),
    ...overrides
  }
}

describe('SlackControlBridge', () => {
  it('run <flow> starts a run and replies with the run id (ephemeral)', () => {
    const engine = seam()
    const reply = new SlackControlBridge(engine).handle(slash('run refund-worker'))
    expect(engine.startRun).toHaveBeenCalledWith('refund-worker')
    expect(reply).toEqual({ text: expect.stringContaining('run-77'), ephemeral: true })
  })

  it('an unknown flow yields a legible ephemeral error', () => {
    const engine = seam({
      startRun: vi.fn().mockReturnValue({ ok: false, error: "No flow named 'ghost'" })
    })
    const reply = new SlackControlBridge(engine).handle(slash('run ghost'))
    expect(reply.text).toMatch(/No flow named 'ghost'/)
    expect(reply.ephemeral).toBe(true)
  })

  it('status lists active runs', () => {
    const engine = seam({
      listRuns: vi.fn().mockReturnValue([{ runId: 'run-1', flowName: 'f', status: 'running' }])
    })
    const reply = new SlackControlBridge(engine).handle(slash('status'))
    expect(reply.text).toContain('run-1')
    expect(reply.text).toContain('running')
  })

  it('status <run> reports one run, or a legible miss', () => {
    const engine = seam({
      listRuns: vi.fn().mockReturnValue([{ runId: 'run-1', flowName: 'f', status: 'done' }])
    })
    const bridge = new SlackControlBridge(engine)
    expect(bridge.handle(slash('status run-1')).text).toContain('done')
    expect(bridge.handle(slash('status run-9')).text).toMatch(/No run 'run-9'/)
  })

  it('stop <run> requests a stop (never force-kill)', () => {
    const engine = seam()
    const reply = new SlackControlBridge(engine).handle(slash('stop run-5'))
    expect(engine.requestStop).toHaveBeenCalledWith('run-5')
    expect(reply.text).toMatch(/Stop requested/)
  })

  it('bare/unknown subcommands reply with usage, never a silent drop', () => {
    const bridge = new SlackControlBridge(seam())
    expect(bridge.handle(slash('')).text).toMatch(/Usage/)
    expect(bridge.handle(slash('frobnicate')).text).toMatch(/Unknown/)
    expect(bridge.handle(slash('run')).text).toMatch(/needs a flow name/)
    expect(bridge.handle(slash('stop')).text).toMatch(/needs a run id/)
  })
})
