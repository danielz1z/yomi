import { expect, test } from 'bun:test'
import {
  buildSendMessageRequest,
  normalizeSendMessageOptions,
} from '../client/talk-service/requests.js'
import { createChatRuntimeService } from './chat-runtime-service.js'
import { SendModeRefusedError } from './send-mode.js'
import { decodeResponseMessage, encodeCallMessage } from './thrift/index.js'

const OA_MID = 'u-official-account'
const USER_MID = 'u-ordinary-user'
const KEY_BYTES = Buffer.alloc(32, 9)
const REPLY_WITH_KEY = {
  fields: { 0: { 1: [0, 1], 2: { 1: 1, 2: 42, 4: KEY_BYTES }, 3: 2 } },
}
const REPLY_NO_KEY = { fields: { 0: { 1: [], 3: 2 } } }

/**
 * Wire a LineProtocolService stand-in: chat-runtime mixin over a fake client
 * (records every call, never touches the network) and a fake E2EE manager
 * whose encrypt succeeds only when handed a pre-negotiated key or when its
 * own negotiation finds one, mirroring the real encryptor's contract.
 *
 * @param options.official - Whether the contact is marked official.
 * @param options.negotiate - Raw negotiate transport result, or an Error to throw.
 * @returns Service, recorded client calls, and recorded encrypt calls.
 */
function makeService(options: { official: boolean; negotiate: unknown }) {
  const calls: Array<{ method: string; args: any[] }> = []
  const encryptCalls: any[] = []
  const client: any = {
    async getContacts(mids: string[]) {
      calls.push({ method: 'getContacts', args: [mids] })
      return [{ mid: mids[0], isOfficial: options.official }]
    },
    async negotiateE2EEPublicKeyRaw(mid: string) {
      calls.push({ method: 'negotiateE2EEPublicKeyRaw', args: [mid] })
      if (options.negotiate instanceof Error) {
        throw options.negotiate
      }
      return options.negotiate
    },
    async negotiateE2EEPublicKey(mid: string) {
      calls.push({ method: 'negotiateE2EEPublicKey', args: [mid] })
      const raw = options.negotiate as any
      return raw?.fields?.[0] ?? null
    },
    async sendMessage(payload: any) {
      calls.push({ method: 'sendMessage', args: [payload] })
      return { id: 'msg-1', to: payload.to, text: payload.text }
    },
  }
  const e2eeManager = {
    async encryptE2EEMessage(
      to: string,
      data: any,
      contentType: number,
      opts: { peerPublicKey?: { keyId: string } } = {},
    ) {
      encryptCalls.push({ to, data, contentType, opts })
      const key =
        opts.peerPublicKey ??
        (await client.negotiateE2EEPublicKey(to))?.[2]?.[4]
      if (!key) {
        throw new Error(`Failed to negotiate peer E2EE public key for ${to}`)
      }
      return {
        chunks: [Buffer.from('salt'), Buffer.from('ct')],
        contentType,
        contentMetadata: { e2eeVersion: '2', contentType: '0', e2eeMark: '2' },
      }
    },
  }
  const service: any = { client, e2eeManager }
  Object.assign(service, createChatRuntimeService(service))
  return { service, calls, encryptCalls }
}

/**
 * Serialize what the fake client received exactly as the real TalkService
 * client would, then decode it back to inspect the Thrift fields.
 *
 * @param payload - Options object passed to client.sendMessage.
 * @returns Decoded message struct (field 2 of the request).
 */
function wireStruct(payload: any): Record<number, any> {
  const request = buildSendMessageRequest(
    normalizeSendMessageOptions(payload, undefined),
  )
  const decoded = decodeResponseMessage(
    encodeCallMessage('sendMessage', 1, request),
  )
  return decoded.fields?.[2] as Record<number, any>
}

