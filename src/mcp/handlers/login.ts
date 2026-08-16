/**
 * Yomi MCP `login`/`login_complete` handlers.
 *
 * Split out of handlers.ts purely to keep that file (the general tool
 * handler surface) under the project's 500-scc-line module cap; behavior
 * owned here is otherwise unchanged in spirit from what previously lived
 * inline there.
 *
 * THREE login paths exist, dispatched by protocol era and client capability
 * (see `handleLogin`), all sharing one login sequence (`runPwlessLogin` in
 * ../../cli/login.ts) and one set of human-facing texts (./login-copy.ts):
 *
 *   - Legacy era + form elicitation: the original single-call flow — the
 *     server PUSHES `elicitation/create` requests at the client, so one tool
 *     call can drive pre-flight, PIN and completion end to end.
 *
 *   - Modern era (2026-07-28) + form elicitation: ./login-mrtr.ts. That
 *     revision has NO server→client request channel, so the same
 *     conversation happens as multi-round-trip `input_required` results the
 *     client answers by re-calling `login`.
 *
 *   - Neither (e.g. Claude Desktop, confirmed empirically — it does not
 *     support MCP elicitation): the PIN has nowhere to go if we block, since
 *     it is produced mid-flow and stderr is invisible to the human, but a
 *     tool RESULT is visible. So the flow is split across two tool calls:
 *     `login` starts the passwordless flow and returns the PIN as soon as
 *     LINE issues it (bounded wait), then `login_complete` awaits the same
 *     in-flight login to finish once the human has acted on their phone.
 */
import type {
  ClientCapabilities,
  ProtocolEra,
  Server,
} from '@modelcontextprotocol/server'
import { runPwlessLogin } from '../../cli/login.js'
import {
  LINE_PIN_CODE_LIFETIME_MS,
  PAAK_AUTH_CLIENT_CEILING_MS,
  PIN_VERIFY_CLIENT_CEILING_MS,
} from '../../line/auth/pwless/index.js'
import type { LineProtocolService } from '../../line/core/service.js'
import { createCliLogger } from '../../util/log.js'
import { supportsFormElicitation } from '../client-capabilities.js'
import { supportsMcpApps } from '../ui/capability.js'
import type { LoginStructuredContent } from '../ui/login-structured-content.js'
import {
  buildAcknowledgementForm,
  buildPreflightForm,
  certSteps,
  LOGIN_REGIONS,
  PRIMARY_DEVICE_SETTING_PATH,
  pinSteps,
  prerequisiteNotMetResult,
  readPreflightForm,
} from './login-copy.js'
import { handleLoginMrtr } from './login-mrtr.js'
import { getPendingQrLogin } from './login-qr-session.js'
import {
  finishPendingLogin,
  getLivePendingLogin,
  getPendingLogin,
  PIN_WAIT_TIMEOUT_MS,
  startPendingLogin,
  waitForPin,
} from './login-session.js'
import { jsonText, toolError } from './shared.js'

const log = createCliLogger('Yomi')

/**
 * How long yomi's client keeps polling for the device-approval step once a
 * PIN has been verified (or skipped via a stored certificate) — the real
 * ceiling the completing call blocks for, used only to describe that wait to
 * the human, not to bound anything server-side.
 */
const APPROVAL_WINDOW_MS = PAAK_AUTH_CLIENT_CEILING_MS

/**
 * Elicit acknowledgement of the login PIN — fire-and-forget from the
 * caller's perspective (must not block `runPwlessLogin`, which is already
 * running concurrently and waiting on phone biometric approval).
 *
 * @param server - MCP Server instance.
 * @param pin - The PIN LINE just issued.
 * @param onDeclined - Called if the human explicitly declines/cancels the
 * acknowledgement, so a later login failure can be reported as
 * "cancelled by user" instead of a bare protocol error.
 */
function elicitPinAcknowledgement(
  server: Server,
  pin: string,
  onDeclined: () => void,
): void {
  server
    .elicitInput(buildAcknowledgementForm(pin))
    .then((result) => {
      if (result.action !== 'accept') {
        onDeclined()
      }
    })
    .catch((error: any) => {
      log.warn('login.pin_ack_failed', {
        error: error?.message ?? String(error),
      })
    })
}

