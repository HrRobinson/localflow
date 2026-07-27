#!/usr/bin/env node
/**
 * saiife API-client CLI, wrapped by the OpenClaw `saiife-api` skill. Reads the
 * grant endpoint + token from SAIIFE_API_ENDPOINT / SAIIFE_API_TOKEN (distinct
 * from the operator skill's SAIIFE_ENDPOINT / SAIIFE_TOKEN) and turns a verb
 * into one control-API request against /http/*, printing the JSON response.
 *
 * The credential the request carries is NEVER seen here — the main process
 * substitutes it by reference; responses come back as shape/values-by-pull.
 */

const isFlag = (s) => typeof s === 'string' && s.startsWith('--')

/** Read `--name value` pairs and positionals out of an argv tail. */
function parseFlags(rest) {
  const flags = {}
  const positional = []
  for (let i = 0; i < rest.length; i++) {
    if (isFlag(rest[i])) {
      flags[rest[i].slice(2)] = rest[i + 1]
      i++
    } else {
      positional.push(rest[i])
    }
  }
  return { flags, positional }
}

/** Pure verb → request mapping (exported for unit tests). */
export function buildRequest(base, argv) {
  const [verb, ...rest] = argv
  switch (verb) {
    case 'collections':
      return { method: 'GET', path: '/http/collections' }
    case 'send': {
      const { flags, positional } = parseFlags(rest)
      const collectionId = positional[0]
      if (!collectionId) throw new Error('send needs a <collectionId>')
      const body = { collectionId }
      if (flags.varset) body.varSet = flags.varset
      if (flags.request) body.requestId = flags.request
      else if (flags.spec) body.spec = JSON.parse(flags.spec)
      else throw new Error('send needs --request or --spec')
      if (flags.vars) body.vars = JSON.parse(flags.vars)
      return { method: 'POST', path: '/http/send', body }
    }
    case 'response':
      if (!rest[0]) throw new Error('response needs a <responseId>')
      return { method: 'GET', path: `/http/responses/${rest[0]}` }
    case 'pull': {
      const [responseId, jsonPath] = rest
      if (!responseId || !jsonPath) throw new Error('pull needs a <responseId> and a <path>')
      return {
        method: 'GET',
        path: `/http/responses/${responseId}/pull?path=${encodeURIComponent(jsonPath)}`
      }
    }
    default:
      throw new Error(`unknown verb: ${verb}`)
  }
}

async function main() {
  const base = process.env.SAIIFE_API_ENDPOINT
  const token = process.env.SAIIFE_API_TOKEN
  if (!base || !token) throw new Error('SAIIFE_API_ENDPOINT and SAIIFE_API_TOKEN required')
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

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    process.stderr.write(String(e) + '\n')
    process.exit(1)
  })
}
