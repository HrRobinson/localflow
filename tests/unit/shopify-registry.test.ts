import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IntegrationRegistry } from '../../src/main/integrations/integration-registry'
import { CredentialStore, type SecretBackend } from '../../src/main/integrations/credential-store'
import type { LiveConnector } from '../../src/shared/integrations'

const backend: SecretBackend = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(s, 'utf8'),
  decryptString: (b) => b.toString('utf8')
}

function build(): IntegrationRegistry {
  const dir = mkdtempSync(join(tmpdir(), 'lf-shopify-reg-'))
  const configFile = join(dir, 'config.json')
  writeFileSync(configFile, '{}')
  const creds = new CredentialStore({ backend, file: join(dir, 'secrets.enc') })
  return new IntegrationRegistry({ creds, configFile })
}

describe('IntegrationRegistry live-connector seam', () => {
  it('delegates invokeAction to a registered connector', async () => {
    const registry = build()
    const connector: LiveConnector = {
      invokeAction: vi.fn(async () => ({ order: { id: '42' } })),
      subscribe: vi.fn(() => () => {})
    }
    registry.registerConnector('shopify', connector)
    await expect(registry.invokeAction('shopify', 'getOrder', { id: '42' })).resolves.toEqual({
      order: { id: '42' }
    })
    expect(connector.invokeAction).toHaveBeenCalledWith('getOrder', { id: '42' })
  })

  it('delegates subscribe (and its unsubscribe) to a registered connector', () => {
    const registry = build()
    const unsub = vi.fn()
    const connector: LiveConnector = {
      invokeAction: vi.fn(),
      subscribe: vi.fn(() => unsub)
    }
    registry.registerConnector('shopify', connector)
    const handler = (): void => {}
    const off = registry.subscribe('shopify', 'order.created', handler)
    // The registry forwards the optional trigger-node config as a 3rd arg (a POLL
    // connector reads it; a webhook connector like Shopify ignores it). Absent
    // here, so it forwards `undefined`.
    expect(connector.subscribe).toHaveBeenCalledWith('order.created', handler, undefined)
    off()
    expect(unsub).toHaveBeenCalledOnce()
  })

  it('rejects invokeAction for an id with no live connector, legibly naming the id', async () => {
    const registry = build()
    await expect(registry.invokeAction('linear', 'issue.updateState', {})).rejects.toThrow(
      /Integration linear has no live connector wired/
    )
  })

  it('returns a no-op unsubscribe when subscribing an id with no connector', () => {
    const registry = build()
    const off = registry.subscribe('linear', 'issue.delegated', () => {})
    expect(() => off()).not.toThrow()
  })
})
