import { expect, test } from 'bun:test'
import type { LineProtocolService } from '../../line/core/service.js'
import { handleToolAuthInvalidated } from './session-revoke.js'

const silentLog = { warn() {} }

/**
 * A service whose invalidateSession is a spy: the handler's job is to
 * delegate the teardown there (the same routine the resume path uses), not to
 * reimplement it.
 */
function spyService() {
  const calls: string[] = []
  const service = {
    loginRequired: false,
    loginReason: null,
    async invalidateSession(reason: string) {
      calls.push(reason)
      service.loginRequired = true
      service.loginReason = 'revoked' as any
    },
  }
  return { service: service as unknown as LineProtocolService, calls }
}

test('a mid-tool V3_TOKEN_CLIENT_LOGGED_OUT runs invalidateSession and answers with the revoked story', async () => {
  const { service, calls } = spyService()
  const result = await handleToolAuthInvalidated(
    service,
    new Error('V3_TOKEN_CLIENT_LOGGED_OUT'),
    'list_conversations',
    silentLog,
  )

  expect(calls).toEqual(['tool_auth_invalidated:list_conversations'])
  expect(service.loginRequired).toBe(true)
  expect(result?.isError).toBe(true)
  expect(result?.content[0].text).toContain('somewhere else')
  expect(result?.content[0].text).toContain('V3_TOKEN_CLIENT_LOGGED_OUT')
})

test('the revoke can also ride the thrift exception payload, not just the message', async () => {
  const { service, calls } = spyService()
  // The shape client/index.ts's LineRequestError gives a TalkException: the
  // code name sits in the decoded thrift struct, not the message.
  const error = Object.assign(new Error('request failed'), {
    type: 'TalkException',
    data: { exception: { 1: 20, 2: 'V3_TOKEN_CLIENT_LOGGED_OUT' } },
  })
  const result = await handleToolAuthInvalidated(
    service,
    error,
    'send_message',
    silentLog,
  )
  expect(calls).toHaveLength(1)
  expect(result?.isError).toBe(true)
})

test('an ordinary tool failure is left to the caller and touches no session state', async () => {
  const { service, calls } = spyService()
  const result = await handleToolAuthInvalidated(
    service,
    new Error('chat not found'),
    'get_chat_messages',
    silentLog,
  )
  expect(result).toBeNull()
  expect(calls).toEqual([])
  expect(service.loginRequired).toBe(false)
})
