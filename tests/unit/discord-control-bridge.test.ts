import { describe, it, expect, vi } from 'vitest'
import { DiscordControlBridge } from '../../src/main/discord/discord-control-bridge'
import type {
  EngineControlSeam,
  ControlRunSnapshot
} from '../../src/main/slack/slack-control-bridge'
import type { DiscordCommandPayload } from '../../src/main/discord/discord-components'

const cmd = (text: string): DiscordCommandPayload => ({
  name: 'localflow',
  text,
  channelId: 'C1',
  userId: 'U1',
  interactionId: 'i1',
  token: 't1'
})

function seam(overrides: Partial<EngineControlSeam> = {}): EngineControlSeam {
  return {
    startRun: vi.fn().mockReturnValue({ ok: true, runId: 'run-77' }),
    listRuns: vi.fn().mockReturnValue([] as ControlRunSnapshot[]),
    requestStop: vi.fn().mockReturnValue({ ok: true }),
    ...overrides
  }
}

describe('DiscordControlBridge — reuses Slack’s EngineControlSeam', () => {
  it('run <flow> starts a run and replies with the run id (ephemeral)', () => {
    const engine = seam()
    const reply = new DiscordControlBridge(engine).handle(cmd('run refund-worker'))
    expect(engine.startRun).toHaveBeenCalledWith('refund-worker')
    expect(reply).toEqual({ text: expect.stringContaining('run-77'), ephemeral: true })
  })

  it('an unknown flow yields a legible ephemeral error', () => {
    const engine = seam({
      startRun: vi.fn().mockReturnValue({ ok: false, error: "No flow named 'ghost'" })
    })
    const reply = new DiscordControlBridge(engine).handle(cmd('run ghost'))
    expect(reply.text).toMatch(/No flow named 'ghost'/)
    expect(reply.ephemeral).toBe(true)
  })

  it('status lists active runs', () => {
    const engine = seam({
      listRuns: vi.fn().mockReturnValue([{ runId: 'run-1', flowName: 'f', status: 'running' }])
    })
    const reply = new DiscordControlBridge(engine).handle(cmd('status'))
    expect(reply.text).toContain('run-1')
    expect(reply.text).toContain('running')
  })

  it('status <run> reports one run, or a legible miss', () => {
    const engine = seam({
      listRuns: vi.fn().mockReturnValue([{ runId: 'run-1', flowName: 'f', status: 'done' }])
    })
    const bridge = new DiscordControlBridge(engine)
    expect(bridge.handle(cmd('status run-1')).text).toContain('done')
    expect(bridge.handle(cmd('status run-9')).text).toMatch(/No run 'run-9'/)
  })

  it('stop <run> requests a stop (never force-kill)', () => {
    const engine = seam()
    const reply = new DiscordControlBridge(engine).handle(cmd('stop run-5'))
    expect(engine.requestStop).toHaveBeenCalledWith('run-5')
    expect(reply.text).toMatch(/Stop requested/)
  })

  it('bare/unknown subcommands reply with usage, never a silent drop', () => {
    const bridge = new DiscordControlBridge(seam())
    expect(bridge.handle(cmd('')).text).toMatch(/Usage/)
    expect(bridge.handle(cmd('frobnicate')).text).toMatch(/Unknown/)
    expect(bridge.handle(cmd('run')).text).toMatch(/needs a flow name/)
    expect(bridge.handle(cmd('stop')).text).toMatch(/needs a run id/)
  })
})
