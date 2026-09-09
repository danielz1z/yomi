/**
 * LINE terminal-revoke cleanup.
 *
 * One routine for every place that learns LINE has signed this device out
 * (V3_TOKEN_CLIENT_LOGGED_OUT / LOGGED_OUT / DIVESTED): the session resume
 * path, the poll loop, a mid-tool MCP failure, and the explicit
 * invalidateSession() call. They used to disagree — resume flipped
 * `loginRequired` but kept the dead certificate on disk, and the next QR
 * login offered that revoked certificate to LINE, which then rejected the
 * final qrCodeLoginV2ForSecure with INVALID_CONTEXT.
 */

import { createCliLogger } from '../../util/log.js'

/** Login helpers that survive a revoke: neither is auth material. */
const PRESERVED_LOGIN_HELPER_KEYS = ['line_phone', 'line_region'] as const

interface RevokeOptions {
  /** Operator/debug reason carried on the `line:loginRequired` event. */
  reason: string
  /** Logger override; defaults to the service's startup/flow logger. */
  log?: any
}

export interface RevokeOutcome {
  /** False when a newer token on disk meant nothing of ours was cleared. */
  cleared: boolean
}

/**
 * Resolve the logger for one revoke.
 *
 * @param service - LineProtocolService instance.
 * @param override - Caller-supplied logger.
 * @returns Logger-like object.
 */
function getLog(service: any, override?: any) {
  return (
    override ??
    service?.startupFlowLogger ??
    (service?.logger?.warn ? service.logger : createCliLogger('LINE'))
  )
}

/**
 * Decide whether the credentials on disk are still the ones LINE revoked.
 *
 * Yomi Desktop and the MCP server share one credential store. If a sibling
 * process has already logged in again, the store holds ITS fresh token, not
 * the dead one this process is still carrying — wiping the store now would
 * cost that sibling a phone-PIN login for nothing. An empty store is ours to
 * clear (nothing to protect); a token equal to ours is the revoked one.
 *
 * @param service - LineProtocolService instance.
 * @returns True when a different, presumably live, token is on disk.
 */
async function newerTokenOnDisk(service: any): Promise<boolean> {
  const deadToken: string | null =
    service?.sessionState?.authToken ?? service?.client?.authToken ?? null
  const storedToken: string | null =
    (await service?.credentialStore?.get?.('line_auth_token')) ?? null
  return Boolean(storedToken && deadToken && storedToken !== deadToken)
}

/**
 * Remove the revoked login from the credential store, keeping the phone and
 * region so the next `login` can prefill them.
 *
 * @param service - LineProtocolService instance.
 */
async function clearRevokedLogin(service: any): Promise<void> {
  const preserved: Array<[string, string]> = []
  for (const key of PRESERVED_LOGIN_HELPER_KEYS) {
    const value = await service.credentialStore?.get?.(key)
    if (value) {
      preserved.push([key, value])
    }
  }
  await service.sessionState.clearAuth()
  for (const [key, value] of preserved) {
    await service.credentialStore?.set?.(key, value)
  }
}

/**
 * Tear down a session LINE has terminally revoked.
 *
 * Order matters. Polling stops and `loginRequired` flips synchronously,
 * before the first await, so the MCP gate short-circuits and the poll loop
 * exits even while the store is still being cleaned. Store errors are logged,
 * never thrown: the in-memory session is already dead and the caller's job is
 * to tell the user, not to fail on a keychain hiccup.
 *
 * @param service - LineProtocolService instance.
 * @param disconnectedState - DISCONNECTED state constant from the service.
 * @param options - Reason and optional logger.
 * @returns Whether the on-disk credentials were cleared.
 */
export async function revokeSession(
  service: any,
  disconnectedState: string,
  options: RevokeOptions,
): Promise<RevokeOutcome> {
  const log = getLog(service, options.log)

  try {
    service.client?.stopPolling?.()
  } catch {
    // Polling may already be stopped.
  }
  service.loginRequired = true
  service.loginReason = 'revoked'

  let cleared = false
  try {
    if (await newerTokenOnDisk(service)) {
      log.warn?.('session.revoke.credentials_preserved', {
        reason: 'newer_token_on_disk',
        source: options.reason,
      })
    } else {
      await clearRevokedLogin(service)
      cleared = true
      log.warn?.('session.revoke.credentials_cleared', {
        source: options.reason,
      })
    }
  } catch (error: any) {
    log.error?.('session.revoke.clear_failed', {
      error: error?.message ?? String(error),
      source: options.reason,
    })
  }

  service.client = null
  service.profile = null
  service.e2eeWarning = false
  service.nameCache?.clear?.()
  service.chatCache?.clear?.()
  service.setState(disconnectedState)
  service.emit('line:loginRequired', { reason: options.reason })
  return { cleared }
}
