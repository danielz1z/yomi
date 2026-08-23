import { expect, test } from 'bun:test'
import { fetchLineMessageMedia } from './media.js'

test('legacy image without OID/SID is fetched from OBS by message id', async () => {
  const originalFetch = globalThis.fetch
  const urls: string[] = []
  globalThis.fetch = (async (input) => {
    urls.push(String(input))
    return new Response(Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]), {
      status: 200,
      headers: { 'content-type': 'image/jpeg' },
    })
  }) as typeof fetch

  try {
    const result = await fetchLineMessageMedia(
      {
        client: { authToken: 'session-token' },
        getRecentMessages: async () => [
          {
            id: 'legacy-image-1',
            contentType: 1,
            contentMetadata: {
              seq: 'legacy-image-1',
              SRC_SVC_CODE: 'talk',
              MEDIA_CONTENT_INFO: JSON.stringify({ extension: 'jpeg' }),
            },
            text: null,
          },
        ],
      },
      'clegacy',
      'legacy-image-1',
      true,
    )
    expect(result.contentType).toBe(1)
    expect(result.bytes.length).toBe(4)
    expect(result.mimeType).toBe('image/jpeg')
    expect(urls).toEqual([
      'https://obs.line-apps.com/r/talk/m/legacy-image-1/preview',
    ])
  } finally {
    globalThis.fetch = originalFetch
  }
})
