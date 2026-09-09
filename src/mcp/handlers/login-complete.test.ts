import { expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import type { LineProtocolService } from '../../line/core/service.js'
import { handleLoginComplete } from './login.js'
import {
  awaitPendingLogin,
  getLivePendingLogin,
  getPendingLogin,
  startPendingLogin,
} from './login-session.js'

/**
 * A LineProtocolService stand-in for the passwordless two-call path: a real
 * EventEmitter (runPwlessLogin subscribes `pinCreated`/`waitingForBiometric`
 * on it) whose `startPwlessLogin` plays a script and settles. Never touches
 * the network.
 *
 * @param script - Runs against the emitter once startPwlessLogin is called.
 * @returns The fake service.
 */
function fakeService(
  script: (service: any) => Promise<void>,
): LineProtocolService {
  const emitter = new EventEmitter()
  const service = emitter as any
  service.profile = null
  service.credentialStore = { get: async () => null, set: async () => {} }
  service.startPwlessLogin = async () => {
    await script(service)
    service.profile = { mid: 'u-pwless', displayName: 'Phone Tester' }
  }
  return service as LineProtocolService
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5))

function gate() {
  let open: () => void = () => {}
  const opened = new Promise<void>((resolve) => {
    open = resolve
  })
  return { open, opened }
}

test('login_complete with nothing pending says so honestly', async () => {
  const result: any = await handleLoginComplete()
  expect(result.isError).toBe(true)
  expect(result.content[0].text).toContain('No login is pending')
})

test('a bounded wait reports `waiting` instead of holding the call open', async () => {
  const approved = gate()
  const service = fakeService(async (s) => {
    await tick()
    s.emit('pinCreated', '123456')
    await approved.opened
  })
  const pending = startPendingLogin(service, '+886900000000', 'TW')

  // 50ms stands in for the 20s slice: the human is still on the phone.
  const outcome = await awaitPendingLogin(pending, 50)
  expect(outcome).toEqual({ kind: 'waiting' })
  expect(pending.settled).toBe(false)
  // The record is untouched — still the live login `login` would reuse.
  expect(getLivePendingLogin(Date.now())).toBe(pending)

  approved.open()
  await tick()
  await tick()
  const done = await awaitPendingLogin(pending, 50)
  expect(done).toEqual({
    kind: 'completed',
    result: { mid: 'u-pwless', displayName: 'Phone Tester' },
  })
})

test('a settled outcome stays readable — a lost login_complete result is not lost', async () => {
  const service = fakeService(async (s) => {
    await tick()
    s.emit('pinCreated', '654321')
    await tick()
  })
  startPendingLogin(service, '+886900000000', 'TW')
  await tick()
  await tick()
  await tick()

  const first: any = await handleLoginComplete()
  expect(first.isError).toBeFalsy()
  expect(JSON.parse(first.content[0].text)).toEqual({
    loggedIn: true,
    mid: 'u-pwless',
    displayName: 'Phone Tester',
  })
  // Pretend the host cancelled that call before the client saw it: the
  // next call answers the same way instead of "No login is pending".
  const second: any = await handleLoginComplete()
  expect(JSON.parse(second.content[0].text).loggedIn).toBe(true)
  // …but `login` will not reuse a finished attempt.
  expect(getPendingLogin()?.settled).toBe(true)
  expect(getLivePendingLogin(Date.now())).toBeNull()
})

test('a failed login surfaces its real error through login_complete', async () => {
  const service = fakeService(async () => {
    await tick()
    throw new Error('PIN verification failed or timed out')
  })
  startPendingLogin(service, '+886900000000', 'TW')
  await tick()
  await tick()
  const result: any = await handleLoginComplete()
  expect(result.isError).toBe(true)
  expect(result.content[0].text).toContain('PIN verification failed')
})
