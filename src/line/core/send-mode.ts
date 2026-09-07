/**
 * Outbound text send-mode policy: E2EE by default, plaintext ONLY for a
 * verified LINE Official Account that provably has no Letter Sealing key.
 *
 * Why this exists: LINE Official Accounts (OAs, bots) sit outside Letter
 * Sealing. Their chats ride on transport TLS, and negotiateE2EEPublicKey
 * comes back without a key. Their MIDs still start with `u`, so the normal
 * pairwise path negotiates, gets nothing, and throws
 * "Failed to negotiate peer E2EE public key". Reading the chat works; only
 * sending is stuck. Official LINE clients handle this by negotiating and,
 * when the peer does not support E2EE, sending ordinary text.
 *
 * Policy (all conditions are checked BEFORE anything is sent, and there is
 * exactly one send, never a retry that downgrades after an ambiguous send):
 *
 *   1. Default is E2EE for every user, group, and room. Nothing changes
 *      unless the caller opts in with `allowPlaintextForOfficial: true`.
 *   2. Even with the opt-in, plaintext is chosen only when BOTH hold:
 *        a. the recipient contact is a verified Official Account
 *           (`isOfficial`, Contact field 35 bit 0x20, see
 *           talk-service/contact-query.ts), never a MID heuristic; and
 *        b. negotiateE2EEPublicKey returned a CONFIRMED empty result
 *           (a REPLY whose public-key field is absent or an empty struct).
 *   3. When negotiation yields a valid key, E2EE is used, opt-in or not.
 *   4. Anything ambiguous is a hard error, never a fallback: groups and
 *      rooms, ordinary users without a key, TalkExceptions (auth included),
 *      transport timeouts, empty HTTP bodies, or a key struct that is
 *      present but malformed (key id without key data, wrong types).
 *   5. v1 plaintext is basic text only: no mentions, no reply quote, no
 *      media. Those still require E2EE and are refused in plaintext mode.
 *
 * The classification below is deliberately conservative. If a live probe
 * (see README "Official Account plaintext policy") shows LINE answering OAs
 * with a specific TalkException code instead of an empty reply, that code
 * can be added to `classifyNegotiateResult` as a second confirmed-unsupported
 * signal. Until observed, exceptions stay errors.
 */

import { normalizeNegotiatedPublicKey } from './e2ee/keys/key-payload.js'
import type { NegotiatedPublicKey } from './e2ee/keys/key-types.js'

/** Which wire shape a text send will use. */
type SendMode = 'e2ee' | 'plaintext-official'

/**
 * Outcome of one negotiateE2EEPublicKey round-trip, classified for the
 * send-mode decision.
 *
 * - `key`: LINE returned a usable peer public key. E2EE.
 * - `unsupported`: LINE replied successfully but with no key at all. This
 *   is the only shape that may ever lead to plaintext, and only for an OA.
 * - `error`: transport failure, TalkException, or a malformed key struct.
 *   Never plaintext, whoever the peer is.
 */
export type NegotiateClassification =
  | { kind: 'key'; publicKey: NegotiatedPublicKey }
  | {
      kind: 'unsupported'
      reason: 'no_public_key_field' | 'empty_key_struct'
      detail: string
    }
  | {
      kind: 'error'
      reason:
        | 'transport_timeout'
        | 'transport_empty_response'
        | 'transport_error'
        | 'talk_exception'
        | 'malformed_key'
      detail: string
    }

/** Minimal transport-result shape `negotiateE2EEPublicKeyRaw` resolves to. */
export interface NegotiateTransportResult {
  fields?: Record<number, unknown>
  error?: string
}

/** Everything the decision was based on, for logs and the dry-run probe. */
export interface SendModeDecision {
  mode: SendMode
  /** Why this mode was selected (stable, log-friendly token). */
  reason:
    | 'default_e2ee'
    | 'group_or_room'
    | 'peer_key_negotiated'
    | 'official_without_e2ee'
  /** Contact verification result; null when not looked up. */
  isOfficial: boolean | null
  /** Negotiation classification; null when not attempted here. */
  negotiate: NegotiateClassification | null
  /**
   * Pre-negotiated peer key to hand to the encryptor so the decision and the
   * send share ONE negotiation round-trip. Only set for `peer_key_negotiated`.
   */
  peerPublicKey?: NegotiatedPublicKey
}

/** Options the caller passes into the decision. */
export interface SendModeOptions {
  /** Opt in to plaintext for a verified OA with no E2EE key. Default false. */
  allowPlaintextForOfficial?: boolean
}

