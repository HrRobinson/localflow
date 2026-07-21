/**
 * Per-pane cloud credential minting (§4.1 of the DevOps/cloud-execution design).
 *
 * Given a pane's cloud config, mint a short-lived credential and hand back an
 * opaque `env` map to inject into the pane's child-process env — WITHOUT the
 * secret material ever leaving this module for a durable surface. The `env` map
 * is the only representation of the secret; it is passed straight to the spawn
 * seam and is never logged, echoed, peeked, or serialized anywhere else.
 *
 * The STS call is behind an injected `StsRunner` seam — exactly like
 * `operator-guard.ts`'s `GuardRunner` and `session-manager.ts`'s `SpawnFn`/`now`
 * seams — so tests drive it with a mock and no real AWS SDK / `aws` shell-out is
 * involved. Wiring the real `@aws-sdk/client-sts` runner is a deferred follow-up.
 *
 * Secret-safety invariants (hard requirements, from the global never-render-
 * secrets rule and design §4.1 / §9):
 *   - the minted secret lives only inside `MintedCredential.env`;
 *   - errors surface the STS error code + non-secret request context (role ARN,
 *     session name, region) only — never partial or whole credential material;
 *   - this module logs nothing on the success path and never logs a secret.
 */

export interface CloudCredentialRequest {
  cloud: 'aws' | 'gcp' | 'azure'
  /** AWS: the role to assume. */
  roleArn?: string
  /** AWS: confused-deputy mitigation (non-secret). */
  externalId?: string
  /** e.g. `saiife-<paneId>-<taskShortId>` — stamped into CloudTrail. */
  sessionName: string
  /** Capped to the MVP 900–1800s window. */
  durationSeconds: number
  region?: string
  // GCP: workloadIdentityPool/provider/serviceAccount; Azure: tenant/clientId/fic
}

export type MintedCredential = {
  cloud: 'aws' | 'gcp' | 'azure'
  /** The ONLY thing that leaves this module — opaque to callers, never logged. */
  env: Record<string, string>
  /** Epoch ms; drives the refresh/expiry UX. */
  expiresAt: number
}

/**
 * Outcome of an `sts:AssumeRole` call. The success arm carries the raw
 * credential fields; the failure arm carries a non-secret error code + message.
 * Injected in tests to avoid a real STS call.
 */
export type StsAssumeResult =
  | {
      ok: true
      accessKeyId: string
      secretAccessKey: string
      sessionToken: string
      /** Epoch ms at which the temporary credential expires. */
      expiration: number
    }
  | { ok: false; code: string; message: string }

export type StsRunner = (req: CloudCredentialRequest) => Promise<StsAssumeResult>

export interface MintDeps {
  /** STS seam; a real `@aws-sdk/client-sts`-backed runner is a follow-up. */
  runner: StsRunner
}

/** MVP session-duration cap (§4.1 / §6). */
const MIN_DURATION_SECONDS = 900
const MAX_DURATION_SECONDS = 1800

/**
 * Mint a short-lived cloud credential. Resolves to a `MintedCredential` whose
 * `env` map is the only secret-bearing surface; rejects with a legible Error
 * (spec §9) that carries the real STS error + non-secret context and never any
 * credential material.
 */
export async function mintCredential(
  req: CloudCredentialRequest,
  deps: MintDeps
): Promise<MintedCredential> {
  if (req.cloud !== 'aws') {
    // GCP (WIF) and Azure (FIC) adapters are designed cross-cloud but deferred
    // past the AWS-first MVP (§12). Fail legibly rather than silently.
    throw new Error(
      `Cloud '${req.cloud}' credential minting isn't built yet — the MVP supports AWS only. ` +
        `Set the project's cloud to 'aws', or wait for the ${req.cloud} adapter (design §12).`
    )
  }

  if (!req.roleArn || req.roleArn.trim() === '') {
    throw new Error(
      "Can't mint AWS credentials: no roleArn configured for this project. " +
        'Set the sandbox role ARN (arn:aws:iam::<acct>:role/…) in the project cloud config (design §8).'
    )
  }

  if (req.durationSeconds < MIN_DURATION_SECONDS || req.durationSeconds > MAX_DURATION_SECONDS) {
    throw new Error(
      `AWS session duration ${req.durationSeconds}s is outside the MVP cap of ` +
        `${MIN_DURATION_SECONDS}-${MAX_DURATION_SECONDS}s. Lower durationSeconds for role ` +
        `${req.roleArn} (short-lived, least-privilege sessions are the point — design §6).`
    )
  }

  const result = await deps.runner(req)

  if (!result.ok) {
    // §9: name the role + what to check + the real STS code/message; the region
    // and session name are non-secret context that speed debugging. No
    // credential material exists on this path, so none can leak.
    const region = req.region ? `, region ${req.region}` : ''
    throw new Error(
      `Couldn't assume the sandbox role ${req.roleArn} (session ${req.sessionName}${region}) — ` +
        "check the role's trust policy allows your identity and the ExternalId matches. " +
        `(STS ${result.code}: ${result.message})`
    )
  }

  // Build the opaque env map — the sole secret-bearing surface. Region is a
  // non-secret hint included only when requested.
  const env: Record<string, string> = {
    AWS_ACCESS_KEY_ID: result.accessKeyId,
    AWS_SECRET_ACCESS_KEY: result.secretAccessKey,
    AWS_SESSION_TOKEN: result.sessionToken
  }
  if (req.region) env.AWS_REGION = req.region

  return { cloud: 'aws', env, expiresAt: result.expiration }
}

export interface ExpiryStatus {
  /** Milliseconds until expiry, clamped at 0 once expired. */
  expiresInMs: number
  expired: boolean
  /** Within (or past) the warn window — drives the proactive re-mint prompt (§9). */
  expiringSoon: boolean
}

/**
 * Expiry math for the re-mint UX (§9). `warnWindowMs` is how long before expiry
 * the "creds expiring, re-mint" warning should fire (default 5 min). Pure and
 * `now`-injected so it is deterministic in tests.
 */
export function expiryStatus(
  expiresAt: number,
  now: number,
  warnWindowMs = 5 * 60_000
): ExpiryStatus {
  const remaining = expiresAt - now
  const expired = remaining <= 0
  return {
    expiresInMs: expired ? 0 : remaining,
    expired,
    expiringSoon: remaining <= warnWindowMs
  }
}
