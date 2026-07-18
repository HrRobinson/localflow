import type { CredentialStore } from '../integrations/credential-store'

/**
 * Keychain-backed access to the three Slack secrets — a THIN wrapper over the
 * hub's `CredentialStore` (spec §4.2, §8): the connector reuses the existing
 * `safeStorage` sidecar, it does not open a second keychain. `revealForConnector`
 * is the sole plaintext exit and is MAIN-PROCESS-ONLY; this store is named
 * distinctly so a grep test can assert no IPC/renderer caller. The plaintext
 * token/secret is read at CALL TIME and NEVER stored on `this`, logged, echoed,
 * or placed in any IPC/context/error/posted-message payload (never-render-secrets).
 */
export class SlackTokenStore {
  constructor(private readonly creds: CredentialStore) {}

  /** The `Authorization: Bearer` bot token (`xoxb-…`) — main-process-only. */
  botToken(): string {
    return this.creds.revealForConnector('slack', 'botToken')
  }

  /** The app-level token (`xapp-…`) used once to open the Socket Mode WS. */
  appToken(): string {
    return this.creds.revealForConnector('slack', 'appToken')
  }

  /** The signing secret used only inside the Events path to verify signatures. */
  signingSecret(): string {
    return this.creds.revealForConnector('slack', 'signingSecret')
  }

  /** Presence probe for gating — never decrypts. */
  hasBotToken(): boolean {
    return this.creds.has('slack', 'botToken')
  }

  /** Presence probe for the Socket Mode app token — never decrypts. */
  hasAppToken(): boolean {
    return this.creds.has('slack', 'appToken')
  }
}
