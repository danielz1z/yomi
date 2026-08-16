import { expect, test } from 'bun:test'
import { buildFindContactByUseridRequest } from '../../line/client/talk-service/requests.js'
import {
  createChatRuntimeService,
  normalizeLineSearchId,
} from '../../line/core/chat-runtime-service.js'
import type { LineProtocolService } from '../../line/core/service.js'
import {
  decodeResponseMessage,
  encodeCallMessage,
} from '../../line/core/thrift/index.js'
import { handleAddFriend, handleFindContactById } from './contacts.js'

/**
 * A service stand-in carrying the chat-runtime mixin plus a fake client
 * whose talk calls are recorded. No network: the fake client IS the LINE
 * server for these tests. It intentionally has NO
 * findContactBySearchIdOrTicketV3 method — any code path still calling the
 * capability-gated RelationService V3 RPC blows up loudly here.
 *
 * @param options.contact - Contact the search resolves to.
 * @param options.searchError - Error the search throws instead.
 * @returns The wired service plus the recorded client calls.
 */
function makeService(options: { contact?: any; searchError?: any } = {}) {
  const calls: { method: string; args: any[] }[] = []
  const contact =
    'contact' in options
      ? options.contact
      : { mid: 'u-resolved-mid', displayName: 'Shop', type: 0 }
  const service: any = {
    nameCache: new Map<string, string>(),
    client: {
      async findContactByUserid(searchId: string) {
        calls.push({ method: 'findContactByUserid', args: [searchId] })
        if (options.searchError) {
          throw options.searchError
        }
        return contact
      },
      async findAndAddContactByMid(mid: string, reference?: string) {
        calls.push({
          method: 'findAndAddContactsByMid',
          args: [mid, reference],
        })
        return { mid, relation: 1 }
      },
    },
  }
  Object.assign(service, createChatRuntimeService(service))
  return { service: service as LineProtocolService, calls }
}

test('request wire shape: {2: searchId} on findContactByUserid, no reqSeq at field 1', () => {
  const data = encodeCallMessage(
    'findContactByUserid',
    1,
    buildFindContactByUseridRequest('@shop'),
  )
  const decoded = decodeResponseMessage(data)
  expect(decoded.method).toBe('findContactByUserid')
  expect(decoded.fields?.[2]).toBe('@shop')
  // This legacy method predates the reqSeq convention — field 1 must stay
  // empty (CHRLINE TalkService.findContactByUserid: [[11, 2, searchId]]).
  expect(decoded.fields?.[1]).toBeUndefined()
})

test('addFriend by MID adds directly — no search call', async () => {
  const { service, calls } = makeService()
  const result = await service.addFriend('u-raw-mid')
  expect(result).toEqual({
    added: true,
    mid: 'u-raw-mid',
    contact: { mid: 'u-raw-mid', relation: 1 },
  })
  expect(calls.map((c) => c.method)).toEqual(['findAndAddContactsByMid'])
  expect(calls[0].args[0]).toBe('u-raw-mid')
})

test('addFriendByUserId resolves the ID, then adds the resolved MID', async () => {
  const { service, calls } = makeService()
  const result = await service.addFriendByUserId('@shop')
  expect(calls.map((c) => c.method)).toEqual([
    'findContactByUserid',
    'findAndAddContactsByMid',
  ])
  expect(calls[0].args).toEqual(['@shop'])
  // The add goes by the resolved MID with the ID-search breadcrumb — never
  // by re-sending the human-facing ID to the MID-only RPC.
  expect(calls[1].args[0]).toBe('u-resolved-mid')
  expect(calls[1].args[1]).toBe(
    '{"screen":"friendAdd:idSearch","spec":"native"}',
  )
  expect(result).toMatchObject({
    added: true,
    userId: '@shop',
    mid: 'u-resolved-mid',
  })
  // The resolved name warms the shared cache for later tool calls.
  expect((service as any).nameCache.get('u-resolved-mid')).toBe('Shop')
})

test('the capability-gated RelationService V3 RPC is never what the search uses', async () => {
  const { service, calls } = makeService()
  await service.findContactByUserId('@shop')
  await service.addFriendByUserId('@shop')
  // LINE answers findContactBySearchIdOrTicketV3 with "API method not
  // capable" on a DESKTOPMAC identity — the fake client above does not even
  // implement it, so any leftover call path throws TypeError instead.
  expect(
    calls.every((c) => c.method !== 'findContactBySearchIdOrTicketV3'),
  ).toBe(true)
  expect(calls.map((c) => c.method)).toEqual([
    'findContactByUserid',
    'findContactByUserid',
    'findAndAddContactsByMid',
  ])
})

test('addFriendByUserId fails honestly when the search yields no mid', async () => {
  const { service, calls } = makeService({ contact: null })
  await expect(service.addFriendByUserId('@nobody')).rejects.toThrow(
    /no contact in response/,
  )
  // Nothing was added.
  expect(calls.map((c) => c.method)).not.toContain('findAndAddContactsByMid')
})

test('findContactByUserId resolves without adding', async () => {
  const { service, calls } = makeService()
  const result = await service.findContactByUserId('some.line.id')
  expect(result).toMatchObject({
    userId: 'some.line.id',
    mid: 'u-resolved-mid',
  })
  expect(calls.map((c) => c.method)).toEqual(['findContactByUserid'])
})

