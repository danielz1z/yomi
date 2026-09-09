/**
 * Yomi MCP `login_qr`/`login_qr_status` handlers — LINE ForSecure QR
 * secondary-device login.
 *
 * This is the login path for accounts that have NO phone number (e.g.
 * created on Apple): no phone/region arguments exist at all, because the
 * account is identified by whichever primary phone scans the code.
 *
 *   - `login_qr` starts the ForSecure flow and returns the QR payload as
 *     soon as LINE issues it — as a scannable PNG image content block plus
 *     the raw URL for clients that render no images. Bounded wait (~20s).
 *   - `login_qr_status` reads the same in-flight flow and returns AT ONCE:
 *     waiting for the scan, a PIN to show, finishing, logged in, or failed.
 *     The agent polls it every few seconds. No tool call ever stays open
 *     for the human — see ./login-qr-session.ts's header for why that
 *     matters (MCP hosts cancel long tool calls, and a PIN carried by a
 *     cancelled call is a PIN nobody sees).
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
  getLivePendingQrLogin,
  getPendingQrLogin,
  type PendingQrLogin,
  QR_WAIT_TIMEOUT_MS,
  type QrLoginStatus,
  snapshotQrLogin,
  startPendingQrLogin,
  waitForQr,
} from './login-qr-session.js'
import { getLivePendingLogin } from './login-session.js'
import { jsonText, toolError } from './shared.js'

const log = createCliLogger('Yomi')

const CODE_LIFETIME_SECONDS = Math.round(LINE_PIN_CODE_LIFETIME_MS / 1000)

/** The one instruction every mid-flight result ends with. */
const POLL_INSTRUCTION =
  'Call `login_qr_status` (no arguments) again in a few seconds — it returns immediately, never ' +
  'waits for the human, and can be called as often as you like. Keep polling until it reports ' +
  '`logged_in` or `failed`.'

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
    '3. If LINE shows a PIN prompt on the phone, `login_qr_status` will ' +
    'report that PIN — show it to the human so they can enter it there.\n'
  )
}

/**
 * Turn a status snapshot into a tool result: human-actionable text plus the
 * same snapshot as `structuredContent` for clients that read the shape.
 *
 * @param status - The snapshot to present.
 * @returns MCP tool result.
 */
function statusResult(status: QrLoginStatus) {
  let text: string
  switch (status.status) {
    case 'none':
      text =
        'No QR login has been started. Call `login_qr` to start one and get the QR code.'
      break
    case 'waiting_for_qr':
      text =
        'A QR login is starting but LINE has not issued the QR payload yet. Call `login_qr` again ' +
        'to receive the code as soon as it exists (it reuses this attempt — no second code is made).'
      break
    case 'waiting_for_scan':
      text =
        `Waiting for the primary phone to scan the QR code and confirm this device. About ${status.secondsLeft} ` +
        `seconds of LINE's ~${CODE_LIFETIME_SECONDS}-second window remain` +
        (status.secondsLeft === 0
          ? ' — the code is dead; call `login_qr` for a fresh one.\n\n'
          : `.\n\nQR payload (unchanged): ${status.qrUrl}\n\n`) +
        POLL_INSTRUCTION
      break
    case 'scan_confirmed':
      text =
        'The phone confirmed the scan. LINE is now checking the stored login certificate — the next ' +
        'status is either a PIN to show the human or `finishing`.\n\n' +
        POLL_INSTRUCTION
      break
    case 'pin':
      text =
        `LINE PIN:\n\n    ${status.pin}\n\n` +
        'The scan was confirmed; LINE now wants this PIN entered on the PRIMARY phone. Show it to the ' +
        `human verbatim. About ${status.secondsLeft} seconds of LINE's ~${CODE_LIFETIME_SECONDS}-second ` +
        'window remain' +
        (status.secondsLeft === 0
          ? ' — it has most likely expired; if the next status is `failed`, call `login_qr` again.'
          : '.') +
        ' This same PIN is reported on every poll until LINE accepts it, so nothing is lost if a ' +
        'result goes missing.\n\n' +
        POLL_INSTRUCTION
      break
    case 'finishing':
      text =
        'The phone has approved this device (PIN accepted, or the stored certificate was valid). ' +
        'Yomi is completing the token exchange with LINE.\n\n' +
        POLL_INSTRUCTION
      break
    case 'logged_in':
      return {
        content: [
          {
            type: 'text' as const,
            text: jsonText({
              loggedIn: true,
              mid: status.mid,
              displayName: status.displayName,
            }),
          },
        ],
        structuredContent: status,
      }
    case 'failed':
      return {
        ...toolError(
          `QR login failed: ${status.message} Call \`login_qr\` to start a fresh attempt.`,
        ),
        structuredContent: status,
      }
  }
  return {
    content: [{ type: 'text' as const, text }],
    structuredContent: status,
  }
}

