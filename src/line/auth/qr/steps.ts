/**
 * LINE ForSecure QR secondary-device login — protocol steps.
 *
 * Flow: createQrSession → createQrCodeForSecure → checkQrCodeVerified →
 *       verifyCertificate (→ createPinCode → checkPinCodeVerified when the
 *       certificate is rejected) → qrCodeLoginV2ForSecure
 *
 * This is the CURRENT QR flow (LINE 26+). The legacy `createQrCode` /
 * `qrCodeLogin(V2)` RPCs are deliberately NOT implemented here: the server
 * marks legacy-issued QR sessions expired immediately, so a login through
 * them can never succeed — callers must get an honest failure, not a dead
 * QR. Field layouts follow linejs's `requestSQR2` (evex-dev/linejs), whose
 * schema source is the LINE Android 26.6.2 smali (`oc4.i` / `oc4.p`).
 */

import {
  boolField,
  encodeCallMessage,
  stringField,
  structField,
} from '../../core/thrift/index.js'
import type { ThriftFieldTuple } from '../../core/thrift/types.js'

/**
 * Fallbacks for the server-supplied long-poll budget. LINE's
 * CreateQrCodeForSecureResponse normally carries both; when it does not
 * (older builds, protocol drift) these keep the scan window at up to
 * 12 × 30s = 6 minutes instead of giving up after a single hop.
 */
export const QR_POLL_DEFAULT_MAX_COUNT = 12
export const QR_POLL_DEFAULT_INTERVAL_SEC = 30

interface QrContext {
  authSessionId: string
  seq: number
  aborted: boolean
  sendQr: (data: Buffer) => Promise<any>
  sendQrLongPoll: (data: Buffer, holdMs: number) => Promise<any>
}

/** Server-supplied long-poll budget + completion nonce from createQrCodeForSecure. */
export interface QrCodeForSecure {
  callbackUrl: string
  longPollingMaxCount: number
  longPollingIntervalSec: number
  nonce: string
}

/**
 * True when one long-poll hop ended with "no user action yet" rather than a
 * real outcome: a client-side socket timeout, or LINE's own empty 410/408
 * answer on the long-poll endpoint. Anything else is a decisive response.
 *
 * @param result - Transport response for one hop.
 * @returns Whether the caller should simply poll again.
 */
function isLongPollNoAnswer(result: any): boolean {
  if (result?.error === 'timeout') {
    return true
  }
  return (
    result?.error === 'empty_response' &&
    (result?.statusCode === 410 || result?.statusCode === 408)
  )
}

/**
 * Step 1: Open a QR auth session. Unlike the passwordless variant this
 * takes NO phone/region — the account is identified by whoever scans —
 * which is exactly why an account created on Apple with no phone number can
 * use it.
 *
 * @param ctx - QR login context.
 * @returns The auth session id ("sqr") carried through every later step.
 */
export async function createQrSession(ctx: QrContext): Promise<string> {
  const data = encodeCallMessage('createSession', ctx.seq++, [])
  const result = await ctx.sendQr(data)
  const sqr = result?.fields?.[0]?.[1]
  if (!sqr) {
    throw new Error(`createSession(QR) failed: ${JSON.stringify(result)}`)
  }
  return sqr
}

/**
 * Step 2: Mint the QR payload (ForSecure). Returns the callback URL the
 * phone scans plus the long-poll budget and the nonce that
 * `qrCodeLoginV2ForSecure` must echo back.
 *
 * @param ctx - QR login context.
 * @returns The callback URL, long-poll budget, and completion nonce.
 */
export async function createQrCodeForSecure(
  ctx: QrContext,
): Promise<QrCodeForSecure> {
  const fields: ThriftFieldTuple[] = [
    structField(1, [stringField(1, ctx.authSessionId)]),
  ]
  const data = encodeCallMessage('createQrCodeForSecure', ctx.seq++, fields)
  const result = await ctx.sendQr(data)
  const response = result?.fields?.[0]
  const callbackUrl = response?.[1]
  if (!callbackUrl) {
    throw new Error(
      `createQrCodeForSecure failed: ${JSON.stringify(result?.fields ?? result)}`,
    )
  }
  return {
    callbackUrl,
    longPollingMaxCount: Number(response[2]) || QR_POLL_DEFAULT_MAX_COUNT,
    longPollingIntervalSec: Number(response[3]) || QR_POLL_DEFAULT_INTERVAL_SEC,
    nonce: response[4] ?? '',
  }
}

/**
 * Shared long-poll loop for the two "wait for the human" hops
 * (checkQrCodeVerified / checkPinCodeVerified): LINE holds each request
 * open for `intervalSec` and expects `maxCount` sequential hops — a single
 * non-long-polling call makes the server expire the session almost at once.
 *
 * @param ctx - QR login context.
 * @param method - The check method to poll with.
 * @param maxCount - Server-supplied hop budget.
 * @param intervalSec - Server-held duration of each hop, in seconds.
 * @returns True once the phone confirmed, false on timeout/abort.
 */
