import type { DiscordCommandPayload } from './discord-components'
import type { EngineControlSeam, ControlReply } from '../slack/slack-control-bridge'

/**
 * The reserved **`/saiife`** control surface (spec §4.2, §9): `run <flow>`,
 * `status [run]`, `stop <run>` — seed / query / stop flow runs from a Discord
 * server. It REUSES the SAME narrow `EngineControlSeam` + `ControlReply` types
 * Slack's bridge defined (the control seam is chat-platform-agnostic already);
 * `stop` only REQUESTS a stop (never force-kills mid-action). Every reply is
 * EPHEMERAL and legible; an unknown flow / run id is a specific, actionable
 * message, never a silent drop.
 *
 * On Discord the command arrives as an application-command INTERACTION_CREATE
 * (type 2) whose `name` is `saiife`; the connector delivers the reply as an
 * ephemeral interaction-callback. Non-`/saiife` interactions flow to the
 * `interaction` trigger instead (§6.1). The PEER of `slack-control-bridge.ts`.
 */

export const CONTROL_COMMAND_NAME = 'saiife'

const ephemeral = (text: string): ControlReply => ({ text, ephemeral: true })

export class DiscordControlBridge {
  constructor(private readonly engine: EngineControlSeam) {}

  /** Handle a `saiife …` command payload → an ephemeral reply. */
  handle(payload: DiscordCommandPayload): ControlReply {
    if (payload.name !== CONTROL_COMMAND_NAME) {
      return ephemeral(
        `This bridge only handles \`/${CONTROL_COMMAND_NAME}\` — got \`/${payload.name}\`.`
      )
    }
    const args = payload.text
      .trim()
      .split(/\s+/)
      .filter((s) => s.length > 0)
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
          `Usage: \`/${CONTROL_COMMAND_NAME} run <flow>\`, \`/${CONTROL_COMMAND_NAME} status [run]\`, \`/${CONTROL_COMMAND_NAME} stop <run>\`.`
        )
      default:
        return ephemeral(
          `Unknown \`/${CONTROL_COMMAND_NAME}\` command '${sub}' — try run, status, or stop.`
        )
    }
  }

  private run(flowName: string): ControlReply {
    if (!flowName)
      return ephemeral(
        `\`/${CONTROL_COMMAND_NAME} run\` needs a flow name — e.g. \`/${CONTROL_COMMAND_NAME} run refund-worker\`.`
      )
    const res = this.engine.startRun(flowName)
    if (!res.ok) {
      return ephemeral(`${res.error} — try \`/${CONTROL_COMMAND_NAME} status\` to list runs.`)
    }
    return ephemeral(`Started '${flowName}' — run \`${res.runId}\`.`)
  }

  private status(runId?: string): ControlReply {
    const runs = this.engine.listRuns()
    if (runId) {
      const run = runs.find((r) => r.runId === runId)
      if (!run)
        return ephemeral(
          `No run '${runId}' — try \`/${CONTROL_COMMAND_NAME} status\` to list active runs.`
        )
      return ephemeral(`Run \`${run.runId}\` (${run.flowName}): ${run.status}.`)
    }
    if (runs.length === 0) return ephemeral('No active runs.')
    const lines = runs.map((r) => `• \`${r.runId}\` ${r.flowName} — ${r.status}`)
    return ephemeral(`Active runs:\n${lines.join('\n')}`)
  }

  private stop(runId?: string): ControlReply {
    if (!runId)
      return ephemeral(
        `\`/${CONTROL_COMMAND_NAME} stop\` needs a run id — see \`/${CONTROL_COMMAND_NAME} status\`.`
      )
    const res = this.engine.requestStop(runId)
    if (!res.ok)
      return ephemeral(`${res.error} — try \`/${CONTROL_COMMAND_NAME} status\` to list runs.`)
    return ephemeral(`Stop requested for run \`${runId}\` — it won't be force-killed mid-action.`)
  }
}
