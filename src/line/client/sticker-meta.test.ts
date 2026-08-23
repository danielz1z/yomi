import { describe, expect, test } from 'bun:test'
import { localizedStickerTitle } from './sticker-meta.js'

describe('localizedStickerTitle', () => {
  const titles = {
    en: 'Flower Friends',
    'zh-Hant': '貓貓蟲咖波-花花小浪漫',
    ja: '花のなかま',
  }

  test('chooses the Traditional Chinese CDN title', () => {
    expect(localizedStickerTitle(titles, 'zh-TW')).toBe('貓貓蟲咖波-花花小浪漫')
    expect(localizedStickerTitle(titles, 'zh_TW')).toBe('貓貓蟲咖波-花花小浪漫')
  })

  test('chooses Japanese and English titles', () => {
    expect(localizedStickerTitle(titles, 'ja')).toBe('花のなかま')
    expect(localizedStickerTitle(titles, 'en')).toBe('Flower Friends')
  })

  test('falls back to English, then first title, then shop title', () => {
    expect(localizedStickerTitle({ ja: '日本語' }, 'zh-TW', 'Shop title')).toBe('日本語')
    expect(localizedStickerTitle({}, 'en', 'Shop title')).toBe('Shop title')
  })
})
