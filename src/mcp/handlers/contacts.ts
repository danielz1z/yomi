import type { LineProtocolService } from '../../line/core/service.js'
import { createCliLogger } from '../../util/log.js'
import { resolveUserNames } from '../names.js'
import { jsonResult, toolError, toonResult } from './shared.js'

const log = createCliLogger('Yomi')

/** One resolved LINE contact/member shape shared by the contact/group tools. */
interface ContactSummary {
  mid: string
  displayName: string | null
}

/**
 * Fetch and normalize the authenticated user's full friend list in one
 * round trip: enumerate friend MIDs, then resolve them all through a
 * single batched getContacts call. Also warms the shared nameCache so
 * later tool calls (get_chat_messages, list_conversations) skip the
 * network for these MIDs.
 *
 * @param service - Resumed LineProtocolService.
 * @returns Normalized friend contacts (unresolved names surfaced as null, never fabricated).
 */
async function fetchAllContacts(
  service: LineProtocolService,
): Promise<ContactSummary[]> {
  const mids = await service.client.getAllContactIds()
  if (!Array.isArray(mids) || mids.length === 0) {
    return []
  }
  const contacts = await service.client.getContacts(mids)
  const summaries: ContactSummary[] = []
  for (const contact of contacts as any[]) {
    if (!contact?.mid) {
      continue
    }
    if (contact.displayName) {
      service.nameCache.set(contact.mid, contact.displayName)
    }
    summaries.push({
      mid: contact.mid,
      displayName: contact.displayName ?? null,
    })
  }
  return summaries
}

/**
 * Handle `list_contacts` — the raw LINE friend list, straight from
 * getAllContactIds + getContacts. No ranking, no scoring: whatever order
 * LINE returns is what callers get.
 *
 * @param service - Resumed LineProtocolService.
 * @returns MCP tool result.
 */
export async function handleListContacts(service: LineProtocolService) {
  const contacts = await fetchAllContacts(service)
  return toonResult(contacts)
}

/**
 * Handle `find_contact` — case-insensitive substring match over the
 * friend list's displayName, so a caller can resolve a person's name to
 * the MID `send_message` needs for a 1:1. Pure lookup: no fuzzy scoring,
 * no ranking by interaction history.
 *
 * @param service - Resumed LineProtocolService.
 * @param args - Tool arguments.
 * @returns MCP tool result.
 */
export async function handleFindContact(
  service: LineProtocolService,
  args: { name: string },
) {
  if (!args.name) {
    return toolError('name is required.')
  }
  const needle = args.name.toLowerCase()
  const contacts = await fetchAllContacts(service)
  const matches = contacts.filter((contact) =>
    contact.displayName?.toLowerCase().includes(needle),
  )
  return toonResult(matches)
}

/**
 * Handle `get_group_members` — the raw member list of one LINE group/room.
 *
 * Members come from getChats(withMembers): the chat's `extra` union carries
 * the group-chat record at field 1, whose field 4 is a
 * `{ memberMid: joinTimestamp }` map and field 5 the pending-invitation map.
 * MIDs are resolved to display names via the shared batched/cached resolver.
 * (getGroup returns null for these chats and is not used.)
 *
 * @param service - Resumed LineProtocolService.
 * @param args - Tool arguments.
 * @returns MCP tool result.
 */
export async function handleGetGroupMembers(
  service: LineProtocolService,
  args: { chatId: string },
) {
  if (!args.chatId) {
    return toolError('chatId is required.')
  }
  const chats = await service.client.getChats([args.chatId], true)
  const chat = Array.isArray(chats) ? chats[0] : chats
  const groupExtra = (chat as any)?.extra?.['1']
  if (!groupExtra) {
    return toolError(
      `No membership data for chatId "${args.chatId}" (not a group chat, or LINE returned no member list).`,
    )
  }
  const memberMids = Object.keys(groupExtra['4'] ?? {})
  const invitedMids = Object.keys(groupExtra['5'] ?? {})
  const names = await resolveUserNames(service, [...memberMids, ...invitedMids])
  const summaries = [
    ...memberMids.map((mid) => ({
      mid,
      displayName: names.get(mid) ?? null,
      invited: false,
    })),
    ...invitedMids.map((mid) => ({
      mid,
      displayName: names.get(mid) ?? null,
      invited: true,
    })),
  ]
  return toonResult(summaries)
}

