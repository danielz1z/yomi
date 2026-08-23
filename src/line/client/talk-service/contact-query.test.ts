import { describe, expect, test } from 'bun:test'
import { mapContactList } from './contact-query.js'

describe('contact notification and official flags', () => {
  test('maps official account mute settings from fields 35 and 36', () => {
    const [contact] = mapContactList([{ 1: 'u-official', 35: 32, 36: 1 }]) as any[]
    expect(contact.attributes).toBe(32)
    expect(contact.settings).toBe(1)
    expect(contact.isOfficial).toBe(true)
    expect(contact.notificationDisabled).toBe(true)
  })

  test('keeps ordinary unmuted contacts unmuted', () => {
    const [contact] = mapContactList([{ 1: 'u-user', 35: 0, 36: 0 }]) as any[]
    expect(contact.attributes).toBe(0)
    expect(contact.settings).toBe(0)
    expect(contact.isOfficial).toBe(false)
    expect(contact.notificationDisabled).toBe(false)
  })
})
