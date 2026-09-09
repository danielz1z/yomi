/**
 * LINE session state manager.
 *
 * Acts as the single state owner for LINE auth/session persistence. All
 * token/revision writes should flow through this class instead of writing
 * directly to the credential store from scattered call sites.
 */

import {
  loadStoredSessionFields,
  parseStoredNumber,
  persistLoginBootstrap,
  persistLoginCredentials,
  persistLoginCryptoMaterial,
} from './persist.js'

/**
 * Credential keys written by one login and owned by it. See clearAuth for
 * why each is here and what is deliberately absent.
 */
export const CLEARED_LOGIN_KEYS = [
  'line_auth_token',
  'line_refresh_token',
  'line_token_issue_time_epoch_sec',
  'line_token_duration_until_refresh_sec',
  'line_revision',
  'line_global_revision',
  'line_individual_revision',
  'line_certificate',
  'line_e2ee_bootstrap',
  'line_nacl_secret_key',
  'line_nacl_public_key',
  'line_nonce',
] as const

/**
 * Own persisted and in-memory LINE session state.
 */
export class LineSessionState {
  public credentialStore: any
  public client: any
  public authToken: string | null
  public refreshToken: string | null
  public tokenIssueTimeEpochSec: number | null
  public durationUntilRefreshInSec: number | null
  public revision: number
  public globalRevision: number
  public individualRevision: number
  public mid: string | null

  /**
   * Create the LINE session state manager.
   * @param credentialStore - Persistent credential store for LINE session data
   */
  constructor(credentialStore: any) {
    this.credentialStore = credentialStore
    this.client = null
    this.authToken = null
    this.refreshToken = null
    this.tokenIssueTimeEpochSec = null
    this.durationUntilRefreshInSec = null
    this.revision = -1
    this.globalRevision = 0
    this.individualRevision = 0
    this.mid = null
  }

  /**
   * Bind the active runtime client to the current session snapshot.
   * @param client - Active LINE client instance
   */
  bindClient(client: any): void {
    this.client = client
    if (this.authToken) {
      client.authToken = this.authToken
    }
    client.revision = this.revision
    client.globalRevision = this.globalRevision
    client.individualRevision = this.individualRevision
  }

  /**
   * Load persisted LINE session state from the credential store.
   * @returns Promise that resolves when state has been hydrated
   */
  async loadFromStore(): Promise<void> {
    const stored = await loadStoredSessionFields(this.credentialStore)
    this.authToken = stored.authToken
    this.refreshToken = stored.refreshToken
    this.mid = stored.mid
    this.tokenIssueTimeEpochSec = parseStoredNumber(
      stored.tokenIssueTimeEpochSec,
      null,
    )
    this.durationUntilRefreshInSec = parseStoredNumber(
      stored.durationUntilRefreshInSec,
      null,
    )
    this.revision = parseStoredNumber(stored.revision, -1) ?? -1
    this.globalRevision = parseStoredNumber(stored.globalRevision, 0) ?? 0
    this.individualRevision =
      parseStoredNumber(stored.individualRevision, 0) ?? 0
    if (this.client) {
      this.bindClient(this.client)
    }
  }

  /**
   * Initialize session state from a fresh login result.
   * @param loginResult - Login payload returned by the LINE auth flow
   * @returns Promise that resolves when state has been persisted
   */
  async initializeFromLogin(loginResult: any): Promise<void> {
    this.authToken = loginResult.authToken ?? this.authToken
    this.refreshToken = loginResult.refreshToken ?? this.refreshToken
    this.mid = loginResult.mid ?? this.mid
    this.tokenIssueTimeEpochSec =
      loginResult.tokenIssueTimeEpochSec ?? this.tokenIssueTimeEpochSec
    this.durationUntilRefreshInSec =
      loginResult.durationUntilRefreshInSec ?? this.durationUntilRefreshInSec

    await persistLoginCredentials(this.credentialStore, loginResult)
    await persistLoginCryptoMaterial(this.credentialStore, loginResult)
    await persistLoginBootstrap(this.credentialStore, loginResult)

    // Read-back verification: a write that is never read back is an
    // unverified claim, not a fact. `persistLoginCredentials` above can
    // report success while the underlying store still drops the key (a
    // keychain write failure swallowed by `CredentialStore.persistBlob`'s
    // catch, a race with another writer, etc.) — the only way to know the
    // session actually survives a restart is to read it back through the
    // same store the next process boot will use.
    const persistedAuthToken = await this.credentialStore.get('line_auth_token')
    const persistedMid = await this.credentialStore.get('line_mid')
    if (!persistedAuthToken || !persistedMid) {
      throw new Error(
        `LineSessionState.initializeFromLogin: login succeeded but session did not persist ` +
          `(line_auth_token=${persistedAuthToken ? 'present' : 'MISSING'}, ` +
          `line_mid=${persistedMid ? 'present' : 'MISSING'}). ` +
          'The next restart would require a fresh phone-PIN login.',
      )
    }

    if (this.client) {
      this.bindClient(this.client)
    }
  }

  /**
   * Apply a refreshed auth token result to the session.
   * @param refreshResult - Refresh payload containing a new auth token
   * @returns Promise that resolves when the new token is persisted
   */
  async applyRefreshResult(refreshResult: any): Promise<void> {
    this.authToken = refreshResult.authToken
    this.tokenIssueTimeEpochSec =
      refreshResult.tokenIssueTimeEpochSec ?? this.tokenIssueTimeEpochSec
    this.durationUntilRefreshInSec =
      refreshResult.durationUntilRefreshInSec ?? this.durationUntilRefreshInSec
    await this.credentialStore.set('line_auth_token', refreshResult.authToken)
    if (refreshResult.tokenIssueTimeEpochSec != null) {
      await this.credentialStore.set(
        'line_token_issue_time_epoch_sec',
        String(refreshResult.tokenIssueTimeEpochSec),
      )
    }
    if (refreshResult.durationUntilRefreshInSec != null) {
      await this.credentialStore.set(
        'line_token_duration_until_refresh_sec',
        String(refreshResult.durationUntilRefreshInSec),
      )
    }
    if (this.client) {
      this.client.authToken = refreshResult.authToken
    }
  }

