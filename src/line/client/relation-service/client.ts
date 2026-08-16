/**
 * LINE RelationService (/RE4) capability — contact discovery that
 * TalkService's MID-based lookups cannot do: resolving a human-facing
 * LINE ID or an Official Account basic ID (`@shop`) to a Contact.
 *
 * Wire shape follows linejs (evex-dev/linejs, base/service/relation), the
 * reference the flow is ported from. Errors surface as the usual
 * LineRequestError from sendCompact (TalkException at field 1), so a
 * miss (LINE reports NOT_FOUND) reaches the caller as an honest throw.
 */

import { LINE_APP_CONFIG } from '../../core/config.js'
import { mapContactList } from '../talk-service/contact-query.js'
import { buildFindContactBySearchIdOrTicketV3Request } from './requests.js'

/**
 * Create the RelationService capability bound to one LINE client runtime.
 *
 * @param runtime - Mutable LINE client runtime.
 * @returns Relation methods bound to the runtime.
 */
export function createRelationClient(runtime) {
  return {
    /**
     * Resolve a LINE ID or Official Account basic ID (leading `@`) to a
     * normalized contact via RelationService findContactBySearchIdOrTicketV3.
     * Throws when LINE matches nothing or rejects the lookup.
     *
     * @param searchId - LINE ID or `@`-prefixed Official Account basic ID.
     * @returns The normalized contact (same shape as getContacts entries).
     */
    async findContactBySearchIdOrTicketV3(searchId) {
      const result = await runtime.sendCompact(
        LINE_APP_CONFIG.relationPath,
        'findContactBySearchIdOrTicketV3',
        buildFindContactBySearchIdOrTicketV3Request(searchId),
      )
      if (result.error) {
        throw new Error(
          `findContactBySearchIdOrTicketV3 failed: ${result.error}`,
        )
      }
      const contact = mapContactList([result.fields?.[0]])[0] as any
      if (!contact?.mid) {
        throw new Error(
          `findContactBySearchIdOrTicketV3: no contact in response for "${searchId}"`,
        )
      }
      return contact
    },
  }
}