/** The slice of the LINE client the policy needs. */
export interface SendModeClient {
  getContacts: (mids: string[]) => Promise<unknown>
  negotiateE2EEPublicKeyRaw: (mid: string) => Promise<NegotiateTransportResult>
}

/**
 * Error raised when the policy refuses to send. `data.code` is stable so
 * callers (MCP handler, CLI) can present it without parsing the message.
 */
export class SendModeRefusedError extends Error {
  public data: { code: string; [key: string]: unknown }

  constructor(message: string, data: { code: string; [key: string]: unknown }) {
    super(message)
    this.name = 'SendModeRefusedError'
    this.data = data
  }
}

/**
 * True when a value is a plain object with no own enumerable keys, which is
 * how the Thrift decoder surfaces an empty struct.
 *
 * @param value - Decoded field value.
 * @returns Whether it is an empty struct.
 */
function isEmptyStruct(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Buffer.isBuffer(value) &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  )
}

/**
 * True when an object carries key fields directly on itself in the
 * FLATTENED E2EEPublicKey layout (keyData at 4, keyId at 2 as a scalar, or
 * their named forms). Tells a flattened-but-broken key apart from a
 * negotiation envelope whose field 2 is a publicKey struct that is simply
 * absent or empty.
 *
 * @param value - Decoded object.
 * @returns Whether a flattened key id or key data field is present.
 */
function hasDirectKeyFields(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const record = value as Record<string | number, unknown>
  const scalarKeyId = record[2] != null && typeof record[2] !== 'object'
  return (
    scalarKeyId ||
    record[4] != null ||
    record.keyId != null ||
    record.keyData != null
  )
}

/**
 * Summarize the non-key members of an E2EENegotiationResult
 * (`{1: allowedTypes, 2: publicKey, 3: specVersion}`) for the probe output,
 * so a confirmed-empty reply is auditable after the fact.
 *
 * @param payload - Decoded negotiation result.
 * @returns Short human-readable summary.
 */
function describeNegotiationEnvelope(
  payload: Record<string | number, unknown>,
): string {
  const allowedTypes = payload[1] ?? payload.allowedTypes
  const specVersion = payload[3] ?? payload.specVersion
  return `allowedTypes=${JSON.stringify(allowedTypes ?? null)} specVersion=${String(specVersion ?? null)}`
}

/**
 * Classify one raw negotiateE2EEPublicKey transport result.
 *
 * The wire shape is E2EENegotiationResult `{1: allowedTypes, 2: publicKey,
 * 3: specVersion}`; `normalizeNegotiatedPublicKey` already tolerates the
 * decoder variants (nested struct, flattened, named). This function only
 * decides what a MISSING key means: confirmed-empty (unsupported) versus
 * broken/unknown (error).
 *
 * @param result - Transport result from `negotiateE2EEPublicKeyRaw`.
 * @returns Classification driving the send-mode decision.
 */
export function classifyNegotiateResult(
  result: NegotiateTransportResult | null | undefined,
): NegotiateClassification {
  if (!result || typeof result !== 'object') {
    return {
      kind: 'error',
      reason: 'transport_error',
      detail: 'negotiate returned no transport result',
    }
  }
  if (result.error) {
    if (result.error === 'timeout') {
      return { kind: 'error', reason: 'transport_timeout', detail: 'timeout' }
    }
    if (result.error === 'empty_response') {
      return {
        kind: 'error',
        reason: 'transport_empty_response',
        detail: 'empty HTTP body',
      }
    }
    return { kind: 'error', reason: 'transport_error', detail: result.error }
  }

  const payload = result.fields?.[0]
  if (payload == null) {
    // A REPLY with no result field: the server answered, and answered "nothing".
    return {
      kind: 'unsupported',
      reason: 'no_public_key_field',
      detail: 'reply carried no negotiation result',
    }
  }
  if (isEmptyStruct(payload)) {
    return {
      kind: 'unsupported',
      reason: 'empty_key_struct',
      detail: 'negotiation result was an empty struct',
    }
  }

  const publicKey = normalizeNegotiatedPublicKey(payload)
  if (publicKey) {
    return { kind: 'key', publicKey }
  }

  const record = payload as Record<string | number, unknown>
  const container = record[2] ?? record.publicKey ?? null
  if (container == null || isEmptyStruct(container)) {
    if (hasDirectKeyFields(record)) {
      return {
        kind: 'error',
        reason: 'malformed_key',
        detail: 'flattened key fields present but unusable',
      }
    }
    // Negotiation result present, publicKey member absent or empty: this is
    // the "peer has no Letter Sealing key" answer.
    return {
      kind: 'unsupported',
      reason: container == null ? 'no_public_key_field' : 'empty_key_struct',
      detail: describeNegotiationEnvelope(record),
    }
  }
  return {
    kind: 'error',
    reason: 'malformed_key',
    detail: 'publicKey struct present but keyId/keyData unusable',
  }
}

