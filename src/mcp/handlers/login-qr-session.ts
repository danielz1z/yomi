/**
 * The one in-flight ForSecure QR login, shared by the `login_qr` /
 * `login_qr_status` tool pair (the QR counterpart of ./login-session.ts for
 * the passwordless flow).
 *
 * WHY this is a record that gets snapshotted, not a promise that gets
 * awaited: the human side of a QR login (scan, confirm, maybe type a PIN)
 * takes minutes, and MCP hosts cancel tool calls that stay open that long —
 * observed as `MCP error -32001: Request timed out`. A tool call that blocks
 * for the human is therefore the wrong unit of work: when the host kills it,
 * whatever that call was about to return (the PIN, most painfully) is lost,
 * and the login itself keeps running with nobody able to see it. So the
 * flow runs in the background on `runQrLogin` and every tool call only READS
 * this record and returns at once. Nothing is consumed by reading: the PIN
 * stays in the record for as long as LINE would still accept it, so a poll
 * whose result the client never received costs nothing.
 *
 * `runQrLogin` (../../cli/login-qr.ts) remains the single login sequence —
 * this module only holds the promise, the stage LINE has reached, and the
 * payloads it produced.
 */
import type { QrLoginResult } from '../../cli/login-qr.js'
import { runQrLogin } from '../../cli/login-qr.js'
import { LINE_PIN_CODE_LIFETIME_MS } from '../../line/auth/pwless/index.js'
import type { LineProtocolService } from '../../line/core/service.js'
import { createCliLogger } from '../../util/log.js'

const log = createCliLogger('Yomi')

/**
 * How long the QR code — and later the PIN — stays usable once LINE has
 * issued it. Bound to LINE's real code lifetime (an external fact, ~3
 * minutes from the LINE Help Center — see line/auth/pwless/index.ts), NOT to
 * yomi's own polling patience: LINE kills the code, yomi only watches.
 */
const QR_WINDOW_MS = LINE_PIN_CODE_LIFETIME_MS

/** How long a `login_qr` call waits for LINE to issue the QR payload. */
export const QR_WAIT_TIMEOUT_MS = 20000

/**
 * Where a QR login attempt is, in LINE's own steps (see
 * ../../line/auth/qr/index.ts). Each value is also the `status` a
 * `login_qr_status` result carries.
 */
type QrLoginStage =
  /** `runQrLogin` started; LINE has not issued the QR payload yet. */
  | 'waiting_for_qr'
  /** QR issued; the primary phone has not confirmed the scan yet. */
  | 'waiting_for_scan'
  /** The phone confirmed the scan; LINE is checking the stored certificate. */
  | 'scan_confirmed'
  /** LINE rejected/lacked a certificate and issued a PIN the human must type on the phone. */
  | 'pin'
  /** Certificate accepted or PIN accepted; the final token exchange is running. */
  | 'finishing'
  /** Settled: the session is live and persisted. */
  | 'logged_in'
  /** Settled: the attempt failed (LINE's window died, network, revoke, …). */
  | 'failed'

/**
 * What `login_qr_status` returns — one object per stage, plus `none` when
 * no attempt has been made in this server's lifetime. `secondsLeft` is how
 * much of LINE's ~3-minute window remains for the step the human must act
 * on (0 once it is dead); the machine shape is deliberately flat so a client
 * can render it without knowing the flow.
 */
export type QrLoginStatus =
  | { status: 'none' }
  | { status: 'waiting_for_qr' }
  | { status: 'waiting_for_scan'; qrUrl: string; secondsLeft: number }
  | { status: 'scan_confirmed' }
  | { status: 'pin'; pin: string; secondsLeft: number }
  | { status: 'finishing' }
  | { status: 'logged_in'; mid: string | null; displayName: string | null }
  | { status: 'failed'; message: string }

/** At most one QR login attempt is tracked at a time. */
export interface PendingQrLogin {
  /** The runQrLogin promise itself — guarded separately against unhandled rejection. */
  promise: Promise<QrLoginResult>
  /** The step LINE has reached; `logged_in`/`failed` are the settled ones. */
  stage: QrLoginStage
  /** The scannable payload once LINE has issued it; null while still waiting. */
  qrUrl: string | null
  /** Epoch millis when `qrUrl` was set; null while none. */
  qrIssuedAt: number | null
  /** The PIN once LINE has issued it; null while none. Never cleared by a read. */
  pin: string | null
  /** Epoch millis when `pin` was set; null while none. */
  pinIssuedAt: number | null
  /** The profile once the flow succeeded; null otherwise. */
  result: QrLoginResult | null
  /** The failure once the flow failed; undefined otherwise. */
  error: unknown
  /** True once the flow settled (success or failure). A settled record is never reused. */
  settled: boolean
  startedAt: number
  /** Resolves the instant `qrUrl` is set OR the flow settles first (failure before any QR). */
  qrReady: Promise<void>
}

let pendingQrLogin: PendingQrLogin | null = null

/** @returns The tracked QR login (live or settled), or null when none was ever started. */
export function getPendingQrLogin(): PendingQrLogin | null {
  return pendingQrLogin
}

/**
 * Whether an attempt can still succeed as far as LINE is concerned. The
 * ~3-minute window restarts when the PIN is issued (the PIN has its own
 * lifetime), and once the phone has done its part there is no human deadline
 * left to miss — the remaining steps are yomi talking to LINE.
 *
 * @param pending - The attempt to judge.
 * @param now - Current epoch millis.
 * @returns True while the attempt is worth waiting on.
 */
