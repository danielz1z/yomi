import { expect, test } from 'bun:test'
import { LINE_APP_CONFIG } from '../../core/config.js'
import { decodeResponseMessage } from '../../core/thrift/index.js'
import { LineQrLogin } from './index.js'
import {
  QR_POLL_DEFAULT_INTERVAL_SEC,
  QR_POLL_DEFAULT_MAX_COUNT,
} from './steps.js'

/**
 * Recorded invocation of one QR transport hop.
 */
interface RecordedCall {
  method: string | undefined
  fields: Record<number, any> | undefined
  longPoll: boolean
}

/**
 * Build a LineQrLogin whose two transport methods are replaced by a
 * scriptable fake. Requests arrive as encoded TCompact CALL buffers and are
 * decoded here so tests can assert the exact method/field shape on the wire
 * — no LINE server is ever contacted.
 *
 * @param responder - Maps each decoded request to its transport response.
 * @returns The login instance plus the recorded call log.
 */
function makeQrLogin(responder: (call: RecordedCall, seq: number) => any) {
  const calls: RecordedCall[] = []
  const login = new LineQrLogin({ systemName: 'yomi-test', modelName: 'yomi' })
  const invoke = (data: Buffer, longPoll: boolean) => {
    const decoded = decodeResponseMessage(data)
    const call: RecordedCall = {
      method: decoded.method,
      fields: decoded.fields,
      longPoll,
    }
    calls.push(call)
    return responder(call, calls.length)
  }
  login.sendQr = (data: Buffer) => Promise.resolve(invoke(data, false))
  login.sendQrLongPoll = (data: Buffer) => Promise.resolve(invoke(data, true))
  return { login, calls }
}

/** The standard happy-path responder: scan confirmed, certificate rejected, PIN entered. */
function happyPathResponder(call: RecordedCall): any {
  switch (call.method) {
    case 'createSession':
      return { fields: { 0: { 1: 'sqr-session-id' } } }
    case 'createQrCodeForSecure':
      return {
        fields: {
          0: {
            1: 'https://line.me/R/qr/forsecure/abc',
            2: 12,
            3: 30,
            4: 'nonce-123',
          },
        },
      }
    case 'checkQrCodeVerified':
      return { fields: { 0: {} } }
    case 'verifyCertificate':
      // Certificate rejected → exception at field 1 → PIN path.
      return { fields: { 1: { 1: 8, 2: 'certificate invalid' } } }
    case 'createPinCode':
      return { fields: { 0: { 1: '482916' } } }
    case 'checkPinCodeVerified':
      return { fields: { 0: {} } }
    case 'qrCodeLoginV2ForSecure':
      return {
        fields: {
          0: {
            1: 'qr-cert-pem',
            3: {
              1: 'v3-access-token',
              2: 'v3-refresh-token',
              3: 7776000n,
              6: 1750000000n,
            },
            4: 'u0123456789abcdef',
            6: {
              e2eeInfo: JSON.stringify({
                encryptedKeyChain: 'a2V5Y2hhaW4=',
                publicKey: 'c2VydmVyLXB1YmxpYw==',
                keyId: 7,
                e2eeVersion: 1,
              }),
            },
          },
        },
      }
    default:
      throw new Error(`unexpected call: ${call.method}`)
  }
}

test('happy path: session → ForSecure QR → scan → PIN → login, in order', async () => {
  const { login, calls } = makeQrLogin(happyPathResponder)
  const events: string[] = []
  let emittedUrl: string | null = null
  login.on('qrCreated', (url: string) => {
    events.push('qrCreated')
    emittedUrl = url
  })
  login.on('pinCreated', () => events.push('pinCreated'))
  login.on('scanVerified', () => events.push('scanVerified'))

  const result = await login.login()

  expect(calls.map((c) => c.method)).toEqual([
    'createSession',
    'createQrCodeForSecure',
    'checkQrCodeVerified',
    'verifyCertificate',
    'createPinCode',
    'checkPinCodeVerified',
    'qrCodeLoginV2ForSecure',
  ])
  expect(events).toEqual(['qrCreated', 'scanVerified', 'pinCreated'])
  expect(emittedUrl!).toContain('https://line.me/R/qr/forsecure/abc?secret=')
  expect(emittedUrl!).toContain('&e2eeVersion=1')

  expect(result.authToken).toBe('v3-access-token')
  expect(result.refreshToken).toBe('v3-refresh-token')
  expect(result.certificate).toBe('qr-cert-pem')
  expect(result.mid).toBe('u0123456789abcdef')
  // thrift i64 arrives as bigint; the result must carry plain numbers.
  expect(result.durationUntilRefreshInSec).toBe(7776000)
  expect(result.tokenIssueTimeEpochSec).toBe(1750000000)
  expect(result.secretKey).toHaveLength(32)
  expect(result.publicKey).toHaveLength(32)

  // E2EE bootstrap material recovered from metaData["e2eeInfo"] (JSON).
  expect(result.e2eeInfo?.encryptedKeyChain?.toString('base64')).toBe(
    'a2V5Y2hhaW4=',
  )
  expect(result.e2eeInfo?.serverPublicKey?.toString('base64')).toBe(
    'c2VydmVyLXB1YmxpYw==',
  )
  expect(result.e2eeInfo?.keyId).toBe(7)
  expect(result.e2eeInfo?.e2eeVersion).toBe(1)
})