  /**
   * Apply an auth token observed at runtime, such as token rotation.
   * @param authToken - Latest auth token
   * @returns Promise that resolves when the token is persisted
   */
  async applyRuntimeToken(authToken: string): Promise<void> {
    this.authToken = authToken
    await this.credentialStore.set('line_auth_token', authToken)
    if (this.client) {
      this.client.authToken = authToken
    }
  }

  /**
   * Persist the latest LINE sync revisions.
   * @param revision - Main operation revision
   * @param globalRevision - Global sync revision
   * @param individualRevision - Individual sync revision
   * @returns Promise that resolves when revisions are persisted
   */
  async setRevisions(
    revision: number,
    globalRevision?: number,
    individualRevision?: number,
  ): Promise<void> {
    this.revision = revision
    await this.credentialStore.set('line_revision', String(revision))
    if (globalRevision != null) {
      this.globalRevision = globalRevision
      await this.credentialStore.set(
        'line_global_revision',
        String(globalRevision),
      )
    }
    if (individualRevision != null) {
      this.individualRevision = individualRevision
      await this.credentialStore.set(
        'line_individual_revision',
        String(individualRevision),
      )
    }
    if (this.client) {
      this.client.revision = revision
      this.client.globalRevision = this.globalRevision
      this.client.individualRevision = this.individualRevision
    }
  }

  /**
   * Persist decrypted E2EE self keys for future session restore.
   * @param keys - Decrypted E2EE self keys
   * @returns Promise that resolves when keys are persisted
   */
  async saveE2EEKeys(keys: any[]): Promise<void> {
    // Only the `line_e2ee_keys` blob is ever read back (auth-session-runtime
    // restore). The former per-keyId and per-mid entries had no reader, so they
    // only churned the OS keychain and emitted one store-complete debug log per
    // key on every login/token refresh — dropped.
    await this.credentialStore.set('line_e2ee_keys', JSON.stringify(keys))
  }

  /**
   * Load persisted recent-fetch checkpoints for warm history planning.
   *
   * @returns Recent fetch checkpoint map.
   */
  async loadRecentFetchState(): Promise<
    Map<
      string,
      {
        lastCheckedAt: number
        lastDeliveredMessageId: string | null
        lastDeliveredTime: number
      }
    >
  > {
    const raw = await this.credentialStore.get('line_recent_fetch_state')
    if (!raw) {
      return new Map()
    }

    try {
      const parsed = JSON.parse(raw)
      const entries = Object.entries(parsed || {}).map(
        ([chatId, state]) =>
          [
            chatId,
            {
              lastCheckedAt: Number((state as any)?.lastCheckedAt || 0),
              lastDeliveredMessageId: (state as any)?.lastDeliveredMessageId
                ? String((state as any).lastDeliveredMessageId)
                : null,
              lastDeliveredTime: Number((state as any)?.lastDeliveredTime || 0),
            },
          ] as const,
      )
      return new Map(entries)
    } catch {
      return new Map()
    }
  }

  /**
   * Persist recent-fetch checkpoints for warm history planning.
   *
   * @param recentFetchState - Current recent fetch checkpoint map.
   * @returns Promise that resolves when checkpoints are persisted.
   */
  async saveRecentFetchState(
    recentFetchState: Map<
      string,
      {
        lastCheckedAt: number
        lastDeliveredMessageId: string | null
        lastDeliveredTime: number
      }
    >,
  ): Promise<void> {
    const payload = Object.fromEntries(
      Array.from(recentFetchState.entries())
        .sort((left, right) => right[1].lastCheckedAt - left[1].lastCheckedAt)
        .slice(0, 500),
    )
    await this.credentialStore.set(
      'line_recent_fetch_state',
      JSON.stringify(payload),
    )
  }

  /**
   * Clear everything the current LINE login handed this device.
   *
   * That is the auth/refresh tokens and their lifetimes, the sync revisions,
   * the secondary-device login certificate, and the login-time E2EE bootstrap
   * (encrypted keychain + the temporal NaCl keypair it was sealed to). All of
   * it was issued by the session being cleared; once LINE has signed this
   * device out, a later QR/PIN login that finds any of it on disk is worse
   * off than one that finds nothing — a revoked certificate offered to
   * verifyCertificate poisons the QR context and the final
   * qrCodeLoginV2ForSecure fails with INVALID_CONTEXT.
   *
   * Deliberately kept: saved phone/region (login helpers, not auth), the
   * decrypted E2EE self keys (`line_e2ee_keys` — they belong to the account,
   * not the login, so already-captured history stays readable and the next
   * login overwrites them anyway), peer/group key caches, `line_mid`, and the
   * recent-fetch checkpoints.
   *
   * @returns Promise that resolves when credentials are removed
   */
  async clearAuth(): Promise<void> {
    this.authToken = null
    this.refreshToken = null
    this.tokenIssueTimeEpochSec = null
    this.durationUntilRefreshInSec = null
    this.mid = null
    this.revision = -1
    this.globalRevision = 0
    this.individualRevision = 0
    for (const key of CLEARED_LOGIN_KEYS) {
      await this.credentialStore.delete(key)
    }
  }
}