/**
 * Handle `login` on a LEGACY-era connection whose client supports form
 * elicitation — drive the passwordless flow entirely through pushed
 * elicitation requests, with no out-of-band channel required. A pre-flight
 * form confirms the 允許自其他裝置登入 prerequisite (and collects
 * phone/region when missing) BEFORE any PIN is issued; the PIN is then
 * surfaced through a second elicitation fired without blocking
 * `runPwlessLogin`, which keeps running while the human acts on their phone.
 *
 * @param server - MCP Server instance (for elicitInput).
 * @param service - LineProtocolService (not yet authenticated).
 * @param args - Tool arguments.
 * @returns MCP tool result describing the logged-in profile.
 */
async function handleLoginElicitation(
  server: Server,
  service: LineProtocolService,
  args: { phone?: string; region?: string },
) {
  const collected = await server.elicitInput(
    buildPreflightForm(args.phone, args.region),
  )
  if (collected.action !== 'accept') {
    return toolError('Login was cancelled by the user.')
  }
  const preflight = readPreflightForm(
    collected.content,
    args.phone,
    args.region,
  )
  if (!preflight.ok) {
    if (preflight.reason === 'prerequisite') {
      log.warn('login.prerequisite', { answer: preflight.answer })
      return prerequisiteNotMetResult(preflight.answer)
    }
    return toolError('Login was cancelled by the user.')
  }
  const { phone, region } = preflight

  let pinDeclined = false
  const onPin = (pin: string) => {
    log.warn('login.pin', { action: 'elicit_acknowledgement' })
    elicitPinAcknowledgement(server, pin, () => {
      pinDeclined = true
    })
  }
  const onBiometric = () => {
    log.warn('login.waiting_biometric', {
      action: 'approve the new device on your phone',
    })
  }

  try {
    const { mid, displayName } = await runPwlessLogin(service, phone, region, {
      onPin,
      onWaitingBiometric: onBiometric,
    })
    log.info('login.complete', { mid })
    return {
      content: [
        {
          type: 'text' as const,
          text: jsonText({ loggedIn: true, mid, displayName }),
        },
      ],
    }
  } catch (error: any) {
    if (pinDeclined) {
      return toolError('Login was cancelled by the user.')
    }
    return toolError(error?.message ?? String(error))
  }
}

/**
 * Handle `login` for a client that supports no form of elicitation at all
 * (confirmed empirically for Claude Desktop). Splits the flow into two tool
 * calls since the PIN cannot be prompted for in-band: this call starts (or
 * reuses) the passwordless flow and returns the PIN as soon as LINE issues
 * it; `login_complete` finishes it once the human has acted.
 *
 * The MCP Apps view (./ui/login-app.ts) has never been observed to render on
 * any deployed client (see that file's header) — resources/read succeeds
 * but the host never completes `ui/initialize`. The MODEL is therefore
 * always the driver of this flow, regardless of `supportsUi`: the plain
 * `content` text below is fully actionable on its own in every case,
 * identical in substance whether or not the client declares MCP Apps
 * support. The only thing `supportsUi` still changes is:
 *   - missing phone/region: a UI-capable client gets `need_credentials`
 *     structuredContent (so a view CAN render a form if it ever does) plus
 *     text telling the model to ask the human directly and call `login`
 *     again — never text telling it to wait for a form. A non-UI client
 *     gets today's `toolError` naming the missing fields, unchanged.
 *   - `pin`/`cert` stages: the model is ALWAYS told to call `login_complete`
 *     immediately, in both cases. The view (./ui/login-app-view.ts) no
 *     longer calls `login_complete` on its own — display-only now — so
 *     there is exactly one driver and nothing to race.
 *
 * @param service - LineProtocolService (not yet authenticated).
 * @param args - Tool arguments.
 * @param supportsUi - Whether the connected client also negotiated MCP Apps
 * support (../ui/capability.ts's `supportsMcpApps`) — only changes whether
 * `structuredContent`/form-hint text is included, never whether the model is
 * told to act.
 * @returns MCP tool result carrying the PIN and next step, or an honest error.
 */