test('normalizeLineSearchId trims and codes the rejection', () => {
  expect(normalizeLineSearchId('  @shop ')).toBe('@shop')
  try {
    normalizeLineSearchId('bad id!')
    throw new Error('should have thrown')
  } catch (error: any) {
    expect(error.data.code).toBe('INVALID_LINE_ID')
    expect(error.message).toContain('bad id!')
  }
})

test('malformed IDs are rejected before any network call', async () => {
  const { service, calls } = makeService()
  for (const bad of [
    '',
    '   ',
    '@',
    'has space',
    '@double@at',
    '日本語',
    'a@b',
  ]) {
    await expect(service.findContactByUserId(bad)).rejects.toThrow(
      /not a valid LINE ID/,
    )
    await expect(service.addFriendByUserId(bad)).rejects.toThrow(
      /not a valid LINE ID/,
    )
  }
  expect(calls).toHaveLength(0)
})

test('well-formed shapes pass validation: plain IDs, @OAs, dots/underscores/dashes', async () => {
  const { service, calls } = makeService()
  for (const good of [
    'daniel484',
    '@522cimsu',
    'some.line-id_ok',
    '@grabmerchantth',
  ]) {
    await service.findContactByUserId(good)
  }
  expect(calls.map((c) => c.args[0])).toEqual([
    'daniel484',
    '@522cimsu',
    'some.line-id_ok',
    '@grabmerchantth',
  ])
})

test('handleAddFriend routes mid vs userId to different protocol paths', async () => {
  const byMid = makeService()
  await handleAddFriend(byMid.service, { mid: 'u-direct' })
  expect(byMid.calls.map((c) => c.method)).toEqual(['findAndAddContactsByMid'])

  const byId = makeService()
  await handleAddFriend(byId.service, { userId: '@shop' })
  expect(byId.calls.map((c) => c.method)).toEqual([
    'findContactByUserid',
    'findAndAddContactsByMid',
  ])
})

test('handleAddFriend requires exactly one identifier', async () => {
  const { service, calls } = makeService()
  const neither: any = await handleAddFriend(service, {})
  expect(neither.isError).toBe(true)
  expect(neither.content[0].text).toContain('mid or userId')

  const both: any = await handleAddFriend(service, {
    mid: 'u-x',
    userId: '@x',
  })
  expect(both.isError).toBe(true)
  expect(both.content[0].text).toContain('only one')
  expect(calls).toHaveLength(0)
})

test('a NOT_FOUND from LINE becomes an honest "no such account" error', async () => {
  const { service } = makeService({
    searchError: Object.assign(new Error('Request internal failed'), {
      data: { code: 'NOT_FOUND' },
    }),
  })
  const result: any = await handleAddFriend(service, { userId: '@ghost' })
  expect(result.isError).toBe(true)
  expect(result.content[0].text).toContain('No LINE account matches "@ghost"')
  expect(result.content[0].text).toContain('keep the leading "@"')
})

test('a method-not-capable answer is reported as a capability restriction, not a miss', async () => {
  const { service } = makeService({
    searchError: Object.assign(
      new Error(
        "findContactByUserid failed: API method not capable: 'findContactByUserid'",
      ),
      { data: { code: 'METHOD_NOT_CAPABLE' } },
    ),
  })
  const find: any = await handleFindContactById(service, { userId: '@shop' })
  expect(find.isError).toBe(true)
  expect(find.content[0].text).toContain('does not allow')
  expect(find.content[0].text).toContain('capability')
  expect(find.content[0].text).not.toContain('No LINE account matches')

  const add: any = await handleAddFriend(service, { userId: '@shop' })
  expect(add.isError).toBe(true)
  expect(add.content[0].text).toContain('capability')
})

test('an invalid ID gets its own message and never touches LINE', async () => {
  const { service, calls } = makeService()
  const result: any = await handleFindContactById(service, {
    userId: 'bad id!',
  })
  expect(result.isError).toBe(true)
  expect(result.content[0].text).toContain('not a valid LINE ID')
  expect(calls).toHaveLength(0)
})

test('a non-classified failure propagates instead of masquerading as a miss', async () => {
  const { service } = makeService({
    searchError: new Error(
      'Request internal failed, findContactByUserid -> rate limited',
    ),
  })
  await expect(handleAddFriend(service, { userId: '@shop' })).rejects.toThrow(
    /rate limited/,
  )
  await expect(
    handleFindContactById(service, { userId: '@shop' }),
  ).rejects.toThrow(/rate limited/)
})

test('find_contact_by_id resolves read-only and reports misses honestly', async () => {
  const { service, calls } = makeService()
  const found: any = await handleFindContactById(service, { userId: '@shop' })
  expect(found.isError).toBeFalsy()
  expect(JSON.parse(found.content[0].text)).toMatchObject({
    userId: '@shop',
    mid: 'u-resolved-mid',
  })
  expect(calls.map((c) => c.method)).toEqual(['findContactByUserid'])

  const missing = makeService({
    searchError: Object.assign(new Error('Request internal failed'), {
      data: { code: 'NOT_FOUND' },
    }),
  })
  const miss: any = await handleFindContactById(missing.service, {
    userId: 'no.such.id',
  })
  expect(miss.isError).toBe(true)
  expect(miss.content[0].text).toContain('No LINE account matches "no.such.id"')
})

test('find_contact_by_id requires userId', async () => {
  const { service } = makeService()
  const result: any = await handleFindContactById(service, {
    userId: '',
  })
  expect(result.isError).toBe(true)
  expect(result.content[0].text).toContain('userId is required')
})
