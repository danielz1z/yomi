/**
 * The one in-flight ForSecure QR login, shared by the `login_qr` /
 * `login_qr_complete` two-call pattern (the QR counterpart of
 * ./login-session.ts for the passwordless flow).
 *
 * The split exists because of a client constraint, not the protocol: on
 * clients with no server→client request channel the QR payload and the
 * (possible) later PIN have nowhere to go while a tool call blocks, but a
 * tool RESULT is always visible. So `login_qr` returns the QR payload as
 * soon as LINE issues it, and `login_qr_complete` awaits the same in-flight
 * flow — returning EARLY with the PIN when LINE demands one mid-flight,
 * since the human cannot enter a PIN they have not seen.
 *
 * `runQrLogin` (../../cli/login-qr.ts) remains the single login sequence —
 * this module only holds the promise and the payloads it produces.
 */
import type { QrLoginResult } from '../../cli/login-qr.js'
import { runQrLogin } from '../../cli/login-qr.js'
import { LINE_PIN_CODE_LIFETIME_MS } from '../../line/auth/pwless/index.js'
import type { LineProtocolService } from '../../line/core/service.js'
import { createCliLogger } from '../../util/log.js'

const log = createCliLogger('Yomi')

/**
 * How long a live pending QR login may be reused by a later `login_qr` call
 * before treating it as stale and starting fresh. Bound to LINE's real
 * code lifetime (an external fact, ~3 minutes from the LINE Help Center —
 * see line/auth/pwless/index.ts), NOT to yomi's own polling patience: LINE
 * kills the code, yomi only watches.
 */
const QR_WINDOW_MS = LINE_PIN_CODE_LIFETIME_MS

/** How long a `login_qr` call waits for LINE to issue the QR payload. */
export const QR_WAIT_TIMEOUT_MS = 20000

/** At most one in-flight QR login at a time. */
export interface PendingQrLogin {
  /** The runQrLogin promise itself — always awaitable, guarded separately against unhandled rejection. */
  promise: Promise<QrLoginResult>
  /** The scannable payload once LINE has issued it; null while still waiting. */
  qrUrl: string | null
  /** The PIN once LINE has issued it (certificate rejected); null while none. */
  pin: string | null
  /**
   * True once the flow passed the certificate check with `pin` still null —
   * LINE accepted the stored certificate, so no PIN will ever be issued for
   * this attempt.
   */
  certSkippedPin: boolean
  /**
   * True once `pin` has been handed out in a `login_qr_complete` result —
   * later calls await the real settlement instead of re-reporting the PIN.
   */
  pinReported: boolean
  /** True once the flow settled (success or failure) — a settled record must never be reused. */
  settled: boolean
  startedAt: number
  /** Resolves the instant `qrUrl` is set OR the flow settles first (failure before any QR). */
  qrReady: Promise<void>
  /** Resolves the instant `pin` is set OR `certSkippedPin` becomes true OR the flow settles. */
  pinReady: Promise<void>
}

let pendingQrLogin: PendingQrLogin | null = null

/** @returns The in-flight QR login, or null when none is pending. */
export function getPendingQrLogin(): PendingQrLogin | null {
  return pendingQrLogin
}

/**
 * The in-flight QR login only if it is still worth reusing: started within
 * LINE's code lifetime.
 *
 * @param now - Current epoch millis.
 * @returns The live pending QR login, or null.
 */
export function getLivePendingQrLogin(now: number): PendingQrLogin | null {
  if (!pendingQrLogin || pendingQrLogin.settled) {
    return null
  }
  return now - pendingQrLogin.startedAt < QR_WINDOW_MS ? pendingQrLogin : null
}

/**
 * Start a new QR login in the background and register it as the one
 * in-flight pending QR login.
 *
 * The stored promise is the actual `runQrLogin` promise, so a later call
 * can await it and see the real success/failure. A `.catch()` is attached
 * immediately (its result discarded, not stored) so an abandoned login — one
 * nobody ever finishes — never surfaces as an unhandled rejection; this does
 * not affect what `promise` itself resolves/rejects with.
 *
 * @param service - LineProtocolService (not yet authenticated).
 * @returns The newly registered pending-QR-login record.
 */