async function handleLoginNoElicitation(
  service: LineProtocolService,
  args: { phone?: string; region?: string },
  supportsUi: boolean,
) {
  let { phone, region } = args
  if (!phone) {
    phone = (await service.credentialStore?.get?.('line_phone')) ?? undefined
  }
  if (!region) {
    region = (await service.credentialStore?.get?.('line_region')) ?? undefined
  }
  // Build the "which fields are missing" text purely for the message, but
  // return inside a `!phone || !region` guard so TypeScript narrows both to
  // `string` for the rest of the function (no assertion needed).
  if (!phone || !region) {
    if (supportsUi) {
      const needCredentialsContent: LoginStructuredContent = {
        stage: 'need_credentials',
        pin: null,
        regions: LOGIN_REGIONS,
      }
      return {
        content: [
          {
            type: 'text' as const,
            text:
              'Ask the human for their LINE phone number (E.164 form, e.g. +8869XXXXXXXX) and region ' +
              `(one of ${LOGIN_REGIONS.join(', ')}), then call \`login\` again with those as arguments. ` +
              'In the same message, tell them yomi signs in as a SECOND device, which requires ' +
              `${PRIMARY_DEVICE_SETTING_PATH} to be enabled on the phone already logged in — if it is ` +
              'off, LINE never prompts that phone and the login cannot finish. ' +
              'A login form may also appear for the human to fill in directly — if they use it, the ' +
              'login proceeds on its own and there is nothing further for you to do — but do not wait ' +
              'for that; if no form appears, asking the human directly is how this login makes progress.',
          },
        ],
        structuredContent: needCredentialsContent,
      }
    }
    const missing: string[] = []
    if (!phone) missing.push('phone')
    if (!region) missing.push('region')
    return toolError(
      `Missing ${missing.join(' and ')} for login. This MCP client does not support form elicitation, so ` +
        `${missing.join('/')} must be supplied as a tool argument, or persisted by running ` +
        '`npx @rikaidev/yomi login` once in a terminal. Also tell the human that yomi signs in as a ' +
        `SECOND device, which requires ${PRIMARY_DEVICE_SETTING_PATH} enabled on the phone already ` +
        'logged in — with it off, LINE never prompts that phone and no login can succeed.',
    )
  }

  if (getPendingQrLogin()) {
    // A QR login is still in flight. Two concurrent logins would fight over
    // the same service state — finish or abandon that one first.
    return toolError(
      'A QR login started with `login_qr` is still in progress. Call `login_qr_complete` ' +
        'to finish it (or wait for its code to expire) before starting a phone-number login.',
    )
  }

  const active = getLivePendingLogin(Date.now())
  if (active && (active.phone !== phone || active.region !== region)) {
    // A live login for a DIFFERENT number is still in flight. Never hand
    // back its PIN under this call's identity, and never silently start a
    // second flow on top of it. Name nothing sensitive.
    return toolError(
      'A login for a different phone number is still in progress. Call `login_complete` to finish it, ' +
        'or wait for its login code to expire (LINE gives the human about 3 minutes to act on it), ' +
        'before starting a login for another number.',
    )
  }
  // Reuse the in-flight login only when it matches this number; otherwise
  // start a fresh one.
  const pending = active ?? startPendingLogin(service, phone, region)

  const pin = await waitForPin(pending, PIN_WAIT_TIMEOUT_MS)
  if (!pin) {
    if (pending.certSkippedPin) {
      // A valid stored login certificate skipped the PIN step entirely — the
      // flow is already past it and waiting on phone approval of this device.
      // Call `login_complete` right now; there is no PIN to wait for.
      log.warn('login.pin', { action: 'skipped_cert_valid' })
      const certStructuredContent: LoginStructuredContent = {
        stage: 'cert',
        pin: null,
        clientApprovalPollCeilingSeconds: Math.round(APPROVAL_WINDOW_MS / 1000),
      }
      const certText =
        certSteps() +
        'Call the `login_complete` tool (no arguments) IMMEDIATELY now — do not wait for ' +
        'confirmation that the approval happened first. `login_complete` blocks by itself while ' +
        `you approve (up to about ${Math.round(APPROVAL_WINDOW_MS / 60000)} minutes) and returns ` +
        'your profile once it succeeds.'
      return {
        content: [{ type: 'text' as const, text: certText }],
        structuredContent: certStructuredContent,
      }
    }
    return toolError(
      'LINE has not issued a login PIN within 20s. The attempt is still running in the background ' +
        '(do not worry, nothing was lost) — call `login` again shortly to check for the PIN.',
    )
  }

  log.warn('login.pin', { action: 'returned_in_tool_result' })
  const pinCodeLifetimeSeconds = Math.round(LINE_PIN_CODE_LIFETIME_MS / 1000)
  const clientPinPollCeilingMinutes = Math.round(
    PIN_VERIFY_CLIENT_CEILING_MS / 60000,
  )
  const clientApprovalPollCeilingMinutes = Math.round(
    APPROVAL_WINDOW_MS / 60000,
  )
  const pinStructuredContent: LoginStructuredContent = {
    stage: 'pin',
    pin,
    pinCodeLifetimeSeconds,
    clientPinPollCeilingSeconds: Math.round(
      PIN_VERIFY_CLIENT_CEILING_MS / 1000,
    ),
    clientApprovalPollCeilingSeconds: Math.round(APPROVAL_WINDOW_MS / 1000),
  }
  const pinText =
    pinSteps(pin) +
    `Call the \`login_complete\` tool (no arguments) IMMEDIATELY now — do not wait until you have ` +
    'entered the PIN or approved the device. `login_complete` blocks by itself through both of ' +
    `those steps: it keeps waiting up to about ${clientPinPollCeilingMinutes} minutes for step 2 and ` +
    `up to about ${clientApprovalPollCeilingMinutes} more minutes for step 3, well beyond LINE's own ` +
    `${pinCodeLifetimeSeconds}-second code deadline, so a slow phone is never the failure — missing ` +
    'that 3-minute deadline is what actually kills the code.\n\n' +
    '(This PIN step is skipped on future logins once a login certificate has been stored.)'
  return {
    content: [{ type: 'text' as const, text: pinText }],
    structuredContent: pinStructuredContent,
  }
}

