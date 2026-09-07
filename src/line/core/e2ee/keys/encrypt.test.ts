import { expect, test } from 'bun:test'
import { encryptE2EEMessage } from './encrypt.js'
import type { KeyManagerContext } from './key-types.js'

/**
 * Minimal KeyManagerContext for a pairwise (`u...`) encrypt: a self key and a
 * client whose negotiate call is recorded (and optionally forbidden).
 *
 * @param negotiate - What the client's negotiateE2EEPublicKey returns.
 * @returns Context plus the recorded negotiate calls.
 */
function makeCtx(negotiate: () => unknown) {
  const negotiateCalls: string[] = []
  const ctx = {
    getProfileMid: () => 'u-self',
    getSelfKeyByMid: () => ({
      keyId: '7',
      privateKey: Buffer.alloc(32, 1),
      publicKey: Buffer.alloc(32, 2),
    }),
    getSelfKeyById: () => undefined,
    raiseWarning: () => {},
    logGroupKeyEvent: () => {},
    getClient: () => ({
      negotiateE2EEPublicKey: async (mid: string) => {
        negotiateCalls.push(mid)
        return negotiate()
      },
    }),
    getStore: () => null,
    peerPublicKeys: new Map(),
    groupKeys: new Map(),
    groupKeyFetches: new Map(),
  } as unknown as KeyManagerContext
  return { ctx, negotiateCalls }
}

test('a pre-negotiated peer key is used as-is and no negotiation happens', async () => {
  const { ctx, negotiateCalls } = makeCtx(() => {
    throw new Error('must not negotiate again')
  })
  const payload = await encryptE2EEMessage(ctx, 'u-peer', 'hi', 0, {
    peerPublicKey: { keyId: '42', keyData: Buffer.alloc(32, 3) },
  })
  expect(negotiateCalls).toEqual([])
  expect(payload.chunks).toHaveLength(5)
  // receiverKeyId chunk is the pre-negotiated key id (42) as 4 big-endian bytes.
  expect(payload.chunks[4].readInt32BE(0)).toBe(42)
  expect(payload.contentMetadata).toEqual({
    e2eeVersion: '2',
    contentType: '0',
    e2eeMark: '2',
  })
})

test('without a pre-negotiated key the encryptor negotiates, and an empty reply still throws', async () => {
  const { ctx, negotiateCalls } = makeCtx(() => null)
  await expect(encryptE2EEMessage(ctx, 'u-peer', 'hi', 0)).rejects.toThrow(
    /Failed to negotiate peer E2EE public key for u-peer/,
  )
  expect(negotiateCalls).toEqual(['u-peer'])
})
