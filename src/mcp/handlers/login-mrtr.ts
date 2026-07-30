/**
 * `login` on a MCP 2026-07-28 connection: the multi-round-trip (MRTR) path.
 *
 * That revision removed the server→client request channel — `elicitInput`
 * throws on a modern-era instance before any wire traffic (SDK:
 * `_assertPushApiInServedEra`, "the 2026-07-28 revision has no server→client
 * request channel"). The same conversation is instead carried by
 * `input_required` RESULTS: the handler returns the elicitation it needs,
 * the client fulfils it through its own `elicitation/create` handler, then
 * RE-CALLS `login` with the answers in `inputResponses`.
 *
 * So this file is ./login.ts's pushed elicitation flow turned inside out —
 * same three beats, one tool call each:
 *
 *   round 1  no responses          → ask the pre-flight form
 *   round 2  `preflight` answered  → start the login, ask for PIN ack
 *   round 3  `ack` answered        → await completion, return the profile
 *
 * The in-flight login survives between rounds in ./login-session.ts, exactly
 * as it survives between `login` and `login_complete` on the fallback path.
 *
 * `requestState` (the other half of MRTR) is deliberately NOT used: it
 * round-trips through the client and comes back attacker-controlled, so the
 * spec requires integrity-protecting anything that influences behavior. The
 * only state this flow needs is the pending login, which never leaves the
 * server.
 */
import {
  acceptedContent,
  inputRequired,
  inputResponse,
} from '@modelcontextprotocol/server'
import type { LineProtocolService } from '../../line/core/service.js'
import { createCliLogger } from '../../util/log.js'
import {
  buildAcknowledgementForm,
  buildPreflightForm,
  prerequisiteNotMetResult,
  readPreflightForm,
} from './login-copy.js'
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

/** Keys this flow assigns to its embedded input requests. */
const PREFLIGHT_KEY = 'preflight'
const ACK_KEY = 'ack'

/**
 * Round 3 — the human says they have acted on their phone. Await the login
 * `startPendingLogin` began in round 2.
 *
 * @returns The logged-in profile, or an honest error.
 */
async function completeRound() {
  const pending = getPendingLogin()
  if (!pending) {
    return toolError(
      'No login is pending — the attempt this acknowledgement belongs to has already finished or ' +
        'expired (LINE gives the human about 3 minutes to act on a shown code). Calling `login` ' +
        'again is safe and starts a fresh attempt.',
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

/**
 * Round 2 — the pre-flight form came back accepted and confirming. Start
 * (or reuse) the passwordless login and ask the human to act on the PIN.
 *
 * @param service - LineProtocolService (not yet authenticated).
 * @param phone - Confirmed phone number.
 * @param region - Confirmed region code.
 * @returns An `input_required` result carrying the PIN acknowledgement form,
 * or an honest error.
 */
async function startRound(
  service: LineProtocolService,
  phone: string,
  region: string,
) {
  const active = getLivePendingLogin(Date.now())
  if (active && (active.phone !== phone || active.region !== region)) {
    // A live login for a DIFFERENT number is still in flight. Never hand
    // back its PIN under this call's identity. Name nothing sensitive.
    return toolError(
      'A login for a different phone number is still in progress. Wait for its login code to expire ' +
        '(LINE gives the human about 3 minutes to act on it) before starting a login for another number.',
    )
  }
  const pending = active ?? startPendingLogin(service, phone, region)

  const pin = await waitForPin(pending, PIN_WAIT_TIMEOUT_MS)
  if (!pin && !pending.certSkippedPin) {
    return toolError(
      'LINE has not issued a login PIN within 20s. The attempt is still running in the background ' +
        '(do not worry, nothing was lost) — call `login` again shortly to check for the PIN.',
    )
  }
  log.warn('login.pin', {
    action: pin ? 'returned_in_input_required' : 'skipped_cert_valid',
  })
  // The PIN travels inside the elicitation the client is about to render,
  // and the login keeps running while the human acts on it — this handler
  // returns immediately rather than blocking through LINE's ~3-minute
  // window, so the human's clock starts now and not after a timeout.
  return inputRequired({
    inputRequests: {
      [ACK_KEY]: inputRequired.elicit(buildAcknowledgementForm(pin)),
    },
  })
}

/**
 * Handle `login` on a modern-era connection. Which round this call is comes
 * from the responses it carries: none means round 1.
 *
 * @param service - LineProtocolService (not yet authenticated).
 * @param args - Tool arguments.
 * @param inputResponses - `ctx.mcpReq.inputResponses` from a retried call.
 * Untrusted client input — read only through the SDK's response readers.
 * @returns An `input_required` result, or a terminal tool result.
 */
export async function handleLoginMrtr(
  service: LineProtocolService,
  args: { phone?: string; region?: string },
  inputResponses: Record<string, unknown> | undefined,
) {
  // Round 3 first: a client that accumulates responses across rounds would
  // send both keys, and the later beat is the one to act on.
  const ack = inputResponse(inputResponses, ACK_KEY)
  if (ack.kind === 'elicit') {
    if (ack.action !== 'accept') {
      return toolError('Login was cancelled by the user.')
    }
    return await completeRound()
  }

  const preflight = inputResponse(inputResponses, PREFLIGHT_KEY)
  if (preflight.kind === 'elicit') {
    if (preflight.action !== 'accept') {
      return toolError('Login was cancelled by the user.')
    }
    const outcome = readPreflightForm(
      acceptedContent(inputResponses, PREFLIGHT_KEY),
      args.phone,
      args.region,
    )
    if (!outcome.ok) {
      if (outcome.reason === 'prerequisite') {
        log.warn('login.prerequisite', { answer: outcome.answer })
        return prerequisiteNotMetResult(outcome.answer)
      }
      return toolError('Login was cancelled by the user.')
    }
    return await startRound(service, outcome.phone, outcome.region)
  }

  // Round 1. Persisted credentials still pre-fill the form, so a returning
  // user only confirms rather than retypes.
  const phone =
    args.phone ??
    (await service.credentialStore?.get?.('line_phone')) ??
    undefined
  const region =
    args.region ??
    (await service.credentialStore?.get?.('line_region')) ??
    undefined
  return inputRequired({
    inputRequests: {
      [PREFLIGHT_KEY]: inputRequired.elicit(buildPreflightForm(phone, region)),
    },
  })
}