/**
 * Handle `login` — dispatches to the path the connected client can actually
 * complete. See this module's header for the three paths.
 *
 * Elicitation is gated on the FORM sub-capability specifically, not on the
 * presence of an `elicitation` object: since MCP 2026-07-28 a client may
 * declare `elicitation: { url: {} }` alone, and both elicitation paths send
 * a `requestedSchema` that such a client would reject. See
 * ../client-capabilities.ts, which also owns WHERE the capabilities are read
 * from — the accessor is empty on a modern-era stdio connection.
 *
 * @param server - MCP Server instance (for elicitInput on the legacy path).
 * @param service - LineProtocolService (not yet authenticated).
 * @param args - Tool arguments.
 * @param context - Era, client capabilities, and the multi-round-trip input
 * responses a retried `tools/call` carried (`ctx.mcpReq.inputResponses`).
 * @returns MCP tool result, or an `input_required` result on the MRTR path.
 */
export async function handleLogin(
  server: Server,
  service: LineProtocolService,
  args: { phone?: string; region?: string },
  context: {
    era?: ProtocolEra
    capabilities?: ClientCapabilities
    inputResponses?: Record<string, unknown>
  } = {},
) {
  const {
    era = 'legacy',
    capabilities = server.getClientCapabilities(),
    inputResponses,
  } = context
  if (supportsFormElicitation(capabilities)) {
    return era === 'legacy'
      ? handleLoginElicitation(server, service, args)
      : handleLoginMrtr(service, args, inputResponses)
  }
  return handleLoginNoElicitation(service, args, supportsMcpApps(capabilities))
}

/**
 * Handle `login_complete` — finish a login started by a prior `login` call
 * on a client with no elicitation. Awaits the same in-flight
 * `runPwlessLogin` promise `login` started, so the real success/failure
 * surfaces here.
 *
 * @returns MCP tool result describing the logged-in profile, or an honest error.
 */
export async function handleLoginComplete() {
  const pending = getPendingLogin()
  if (!pending) {
    return toolError(
      'No login is pending. Call `login` first to start a passwordless login. ' +
        '(If you already called `login`, a previous attempt may have finished or its PIN code may have ' +
        `expired — LINE only gives the human about ${Math.round(LINE_PIN_CODE_LIFETIME_MS / 1000)} seconds ` +
        '(about 3 minutes) to act on a shown code. Calling `login` again is safe.)',
    )
  }
  try {
    const { mid, displayName } = await finishPendingLogin(pending)
    return {
      content: [
        {
          type: 'text' as const,
          text: jsonText({ loggedIn: true, mid, displayName }),
        },
      ],
    }
  } catch (error: any) {
    return toolError(error?.message ?? String(error))
  }
}
