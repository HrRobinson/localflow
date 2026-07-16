import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CredentialStore, type SecretBackend } from '../../src/main/integrations/credential-store'
import { IntegrationRegistry } from '../../src/main/integrations/integration-registry'

class FakeBackend implements SecretBackend {
  isEncryptionAvailable(): boolean {
    return true
  }
  encryptString(plaintext: string): Buffer {
    return Buffer.from('cipher::' + plaintext, 'utf8')
  }
  decryptString(ciphertext: Buffer): string {
    return ciphertext.toString('utf8').slice('cipher::'.length)
  }
}

const KNOWN_SECRET = 'lin_live_SUPER_SECRET_do_not_leak_9f3a'

/** ★ The load-bearing invariant: no secret VALUE ever crosses an IPC/log boundary. */
describe('integration secret safety', () => {
  let dir: string
  let configFile: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lf-leak-'))
    configFile = join(dir, 'config.json')
    writeFileSync(
      configFile,
      JSON.stringify({
        integrations: { linear: { enabled: true, workspaceId: 'ws', environment: 1 } }
      })
    )
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('never surfaces the secret value through any IPC-shaped payload or notice', () => {
    const notices: string[] = []
    const creds = new CredentialStore({
      backend: new FakeBackend(),
      file: join(dir, 'secrets.enc')
    })
    const registry = new IntegrationRegistry({ creds, configFile, notify: (m) => notices.push(m) })

    // Drive the full set → list → status cycle with a known secret value.
    const setResult = registry.setSecret('linear', 'oauthToken', KNOWN_SECRET)
    registry.setSecret('linear', 'webhookSecret', KNOWN_SECRET)
    const views = registry.views()
    const status = registry.get('linear')!.status()

    // Every renderer-facing / IPC-return payload + every emitted notice.
    const surfaced = [
      JSON.stringify(setResult),
      JSON.stringify(views),
      JSON.stringify(status),
      notices.join('\n')
    ].join('\n')

    expect(status).toBe('connected') // proves the secret WAS stored + read as present
    expect(surfaced).not.toContain(KNOWN_SECRET)
  })

  it('keeps revealForConnector as the sole plaintext exit — no IPC/renderer caller', () => {
    // The ONLY file under src/ allowed to reference the plaintext exit is its
    // own definition (credential-store.ts). Any caller in preload/renderer or an
    // ipcMain.handle body would be a boundary leak — assert there are none yet.
    const root = join(__dirname, '..', '..', 'src')
    const offenders: string[] = []
    for (const file of walk(root)) {
      if (file.endsWith('credential-store.ts')) continue
      if (readFileSync(file, 'utf8').includes('revealForConnector')) offenders.push(file)
    }
    expect(offenders).toEqual([])
  })
})

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) yield* walk(full)
    else if (full.endsWith('.ts') || full.endsWith('.tsx')) yield full
  }
}
