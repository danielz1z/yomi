import { describe, expect, test } from 'bun:test'
import {
  mergeMessageBoxPages,
  nextMessageBoxCursor,
} from './message-box-query.js'

describe('message-box pagination helpers', () => {
  test('deduplicates pages while retaining the latest row', () => {
    const merged = mergeMessageBoxPages([
      { messageBoxes: [{ id: 'u-old', unreadCount: 1 }, { id: 'u-dup', unreadCount: 1 }], hasNext: true },
      { messageBoxes: [{ id: 'u-dup', unreadCount: 4 }, { id: 'u-new', unreadCount: 0 }], hasNext: false },
    ])
    expect(merged.map((item) => item.id)).toEqual(['u-old', 'u-dup', 'u-new'])
    expect(merged[1].unreadCount).toBe(4)
  })

  test('stops when the server repeats the cursor', () => {
    expect(nextMessageBoxCursor([{ id: 'u-2' }], 'u-1')).toBe('u-2')
    expect(nextMessageBoxCursor([{ id: 'u-2' }], 'u-2')).toBeUndefined()
    expect(nextMessageBoxCursor([], 'u-2')).toBeUndefined()
  })
})
