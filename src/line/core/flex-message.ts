export interface FlexMessageInterpretation {
  summary: string
  imageUrl: string | null
  actionUrl: string | null
  actionLabels: string[]
}

const FLEX_PAYLOAD_KEYS = ['FLEX_JSON', 'FLEX_CONTENTS', 'FLEX_MESSAGE', 'CONTENTS', 'MARKUP_JSON'] as const

function parseObject(value: unknown): unknown {
  if (typeof value !== 'string') return value
  const trimmed = value.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null
  try { return JSON.parse(trimmed) } catch { return null }
}

function webUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null
  } catch { return null }
}

/** Interpret LINE bubble/carousel content in header→hero→body→footer order. */
export function interpretFlexPayload(payload: unknown): FlexMessageInterpretation {
  const texts: string[] = []
  const images: string[] = []
  const actions: Array<{ label: string; url: string | null }> = []
  const seen = new Set<unknown>()
  let visited = 0

  const addText = (value: unknown) => {
    if (typeof value !== 'string') return
    const clean = value.replace(/\s+/g, ' ').trim()
    if (clean && !texts.includes(clean)) texts.push(clean)
  }

  const walk = (raw: unknown, depth = 0) => {
    if (depth > 24 || visited >= 800) return
    const value = parseObject(raw)
    if (!value || typeof value !== 'object' || seen.has(value)) return
    seen.add(value)
    visited += 1
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1)
      return
    }

    const node = value as Record<string, unknown>
    const type = typeof node.type === 'string' ? node.type.toLowerCase() : ''
    if (type === 'text' || type === 'span') addText(node.text)
    if (type === 'image' || type === 'video') {
      const image = webUrl(node.url) || webUrl(node.previewUrl)
      if (image && !images.includes(image)) images.push(image)
    }

    const action = parseObject(node.action)
    if (action && typeof action === 'object' && !Array.isArray(action)) {
      const record = action as Record<string, unknown>
      const label = [record.label, record.displayText, record.text]
        .find((item): item is string => typeof item === 'string' && item.trim().length > 0) ?? ''
      const url = webUrl(record.uri)
      if (label || url) actions.push({ label: label.trim(), url })
    }

    const ordered = ['header', 'hero', 'body', 'footer', 'contents', 'altContent']
    for (const key of ordered) if (key in node) walk(node[key], depth + 1)
    for (const [key, child] of Object.entries(node)) {
      if (ordered.includes(key) || ['action', 'type', 'text', 'url', 'previewUrl'].includes(key)) continue
      if (child && typeof child === 'object') walk(child, depth + 1)
    }
  }

  walk(payload)
  const machineLabels = new Set(['uri', 'url', 'link', 'open', 'action'])
  const actionLabels = actions.map((item) => item.label).filter(Boolean)
  const readableActionLabels = actionLabels.filter((label) => !machineLabels.has(label.toLowerCase()))
  const readable = [...texts, ...readableActionLabels.filter((label) => !texts.includes(label))]
  return {
    summary: readable.join(' · ').slice(0, 700),
    imageUrl: images[0] ?? null,
    actionUrl: actions.find((item) => item.url)?.url ?? null,
    actionLabels,
  }
}

export function interpretFlexMessage(message: any): FlexMessageInterpretation {
  const metadata = message?.contentMetadata && typeof message.contentMetadata === 'object'
    ? message.contentMetadata as Record<string, unknown>
    : {}
  for (const key of FLEX_PAYLOAD_KEYS) {
    const parsed = parseObject(metadata[key])
    if (parsed) return interpretFlexPayload(parsed)
  }
  const textPayload = parseObject(message?.text)
  return textPayload ? interpretFlexPayload(textPayload) : {
    summary: '', imageUrl: null, actionUrl: null, actionLabels: [],
  }
}
