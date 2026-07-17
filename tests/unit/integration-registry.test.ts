import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CredentialStore, type SecretBackend } from '../../src/main/integrations/credential-store'
import { IntegrationRegistry } from '../../src/main/integrations/integration-registry'

class FakeBackend implements SecretBackend {
  available = true
  corruptDecrypt = false
  isEncryptionAvailable(): boolean {
    return this.available
  }
  encryptString(plaintext: string): Buffer {
    return Buffer.from('cipher::' + plaintext, 'utf8')
  }
  decryptString(ciphertext: Buffer): string {
    if (this.corruptDecrypt) throw new Error('key mismatch')
    return ciphertext.toString('utf8').slice('cipher::'.length)
  }
}

describe('IntegrationRegistry', () => {
  let dir: string
  let configFile: string
  let backend: FakeBackend
  let creds: CredentialStore
  let registry: IntegrationRegistry

  const build = (): IntegrationRegistry =>
    new IntegrationRegistry({ creds, configFile, notify: () => {} })
  const writeConfig = (obj: unknown): void => writeFileSync(configFile, JSON.stringify(obj))

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lf-reg-'))
    configFile = join(dir, 'config.json')
    backend = new FakeBackend()
    creds = new CredentialStore({ backend, file: join(dir, 'secrets.enc') })
    registry = build()
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('lists all descriptors in the pinned order with a sync status()', () => {
    const ds = registry.descriptors()
    expect(ds.map((d) => d.id)).toEqual(['linear', 'email', 'cloud', 'woocommerce'])
    expect(typeof ds[0].status()).toBe('string')
  })

  it('reports needs-config with the missing field names when required fields are empty', () => {
    const v = registry.view('linear')
    expect(v.status).toBe('needs-config')
    expect(v.statusDetail).toMatch(/Linear access token/)
  })

  it('reaches connected once every required field is present', () => {
    writeConfig({ integrations: { linear: { enabled: true, workspaceId: 'ws', environment: 2 } } })
    creds.set('linear', 'oauthToken', 'tok')
    creds.set('linear', 'webhookSecret', 'whs')
    expect(build().view('linear').status).toBe('connected')
    expect(build().get('linear')!.status()).toBe('connected')
  })

  it('a fully-configured but DISABLED integration reports disabled, not connected', () => {
    // Every required field present, but the config entry is turned off. Opt-in:
    // the engine refuses any non-'connected' integration, so this must NOT be
    // 'connected'.
    writeConfig({ integrations: { linear: { enabled: false, workspaceId: 'ws', environment: 2 } } })
    creds.set('linear', 'oauthToken', 'tok')
    creds.set('linear', 'webhookSecret', 'whs')
    const v = build().view('linear')
    expect(v.status).toBe('disabled')
    expect(v.enabled).toBe(false)
    expect(build().get('linear')!.status()).toBe('disabled')
  })

  it('views() reads config once — a secret-in-config drop notice fires only once', () => {
    // A secret hand-edited into config.json is dropped with a loud notice. The
    // old code re-read+re-validated config ~6× per views() and spammed the
    // notice six times; views() must now parse once and emit it a single time.
    writeConfig({
      integrations: { linear: { enabled: true, oauthToken: 'leaked', workspaceId: 'ws' } }
    })
    const notices: string[] = []
    const reg = new IntegrationRegistry({ creds, configFile, notify: (m) => notices.push(m) })
    reg.views()
    expect(notices.filter((n) => n.includes('linear.oauthToken'))).toHaveLength(1)
  })

  it('reaches connected for cloud with NO secret — the all-non-secret case', () => {
    writeConfig({
      integrations: {
        cloud: { enabled: true, roleArn: 'arn:x', externalId: 'ext', region: 'us-east-1' }
      }
    })
    const v = build().view('cloud')
    expect(v.status).toBe('connected')
    expect(v.fields.every((f) => f.secret === false)).toBe(true)
  })

  it('reports error with detail when a stored secret cannot be decrypted', () => {
    writeConfig({ integrations: { linear: { enabled: true, workspaceId: 'ws', environment: 2 } } })
    creds.set('linear', 'oauthToken', 'tok')
    creds.set('linear', 'webhookSecret', 'whs')
    backend.corruptDecrypt = true
    const v = build().view('linear')
    expect(v.status).toBe('error')
    expect(v.statusDetail).toMatch(/re-enter/i)
  })

  it('a secret field view carries hasValue but never a value', () => {
    creds.set('linear', 'oauthToken', 'tok')
    const field = registry.view('linear').fields.find((f) => f.key === 'oauthToken')!
    expect(field.secret).toBe(true)
    expect(field.hasValue).toBe(true)
    expect('value' in field ? field.value : undefined).toBeUndefined()
  })

  it('a non-secret field view carries value read back from config', () => {
    writeConfig({ integrations: { linear: { workspaceId: 'ws-42', teamIds: ['a', 'b'] } } })
    const fields = build().view('linear').fields
    expect(fields.find((f) => f.key === 'workspaceId')!.value).toBe('ws-42')
    expect(fields.find((f) => f.key === 'teamIds')!.value).toBe('a, b')
  })

  it('setField rejects a secret key and setSecret rejects a config key', () => {
    expect(registry.setField('linear', 'oauthToken', 'x')).toEqual({
      ok: false,
      reason: expect.stringMatching(/is a secret/)
    })
    expect(registry.setSecret('linear', 'workspaceId', 'x')).toEqual({
      ok: false,
      reason: expect.stringMatching(/config field/)
    })
  })

  it('setField validates environment range and persists a good value', () => {
    expect(registry.setField('linear', 'environment', '99')).toEqual({
      ok: false,
      reason: expect.stringMatching(/1 to 9/)
    })
    const ok = registry.setField('linear', 'environment', '4')
    expect(ok.ok).toBe(true)
    expect(
      build()
        .view('linear')
        .fields.find((f) => f.key === 'environment')!.value
    ).toBe('4')
  })

  it('setEnabled toggles persisted enabled state', () => {
    expect(registry.setEnabled('linear', true).ok).toBe(true)
    expect(build().view('linear').enabled).toBe(true)
    registry.setEnabled('linear', false)
    expect(build().view('linear').enabled).toBe(false)
  })

  it('setSecret stores and clearSecret removes without ever echoing a value', () => {
    const set = registry.setSecret('linear', 'oauthToken', 'tok')
    expect(set).toEqual({ ok: true, status: expect.any(String) })
    expect(registry.view('linear').fields.find((f) => f.key === 'oauthToken')!.hasValue).toBe(true)
    registry.clearSecret('linear', 'oauthToken')
    expect(registry.view('linear').fields.find((f) => f.key === 'oauthToken')!.hasValue).toBe(false)
  })

  it('invokeAction rejects legibly when no live connector is wired', async () => {
    await expect(registry.invokeAction('linear', 'comment.create', {})).rejects.toThrow(
      /no live connector is wired/i
    )
  })

  it('subscribe returns a no-op unsubscribe when no live connector is wired', () => {
    const off = registry.subscribe('linear', 'issue.delegated', () => {})
    expect(typeof off).toBe('function')
    expect(() => off()).not.toThrow()
  })

  it('registerConnector delegates invokeAction + subscribe to the connector', async () => {
    const calls: { action?: [string, Record<string, unknown>]; trigger?: string } = {}
    let unsubbed = false
    registry.registerConnector('woocommerce', {
      invokeAction: (actionId, params) => {
        calls.action = [actionId, params]
        return Promise.resolve({ ok: true })
      },
      subscribe: (triggerId) => {
        calls.trigger = triggerId
        return () => {
          unsubbed = true
        }
      }
    })
    await expect(registry.invokeAction('woocommerce', 'getOrder', { id: '1' })).resolves.toEqual({
      ok: true
    })
    expect(calls.action).toEqual(['getOrder', { id: '1' }])
    const off = registry.subscribe('woocommerce', 'order.created', () => {})
    expect(calls.trigger).toBe('order.created')
    off()
    expect(unsubbed).toBe(true)
  })
})