function isLive(pending: PendingQrLogin, now: number): boolean {
  if (pending.settled) {
    return false
  }
  switch (pending.stage) {
    case 'waiting_for_qr':
    case 'waiting_for_scan':
      return now - pending.startedAt < QR_WINDOW_MS
    case 'pin':
      return now - (pending.pinIssuedAt ?? now) < QR_WINDOW_MS
    default:
      return true
  }
}

/**
 * The in-flight QR login only if it is still worth reusing (unsettled, and
 * LINE's window for the step the human is on has not run out).
 *
 * @param now - Current epoch millis.
 * @returns The live pending QR login, or null.
 */
export function getLivePendingQrLogin(now: number): PendingQrLogin | null {
  return pendingQrLogin && isLive(pendingQrLogin, now) ? pendingQrLogin : null
}

/**
 * Start a new QR login in the background and register it as the one tracked
 * QR login, replacing whatever record was there before.
 *
 * The stored promise is the actual `runQrLogin` promise. A `.catch()` is
 * attached immediately (its result discarded) so an abandoned login — one
 * nobody ever polls to the end — never surfaces as an unhandled rejection;
 * the outcome is still recorded on the record for `snapshotQrLogin`.
 *
 * @param service - LineProtocolService (not yet authenticated).
 * @returns The newly registered pending-QR-login record.
 */
export function startPendingQrLogin(
  service: LineProtocolService,
): PendingQrLogin {
  let resolveQrReady: () => void = () => {}
  const qrReady = new Promise<void>((resolve) => {
    resolveQrReady = resolve
  })

  const pending: Partial<PendingQrLogin> = {
    stage: 'waiting_for_qr',
    qrUrl: null,
    qrIssuedAt: null,
    pin: null,
    pinIssuedAt: null,
    result: null,
    error: undefined,
    settled: false,
    startedAt: Date.now(),
    qrReady,
  }

  const promise = runQrLogin(service, {
    onQr: (qrUrl) => {
      pending.qrUrl = qrUrl
      pending.qrIssuedAt = Date.now()
      pending.stage = 'waiting_for_scan'
      resolveQrReady()
    },
    onScanVerified: () => {
      pending.stage = 'scan_confirmed'
      log.warn('login_qr.scan_verified', {
        action: 'waiting for certificate check or PIN entry on the phone',
      })
    },
    onPin: (pin) => {
      pending.pin = pin
      pending.pinIssuedAt = Date.now()
      pending.stage = 'pin'
    },
    onCertificateVerified: () => {
      pending.stage = 'finishing'
    },
    onPinVerified: () => {
      pending.stage = 'finishing'
    },
  })
  promise.then(
    (result) => {
      pending.result = result
      pending.stage = 'logged_in'
      pending.settled = true
      log.info('login_qr.complete', { mid: result.mid })
      resolveQrReady()
    },
    (error) => {
      pending.error = error
      pending.stage = 'failed'
      pending.settled = true
      resolveQrReady()
    },
  )
  promise.catch(() => {
    // Swallow here only to prevent an unhandled-rejection warning for a
    // login nobody polls to the end; the failure is kept on the record.
  })

  pending.promise = promise
  pendingQrLogin = pending as PendingQrLogin
  return pendingQrLogin
}

/**
 * Wait for a pending QR login's payload to arrive, bounded by a timeout.
 *
 * @param pending - The pending QR login to wait on.
 * @param timeoutMs - Maximum time to wait.
 * @returns The QR payload, or `null` if it did not arrive within `timeoutMs`.
 */
export async function waitForQr(
  pending: PendingQrLogin,
  timeoutMs: number,
): Promise<string | null> {
  if (pending.qrUrl) {
    return pending.qrUrl
  }
  return await Promise.race([
    pending.qrReady.then(() => pending.qrUrl ?? null),
    new Promise<null>((resolve) => {
      setTimeout(() => resolve(null), timeoutMs)
    }),
  ])
}

/**
 * Seconds of LINE's window left for a step issued at `issuedAt`.
 *
 * @param issuedAt - Epoch millis the code/PIN was issued.
 * @param now - Current epoch millis.
 * @returns Whole seconds remaining, never negative.
 */
function secondsLeft(issuedAt: number, now: number): number {
  return Math.max(0, Math.ceil((issuedAt + QR_WINDOW_MS - now) / 1000))
}

/**
 * Read the tracked QR login without waiting on anything. Idempotent: reading
 * changes nothing, so the same PIN comes back on every poll until LINE
 * accepts it or its window dies, and a settled outcome stays readable until
 * a new `login_qr` replaces the record.
 *
 * @param pending - The record to read (null when none was ever started).
 * @param now - Current epoch millis.
 * @returns The stable machine-readable status.
 */
export function snapshotQrLogin(
  pending: PendingQrLogin | null,
  now: number,
): QrLoginStatus {
  if (!pending) {
    return { status: 'none' }
  }
  switch (pending.stage) {
    case 'waiting_for_qr':
      return { status: 'waiting_for_qr' }
    case 'waiting_for_scan':
      return {
        status: 'waiting_for_scan',
        qrUrl: pending.qrUrl ?? '',
        secondsLeft: secondsLeft(pending.qrIssuedAt ?? now, now),
      }
    case 'scan_confirmed':
      return { status: 'scan_confirmed' }
    case 'pin':
      return {
        status: 'pin',
        pin: pending.pin ?? '',
        secondsLeft: secondsLeft(pending.pinIssuedAt ?? now, now),
      }
    case 'finishing':
      return { status: 'finishing' }
    case 'logged_in':
      return {
        status: 'logged_in',
        mid: pending.result?.mid ?? null,
        displayName: pending.result?.displayName ?? null,
      }
    case 'failed': {
      const error: any = pending.error
      return { status: 'failed', message: error?.message ?? String(error) }
    }
  }
}