/**
 * Wrap a thrown negotiate error as a classification. TalkExceptions (auth,
 * capability gating, NOT_FOUND) all land here; none of them may ever be read
 * as "peer does not support E2EE".
 *
 * @param error - Error thrown by the client.
 * @returns Error classification.
 */
function classifyNegotiateThrow(error: unknown): NegotiateClassification {
  const data = (error as { data?: Record<string, unknown> })?.data
  const code = typeof data?.code === 'string' ? data.code : null
  const message =
    error instanceof Error ? error.message : String(error ?? 'unknown')
  return {
    kind: 'error',
    reason: code ? 'talk_exception' : 'transport_error',
    detail: code ? `${code}: ${message}` : message,
  }
}

/**
 * Look up whether `mid` is a verified Official Account via getContacts,
 * which returns normalized contacts carrying `isOfficial` (Contact field 35
 * bit 0x20). Fails closed: no contact, wrong mid, or a lookup failure all
 * yield `false`; only an explicit `isOfficial: true` on the matching
 * contact counts.
 *
 * @param client - LINE client slice.
 * @param mid - Recipient MID.
 * @returns Whether LINE marks the contact official.
 */
async function lookupIsOfficial(
  client: SendModeClient,
  mid: string,
): Promise<boolean> {
  const contacts = await client.getContacts([mid])
  if (!Array.isArray(contacts)) {
    return false
  }
  const match = contacts.find(
    (contact) =>
      typeof contact === 'object' &&
      contact !== null &&
      (contact as { mid?: unknown }).mid === mid,
  ) as { isOfficial?: unknown } | undefined
  return match?.isOfficial === true
}

/**
 * Decide how one text message to `to` will be sent. Pure policy plus at most
 * two read-only LINE calls (getContacts, negotiateE2EEPublicKey); it never
 * sends. Throws {@link SendModeRefusedError} instead of ever returning a
 * plaintext decision for a recipient that does not meet every condition.
 *
 * @param client - LINE client slice (getContacts + negotiateE2EEPublicKeyRaw).
 * @param to - Recipient MID.
 * @param options - Caller opt-ins.
 * @returns The selected mode and the evidence behind it.
 */
export async function resolveTextSendMode(
  client: SendModeClient,
  to: string,
  options: SendModeOptions = {},
): Promise<SendModeDecision> {
  if (!options.allowPlaintextForOfficial) {
    return {
      mode: 'e2ee',
      reason: 'default_e2ee',
      isOfficial: null,
      negotiate: null,
    }
  }
  if (typeof to !== 'string' || !to.startsWith('u')) {
    // Groups/rooms use a shared group key. There is no OA concept there and
    // plaintext is never an option, so the flag is simply irrelevant.
    return {
      mode: 'e2ee',
      reason: 'group_or_room',
      isOfficial: null,
      negotiate: null,
    }
  }

  const isOfficial = await lookupIsOfficial(client, to)

  let negotiate: NegotiateClassification
  try {
    negotiate = classifyNegotiateResult(
      await client.negotiateE2EEPublicKeyRaw(to),
    )
  } catch (error) {
    negotiate = classifyNegotiateThrow(error)
  }

  if (negotiate.kind === 'key') {
    return {
      mode: 'e2ee',
      reason: 'peer_key_negotiated',
      isOfficial,
      negotiate,
      peerPublicKey: negotiate.publicKey,
    }
  }

  if (negotiate.kind === 'error') {
    throw new SendModeRefusedError(
      `Refusing to send to ${to}: E2EE key negotiation failed (${negotiate.reason}: ${negotiate.detail}). ` +
        'This is not a confirmed "no E2EE" reply, so plaintext is not allowed even for an Official Account.',
      {
        code: 'E2EE_NEGOTIATE_ERROR',
        mid: to,
        isOfficial,
        negotiate,
      },
    )
  }

  if (!isOfficial) {
    throw new SendModeRefusedError(
      `Refusing to send to ${to}: the peer has no E2EE public key and is not a verified LINE Official Account. ` +
        'Yomi never sends plaintext to ordinary users.',
      {
        code: 'PLAINTEXT_NOT_OFFICIAL',
        mid: to,
        isOfficial,
        negotiate,
      },
    )
  }

  return {
    mode: 'plaintext-official',
    reason: 'official_without_e2ee',
    isOfficial,
    negotiate,
  }
}
