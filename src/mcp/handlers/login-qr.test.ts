import { expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import type { LineProtocolService } from '../../line/core/service.js'
import { handleLoginQr, handleLoginQrComplete } from './login-qr.js'

/**
 * A LineProtocolService stand-in for the QR handler tests: a real
 * EventEmitter (runQrLogin subscribes `qrCreated`/`pinCreated`/
 * `scanVerified` on it) whose `startQrLogin` plays a scripted event
 * sequence and settles. Never touches the network — the "LINE server" is
 * the script.
 *
 * @param script - Runs against the emitter once startQrLogin is called.
 * @returns The fake service plus a handle to its emitted profile.
 */
function fakeService(
  script: (service: any) => Promise<void>,
): LineProtocolService {
  const emitter = new EventEmitter()
  const service = emitter as any
  service.profile = null
  service.credentialStore = { get: async () => null, set: async () => {} }
  service.startQrLogin = async () => {
    await script(service)
    service.profile = { mid: 'u-test-mid', displayName: 'QR Tester' }
  }
  return service as LineProtocolService
}

/** Flush the microtask queue so scripted emits land between awaits. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 5))

test('login_qr returns the QR payload as text and PNG; login_qr_complete finishes', async () => {
  const service = fakeService(async (s) => {
    await tick()
    s.emit(
      'qrCreated',
      'https://line.me/R/qr/forsecure/xyz?secret=AAAA&e2eeVersion=1',
    )
    await tick()
  })

  const start: any = await handleLoginQr(service)
  expect(start.isError).toBeFalsy()
  const text = start.content[0].text
  expect(text).toContain('https://line.me/R/qr/forsecure/xyz?secret=AAAA')
  expect(text).toContain('login_qr_complete')
  const image = start.content.find((c: any) => c.type === 'image')
  expect(image).toBeDefined()
  expect(image.mimeType).toBe('image/png')
  // Real PNG bytes out of the qrcode encoder — a client can show this.
  expect(Buffer.from(image.data, 'base64').subarray(0, 4)).toEqual(
    Buffer.from([0x89, 0x50, 0x4e, 0x47]),
  )

  const done: any = await handleLoginQrComplete()
  expect(done.isError).toBeFalsy()
  const payload = JSON.parse(done.content[0].text)
  expect(payload).toEqual({
    loggedIn: true,
    mid: 'u-test-mid',
    displayName: 'QR Tester',
  })
})

test('a PIN mid-flight is returned EARLY, then the next call completes', async () => {
  const service = fakeService(async (s) => {
    await tick()
    s.emit(
      'qrCreated',
      'https://line.me/R/qr/forsecure/xyz?secret=BBBB&e2eeVersion=1',
    )
    await tick()
    s.emit('pinCreated', '731904')
    await tick()
  })

  await handleLoginQr(service)

  const pinResult: any = await handleLoginQrComplete()
  expect(pinResult.isError).toBeFalsy()
  expect(pinResult.content[0].text).toContain('731904')
  expect(pinResult.content[0].text).toContain('login_qr_complete')

  // The PIN must not be replayed — the follow-up call awaits completion.
  const done: any = await handleLoginQrComplete()
  expect(done.isError).toBeFalsy()
  expect(JSON.parse(done.content[0].text).loggedIn).toBe(true)
})

test('login_qr reuses the in-flight attempt instead of starting a second one', async () => {
  let starts = 0
  let release: () => void = () => {}
  const emitter = new EventEmitter() as any
  emitter.profile = null
  emitter.credentialStore = { get: async () => null, set: async () => {} }
  emitter.startQrLogin = async () => {
    starts++
    await tick()
    emitter.emit(
      'qrCreated',
      'https://line.me/R/qr/forsecure/reuse?secret=CCCC&e2eeVersion=1',
    )
    // Stay in flight (the real flow long-polls for minutes) until the test
    // has made its second call.
    await new Promise<void>((resolve) => {
      release = resolve
    })
    emitter.profile = { mid: 'u-reuse', displayName: 'Reuse' }
  }

  const first: any = await handleLoginQr(emitter as LineProtocolService)
  const second: any = await handleLoginQr(emitter as LineProtocolService)
  expect(starts).toBe(1)
  expect(second.content[0].text).toContain('forsecure/reuse')
  expect(first.content[0].text).toContain('forsecure/reuse')

  const donePromise = handleLoginQrComplete()
  release()
  const done: any = await donePromise
  expect(JSON.parse(done.content[0].text).mid).toBe('u-reuse')
})

test('a settled attempt is not reused — a fresh login_qr starts a new flow', async () => {
  let starts = 0
  const service = fakeService(async (s) => {
    starts++
    await tick()
    s.emit(
      'qrCreated',
      `https://line.me/R/qr/forsecure/fresh-${starts}?secret=EEEE&e2eeVersion=1`,
    )
    await tick()
  })

  const first: any = await handleLoginQr(service)
  expect(first.content[0].text).toContain('fresh-1')
  // Let the first flow settle before the second call.
  await tick()
  await tick()
  const second: any = await handleLoginQr(service)
  expect(starts).toBe(2)
  expect(second.content[0].text).toContain('fresh-2')

  const done: any = await handleLoginQrComplete()
  expect(done.isError).toBeFalsy()
})

test('a failed flow surfaces the real error through login_qr_complete', async () => {
  const service = fakeService(async (s) => {
    await tick()
    s.emit(
      'qrCreated',
      'https://line.me/R/qr/forsecure/fail?secret=DDDD&e2eeVersion=1',
    )
    await tick()
    throw new Error(
      'QR code was not confirmed in time — it expired. Start login_qr again for a fresh code.',
    )
  })

  await handleLoginQr(service)
  const done: any = await handleLoginQrComplete()
  expect(done.isError).toBe(true)
  expect(done.content[0].text).toContain('not confirmed in time')
})

test('login_qr_complete with nothing pending says so honestly', async () => {
  const result: any = await handleLoginQrComplete()
  expect(result.isError).toBe(true)
  expect(result.content[0].text).toContain('No QR login is pending')
  expect(result.content[0].text).toContain('login_qr')
})