test('OA + isOfficial + confirmed-empty negotiate + opt-in: one plaintext send, no encrypt', async () => {
  const { service, calls, encryptCalls } = makeService({
    official: true,
    negotiate: REPLY_NO_KEY,
  })
  const sent = await service.sendMessage(
    OA_MID,
    'hello shop',
    undefined,
    undefined,
    {
      allowPlaintextForOfficial: true,
    },
  )
  expect(sent.sendMode).toBe('plaintext-official')
  expect(sent.id).toBe('msg-1')
  expect(encryptCalls).toHaveLength(0)

  const sends = calls.filter((c) => c.method === 'sendMessage')
  expect(sends).toHaveLength(1)
  const payload = sends[0].args[0]
  expect(payload.text).toBe('hello shop')
  expect(payload.chunks).toBeNull()
  expect(payload.contentType).toBe(0)

  // Wire shape: ordinary text at field 10, no E2EE chunks (20), no
  // contentMetadata map (18) and therefore no e2eeVersion/e2eeMark markers.
  const struct = wireStruct(payload)
  expect(struct[2]).toBe(OA_MID)
  expect(struct[10]).toBe('hello shop')
  expect(struct[15]).toBe(0)
  expect(struct[18]).toBeUndefined()
  expect(struct[20]).toBeUndefined()

  // Mode was selected BEFORE the send: exactly one negotiation, then one send.
  expect(calls.map((c) => c.method)).toEqual([
    'getContacts',
    'negotiateE2EEPublicKeyRaw',
    'sendMessage',
  ])
})

test('same OA WITHOUT the opt-in still fails at encrypt and sends nothing', async () => {
  const { service, calls } = makeService({
    official: true,
    negotiate: REPLY_NO_KEY,
  })
  await expect(service.sendMessage(OA_MID, 'hello shop')).rejects.toThrow(
    /Failed to negotiate peer E2EE public key/,
  )
  expect(calls.filter((c) => c.method === 'sendMessage')).toHaveLength(0)
  expect(calls.filter((c) => c.method === 'getContacts')).toHaveLength(0)
})

test('ordinary user missing a key + opt-in: refused, nothing sent, never plaintext', async () => {
  const { service, calls } = makeService({
    official: false,
    negotiate: REPLY_NO_KEY,
  })
  await expect(
    service.sendMessage(USER_MID, 'hi', undefined, undefined, {
      allowPlaintextForOfficial: true,
    }),
  ).rejects.toMatchObject({ data: { code: 'PLAINTEXT_NOT_OFFICIAL' } })
  expect(calls.filter((c) => c.method === 'sendMessage')).toHaveLength(0)
})

test('valid peer key + opt-in: still E2EE, key reused, one negotiation total', async () => {
  const { service, calls, encryptCalls } = makeService({
    official: true,
    negotiate: REPLY_WITH_KEY,
  })
  const sent = await service.sendMessage(
    OA_MID,
    'sealed',
    undefined,
    undefined,
    {
      allowPlaintextForOfficial: true,
    },
  )
  expect(sent.sendMode).toBe('e2ee')
  expect(encryptCalls).toHaveLength(1)
  expect(encryptCalls[0].opts.peerPublicKey?.keyId).toBe('42')

  const sends = calls.filter((c) => c.method === 'sendMessage')
  expect(sends).toHaveLength(1)
  const payload = sends[0].args[0]
  expect(payload.text).toBeNull()
  expect(Array.isArray(payload.chunks)).toBe(true)
  expect(payload.contentMetadata.e2eeMark).toBe('2')
  const struct = wireStruct(payload)
  expect(struct[10]).toBeUndefined()
  expect(struct[20]).toBeDefined()

  const negotiations = calls.filter((c) =>
    c.method.startsWith('negotiateE2EEPublicKey'),
  )
  expect(negotiations).toHaveLength(1)
})

test('valid peer key WITHOUT opt-in: unchanged default E2EE path', async () => {
  const { service, calls, encryptCalls } = makeService({
    official: false,
    negotiate: REPLY_WITH_KEY,
  })
  const sent = await service.sendMessage(USER_MID, 'sealed')
  expect(sent.sendMode).toBe('e2ee')
  expect(encryptCalls).toHaveLength(1)
  expect(encryptCalls[0].opts.peerPublicKey).toBeUndefined()
  expect(calls.map((c) => c.method)).toEqual([
    'negotiateE2EEPublicKey',
    'sendMessage',
  ])
})

