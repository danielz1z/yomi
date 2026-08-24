/**
 * Yomi MCP `login_qr`/`login_qr_complete` handlers — LINE ForSecure QR
 * secondary-device login.
 *
 * This is the login path for accounts that have NO phone number (e.g.
 * created on Apple): no phone/region arguments exist at all, because the
 * account is identified by whichever primary phone scans the code. It
 * follows the same two-call, no-elicitation pattern as `login`/
 * `login_complete` (see ./login.ts's header for why that pattern exists):
 *
 *   - `login_qr` starts the ForSecure flow and returns the QR payload as
 *     soon as LINE issues it — as a scannable PNG image content block plus
 *     the raw URL for clients that render no images.
 *   - `login_qr_complete` awaits the same in-flight flow. It returns EARLY
 *     when LINE issues a PIN (the human cannot type a PIN they have not
 *     seen, and a blocked tool call cannot show one) — call it again after
 *     the PIN is entered on the phone.
 *
 * Client identity stays DESKTOPMAC (src/line/core/config.ts). Never
 * CHROMEOS: that is a different device class and signing in with it kicks
 * an official LINE for Chrome session on the same machine offline.
 */
import { toBuffer as qrToBuffer } from 'qrcode'
import { LINE_PIN_CODE_LIFETIME_MS } from '../../line/auth/pwless/index.js'
import type { LineProtocolService } from '../../line/core/service.js'
import { createCliLogger } from '../../util/log.js'
import {
  awaitPendingQrLogin,
  getLivePendingQrLogin,
  getPendingQrLogin,
  QR_WAIT_TIMEOUT_MS,
  startPendingQrLogin,
  waitForQr,
} from './login-qr-session.js'
import { getLivePendingLogin } from './login-session.js'
import { jsonText, toolError } from './shared.js'

const log = createCliLogger('Yomi')

/** Render the QR payload as a PNG for MCP image content; null on failure. */
async function renderQrPngBase64(qrUrl: string): Promise<string | null> {
  try {
    const png = await qrToBuffer(qrUrl, {
      type: 'png',
      width: 320,
      margin: 2,
      errorCorrectionLevel: 'M',
    })
    return png.toString('base64')
  } catch (error: any) {
    log.warn('login_qr.render_failed', {
      error: error?.message ?? String(error),
    })
    return null
  }
}

/** The numbered steps a human follows once they can SEE the QR code. */
function qrScanSteps(): string {
  return (
    '1. On the PRIMARY phone (already logged in to this LINE account), open ' +
    'LINE and use its QR reader (Home tab > search bar > scan icon, or ' +
    '設定 > アカウント > QRコード — the label is localized).\n' +
    '2. Scan the code above and confirm this new device on the phone.\n' +
    '3. If LINE shows a PIN prompt on the phone, the NEXT tool result will ' +
    'carry that PIN — enter it there.\n'
  )
}

/**
 * Handle `login_qr` — start (or reuse) the one in-flight ForSecure QR
 * login and return its QR payload as soon as LINE issues it.
 *
 * @param service - LineProtocolService (not yet authenticated).
 * @returns MCP tool result carrying the QR image + URL and the next step.
 */
