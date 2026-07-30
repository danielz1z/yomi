/**
 * Everything a human READS during a yomi login, plus the elicitation form
 * shapes that carry it — owned in one module so the three protocol paths
 * (legacy push elicitation, 2026-07-28 multi-round-trip, and the two-call
 * fallback) cannot drift apart in what they tell the user.
 *
 * The centre of gravity is one prerequisite that nothing in the protocol can
 * work around: the primary phone must have 允許自其他裝置登入 turned on. When
 * it is off, LINE never offers this device a sign-in prompt at all — the
 * human sees NOTHING happen on their phone and has no way to tell that from
 * "it is just slow". That is the failure users actually report.
 *
 * Ordering matters as much as wording: the prerequisite has to be raised
 * BEFORE `runPwlessLogin` issues a PIN, because LINE gives the human only
 * ~3 minutes from that moment. Telling them about a settings toggle while
 * that clock runs is telling them too late.
 *
 * One copy of the prerequisite lives outside this module, in
 * ../ui/login-app-view.ts — browser code embedded as a string literal, which
 * cannot import from here. Keep it in step by hand if the wording changes.
 */
import type {
  ElicitRequestFormParams,
  TitledSingleSelectEnumSchema,
} from '@modelcontextprotocol/server'
import { LINE_PIN_CODE_LIFETIME_MS } from '../../line/auth/pwless/index.js'

/** A form-mode elicitation body, accepted by both `elicitInput` and `inputRequired.elicit`. */
export type LoginForm = Pick<
  ElicitRequestFormParams,
  'message' | 'requestedSchema'
>

/** LINE region codes offered on the login form. */
export const LOGIN_REGIONS = ['TW', 'JP', 'TH', 'ID', 'US']

/** Where the toggle lives on the primary phone, in LINE's own words. */
export const PRIMARY_DEVICE_SETTING_PATH =
  '設定 > 我的帳號 > 允許自其他裝置登入'

/**
 * The prerequisite as a single line, for texts that report on a login
 * already in flight (the PIN and cert steps) rather than gating one.
 */
export const PRIMARY_DEVICE_SETTING_NOTE =
  `0. This only works if the primary phone has ${PRIMARY_DEVICE_SETTING_PATH} ` +
  '(Settings > Account > allow logging in from other devices; the label is ' +
  'localized) enabled — without it LINE will not offer this device a sign-in ' +
  'prompt at all.\n'

/**
 * Step-by-step instructions for turning the setting on, returned when the
 * human says it is off or that they do not know where it is.
 */
export const PRIMARY_DEVICE_SETTING_STEPS =
  'On the PRIMARY phone (the one already logged in to this LINE account):\n\n' +
  '1. Open LINE and go to the 主頁 / Home tab.\n' +
  '2. Tap the gear icon in the top corner to open 設定 (Settings).\n' +
  '3. Open 我的帳號 (Account).\n' +
  '4. Turn ON 允許自其他裝置登入 (the toggle allowing login from other ' +
  'devices — the exact wording is localized).\n\n' +
  'This toggle is what lets LINE prompt a second device to sign in. With it ' +
  'off, nothing at all appears on the phone and the login simply never ' +
  'completes.'

/** Answers offered by the pre-flight prerequisite check. */
export const PREREQ_ANSWERS = {
  enabled: 'enabled',
  notEnabled: 'not_enabled',
  unsure: 'unsure',
} as const

/**
 * The prerequisite question, in the 2026-07-28 `oneOf`-with-`title`
 * single-select shape (`TitledSingleSelectEnumSchema`) so each choice carries
 * human-facing text of its own, rather than an enum of bare machine values
 * the client has to render raw.
 */
const PREREQ_SCHEMA_PROPERTY: TitledSingleSelectEnumSchema = {
  type: 'string',
  title: 'Is 允許自其他裝置登入 enabled on your primary phone?',
  description:
    `On the phone already logged in to LINE: ${PRIMARY_DEVICE_SETTING_PATH}. ` +
    'Without it, LINE never prompts this device and the login cannot finish.',
  oneOf: [
    { const: PREREQ_ANSWERS.enabled, title: 'Yes — it is already on' },
    { const: PREREQ_ANSWERS.notEnabled, title: 'No / not yet — show me how' },
    {
      const: PREREQ_ANSWERS.unsure,
      title: "I don't know where that setting is",
    },
  ],
}

/**
 * Build the one form shown before a login starts: the prerequisite, plus
 * `phone`/`region` when the caller did not supply them.
 *
 * Both live in ONE form on purpose — the human answers a single prompt, and
 * the prerequisite is raised while it can still change the outcome.
 *
 * @param phone - Phone already supplied by the tool call, if any.
 * @param region - Region already supplied by the tool call, if any.
 * @returns The elicitation body, for `elicitInput` or `inputRequired.elicit`.
 */