test('timeout or TalkException during negotiate + opt-in: refused even for an OA', async () => {
  const talkError: any = new Error(
    'Request internal failed -> AUTHENTICATION_FAILED',
  )
  talkError.data = { code: 'AUTHENTICATION_FAILED' }
  for (const negotiate of [{ error: 'timeout' }, talkError]) {
    const { service, calls } = makeService({ official: true, negotiate })
    await expect(
      service.sendMessage(OA_MID, 'hi', undefined, undefined, {
        allowPlaintextForOfficial: true,
      }),
    ).rejects.toMatchObject({ data: { code: 'E2EE_NEGOTIATE_ERROR' } })
    expect(calls.filter((c) => c.method === 'sendMessage')).toHaveLength(0)
  }
})

test('group/room + opt-in: flag ignored, no contact lookup, E2EE path', async () => {
  const { service, calls, encryptCalls } = makeService({
    official: true,
    negotiate: REPLY_NO_KEY,
  })
  // Fake encryptor negotiates by mid; a group needs a group key in reality,
  // so give it a key here purely to observe the routing.
  service.e2eeManager.encryptE2EEMessage = async (
    to: string,
    _d: any,
    ct: number,
  ) => {
    encryptCalls.push({ to, ct })
    return {
      chunks: [Buffer.from('x')],
      contentType: ct,
      contentMetadata: { e2eeMark: '2' },
    }
  }
  const sent = await service.sendMessage(
    'c-group',
    'hi',
    undefined,
    undefined,
    {
      allowPlaintextForOfficial: true,
    },
  )
  expect(sent.sendMode).toBe('e2ee')
  expect(encryptCalls).toHaveLength(1)
  expect(calls.map((c) => c.method)).toEqual(['sendMessage'])
})

test('plaintext mode refuses mentions and reply quotes before sending', async () => {
  const { service, calls } = makeService({
    official: true,
    negotiate: REPLY_NO_KEY,
  })
  await expect(
    service.sendMessage(OA_MID, '@Shop hi', { MENTION: '{}' }, undefined, {
      allowPlaintextForOfficial: true,
    }),
  ).rejects.toBeInstanceOf(SendModeRefusedError)
  await expect(
    service.sendMessage(
      OA_MID,
      'hi',
      undefined,
      {
        relatedMessageId: '1',
        messageRelationType: 3,
        relatedMessageServiceCode: 1,
      },
      { allowPlaintextForOfficial: true },
    ),
  ).rejects.toMatchObject({ data: { code: 'PLAINTEXT_UNSUPPORTED_FEATURE' } })
  expect(calls.filter((c) => c.method === 'sendMessage')).toHaveLength(0)
})

test('probeSendMode reports the decision without sending', async () => {
  const oa = makeService({ official: true, negotiate: REPLY_NO_KEY })
  expect(await oa.service.probeSendMode(OA_MID)).toMatchObject({
    refused: false,
    mode: 'plaintext-official',
    isOfficial: true,
    negotiate: { kind: 'unsupported' },
  })
  const user = makeService({ official: false, negotiate: REPLY_NO_KEY })
  expect(await user.service.probeSendMode(USER_MID)).toMatchObject({
    refused: true,
    code: 'PLAINTEXT_NOT_OFFICIAL',
  })
  const keyed = makeService({ official: true, negotiate: REPLY_WITH_KEY })
  const probe = await keyed.service.probeSendMode(OA_MID)
  expect(probe).toMatchObject({
    refused: false,
    mode: 'e2ee',
    negotiate: { kind: 'key', keyId: '42' },
  })
  expect(JSON.stringify(probe)).not.toContain(KEY_BYTES.toString('base64'))
  for (const { calls } of [oa, user, keyed]) {
    expect(calls.filter((c) => c.method === 'sendMessage')).toHaveLength(0)
  }
})