export function startPendingQrLogin(
  service: LineProtocolService,
): PendingQrLogin {
  let resolveQrReady: () => void = () => {}
  let resolvePinReady: () => void = () => {}
  const qrReady = new Promise<void>((resolve) => {
    resolveQrReady = resolve
  })
  const pinReady = new Promise<void>((resolve) => {
    resolvePinReady = resolve
  })

  const pending: Partial<PendingQrLogin> = {
    qrUrl: null,
    pin: null,
    certSkippedPin: false,
    pinReported: false,
    settled: false,
    startedAt: Date.now(),
    qrReady,
    pinReady,
  }

  const onQr = (qrUrl: string) => {
    pending.qrUrl = qrUrl
    resolveQrReady()
  }
  const onPin = (pin: string) => {
    pending.pin = pin
    resolvePinReady()
  }
  const onScanVerified = () => {
    log.warn('login_qr.scan_verified', {
      action: 'waiting for certificate check or PIN entry on the phone',
    })
  }

  const promise = runQrLogin(service, { onQr, onPin, onScanVerified })
  // A settled flow unblocks any waiter still parked on qrReady/pinReady —
  // the real outcome (error included) is read off `promise` itself.
  const markSettled = () => {
    pending.settled = true
    resolveQrReady()
    resolvePinReady()
  }
  promise.then(
    () => {
      if (!pending.pin && !pending.certSkippedPin) {
        // Reaching completion with no PIN ever set means the stored
        // certificate was accepted (see LineQrLogin.login, step 5).
        pending.certSkippedPin = true
      }
      markSettled()
    },
    () => {
      markSettled()
    },
  )
  promise.catch(() => {
    // Swallow here only to prevent an unhandled-rejection warning for a
    // login nobody completes; the real error still surfaces to whoever
    // awaits `promise` below.
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

/** What a `login_qr_complete` wait can end with, short of full completion. */
export type QrWaitOutcome =
  | { kind: 'completed'; result: QrLoginResult }
  | { kind: 'pin'; pin: string }
  | { kind: 'failed'; error: unknown }

/**
 * Await the in-flight QR login, returning EARLY when LINE issues a PIN —
 * the human must see it to act on it, and a tool call cannot report while
 * still blocked. The pending login stays registered either way; only a
 * settled flow (success or failure) clears it, mirroring
 * finishPendingLogin's "await the same promise" contract.
 *
 * @param pending - The pending QR login to await.
 * @returns The outcome: completed, PIN-issued (call again), or failed.
 */
export async function awaitPendingQrLogin(
  pending: PendingQrLogin,
): Promise<QrWaitOutcome> {
  // Hand the PIN out exactly once — a `login_qr_complete` called again after
  // that must wait for the real settlement, not replay the same PIN.
  const takePin = (): QrWaitOutcome | null => {
    if (pending.pin && !pending.pinReported) {
      pending.pinReported = true
      return { kind: 'pin', pin: pending.pin }
    }
    return null
  }
  const early = takePin()
  if (early) {
    return early
  }
  const outcome = await Promise.race([
    pending.promise.then(
      (result): QrWaitOutcome => ({ kind: 'completed', result }),
      (error): QrWaitOutcome => ({ kind: 'failed', error }),
    ),
    pending.pinReady.then((): QrWaitOutcome | null => takePin()),
  ])
  if (outcome) {
    if (outcome.kind !== 'pin') {
      pendingQrLogin = null
    }
    return outcome
  }
  // pinReady resolved with no reportable PIN (already reported, or the flow
  // settled in the same tick): read the real outcome off the promise.
  try {
    const result = await pending.promise
    pendingQrLogin = null
    return { kind: 'completed', result }
  } catch (error) {
    pendingQrLogin = null
    return { kind: 'failed', error }
  }
}