export async function handleLoginQr(service: LineProtocolService) {
  if (getLivePendingLogin(Date.now())) {
    // A passwordless login is still in flight. Two concurrent logins would
    // fight over the same service state — finish or abandon that one first.
    return toolError(
      'A phone-number login started with `login` is still in progress. Call `login_complete` ' +
        'to finish it (or wait for its code to expire) before starting a QR login.',
    )
  }

  // Reuse the in-flight login while its code could still be alive (LINE's
  // own ~3-minute window). A stale one holds a dead URL: wind it down so it
  // cannot complete underneath the fresh attempt, then start over.
  let pending = getLivePendingQrLogin(Date.now())
  if (!pending) {
    const stale = getPendingQrLogin()
    if (stale) {
      try {
        ;(service as any).qrLogin?.abort?.()
      } catch {
        // Best effort — the stale flow fails on its own at the next poll.
      }
      stale.promise.catch(() => {})
    }
    pending = startPendingQrLogin(service)
  }

  const qrUrl = await waitForQr(pending, QR_WAIT_TIMEOUT_MS)
  if (!qrUrl) {
    const settled = await Promise.race([
      pending.promise.then(
        () => 'done' as const,
        (error: any) => ({ error }),
      ),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 100)),
    ])
    if (settled && settled !== 'done') {
      return toolError(
        `QR login failed before LINE issued a code: ${settled.error?.message ?? String(settled.error)}`,
      )
    }
    return toolError(
      'LINE has not issued a QR payload within 20s. The attempt is still running in the background ' +
        '(do not worry, nothing was lost) — call `login_qr` again shortly to check for it.',
    )
  }

  log.warn('login_qr.issued', { action: 'returned_in_tool_result' })
  const codeLifetimeSeconds = Math.round(LINE_PIN_CODE_LIFETIME_MS / 1000)
  const pngBase64 = await renderQrPngBase64(qrUrl)
  const text =
    'LINE QR login started (no phone number needed — the scanning phone identifies the account).\n\n' +
    qrScanSteps() +
    `\nQR payload (identical to the image): ${qrUrl}\n\n` +
    `LINE gives the human about ${codeLifetimeSeconds} seconds (about 3 minutes) from the code being ` +
    'shown to confirm on the phone — past that the code is dead and `login_qr` must be called again ' +
    'for a fresh one.\n\n' +
    'Call the `login_qr_complete` tool (no arguments) IMMEDIATELY now — do not wait for the human to ' +
    'scan first. `login_qr_complete` blocks by itself while they scan and approve; if LINE asks for a ' +
    'PIN it returns early with that PIN, and you must show it and call `login_qr_complete` again.'

  const content: any[] = [{ type: 'text' as const, text }]
  if (pngBase64) {
    content.push({
      type: 'image' as const,
      data: pngBase64,
      mimeType: 'image/png',
    })
  }
  return { content }
}

/**
 * Handle `login_qr_complete` — finish a QR login started by a prior
 * `login_qr` call. Awaits the same in-flight `runQrLogin` promise, but
 * returns early with the PIN if LINE issues one mid-flight (the human must
 * see it to enter it; call `login_qr_complete` again afterwards).
 *
 * @returns MCP tool result describing the logged-in profile, the PIN, or an
 * honest error.
 */
export async function handleLoginQrComplete() {
  const pending = getPendingQrLogin()
  if (!pending) {
    return toolError(
      'No QR login is pending. Call `login_qr` first to start a QR login. ' +
        '(If you already called `login_qr`, a previous attempt may have finished or its code may have ' +
        `expired — LINE only gives the human about ${Math.round(LINE_PIN_CODE_LIFETIME_MS / 1000)} seconds ` +
        '(about 3 minutes) to act on a shown code. Calling `login_qr` again is safe.)',
    )
  }

  const outcome = await awaitPendingQrLogin(pending)
  if (outcome.kind === 'pin') {
    const lifetimeSeconds = Math.round(LINE_PIN_CODE_LIFETIME_MS / 1000)
    return {
      content: [
        {
          type: 'text' as const,
          text:
            `LINE PIN:\n\n    ${outcome.pin}\n\n` +
            'The QR scan was confirmed; LINE now wants this PIN entered on the PRIMARY phone ' +
            `(within about ${lifetimeSeconds} seconds of it being shown — LINE's own deadline).\n\n` +
            'Show the human this PIN verbatim, then call `login_qr_complete` again IMMEDIATELY — ' +
            'it keeps blocking on its own while they type it.',
        },
      ],
    }
  }
  if (outcome.kind === 'failed') {
    const error: any = outcome.error
    return toolError(error?.message ?? String(error))
  }
  const { mid, displayName } = outcome.result
  log.info('login_qr.complete', { mid })
  return {
    content: [
      {
        type: 'text' as const,
        text: jsonText({ loggedIn: true, mid, displayName }),
      },
    ],
  }
}
