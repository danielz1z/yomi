import { describe, expect, test } from 'bun:test'
import { ensureSyncRevision, updateSyncRevisions } from './client.js'

describe('LINE sync checkpoints', () => {
  test('hydrates an uninitialised revision from getLastOpRevision', async () => {
    const calls: string[] = []
    const runtime = {
      revision: -1,
      sendTalk: async (method: string) => {
        calls.push(method)
        return { fields: { 0: 1726279 } }
      },
    }
    await ensureSyncRevision(runtime, { info() {}, warn() {}, error() {} })
    expect(calls).toEqual(['getLastOpRevision'])
    expect(runtime.revision).toBe(1726279)
  })

  test('never moves a valid checkpoint backwards', () => {
    const runtime = { revision: 1726279, globalRevision: 4, individualRevision: 8 }
    updateSyncRevisions(runtime, {
      1: { 1: [], 2: 3, 3: 7 },
      2: 1726278,
    })
    expect(runtime.revision).toBe(1726279)
    expect(runtime.globalRevision).toBe(3)
    expect(runtime.individualRevision).toBe(7)
  })
})
