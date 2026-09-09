import { expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { revokeSession } from './auth-session-revoke.js'
import { createAuthSessionService } from './auth-session-service.js'
import { LineSessionState } from './session-state/index.js'

const STATES = {
  DISCONNECTED: 'disconnected',
  LOGGING_IN: 'logging_in',
  CONNECTED: 'connected',
  ERROR: 'error',
}

/** In-memory credential store seeded like a device that logged in earlier. */
function makeStore() {
  const map = new Map<string, string>([
    ['line_auth_token', 'live-token'],
    ['line_refresh_token', 'live-refresh'],
    ['line_certificate', 'device-cert'],
    ['line_e2ee_bootstrap', '{"encryptedKeyChain":"x"}'],
    ['line_phone', '+818012345678'],
    ['line_region', 'JP'],
    ['line_e2ee_keys', '[{"keyId":1}]'],
  ])
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
 * A live, polling service: a real LineSessionState bound to a client whose
 * stopPolling() is observable.
 */
async function makeLiveService() {
  const store = makeStore()
  const sessionState = new LineSessionState(store)
  await sessionState.loadFromStore()
  const client = {
    authToken: 'live-token',
    stopPollingCalls: 0,
    stopPolling() {
      this.stopPollingCalls++
    },
  }
  sessionState.bindClient(client)
  const service = Object.assign(new EventEmitter(), {
    client: client as any,
    profile: { mid: 'u-self' } as any,
    e2eeWarning: true,
    loginRequired: false,
    loginReason: null as string | null,
    state: STATES.CONNECTED,
    logger: { warn() {}, error() {}, info() {} },
    startupFlowLogger: null,
    nameCache: new Map([['u1', 'Alice']]),
    chatCache: new Map([['c1', {}]]),
    credentialStore: store,
    sessionState,
    setState(next: string) {
      service.state = next
    },
  })
  service.on('error', () => {})
  return { service, store, client }
}

test('invalidateSession stops polling and clears the token pair and certificate, keeping phone/region', async () => {
  const { service, store, client } = await makeLiveService()
  const auth = createAuthSessionService(service, STATES)
  const events: any[] = []
  service.on('line:loginRequired', (payload) => events.push(payload))

  await auth.invalidateSession('V3_TOKEN_CLIENT_LOGGED_OUT')

  expect(client.stopPollingCalls).toBe(1)
  expect(await store.get('line_auth_token')).toBeNull()
  expect(await store.get('line_refresh_token')).toBeNull()
  expect(await store.get('line_certificate')).toBeNull()
  expect(await store.get('line_e2ee_bootstrap')).toBeNull()
  expect(await store.get('line_phone')).toBe('+818012345678')
  expect(await store.get('line_region')).toBe('JP')
  expect(await store.get('line_e2ee_keys')).toBe('[{"keyId":1}]')

  expect(service.client).toBeNull()
  expect(service.profile).toBeNull()
  expect(service.loginRequired).toBe(true)
  expect(service.loginReason).toBe('revoked')
  expect(service.nameCache.size).toBe(0)
  expect(service.chatCache.size).toBe(0)
  expect(service.state).toBe(STATES.DISCONNECTED)
  expect(events).toEqual([{ reason: 'V3_TOKEN_CLIENT_LOGGED_OUT' }])
})

test('revokeSession flips loginRequired and stops polling before its first await', async () => {
  const { service, client } = await makeLiveService()
  const pending = revokeSession(service, STATES.DISCONNECTED, {
    reason: 'test',
  })
  // Not awaited yet: the MCP gate and the poll loop must already see the
  // dead session while the store is still being cleaned.
  expect(service.loginRequired).toBe(true)
  expect(service.loginReason).toBe('revoked')
  expect(client.stopPollingCalls).toBe(1)
  expect((await pending).cleared).toBe(true)
})

test('revokeSession preserves a newer token another process wrote to the shared store', async () => {
  const { service, store } = await makeLiveService()
  await store.set('line_auth_token', 'sibling-token')
  await store.set('line_certificate', 'sibling-cert')

  const outcome = await revokeSession(service, STATES.DISCONNECTED, {
    reason: 'test',
  })

  expect(outcome.cleared).toBe(false)
  expect(await store.get('line_auth_token')).toBe('sibling-token')
  expect(await store.get('line_certificate')).toBe('sibling-cert')
  // This process is still done for: it must not keep using its dead token.
  expect(service.loginRequired).toBe(true)
  expect(service.client).toBeNull()
})

test('a store that throws does not stop the in-memory teardown', async () => {
  const { service, store } = await makeLiveService()
  store.delete = async () => {
    throw new Error('keychain locked')
  }
  const errors: string[] = []
  service.logger = {
    warn() {},
    info() {},
    error(event: string) {
      errors.push(event)
    },
  }

  const outcome = await revokeSession(service, STATES.DISCONNECTED, {
    reason: 'test',
  })

  expect(outcome.cleared).toBe(false)
  expect(errors).toContain('session.revoke.clear_failed')
  expect(service.loginRequired).toBe(true)
  expect(service.client).toBeNull()
  expect(service.state).toBe(STATES.DISCONNECTED)
})
