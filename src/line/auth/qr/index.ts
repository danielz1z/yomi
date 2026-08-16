/**
 * LINE ForSecure QR Login — Orchestrator
 *
 * Flow:
 *   1. createQrSession → authSessionId (no phone number involved — this is
 *      the path for accounts that have none)
 *   2. createQrCodeForSecure → callbackUrl + long-poll budget + nonce
 *   3. Temporal NaCl keypair; the PUBLIC key rides the QR URL as
 *      `?secret=…&e2eeVersion=1` so the phone can seal the E2EE keychain
 *      to exactly this device
 *   4. checkQrCodeVerified → long-poll until the phone confirms the scan
 *   5. verifyCertificate → skip PIN when a stored certificate is accepted,
 *      else createPinCode + checkPinCodeVerified
 *   6. qrCodeLoginV2ForSecure → authToken + refreshToken + certificate + mid
 *      (+ E2EE bootstrap material)
 *
 * Identity stays DESKTOPMAC (see ../../core/config.ts) — the same client
 * class the passwordless flow uses. Do NOT switch this to CHROMEOS: that is
 * a different device class and would kick an official LINE for Chrome
 * session on the same machine offline.
 *
 * The legacy `createQrCode` RPC is intentionally absent: LINE 26+ expires
 * legacy QR sessions server-side, so offering it would be offering a login
 * that cannot succeed.
 */

import { Buffer } from 'node:buffer'
import { EventEmitter } from 'node:events'
import nacl from 'tweetnacl'
import { sendRequest } from '../../client/transport.js'
import { LINE_APP_CONFIG } from '../../core/config.js'
import { extractE2EEInfo } from '../protocol/login-metadata.js'
import {
  checkQrCodeVerified,
  checkQrPinCodeVerified,
  createQrCodeForSecure,
  createQrPinCode,
  createQrSession,
  qrCodeLoginV2ForSecure,
  verifyQrCertificate,
} from './steps.js'

const DEFAULT_CONFIG = {
  ...LINE_APP_CONFIG,
}

/** E2EE version tag LINE expects in the QR URL's secret suffix. */
const SQR_E2EE_VERSION = 1

/**
 * Coerce a thrift i64-ish scalar (number|string|bigint) into a plain number
 * of seconds, or null when absent. Token lifetimes fit Number comfortably.
 *
 * @param value - Raw decoded scalar.
 * @returns Seconds as a number, or null.
 */