/**
 * Whether the phone has already scanned this attempt's code — past that
 * point a fresh QR would only abandon a login the human has half done.
 *
 * @param pending - The live attempt.
 * @returns True once the stage is beyond `waiting_for_scan`.
 */
function pastScanning(pending: PendingQrLogin): boolean {
  return (
    pending.stage !== 'waiting_for_qr' && pending.stage !== 'waiting_for_scan'
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

  // Reuse the in-flight login while LINE could still accept it. Once the
  // phone has scanned, there is no QR to show any more — report where the
  // attempt is instead of issuing a second code underneath it. A stale one
  // holds a dead URL: wind it down so it cannot complete underneath the
  // fresh attempt, then start over.
  let pending = getLivePendingQrLogin(Date.now())
  if (pending && pastScanning(pending)) {
    return statusResult(snapshotQrLogin(pending, Date.now()))
  }
  if (!pending) {
    const stale = getPendingQrLogin()
    if (stale && !stale.settled) {
      try {
        ;(service as any).qrLogin?.abort?.()
      } catch {
        // Best effort — the stale flow fails on its own at the next poll.
      }
    }
    pending = startPendingQrLogin(service)
  }

  const qrUrl = await waitForQr(pending, QR_WAIT_TIMEOUT_MS)
  if (!qrUrl) {
    if (pending.stage === 'failed') {
      return statusResult(snapshotQrLogin(pending, Date.now()))
    }
    return toolError(
      'LINE has not issued a QR payload within 20s. The attempt is still running in the background ' +
        '(do not worry, nothing was lost) — call `login_qr` again shortly to check for it.',
    )
  }

  log.warn('login_qr.issued', { action: 'returned_in_tool_result' })
  const pngBase64 = await renderQrPngBase64(qrUrl)
  const text =
    'LINE QR login started (no phone number needed — the scanning phone identifies the account).\n\n' +
    qrScanSteps() +
    `\nQR payload (identical to the image): ${qrUrl}\n\n` +
    `LINE gives the human about ${CODE_LIFETIME_SECONDS} seconds (about 3 minutes) from the code being ` +
    'shown to scan and confirm on the phone — past that the code is dead and `login_qr` must be called ' +
    'again for a fresh one.\n\n' +
    'Show the human the QR code now, then poll `login_qr_status` (no arguments) every few seconds. It ' +
    'returns immediately with where the login is: `waiting_for_scan`, `scan_confirmed`, `pin` (show the ' +
    'digits to the human at once — they must type them on the phone), `finishing`, `logged_in`, or ' +
    '`failed`. Never wait for the human inside a tool call; the polling is how progress is observed.'

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
 * Handle `login_qr_status` — report where the QR login started by `login_qr`
 * is, without waiting for anything. Safe to call as often as wanted: reading
 * consumes nothing, so a PIN is repeated on every poll until LINE accepts it
 * and a settled outcome stays readable until a new `login_qr` replaces it.
 *
 * @returns MCP tool result carrying the human-readable state and the stable
 * `structuredContent` shape (see QrLoginStatus).
 */
export function handleLoginQrStatus() {
  return statusResult(snapshotQrLogin(getPendingQrLogin(), Date.now()))
}