test('the QR URL carries the temporal PUBLIC key; the secret half stays local', async () => {
  const { login } = makeQrLogin(happyPathResponder)
  let emittedUrl: string | null = null
  login.on('qrCreated', (url: string) => {
    emittedUrl = url
  })
  await login.login()

  const secretParam = new URL(emittedUrl!).searchParams.get('secret') ?? ''
  expect(Buffer.from(secretParam, 'base64').equals(login.publicKey!)).toBe(true)
  expect(emittedUrl!).not.toContain(login.secretKey!.toString('base64'))
})

test('request wire shapes: ForSecure field layouts, not legacy', async () => {
  const { login, calls } = makeQrLogin(happyPathResponder)
  await login.login('saved-cert')

  const byMethod = new Map(calls.map((c) => [c.method, c]))

  // createQrCodeForSecure: { 1: { 1: authSessionId } }
  const create = byMethod.get('createQrCodeForSecure')!
  expect(create.fields?.[1]?.[1]).toBe('sqr-session-id')

  // checkQrCodeVerified / checkPinCodeVerified ride the long-poll hop.
  expect(byMethod.get('checkQrCodeVerified')!.longPoll).toBe(true)
  expect(byMethod.get('checkPinCodeVerified')!.longPoll).toBe(true)
  expect(byMethod.get('createQrCodeForSecure')!.longPoll).toBe(false)

  // verifyCertificate carries the stored certificate at field 2.
  const verify = byMethod.get('verifyCertificate')!
  expect(verify.fields?.[1]?.[1]).toBe('sqr-session-id')
  expect(verify.fields?.[1]?.[2]).toBe('saved-cert')

  // qrCodeLoginV2ForSecure echoes the nonce at field 5 and asks for
  // auto-login at field 4.
  const finish = byMethod.get('qrCodeLoginV2ForSecure')!
  const req = finish.fields?.[1]
  expect(req?.[1]).toBe('sqr-session-id')
  expect(req?.[2]).toBe('yomi-test')
  expect(req?.[3]).toBe('yomi')
  expect(req?.[4]).toBe(true)
  expect(req?.[5]).toBe('nonce-123')
})

test('legacy QR RPCs are never called (LINE 26+ expires them server-side)', async () => {
  const { login, calls } = makeQrLogin(happyPathResponder)
  await login.login()
  const methods = calls.map((c) => c.method)
  // Exact matches only — qrCodeLoginV2ForSecure legitimately CONTAINS the
  // legacy names as prefixes.
  expect(methods).not.toContain('createQrCode')
  expect(methods).not.toContain('qrCodeLogin')
  expect(methods).not.toContain('qrCodeLoginV2')
})

test('client identity stays DESKTOPMAC (never CHROMEOS)', () => {
  expect(LINE_APP_CONFIG.lineApp.startsWith('DESKTOPMAC\t')).toBe(true)
  expect(LINE_APP_CONFIG.lineApp).not.toContain('CHROMEOS')
  expect(LINE_APP_CONFIG.lineApp).not.toContain('Chrome')
  const login = new LineQrLogin()
  expect(login.config.lineApp).toBe(LINE_APP_CONFIG.lineApp)
  expect(login.config.qrPath).toBe('/acct/lgn/sq/v1')
  expect(login.config.qrLongPollPath).toBe('/acct/lp/lgn/sq/v1')
})

