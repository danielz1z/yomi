/**
 * The one in-flight passwordless login, shared by every `login` protocol
 * path that cannot finish inside a single tool call.
 *
 * Two such paths exist and both need the same state: the 2026-07-28
 * multi-round-trip flow (./login-mrtr.ts), where the client re-calls `login`
 * after the human acts, and the two-call fallback (./login.ts), where the
 * model calls `login_complete`. Owned here rather than in either one so
 * neither imports the other.
 *
 * `runPwlessLogin` (../../cli/login.ts) remains the single login sequence —
 * this module only holds the promise and the PIN it produces.
 */
import type { PwlessLoginResult } from '../../cli/login.js'
import { runPwlessLogin } from '../../cli/login.js'
import { LINE_PIN_CODE_LIFETIME_MS } from '../../line/auth/pwless/index.js'
import type { LineProtocolService } from '../../line/core/service.js'
import { createCliLogger } from '../../util/log.js'

const log = createCliLogger('Yomi')

/**
 * How long a live pending login may be reused by a later `login` call for
 * the same phone/region, before treating it as stale and starting fresh.
 *
 * This is bound to LINE's real PIN code lifetime (~line/auth/pwless/index.ts,
 * an external fact from LINE Help Center, ~3 minutes) — NOT to how long
 * yomi's client is willing to keep polling (~16 minutes). A login started
 * 90 seconds ago is still very much alive and its PIN is still valid; the
 * only thing that actually kills a pending login early is LINE's own code
 * expiring, so that is the correct bound for "is this still worth reusing".
 */
export const PIN_WINDOW_MS = LINE_PIN_CODE_LIFETIME_MS

/** How long a `login` call waits for LINE to issue a PIN before giving up. */
export const PIN_WAIT_TIMEOUT_MS = 20000

/** At most one in-flight passwordless login at a time. */
export interface PendingLogin {
  /** The runPwlessLogin promise itself — always awaitable, guarded separately against unhandled rejection. */
  promise: Promise<PwlessLoginResult>
  /** The PIN once LINE has issued it; null while still waiting. */
  pin: string | null
  /**
   * True once the flow reaches `waitingForBiometric` with `pin` still null —
   * the login had a valid stored certificate, so `requestPinCodeVerif` was
   * skipped entirely and no PIN will ever be issued for this attempt.
   */
  certSkippedPin: boolean
  phone: string
  region: string
  startedAt: number
  /** Resolves the instant `pin` is set OR `certSkippedPin` becomes true, so a later call can wait on either outcome. */
  pinReady: Promise<void>
}

let pendingLogin: PendingLogin | null = null

/** @returns The in-flight login, or null when none is pending. */
export function getPendingLogin(): PendingLogin | null {
  return pendingLogin
}

/**
 * The in-flight login only if it is still worth reusing: started within
 * LINE's PIN lifetime.
 *
 * @param now - Current epoch millis.
 * @returns The live pending login, or null.
 */
export function getLivePendingLogin(now: number): PendingLogin | null {
  if (!pendingLogin) {
    return null
  }
  return now - pendingLogin.startedAt < PIN_WINDOW_MS ? pendingLogin : null
}

/**
 * Start a new passwordless login in the background and register it as the
 * one in-flight pending login.
 *
 * The stored promise is the actual `runPwlessLogin` promise, so a later call
 * can await it and see the real success/failure. A `.catch()` is attached
 * immediately (its result discarded, not stored) so an abandoned login — one
 * nobody ever finishes — never surfaces as an unhandled rejection; this does
 * not affect what `promise` itself resolves/rejects with.
 *
 * @param service - LineProtocolService (not yet authenticated).
 * @param phone - Phone number in E.164 form.
 * @param region - Region code.
 * @returns The newly registered pending-login record.
 */
export function startPendingLogin(
  service: LineProtocolService,
  phone: string,
  region: string,
): PendingLogin {
  let resolvePinReady: () => void = () => {}
  const pinReady = new Promise<void>((resolve) => {
    resolvePinReady = resolve
  })

  const pending: Partial<PendingLogin> = {
    phone,
    region,
    pin: null,
    certSkippedPin: false,
    startedAt: Date.now(),
    pinReady,
  }

  const onPin = (pin: string) => {
    pending.pin = pin
    resolvePinReady()
  }
  const onBiometric = () => {
    log.warn('login.waiting_biometric', {
      action: 'approve the new device on your phone',
    })
    // Reaching biometric wait with no PIN ever set means a valid stored
    // certificate skipped the PIN step entirely (see LinePwlessLogin.login,
    // step 2-3) — resolve `pinReady` now so `waitForPin` doesn't block out
    // its full timeout waiting for a PIN that will never arrive.
    if (!pending.pin) {
      pending.certSkippedPin = true
      resolvePinReady()
    }
  }

  const promise = runPwlessLogin(service, phone, region, {
    onPin,
    onWaitingBiometric: onBiometric,
  })
  promise.catch(() => {
    // Swallow here only to prevent an unhandled-rejection warning for a
    // login nobody completes; the real error still surfaces to whoever
    // awaits `promise` below.
  })

  pending.promise = promise
  pendingLogin = pending as PendingLogin
  return pendingLogin
}

/**
 * Wait for a pending login's PIN to arrive, bounded by a timeout.
 *
 * @param pending - The pending login to wait on.
 * @param timeoutMs - Maximum time to wait.
 * @returns The PIN, or `null` if it did not arrive within `timeoutMs` (also
 * the answer when a stored certificate skipped the PIN — check
 * `certSkippedPin` to tell the two apart).
 */
export async function waitForPin(
  pending: PendingLogin,
  timeoutMs: number,
): Promise<string | null> {
  if (pending.pin) {
    return pending.pin
  }
  return await Promise.race([
    pending.pinReady.then(() => pending.pin ?? null),
    new Promise<null>((resolve) => {
      setTimeout(() => resolve(null), timeoutMs)
    }),
  ])
}

/**
 * Await the in-flight login to completion and clear it either way. Never
 * touches credentials on the failure path — `runPwlessLogin` owns that.
 *
 * @param pending - The pending login to finish.
 * @returns The logged-in profile.
 * @throws Whatever `runPwlessLogin` failed with.
 */
export async function finishPendingLogin(
  pending: PendingLogin,
): Promise<PwlessLoginResult> {
  try {
    const result = await pending.promise
    log.info('login.complete', { mid: result.mid })
    return result
  } finally {
    pendingLogin = null
  }
}
