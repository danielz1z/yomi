import { expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import type { LineProtocolService } from '../../line/core/service.js'
import { handleLoginQr, handleLoginQrStatus } from './login-qr.js'
import { getPendingQrLogin } from './login-qr-session.js'

/**
 * A LineProtocolService stand-in for the QR handler tests: a real
 * EventEmitter (runQrLogin subscribes `qrCreated`/`scanVerified`/
 * `pinCreated`/`pinVerified`/`certificateVerified` on it) whose
 * `startQrLogin` plays a scripted event sequence and settles. Never touches
 * the network — the "LINE server" is the script.
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

/** A gate the test opens to let a scripted flow take its next step. */
function gate() {
  let open: () => void = () => {}
  const opened = new Promise<void>((resolve) => {
    open = resolve
  })
  return { open, opened }
}

const QR = (tag: string) =>
  `https://line.me/R/qr/forsecure/${tag}?secret=AAAA&e2eeVersion=1`

test('login_qr_status before any attempt reports `none`, not an error', () => {
  const result: any = handleLoginQrStatus()
  expect(result.isError).toBeFalsy()
  expect(result.structuredContent).toEqual({ status: 'none' })
  expect(result.content[0].text).toContain('login_qr')
})

test('login_qr returns the QR as text and PNG; status polls through to logged_in', async () => {
  const scanned = gate()
  const service = fakeService(async (s) => {
    await tick()
    s.emit('qrCreated', QR('xyz'))
    await scanned.opened
  })

  const start: any = await handleLoginQr(service)
  expect(start.isError).toBeFalsy()
  const text = start.content[0].text
  expect(text).toContain(QR('xyz'))
  expect(text).toContain('login_qr_status')
  expect(text).not.toContain('login_qr_complete')
  const image = start.content.find((c: any) => c.type === 'image')
  expect(image).toBeDefined()
  expect(image.mimeType).toBe('image/png')
  // Real PNG bytes out of the qrcode encoder — a client can show this.
  expect(Buffer.from(image.data, 'base64').subarray(0, 4)).toEqual(
    Buffer.from([0x89, 0x50, 0x4e, 0x47]),
  )

  // Nobody has scanned: the status call returns at once and says so.
  const waiting: any = handleLoginQrStatus()
  expect(waiting.isError).toBeFalsy()
  expect(waiting.structuredContent.status).toBe('waiting_for_scan')
  expect(waiting.structuredContent.qrUrl).toBe(QR('xyz'))
  expect(waiting.structuredContent.secondsLeft).toBeGreaterThan(170)
  expect(waiting.content[0].text).toContain('login_qr_status')

  scanned.open()
  await tick()
  await tick()

  const done: any = handleLoginQrStatus()
  expect(done.isError).toBeFalsy()
  expect(done.structuredContent).toEqual({
    status: 'logged_in',
    mid: 'u-test-mid',
    displayName: 'QR Tester',
  })
  expect(JSON.parse(done.content[0].text)).toEqual({
    loggedIn: true,
    mid: 'u-test-mid',
    displayName: 'QR Tester',
  })
  // Reading settles nothing: a client that lost the first result gets it again.
  expect(handleLoginQrStatus().structuredContent.status).toBe('logged_in')
})

test('a PIN is reported on every poll until LINE accepts it — never a one-shot', async () => {
  const pinTyped = gate()
  const service = fakeService(async (s) => {
    await tick()
    s.emit('qrCreated', QR('pin'))
    await tick()
    s.emit('scanVerified')
    await tick()
    s.emit('pinCreated', '731904')
    await pinTyped.opened
    s.emit('pinVerified')
    await tick()
  })

  await handleLoginQr(service)
  await tick()
  await tick()

  // The phone confirmed the scan; LINE is deciding cert vs PIN.
  // (scanVerified and pinCreated land a tick apart, so catch whichever the
  // script has reached — both are honest, neither blocks.)
  const confirmed: any = handleLoginQrStatus()
  expect(['scan_confirmed', 'pin']).toContain(
    confirmed.structuredContent.status,
  )

  await tick()
  await tick()
  const first: any = handleLoginQrStatus()
  expect(first.isError).toBeFalsy()
  expect(first.structuredContent.status).toBe('pin')
  expect(first.structuredContent.pin).toBe('731904')
  expect(first.structuredContent.secondsLeft).toBeGreaterThan(170)
  expect(first.content[0].text).toContain('731904')

  // The result of that poll is lost (host cancelled the call). The next poll
  // MUST carry the same PIN — the human still has not seen it.
  const second: any = handleLoginQrStatus()
  expect(second.structuredContent.status).toBe('pin')
  expect(second.structuredContent.pin).toBe('731904')
  expect(second.content[0].text).toContain('731904')

  // A login_qr while the PIN is outstanding must not thrash the attempt with
  // a second code: it reports the same PIN instead.
  const again: any = await handleLoginQr(service)
  expect(again.structuredContent.status).toBe('pin')
  expect(again.structuredContent.pin).toBe('731904')
  expect(again.content.find((c: any) => c.type === 'image')).toBeUndefined()

  pinTyped.open()
  await tick()
  const finishing: any = handleLoginQrStatus()
  expect(['finishing', 'logged_in']).toContain(
    finishing.structuredContent.status,
  )

  await tick()
  await tick()
  const done: any = handleLoginQrStatus()
  expect(done.structuredContent.status).toBe('logged_in')
  expect(done.structuredContent.mid).toBe('u-test-mid')
})

test('login_qr reuses the in-flight attempt instead of starting a second one', async () => {
  let starts = 0
  const scanned = gate()
  const emitter = new EventEmitter() as any
  emitter.profile = null
  emitter.credentialStore = { get: async () => null, set: async () => {} }
  emitter.startQrLogin = async () => {
    starts++
    await tick()
    emitter.emit('qrCreated', QR('reuse'))
    // Stay in flight (the real flow long-polls for minutes) until the test
    // has made its second call.
    await scanned.opened
    emitter.profile = { mid: 'u-reuse', displayName: 'Reuse' }
  }

  const first: any = await handleLoginQr(emitter as LineProtocolService)
  const second: any = await handleLoginQr(emitter as LineProtocolService)
  expect(starts).toBe(1)
  expect(second.content[0].text).toContain('forsecure/reuse')
  expect(first.content[0].text).toContain('forsecure/reuse')

  scanned.open()
  await tick()
  await tick()
  expect(handleLoginQrStatus().structuredContent.mid).toBe('u-reuse')
})

test('a settled attempt is not reused — a fresh login_qr starts a new flow', async () => {
  let starts = 0
  const service = fakeService(async (s) => {
    starts++
    await tick()
    s.emit('qrCreated', QR(`fresh-${starts}`))
    await tick()
  })

  const first: any = await handleLoginQr(service)
  expect(first.content[0].text).toContain('fresh-1')
  // Let the first flow settle before the second call.
  await tick()
  await tick()
  expect(handleLoginQrStatus().structuredContent.status).toBe('logged_in')

  const second: any = await handleLoginQr(service)
  expect(starts).toBe(2)
  expect(second.content[0].text).toContain('fresh-2')
  // The new attempt replaced the settled record.
  expect(getPendingQrLogin()?.qrUrl).toContain('fresh-2')
})

test('a stale unscanned attempt is aborted and replaced by a fresh code', async () => {
  let starts = 0
  let aborted = 0
  const stuck = gate()
  const service = fakeService(async (s) => {
    starts++
    await tick()
    s.emit('qrCreated', QR(`stale-${starts}`))
    if (starts === 1) {
      await stuck.opened
    }
  })
  ;(service as any).qrLogin = {
    abort: () => {
      aborted++
    },
  }

  const first: any = await handleLoginQr(service)
  expect(first.content[0].text).toContain('stale-1')

  // Pretend LINE's ~3-minute code window has passed with nobody scanning.
  const pending = getPendingQrLogin()!
  expect(handleLoginQrStatus().structuredContent.secondsLeft).toBeGreaterThan(0)
  pending.startedAt -= 200_000
  pending.qrIssuedAt! -= 200_000
  const dead: any = handleLoginQrStatus()
  expect(dead.structuredContent.status).toBe('waiting_for_scan')
  expect(dead.structuredContent.secondsLeft).toBe(0)
  expect(dead.content[0].text).toContain('call `login_qr` for a fresh one')

  const second: any = await handleLoginQr(service)
  expect(starts).toBe(2)
  expect(aborted).toBe(1)
  expect(second.content[0].text).toContain('stale-2')
  stuck.open()
})

test('an old attempt whose PIN is fresh is still live — no second code', async () => {
  let starts = 0
  const hold = gate()
  const service = fakeService(async (s) => {
    starts++
    await tick()
    s.emit('qrCreated', QR('slow-scan'))
    await tick()
    s.emit('scanVerified')
    s.emit('pinCreated', '286971')
    await hold.opened
  })

  await handleLoginQr(service)
  await tick()
  await tick()
  // The human took nearly the whole window to scan; the PIN was just issued.
  const pending = getPendingQrLogin()!
  pending.startedAt -= 170_000
  expect(pending.stage).toBe('pin')

  const again: any = await handleLoginQr(service)
  expect(starts).toBe(1)
  expect(again.structuredContent.status).toBe('pin')
  expect(again.structuredContent.pin).toBe('286971')
  hold.open()
})

test('a failed flow surfaces the real error through status, repeatedly', async () => {
  const service = fakeService(async (s) => {
    await tick()
    s.emit('qrCreated', QR('fail'))
    await tick()
    throw new Error(
      'QR code was not confirmed in time — it expired. Start login_qr again for a fresh code.',
    )
  })

  await handleLoginQr(service)
  await tick()
  await tick()
  const failed: any = handleLoginQrStatus()
  expect(failed.isError).toBe(true)
  expect(failed.structuredContent.status).toBe('failed')
  expect(failed.structuredContent.message).toContain('not confirmed in time')
  expect(failed.content[0].text).toContain('not confirmed in time')
  expect(failed.content[0].text).toContain('login_qr')
  // Still readable on the next poll — nothing was consumed.
  expect(handleLoginQrStatus().structuredContent.status).toBe('failed')
})

test('login_qr that fails before any code surfaces the failure, not a 20s wait', async () => {
  const service = fakeService(async () => {
    await tick()
    throw new Error('createQrSession: LINE said no')
  })
  const result: any = await handleLoginQr(service)
  expect(result.isError).toBe(true)
  expect(result.structuredContent.status).toBe('failed')
  expect(result.content[0].text).toContain('LINE said no')
})
