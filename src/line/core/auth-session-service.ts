/**
 * LINE core auth/session capability.
 */

import { performPwlessLogin, performQrLogin } from '../auth/protocol/index.js'
import { performLogout } from './auth-session-logout.js'
import { revokeSession } from './auth-session-revoke.js'
import {
  resumeSession as resumeSessionImpl,
  tryRefreshToken as tryRefreshTokenImpl,
} from './auth-session-runtime.js'

/**
 * Create the auth/session capability bound to one LINE protocol service.
 *
 * @param service - Mutable LINE protocol service runtime.
 * @param states - Service state constants.
 * @returns Auth/session methods.
 */
export function createAuthSessionService(
  service: any,
  states: Record<string, string>,
) {
  return {
    /**
     * Start the passwordless login process.
     *
     * @param phone - E.164 phone number.
     * @param region - Region code.
     * @returns Promise resolving to the login result.
     */
    async startPwlessLogin(phone: string, region: string): Promise<any> {
      return performPwlessLogin(
        service,
        phone,
        region,
        states.LOGGING_IN,
        states.CONNECTED,
        states.ERROR,
      )
    },

    /**
     * Start the ForSecure QR login process — the secondary-device path for
     * accounts that have no phone number (the QR is scanned and approved on
     * the primary phone, exactly like official LINE for Chrome).
     *
     * @returns Promise resolving to the login result.
     */
    async startQrLogin(): Promise<any> {
      return performQrLogin(
        service,
        states.LOGGING_IN,
        states.CONNECTED,
        states.ERROR,
      )
    },

    /**
     * Log out from LINE, clearing the local session regardless of remote result.
     *
     * @returns Promise resolving when logout completes.
     */
    async logout(): Promise<void> {
      return performLogout(service, states.DISCONNECTED)
    },

    /**
     * Mark the active session as invalid after LINE rejects a previously saved token.
     *
     * Same cleanup as the resume and poll-loop revoke paths (see
     * auth-session-revoke.ts): polling stops, the dead login leaves the
     * credential store, phone/region stay for the next `login`.
     *
     * @param reason - Operator/debug reason for invalidation.
     */
    async invalidateSession(reason = 'line_auth_invalidated'): Promise<void> {
      await revokeSession(service, states.DISCONNECTED, { reason })
      service.emit('error', new Error(reason))
    },

    /**
     * Attempt token refresh via stored refresh token.
     *
     * @returns True when refresh succeeded.
     */
    async tryRefreshToken(): Promise<boolean> {
      return tryRefreshTokenImpl(service)
    },

    /**
     * Restore a previously persisted LINE session.
     *
     * @returns True when the session was restored.
     */
    async resumeSession(): Promise<boolean> {
      return resumeSessionImpl(service)
    },
  }
}