export function buildPreflightForm(
  phone: string | undefined,
  region: string | undefined,
): LoginForm {
  const needsCredentials = !phone || !region
  const properties: LoginForm['requestedSchema']['properties'] = {
    primaryDeviceLogin: PREREQ_SCHEMA_PROPERTY,
  }
  const required = ['primaryDeviceLogin']
  if (needsCredentials) {
    properties.phone = {
      type: 'string',
      title: 'Phone number',
      description: 'E.164 form, e.g. +8869XXXXXXXX.',
      ...(phone ? { default: phone } : {}),
    }
    properties.region = {
      type: 'string',
      title: 'Region',
      enum: LOGIN_REGIONS,
      ...(region ? { default: region } : {}),
    }
    required.push('phone', 'region')
  }
  return {
    message:
      'Yomi signs in as a SECOND LINE device. That requires ' +
      `${PRIMARY_DEVICE_SETTING_PATH} to be enabled on the phone already ` +
      'logged in — confirm that below' +
      (needsCredentials
        ? ', along with your number and region.'
        : ' before the login starts.'),
    requestedSchema: { type: 'object', properties, required },
  }
}

/** What the pre-flight form's answer means for the login about to start. */
export type PreflightOutcome =
  | { ok: true; phone: string; region: string }
  | { ok: false; reason: 'cancelled' }
  | { ok: false; reason: 'prerequisite'; answer: string }

/**
 * Read an accepted pre-flight form back. Shared by every path so the answer
 * is interpreted identically no matter how it was collected.
 *
 * @param content - The accepted form content (untrusted client input).
 * @param phone - Phone supplied by the tool call, used when the form did not
 * carry the field because it was already known.
 * @param region - Region, same rule.
 * @returns What the login should do next.
 */
export function readPreflightForm(
  content: Record<string, unknown> | undefined,
  phone: string | undefined,
  region: string | undefined,
): PreflightOutcome {
  const answer = String(content?.primaryDeviceLogin ?? '')
  if (answer !== PREREQ_ANSWERS.enabled) {
    return { ok: false, reason: 'prerequisite', answer }
  }
  const collectedPhone = String(content?.phone ?? phone ?? '')
  const collectedRegion = String(content?.region ?? region ?? '')
  if (!collectedPhone || !collectedRegion) {
    return { ok: false, reason: 'cancelled' }
  }
  return { ok: true, phone: collectedPhone, region: collectedRegion }
}

/**
 * The numbered steps for acting on an issued PIN. Step 0 repeats the
 * prerequisite even though the pre-flight form already asked about it: a
 * human who answered "yes" without checking finds out here, while the code
 * is still valid.
 *
 * @param pin - The PIN LINE just issued.
 * @returns The steps, ending in a blank line.
 */
export function pinSteps(pin: string): string {
  const lifetimeSeconds = Math.round(LINE_PIN_CODE_LIFETIME_MS / 1000)
  return (
    `LINE PIN:\n\n    ${pin}\n\n` +
    PRIMARY_DEVICE_SETTING_NOTE +
    '1. Open LINE on the primary phone. If a verification prompt does not ' +
    'appear immediately, bringing the app to the foreground surfaces it.\n' +
    `2. Enter this PIN and tick the device that is signing in, then tap ` +
    `「用戶確認」 — LINE gives you ${lifetimeSeconds} seconds (about 3 ` +
    'minutes) from when the code was shown to do this.\n' +
    '3. LINE will then ask that same phone to approve this new device ' +
    'signing in — approve it there.\n\n'
  )
}

/**
 * The steps when a stored login certificate skipped the PIN entirely — the
 * flow is already waiting on phone approval of this device.
 *
 * @returns The steps, ending in a blank line.
 */
export function certSteps(): string {
  return (
    'No PIN needed — LINE recognized a stored login certificate from a ' +
    'previous login, so the PIN step was skipped.\n\n' +
    PRIMARY_DEVICE_SETTING_NOTE +
    '1. Bring the LINE app to the foreground on your primary phone — it ' +
    'should prompt you to approve this new device signing in.\n' +
    '2. Approve the device from there.\n\n'
  )
}

/**
 * The acknowledgement form shown alongside an issued PIN (or alongside the
 * cert-skipped approval prompt).
 *
 * @param pin - The PIN, or `null` when a stored certificate skipped it.
 * @returns The elicitation body.
 */
export function buildAcknowledgementForm(pin: string | null): LoginForm {
  return {
    message:
      (pin ? pinSteps(pin) : certSteps()) +
      'Acknowledge below once you have done this.',
    requestedSchema: {
      type: 'object',
      properties: {
        entered: {
          type: 'boolean',
          title: pin
            ? 'I entered the PIN and approved the device on my phone'
            : 'I approved the device on my phone',
        },
      },
    },
  }
}

/**
 * Build the tool result returned when the human has not confirmed the
 * prerequisite. Deliberately NOT a tool error: nothing failed, the login was
 * simply never started, and the human has one concrete thing to do.
 *
 * @param answer - Which non-confirming answer they gave, for wording.
 * @returns MCP tool result carrying the enabling steps and the retry.
 */
export function prerequisiteNotMetResult(answer: string) {
  const lead =
    answer === PREREQ_ANSWERS.unsure
      ? 'Login was not started — here is where that setting lives.\n\n'
      : 'Login was not started, because LINE would never prompt the phone.\n\n'
  return {
    content: [
      {
        type: 'text' as const,
        text:
          lead +
          PRIMARY_DEVICE_SETTING_STEPS +
          '\n\nOnce the toggle is on, call `login` again. Relay these steps ' +
          'to the human as they are — do not summarize the settings path ' +
          'away, it is the whole point.',
      },
    ],
  }
}