function toEpochSeconds(value: unknown): number | null {
  if (value == null) {
    return null
  }
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * Resolve the E2EE bootstrap payload from a QrCodeLoginV2ForSecure response.
 * LINE has shipped it two ways: as a struct at field 10 (pre-ForSecure QR
 * layout) and as a JSON string in `metaData["e2eeInfo"]` (ForSecure). The
 * numeric-keyed struct form and the JSON named-key form are both understood
 * by extractE2EEInfo.
 *
 * @param response - Raw QrCodeLoginV2Response struct.
 * @returns Normalized E2EE info, or null when the response carries none.
 */
function extractQrE2EEInfo(response: Record<number, any>) {
  const metaData = response?.[6]
  const metaValue =
    metaData && typeof metaData === 'object' ? metaData.e2eeInfo : null
  let parsed: unknown = null
  if (typeof metaValue === 'string' && metaValue.length > 0) {
    try {
      parsed = JSON.parse(metaValue)
    } catch {
      parsed = null
    }
  } else if (metaValue && typeof metaValue === 'object') {
    parsed = metaValue
  }
  return extractE2EEInfo(response?.[10] ?? parsed)
}

/**
 * Handles the LINE ForSecure QR login flow.
 * Emits events: session, qrCreated, certificateVerified, pinCreated,
 * pinVerified, loginComplete, error, abort
 */
export class LineQrLogin extends EventEmitter {
  public config: any
  public authSessionId: string | null
  public secretKey: Buffer | null
  public publicKey: Buffer | null
  public certificate: string | null
  public aborted: boolean
  public seq: number

  constructor(config = {}) {
    super()
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.authSessionId = null
    this.secretKey = null
    this.publicKey = null
    this.certificate = null
    this.aborted = false
    this.seq = 1
  }

  /**
   * Abort the login process.
   */
  abort(): void {
    this.aborted = true
    this.emit('abort')
  }

  /**
   * Build the scannable QR URL: LINE's callback URL plus the temporal E2EE
   * public key, matching the official secondary-client suffix.
   *
   * @param callbackUrl - URL returned by createQrCodeForSecure.
   * @returns The URL to render as a QR code.
   */
  private buildQrUrl(callbackUrl: string): string {
    if (!this.publicKey) {
      throw new Error('buildQrUrl called before the keypair was generated')
    }
    const secret = encodeURIComponent(this.publicKey.toString('base64'))
    return `${callbackUrl}?secret=${secret}&e2eeVersion=${SQR_E2EE_VERSION}`
  }

  /**
   * Run the full ForSecure QR login flow.
   *
   * @param savedCertificate - Previously saved certificate for skip-PIN.
   * @returns Login result with authToken and credentials, shaped like the
   * passwordless result so the same session persistence applies.
   */
  async login(savedCertificate?: string) {
    this.aborted = false
    this.certificate = savedCertificate || null

    // Step 1-2: session + QR payload (LINE's long-poll budget included).
    this.authSessionId = await createQrSession(this as any)
    this.emit('session', this.authSessionId)
    const qr = await createQrCodeForSecure(this as any)

    // Step 3: temporal E2EE keypair — the secret half never leaves this
    // device; the public half goes into the scanned URL.
    const kp = nacl.box.keyPair()
    this.secretKey = Buffer.from(kp.secretKey)
    this.publicKey = Buffer.from(kp.publicKey)

    const qrUrl = this.buildQrUrl(qr.callbackUrl)
    this.emit('qrCreated', qrUrl)

    // Step 4: wait for the scan + on-phone confirmation.
    const scanned = await checkQrCodeVerified(
      this as any,
      qr.longPollingMaxCount,
      qr.longPollingIntervalSec,
    )
    if (!scanned) {
      throw new Error(
        'QR code was not confirmed in time — it expired. Start login_qr again for a fresh code.',
      )
    }
    this.emit('scanVerified')

    // Step 5: certificate shortcut, else PIN on the phone.
    const certOk = await verifyQrCertificate(
      this as any,
      this.certificate || '',
    )
    if (certOk) {
      this.emit('certificateVerified')
    } else {
      const pin = await createQrPinCode(this as any)
      this.emit('pinCreated', pin)
      const pinOk = await checkQrPinCodeVerified(
        this as any,
        qr.longPollingMaxCount,
        qr.longPollingIntervalSec,
      )
      if (!pinOk) {
        throw new Error('PIN verification failed or timed out')
      }
      this.emit('pinVerified')
    }

    // Step 6: final login, echoing the ForSecure nonce.
    const response = await qrCodeLoginV2ForSecure(
      this as any,
      qr.nonce,
      this.config.systemName,
      this.config.modelName,
    )
    const tokenInfo = response[3]
    // Prefer the V3 token (carries refreshToken + lifetimes); fall back to
    // the legacy accessTokenV2 at field 2, the same field the pre-ForSecure
    // qrCodeLogin(V2) consumers read — a LINE build that issues only the
    // legacy token still logs in, just without refresh support.
    const authToken = tokenInfo?.[1] ?? response[2]
    if (!authToken) {
      throw new Error('qrCodeLoginV2ForSecure: no access token in response')
    }

    const result = {
      authToken,
      refreshToken: tokenInfo?.[2] ?? null,
      durationUntilRefreshInSec: toEpochSeconds(tokenInfo?.[3]),
      tokenIssueTimeEpochSec: toEpochSeconds(tokenInfo?.[6]),
      certificate: response[1] ?? null,
      mid: response[4] ?? null,
      secretKey: this.secretKey,
      publicKey: this.publicKey,
      e2eeInfo: extractQrE2EEInfo(response),
      nonce: null,
    }

    this.emit('loginComplete', result)
    return result
  }

  // ─── Transport (used by steps via QrContext interface) ──────────

  /**
   * Send a QR login request to the session endpoint.
   * @param data - TCompact-encoded body
   * @returns Promise resolving to decoded response
   */
  sendQr(data: Buffer | Uint8Array) {
    return sendRequest(this.config.host, this.config.qrPath, data, {}, 30000, {
      logger: this.config?.startupFlowLogger || this.config?.logger,
    })
  }

  /**
   * Send a long-poll QR login request. The auth session id rides the
   * X-Line-Access header (the QR endpoints have no token yet) and `x-lst`
   * tells LINE how long to hold the poll open; the socket timeout gets a
   * grace margin on top so LINE's own deadline always speaks first.
   * @param data - TCompact-encoded body
   * @param holdMs - How long LINE should hold this poll open, in ms
   * @returns Promise resolving to decoded response
   */
  sendQrLongPoll(data: Buffer | Uint8Array, holdMs: number) {
    return sendRequest(
      this.config.host,
      this.config.qrLongPollPath,
      data,
      {
        'X-Line-Access': this.authSessionId,
        'x-lst': String(Math.max(1000, Math.round(holdMs))),
      },
      Math.max(1000, Math.round(holdMs)) + 5000,
      { logger: this.config?.startupFlowLogger || this.config?.logger },
    )
  }
}
