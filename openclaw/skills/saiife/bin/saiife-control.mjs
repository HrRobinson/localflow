#!/usr/bin/env node
/**
 * saiife control-API CLI, wrapped by the OpenClaw `saiife` skill. Reads
 * the grant endpoint + token from SAIIFE_ENDPOINT / SAIIFE_TOKEN and
 * turns a verb into one control-API request, printing the JSON response.
 *
 * Env is injected via skills.entries.saiife.env (auto-written by saiife).
 */

/** Pure verb → request mapping (exported for unit tests). */
export function buildRequest(base, argv) {
  const [verb, ...rest] = argv
  switch (verb) {
    case 'panes':
      return { method: 'GET', path: '/panes' }
    case 'navigate':
      return { method: 'POST', path: `/panes/${rest[0]}/navigate`, body: { url: rest[1] } }
    case 'screenshot':
      return { method: 'POST', path: `/panes/${rest[0]}/screenshot` }
    case 'cookies':
      return { method: 'GET', path: `/panes/${rest[0]}/cookies` }
    case 'network':
      return { method: 'GET', path: `/panes/${rest[0]}/network` }
    case 'act':
      return {
        method: 'POST',
        path: `/panes/${rest[0]}/act`,
        body: { selector: rest[1], action: rest[2], text: rest[3] }
      }
    case 'prompt':
      return {
        method: 'POST',
        path: `/panes/${rest[0]}/prompt`,
        body: { text: rest.slice(1).join(' ') }
      }
    case 'output':
      return { method: 'GET', path: `/panes/${rest[0]}/output?maxLines=${rest[1] ?? 5}` }
    case 'create-pane': {
      const [kind, ...paneArgs] = rest
      if (kind === 'browser') {
        const [url, groupId] = paneArgs
        const body = groupId ? { kind, url, groupId } : { kind, url }
        return { method: 'POST', path: '/panes', body }
      }
      if (kind === 'terminal') {
        const [agentId, groupId] = paneArgs
        return { method: 'POST', path: '/panes', body: { kind, agentId, groupId } }
      }
      throw new Error(`unknown pane kind: ${kind}`)
    }
    case 'checkpoint': {
      const halted = rest.includes('--halt')
      return { method: 'POST', path: '/captures', body: { watchpointId: rest[0], halted } }
    }
    default:
      throw new Error(`unknown verb: ${verb}`)
  }
}

async function main() {
  const base = process.env.SAIIFE_ENDPOINT
  const token = process.env.SAIIFE_TOKEN
  if (!base || !token) throw new Error('SAIIFE_ENDPOINT and SAIIFE_TOKEN required')
  const req = buildRequest(base, process.argv.slice(2))
  const res = await fetch(base + req.path, {
    method: req.method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: req.body ? JSON.stringify(req.body) : undefined
  })
  const text = await res.text()
  process.stdout.write(text + '\n')
  if (!res.ok) process.exit(1)
}

// Only run when invoked directly (not when imported by the test).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    process.stderr.write(String(e) + '\n')
    process.exit(1)
  })
}
