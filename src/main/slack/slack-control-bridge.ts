import type { SlackSlashPayload } from '../../shared/slack'

/**
 * The reserved **`/localflow`** control surface (spec §4.2, §9): `run <flow>`,
 * `status [run]`, `stop <run>` — seed / query / stop flow runs from chat.
 * openclaw's chat-control, upgraded and GATED: it carries a NARROW engine seam
 * (start / query / stop), not arbitrary engine access, and `stop` only REQUESTS
 * a stop (never force-kills mid-action). Every reply is EPHEMERAL and legible;
 * an unknown flow / run id is a specific, actionable message, never a silent drop.
 *
 * Non-`/localflow` slash commands are NOT handled here — they flow to the
 * `slash.command` trigger (§6.1) instead.
 */

export const CONTROL_COMMAND = '/localflow'

/** The minimal run snapshot the bridge reads for `status`. */
export interface ControlRunSnapshot {
  runId: string
  flowName: string
  status: string
}

/** The narrow engine control seam injected at startup (§4.2). */
export interface EngineControlSeam {
  startRun(flowName: string): { ok: true; runId: string } | { ok: false; error: string }
  listRuns(): ControlRunSnapshot[]
  requestStop(runId: string): { ok: true } | { ok: false; error: string }
}

/** An ephemeral reply back to the tapping user. */
export interface ControlReply {
  text: string
  ephemeral: true
}

const ephemeral = (text: string): ControlReply => ({ text, ephemeral: true })

export class SlackControlBridge {
  constructor(private readonly engine: EngineControlSeam) {}

  /** Handle a `/localflow …` slash payload → an ephemeral reply. */
  handle(payload: SlackSlashPayload): ControlReply {
    if (payload.command !== CONTROL_COMMAND) {
      return ephemeral(`This bridge only handles \`${CONTROL_COMMAND}\` — got \`${payload.command}\`.`)
    }
    const args = payload.text.trim().split(/\s+/).filter((s) => s.length > 0)
    const sub = args[0] ?? ''
    switch (sub) {
      case 'run':
        return this.run(args.slice(1).join(' '))
      case 'status':
        return this.status(args[1])
      case 'stop':
        return this.stop(args[1])
      case '':
        return ephemeral(
          `Usage: \`${CONTROL_COMMAND} run <flow>\`, \`${CONTROL_COMMAND} status [run]\`, \`${CONTROL_COMMAND} stop <run>\`.`
        )
      default:
        return ephemeral(
          `Unknown \`${CONTROL_COMMAND}\` command '${sub}' — try run, status, or stop.`
        )
    }
  }

  private run(flowName: string): ControlReply {
    if (!flowName) return ephemeral(`\`${CONTROL_COMMAND} run\` needs a flow name — e.g. \`${CONTROL_COMMAND} run refund-worker\`.`)
    const res = this.engine.startRun(flowName)
    if (!res.ok) {
      return ephemeral(`${res.error} — try \`${CONTROL_COMMAND} status\` to list runs.`)
    }
    return ephemeral(`Started '${flowName}' — run \`${res.runId}\`.`)
  }

  private status(runId?: string): ControlReply {
    const runs = this.engine.listRuns()
    if (runId) {
      const run = runs.find((r) => r.runId === runId)
      if (!run) return ephemeral(`No run '${runId}' — try \`${CONTROL_COMMAND} status\` to list active runs.`)
      return ephemeral(`Run \`${run.runId}\` (${run.flowName}): ${run.status}.`)
    }
    if (runs.length === 0) return ephemeral('No active runs.')
    const lines = runs.map((r) => `• \`${r.runId}\` ${r.flowName} — ${r.status}`)
    return ephemeral(`Active runs:\n${lines.join('\n')}`)
  }

  private stop(runId?: string): ControlReply {
    if (!runId) return ephemeral(`\`${CONTROL_COMMAND} stop\` needs a run id — see \`${CONTROL_COMMAND} status\`.`)
    const res = this.engine.requestStop(runId)
    if (!res.ok) return ephemeral(`${res.error} — try \`${CONTROL_COMMAND} status\` to list runs.`)
    return ephemeral(`Stop requested for run \`${runId}\` — it won't be force-killed mid-action.`)
  }
}
