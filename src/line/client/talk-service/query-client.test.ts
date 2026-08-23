import { describe, expect, test } from 'bun:test'
import { createTalkQueryClient } from './query-client.js'

describe('getAllMessageBoxes', () => {
  test('walks cursors and retains old official-account/user boxes', async () => {
    const requests: any[] = []
    const pages = [
      { fields: [{ 1: [[1, 'u-new'], [1, 'u-old']], 2: true }] },
      { fields: [{ 1: [[1, 'u-old'], [1, 'u-oa']], 2: false }] },
    ]
    const client = createTalkQueryClient({
      sendTalk: async (_name: string, request: any[]) => {
        requests.push(request)
        return pages.shift()
      },
    } as any)
    const result = await client.getAllMessageBoxes({ messageBoxCountLimit: 2 })
    expect(result.messageBoxes.map((box: any) => box.id)).toEqual(['u-new', 'u-old', 'u-oa'])
    expect(requests).toHaveLength(2)
    // The second page must move the lower/older bound, never repeat the
    // first page through maxChatId.
    expect(JSON.stringify(requests[1])).toContain('u-old')
    expect(JSON.stringify(requests[1])).toContain('[11,1')
  })
})
