import { describe, it, expect, vi } from 'vitest'
import {
  mintCredential,
  expiryStatus,
  type CloudCredentialRequest,
  type StsRunner,
  type StsAssumeResult
} from '../../src/main/cloud-credentials'

// Distinctive sentinels so any accidental leak is unmistakable in a scan.
const SECRET = {
  accessKeyId: 'AKIATESTdonotleak0000',
  secretAccessKey: 'SECRETdonotleak/aaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  sessionToken: 'SESSIONTOKENdonotleakbbbbbbbbbbbbbbbbbbbbbbbbbb'
}
const SECRET_STRINGS = [SECRET.accessKeyId, SECRET.secretAccessKey, SECRET.sessionToken]

/**
 * Flatten a thrown value into one string spanning the WHOLE error chain —
 * message + stack + every nested `cause` (Error or plain value). A secret that
 * hid in a wrapped `cause` (a shape a naive `.message`-only scan misses) must
 * still be caught here.
 */
function flattenErrorChain(err: unknown): string {
  const parts: string[] = []
  const seen = new Set<unknown>()
  let cur: unknown = err
  while (cur != null && !seen.has(cur)) {
    seen.add(cur)
    if (cur instanceof Error) {
      parts.push(cur.message, cur.stack ?? '')
      cur = (cur as Error).cause
    } else {
      parts.push(typeof cur === 'string' ? cur : JSON.stringify(cur))
      break
    }
  }
  return parts.join(' ')
}

/**
 * Every process-level output sink the module could plausibly leak through:
 * the console.* family plus the raw stdout/stderr write seams. Spying on all of
 * them (not just console.log) is what makes the "stays clean" assertion real
 * rather than vacuous — a leak via any of these channels would be caught.
 */
function spyOnAllSinks() {
  return [
    vi.spyOn(console, 'log').mockImplementation(() => {}),
    vi.spyOn(console, 'warn').mockImplementation(() => {}),
    vi.spyOn(console, 'error').mockImplementation(() => {}),
    vi.spyOn(console, 'info').mockImplementation(() => {}),
    vi.spyOn(console, 'debug').mockImplementation(() => {}),
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true),
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  ]
}

function collectSinkOutput(spies: ReturnType<typeof vi.spyOn>[]): string {
  return spies
    .flatMap((s) => s.mock.calls)
    .flat()
    .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ')
}

const EXPIRATION = 1_800_000_000_000 // fixed epoch ms

function okRunner(): StsRunner {
  return async (): Promise<StsAssumeResult> => ({
    ok: true,
    accessKeyId: SECRET.accessKeyId,
    secretAccessKey: SECRET.secretAccessKey,
    sessionToken: SECRET.sessionToken,
    expiration: EXPIRATION
  })
}

function errRunner(code: string, message: string): StsRunner {
  return async (): Promise<StsAssumeResult> => ({ ok: false, code, message })
}

const awsReq = (over: Partial<CloudCredentialRequest> = {}): CloudCredentialRequest => ({
  cloud: 'aws',
  roleArn: 'arn:aws:iam::123456789012:role/saiife-agent-sandbox',
  externalId: 'lf-ext-id',
  sessionName: 'saiife-pane7-abc123',
  durationSeconds: 1800,
  region: 'us-east-1',
  ...over
})

