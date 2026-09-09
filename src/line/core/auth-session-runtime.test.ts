import { expect, mock, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import {
  sessionExpiredError,
  sessionRevokedError,
} from '../../mcp/handlers/shared.js'
import { isLineAuthInvalidatedError } from '../client/index.js'
import { resumeSession } from './auth-session-runtime.js'
import { CLEARED_LOGIN_KEYS, LineSessionState } from './session-state/index.js'

/**
 * Silence the runtime's startup/flow logging for the duration of a test.
 */
const silentLog = {
  info() {},
  warn() {},
  error() {},
  debug() {},
}

/**
 * Credentials a previously logged-in device carries: the token pair, the
 * secondary-device certificate, the login-time E2EE bootstrap, and the two
 * login helpers (phone/region) that must outlive any revoke.
 */
const SAVED_LOGIN = {
  line_auth_token: 'stale-token',
  line_refresh_token: 'stale-refresh',
  line_certificate: 'revoked-cert',
  line_e2ee_bootstrap: '{"encryptedKeyChain":"x"}',
  line_nacl_secret_key: 'nacl-secret',
  line_mid: 'u-self',
  line_e2ee_keys: '[{"keyId":1}]',
  line_phone: '+818012345678',
  line_region: 'JP',
}

/** In-memory credential store with the get/set/delete surface the runtime uses. */
function makeStore(seed: Record<string, string> = SAVED_LOGIN) {
  const map = new Map(Object.entries(seed))
  return {
    map,
    async get(key: string) {
      return map.get(key) ?? null
    },
    async set(key: string, value: string) {
      map.set(key, value)
    },
    async delete(key: string) {
      map.delete(key)
    },
  }
}

/**
 * Build the minimum LineProtocolService surface resumeSession touches, over a
 * REAL LineSessionState so the store-clearing under test is the production
 * clearAuth, not a stub of it.
 */
function makeService(store = makeStore()) {
  const emitter = new EventEmitter()
  const service = Object.assign(emitter, {
    loginRequired: false,
    loginReason: null as string | null,
    client: null as any,
    profile: null as any,
    logger: silentLog,
    startupFlowLogger: silentLog,
    state: 'connected',
    recentFetchState: new Map(),
    nameCache: new Map(),
    chatCache: new Map(),
    setState(next: string) {
      service.state = next
    },
    e2eeManager: { setRuntime() {}, importKeys() {}, bindSelfKeysToMid() {} },
    credentialStore: store,
    sessionState: new LineSessionState(store),
  })
  return service
}

/** Every LineClient the mocked module hands out, so tests can reach its spies. */
const createdClients: FakeLineClient[] = []

/**
 * Stand-in for LineClient: an EventEmitter (the poll loop emits 'error' on
 * it) whose getProfile() is scripted per test and whose stopPolling() is
 * observable.
 */
class FakeLineClient extends EventEmitter {
  static profileScript: (client: FakeLineClient) => Promise<any> = async () =>
    null
  authToken: string | null = null
  stopPollingCalls = 0

  constructor(token: string) {
    super()
    this.authToken = token
    createdClients.push(this)
  }

  async getProfile() {
    return FakeLineClient.profileScript(this)
  }

  stopPolling() {
    this.stopPollingCalls++
  }
}

// resumeSession dynamically imports LineClient, so the module is mocked to
// keep the restore path off the network. The revoke classifier is the REAL
// one — the runtime imports it from this same module.
mock.module('../client/index.js', () => ({
  LineClient: FakeLineClient,
  isLineAuthInvalidatedError,
}))

/**
 * Drive a full resumeSession against a client whose getProfile() rejects.
 *
 * @param profileError - Error the stubbed getProfile() throws.
 * @param store - Credential store to resume from (defaults to a saved login).
 * @returns The service and store, post-restore, for assertion.
 */
async function resumeWithProfileError(
  profileError: Error,
  store = makeStore(),
) {
  FakeLineClient.profileScript = async () => {
    throw profileError
  }
  const service = makeService(store)
  const resumed = await resumeSession(service)
  return { service, store, resumed, client: createdClients.at(-1)! }
}

test('a LINE-rejected token classifies loginReason as revoked', async () => {
  const { service } = await resumeWithProfileError(
    new Error('V3_TOKEN_CLIENT_LOGGED_OUT'),
  )
  expect(service.loginRequired).toBe(true)
  expect(service.loginReason).toBe('revoked')
})

test('terminal revoke on resume stops polling and clears the dead login, certificate included', async () => {
  const { service, store, resumed, client } = await resumeWithProfileError(
    new Error('V3_TOKEN_CLIENT_LOGGED_OUT'),
  )
  expect(resumed).toBe(false)
  expect(client.stopPollingCalls).toBe(1)

  // Nothing the revoked login issued may survive: the next login_qr reads
  // line_certificate and would otherwise offer LINE a revoked certificate.
  for (const key of CLEARED_LOGIN_KEYS) {
    expect(store.map.has(key)).toBe(false)
  }
  expect(await store.get('line_certificate')).toBeNull()
  expect(service.sessionState.authToken).toBeNull()
  expect(service.sessionState.refreshToken).toBeNull()

  // Login helpers and account-level E2EE keys are not auth material.
  expect(await store.get('line_phone')).toBe(SAVED_LOGIN.line_phone)
  expect(await store.get('line_region')).toBe(SAVED_LOGIN.line_region)
  expect(await store.get('line_e2ee_keys')).toBe(SAVED_LOGIN.line_e2ee_keys)
  expect(await store.get('line_mid')).toBe(SAVED_LOGIN.line_mid)

  expect(service.client).toBeNull()
  expect(service.state).toBe('disconnected')
})

test('DIVESTED and plain LOGGED_OUT are terminal too', async () => {
  for (const message of ['DIVESTED', 'LOGGED_OUT']) {
    const { store } = await resumeWithProfileError(new Error(message))
    expect(await store.get('line_certificate')).toBeNull()
    expect(await store.get('line_auth_token')).toBeNull()
  }
})

test('an aged-out token whose refresh fails classifies loginReason as expired', async () => {
  const { service } = await resumeWithProfileError(
    new Error('access token expired'),
  )
  expect(service.loginRequired).toBe(true)
  expect(service.loginReason).toBe('expired')
})

test('a non-terminal auth error on resume leaves every credential on disk', async () => {
  const { store, client } = await resumeWithProfileError(
    new Error('access token expired'),
  )
  // Expired is not revoked: the token merely aged out and a later login
  // overwrites it. Wiping here would cost a PIN for nothing.
  expect(Object.fromEntries(store.map)).toEqual(SAVED_LOGIN)
  expect(client.stopPollingCalls).toBe(0)
})

test('a network failure on resume is trusted optimistically and clears nothing', async () => {
  const { service, store, resumed } = await resumeWithProfileError(
    new Error('ECONNRESET'),
  )
  expect(resumed).toBe(true)
  expect(service.loginRequired).toBe(false)
  expect(Object.fromEntries(store.map)).toEqual(SAVED_LOGIN)
})

test('a revoke does not wipe a sibling process that already logged in again', async () => {
  const store = makeStore()
  FakeLineClient.profileScript = async () => {
    // Yomi Desktop re-logged in while this process was still validating its
    // old token: the shared store now holds the desktop's fresh session.
    await store.set('line_auth_token', 'fresh-sibling-token')
    await store.set('line_certificate', 'fresh-sibling-cert')
    throw new Error('V3_TOKEN_CLIENT_LOGGED_OUT')
  }
  const service = makeService(store)
  await resumeSession(service)

  expect(service.loginRequired).toBe(true)
  expect(service.loginReason).toBe('revoked')
  expect(await store.get('line_auth_token')).toBe('fresh-sibling-token')
  expect(await store.get('line_certificate')).toBe('fresh-sibling-cert')
})

test('a LOGGED_OUT surfacing from the poll loop stops polling and clears the login', async () => {
  const store = makeStore()
  FakeLineClient.profileScript = async () => ({
    mid: 'u-self',
    displayName: 'Self',
  })
  const service = makeService(store)
  expect(await resumeSession(service)).toBe(true)
  const client = createdClients.at(-1)!
  expect(service.loginRequired).toBe(false)

  // What sync-service/client.ts does after a failed pollOnce().
  client.emit('error', new Error('V3_TOKEN_CLIENT_LOGGED_OUT'))
  // The revoke flips loginRequired and stops polling synchronously; the store
  // clear is async, so let it settle.
  expect(client.stopPollingCalls).toBe(1)
  expect(service.loginRequired).toBe(true)
  await new Promise((resolve) => setTimeout(resolve, 0))

  expect(await store.get('line_certificate')).toBeNull()
  expect(await store.get('line_auth_token')).toBeNull()
  expect(await store.get('line_phone')).toBe(SAVED_LOGIN.line_phone)
  expect(service.client).toBeNull()

  // Repeated poll errors after the first revoke are only logged.
  client.emit('error', new Error('V3_TOKEN_CLIENT_LOGGED_OUT'))
  expect(client.stopPollingCalls).toBe(1)
})

test('an ordinary poll-loop error does not touch the session', async () => {
  const store = makeStore()
  FakeLineClient.profileScript = async () => ({ mid: 'u-self' })
  const service = makeService(store)
  await resumeSession(service)
  const client = createdClients.at(-1)!

  client.emit('error', new Error('socket hang up'))
  await new Promise((resolve) => setTimeout(resolve, 0))

  expect(client.stopPollingCalls).toBe(0)
  expect(service.loginRequired).toBe(false)
  expect(Object.fromEntries(store.map)).toEqual(SAVED_LOGIN)
})

test('the two causes tell the user different stories, with the same recovery', () => {
  const revoked = sessionRevokedError().content[0].text
  const expired = sessionExpiredError().content[0].text

  expect(revoked).not.toBe(expired)
  // Only a revocation may blame another device — claiming one for a token that
  // merely aged out sends the user hunting for a login that never happened.
  expect(revoked).toContain('somewhere else')
  expect(expired).not.toContain('somewhere else')
  expect(expired).toContain('expired')
  // Both still point at the same way out.
  expect(revoked).toContain('`login`')
  expect(expired).toContain('`login`')
  // A revoke clears the certificate, so only the expired path may promise a
  // PIN-free re-login.
  expect(revoked).not.toContain('without a new PIN')
  expect(expired).toContain('without a new PIN')
})
