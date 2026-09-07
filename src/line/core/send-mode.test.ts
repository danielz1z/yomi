import { expect, test } from 'bun:test'
import {
  classifyNegotiateResult,
  resolveTextSendMode,
  type SendModeClient,
  SendModeRefusedError,
} from './send-mode.js'

const OA_MID = 'u-official-account'
const USER_MID = 'u-ordinary-user'
const KEY_BYTES = Buffer.alloc(32, 7)

/** A decoded E2EENegotiationResult carrying a usable public key. */
const REPLY_WITH_KEY = {
  fields: { 0: { 1: [0, 1], 2: { 1: 1, 2: 42, 4: KEY_BYTES }, 3: 2 } },
}

/** A decoded E2EENegotiationResult with the publicKey member absent. */
const REPLY_NO_KEY = { fields: { 0: { 1: [], 3: 2 } } }

/**
 * Fake LINE client slice: contact lookup + raw negotiate, both recorded.
 *
 * @param options.official - Whether the looked-up contact is official.
 * @param options.negotiate - Transport result to return, or an Error to throw.
 * @param options.contactMid - MID reported on the returned contact.
 * @returns Fake client plus recorded calls.
 */
function makeClient(options: {
  official?: boolean
  negotiate?: unknown
  contactMid?: string
  contacts?: unknown
}) {
  const calls: string[] = []
  const client: SendModeClient = {
    async getContacts(mids) {
      calls.push(`getContacts:${mids.join(',')}`)
      if ('contacts' in options) {
        return options.contacts
      }
      return [
        {
          mid: options.contactMid ?? mids[0],
          displayName: 'x',
          isOfficial: options.official === true,
        },
      ]
    },
    async negotiateE2EEPublicKeyRaw(mid) {
      calls.push(`negotiate:${mid}`)
      if (options.negotiate instanceof Error) {
        throw options.negotiate
      }
      return options.negotiate as any
    },
  }
  return { client, calls }
}

/**
 * Build a LineRequestError-shaped TalkException, as sendCompact throws.
 *
 * @param code - Normalized TalkException code.
 * @returns Error carrying `data.code`.
 */
function talkException(code: string) {
  const error: any = new Error(`Request internal failed -> ${code}`)
  error.data = { code, method: 'negotiateE2EEPublicKey' }
  return error
}

test('classify: a usable public key is E2EE material', () => {
  const result = classifyNegotiateResult(REPLY_WITH_KEY)
  expect(result.kind).toBe('key')
  if (result.kind === 'key') {
    expect(result.publicKey.keyId).toBe('42')
    expect(result.publicKey.keyData.equals(KEY_BYTES)).toBe(true)
  }
})

test('classify: confirmed-empty replies are unsupported, not errors', () => {
  expect(classifyNegotiateResult({ fields: {} })).toMatchObject({
    kind: 'unsupported',
    reason: 'no_public_key_field',
  })
  expect(classifyNegotiateResult({ fields: { 0: {} } })).toMatchObject({
    kind: 'unsupported',
    reason: 'empty_key_struct',
  })
  expect(classifyNegotiateResult(REPLY_NO_KEY)).toMatchObject({
    kind: 'unsupported',
    reason: 'no_public_key_field',
  })
  expect(
    classifyNegotiateResult({ fields: { 0: { 1: [], 2: {} } } }),
  ).toMatchObject({ kind: 'unsupported', reason: 'empty_key_struct' })
})

test('classify: transport failures are errors, never unsupported', () => {
  expect(classifyNegotiateResult({ error: 'timeout' })).toMatchObject({
    kind: 'error',
    reason: 'transport_timeout',
  })
  expect(classifyNegotiateResult({ error: 'empty_response' })).toMatchObject({
    kind: 'error',
    reason: 'transport_empty_response',
  })
  expect(classifyNegotiateResult(null)).toMatchObject({
    kind: 'error',
    reason: 'transport_error',
  })
})

test('classify: a present-but-broken key struct is malformed, never unsupported', () => {
  // keyId without keyData
  expect(
    classifyNegotiateResult({ fields: { 0: { 2: { 2: 42 } } } }),
  ).toMatchObject({ kind: 'error', reason: 'malformed_key' })
  // keyData of an unusable type
  expect(
    classifyNegotiateResult({ fields: { 0: { 2: { 2: 42, 4: 12345 } } } }),
  ).toMatchObject({ kind: 'error', reason: 'malformed_key' })
  // flattened keyData only
  expect(
    classifyNegotiateResult({ fields: { 0: { 4: KEY_BYTES } } }),
  ).toMatchObject({ kind: 'error', reason: 'malformed_key' })
})

