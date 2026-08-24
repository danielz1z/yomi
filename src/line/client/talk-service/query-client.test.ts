import { describe, expect, test } from 'bun:test'
import { createTalkQueryClient } from './query-client.js'

/**
 * Bind the TalkService query capability to a scripted runtime. sendTalk is
 * the transport boundary — the script answers with decoded response objects,
 * so no LINE server is contacted.
 *
 * @param response - What sendTalk resolves with (or throws).
 * @returns The bound client plus the recorded calls.
 */
function makeClient(response: any) {
  const calls: { method: string; args: any }[] = []
  const runtime = {
    async sendTalk(method: string, args: any) {
      calls.push({ method, args })
      if (response instanceof Error) {
        throw response
      }
      return response
    },
  }
  return { client: createTalkQueryClient(runtime), calls }
}

/** A minimal Contact struct as the thrift reader delivers it. */
const CONTACT_STRUCT = { 1: 'u0123456789abcdef', 10: 0, 22: 'GrabMerchantTH' }

test('findContactByUserid maps the Contact struct at field 0', async () => {
  const { client, calls } = makeClient({ fields: { 0: CONTACT_STRUCT } })
  const contact = await client.findContactByUserid('@grabmerchantth')
  expect(calls[0].method).toBe('findContactByUserid')
  expect(contact.mid).toBe('u0123456789abcdef')
  expect(contact.displayName).toBe('GrabMerchantTH')
})

test('a TalkException struct is left to sendCompact (tested via its throw)', async () => {
  // sendCompact throws before findContactByUserid sees the result; simulate
  // that boundary with a rejecting sendTalk carrying the normalized code.
  const notFound: any = new Error(
    'Request internal failed, findContactByUserid(/S4) -> Cannot find',
  )
  notFound.data = { code: 'NOT_FOUND' }
  const { client } = makeClient(notFound)
  await expect(client.findContactByUserid('daniel484')).rejects.toThrow(
    /Cannot find/,
  )
})

test('a STRING in the exception slot is classified, not mistaken for a miss', async () => {
  // Live-observed shape: LINE answers a capability rejection with a plain
  // string at field 1 ("API method not capable: '...'"), which sendCompact
  // does not throw on — without this branch the caller saw "no contact in
  // response", i.e. a capability problem disguised as an empty search.
  const { client } = makeClient({
    fields: { 1: "API method not capable: 'findContactByUserid'" },
  })
  try {
    await client.findContactByUserid('@shop')
    throw new Error('should have thrown')
  } catch (error: any) {
    expect(error.message).toContain('API method not capable')
    expect(error.data.code).toBe('METHOD_NOT_CAPABLE')
  }
})

test('a non-capability string exception keeps an honest generic code', async () => {
  const { client } = makeClient({ fields: { 1: 'some unstructured failure' } })
  try {
    await client.findContactByUserid('@shop')
    throw new Error('should have thrown')
  } catch (error: any) {
    expect(error.data.code).toBe('LINE_ERROR')
  }
})

test('a transport-level failure throws with context', async () => {
  const { client } = makeClient({ error: 'timeout' })
  await expect(client.findContactByUserid('@shop')).rejects.toThrow(
    /findContactByUserid failed: timeout/,
  )
})

test('an empty success is reported, never fabricated into a contact', async () => {
  const { client } = makeClient({ fields: {} })
  await expect(client.findContactByUserid('@ghost')).rejects.toThrow(
    /no contact in response/,
  )
})

describe('getAllMessageBoxes', () => {
  test('walks cursors and retains old official-account/user boxes', async () => {
    const requests: any[] = []
    const pages = [
      {
        fields: [
          {
            1: [
              [1, 'u-new'],
              [1, 'u-old'],
            ],
            2: true,
          },
        ],
      },
      {
        fields: [
          {
            1: [
              [1, 'u-old'],
              [1, 'u-oa'],
            ],
            2: false,
          },
        ],
      },
    ]
    const client = createTalkQueryClient({
      sendTalk: async (_name: string, request: any[]) => {
        requests.push(request)
        return pages.shift()
      },
    } as any)
    const result = await client.getAllMessageBoxes({ messageBoxCountLimit: 2 })
    expect(result.messageBoxes.map((box: any) => box.id)).toEqual([
      'u-new',
      'u-old',
      'u-oa',
    ])
    expect(requests).toHaveLength(2)
    // The second page must move the lower/older bound, never repeat the
    // first page through maxChatId.
    expect(JSON.stringify(requests[1])).toContain('u-old')
    expect(JSON.stringify(requests[1])).toContain('[11,1')
  })
})
