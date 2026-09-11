// Generic Map helpers shared by the Stremio caches and the image proxy. They lived
// in src/stremio-rating.ts, which meant the image proxy imported a Map utility from
// a parental-control module.

export const STREMIO_CACHE_MAX_ITEMS = 1_000

// Not SEARCH-specific: the same window is used for the rating cache, the search
// cache and the season and episode caches.
export const STREMIO_CACHE_TTL_MS = 15 * 60 * 1000

export function trimCacheMap<K, V>(cache: Map<K, V>, maxItems: number): void {
  while (cache.size > maxItems) {
    const firstKey = cache.keys().next().value as K | undefined
    if (firstKey === undefined) return
    cache.delete(firstKey)
  }
}