test('decision: without the opt-in nothing is looked up and E2EE is chosen', async () => {
  const { client, calls } = makeClient({
    official: true,
    negotiate: REPLY_NO_KEY,
  })
  const decision = await resolveTextSendMode(client, OA_MID)
  expect(decision).toMatchObject({ mode: 'e2ee', reason: 'default_e2ee' })
  expect(calls).toEqual([])
})

test('decision: groups and rooms are E2EE regardless of the opt-in', async () => {
  for (const mid of ['c-group', 'r-room']) {
    const { client, calls } = makeClient({
      official: true,
      negotiate: REPLY_NO_KEY,
    })
    const decision = await resolveTextSendMode(client, mid, {
      allowPlaintextForOfficial: true,
    })
    expect(decision).toMatchObject({ mode: 'e2ee', reason: 'group_or_room' })
    expect(calls).toEqual([])
  }
})

test('decision: verified OA + confirmed-empty negotiate selects plaintext', async () => {
  const { client, calls } = makeClient({
    official: true,
    negotiate: REPLY_NO_KEY,
  })
  const decision = await resolveTextSendMode(client, OA_MID, {
    allowPlaintextForOfficial: true,
  })
  expect(decision).toMatchObject({
    mode: 'plaintext-official',
    reason: 'official_without_e2ee',
    isOfficial: true,
    negotiate: { kind: 'unsupported' },
  })
  expect(decision.peerPublicKey).toBeUndefined()
  expect(calls).toEqual([`getContacts:${OA_MID}`, `negotiate:${OA_MID}`])
})

test('decision: a valid key wins over the opt-in, even for an OA, and is handed on', async () => {
  const { client, calls } = makeClient({
    official: true,
    negotiate: REPLY_WITH_KEY,
  })
  const decision = await resolveTextSendMode(client, OA_MID, {
    allowPlaintextForOfficial: true,
  })
  expect(decision).toMatchObject({
    mode: 'e2ee',
    reason: 'peer_key_negotiated',
  })
  expect(decision.peerPublicKey?.keyId).toBe('42')
  // Exactly one negotiation; the encryptor reuses peerPublicKey.
  expect(calls.filter((c) => c.startsWith('negotiate:'))).toHaveLength(1)
})

test('decision: ordinary user with no key is refused, never plaintext', async () => {
  const { client } = makeClient({ official: false, negotiate: REPLY_NO_KEY })
  const promise = resolveTextSendMode(client, USER_MID, {
    allowPlaintextForOfficial: true,
  })
  await expect(promise).rejects.toBeInstanceOf(SendModeRefusedError)
  await expect(promise).rejects.toMatchObject({
    data: { code: 'PLAINTEXT_NOT_OFFICIAL', isOfficial: false },
  })
})

test('decision: contact lookup must match the recipient and say official', async () => {
  // Contact returned for a different mid: not verified.
  const mismatch = makeClient({
    official: true,
    contactMid: 'u-somebody-else',
    negotiate: REPLY_NO_KEY,
  })
  await expect(
    resolveTextSendMode(mismatch.client, OA_MID, {
      allowPlaintextForOfficial: true,
    }),
  ).rejects.toMatchObject({ data: { code: 'PLAINTEXT_NOT_OFFICIAL' } })

  // No contact at all (lookup timed out -> []): not verified.
  const empty = makeClient({ contacts: [], negotiate: REPLY_NO_KEY })
  await expect(
    resolveTextSendMode(empty.client, OA_MID, {
      allowPlaintextForOfficial: true,
    }),
  ).rejects.toMatchObject({ data: { code: 'PLAINTEXT_NOT_OFFICIAL' } })
})

test('decision: timeouts, empty bodies and TalkExceptions refuse even for an OA', async () => {
  const cases: Array<[unknown, string]> = [
    [{ error: 'timeout' }, 'transport_timeout'],
    [{ error: 'empty_response' }, 'transport_empty_response'],
    [talkException('AUTHENTICATION_FAILED'), 'talk_exception'],
    [talkException('NOT_FOUND'), 'talk_exception'],
    [{ fields: { 0: { 2: { 2: 1 } } } }, 'malformed_key'],
  ]
  for (const [negotiate, reason] of cases) {
    const { client } = makeClient({ official: true, negotiate })
    await expect(
      resolveTextSendMode(client, OA_MID, { allowPlaintextForOfficial: true }),
    ).rejects.toMatchObject({
      data: {
        code: 'E2EE_NEGOTIATE_ERROR',
        negotiate: { kind: 'error', reason },
      },
    })
  }
})
