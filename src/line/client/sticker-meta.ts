/**
 * Sticker package metadata from LINE's PUBLIC sticker CDN.
 *
 * getOwnedStickerPackages (ShopService) returns package-level info; to actually
 * send a sticker LINE needs an individual sticker id (STKID). Those live in the
 * package's public productInfo.meta on the sticker CDN — no auth, no account
 * data sent (only the public packageId), so this is safe to fetch for any owned
 * package the caller wants to expand into sendable sticker ids.
 */

const CDN = 'https://stickershop.line-scdn.net/stickershop/v1/product'

// Metadata is public and immutable for the lifetime of a picker session. Keep
// one in-flight/result promise per package so opening the picker or changing
// locale does not refetch the same package repeatedly.
const packageMetaCache = new Map<string, Promise<StickerPackageMeta | null>>()

/** One sticker package's public metadata, trimmed to what sending needs. */
export interface StickerPackageMeta {
  packageId: string
  /** Localized titles keyed by locale (e.g. { en, zh_TW }). */
  title: Record<string, string>
  /** Individual sticker ids (STKID) in the package. */
  stickerIds: string[]
}

/** Pick the title users expect for the app's current language. */
export function localizedStickerTitle(
  titles: Record<string, string> | undefined,
  language = 'en',
  fallback = '',
): string {
  const values = titles ?? {}
  const normalized = language.replace('_', '-').toLowerCase()
  const preferred = normalized.startsWith('zh')
    ? ['zh-Hant', 'zh_TW', 'zh-TW', 'zh']
    : normalized.startsWith('ja')
      ? ['ja']
      : ['en']
  for (const key of preferred) {
    const value = values[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  const english = values.en
  if (typeof english === 'string' && english.trim()) return english.trim()
  const first = Object.values(values).find(
    (value) => typeof value === 'string' && value.trim(),
  )
  return first?.trim() || fallback
}

/**
 * Fetch one sticker package's public metadata (title + individual sticker ids).
 *
 * @param packageId - LINE sticker package id (STKPKGID).
 * @returns Package metadata, or null when the CDN has no such package.
 */
export async function fetchStickerPackageMeta(
  packageId: string,
): Promise<StickerPackageMeta | null> {
  const res = await fetch(`${CDN}/${packageId}/android/productInfo.meta`)
  if (!res.ok) {
    return null
  }
  const meta: any = await res.json()
  const stickers = Array.isArray(meta?.stickers) ? meta.stickers : []
  return {
    packageId: String(meta?.packageId ?? packageId),
    title:
      meta?.title && typeof meta.title === 'object'
        ? (meta.title as Record<string, string>)
        : {},
    stickerIds: stickers
      .map((s: any) => (s?.id != null ? String(s.id) : null))
      .filter((id: string | null): id is string => id !== null),
  }
}

export function fetchStickerPackageMetaCached(
  packageId: string,
): Promise<StickerPackageMeta | null> {
  const cached = packageMetaCache.get(packageId)
  if (cached) return cached
  const request = fetchStickerPackageMeta(packageId)
  packageMetaCache.set(packageId, request)
  return request
}

/**
 * Fetch one sticker's PNG preview image from the public sticker CDN.
 *
 * @param stickerId - LINE sticker id (STKID).
 * @returns PNG bytes, or null when the CDN has no such sticker.
 */
export async function fetchStickerImage(
  stickerId: string,
): Promise<Buffer | null> {
  const res = await fetch(
    `${CDN.replace('/product', '/sticker')}/${stickerId}/android/sticker.png`,
  )
  if (!res.ok) {
    return null
  }
  return Buffer.from(await res.arrayBuffer())
}
