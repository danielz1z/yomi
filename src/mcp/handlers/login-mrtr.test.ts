import { beforeEach, expect, test } from 'bun:test'
import type { LineProtocolService } from '../../line/core/service.js'
import { handleLoginMrtr } from './login-mrtr.js'
import { resetPendingLoginForTests } from './login-session.js'

// One shared module registry per `bun test` process: the "no login in
// flight" case below must not see a login another file settled first.
beforeEach(() => {
  resetPendingLoginForTests()
})

/**
 * A service that can answer credential lookups and nothing else. Every case
 * below stops before the login sequence would touch LINE — a test that
 * reached the network would be acting on a real account.
 */
const fakeService = (stored: Record<string, string> = {}) =>
  ({
    credentialStore: { get: async (key: string) => stored[key] ?? null },
  }) as unknown as LineProtocolService

/** The elicitation a round-1 result should be asking for. */
const preflightOf = (result: any) =>
  result.inputRequests?.preflight?.params ?? result.inputRequests?.preflight

test('round 1 asks the prerequisite before starting any login', async () => {
  const result: any = await handleLoginMrtr(fakeService(), {}, undefined)
  expect(result.resultType).toBe('input_required')
  const preflight = preflightOf(result)
  expect(preflight.requestedSchema.properties.primaryDeviceLogin).toBeDefined()
  expect(preflight.requestedSchema.required).toContain('primaryDeviceLogin')
  expect(preflight.message).toContain('允許自其他裝置登入')
})

test('round 1 pre-fills persisted credentials and still asks the prerequisite', async () => {
  const service = fakeService({
    line_phone: '+886900000000',
    line_region: 'TW',
  })
  const result: any = await handleLoginMrtr(service, {}, undefined)
  const preflight = preflightOf(result)
  // Known phone/region drop out of the form — only the prerequisite remains.
  expect(preflight.requestedSchema.properties.phone).toBeUndefined()
  expect(preflight.requestedSchema.properties.primaryDeviceLogin).toBeDefined()
})

test('a prerequisite the human says is off returns steps, not a login', async () => {
  const result: any = await handleLoginMrtr(
    fakeService({ line_phone: '+886900000000', line_region: 'TW' }),
    {},
    {
      preflight: {
        action: 'accept',
        content: { primaryDeviceLogin: 'not_enabled' },
      },
    },
  )
  expect(result.resultType).toBeUndefined()
  expect(result.isError).toBeFalsy()
  const text = result.content[0].text
  expect(text).toContain('Login was not started')
  expect(text).toContain('允許自其他裝置登入')
})

test('"I do not know where that setting is" gets the same steps', async () => {
  const result: any = await handleLoginMrtr(
    fakeService(),
    {},
    {
      preflight: {
        action: 'accept',
        content: { primaryDeviceLogin: 'unsure' },
      },
    },
  )
  expect(result.content[0].text).toContain('設定 (Settings)')
})

test('a declined pre-flight cancels instead of starting a login', async () => {
  const result: any = await handleLoginMrtr(
    fakeService(),
    {},
    {
      preflight: { action: 'decline' },
    },
  )
  expect(result.isError).toBe(true)
  expect(result.content[0].text).toContain('cancelled by the user')
})

test('an acknowledgement with no login in flight says so honestly', async () => {
  const result: any = await handleLoginMrtr(
    fakeService(),
    {},
    {
      ack: { action: 'accept', content: { entered: true } },
    },
  )
  expect(result.isError).toBe(true)
  expect(result.content[0].text).toContain('No login is pending')
})
