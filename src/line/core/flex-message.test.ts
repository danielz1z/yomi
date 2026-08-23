import { expect, test } from 'bun:test'
import { interpretFlexMessage, interpretFlexPayload } from './flex-message.js'

const sample = {
  type: 'carousel',
  contents: [{
    type: 'bubble',
    hero: { type: 'image', url: 'https://example.com/hero.jpg' },
    body: { type: 'box', layout: 'vertical', contents: [
      { type: 'text', text: '本週 LINE POINTS' },
      { type: 'text', text: '最高回饋 15%' },
    ] },
    footer: { type: 'button', action: { type: 'uri', label: '立即查看', uri: 'https://example.com/points' } },
  }],
}

test('interprets Flex in visual order with image and action', () => {
  expect(interpretFlexPayload(sample)).toEqual({
    summary: '本週 LINE POINTS · 最高回饋 15% · 立即查看',
    imageUrl: 'https://example.com/hero.jpg',
    actionUrl: 'https://example.com/points',
    actionLabels: ['立即查看'],
  })
})

test('reads Flex JSON from inbound LINE metadata', () => {
  expect(interpretFlexMessage({ contentMetadata: { FLEX_JSON: JSON.stringify(sample) } }).summary)
    .toContain('最高回饋 15%')
})

test('rejects unsafe Flex action schemes', () => {
  expect(interpretFlexPayload({ type: 'button', action: {
    type: 'uri', label: '不要執行', uri: 'javascript:alert(1)',
  } }).actionUrl).toBeNull()
})