describe('mintCredential (AWS)', () => {
  it('produces the AWS env keys and an expiresAt on success', async () => {
    const cred = await mintCredential(awsReq(), { runner: okRunner() })
    expect(cred.cloud).toBe('aws')
    expect(cred.env).toEqual({
      AWS_ACCESS_KEY_ID: SECRET.accessKeyId,
      AWS_SECRET_ACCESS_KEY: SECRET.secretAccessKey,
      AWS_SESSION_TOKEN: SECRET.sessionToken,
      AWS_REGION: 'us-east-1'
    })
    expect(cred.expiresAt).toBe(EXPIRATION)
  })

  it('omits AWS_REGION when no region is requested', async () => {
    const cred = await mintCredential(awsReq({ region: undefined }), { runner: okRunner() })
    expect(cred.env.AWS_REGION).toBeUndefined()
    expect(cred.env.AWS_ACCESS_KEY_ID).toBe(SECRET.accessKeyId)
  })

  it('never leaks credential material to logs or any non-env surface', async () => {
    // Spy on the full sink surface (console.* AND process stdout/stderr), so the
    // "stays clean" assertion covers every channel the module could write to —
    // not just console.log, which the module never touches (the old vacuous scan).
    const spies = spyOnAllSinks()
    try {
      const cred = await mintCredential(awsReq(), { runner: okRunner() })

      // (1) With real secrets in scope on the success path, nothing the module
      // emitted to ANY output sink may contain a secret.
      const allLogged = collectSinkOutput(spies)
      for (const s of SECRET_STRINGS) {
        expect(allLogged).not.toContain(s)
      }

      // (2) The ONLY representation of the secret is the opaque env map.
      // Any other serialization of the result must be secret-free.
      const withoutEnv = JSON.stringify({ ...cred, env: '<redacted>' })
      for (const s of SECRET_STRINGS) {
        expect(withoutEnv).not.toContain(s)
      }
    } finally {
      spies.forEach((s) => s.mockRestore())
    }
  })

  it('surfaces a legible STS error carrying the real code + non-secret context, no credential', async () => {
    const spies = spyOnAllSinks()
    try {
      const err = await mintCredential(awsReq(), {
        runner: errRunner('AccessDenied', 'not authorized to perform sts:AssumeRole')
      }).then(
        () => null,
        (e: Error) => e
      )
      expect(err).toBeInstanceOf(Error)
      const msg = (err as Error).message
      // human sentence + actionable + real detail (spec §9)
      expect(msg).toContain('arn:aws:iam::123456789012:role/saiife-agent-sandbox')
      expect(msg).toContain('AccessDenied')
      expect(msg).toContain('not authorized to perform sts:AssumeRole')
      expect(msg.toLowerCase()).toContain('trust policy')
      expect(msg).toContain('saiife-pane7-abc123') // session name = non-secret context
      // and never any credential material — scan the WHOLE error chain
      // (message + stack + nested cause), not just the top-level message.
      const chain = flattenErrorChain(err)
      for (const s of SECRET_STRINGS) {
        expect(chain).not.toContain(s)
      }
      // nor may anything have been written to any output sink on the error path.
      const sunk = collectSinkOutput(spies)
      for (const s of SECRET_STRINGS) {
        expect(sunk).not.toContain(s)
      }
    } finally {
      spies.forEach((s) => s.mockRestore())
    }
  })

  it('rejects a duration outside the MVP 900-1800s cap with a legible error', async () => {
    const err = await mintCredential(awsReq({ durationSeconds: 7200 }), {
      runner: okRunner()
    }).then(
      () => null,
      (e: Error) => e
    )
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toContain('900')
    expect((err as Error).message).toContain('1800')
    expect((err as Error).message).toContain('7200')
  })

  it('requires a roleArn for AWS', async () => {
    const err = await mintCredential(awsReq({ roleArn: undefined }), { runner: okRunner() }).then(
      () => null,
      (e: Error) => e
    )
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message.toLowerCase()).toContain('rolearn')
  })
})

describe('mintCredential (deferred clouds)', () => {
  it('throws a legible not-yet-supported error for gcp/azure', async () => {
    for (const cloud of ['gcp', 'azure'] as const) {
      const err = await mintCredential(awsReq({ cloud }), { runner: okRunner() }).then(
        () => null,
        (e: Error) => e
      )
      expect(err).toBeInstanceOf(Error)
      expect((err as Error).message.toLowerCase()).toContain(cloud)
      expect((err as Error).message.toLowerCase()).toContain('aws')
    }
  })
})

describe('expiryStatus', () => {
  const expiresAt = 1_000_000
  it('reports remaining time and not-expired well before expiry', () => {
    const s = expiryStatus(expiresAt, expiresAt - 600_000, 300_000)
    expect(s.expired).toBe(false)
    expect(s.expiringSoon).toBe(false)
    expect(s.expiresInMs).toBe(600_000)
  })

  it('flags expiringSoon inside the warn window', () => {
    const s = expiryStatus(expiresAt, expiresAt - 120_000, 300_000)
    expect(s.expired).toBe(false)
    expect(s.expiringSoon).toBe(true)
    expect(s.expiresInMs).toBe(120_000)
  })

  it('flags expired once now passes expiresAt', () => {
    const s = expiryStatus(expiresAt, expiresAt + 1, 300_000)
    expect(s.expired).toBe(true)
    expect(s.expiringSoon).toBe(true)
    expect(s.expiresInMs).toBe(0)
  })
})
