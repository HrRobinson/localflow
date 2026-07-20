import type { CredentialStore } from '../integrations/credential-store'

/**
 * Keychain-backed access to the ONE Discord secret (the bot token) — a THIN
 * wrapper over the hub's `CredentialStore` (spec §4.2, §8): the connector reuses
 * the existing `safeStorage` sidecar, it does not open a second keychain.
 * `revealForConnector` is the sole plaintext exit and is MAIN-PROCESS-ONLY; this
 * store is named distinctly so a grep test can assert no IPC/renderer caller.
 * The plaintext token is read at CALL TIME and NEVER stored on `this`, logged,
 * echoed, or placed in any IPC/context/error/posted-message payload
 * (never-render-secrets). The PEER of `slack-token-store.ts` — but ONE secret,
 * not three (the Ed25519 verification key is PUBLIC, so it lives in config, §8).
 */
export class DiscordTokenStore {
  constructor(private readonly creds: CredentialStore) {}

  /** The `Authorization: Bot <token>` header value + the Gateway IDENTIFY token
   *  — main-process-only. */
  botToken(): string {
    return this.creds.revealForConnector('discord', 'botToken')
  }

  /** Presence probe for gating — never decrypts. */
  hasBotToken(): boolean {
    return this.creds.has('discord', 'botToken')
  }
}
