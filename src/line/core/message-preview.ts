/**
 * Convert raw/decrypted LINE payloads into safe user-facing preview text.
 *
 * E2EE media envelopes are transport data, not message text. They commonly
 * contain keyMaterial, keys, chunks, ciphertext, or nonce fields. This
 * boundary must be shared by every conversation/message output path so a raw
 * message cannot bypass the decrypted-path sanitizer.
 */
const OPAQUE_FIELD = /(?:^|["'\s,{])(keymaterial|keys|chunks|ciphertext|nonce)\s*["']?\s*:/i
const OPAQUE_TOKEN = /\b(?:keymaterial|ciphertext|nonce)\b/i

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function containsOpaqueField(value: unknown): boolean {
  if (typeof value === 'string') {
    return OPAQUE_FIELD.test(value) || (value.trim().startsWith('{') && OPAQUE_TOKEN.test(value))
  }
  if (Array.isArray(value)) return value.some(containsOpaqueField)
  if (!isRecord(value)) return false
  return Object.entries(value).some(([key, nested]) =>
    /^(keymaterial|keys|chunks|ciphertext|nonce)$/i.test(key) || containsOpaqueField(nested),
  )
}

/** Return only actual user text; opaque E2EE envelopes return an empty string. */
export function sanitizeMessagePreview(value: unknown): string {
  if (containsOpaqueField(value)) return ''
  if (typeof value !== 'string') {
    if (!isRecord(value)) return ''
    for (const key of ['text', 'message', 'body', 'content', 'caption']) {
      const nested = sanitizeMessagePreview(value[key])
      if (nested) return nested
    }
    return ''
  }

  const text = value.trim()
  if (!text) return ''
  if (!text.startsWith('{') && !text.startsWith('[')) return text

  try {
    const parsed = JSON.parse(text) as unknown
    if (!isRecord(parsed)) return ''
    for (const key of ['text', 'message', 'body', 'content', 'caption']) {
      const nested = sanitizeMessagePreview(parsed[key])
      if (nested) return nested
    }
    return ''
  } catch {
    // A non-JSON message beginning with punctuation is still normal text.
    return text
  }
}

