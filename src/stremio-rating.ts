import { STREMIO_CACHE_MAX_ITEMS, STREMIO_CACHE_TTL_MS, trimCacheMap } from './cache-utils.js'
import { canUserAccessKnownRating, hasRatingLimit, type AppUser } from './db.js'
import { fetchMovieOfficialRatingByIds, fetchShowOfficialRatingByIds } from './tmdb.js'
import type { StremioMediaType, StremioMeta } from './sootio.js'

// The parental gate for Stremio metas. Both the Jellyfin search path and the
// Stremio addon endpoint enforce it, so it lives here rather than private to
// one of them: a parental control that exists twice drifts into two versions.

const stremioRatingCache = new Map<string, { rating: string; expiresAt: number }>()

export function pruneStremioRatingCache(now = Date.now()): void {
  for (const [key, entry] of stremioRatingCache) {
    if (entry.expiresAt <= now) stremioRatingCache.delete(key)
  }
}

// The seam the parental gate is tested through. stremioOfficialRating reads this
// cache before it reaches TMDB or TVDB, so seeding it lets a test drive the gate
// with a real rating on both media types without a network or an API key. This is
// the household's only parental control and it has two consumers, so it needs
// coverage that survives the next edit rather than byte-identity with the version
// it was moved from.
export function primeStremioRating(meta: StremioMeta, mediaType: StremioMediaType, rating: string): void {
  stremioRatingCache.set(stremioRatingCacheKey(meta, mediaType), {
    rating,
    expiresAt: Date.now() + STREMIO_CACHE_TTL_MS,
  })
}

export function stremioMetaTmdbId(meta: StremioMeta): number | null {
  if (!meta.id.startsWith('tmdb:')) return null
  const tmdbId = Number.parseInt(meta.id.slice(5), 10)
  return Number.isFinite(tmdbId) && tmdbId > 0 ? tmdbId : null
}

export function stremioMetaImdbId(meta: StremioMeta): string {
  const imdbId = meta.imdb_id || meta.imdbId || (meta.id.startsWith('tt') ? meta.id : '')
  return /^tt\d+$/i.test(imdbId) ? imdbId : ''
}

export function stremioMetaTvdbId(meta: StremioMeta): number | undefined {
  const raw = (meta as StremioMeta & { tvdb_id?: number | string; tvdbId?: number | string }).tvdb_id
    ?? (meta as StremioMeta & { tvdb_id?: number | string; tvdbId?: number | string }).tvdbId
  const tvdbId = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number.parseInt(raw, 10) : NaN
  return Number.isFinite(tvdbId) && tvdbId > 0 ? tvdbId : undefined
}

function stremioRatingCacheKey(meta: StremioMeta, mediaType: StremioMediaType): string {
  return `${mediaType}:${meta.id}:${stremioMetaImdbId(meta)}:${stremioMetaTmdbId(meta) ?? ''}:${stremioMetaTvdbId(meta) ?? ''}`
}

export async function stremioOfficialRating(meta: StremioMeta, mediaType: StremioMediaType): Promise<string> {
  pruneStremioRatingCache()
  const key = stremioRatingCacheKey(meta, mediaType)
  const cached = stremioRatingCache.get(key)
  if (cached && cached.expiresAt > Date.now()) return cached.rating

  const tmdbId = stremioMetaTmdbId(meta)
  const imdbId = stremioMetaImdbId(meta)
  const rating = mediaType === 'movie'
    ? await fetchMovieOfficialRatingByIds({ tmdbId, imdbId })
    : await fetchShowOfficialRatingByIds({ tmdbId, imdbId, tvdbId: stremioMetaTvdbId(meta) })
  stremioRatingCache.set(key, { rating, expiresAt: Date.now() + STREMIO_CACHE_TTL_MS })
  trimCacheMap(stremioRatingCache, STREMIO_CACHE_MAX_ITEMS)
  return rating
}

export async function canUserAccessStremioMeta(user: AppUser, meta: StremioMeta, mediaType: StremioMediaType): Promise<boolean> {
  if (!hasRatingLimit(user)) return true
  const rating = await stremioOfficialRating(meta, mediaType)
  return canUserAccessKnownRating(user.maxRating, rating)
}
