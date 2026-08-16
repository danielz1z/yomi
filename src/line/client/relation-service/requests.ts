import { stringField, structField } from '../../core/thrift/index.js'

/**
 * Build the findContactBySearchIdOrTicketV3 request fields (RelationService
 * /RE4) — resolve a human-facing LINE ID or an Official Account basic ID
 * (leading `@`, e.g. `@shop`) to a Contact. Request shape per linejs
 * (evex-dev/linejs, base/service/relation): a single struct arg at field 1
 * wrapping the search-id transition struct `{ 1: { 1: searchId } }`.
 *
 * @param searchId - LINE ID or `@`-prefixed Official Account basic ID.
 * @returns Thrift request fields.
 */
export function buildFindContactBySearchIdOrTicketV3Request(searchId) {
  return [structField(1, [structField(1, [stringField(1, searchId)])])]
}