test('an accepted certificate skips the PIN round trip entirely', async () => {
  const { login, calls } = makeQrLogin((call) => {
    if (call.method === 'verifyCertificate') {
      return { fields: { 0: {} } }
    }
    return happyPathResponder(call)
  })
  const events: string[] = []
  login.on('certificateVerified', () => events.push('certificateVerified'))
  login.on('pinCreated', () => events.push('pinCreated'))

  await login.login('good-cert')

  expect(events).toEqual(['certificateVerified'])
  expect(calls.map((c) => c.method)).not.toContain('createPinCode')
  expect(calls.map((c) => c.method)).not.toContain('checkPinCodeVerified')
})

test('long-poll timeouts and 410 beats are tolerated until the scan lands', async () => {
  let polls = 0
  const { login } = makeQrLogin((call) => {
    if (call.method === 'checkQrCodeVerified') {
      polls++
      if (polls === 1) return { error: 'timeout' }
      if (polls === 2) return { error: 'empty_response', statusCode: 410 }
      return { fields: { 0: {} } }
    }
    return happyPathResponder(call)
  })
  const result = await login.login()
  expect(result.authToken).toBe('v3-access-token')
  expect(polls).toBe(3)
})

test('a scan that never lands exhausts the server poll budget and fails honestly', async () => {
  const { login } = makeQrLogin((call) => {
    if (call.method === 'checkQrCodeVerified') {
      return { error: 'timeout' }
    }
    return happyPathResponder(call)
  })
  await expect(login.login()).rejects.toThrow(/not confirmed in time/)
})

test('a thrift exception from qrCodeLoginV2ForSecure surfaces code and message', async () => {
  const { login } = makeQrLogin((call) => {
    if (call.method === 'qrCodeLoginV2ForSecure') {
      return { fields: { 1: { 1: 20, 2: 'session expired' } } }
    }
    return happyPathResponder(call)
  })
  await expect(login.login()).rejects.toThrow(
    /qrCodeLoginV2ForSecure failed: code=20 msg="session expired"/,
  )
})

test('E2EE bootstrap material is also read from a field-10 struct', async () => {
  const { login } = makeQrLogin((call) => {
    if (call.method === 'qrCodeLoginV2ForSecure') {
      return {
        fields: {
          0: {
            1: 'qr-cert-pem',
            3: { 1: 'v3-access-token', 2: 'v3-refresh-token' },
            4: 'u0123456789abcdef',
            // Struct form (numeric keys, per E2EEKeyInfo): 1 version,
            // 2 keyId, 4 publicKey, 6 encryptedKeyChain.
            10: {
              1: 1,
              2: 9,
              4: 'c3RydWN0LXB1YmxpYw==',
              6: 'c3RydWN0LWtleWNoYWlu',
            },
          },
        },
      }
    }
    return happyPathResponder(call)
  })
  const result = await login.login()
  expect(result.e2eeInfo?.keyId).toBe(9)
  expect(result.e2eeInfo?.encryptedKeyChain?.toString('base64')).toBe(
    'c3RydWN0LWtleWNoYWlu',
  )
  expect(result.e2eeInfo?.serverPublicKey?.toString('base64')).toBe(
    'c3RydWN0LXB1YmxpYw==',
  )
})

test('abort stops the poll loop and the login fails honestly', async () => {
  const { login } = makeQrLogin((call) => {
    if (call.method === 'checkQrCodeVerified') {
      login.abort()
      return { error: 'timeout' }
    }
    return happyPathResponder(call)
  })
  await expect(login.login()).rejects.toThrow(/not confirmed in time/)
})

test('a ForSecure response without poll budget falls back to the documented defaults', async () => {
  let scanPolls = 0
  const { login } = makeQrLogin((call) => {
    if (call.method === 'createQrCodeForSecure') {
      // LINE omits fields 2/3 (protocol drift): only URL + nonce arrive.
      return {
        fields: {
          0: { 1: 'https://line.me/R/qr/forsecure/abc', 4: 'nonce-123' },
        },
      }
    }
    if (call.method === 'checkQrCodeVerified') {
      scanPolls++
      // Answer with "no action yet" until the default budget is about to
      // run out — proves the loop did not give up after a single hop.
      return scanPolls < QR_POLL_DEFAULT_MAX_COUNT
        ? { error: 'empty_response', statusCode: 410 }
        : { fields: { 0: {} } }
    }
    return happyPathResponder(call)
  })
  const result = await login.login()
  expect(result.authToken).toBe('v3-access-token')
  expect(scanPolls).toBe(QR_POLL_DEFAULT_MAX_COUNT)
  expect(QR_POLL_DEFAULT_INTERVAL_SEC).toBe(30)
})
