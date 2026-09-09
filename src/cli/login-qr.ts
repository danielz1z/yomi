/**
 * Shared LINE ForSecure QR-login core, plus the TTY front-end for it.
 *
 * `runQrLogin` is the ONE QR login sequence: subscribe to
 * `qrCreated`/`pinCreated`, drive `service.startQrLogin`, unsubscribe in a
 * `finally`. Every front-end calls it — the MCP `login_qr`/
 * `login_qr_status` tools (see ../mcp/handlers/login-qr.ts) and
 * `cliLoginQr` below (surfaces the QR and PIN on stdout, for the
 * `npx @rikaidev/yomi login-qr` path that needs no MCP client at all).
 * No front-end duplicates the sequence itself.
 *
 * Unlike the passwordless login there are NO credentials to collect here:
 * the account is identified by whichever phone scans the code. That is what
 * makes this the login path for accounts created on Apple with no phone
 * number attached.
 */

import { toString as qrToString } from 'qrcode'
import { LineProtocolService } from '../line/core/service.js'

/** Result of a successful QR login (same shape as the passwordless one). */
export interface QrLoginResult {
  mid: string | null
  displayName: string | null
}

/** Front-end hooks into the shared QR login sequence. */
export interface QrLoginHooks {
  /** Called the moment LINE has issued the QR payload — render it NOW. */
  onQr: (qrUrl: string) => void
  /** Called when LINE asks for a PIN on the phone (no valid certificate). */
  onPin?: (pin: string) => void
  /** Called once the phone has confirmed the scan. */
  onScanVerified?: () => void
  /** Called when LINE accepted the stored certificate — no PIN this time. */
  onCertificateVerified?: () => void
  /** Called once LINE accepted the PIN the human typed on the phone. */
  onPinVerified?: () => void
}

/**
 * Drive the ForSecure QR (secondary-device) LINE login flow to completion.
 *
 * This is the single QR login sequence shared by every front-end — do not
 * re-subscribe to `qrCreated`/`pinCreated` or call `service.startQrLogin`
 * anywhere else.
 *
 * @param service - LineProtocolService (not yet authenticated).
 * @param hooks - Front-end callbacks for surfacing the QR payload and PIN.
 * @returns The resulting profile identity.
 */
export async function runQrLogin(
  service: LineProtocolService,
  hooks: QrLoginHooks,
): Promise<QrLoginResult> {
  const onPin = (pin: string) => hooks.onPin?.(pin)
  const onScanVerified = () => hooks.onScanVerified?.()
  const onCertificateVerified = () => hooks.onCertificateVerified?.()
  const onPinVerified = () => hooks.onPinVerified?.()
  service.on('qrCreated', hooks.onQr)
  service.on('pinCreated', onPin)
  service.on('scanVerified', onScanVerified)
  service.on('certificateVerified', onCertificateVerified)
  service.on('pinVerified', onPinVerified)
  try {
    await service.startQrLogin()
    const profile = service.profile ?? null
    return {
      mid: profile?.mid ?? null,
      displayName: profile?.displayName ?? null,
    }
  } finally {
    service.off('qrCreated', hooks.onQr)
    service.off('pinCreated', onPin)
    service.off('scanVerified', onScanVerified)
    service.off('certificateVerified', onCertificateVerified)
    service.off('pinVerified', onPinVerified)
  }
}

/**
 * Render a QR payload as a scannable terminal block (Unicode half-blocks).
 *
 * @param qrUrl - The QR payload LINE issued (callback URL + E2EE suffix).
 * @returns The terminal-rendered QR string.
 */
export async function renderQrForTerminal(qrUrl: string): Promise<string> {
  return qrToString(qrUrl, { type: 'terminal', small: true })
}

/**
 * TTY front-end: `npx @rikaidev/yomi login-qr`.
 *
 * Prints the QR code directly to the terminal (stdout — there is no MCP
 * client here to hide it from) along with the raw URL as a fallback, then
 * blocks until the flow completes. No phone number is asked for: the whole
 * point of this path is logging in an account that has none.
 *
 * @returns Process exit code (0 on success).
 */
export async function cliLoginQr(): Promise<number> {
  const service = new LineProtocolService()
  // A Node EventEmitter with zero 'error' listeners turns any emit('error')
  // into an uncaught exception that kills this process (see
  // qr-login-flow.ts). This listener must exist for the lifetime of the
  // service so a login/session error surfaces as a log line, not a crash —
  // the real failure still reaches this function through the normal
  // throw/rejection path.
  service.on('error', (error: any) =>
    console.error(`[Yomi] service error: ${error?.message ?? String(error)}`),
  )
  try {
    console.log(
      '[Yomi] Starting QR login (LINE ForSecure). No phone number needed — ' +
        'the account is identified by the phone that scans the code.',
    )

    const result = await runQrLogin(service, {
      onQr: (qrUrl) => {
        void renderQrForTerminal(qrUrl)
          .then((rendered) => {
            console.log(`\n${rendered}`)
          })
          .catch(() => {
            // A terminal that cannot render the block still gets the URL.
          })
          .finally(() => {
            console.log(`[Yomi] QR URL (same content): ${qrUrl}`)
            console.log(
              '[Yomi] On your PRIMARY phone: LINE > 設定/Settings > scan this ' +
                'code (the LINE QR reader), then confirm the new device there.',
            )
          })
      },
      onScanVerified: () => {
        console.log('[Yomi] Scan confirmed on the phone.')
      },
      onPin: (pin) => {
        console.log(`[Yomi] PIN: ${pin}`)
        console.log(
          '[Yomi] Enter this PIN in the LINE app on your primary phone within ' +
            "about 3 minutes — that is LINE's own deadline.",
        )
      },
    })

    console.log(
      `[Yomi] Login successful. mid=${result.mid ?? 'unknown'} displayName=${result.displayName ?? 'unknown'}`,
    )
    return 0
  } catch (error: any) {
    console.error(`[Yomi] QR login failed: ${error?.message ?? String(error)}`)
    return 1
  }
}
