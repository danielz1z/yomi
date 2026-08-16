import { LineClient } from '../../client/index.js'
import { LineQrLogin } from '../qr/index.js'
import { initE2EE } from './e2ee-bootstrap.js'

/**
 * Perform a ForSecure QR login and initialize the service client.
 *
 * Deliberately the same post-login spine as the passwordless flow
 * (performPwlessLogin): one LineClient, one session persist via
 * sessionState.initializeFromLogin, one E2EE bootstrap, one getProfile
 * validation — so a QR session restores exactly like a phone-PIN session
 * on the next start. The only difference is HOW LINE is convinced: a scan
 * on the primary phone instead of a phone number + PIN.
 *
 * The certificate is shared with the passwordless flow (`line_certificate`):
 * both are LINE "secondary device" login certificates for this device. A
 * certificate LINE rejects simply drops the QR flow into its PIN path, so
 * sharing can never strand the login.
 *
 * @param service - The LINE protocol service instance
 * @param loggingInState - State to set during login
 * @param connectedState - State to set on successful login
 * @param errorState - State to set on login failure
 * @returns Promise resolving to login result
 */
export async function performQrLogin(
  service,
  loggingInState,
  connectedState,
  errorState,
) {
  // Never write login progress to stdout: under the MCP stdio transport
  // stdout IS the JSON-RPC channel, and this login path runs inside the MCP
  // server. Route through the service logger, which writes to stderr.
  const log = service.startupFlowLogger ?? service.logger
  service.setState(loggingInState)
  service.qrLogin = new LineQrLogin(service.config)

  for (const evt of [
    'qrCreated',
    'scanVerified',
    'certificateVerified',
    'pinCreated',
    'pinVerified',
    'error',
  ]) {
    service.qrLogin.on(evt, (...args) => service.emit(evt, ...args))
  }

  try {
    const savedCert = await service.credentialStore.get('line_certificate')
    const result = await service.qrLogin.login(savedCert || undefined)
    log?.info?.('login.ok', {
      method: 'qr_forsecure',
      refreshToken: result.refreshToken ? 'yes' : 'no',
    })
    service.client = new LineClient(result.authToken, {
      ...service.config,
      logger: service.logger,
      startupFlowLogger: service.startupFlowLogger,
    })
    // `service.client` is its own EventEmitter (see sync-service/client.ts's
    // `runtime.emit('error', ...)` in the poll loop) — a zero-listener 'error'
    // emit there throws uncaught and kills the process just like on `service`
    // itself. Attach here, at construction, for the client's lifetime.
    service.client.on('error', (error: any) => {
      const message = error?.message ?? String(error)
      if (service.startupFlowLogger?.warn) {
        service.startupFlowLogger.warn('client.error', { error: message })
      } else {
        // stderr, not stdout — stdout is the MCP JSON-RPC channel.
        console.error(`[LINE] client error: ${message}`)
      }
    })
    service.sessionState.bindClient(service.client)
    await service.sessionState.initializeFromLogin(result)
    const e2eeBootstrap = await initE2EE(service, result)
    if (!e2eeBootstrap.success) {
      service.startupFlowLogger?.warn?.('session.login_e2ee_unavailable', {
        reason: e2eeBootstrap.reason,
      })
    }
    service.profile = await service.client.getProfile()
    // Display name only — do not print the mid alongside it.
    log?.info?.('profile.ok', {
      displayName: service.profile?.displayName ?? null,
    })
    service.loginRequired = false
    service.loginReason = null
    service.setState(connectedState)
    service.emit('loginComplete', { profile: service.profile })
    return result
  } catch (err) {
    service.setState(errorState)
    service.emit('error', err)
    throw err
  }
}