/**
 * Whether a thrown LINE error is the contact-search "no match" outcome
 * (TalkException code 5, NOT_FOUND) rather than a real failure.
 *
 * @param error - Error thrown by the search/add call.
 * @returns True when LINE reported no match for the searched ID.
 */
function isContactNotFoundError(error: any): boolean {
  const code = error?.data?.code
  return code === 'NOT_FOUND' || code === '5' || code === 5
}

/**
 * Handle `add_friend` — REALLY adds a person to THIS account's LINE friends
 * now. Two identifier forms: `mid` (TalkService findAndAddContactsByMid
 * directly) or `userId` — a LINE ID / Official Account basic ID like
 * `@shop` — resolved first via RelationService
 * findContactBySearchIdOrTicketV3, then added by the resolved MID.
 *
 * @param service - Resumed LineProtocolService.
 * @param args - Tool arguments (`mid` xor `userId`).
 * @returns MCP tool result.
 */
export async function handleAddFriend(
  service: LineProtocolService,
  args: { mid?: string; userId?: string },
) {
  if (!args.mid && !args.userId) {
    return toolError(
      'mid or userId is required. Pass a LINE ID (or @OfficialAccount basic ID) as `userId`, or a raw MID as `mid`.',
    )
  }
  if (args.mid && args.userId) {
    return toolError('Pass only one of mid / userId, not both.')
  }
  try {
    if (args.userId) {
      const result = await service.addFriendByUserId(args.userId)
      log.info('add_friend.done', { userId: args.userId, mid: result?.mid })
      return jsonResult(result)
    }
    const result = await service.addFriend(args.mid as string)
    log.info('add_friend.done', { mid: args.mid })
    return jsonResult(result)
  } catch (error: any) {
    if (args.userId && isContactNotFoundError(error)) {
      return toolError(
        `No LINE account matches "${args.userId}". For an Official Account keep the leading "@"; ` +
          'note LINE only resolves IDs that are searchable (the owner can disable ID search).',
      )
    }
    throw error
  }
}

/**
 * Handle `find_contact_by_id` — resolve a LINE ID or Official Account basic
 * ID to a contact (mid + profile fields) WITHOUT adding it
 * (RelationService findContactBySearchIdOrTicketV3). Read-only.
 *
 * @param service - Resumed LineProtocolService.
 * @param args - Tool arguments.
 * @returns MCP tool result.
 */
export async function handleFindContactById(
  service: LineProtocolService,
  args: { userId: string },
) {
  if (!args.userId) {
    return toolError('userId is required.')
  }
  try {
    const result = await service.findContactByUserId(args.userId)
    log.info('find_contact_by_id.done', { userId: args.userId })
    return jsonResult(result)
  } catch (error: any) {
    if (isContactNotFoundError(error)) {
      return toolError(
        `No LINE account matches "${args.userId}". For an Official Account keep the leading "@"; ` +
          'note LINE only resolves IDs that are searchable (the owner can disable ID search).',
      )
    }
    throw error
  }
}

/**
 * Handle `block_contact` — REALLY blocks a contact for THIS account now
 * (TalkService blockContact). Reversible with unblock_contact.
 *
 * @param service - Resumed LineProtocolService.
 * @param args - Tool arguments.
 * @returns MCP tool result.
 */
export async function handleBlockContact(
  service: LineProtocolService,
  args: { mid: string },
) {
  if (!args.mid) {
    return toolError('mid is required.')
  }
  const result = await service.blockContact(args.mid)
  log.info('block_contact.done', { mid: args.mid })
  return jsonResult(result)
}

/**
 * Handle `unblock_contact` — REALLY unblocks a previously blocked contact for
 * THIS account now (TalkService unblockContact).
 *
 * @param service - Resumed LineProtocolService.
 * @param args - Tool arguments.
 * @returns MCP tool result.
 */
export async function handleUnblockContact(
  service: LineProtocolService,
  args: { mid: string },
) {
  if (!args.mid) {
    return toolError('mid is required.')
  }
  const result = await service.unblockContact(args.mid)
  log.info('unblock_contact.done', { mid: args.mid })
  return jsonResult(result)
}