async function pollUntilConfirmed(
  ctx: QrContext,
  method: 'checkQrCodeVerified' | 'checkPinCodeVerified',
  maxCount: number,
  intervalSec: number,
): Promise<boolean> {
  const intervalMs = Math.max(1, intervalSec) * 1000
  for (let i = 0; i < maxCount; i++) {
    if (ctx.aborted) {
      return false
    }
    const fields: ThriftFieldTuple[] = [
      structField(1, [stringField(1, ctx.authSessionId)]),
    ]
    const data = encodeCallMessage(method, ctx.seq++, fields)
    const result = await ctx.sendQrLongPoll(data, intervalMs)
    if (isLongPollNoAnswer(result)) {
      continue
    }
    if (result?.error) {
      // A decisive transport failure (DNS, TLS, ...) — not a polling beat.
      throw new Error(`${method} failed: ${result.error}`)
    }
    if (result?.fields?.[1]) {
      const exc = result.fields[1]
      throw new Error(`${method} rejected: ${JSON.stringify(exc)}`)
    }
    if (result?.fields) {
      return true
    }
  }
  return false
}

/**
 * Step 3: Long-poll until the human scans the QR and confirms on the phone.
 *
 * @param ctx - QR login context.
 * @param maxCount - Server-supplied hop budget.
 * @param intervalSec - Server-held hop duration, in seconds.
 * @returns True once the QR was confirmed on the phone.
 */
export async function checkQrCodeVerified(
  ctx: QrContext,
  maxCount: number,
  intervalSec: number,
): Promise<boolean> {
  return pollUntilConfirmed(ctx, 'checkQrCodeVerified', maxCount, intervalSec)
}

/**
 * Step 4: Offer a stored login certificate. When LINE accepts it, the PIN
 * round trip is skipped entirely; when it answers with an exception (or no
 * usable response), the caller drops into the PIN path. Never throws on a
 * rejected certificate — that outcome IS the PIN path's entry condition.
 *
 * @param ctx - QR login context.
 * @param certificate - Previously saved certificate, or empty string.
 * @returns True when the certificate was accepted (PIN can be skipped).
 */
export async function verifyQrCertificate(
  ctx: QrContext,
  certificate: string,
): Promise<boolean> {
  const fields: ThriftFieldTuple[] = [
    structField(1, [
      stringField(1, ctx.authSessionId),
      stringField(2, certificate || ''),
    ]),
  ]
  const data = encodeCallMessage('verifyCertificate', ctx.seq++, fields)
  const result = await ctx.sendQr(data)
  if (result?.error) {
    return false
  }
  return Boolean(result?.fields && !result.fields[1])
}

/**
 * Step 5a: Ask LINE for the PIN the human must enter on their phone.
 *
 * @param ctx - QR login context.
 * @returns The PIN to display.
 */
export async function createQrPinCode(ctx: QrContext): Promise<string> {
  const fields: ThriftFieldTuple[] = [
    structField(1, [stringField(1, ctx.authSessionId)]),
  ]
  const data = encodeCallMessage('createPinCode', ctx.seq++, fields)
  const result = await ctx.sendQr(data)
  const pin = result?.fields?.[0]?.[1]
  if (!pin) {
    throw new Error(`createPinCode failed: ${JSON.stringify(result)}`)
  }
  return pin
}

/**
 * Step 5b: Long-poll until the PIN is entered on the phone.
 *
 * @param ctx - QR login context.
 * @param maxCount - Server-supplied hop budget.
 * @param intervalSec - Server-held hop duration, in seconds.
 * @returns True once the PIN was entered.
 */
export async function checkQrPinCodeVerified(
  ctx: QrContext,
  maxCount: number,
  intervalSec: number,
): Promise<boolean> {
  return pollUntilConfirmed(ctx, 'checkPinCodeVerified', maxCount, intervalSec)
}

/**
 * Step 6: Finish the login, echoing the ForSecure nonce. Response is the
 * QrCodeLoginV2Response struct: 1 certificate, 2 legacy accessTokenV2,
 * 3 tokenV3IssueResult, 4 mid, 5 lastBindTimestamp, 6 metaData; E2EE
 * bootstrap material arrives in field 10 or in metaData["e2eeInfo"] (JSON).
 *
 * @param ctx - QR login context.
 * @param nonce - Nonce from createQrCodeForSecure.
 * @param systemName - Device hostname shown on the phone.
 * @param modelName - Device model label shown on the phone.
 * @returns Raw response struct for the caller to map.
 */
export async function qrCodeLoginV2ForSecure(
  ctx: QrContext,
  nonce: string,
  systemName: string,
  modelName: string,
): Promise<Record<number, any>> {
  const fields: ThriftFieldTuple[] = [
    structField(1, [
      stringField(1, ctx.authSessionId),
      stringField(2, systemName),
      stringField(3, modelName),
      boolField(4, true),
      stringField(5, nonce),
    ]),
  ]
  const data = encodeCallMessage('qrCodeLoginV2ForSecure', ctx.seq++, fields)
  const result = await ctx.sendQr(data)
  if (result?.fields?.[1]) {
    const exc = result.fields[1]
    throw new Error(
      `qrCodeLoginV2ForSecure failed: code=${exc[1]} msg="${exc[2]}"`,
    )
  }
  const response = result?.fields?.[0]
  if (!response || typeof response !== 'object') {
    throw new Error('qrCodeLoginV2ForSecure: unexpected response')
  }
  return response
}
