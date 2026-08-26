import type { FastifyInstance, FastifyReply } from 'fastify'
import { createHash, randomBytes } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { config, normalizeListPresentation, discoverPresentationFromMode, DISCOVER_CATEGORIES, type DiscoverCategoryDef, type ListFoldersSetting, type ListPresentation, type MdblistListEntry } from '../config.js'
import { discoverSourceKey } from '../discover.js'
import {
  listMovies, countMovies, getMovieByTmdbId,
  listUsers, getUserData, saveProgress, markPlayed, markUnplayed, listResumeItemIds, countResumeItems, getAllPlayedItemIds,
  getEffectiveShowMode, listShows, countShows, getShowByTmdbId,
  getSeasonsForShow, getSeason, getEpisodesForSeason, getAiredEpisodesForSeason, isMovieVisibleToLibrary, isEpisodeVisibleToLibrary, hasAnySourceItem,
  authEnabled, canUserAccessKnownRating, canUserAccessMovie, canUserAccessShow, getDb, getUserById, getUserByUsername, hasRatingLimit, verifyUserCredentials, DEFAULT_ADMIN_USER_ID, isLibraryItemHidden, listSourceItems, getPersonProfilePath, type AppUser,
} from '../db.js'
import {
  fetchMovieByTmdbId, posterUrl,
  fetchShowByTmdbId,
  fetchMovieOfficialRatingByIds,
  fetchShowOfficialRatingByIds,
  fetchAndCacheSeasonDetails, ensureShowSeasonsCached,
  fetchMovieRecommendations, fetchShowRecommendations,
  type CreditPerson,
} from '../tmdb.js'
import type { Movie, Show, Season, Episode } from '../db.js'
import { buildPlaybackOrigin, createSignedPlaybackUrl } from '../play-auth.js'
import { mdblistListPathFromUrl } from '../mdblist.js'
import { fetchStremioMeta, searchStremioMetas, type StremioMediaType, type StremioMeta } from '../sootio.js'
import { searchTraktMetas } from '../trakt.js'
import { PLAYBACK_PROFILES, playbackProfileForKey, type PlaybackProfile } from '../playback-profiles.js'

// ── ID helpers ────────────────────────────────────────────────────────────────
// Real Jellyfin uses GUIDs for all IDs. Infuse validates this client-side.
// We encode TMDB IDs as deterministic GUIDs and decode them back on request.
//
// Encoding scheme (last 12 hex chars carry the payload):
//   Movie:   00000000-0000-4000-8000-{tmdbId 12 hex}
//   Series:  00000000-0000-4000-8001-{tmdbId 12 hex}
//   Season:  00000000-0000-4000-8002-{showTmdbId 8 hex}{seasonNum 4 hex}
//   Episode: 00000000-0000-4000-8003-{showTmdbId 6 hex}{seasonNum 3 hex}{episodeNum 3 hex}
//   Search Movie:  00000000-0000-4000-8004-{tmdbId 12 hex}
//   Search Series: 00000000-0000-4000-8005-{tmdbId 12 hex}
//   Stremio Search:    md5(stremio:item:{mediaType}:{meta id}) 32 hex
//   Stremio Source:    md5(stremio:source:{mediaType}:{meta id}) 32 hex
//   Stremio Season:    00000000-0000-4000-8008-{md5(series id/season) last 12 hex}
//   Stremio Episode:   00000000-0000-4000-8009-{md5(series id/episode id) last 12 hex}
//   Person:            00000000-0000-4000-800d-{tmdbId 12 hex}

const MOVIES_FOLDER_ID = 'a0000000-0000-4000-8000-000000000001'
const SHOWS_FOLDER_ID  = 'a0000000-0000-4000-8000-000000000002'
const COLLECTIONS_FOLDER_ID = 'a0000000-0000-4000-8007-000000000001'
const SEARCH_DISABLED_ITEM_ID = 'a0000000-0000-4000-800a-000000000001'
const SEARCH_DISABLED_RUNTIME_TICKS = 60 * 10_000_000
const MEDIA_SOURCE_ITEM_ETAG_VERSION = 'media-sources-discovery-v4'
const SERVER_GUID      = 'a0000000-0000-0000-0000-000000000001'
const SEARCH_SERVER_GUID = 'a0000000-0000-0000-0000-00000000f001'
const DISCOVER_FOLDER_ID = 'a0000000-0000-4000-8000-000000000003'
// Keep old name as alias so existing code still compiles
const FOLDER_ID = MOVIES_FOLDER_ID

// Fixed per-category ids — folder-context and collection-context are distinct
// so a category can independently show up as a top-level folder and/or a BoxSet
// under Collections without id collisions.
const DISCOVER_CATEGORY_FOLDER_IDS: Record<string, string> = Object.fromEntries(
  DISCOVER_CATEGORIES.map((def, i) => [def.slug, `a0000000-0000-4000-800b-${(i + 1).toString(16).padStart(12, '0')}`]),
)
const DISCOVER_CATEGORY_COLLECTION_IDS: Record<string, string> = Object.fromEntries(
  DISCOVER_CATEGORIES.map((def, i) => [def.slug, `a0000000-0000-4000-800c-${(i + 1).toString(16).padStart(12, '0')}`]),
)
const DISCOVER_FOLDER_ID_TO_SLUG: Record<string, string> = Object.fromEntries(
  DISCOVER_CATEGORIES.map(def => [DISCOVER_CATEGORY_FOLDER_IDS[def.slug], def.slug]),
)
const DISCOVER_COLLECTION_ID_TO_SLUG: Record<string, string> = Object.fromEntries(
  DISCOVER_CATEGORIES.map(def => [DISCOVER_CATEGORY_COLLECTION_IDS[def.slug], def.slug]),
)

const API_LIBRARY_FILTER = { availableOnly: true as const }

function traktListPresentation(slug: string): ListPresentation {
  const configured = config.traktListModes[slug]
  if (configured) return normalizeListPresentation(configured)
  return {
    includeInLibrary: true,
    showAsFolder: isTraktListFolder(config.traktFolders, slug),
    showAsCollection: config.traktCollections,
  }
}

function isTraktEntryVisible(slug: string): boolean {
  return traktListPresentation(slug).showAsFolder
}

function isTraktEntryCollection(slug: string): boolean {
  return traktListPresentation(slug).showAsCollection
}

function discoverPresentation(): ListPresentation {
  return discoverPresentationFromMode(config.discoverPresentationMode)
}

function isDiscoverFolderVisible(): boolean {
  return config.discoverEnabled && discoverPresentation().showAsFolder
}

function isDiscoverCollectionVisible(): boolean {
  return config.discoverEnabled && discoverPresentation().showAsCollection
}

function apiLibraryFilter(): { availableOnly: true; excludeSourceKeys?: string[] } {
  const mdblistKeys = config.mdblistLists
    .filter(e => !mdblistListPresentation(e).includeInLibrary)
    .map(e => mdblistFolderSourceKey(e.url))
  const traktKeys = config.traktLists
    .filter(slug => !traktListPresentation(slug).includeInLibrary)
    .map(slug => `trakt:list:${slug}`)
  const discoverKeys = config.discoverEnabled && !discoverPresentation().includeInLibrary
    ? DISCOVER_CATEGORIES.map(def => discoverSourceKey(def.slug))
    : []
  const keys = [...mdblistKeys, ...traktKeys, ...discoverKeys]
  return keys.length ? { availableOnly: true, excludeSourceKeys: keys } : API_LIBRARY_FILTER
}
const READ_CACHE_TTL_MS = 3_000
const IMAGE_PROXY_TTL_MS = 60 * 60 * 1000
const IMAGE_PROXY_TIMEOUT_MS = 10_000
const IMAGE_PROXY_MAX_BYTES = 8 * 1024 * 1024
const IMAGE_PROXY_MAX_REDIRECTS = 5
const IMAGE_PROXY_CACHE_MAX_ITEMS = 250
const STREMIO_SEARCH_CACHE_TTL_MS = 15 * 60 * 1000
const STREMIO_SEARCH_CACHE_MAX_KEYS = 2_000
const STREMIO_CACHE_MAX_ITEMS = 1_000
const PLAYED_COMPLETION_THRESHOLD = 0.95
const NEXT_UP_PROGRESS_THRESHOLD = 0.60
const JELLYFIN_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000
const LOGIN_WINDOW_MS = 15 * 60 * 1000
const LOGIN_MAX_ATTEMPTS = 10
const TRAKT_COLLECTION_CACHE_TTL_MS = 3_000
const jellyfinTokens = new Map<string, { userId: string; expiresAt: number }>()
const loginAttempts = new Map<string, { count: number; resetAt: number }>()
const proxiedImageCache = new Map<string, { buffer: Buffer; contentType: string; expiresAt: number }>()
const traktCollectionSummaryCache = new Map<string, { expiresAt: number; summaries: TraktCollectionSummary[] }>()
const stremioSearchCache = new Map<string, { meta: StremioMeta; mediaType: StremioMediaType; itemId: string; sourceId: string; expiresAt: number }>()
const stremioSeasonCache = new Map<string, { series: StremioMeta; seasonNumber: number; expiresAt: number }>()
const stremioEpisodeCache = new Map<string, { series: StremioMeta; episode: StremioMeta; expiresAt: number }>()
const stremioRatingCache = new Map<string, { rating: string; expiresAt: number }>()
type JellyfinRouteOptions = {
  searchOnly?: boolean
  prewarmPlayback?: (playPath: string, label: string) => void
  registerPlaybackItem?: (itemId: string, playPath: string) => void
  registerPlaybackClient?: (playPath: string, clientName: string) => void
  touchPlaybackItem?: (itemId: string) => void
  stopPlaybackItem?: (itemId: string) => void
  validatePlaybackCandidate?: (candidate: string, itemId: string) => boolean
  buildPlaybackMediaSources?: (input: {
    itemId: string
    sourceId: string
    origin: string
    playPath: string
    name: string
    runtimeTicks: number
    playbackClient: string
  }) => Promise<Array<Record<string, unknown>>>
}
type ImageKind = 'poster' | 'backdrop' | 'logo' | 'profile'
type ImageQuery = {
  tag?: string
  width?: string
  maxWidth?: string
  height?: string
  maxHeight?: string
  quality?: string
}

function tmdbToId(tmdbId: number): string {
  return `00000000-0000-4000-8000-${tmdbId.toString(16).padStart(12, '0')}`
}

function idToTmdb(id: string): number {
  const m = id.match(/^00000000-0000-4000-8000-([0-9a-f]{12})$/i)
  if (m) return parseInt(m[1], 16)
  const n = parseInt(id)           // backward-compat for numeric string IDs
  return isNaN(n) ? 0 : n
}

function showTmdbToId(tmdbId: number): string {
  return `00000000-0000-4000-8001-${tmdbId.toString(16).padStart(12, '0')}`
}

function idToShowTmdb(id: string): number | null {
  const m = id.match(/^00000000-0000-4000-8001-([0-9a-f]{12})$/i)
  return m ? parseInt(m[1], 16) : null
}

function personTmdbToId(tmdbId: number): string {
  return `00000000-0000-4000-800d-${tmdbId.toString(16).padStart(12, '0')}`
}

function idToPersonTmdb(id: string): number | null {
  const m = id.match(/^00000000-0000-4000-800d-([0-9a-f]{12})$/i)
  return m ? parseInt(m[1], 16) : null
}

function searchMovieTmdbToId(tmdbId: number): string {
  return `00000000-0000-4000-8004-${tmdbId.toString(16).padStart(12, '0')}`
}

function idToSearchMovieTmdb(id: string): number | null {
  const m = id.match(/^00000000-0000-4000-8004-([0-9a-f]{12})$/i)
  return m ? parseInt(m[1], 16) : null
}

function searchShowTmdbToId(tmdbId: number): string {
  return `00000000-0000-4000-8005-${tmdbId.toString(16).padStart(12, '0')}`
}

function idToSearchShowTmdb(id: string): number | null {
  const m = id.match(/^00000000-0000-4000-8005-([0-9a-f]{12})$/i)
  return m ? parseInt(m[1], 16) : null
}

function normalizePlaybackItemId(itemId: string): string {
  return itemId
}

function traktListId(slug: string, kind: 'folder' | 'collection'): string {
  const digest = createHash('md5').update(`trakt:list:${kind}:${slug}`).digest('hex').slice(0, 12)
  return `00000000-0000-4000-8006-${digest}`
}

function traktFolderSlugToId(slug: string): string {
  return traktListId(slug, 'folder')
}

function traktCollectionSlugToId(slug: string): string {
  return traktListId(slug, 'collection')
}

function idToTraktFolderSlug(id: string): string | null {
  const m = id.match(/^00000000-0000-4000-8006-([0-9a-f]{12})$/i)
  if (!m) return null
  return config.traktLists.find(slug => traktFolderSlugToId(slug) === id) ?? null
}

function idToTraktCollectionSlug(id: string): string | null {
  const m = id.match(/^00000000-0000-4000-8006-([0-9a-f]{12})$/i)
  if (!m) return null
  return config.traktLists.find(slug => traktCollectionSlugToId(slug) === id) ?? null
}

function stremioSearchMetaIds(meta: StremioMeta, mediaType: StremioMediaType): { itemId: string; sourceId: string } {
  pruneStremioCaches()
  const itemId = createHash('md5').update(`stremio:item:${mediaType}:${meta.id}`).digest('hex')
  const sourceId = createHash('md5').update(`stremio:source:${mediaType}:${meta.id}`).digest('hex')
  const cached = { meta, mediaType, itemId, sourceId, expiresAt: Date.now() + STREMIO_SEARCH_CACHE_TTL_MS }
  stremioSearchCache.set(itemId, cached)
  stremioSearchCache.set(sourceId, cached)
  trimStremioSearchCache()
  return { itemId, sourceId }
}

function stremioSearchMetaToId(meta: StremioMeta, mediaType: StremioMediaType): string {
  return stremioSearchMetaIds(meta, mediaType).itemId
}

async function hydrateStremioSeriesMeta(series: StremioMeta): Promise<StremioMeta> {
  if ((series.videos?.length ?? 0) > 0) return series
  const detailed = await fetchStremioMeta('series', series.id).catch(() => null)
  if (!detailed || !(detailed.videos?.length ?? 0)) return series

  const merged: StremioMeta = {
    ...series,
    ...detailed,
    type: detailed.type ?? series.type ?? 'series',
    videos: detailed.videos,
  }
  stremioSearchMetaIds(merged, 'series')
  return merged
}

function idToStremioSearchMeta(id: string): { meta: StremioMeta; mediaType: StremioMediaType; itemId: string; sourceId: string; requestedId: string } | null {
  pruneStremioCaches()
  if (!/^[0-9a-f]{32}$/i.test(id)) return null
  const cached = stremioSearchCache.get(id)
  if (!cached) return null
  if (cached.expiresAt <= Date.now()) {
    stremioSearchCache.delete(cached.itemId)
    stremioSearchCache.delete(cached.sourceId)
    return null
  }
  const refreshed = { ...cached, expiresAt: Date.now() + STREMIO_SEARCH_CACHE_TTL_MS }
  stremioSearchCache.set(cached.itemId, refreshed)
  stremioSearchCache.set(cached.sourceId, refreshed)
  return { meta: cached.meta, mediaType: cached.mediaType, itemId: cached.itemId, sourceId: cached.sourceId, requestedId: id }
}

function stremioSeasonToId(series: StremioMeta, seasonNumber: number): string {
  pruneStremioCaches()
  const hash = createHash('md5').update(`stremio-season:${series.id}:${seasonNumber}`).digest('hex')
  const id = `00000000-0000-4000-8008-${hash.slice(-12)}`
  stremioSeasonCache.set(id, { series, seasonNumber, expiresAt: Date.now() + STREMIO_SEARCH_CACHE_TTL_MS })
  trimCacheMap(stremioSeasonCache, STREMIO_CACHE_MAX_ITEMS)
  return id
}

function idToStremioSeason(id: string): { series: StremioMeta; seasonNumber: number } | null {
  pruneStremioCaches()
  if (!/^00000000-0000-4000-8008-[0-9a-f]{12}$/i.test(id)) return null
  const cached = stremioSeasonCache.get(id)
  if (!cached) return null
  if (cached.expiresAt <= Date.now()) {
    stremioSeasonCache.delete(id)
    return null
  }
  return { series: cached.series, seasonNumber: cached.seasonNumber }
}

function stremioEpisodeToId(series: StremioMeta, episode: StremioMeta): string {
  pruneStremioCaches()
  const hash = createHash('md5').update(`stremio-episode:${series.id}:${episode.id || episode.season}:${episode.episode || episode.number}`).digest('hex')
  const id = `00000000-0000-4000-8009-${hash.slice(-12)}`
  stremioEpisodeCache.set(id, { series, episode, expiresAt: Date.now() + STREMIO_SEARCH_CACHE_TTL_MS })
  trimCacheMap(stremioEpisodeCache, STREMIO_CACHE_MAX_ITEMS)
  return id
}

function idToStremioEpisode(id: string): { series: StremioMeta; episode: StremioMeta } | null {
  pruneStremioCaches()
  if (!/^00000000-0000-4000-8009-[0-9a-f]{12}$/i.test(id)) return null
  const cached = stremioEpisodeCache.get(id)
  if (!cached) return null
  if (cached.expiresAt <= Date.now()) {
    stremioEpisodeCache.delete(id)
    return null
  }
  return { series: cached.series, episode: cached.episode }
}

function trimCacheMap<K, V>(cache: Map<K, V>, maxItems: number): void {
  while (cache.size > maxItems) {
    const firstKey = cache.keys().next().value as K | undefined
    if (firstKey === undefined) return
    cache.delete(firstKey)
  }
}

function trimStremioSearchCache(): void {
  const seen = new Set<object>()
  for (const entry of stremioSearchCache.values()) {
    if (stremioSearchCache.size <= STREMIO_SEARCH_CACHE_MAX_KEYS) return
    if (seen.has(entry)) continue
    seen.add(entry)
    stremioSearchCache.delete(entry.itemId)
    stremioSearchCache.delete(entry.sourceId)
  }
}

function pruneStremioCaches(now = Date.now()): void {
  for (const entry of stremioSearchCache.values()) {
    if (entry.expiresAt > now) continue
    stremioSearchCache.delete(entry.itemId)
    stremioSearchCache.delete(entry.sourceId)
  }
  for (const [id, entry] of stremioSeasonCache) {
    if (entry.expiresAt <= now) stremioSeasonCache.delete(id)
  }
  for (const [id, entry] of stremioEpisodeCache) {
    if (entry.expiresAt <= now) stremioEpisodeCache.delete(id)
  }
  for (const [key, entry] of stremioRatingCache) {
    if (entry.expiresAt <= now) stremioRatingCache.delete(key)
  }
}

function seasonToId(showTmdbId: number, seasonNum: number): string {
  return `00000000-0000-4000-8002-${showTmdbId.toString(16).padStart(8, '0')}${seasonNum.toString(16).padStart(4, '0')}`
}

function idToSeason(id: string): { showTmdbId: number; seasonNum: number } | null {
  const m = id.match(/^00000000-0000-4000-8002-([0-9a-f]{8})([0-9a-f]{4})$/i)
  return m ? { showTmdbId: parseInt(m[1], 16), seasonNum: parseInt(m[2], 16) } : null
}

function episodeToId(showTmdbId: number, seasonNum: number, episodeNum: number): string {
  return `00000000-0000-4000-8003-${showTmdbId.toString(16).padStart(6, '0')}${seasonNum.toString(16).padStart(3, '0')}${episodeNum.toString(16).padStart(3, '0')}`
}

function idToEpisode(id: string): { showTmdbId: number; seasonNum: number; episodeNum: number } | null {
  const m = id.match(/^00000000-0000-4000-8003-([0-9a-f]{6})([0-9a-f]{3})([0-9a-f]{3})$/i)
  return m ? { showTmdbId: parseInt(m[1], 16), seasonNum: parseInt(m[2], 16), episodeNum: parseInt(m[3], 16) } : null
}

// ── Helpers ───────────────────────────────────────────────────────────────────

type DetailEntity = {
  id: number
  name: string
}

function stableMetaId(kind: string, value: string): string {
  return createHash('md5').update(`${kind}:${value}`).digest('hex')
}

interface ReadCacheEntry<T> {
  expiresAt: number
  inFlight?: Promise<T>
  value?: T
}

const readCache = new Map<string, ReadCacheEntry<unknown>>()

async function withReadCache<T>(key: string, loader: () => Promise<T>): Promise<T> {
  const now = Date.now()
  const existing = readCache.get(key) as ReadCacheEntry<T> | undefined
  if (existing?.value !== undefined && existing.expiresAt > now) return existing.value
  if (existing?.inFlight) return existing.inFlight

  const inFlight = loader().then(value => {
    readCache.set(key, { value, expiresAt: Date.now() + READ_CACHE_TTL_MS })
    return value
  }).finally(() => {
    const latest = readCache.get(key) as ReadCacheEntry<T> | undefined
    if (latest?.inFlight) readCache.set(key, { value: latest.value, expiresAt: latest.expiresAt })
  })

  readCache.set(key, { expiresAt: now + READ_CACHE_TTL_MS, inFlight })
  return inFlight
}

function clientIp(headers: Record<string, string | string[] | undefined>): string {
  const cfIp = headers['cf-connecting-ip']
  if (typeof cfIp === 'string' && cfIp.trim()) return cfIp.trim()
  const forwardedFor = headers['x-forwarded-for']
  if (typeof forwardedFor === 'string' && forwardedFor.trim()) return forwardedFor.split(',')[0].trim()
  return 'unknown'
}

function playbackClientFromHeaders(headers: Record<string, string | string[] | undefined>): string {
  const client = headers['x-emby-client'] ?? headers['x-media-browser-client'] ?? headers['user-agent']
  return Array.isArray(client) ? client[0] ?? '' : client ?? ''
}

function loginRateState(ip: string) {
  const now = Date.now()
  const existing = loginAttempts.get(ip)
  if (!existing || now > existing.resetAt) {
    const fresh = { count: 0, resetAt: now + LOGIN_WINDOW_MS }
    loginAttempts.set(ip, fresh)
    return fresh
  }
  return existing
}

function bodyString(body: Record<string, unknown> | undefined, keys: string[]): string {
  if (!body) return ''
  for (const key of keys) {
    const value = body[key]
    if (typeof value === 'string') return value
    if (value != null) return String(value)
  }
  return ''
}

const ALLOWED_IMAGE_CONTENT_TYPES = new Set([
  'image/avif',
  'image/bmp',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/x-icon',
])

function normalizedHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
}

function ipv4ToNumber(address: string): number | null {
  const parts = address.split('.').map(part => Number.parseInt(part, 10))
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return null
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3]
}

function ipv4InCidr(address: string, base: string, bits: number): boolean {
  const value = ipv4ToNumber(address)
  const baseValue = ipv4ToNumber(base)
  if (value == null || baseValue == null) return false
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
  return (value & mask) === (baseValue & mask)
}

function isBlockedIpv4(address: string): boolean {
  return [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.0.2.0', 24],
    ['192.168.0.0', 16],
    ['198.18.0.0', 15],
    ['198.51.100.0', 24],
    ['203.0.113.0', 24],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4],
  ].some(([base, bits]) => ipv4InCidr(address, String(base), Number(bits)))
}

function isBlockedIpv6(address: string): boolean {
  const lower = address.toLowerCase()
  if (lower === '::' || lower === '::1') return true
  const mappedIpv4 = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (mappedIpv4) return isBlockedIpv4(mappedIpv4[1])
  const embeddedIpv4 = lower.match(/(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/)
  if (embeddedIpv4) return isBlockedIpv4(embeddedIpv4[1])
  const firstHextet = Number.parseInt(lower.split(':')[0] || '0', 16)
  if (!Number.isFinite(firstHextet)) return true
  return (firstHextet & 0xfe00) === 0xfc00
    || (firstHextet & 0xffc0) === 0xfe80
    || (firstHextet & 0xff00) === 0xff00
}

function isBlockedIpAddress(address: string): boolean {
  const normalized = normalizedHostname(address)
  const version = isIP(normalized)
  if (version === 4) return isBlockedIpv4(normalized)
  if (version === 6) return isBlockedIpv6(normalized)
  return true
}

async function isPublicHttpUrl(url: URL): Promise<boolean> {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false
  if (url.username || url.password) return false

  const hostname = normalizedHostname(url.hostname)
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) return false
  if (isIP(hostname)) return !isBlockedIpAddress(hostname)

  try {
    const addresses = await lookup(hostname, { all: true, verbatim: true })
    return addresses.length > 0 && addresses.every(entry => !isBlockedIpAddress(entry.address))
  } catch {
    return false
  }
}

function imageContentType(raw: string | null): string | null {
  const contentType = raw?.split(';')[0]?.trim().toLowerCase() ?? ''
  return ALLOWED_IMAGE_CONTENT_TYPES.has(contentType) ? contentType : null
}

async function readLimitedResponseBody(res: Response): Promise<Buffer | null> {
  const rawLength = res.headers.get('content-length')
  const contentLength = rawLength ? Number.parseInt(rawLength, 10) : 0
  if (Number.isFinite(contentLength) && contentLength > IMAGE_PROXY_MAX_BYTES) {
    await res.body?.cancel().catch(() => {})
    return null
  }

  if (!res.body) {
    const buffer = Buffer.from(await res.arrayBuffer())
    return buffer.length <= IMAGE_PROXY_MAX_BYTES ? buffer : null
  }

  const chunks: Buffer[] = []
  let total = 0
  const reader = res.body.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > IMAGE_PROXY_MAX_BYTES) {
        await reader.cancel().catch(() => {})
        return null
      }
      chunks.push(Buffer.from(value))
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks, total)
}

function cacheProxiedImage(url: string, value: { buffer: Buffer; contentType: string }, now = Date.now()): void {
  proxiedImageCache.set(url, { ...value, expiresAt: now + IMAGE_PROXY_TTL_MS })
  trimCacheMap(proxiedImageCache, IMAGE_PROXY_CACHE_MAX_ITEMS)
}

async function fetchProxiedImage(url: string): Promise<{ buffer: Buffer; contentType: string } | null> {
  const now = Date.now()
  const cached = proxiedImageCache.get(url)
  if (cached && cached.expiresAt > now) {
    return { buffer: cached.buffer, contentType: cached.contentType }
  }

  try {
    let current = new URL(url)
    for (let redirects = 0; redirects <= IMAGE_PROXY_MAX_REDIRECTS; redirects++) {
      if (!await isPublicHttpUrl(current)) return null
      const res = await fetch(current, {
        redirect: 'manual',
        headers: {
          'user-agent': 'Fetcherr/1.0',
          'accept': 'image/avif,image/webp,image/png,image/jpeg,image/gif,image/*;q=0.8',
        },
        signal: AbortSignal.timeout(IMAGE_PROXY_TIMEOUT_MS),
      })

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location')
        await res.body?.cancel().catch(() => {})
        if (!location) return null
        current = new URL(location, current)
        continue
      }

      if (!res.ok) {
        await res.body?.cancel().catch(() => {})
        return null
      }

      const contentType = imageContentType(res.headers.get('content-type'))
      if (!contentType) {
        await res.body?.cancel().catch(() => {})
        return null
      }

      const buffer = await readLimitedResponseBody(res)
      if (!buffer) return null
      const result = { buffer, contentType }
      cacheProxiedImage(url, result, now)
      return result
    }
    return null
  } catch {
    return null
  }
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  if (typeof value === 'string') return value
  return value?.[0]
}

function parsePositiveInt(value: string | undefined): number | null {
  if (!value) return null
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function requestedImageWidth(query: ImageQuery | undefined): number | null {
  return parsePositiveInt(query?.width) ?? parsePositiveInt(query?.maxWidth)
}

function imageKindForType(type: string): ImageKind {
  const normalized = type.toLowerCase()
  if (normalized === 'logo') return 'logo'
  if (normalized === 'backdrop' || normalized === 'thumb') return 'backdrop'
  return 'poster'
}

function imageEtag(tag: string | undefined, url: string): string {
  return `"${tag || createHash('sha1').update(url).digest('hex')}"`
}

function jellyfinPremiereDate(date: string | undefined): string | undefined {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return undefined
  return `${date}T00:00:00.000Z`
}

async function sendImageUrl(
  reply: FastifyReply,
  headers: Record<string, string | string[] | undefined>,
  pathOrUrl: string | undefined,
  kind: ImageKind,
  query?: ImageQuery,
): Promise<FastifyReply> {
  if (!pathOrUrl) return reply.code(404).send()
  const url = posterUrl(pathOrUrl, { kind, width: requestedImageWidth(query) })
  const etag = imageEtag(query?.tag, url)
  if (firstHeaderValue(headers['if-none-match']) === etag) {
    reply.header('Cache-Control', 'public, max-age=31536000, immutable')
    reply.header('ETag', etag)
    return reply.code(304).send()
  }
  const proxied = await fetchProxiedImage(url)
  if (!proxied) return reply.code(404).send()
  reply.header('Cache-Control', 'public, max-age=31536000, immutable')
  reply.header('ETag', etag)
  reply.type(proxied.contentType)
  return reply.send(proxied.buffer)
}

function runtimeTicksForItem(itemId: string): number | null {
  const epRef = idToEpisode(itemId)
  if (epRef) {
    const episode = getEpisodesForSeason(epRef.showTmdbId, epRef.seasonNum)
      .find(e => e.episodeNumber === epRef.episodeNum)
    return episode ? (episode.runtimeMins || 45) * 60 * 10_000_000 : null
  }

  const tmdbId = idToTmdb(itemId)
  if (!tmdbId) return null
  const movie = getMovieByTmdbId(tmdbId)
  return movie ? (movie.runtimeMins || 90) * 60 * 10_000_000 : null
}

function humanizeCollectionSlug(slug: string): string {
  return slug
    .split(/[-_]+/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function hasFoldersSetting(setting: ListFoldersSetting): boolean {
  if (typeof setting === 'boolean') return setting
  return setting.length > 0
}

function isTraktListFolder(setting: ListFoldersSetting, slug: string): boolean {
  if (typeof setting === 'boolean') return setting
  return setting.includes(slug)
}

function isMdblistListFolder(setting: ListFoldersSetting, url: string): boolean {
  if (typeof setting === 'boolean') return setting
  const path = mdblistListPathFromUrl(url)
  return setting.some(s => path === s || path.endsWith(`/${s}`))
}

function mdblistListPresentation(entry: MdblistListEntry): ListPresentation {
  const hasPresentation = entry.includeInLibrary != null || entry.showAsFolder != null || entry.showAsCollection != null
  if (hasPresentation || entry.mode) return normalizeListPresentation(entry)
  return {
    includeInLibrary: true,
    showAsFolder: isMdblistListFolder(config.mdblistFolders, entry.url),
    showAsCollection: false,
  }
}

function isMdblistEntryVisible(entry: MdblistListEntry): boolean {
  return mdblistListPresentation(entry).showAsFolder
}

function mdblistFolderUrlForId(id: string | null | undefined): string | null {
  if (!id) return null
  const url = idToMdblistListUrl(id)
  if (!url) return null
  const entry = config.mdblistLists.find(e => e.url === url)
  if (!entry) return null
  return mdblistListPresentation(entry).showAsFolder ? url : null
}

function mdblistCollectionUrlForId(id: string | null | undefined): string | null {
  if (!id) return null
  const url = idToMdblistCollectionListUrl(id)
  if (!url) return null
  const entry = config.mdblistLists.find(e => e.url === url)
  if (!entry) return null
  return mdblistListPresentation(entry).showAsCollection ? url : null
}

function hasAnyCollections(): boolean {
  return config.traktLists.some(slug => isTraktEntryCollection(slug))
    || config.mdblistLists.some(e => mdblistListPresentation(e).showAsCollection)
    || isDiscoverCollectionVisible()
}

// ── Discover (TMDB trending/popular/top-rated/upcoming) ────────────────────────
// Items are synced into the real movies/shows tables (see src/discover.ts) tagged
// with a `discover:<slug>` source key, so once synced they're ordinary library
// items — same detail/season/episode/playback code path as everything else.
// This block only builds the folder/collection browse structure around them.

function idToDiscoverFolderSlug(id: string | null | undefined): string | null {
  if (!id) return null
  return isDiscoverFolderVisible() ? (DISCOVER_FOLDER_ID_TO_SLUG[id] ?? null) : null
}

function idToDiscoverCollectionSlug(id: string | null | undefined): string | null {
  if (!id) return null
  return isDiscoverCollectionVisible() ? (DISCOVER_COLLECTION_ID_TO_SLUG[id] ?? null) : null
}

function discoverCategoryMembers(user: AppUser, slug: string): CollectionMember[] {
  return listSourceItems(discoverSourceKey(slug)).filter(item => {
    if (isLibraryItemHidden(item.mediaType, item.tmdbId)) return false
    if (item.mediaType === 'movie') {
      const movie = getMovieByTmdbId(item.tmdbId)
      return !!movie && canUserAccessMovie(user, movie)
    }
    const show = getShowByTmdbId(item.tmdbId)
    return !!show && canUserAccessShow(user, show)
  })
}

async function discoverCategoryContents(slug: string, user: AppUser): Promise<Record<string, unknown>[]> {
  const members = discoverCategoryMembers(user, slug)
  const items: Record<string, unknown>[] = []
  for (const member of members) {
    if (member.mediaType === 'movie') {
      const movie = getMovieByTmdbId(member.tmdbId)
      if (movie && canUserAccessMovie(user, movie)) items.push(movieToItem(movie, user.id))
      continue
    }
    const show = getShowByTmdbId(member.tmdbId) ?? await fetchShowByTmdbId(member.tmdbId)
    if (show && canUserAccessShow(user, show)) items.push(showToSeriesItem(show, user.id))
  }
  return items
}

function buildDiscoverCategoryFolderItem(def: DiscoverCategoryDef, count: number) {
  const id = DISCOVER_CATEGORY_FOLDER_IDS[def.slug]
  return {
    Id: id, ServerId: SERVER_GUID, Name: def.label, SortName: def.label.toLowerCase(),
    Type: 'CollectionFolder', CollectionType: 'boxsets', IsFolder: true,
    CanDelete: false, CanDownload: false, PlayAccess: 'Full',
    ChildCount: count, RecursiveItemCount: count,
    ImageTags: { Primary: `discover:${def.slug}`, Backdrop: `discover:${def.slug}` },
    UserData: { PlaybackPositionTicks: 0, PlayCount: 0, IsFavorite: false, Played: false, Key: id },
  }
}

function buildDiscoverCategoryCollectionItem(def: DiscoverCategoryDef, count: number) {
  const id = DISCOVER_CATEGORY_COLLECTION_IDS[def.slug]
  return {
    Id: id, ServerId: SERVER_GUID, Name: def.label, SortName: def.label.toLowerCase(),
    Type: 'BoxSet', CollectionType: 'boxsets', IsFolder: true,
    CanDelete: false, CanDownload: false, PlayAccess: 'Full',
    ChildCount: count, RecursiveItemCount: count,
    ImageTags: { Primary: `discover:${def.slug}`, Backdrop: `discover:${def.slug}` },
    UserData: { PlaybackPositionTicks: 0, PlayCount: 0, IsFavorite: false, Played: false, Key: id },
  }
}

function discoverFolderItemsForUser(user: AppUser) {
  if (!isDiscoverFolderVisible()) return []
  return DISCOVER_CATEGORIES.map(def => buildDiscoverCategoryFolderItem(def, discoverCategoryMembers(user, def.slug).length))
}

function discoverCollectionItemsForUser(user: AppUser) {
  if (!isDiscoverCollectionVisible()) return []
  return DISCOVER_CATEGORIES.map(def => buildDiscoverCategoryCollectionItem(def, discoverCategoryMembers(user, def.slug).length))
}

function buildDiscoverRootFolderItem(user: AppUser) {
  const count = DISCOVER_CATEGORIES.reduce((sum, def) => sum + discoverCategoryMembers(user, def.slug).length, 0)
  return {
    Name:               'Discover',
    Id:                 DISCOVER_FOLDER_ID,
    ServerId:           SERVER_GUID,
    Type:               'CollectionFolder',
    CollectionType:     'boxsets',
    IsFolder:           true,
    Path:               '/discover',
    ChildCount:         DISCOVER_CATEGORIES.length,
    RecursiveItemCount: count,
    ImageTags:          {},
    UserData: { PlaybackPositionTicks: 0, PlayCount: 0, IsFavorite: false, Played: false, Key: DISCOVER_FOLDER_ID },
  }
}

function mdblistCollectionTypeForUrl(url: string): 'movies' | 'tvshows' | 'boxsets' {
  const pathParts = mdblistListPathFromUrl(url).split('/').map(part => part.toLowerCase())
  if (pathParts.includes('movies')) return 'movies'
  if (pathParts.includes('shows') || pathParts.includes('series')) return 'tvshows'
  return 'boxsets'
}

function buildMdblistCollectionItem(entry: MdblistListEntry, count: number) {
  const path = mdblistListPathFromUrl(entry.url)
  const id = mdblistCollectionIdFromPath(path)
  const name = nameForMdblistUrl(entry.url)
  return {
    Id: id, ServerId: SERVER_GUID, Name: name, SortName: name.toLowerCase(),
    Type: 'CollectionFolder', CollectionType: mdblistCollectionTypeForUrl(entry.url), IsFolder: true,
    CanDelete: false, CanDownload: false, PlayAccess: 'Full',
    ChildCount: count, RecursiveItemCount: count,
    ImageTags: { Primary: 'mdblist', Backdrop: 'mdblist' },
    UserData: { PlaybackPositionTicks: 0, PlayCount: 0, IsFavorite: false, Played: false, Key: id },
  }
}

function mdblistCollectionItems(user: AppUser) {
  return config.mdblistLists
    .filter(e => mdblistListPresentation(e).showAsCollection)
    .map(e => buildMdblistCollectionItem(e, mdblistFolderMembers(user, e.url).length))
}

type CollectionMember = { mediaType: 'movie' | 'show'; tmdbId: number; sourcePosition?: number; syncedAt?: string }
type TraktCollectionItem = ReturnType<typeof buildTraktCollectionItem>
type TraktCollectionSummary = { slug: string; members: CollectionMember[]; item: TraktCollectionItem }

// ── MDBList folder helpers ─────────────────────────────────────────────────────

function mdblistFolderIdFromPath(path: string): string {
  const digest = createHash('md5').update(`mdblist:list:folder:${path}`).digest('hex').slice(0, 12)
  return `00000000-0000-4000-8009-${digest}`
}

function mdblistCollectionIdFromPath(path: string): string {
  const digest = createHash('md5').update(`mdblist:list:collection:${path}`).digest('hex').slice(0, 12)
  return `00000000-0000-4000-8009-${digest}`
}

function idToMdblistListUrl(id: string): string | null {
  if (!id.match(/^00000000-0000-4000-8009-[0-9a-f]{12}$/i)) return null
  const entry = config.mdblistLists.find(e => mdblistFolderIdFromPath(mdblistListPathFromUrl(e.url)) === id)
  return entry?.url ?? null
}

function idToMdblistCollectionListUrl(id: string): string | null {
  if (!id.match(/^00000000-0000-4000-8009-[0-9a-f]{12}$/i)) return null
  const entry = config.mdblistLists.find(e => mdblistCollectionIdFromPath(mdblistListPathFromUrl(e.url)) === id)
  return entry?.url ?? null
}

function humanizeMdblistPath(path: string): string {
  const name = path.split('/').pop() ?? path
  return name.split(/[-_]+/).filter(Boolean).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
}

function nameForMdblistUrl(url: string): string {
  const path = mdblistListPathFromUrl(url)
  const entry = config.mdblistLists.find(e => e.url === url || mdblistListPathFromUrl(e.url) === path)
  return entry?.name || humanizeMdblistPath(path)
}

function mdblistFolderSourceKey(listUrl: string): string {
  return `mdblist:list:${mdblistListPathFromUrl(listUrl)}`
}

function dateCreatedForSourcePosition(syncedAt: string | undefined, sourcePosition: number | undefined): string | undefined {
  if (!sourcePosition || sourcePosition <= 0) return syncedAt
  const baseMs = Date.parse(syncedAt ?? '')
  if (!Number.isFinite(baseMs)) return syncedAt
  // Treat the source ranking as an ordered sequence: rank 1 is the oldest
  // synthetic date, so Infuse's normal ascending Date Added order shows the
  // list's ranking order and descending reverses it.
  return new Date(baseMs + ((sourcePosition - 1) * 1000)).toISOString()
}

function mdblistFolderMembers(user: AppUser, listUrl: string): CollectionMember[] {
  return listSourceItems(mdblistFolderSourceKey(listUrl)).filter(item => {
    if (isLibraryItemHidden(item.mediaType, item.tmdbId)) return false
    if (item.mediaType === 'movie') {
      const movie = getMovieByTmdbId(item.tmdbId)
      return !!movie && canUserAccessMovie(user, movie)
    }
    const show = getShowByTmdbId(item.tmdbId)
    return !!show && canUserAccessShow(user, show)
  })
}

function latestEpisodePlayedDate(showTmdbId: number, userId: string): string {
  const row = getDb().prepare(`
    SELECT max(u.last_played_date) AS last_played_date
    FROM user_item_data u
    JOIN episodes e
      ON u.item_id = ('00000000-0000-4000-8003-' || lower(printf('%06x%03x%03x', e.show_tmdb_id, e.season_number, e.episode_number)))
    WHERE u.user_id = ? AND e.show_tmdb_id = ?
  `).get(userId, showTmdbId) as { last_played_date?: string } | undefined
  return row?.last_played_date ?? ''
}

function latestEpisodeAddedDate(showTmdbId: number): string {
  const row = getDb().prepare('SELECT max(synced_at) AS synced_at FROM episodes WHERE show_tmdb_id = ?')
    .get(showTmdbId) as { synced_at?: string } | undefined
  return row?.synced_at ?? ''
}

function sortMdblistFolderItems<T extends Record<string, unknown>>(items: T[], sortBy?: string, sortOrder?: string): T[] {
  const normalizedSort = (sortBy ?? '').split(',')[0].trim().toLowerCase()
  const normalizedOrder = (sortOrder ?? '').split(',')[0].trim().toLowerCase()
  const direction = normalizedOrder === 'ascending' || normalizedOrder === 'asc' ? 1 : -1
  const compareStrings = (a: unknown, b: unknown) => String(a ?? '').localeCompare(String(b ?? ''), undefined, { sensitivity: 'base' })
  const compareNumbers = (a: unknown, b: unknown) => (Number(a ?? 0) || 0) - (Number(b ?? 0) || 0)
  const compareDates = (a: unknown, b: unknown) => compareStrings(a, b)
  const compareUserData = (a: T, b: T, field: 'PlayCount' | 'LastPlayedDate') => {
    const aValue = (a.UserData as Record<string, unknown> | undefined)?.[field]
    const bValue = (b.UserData as Record<string, unknown> | undefined)?.[field]
    return field === 'PlayCount' ? compareNumbers(aValue, bValue) : compareDates(aValue, bValue)
  }
  const sourceOrder = (a: T, b: T) => compareNumbers(a.SourcePosition, b.SourcePosition)
    || compareStrings(a.SortName ?? a.Name, b.SortName ?? b.Name)

  if (!normalizedSort) return [...items]
  if (normalizedSort === 'random') {
    const shuffled = [...items]
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
    }
    return shuffled
  }

  return [...items].sort((a, b) => {
    let result: number | undefined
    if (['sortname', 'name'].includes(normalizedSort)) result = compareStrings(a.SortName ?? a.Name, b.SortName ?? b.Name)
    else if (['communityrating', 'rating', 'imdbrating'].includes(normalizedSort)) result = compareNumbers(a.CommunityRating, b.CommunityRating)
    else if (['officialrating', 'parentalrating'].includes(normalizedSort)) result = compareStrings(a.OfficialRating, b.OfficialRating)
    else if (['premieredate', 'releasedate', 'productionyear'].includes(normalizedSort)) result = compareDates(a.PremiereDate ?? a.ProductionYear, b.PremiereDate ?? b.ProductionYear)
    // MDBList rank 1 is represented by the oldest synthetic DateCreated, so
    // Infuse's normal ascending Date Added order shows the ranking order.
    else if (['datecreated', 'dateshowadded', 'dateadded', 'addeddate'].includes(normalizedSort)) result = sourceOrder(a, b)
    else if (['dateepisodeadded', 'episodeaddeddate'].includes(normalizedSort)) result = compareDates(a.EpisodeAddedDate, b.EpisodeAddedDate)
    else if (['dateplayed', 'lastplayeddate'].includes(normalizedSort)) result = compareUserData(a, b, 'LastPlayedDate')
    else if (normalizedSort === 'playcount') result = compareUserData(a, b, 'PlayCount')
    else if (['runtime', 'runtimeticks'].includes(normalizedSort)) result = compareNumbers(a.RunTimeTicks, b.RunTimeTicks)
    else if (['isfolder', 'folders'].includes(normalizedSort)) result = compareNumbers(a.IsFolder ? 1 : 0, b.IsFolder ? 1 : 0)
    // Fetcherr does not currently store a critic score. Keep the MDBList rank
    // stable instead of presenting TMDB's community score as a critic score.
    else if (['criticrating', 'criticsrating'].includes(normalizedSort)) result = sourceOrder(a, b)
    else result = sourceOrder(a, b)
    return (result || 0) * direction
  })
}

function sortCollectionItems<T extends Record<string, unknown>>(items: T[], sortBy?: string, sortOrder?: string): T[] {
  const normalizedSort = (sortBy ?? '').split(',')[0].trim().toLowerCase()
  if (!normalizedSort) return [...items]
  if (normalizedSort === 'random') {
    const shuffled = [...items]
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
    }
    return shuffled
  }
  const direction = (sortOrder ?? '').split(',')[0].trim().toLowerCase() === 'ascending' || (sortOrder ?? '').split(',')[0].trim().toLowerCase() === 'asc' ? 1 : -1
  const compare = (a: T, b: T) => String(a.SortName ?? a.Name ?? '').localeCompare(String(b.SortName ?? b.Name ?? ''), undefined, { sensitivity: 'base' })
  // Collection tiles have no movie/show rating, runtime, or playback value.
  // Name is the meaningful deterministic fallback for those Infuse keys.
  return [...items].sort((a, b) => compare(a, b) * direction)
}

async function mdblistFolderContents(listUrl: string, user: AppUser, sortBy?: string, sortOrder?: string) {
  const members = mdblistFolderMembers(user, listUrl)
  const items: Array<Record<string, unknown>> = []
  for (const member of members) {
    if (member.mediaType === 'movie') {
      const movie = getMovieByTmdbId(member.tmdbId)
      if (movie && canUserAccessMovie(user, movie)) {
        items.push({
          ...movieToItem(movie, user.id),
          DateCreated: dateCreatedForSourcePosition(member.syncedAt, member.sourcePosition),
          SourcePosition: member.sourcePosition ?? 0,
        })
      }
      continue
    }
    const show = getShowByTmdbId(member.tmdbId) ?? await fetchShowByTmdbId(member.tmdbId)
    if (show && canUserAccessShow(user, show)) {
      const item = showToSeriesItem(show, user.id)
      items.push({
        ...item,
        DateCreated: dateCreatedForSourcePosition(member.syncedAt, member.sourcePosition),
        EpisodeAddedDate: latestEpisodeAddedDate(show.tmdbId),
        SourcePosition: member.sourcePosition ?? 0,
        UserData: {
          ...(item.UserData as Record<string, unknown>),
          LastPlayedDate: latestEpisodePlayedDate(show.tmdbId, user.id),
        },
      })
    }
  }
  return sortMdblistFolderItems(items, sortBy, sortOrder)
}

function buildMdblistFolderItem(listUrl: string, count: number) {
  const path = mdblistListPathFromUrl(listUrl)
  const id = mdblistFolderIdFromPath(path)
  const name = nameForMdblistUrl(listUrl)
  return {
    Id: id, ServerId: SERVER_GUID, Name: name, SortName: name.toLowerCase(),
    Type: 'CollectionFolder', CollectionType: 'boxsets', IsFolder: true,
    CanDelete: false, CanDownload: false, PlayAccess: 'Full',
    ChildCount: count, RecursiveItemCount: count,
    ImageTags: { Primary: 'mdblist', Backdrop: 'mdblist' },
    UserData: { PlaybackPositionTicks: 0, PlayCount: 0, IsFavorite: false, Played: false, Key: id },
  }
}

function traktCollectionSourceKey(slug: string): string {
  return `trakt:list:${slug}`
}

function collectionMembersForUser(user: AppUser, slug: string): CollectionMember[] {
  return listSourceItems(traktCollectionSourceKey(slug))
    .filter(item => {
      if (isLibraryItemHidden(item.mediaType, item.tmdbId)) return false
      if (item.mediaType === 'movie') {
        const movie = getMovieByTmdbId(item.tmdbId)
        return !!movie && canUserAccessMovie(user, movie)
      }
      const show = getShowByTmdbId(item.tmdbId)
      return !!show && canUserAccessShow(user, show)
    })
}

function traktCollectionImageTags(slug: string): Record<string, string> {
  return { Primary: `trakt-list:${slug}`, Backdrop: `trakt-list:${slug}` }
}

function buildTraktCollectionItem(slug: string, members: CollectionMember[]) {
  const name = humanizeCollectionSlug(slug)
  return {
    Id:                 traktCollectionSlugToId(slug),
    ServerId:           SERVER_GUID,
    Name:               name,
    SortName:           name.toLowerCase(),
    Type:               'BoxSet',
    CollectionType:     'boxsets',
    IsFolder:           true,
    CanDelete:          false,
    CanDownload:        false,
    PlayAccess:         'Full',
    ChildCount:         members.length,
    RecursiveItemCount: members.length,
    ImageTags:          traktCollectionImageTags(slug),
    UserData: { PlaybackPositionTicks: 0, PlayCount: 0, IsFavorite: false, Played: false, Key: traktCollectionSlugToId(slug) },
  }
}

function buildTraktFolderItem(slug: string, count: number) {
  const id = traktFolderSlugToId(slug)
  const name = humanizeCollectionSlug(slug.split('/').pop() ?? slug)
  return {
    Id: id, ServerId: SERVER_GUID, Name: name, SortName: name.toLowerCase(),
    Type: 'CollectionFolder', CollectionType: 'boxsets', IsFolder: true,
    CanDelete: false, CanDownload: false, PlayAccess: 'Full',
    ChildCount: count, RecursiveItemCount: count,
    ImageTags: traktCollectionImageTags(slug),
    UserData: { PlaybackPositionTicks: 0, PlayCount: 0, IsFavorite: false, Played: false, Key: id },
  }
}

function traktCollectionToItem(slug: string, user: AppUser) {
  return buildTraktCollectionItem(slug, collectionMembersForUser(user, slug))
}

async function traktCollectionContents(slug: string, user: AppUser) {
  const members = collectionMembersForUser(user, slug)
  const items = []
  for (const member of members) {
    if (member.mediaType === 'movie') {
      const movie = getMovieByTmdbId(member.tmdbId)
      if (movie && canUserAccessMovie(user, movie)) items.push(movieToItem(movie, user.id))
      continue
    }
    const show = getShowByTmdbId(member.tmdbId) ?? await fetchShowByTmdbId(member.tmdbId)
    if (show && canUserAccessShow(user, show)) items.push(showToSeriesItem(show, user.id))
  }
  return items.sort((a, b) => String(a.SortName ?? a.Name ?? '').localeCompare(String(b.SortName ?? b.Name ?? '')))
}

function traktCollectionCacheKey(user: AppUser): string {
  return `${user.id}:${config.traktLists.join('\u0000')}`
}

function pruneExpiredTraktCollectionSummaryCache(now = Date.now()): void {
  for (const [key, entry] of traktCollectionSummaryCache.entries()) {
    if (entry.expiresAt <= now) traktCollectionSummaryCache.delete(key)
  }
}

function traktCollectionSummariesForUser(user: AppUser): TraktCollectionSummary[] {
  const now = Date.now()
  pruneExpiredTraktCollectionSummaryCache(now)
  const key = traktCollectionCacheKey(user)
  const cached = traktCollectionSummaryCache.get(key)
  if (cached && cached.expiresAt > now) return cached.summaries

  const summaries = config.traktLists
    .filter(slug => isTraktEntryCollection(slug))
    .map(slug => {
      const members = collectionMembersForUser(user, slug)
      return { slug, members, item: buildTraktCollectionItem(slug, members) }
    })
    .filter(summary => summary.members.length > 0)

  traktCollectionSummaryCache.set(key, {
    expiresAt: now + TRAKT_COLLECTION_CACHE_TTL_MS,
    summaries,
  })
  return summaries
}

function traktCollectionItemsForUser(user: AppUser): TraktCollectionItem[] {
  return traktCollectionSummariesForUser(user).map(summary => summary.item)
}

function traktCollectionsFolderToItem(user: AppUser) {
  const traktSummaries = traktCollectionSummariesForUser(user)
  const mdblistCollEntries = config.mdblistLists.filter(e => mdblistListPresentation(e).showAsCollection)
  const traktItemCount = traktSummaries.reduce((sum, s) => sum + s.members.length, 0)
  const mdblistItemCount = mdblistCollEntries.reduce((sum, e) => sum + mdblistFolderMembers(user, e.url).length, 0)
  return {
    Name:               'Collections',
    Id:                 COLLECTIONS_FOLDER_ID,
    ServerId:           SERVER_GUID,
    Type:               'CollectionFolder',
    CollectionType:     'boxsets',
    IsFolder:           true,
    Path:               '/collections',
    ChildCount:         traktSummaries.length + mdblistCollEntries.length,
    RecursiveItemCount: traktItemCount + mdblistItemCount,
    ImageTags:          rootFolderImageTags(COLLECTIONS_FOLDER_ID),
    UserData: { PlaybackPositionTicks: 0, PlayCount: 0, IsFavorite: false, Played: false, Key: COLLECTIONS_FOLDER_ID },
  }
}

function bestCollectionArtwork(members: CollectionMember[]): { path: string; kind: ImageKind } | null {
  const ranked = members
    .map(member => {
      if (member.mediaType === 'movie') {
        const movie = getMovieByTmdbId(member.tmdbId)
        return movie ? { popularity: movie.popularity ?? 0, backdropPath: movie.backdropPath, posterPath: movie.posterPath } : null
      }
      const show = getShowByTmdbId(member.tmdbId)
      return show ? { popularity: show.popularity ?? 0, backdropPath: show.backdropPath, posterPath: show.posterPath } : null
    })
    .filter((item): item is { popularity: number; backdropPath: string; posterPath: string } => item !== null)
    .sort((a, b) => b.popularity - a.popularity)

  for (const item of ranked) {
    if (item.backdropPath) return { path: item.backdropPath, kind: 'backdrop' }
    if (item.posterPath) return { path: item.posterPath, kind: 'poster' }
  }
  return null
}

async function sendTraktCollectionImage(
  slug: string,
  type: string,
  query: ImageQuery | undefined,
  headers: Record<string, string | string[] | undefined>,
  reply: FastifyReply,
): Promise<FastifyReply> {
  const user = requestUser(headers) ?? fallbackUser()
  const members = user ? collectionMembersForUser(user, slug) : listSourceItems(traktCollectionSourceKey(slug))
  const representative = bestCollectionArtwork(members)
  if (representative) return sendImageUrl(reply, headers, representative.path, representative.kind, query)
  return reply.code(404).send()
}

async function sendMdblistFolderImage(
  listUrl: string,
  type: string,
  query: ImageQuery | undefined,
  headers: Record<string, string | string[] | undefined>,
  reply: FastifyReply,
): Promise<FastifyReply> {
  const user = requestUser(headers) ?? fallbackUser()
  const members = user
    ? mdblistFolderMembers(user, listUrl)
    : listSourceItems(mdblistFolderSourceKey(listUrl))
  const representative = bestCollectionArtwork(members)
  if (representative) return sendImageUrl(reply, headers, representative.path, representative.kind, query)
  return reply.code(404).send()
}

function rootFolderImageTags(id: string) {
  return (id === MOVIES_FOLDER_ID || id === SHOWS_FOLDER_ID || id === COLLECTIONS_FOLDER_ID)
    ? { Primary: 'root', Backdrop: 'root' }
    : {}
}

function bestRootFolderImage(
  id: string,
  user: AppUser | null,
): { path: string; kind: ImageKind } | null {
  const visibleUser = user ?? fallbackUser()
  if (!visibleUser) return null
  if (id === MOVIES_FOLDER_ID) {
    const movies = filterMoviesForUser(
      visibleUser,
      listMovies({ sortBy: 'popularity', sortOrder: 'DESC', limit: 100, offset: 0, userId: visibleUser.id, ...apiLibraryFilter() }),
    )
    for (const movie of movies) {
      if (movie.backdropPath) return { path: movie.backdropPath, kind: 'backdrop' }
      if (movie.posterPath) return { path: movie.posterPath, kind: 'poster' }
    }
    return null
  }
  if (id === SHOWS_FOLDER_ID) {
    const shows = filterShowsForUser(
      visibleUser,
      listShows({ sortBy: 'popularity', sortOrder: 'DESC', limit: 100, offset: 0, userId: visibleUser.id, ...apiLibraryFilter() }),
    )
    for (const show of shows) {
      if (show.backdropPath) return { path: show.backdropPath, kind: 'backdrop' }
      if (show.posterPath) return { path: show.posterPath, kind: 'poster' }
    }
  }
  if (id === COLLECTIONS_FOLDER_ID && hasAnyCollections()) {
    const traktMembers = traktCollectionSummariesForUser(visibleUser).flatMap(s => s.members)
    const mdblistMembers = config.mdblistLists.filter(e => mdblistListPresentation(e).showAsCollection).flatMap(e => mdblistFolderMembers(visibleUser, e.url))
    return bestCollectionArtwork([...traktMembers, ...mdblistMembers])
  }
  return null
}

function reachedCompletionThreshold(positionTicks: number | undefined, runtimeTicks: number | undefined): boolean {
  if (positionTicks == null || runtimeTicks == null || runtimeTicks <= 0) return false
  return (positionTicks / runtimeTicks) >= PLAYED_COMPLETION_THRESHOLD
}

function parseJsonArray<T>(value: string): T[] {
  try {
    const parsed = JSON.parse(value || '[]')
    return Array.isArray(parsed) ? parsed as T[] : []
  } catch {
    return []
  }
}

function genreItems(genres: string[]) {
  return genres.map(name => ({ Name: name, Id: stableMetaId('genre', name) }))
}

function detailStudios(studiosJson: string) {
  const studios = parseJsonArray<DetailEntity>(studiosJson)
  return studios.map(studio => ({
    Name: studio.name,
    Id: stableMetaId('studio', String(studio.id || studio.name)),
  }))
}

function detailPeople(castJson: string) {
  const people = parseJsonArray<CreditPerson>(castJson)
  return people.map(person => ({
    Name: person.name,
    Id: personTmdbToId(person.id),
    Role: person.role || undefined,
    Type: person.type,
    PrimaryImageTag: person.profilePath ? createHash('sha1').update(person.profilePath).digest('hex').slice(0, 16) : undefined,
  }))
}

function externalUrls(type: 'movie' | 'show', imdbId: string, tmdbId: number) {
  const urls = []
  if (imdbId) urls.push({ Name: 'IMDb', Url: `https://www.imdb.com/title/${imdbId}` })
  urls.push({ Name: 'TMDB', Url: `https://www.themoviedb.org/${type === 'show' ? 'tv' : 'movie'}/${tmdbId}` })
  if (imdbId) {
    urls.push({
      Name: 'Trakt',
      Url: `https://trakt.tv/${type === 'movie' ? 'movies' : 'shows'}/${imdbId}`,
    })
  }
  return urls
}

function episodeExternalUrls(showTmdbId: number, seasonNumber: number, episodeNumber: number) {
  return [{
    Name: 'TMDB',
    Url: `https://www.themoviedb.org/tv/${showTmdbId}/season/${seasonNumber}/episode/${episodeNumber}`,
  }]
}

function userDataForItem(itemId: string, ud: { played: boolean; playCount: number; positionTicks: number; lastPlayedDate: string }, runtimeTicks = 0) {
  const playedPercentage = runtimeTicks > 0
    ? Math.max(0, Math.min(100, (ud.positionTicks / runtimeTicks) * 100))
    : undefined
  const hasActivePlaybackState = ud.played || ud.positionTicks > 0
  return {
    PlayedPercentage:      playedPercentage,
    PlaybackPositionTicks: ud.positionTicks,
    PlayCount:             ud.playCount,
    IsFavorite:            false,
    LastPlayedDate:        hasActivePlaybackState ? (ud.lastPlayedDate || undefined) : undefined,
    Played:                ud.played,
    Key:                   itemId,
    ItemId:                itemId,
  }
}

function mediaSourceItemEtag(scope: string, identity: string | number, syncedAt: string | undefined): string {
  return createHash('md5').update([
    MEDIA_SOURCE_ITEM_ETAG_VERSION,
    scope,
    identity,
    syncedAt,
    config.mediaSourceSelection ? 'versions-enabled' : 'versions-disabled',
    config.mediaSourceLimit,
  ].join(':')).digest('hex')
}

function movieItemEtag(movie: Movie): string {
  return mediaSourceItemEtag('movie', movie.tmdbId, movie.syncedAt)
}

function episodeItemEtag(ep: Episode, show: Show): string {
  return mediaSourceItemEtag('episode', `${show.tmdbId}:${ep.seasonNumber}:${ep.episodeNumber}`, ep.syncedAt)
}

function virtualProfileMediaSourceId(itemId: string, profile: PlaybackProfile): string {
  return `${itemId}:profile:${profile.key}`
}

function virtualProfilePath(itemId: string, mediaSourceId: string): string {
  const params = new URLSearchParams({
    PlaySessionId: `fetcherr-${itemId}`,
    MediaSourceId: mediaSourceId,
  })
  return `/Videos/${encodeURIComponent(itemId)}/stream?${params.toString()}`
}

function virtualProfileDimensions(profile: PlaybackProfile): { width: number; height: number } {
  switch (profile.targetHeight) {
    case 2160: return { width: 3840, height: 2160 }
    case 1080: return { width: 1920, height: 1080 }
    case 720: return { width: 1280, height: 720 }
    case 360: return { width: 640, height: 360 }
    default: return { width: 1920, height: 1080 }
  }
}

function virtualProfileMediaSources(itemId: string, runtimeTicks: number, hasPlaybackIdentity: boolean) {
  if (!config.mediaSourceSelection || !hasPlaybackIdentity) return []
  if (!config.sootioUrl && config.streamProviderUrls.length === 0) return []

  return PLAYBACK_PROFILES.map(profile => {
    const mediaSourceId = virtualProfileMediaSourceId(itemId, profile)
    const { width, height } = virtualProfileDimensions(profile)
    const bitrate = profile.targetBitrateMbps
      ? profile.targetBitrateMbps * 1_000_000
      : undefined
    return {
      Id: mediaSourceId,
      Name: profile.name,
      Type: 'Default',
      Protocol: 'Http',
      Path: virtualProfilePath(itemId, mediaSourceId),
      IsRemote: true,
      SupportsDirectPlay: true,
      SupportsDirectStream: true,
      SupportsTranscoding: false,
      RequiresOpening: false,
      RequiresClosing: false,
      Container: 'mkv',
      Bitrate: bitrate,
      VideoType: 'VideoFile',
      RunTimeTicks: runtimeTicks,
      DefaultAudioStreamIndex: 1,
      MediaStreams: [
        {
          Type: 'Video',
          Index: 0,
          Codec: 'h264',
          IsDefault: true,
          Width: width,
          Height: height,
          BitRate: bitrate,
        },
        { Type: 'Audio', Index: 1, Codec: 'aac', IsDefault: true, Language: 'eng' },
      ],
    }
  })
}
function movieToItem(m: Movie, userId = DEFAULT_ADMIN_USER_ID) {
  const genres: string[] = JSON.parse(m.genres || '[]')
  const runtimeTicks = (m.runtimeMins || 90) * 60 * 10_000_000
  const fakePath = `/movies/${m.title.replace(/[/\\:*?"<>|]/g, '')} (${m.year}).mkv`
  const id = tmdbToId(m.tmdbId)
  const ud = getUserData(id, userId)
  const posterTag = m.posterPath ? m.posterPath.replace(/\W/g, '').slice(0, 16) : undefined
  const thumbTag = (m.backdropPath || m.posterPath) ? (m.backdropPath || m.posterPath).replace(/\W/g, '').slice(0, 16) : undefined
  const logoTag = m.logoPath ? m.logoPath.replace(/\W/g, '').slice(0, 16) : undefined
  const virtualMediaSources = virtualProfileMediaSources(id, runtimeTicks, Boolean(m.imdbId))
  return {
    Id:                 id,
    ServerId:           SERVER_GUID,
    Name:               m.title,
    SortName:           m.title.replace(/^(the|a|an)\s+/i, '').toLowerCase(),
    Type:               'Movie',
    MediaType:          'Video',
    VideoType:          'VideoFile',
    LocationType:       'FileSystem',
    PlayAccess:         'Full',
    IsPlayable:         true,
    CanDelete:          false,
    CanDownload:        false,
    ProductionYear:     m.year,
    Overview:           m.overview,
    Genres:             genres,
    GenreItems:         genreItems(genres),
    Studios:            detailStudios(m.studiosJson),
    Tags:               parseJsonArray<string>(m.tagsJson),
    People:             detailPeople(m.castJson),
    OfficialRating:     m.officialRating || undefined,
    CommunityRating:    m.communityRating || undefined,
    ExternalUrls:       externalUrls('movie', m.imdbId, m.tmdbId),
    PremiereDate:       jellyfinPremiereDate(m.releaseDate || m.digitalReleaseDate),
    DateCreated:        m.syncedAt,
    Etag:               movieItemEtag(m),
    RunTimeTicks:       runtimeTicks,
    IsFolder:           false,
    Path:               fakePath,
    EnableMediaSourceDisplay: true,
    ...(virtualMediaSources.length ? {
      MediaSources: virtualMediaSources,
      AlternateMediaSources: virtualMediaSources,
      MediaSourceCount: virtualMediaSources.length,
    } : {}),
    ImageTags:          {
      ...(posterTag ? { Primary: posterTag } : {}),
      ...(logoTag ? { Logo: logoTag } : {}),
      ...(thumbTag ? { Thumb: thumbTag } : {}),
    },
    PrimaryImageTag:    null,
    BackdropImageTags:  m.backdropPath ? [m.backdropPath.replace(/\W/g, '').slice(0, 16)] : [],
    ParentId:           FOLDER_ID,
    ProviderIds:        { Imdb: m.imdbId || undefined, Tmdb: String(m.tmdbId) },
    UserData:           userDataForItem(id, ud, runtimeTicks),
  }
}

function showToSeriesItem(s: Show, userId = DEFAULT_ADMIN_USER_ID) {
  const genres: string[] = JSON.parse(s.genres || '[]')
  const id = showTmdbToId(s.tmdbId)
  const ud = getUserData(id, userId)
  const showMode = getEffectiveShowMode(s.tmdbId)
  const childCount = showMode.mode === 'latest' ? 1 : s.numSeasons
  const posterTag = s.posterPath ? s.posterPath.replace(/\W/g, '').slice(0, 16) : undefined
  const thumbTag = (s.backdropPath || s.posterPath) ? (s.backdropPath || s.posterPath).replace(/\W/g, '').slice(0, 16) : undefined
  const logoTag = s.logoPath ? s.logoPath.replace(/\W/g, '').slice(0, 16) : undefined
  return {
    Id:                 id,
    ServerId:           SERVER_GUID,
    Name:               s.title,
    SortName:           s.title.replace(/^(the|a|an)\s+/i, '').toLowerCase(),
    Type:               'Series',
    MediaType:          'Video',
    LocationType:       'FileSystem',
    PlayAccess:         'Full',
    IsPlayable:         false,
    CanDelete:          false,
    CanDownload:        false,
    ProductionYear:     s.year,
    Overview:           s.overview,
    Genres:             genres,
    GenreItems:         genreItems(genres),
    Studios:            detailStudios(s.studiosJson),
    Tags:               parseJsonArray<string>(s.tagsJson),
    People:             detailPeople(s.castJson),
    OfficialRating:     s.officialRating || undefined,
    CommunityRating:    s.communityRating || undefined,
    ExternalUrls:       externalUrls('show', s.imdbId, s.tmdbId),
    DateCreated:        s.syncedAt,
    IsFolder:           true,
    ChildCount:         childCount,
    RecursiveItemCount: childCount,
    Status:             s.status,
    ImageTags:          {
      ...(posterTag ? { Primary: posterTag } : {}),
      ...(logoTag ? { Logo: logoTag } : {}),
      ...(thumbTag ? { Thumb: thumbTag } : {}),
    },
    PrimaryImageTag:    null,
    BackdropImageTags:  s.backdropPath ? [s.backdropPath.replace(/\W/g, '').slice(0, 16)] : [],
    ParentId:           SHOWS_FOLDER_ID,
    ProviderIds:        { Imdb: s.imdbId || undefined, Tmdb: String(s.tmdbId) },
    UserData:           userDataForItem(id, ud),
  }
}

function stremioMetaName(meta: StremioMeta): string {
  return meta.name || meta.title || meta.id
}

function stremioMetaYear(meta: StremioMeta): number | undefined {
  if (typeof meta.year === 'number') return meta.year
  if (typeof meta.year === 'string') {
    const parsed = Number.parseInt(meta.year, 10)
    if (Number.isFinite(parsed)) return parsed
  }
  const releaseInfo = String(meta.releaseInfo ?? '')
  const match = releaseInfo.match(/\b(19\d{2}|20\d{2})\b/)
  return match ? Number.parseInt(match[1], 10) : undefined
}

function stremioRuntimeTicks(meta: StremioMeta, fallbackMins: number): number {
  const runtime = String(meta.runtime ?? '')
  const hours = runtime.match(/(\d+)\s*h/i)
  const minutes = runtime.match(/(\d+)\s*m/i)
  const plainMinutes = runtime.match(/^\s*(\d+)\s*$/)
  const totalMins = hours || minutes
    ? (hours ? Number.parseInt(hours[1], 10) * 60 : 0) + (minutes ? Number.parseInt(minutes[1], 10) : 0)
    : plainMinutes ? Number.parseInt(plainMinutes[1], 10) : fallbackMins
  return totalMins * 60 * 10_000_000
}

function stremioSeriesTmdbId(series: StremioMeta): number | null {
  const id = series.id.startsWith('tmdb:') ? Number.parseInt(series.id.slice(5), 10) : NaN
  return Number.isFinite(id) && id > 0 ? id : null
}

function stremioEpisodeAirDate(ep: StremioMeta): string {
  const released = typeof ep.released === 'string' ? ep.released.slice(0, 10) : ''
  if (/^\d{4}-\d{2}-\d{2}$/.test(released)) return released

  const releaseInfo = String(ep.releaseInfo ?? '')
  const dateMatch = releaseInfo.match(/\b(19\d{2}|20\d{2})-\d{2}-\d{2}\b/)
  return dateMatch?.[0] ?? ''
}

function isStremioEpisodeVisibleToLibrary(ep: StremioMeta): boolean {
  return isEpisodeVisibleToLibrary({ airDate: stremioEpisodeAirDate(ep) })
}

function visibleStremioEpisodesFromMeta(series: StremioMeta): StremioMeta[] {
  return (series.videos ?? []).filter(isStremioEpisodeVisibleToLibrary)
}

async function visibleStremioEpisodes(series: StremioMeta): Promise<StremioMeta[]> {
  const episodes = series.videos ?? []
  const tmdbId = stremioSeriesTmdbId(series)
  if (!tmdbId) return episodes.filter(isStremioEpisodeVisibleToLibrary)

  const seasonNumbers = stremioSeriesSeasons(episodes)
  await Promise.all(seasonNumbers.map(async seasonNumber => {
    if (getEpisodesForSeason(tmdbId, seasonNumber).length) return
    await fetchAndCacheSeasonDetails(tmdbId, seasonNumber).catch(() => [])
  }))

  const cachedEpisodes = new Map<string, Episode>()
  for (const seasonNumber of seasonNumbers) {
    for (const episode of getEpisodesForSeason(tmdbId, seasonNumber)) {
      cachedEpisodes.set(`${episode.seasonNumber}:${episode.episodeNumber}`, episode)
    }
  }

  return episodes.filter(ep => {
    const cached = cachedEpisodes.get(`${stremioEpisodeSeasonNumber(ep)}:${stremioEpisodeNumber(ep)}`)
    if (cached) return isEpisodeVisibleToLibrary(cached)
    return isStremioEpisodeVisibleToLibrary(ep)
  })
}

function stremioMetaExternalUrls(meta: StremioMeta, mediaType: StremioMediaType) {
  const urls = []
  const imdbId = meta.imdb_id || meta.imdbId || (meta.id.startsWith('tt') ? meta.id : '')
  if (imdbId) urls.push({ Name: 'IMDb', Url: `https://www.imdb.com/title/${imdbId}` })
  if (meta.id.startsWith('tmdb:')) {
    urls.push({
      Name: 'TMDB',
      Url: `https://www.themoviedb.org/${mediaType === 'series' ? 'tv' : 'movie'}/${meta.id.slice(5)}`,
    })
  }
  return urls
}

function stremioStubPath(id: string): string {
  return `fetcherr://stremio/${id}`
}

function stremioSearchTypeLabel(includeTypes: string): string {
  if (!includeTypes) return 'Movie,Series'
  const labels = [
    includeTypes.includes('movie') ? 'Movie' : '',
    includeTypes.includes('series') ? 'Series' : '',
  ].filter(Boolean)
  return labels.length ? labels.join(',') : includeTypes
}

function searchMovieAutoplayItem(item: Record<string, unknown>): Record<string, unknown> {
  if (item.Type !== 'Movie') return item
  const copy = { ...item }
  const providerIds = copy.ProviderIds as Record<string, unknown> | undefined
  const tmdbId = providerIds?.Tmdb
  copy.PlayAccess = 'Full'
  copy.IsPlayable = true
  copy.CanDownload = true
  copy.LocationType = 'Remote'
  copy.ParentId = null
  copy.Path = copy.Path ?? (tmdbId
    ? `fetcherr://tmdb/movie/${encodeURIComponent(String(tmdbId))}`
    : `fetcherr://search/movie/${encodeURIComponent(String(copy.Id ?? 'unknown'))}`)
  copy.EnableMediaSourceDisplay = true
  delete copy.MediaSources
  delete copy.AlternateMediaSources
  delete copy.MediaSourceCount
  return copy
}

function stremioSearchMetaToItem(
  meta: StremioMeta,
  mediaType: StremioMediaType,
  requestedId?: string,
  options: { suppressMovieAutoplay?: boolean; officialRating?: string } = {},
) {
  const { itemId, sourceId } = stremioSearchMetaIds(meta, mediaType)
  const id = requestedId ?? itemId
  const name = stremioMetaName(meta)
  const genres = meta.genres ?? meta.genre ?? []
  const runtimeTicks = stremioRuntimeTicks(meta, mediaType === 'movie' ? 90 : 45)
  const path = stremioStubPath(meta.id)
  const primaryTag = meta.poster ? createHash('md5').update(meta.poster).digest('hex') : undefined
  const logoTag = meta.logo ? createHash('sha1').update(meta.logo).digest('hex').slice(0, 16) : undefined
  const isMovie = mediaType === 'movie'
  const visibleEpisodeCount = isMovie ? undefined : visibleStremioEpisodesFromMeta(meta).length
  const year = stremioMetaYear(meta)
  const releasedDate = meta.released?.match(/^\d{4}-\d{2}-\d{2}/)?.[0]
  const date = releasedDate
    ? `${releasedDate}T00:00:00.0000000Z`
    : year ? `${year}-07-01T12:00:00.0000000Z` : undefined
  return {
    Id:                 id,
    ServerId:           SERVER_GUID,
    Name:               name,
    SortName:           name.replace(/^(the|a|an)\s+/i, '').toLowerCase(),
    Type:               isMovie ? 'Movie' : 'Series',
    MediaType:          isMovie ? 'Video' : undefined,
    VideoType:          isMovie ? 'VideoFile' : undefined,
    LocationType:       'Remote',
    PlayAccess:         isMovie && options.suppressMovieAutoplay ? 'None' : 'Full',
    IsPlayable:         isMovie && !options.suppressMovieAutoplay,
    CanDelete:          false,
    CanDownload:        isMovie && !options.suppressMovieAutoplay,
    ChannelId:          null,
    ProductionYear:     year,
    Overview:           meta.overview || meta.description,
    Genres:             genres,
    GenreItems:         genreItems(genres),
    OfficialRating:     options.officialRating || undefined,
    ExternalUrls:       meta.id.startsWith('tmdb:')
      ? [{ Name: 'TMDB', Url: `https://www.themoviedb.org/${mediaType === 'series' ? 'tv' : 'movie'}/${meta.id.slice(5)}` }]
      : stremioMetaExternalUrls(meta, mediaType),
    DateCreated:        new Date().toISOString(),
    PremiereDate:       date,
    EndDate:            date,
    RunTimeTicks:       isMovie ? runtimeTicks : undefined,
    Etag:               createHash('md5').update(`stremio:etag:${mediaType}:${meta.id}`).digest('hex'),
    DisplayPreferencesId: createHash('md5').update(`stremio:display:${mediaType}:${meta.id}`).digest('hex'),
    IsFolder:           !isMovie,
    Path:               path,
    EnableMediaSourceDisplay: isMovie ? true : undefined,
    ChildCount:         visibleEpisodeCount,
    RecursiveItemCount: visibleEpisodeCount,
    ImageTags:          {
      ...(primaryTag ? { Primary: primaryTag } : {}),
      ...(logoTag ? { Logo: logoTag } : {}),
    },
    PrimaryImageAspectRatio: primaryTag ? 0.6666666666666666 : undefined,
    BackdropImageTags:  meta.background ? [createHash('sha1').update(meta.background).digest('hex').slice(0, 16)] : [],
    ParentId:           null,
    ProviderIds:        {
      ...(meta.id.startsWith('tmdb:') ? { Tmdb: meta.id.slice(5) } : {}),
      Stremio: meta.id,
    },
    UserData:           userDataForItem(id, { played: false, playCount: 0, positionTicks: 0, lastPlayedDate: '' }, runtimeTicks),
  }
}

function stremioEpisodeSeasonNumber(ep: StremioMeta): number {
  return ep.season ?? 1
}

function stremioEpisodeNumber(ep: StremioMeta): number {
  return ep.episode ?? ep.number ?? 1
}

function stremioSeriesSeasons(series: StremioMeta[]) {
  return [...new Set(series.map(stremioEpisodeSeasonNumber).filter(n => Number.isFinite(n) && n > 0))].sort((a, b) => a - b)
}

function stremioSeasonToItem(series: StremioMeta, seasonNumber: number) {
  const id = stremioSeasonToId(series, seasonNumber)
  const seriesId = stremioSearchMetaToId(series, 'series')
  const episodes = visibleStremioEpisodesFromMeta(series)
    .filter(ep => stremioEpisodeSeasonNumber(ep) === seasonNumber)
  return {
    Id:             id,
    ServerId:       SERVER_GUID,
    Name:           `Season ${seasonNumber}`,
    SeriesName:     stremioMetaName(series),
    SeriesId:       seriesId,
    Type:           'Season',
    LocationType:   'Virtual',
    IndexNumber:    seasonNumber,
    ParentIndexNumber: seasonNumber,
    ParentId:       seriesId,
    IsFolder:       true,
    ChildCount:     episodes.length,
    RecursiveItemCount: episodes.length,
    ImageTags:      series.poster ? { Primary: createHash('sha1').update(series.poster).digest('hex').slice(0, 16) } : {},
    UserData:       userDataForItem(id, { played: false, playCount: 0, positionTicks: 0, lastPlayedDate: '' }),
  }
}

function stremioEpisodeToItem(series: StremioMeta, episode: StremioMeta) {
  const id = stremioEpisodeToId(series, episode)
  const seasonNumber = stremioEpisodeSeasonNumber(episode)
  const episodeNumber = stremioEpisodeNumber(episode)
  const seasonId = stremioSeasonToId(series, seasonNumber)
  const seriesId = stremioSearchMetaToId(series, 'series')
  const name = stremioMetaName(episode) || `Episode ${episodeNumber}`
  const runtimeTicks = stremioRuntimeTicks(episode, 45)
  const path = stremioStubPath(episode.id || `${series.id}:${seasonNumber}:${episodeNumber}`)
  return {
    Id:                 id,
    ServerId:           SERVER_GUID,
    Name:               name,
    SeriesName:         stremioMetaName(series),
    SeriesId:           seriesId,
    SeasonId:           seasonId,
    Type:               'Episode',
    MediaType:          'Video',
    VideoType:          'VideoFile',
    LocationType:       'Remote',
    PlayAccess:         'Full',
    IsPlayable:         true,
    CanDownload:        true,
    IsFolder:           false,
    IndexNumber:        episodeNumber,
    ParentIndexNumber:  seasonNumber,
    ParentId:           seasonId,
    Overview:           episode.overview || episode.description,
    ProductionYear:     stremioMetaYear(episode) ?? stremioMetaYear(series),
    RunTimeTicks:       runtimeTicks,
    Path:               path,
    EnableMediaSourceDisplay: true,
    ImageTags:          (episode.poster || series.poster) ? { Primary: createHash('sha1').update(episode.poster || series.poster || '').digest('hex').slice(0, 16) } : {},
    ProviderIds:        { Stremio: episode.id || `${series.id}:${seasonNumber}:${episodeNumber}` },
    UserData:           userDataForItem(id, { played: false, playCount: 0, positionTicks: 0, lastPlayedDate: '' }, runtimeTicks),
  }
}

function movieToSearchItem(m: Movie) {
  const genres: string[] = JSON.parse(m.genres || '[]')
  const id = searchMovieTmdbToId(m.tmdbId)
  const posterTag = m.posterPath ? m.posterPath.replace(/\W/g, '').slice(0, 16) : undefined
  const thumbTag = (m.backdropPath || m.posterPath) ? (m.backdropPath || m.posterPath).replace(/\W/g, '').slice(0, 16) : undefined
  const logoTag = m.logoPath ? m.logoPath.replace(/\W/g, '').slice(0, 16) : undefined
  return {
    Id:                 id,
    ServerId:           SERVER_GUID,
    Name:               m.title,
    SortName:           m.title.replace(/^(the|a|an)\s+/i, '').toLowerCase(),
    Type:               'Movie',
    MediaType:          'Video',
    VideoType:          'VideoFile',
    LocationType:       'Virtual',
    PlayAccess:         'None',
    IsPlayable:         false,
    CanDelete:          false,
    CanDownload:        false,
    ProductionYear:     m.year,
    Overview:           m.overview,
    Genres:             genres,
    GenreItems:         genreItems(genres),
    Studios:            detailStudios(m.studiosJson),
    Tags:               [...parseJsonArray<string>(m.tagsJson), 'Not In Library'],
    People:             detailPeople(m.castJson),
    OfficialRating:     m.officialRating || undefined,
    CommunityRating:    m.communityRating || undefined,
    ExternalUrls:       externalUrls('movie', m.imdbId, m.tmdbId),
    PremiereDate:       jellyfinPremiereDate(m.releaseDate || m.digitalReleaseDate),
    DateCreated:        m.syncedAt,
    Etag:               movieItemEtag(m),
    IsFolder:           false,
    ImageTags:          {
      ...(posterTag ? { Primary: posterTag } : {}),
      ...(logoTag ? { Logo: logoTag } : {}),
      ...(thumbTag ? { Thumb: thumbTag } : {}),
    },
    PrimaryImageTag:    null,
    BackdropImageTags:  m.backdropPath ? [m.backdropPath.replace(/\W/g, '').slice(0, 16)] : [],
    ParentId:           FOLDER_ID,
    ProviderIds:        { Imdb: m.imdbId || undefined, Tmdb: String(m.tmdbId) },
    UserData:           userDataForItem(id, { played: false, playCount: 0, positionTicks: 0, lastPlayedDate: '' }),
  }
}

function showToSearchSeriesItem(s: Show) {
  const genres: string[] = JSON.parse(s.genres || '[]')
  const id = searchShowTmdbToId(s.tmdbId)
  const posterTag = s.posterPath ? s.posterPath.replace(/\W/g, '').slice(0, 16) : undefined
  const thumbTag = (s.backdropPath || s.posterPath) ? (s.backdropPath || s.posterPath).replace(/\W/g, '').slice(0, 16) : undefined
  const logoTag = s.logoPath ? s.logoPath.replace(/\W/g, '').slice(0, 16) : undefined
  return {
    Id:                 id,
    ServerId:           SERVER_GUID,
    Name:               s.title,
    SortName:           s.title.replace(/^(the|a|an)\s+/i, '').toLowerCase(),
    Type:               'Series',
    MediaType:          'Video',
    LocationType:       'Virtual',
    PlayAccess:         'None',
    IsPlayable:         false,
    CanDelete:          false,
    CanDownload:        false,
    ProductionYear:     s.year,
    Overview:           s.overview,
    Genres:             genres,
    GenreItems:         genreItems(genres),
    Studios:            detailStudios(s.studiosJson),
    Tags:               [...parseJsonArray<string>(s.tagsJson), 'Not In Library'],
    People:             detailPeople(s.castJson),
    OfficialRating:     s.officialRating || undefined,
    CommunityRating:    s.communityRating || undefined,
    ExternalUrls:       externalUrls('show', s.imdbId, s.tmdbId),
    DateCreated:        s.syncedAt,
    IsFolder:           true,
    ChildCount:         0,
    RecursiveItemCount: 0,
    Status:             s.status,
    ImageTags:          {
      ...(posterTag ? { Primary: posterTag } : {}),
      ...(logoTag ? { Logo: logoTag } : {}),
      ...(thumbTag ? { Thumb: thumbTag } : {}),
    },
    PrimaryImageTag:    null,
    BackdropImageTags:  s.backdropPath ? [s.backdropPath.replace(/\W/g, '').slice(0, 16)] : [],
    ParentId:           SHOWS_FOLDER_ID,
    ProviderIds:        { Imdb: s.imdbId || undefined, Tmdb: String(s.tmdbId) },
    UserData:           userDataForItem(id, { played: false, playCount: 0, positionTicks: 0, lastPlayedDate: '' }),
  }
}

function visibleSeasonsForShow(show: Show): Season[] {
  const seasons = getSeasonsForShow(show.tmdbId)
  const showMode = getEffectiveShowMode(show.tmdbId)
  if (showMode.mode !== 'latest' || !showMode.activeSeasonNumber) return seasons
  return seasons.filter(s => s.seasonNumber === showMode.activeSeasonNumber)
}

function allAiredEpisodesForShow(show: Show): Episode[] {
  return getSeasonsForShow(show.tmdbId).flatMap(s => getAiredEpisodesForSeason(show.tmdbId, s.seasonNumber))
}

function visibleAiredEpisodesForShow(show: Show): Episode[] {
  return visibleSeasonsForShow(show).flatMap(s => getAiredEpisodesForSeason(show.tmdbId, s.seasonNumber))
}

function getFirstEpisodeOfFirstUnplayedSeason(show: Show, userId: string): Episode | null {
  const allEps = visibleAiredEpisodesForShow(show)
  const bySeason = new Map<number, Episode[]>()
  for (const ep of allEps) {
    if (ep.seasonNumber <= 0) continue
    const arr = bySeason.get(ep.seasonNumber) ?? []
    arr.push(ep)
    bySeason.set(ep.seasonNumber, arr)
  }
  for (const episodes of bySeason.values()) {
    const allPlayed = episodes.every(ep =>
      getUserData(episodeToId(show.tmdbId, ep.seasonNumber, ep.episodeNumber), userId).played
    )
    if (!allPlayed) return episodes[0]
  }
  return null
}

function filterMoviesForUser(user: AppUser, movies: Movie[]): Movie[] {
  return movies.filter(movie => canUserAccessMovie(user, movie))
}

function filterShowsForUser(user: AppUser, shows: Show[]): Show[] {
  return shows.filter(show => canUserAccessShow(user, show))
}

function fallbackUser(): AppUser | null {
  return getUserById(DEFAULT_ADMIN_USER_ID)
}

function initJellyfinTokenSchema(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS jellyfin_tokens (
      token       TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL,
      expires_at  INTEGER NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );
    CREATE INDEX IF NOT EXISTS jellyfin_tokens_user_id ON jellyfin_tokens(user_id);
    CREATE INDEX IF NOT EXISTS jellyfin_tokens_expires_at ON jellyfin_tokens(expires_at);
  `)
}

function purgeExpiredJellyfinTokens(): void {
  initJellyfinTokenSchema()
  getDb().prepare(`DELETE FROM jellyfin_tokens WHERE expires_at <= ?`).run(Date.now())
}

function storeJellyfinToken(token: string, userId: string, expiresAt: number): void {
  initJellyfinTokenSchema()
  getDb().prepare(`
    INSERT INTO jellyfin_tokens (token, user_id, expires_at)
    VALUES (?, ?, ?)
    ON CONFLICT(token) DO UPDATE SET
      user_id = excluded.user_id,
      expires_at = excluded.expires_at
  `).run(token, userId, expiresAt)
}

function loadJellyfinToken(token: string): { userId: string; expiresAt: number } | null {
  initJellyfinTokenSchema()
  const row = getDb().prepare(`
    SELECT user_id, expires_at
    FROM jellyfin_tokens
    WHERE token = ?
  `).get(token) as { user_id: string; expires_at: number } | undefined
  if (!row) return null
  return { userId: row.user_id, expiresAt: Number(row.expires_at) }
}

function deleteJellyfinToken(token: string): void {
  initJellyfinTokenSchema()
  getDb().prepare(`DELETE FROM jellyfin_tokens WHERE token = ?`).run(token)
}

function requestUser(headers: Record<string, string | string[] | undefined>): AppUser | null {
  return resolveJellyfinUser(headers) ?? (authEnabled() ? null : fallbackUser())
}

function requireRequestUser(
  headers: Record<string, string | string[] | undefined>,
  reply: FastifyReply,
): AppUser | null {
  const user = requestUser(headers)
  if (!user) {
    reply.code(authEnabled() ? 401 : 503).send({ error: authEnabled() ? 'Unauthorized' : 'User auth is not configured.' })
    return null
  }
  return user
}

function pagedItems<T>(items: T[], offset: number, limit: number): T[] {
  if (limit <= 0) return []
  return items.slice(offset, offset + limit)
}

function compareEpisodeOrder(a: Pick<Episode, 'seasonNumber' | 'episodeNumber'>, b: Pick<Episode, 'seasonNumber' | 'episodeNumber'>): number {
  if (a.seasonNumber !== b.seasonNumber) return a.seasonNumber - b.seasonNumber
  return a.episodeNumber - b.episodeNumber
}

function isStremioErrorMeta(meta: StremioMeta): boolean {
  return stremioMetaName(meta).startsWith('[x]') || stremioMetaName(meta).startsWith('[❌]')
}

function stremioMetaTmdbId(meta: StremioMeta): number | null {
  if (!meta.id.startsWith('tmdb:')) return null
  const tmdbId = Number.parseInt(meta.id.slice(5), 10)
  return Number.isFinite(tmdbId) && tmdbId > 0 ? tmdbId : null
}

function stremioMetaImdbId(meta: StremioMeta): string {
  const imdbId = meta.imdb_id || meta.imdbId || (meta.id.startsWith('tt') ? meta.id : '')
  return /^tt\d+$/i.test(imdbId) ? imdbId : ''
}

function stremioMetaTvdbId(meta: StremioMeta): number | undefined {
  const raw = (meta as StremioMeta & { tvdb_id?: number | string; tvdbId?: number | string }).tvdb_id
    ?? (meta as StremioMeta & { tvdb_id?: number | string; tvdbId?: number | string }).tvdbId
  const tvdbId = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number.parseInt(raw, 10) : NaN
  return Number.isFinite(tvdbId) && tvdbId > 0 ? tvdbId : undefined
}

function stremioRatingCacheKey(meta: StremioMeta, mediaType: StremioMediaType): string {
  return `${mediaType}:${meta.id}:${stremioMetaImdbId(meta)}:${stremioMetaTmdbId(meta) ?? ''}:${stremioMetaTvdbId(meta) ?? ''}`
}

async function stremioOfficialRating(meta: StremioMeta, mediaType: StremioMediaType): Promise<string> {
  pruneStremioCaches()
  const key = stremioRatingCacheKey(meta, mediaType)
  const cached = stremioRatingCache.get(key)
  if (cached && cached.expiresAt > Date.now()) return cached.rating

  const tmdbId = stremioMetaTmdbId(meta)
  const imdbId = stremioMetaImdbId(meta)
  const rating = mediaType === 'movie'
    ? await fetchMovieOfficialRatingByIds({ tmdbId, imdbId })
    : await fetchShowOfficialRatingByIds({ tmdbId, imdbId, tvdbId: stremioMetaTvdbId(meta) })
  stremioRatingCache.set(key, { rating, expiresAt: Date.now() + STREMIO_SEARCH_CACHE_TTL_MS })
  trimCacheMap(stremioRatingCache, STREMIO_CACHE_MAX_ITEMS)
  return rating
}

async function canUserAccessStremioMeta(user: AppUser, meta: StremioMeta, mediaType: StremioMediaType): Promise<boolean> {
  if (!hasRatingLimit(user)) return true
  const rating = await stremioOfficialRating(meta, mediaType)
  return canUserAccessKnownRating(user.maxRating, rating)
}

async function stremioRatingForVisibleMeta(user: AppUser, meta: StremioMeta, mediaType: StremioMediaType): Promise<string> {
  if (!hasRatingLimit(user)) return ''
  return stremioOfficialRating(meta, mediaType)
}

function externalSearchEnabledForUser(user: AppUser): boolean {
  return config.stremioSearchEnabled && user.searchEnabled
}

function searchDisabledItem(includeTypes: string) {
  const type = includeTypes.includes('series') && !includeTypes.includes('movie') ? 'Series' : 'Movie'
  const isSeries = type === 'Series'
  return {
    Id:                 SEARCH_DISABLED_ITEM_ID,
    ServerId:           SERVER_GUID,
    Name:               'Fetcherr Search Disabled',
    SortName:           'fetcherr search disabled',
    Type:               type,
    MediaType:          'Video',
    VideoType:          'VideoFile',
    LocationType:       'FileSystem',
    PlayAccess:         'Full',
    IsPlayable:         true,
    CanDelete:          false,
    CanDownload:        false,
    Overview:           'Search must be enabled globally in Settings and for this Fetcherr user.',
    IsFolder:           isSeries,
    ChildCount:         isSeries ? 0 : undefined,
    RecursiveItemCount: isSeries ? 0 : undefined,
    RunTimeTicks:       SEARCH_DISABLED_RUNTIME_TICKS,
    Path:               '/fetcherr/search-disabled.mkv',
    ImageTags:          {},
    BackdropImageTags:  [],
    ProviderIds:        {},
    UserData:           userDataForItem(SEARCH_DISABLED_ITEM_ID, { played: false, playCount: 0, positionTicks: 0, lastPlayedDate: '' }),
  }
}

function searchDisabledMediaSource(origin: string) {
  return defaultPlaybackMediaSource(
    SEARCH_DISABLED_ITEM_ID,
    'Fetcherr Search Disabled',
    `${origin}/Videos/${SEARCH_DISABLED_ITEM_ID}/stream?PlaySessionId=fetcherr-${SEARCH_DISABLED_ITEM_ID}&MediaSourceId=${SEARCH_DISABLED_ITEM_ID}`,
    SEARCH_DISABLED_RUNTIME_TICKS,
  )
}

function searchDisabledPlaybackInfo(origin: string) {
  const mediaSources = [searchDisabledMediaSource(origin)]
  return {
    MediaSources: mediaSources,
    AlternateMediaSources: mediaSources,
    PlaySessionId: `fetcherr-${SEARCH_DISABLED_ITEM_ID}`,
  }
}

function withoutExcludedLocationTypes<T extends Record<string, unknown>>(
  items: T[],
  excludedLocationTypes: ReadonlySet<string>,
): T[] {
  if (!excludedLocationTypes.size) return items
  return items.filter(item => !excludedLocationTypes.has(String(item.LocationType ?? '').toLowerCase()))
}

function searchDisabledResponse(
  includeTypes: string,
  limit: number,
  offset: number,
  excludedLocationTypes: ReadonlySet<string>,
) {
  const items = withoutExcludedLocationTypes([searchDisabledItem(includeTypes)], excludedLocationTypes)
  return {
    Items: pagedItems(items, offset, limit),
    TotalRecordCount: items.length,
    StartIndex: offset,
  }
}

async function buildSearchResultItems(
  searchTerm: string,
  includeTypes: string,
  sortBy: string | undefined,
  sortOrder: string | undefined,
  limit: number,
  offset: number,
  user: AppUser,
  searchOnly = false,
  excludedLocationTypes: ReadonlySet<string> = new Set(),
) {
  const wantMovies = !includeTypes || includeTypes.includes('movie')
  const wantShows = !includeTypes || includeTypes.includes('series')
  const stremioTypes: StremioMediaType[] = [
    ...(wantMovies ? ['movie' as const] : []),
    ...(wantShows ? ['series' as const] : []),
  ]

  const localMovies = wantMovies
    ? filterMoviesForUser(user, listMovies({ search: searchTerm, sortBy, sortOrder, limit: 10_000, offset: 0, userId: user.id, ...apiLibraryFilter() }))
    : []
  const localShows = wantShows
    ? filterShowsForUser(user, listShows({ search: searchTerm, sortBy, sortOrder, limit: 10_000, offset: 0, userId: user.id, ...apiLibraryFilter() }))
    : []
  const externalSearchEnabled = externalSearchEnabledForUser(user)

  const rawStremioMetas = externalSearchEnabled && stremioTypes.length
    ? await (config.stremioSearchSource === 'trakt'
        ? searchTraktMetas(searchTerm, stremioTypes).catch(() => [])
        : searchStremioMetas(searchTerm, stremioTypes).catch(() => []))
    : []
  const stremioMetas = rawStremioMetas.filter(meta => !isStremioErrorMeta(meta))

  const localMovieIds = new Set(localMovies.map(movie => movie.tmdbId))
  const localShowIds = new Set(localShows.map(show => show.tmdbId))
  const localMovieImdbIds = new Set(localMovies.map(movie => movie.imdbId).filter(Boolean))
  const localShowImdbIds = new Set(localShows.map(show => show.imdbId).filter(Boolean))
  const stremioSearchMetas: StremioMeta[] = []
  for (const meta of stremioMetas) {
    const mediaType = String(meta.type ?? '').toLowerCase() as StremioMediaType
    if (mediaType !== 'movie' && mediaType !== 'series') continue
    const tmdbId = stremioMetaTmdbId(meta)
    const imdbId = stremioMetaImdbId(meta)
    if (mediaType === 'movie') {
      if (tmdbId && localMovieIds.has(tmdbId)) continue
      if (imdbId && localMovieImdbIds.has(imdbId)) continue
    } else {
      if (tmdbId && localShowIds.has(tmdbId)) continue
      if (imdbId && localShowImdbIds.has(imdbId)) continue
    }
    if (!await canUserAccessStremioMeta(user, meta, mediaType)) continue
    stremioSearchMetas.push(meta)
  }
  const stremioSearchItems = await Promise.all(stremioSearchMetas.map(async meta => {
    const mediaType = String(meta.type ?? 'movie').toLowerCase() === 'series' ? 'series' : 'movie'
    const hydrated = mediaType === 'series' ? await hydrateStremioSeriesMeta(meta) : meta
    const rating = await stremioRatingForVisibleMeta(user, meta, mediaType)
    const item = stremioSearchMetaToItem(hydrated, mediaType, undefined, { officialRating: rating }) as Record<string, unknown>
    return mediaType === 'movie' ? searchMovieAutoplayItem(item) : item
  }))

  const combined = withoutExcludedLocationTypes([
    ...localMovies.map(movie => searchMovieAutoplayItem(movieToSearchItem(movie) as Record<string, unknown>)),
    ...localShows.map(show => showToSeriesItem(show, user.id)),
    ...stremioSearchItems,
  ], excludedLocationTypes)

  if (searchOnly && !combined.length && !externalSearchEnabled) {
    return searchDisabledResponse(includeTypes, limit, offset, excludedLocationTypes)
  }

  return {
    Items: pagedItems(combined, offset, limit),
    TotalRecordCount: combined.length,
    StartIndex: offset,
  }
}

async function buildSimilarItems(itemId: string, user: AppUser, limit: number) {
  const movieTmdbId = idToSearchMovieTmdb(itemId) ?? idToTmdb(itemId)
  const showTmdbId = idToSearchShowTmdb(itemId) ?? idToShowTmdb(itemId)

  if (movieTmdbId) {
    const recIds = await fetchMovieRecommendations(movieTmdbId, limit)
    const movies = (await Promise.all(recIds.map(id => fetchMovieByTmdbId(id))))
      .filter((m): m is Movie => Boolean(m) && canUserAccessMovie(user, m as Movie))
    return movies.map(m => searchMovieAutoplayItem(movieToSearchItem(m) as Record<string, unknown>))
  }

  if (showTmdbId) {
    const recIds = await fetchShowRecommendations(showTmdbId, limit)
    const shows = (await Promise.all(recIds.map(id => fetchShowByTmdbId(id))))
      .filter((s): s is Show => Boolean(s) && canUserAccessShow(user, s as Show))
    return shows.map(s => showToSearchSeriesItem(s))
  }

  return []
}

function episodeRuntimeTicks(ep: Episode): number {
  return (ep.runtimeMins || 45) * 60 * 10_000_000
}

function meetsNextUpProgressThreshold(show: Show, ep: Episode, userId: string): boolean {
  const episodeId = episodeToId(show.tmdbId, ep.seasonNumber, ep.episodeNumber)
  const ud = getUserData(episodeId, userId)
  return !ud.played && ud.positionTicks > 0 && (ud.positionTicks / episodeRuntimeTicks(ep)) >= NEXT_UP_PROGRESS_THRESHOLD
}

function findNextUpEpisode(show: Show, playedIds: Set<string>, resumeIds: Set<string>, userId: string): Episode | null {
  const candidateEpisodes = visibleAiredEpisodesForShow(show)
  if (!candidateEpisodes.length) return null

  let anchorEpisode: Episode | null = null
  for (const ep of allAiredEpisodesForShow(show)) {
    const episodeId = episodeToId(show.tmdbId, ep.seasonNumber, ep.episodeNumber)
    if (!playedIds.has(episodeId) && !meetsNextUpProgressThreshold(show, ep, userId)) continue
    if (!anchorEpisode || compareEpisodeOrder(ep, anchorEpisode) > 0) {
      anchorEpisode = ep
    }
  }

  if (!anchorEpisode) return null

  for (const ep of candidateEpisodes) {
    if (compareEpisodeOrder(ep, anchorEpisode) <= 0) continue
    const episodeId = episodeToId(show.tmdbId, ep.seasonNumber, ep.episodeNumber)
    if (resumeIds.has(episodeId)) continue
    if (!playedIds.has(episodeId)) return ep
  }

  return null
}

function seasonToItem(season: Season, show: Show, userId = DEFAULT_ADMIN_USER_ID) {
  const seriesId = showTmdbToId(show.tmdbId)
  const id = seasonToId(show.tmdbId, season.seasonNumber)
  let ud = getUserData(id, userId)
  if (!ud.played) {
    const airedEps = getAiredEpisodesForSeason(show.tmdbId, season.seasonNumber)
    if (airedEps.length > 0) {
      let allPlayed = true
      let latestDate = ''
      for (const ep of airedEps) {
        const epId = episodeToId(show.tmdbId, ep.seasonNumber, ep.episodeNumber)
        const epUd = getUserData(epId, userId)
        if (!epUd.played) { allPlayed = false; break }
        if (epUd.lastPlayedDate > latestDate) latestDate = epUd.lastPlayedDate
      }
      if (allPlayed) ud = { played: true, playCount: 1, positionTicks: 0, lastPlayedDate: latestDate }
    }
  }
  return {
    Id:                 id,
    ServerId:           SERVER_GUID,
    SeriesId:           seriesId,
    SeriesName:         show.title,
    Name:               season.name || `Season ${season.seasonNumber}`,
    SortName:           `season ${season.seasonNumber.toString().padStart(4, '0')}`,
    Type:               'Season',
    LocationType:       'FileSystem',
    PlayAccess:         'Full',
    IsPlayable:         false,
    CanDelete:          false,
    CanDownload:        false,
    ProductionYear:     season.airDate ? parseInt(season.airDate.slice(0, 4)) : show.year,
    Overview:           season.overview,
    PremiereDate:       jellyfinPremiereDate(season.airDate),
    DateCreated:        season.syncedAt,
    IsFolder:           true,
    IndexNumber:        season.seasonNumber,
    ChildCount:         season.episodeCount,
    RecursiveItemCount: season.episodeCount,
    ImageTags:          season.posterPath ? { Primary: 'poster' } : {},
    PrimaryImageTag:    season.posterPath ? 'poster' : undefined,
    BackdropImageTags:  [],
    ParentId:           seriesId,
    UserData:           userDataForItem(id, ud),
  }
}

function episodeToItem(ep: Episode, show: Show, userId = DEFAULT_ADMIN_USER_ID) {
  const genres: string[] = JSON.parse(show.genres || '[]')
  const seriesId  = showTmdbToId(show.tmdbId)
  const seasonId  = seasonToId(show.tmdbId, ep.seasonNumber)
  const id        = episodeToId(show.tmdbId, ep.seasonNumber, ep.episodeNumber)
  const ud        = getUserData(id, userId)
  const runtimeTicks = (ep.runtimeMins || 45) * 60 * 10_000_000
  const safeShowTitle = show.title.replace(/[/\\:*?"<>|]/g, '')
  const safeEpisodeName = (ep.name || `Episode ${ep.episodeNumber}`).replace(/[/\\:*?"<>|]/g, '')
  const fakeFilename = `${safeShowTitle} - S${ep.seasonNumber.toString().padStart(2, '0')}E${ep.episodeNumber.toString().padStart(2, '0')} - ${safeEpisodeName}.mkv`
  const fakePath = `/shows/${safeShowTitle}/Season ${ep.seasonNumber}/${fakeFilename}`
  const showPosterTag = show.posterPath ? show.posterPath.replace(/\W/g, '').slice(0, 16) : undefined
  const showBackdropTag = show.backdropPath ? show.backdropPath.replace(/\W/g, '').slice(0, 16) : undefined
  const showLogoTag = show.logoPath ? show.logoPath.replace(/\W/g, '').slice(0, 16) : undefined
  const virtualMediaSources = virtualProfileMediaSources(id, runtimeTicks, Boolean(show.imdbId))
  return {
    Id:                    id,
    ServerId:              SERVER_GUID,
    SeriesId:              seriesId,
    SeriesName:            show.title,
    SeasonId:              seasonId,
    Name:                  ep.name || `Episode ${ep.episodeNumber}`,
    SortName:              `s${ep.seasonNumber.toString().padStart(4,'0')}e${ep.episodeNumber.toString().padStart(4,'0')}`,
    Type:                  'Episode',
    MediaType:             'Video',
    VideoType:             'VideoFile',
    LocationType:          'FileSystem',
    PlayAccess:            'Full',
    IsPlayable:            true,
    CanDelete:             false,
    CanDownload:           false,
    ProductionYear:        ep.airDate ? parseInt(ep.airDate.slice(0, 4)) : show.year,
    Overview:              ep.overview,
    Genres:                genres,
    GenreItems:            genreItems(genres),
    Studios:               null,
    Tags:                  null,
    OfficialRating:        undefined,
    CommunityRating:       ep.communityRating || undefined,
    ExternalUrls:          null,
    PremiereDate:          jellyfinPremiereDate(ep.airDate),
    DateCreated:           ep.airDate ? `${ep.airDate}T00:00:00Z` : ep.syncedAt,
    Etag:                  episodeItemEtag(ep, show),
    IsFolder:              false,
    IndexNumber:           ep.episodeNumber,
    ParentIndexNumber:     ep.seasonNumber,
    RunTimeTicks:          runtimeTicks,
    Path:                  fakePath,
    EnableMediaSourceDisplay: true,
    ...(virtualMediaSources.length ? {
      MediaSources: virtualMediaSources,
      AlternateMediaSources: virtualMediaSources,
      MediaSourceCount: virtualMediaSources.length,
    } : {}),
    ImageTags:             ep.stillPath ? { Primary: 'still' } : (showBackdropTag ? { Primary: showBackdropTag } : {}),
    PrimaryImageTag:       undefined,
    BackdropImageTags:     [],
    ParentId:              seasonId,
    SeriesPrimaryImageTag: showPosterTag,
    SeriesThumbImageTag:   showBackdropTag,
    SeasonPrimaryImageTag: undefined,
    ParentThumbItemId:     seriesId,
    ParentThumbImageTag:   showBackdropTag ?? showPosterTag,
    ParentBackdropItemId:  seriesId,
    ParentBackdropImageTags: showBackdropTag ? [showBackdropTag] : [],
    ParentLogoItemId:      showLogoTag ? seriesId : undefined,
    ParentLogoImageTag:    showLogoTag,
    UserData:              userDataForItem(id, ud, runtimeTicks),
  }
}

function createJellyfinToken(userId: string): string {
  purgeExpiredJellyfinTokens()
  const token = randomBytes(32).toString('hex')
  const expiresAt = Date.now() + JELLYFIN_TOKEN_TTL_MS
  jellyfinTokens.set(token, { userId, expiresAt })
  storeJellyfinToken(token, userId, expiresAt)
  return token
}

function tokenFromHeaderValue(value: string | string[] | undefined): string | null {
  const raw = firstHeaderValue(value)?.trim()
  if (!raw) return null
  if (!/[=,\s]/.test(raw)) return raw

  const tokenMatch = raw.match(/\bToken="?([^",\s]+)"?/i)
  if (tokenMatch) return tokenMatch[1]

  const bearerMatch = raw.match(/^Bearer\s+(.+)$/i)
  if (bearerMatch?.[1]) return bearerMatch[1].trim()

  return null
}

function parseJellyfinToken(headers: Record<string, string | string[] | undefined>): string | null {
  const directHeaders = [
    headers['x-emby-token'],
    headers['x-mediabrowser-token'],
    headers['x-emby-authorization'],
    headers['x-mediabrowser-authorization'],
    headers.authorization,
  ]

  for (const value of directHeaders) {
    const token = tokenFromHeaderValue(value)
    if (token) return token
  }

  return null
}

export function resolveJellyfinUser(headers: Record<string, string | string[] | undefined>): AppUser | null {
  const token = parseJellyfinToken(headers)
  if (!token) return null
  let record = jellyfinTokens.get(token)
  if (!record) {
    const persisted = loadJellyfinToken(token)
    if (persisted) {
      jellyfinTokens.set(token, persisted)
      record = persisted
    }
  }
  if (!record) return null
  if (record.expiresAt <= Date.now()) {
    jellyfinTokens.delete(token)
    deleteJellyfinToken(token)
    return null
  }
  return getUserById(record.userId)
}

function jellyfinUser(user: AppUser, serverId = SERVER_GUID, serverName = config.serverName) {
  return {
    Name:                  user.username,
    Id:                    user.id,
    ServerId:              serverId,
    ServerName:            serverName,
    PrimaryImageTag:       null,
    HasPassword:           true,
    HasConfiguredPassword: true,
    HasConfiguredEasyPassword: false,
    EnableAutoLogin:       false,
    Policy: {
      IsAdministrator: user.role === 'admin',
      EnableAllFolders: true,
      EnableMediaPlayback: true,
      AuthenticationProviderId: 'Jellyfin.Server.Implementations.Users.DefaultAuthenticationProvider',
      PasswordResetProviderId:   'Jellyfin.Server.Implementations.Users.DefaultPasswordResetProvider',
    },
  }
}

function jellyfinSessionInfo(user: AppUser, accessToken: string, serverId = SERVER_GUID, searchOnly = false) {
  const now = new Date().toISOString()
  const deviceSuffix = searchOnly ? '-search' : ''
  return {
    Id:              `${user.id}:${accessToken.slice(0, 12)}`,
    UserId:          user.id,
    UserName:        user.username,
    Client:          'Fetcherr',
    DeviceName:      searchOnly ? 'Fetcherr Search' : 'Fetcherr',
    DeviceType:      'Browser',
    DeviceId:        `fetcherr-${user.id}${deviceSuffix}`,
    AppName:         searchOnly ? 'Fetcherr Search' : 'Fetcherr',
    AppVersion:      '1.0.0',
    ApplicationVersion: '1.0.0',
    PlayableMediaTypes: ['Video'],
    SupportedCommands:  [],
    SupportsMediaControl: true,
    SupportsRemoteControl: true,
    HasCustomDeviceName:  false,
    IsActive:        true,
    LastActivityDate: now,
    LastPlaybackCheckIn: now,
    ServerId:        serverId,
    UserPrimaryImageTag: null,
    AdditionalUsers: [],
    NowPlayingQueue: [],
    NowPlayingQueueFullItems: [],
  }
}

function queryValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? ''
  return value ?? ''
}

function defaultPlaybackMediaSource(id: string, name: string, playUrl: string, runtimeTicks: number) {
  return {
    Id:                   id,
    Name:                 name,
    Type:                 'Default',
    Protocol:             'Http',
    Path:                 playUrl,
    IsRemote:             true,
    SupportsDirectPlay:   true,
    SupportsDirectStream: true,
    SupportsTranscoding:  false,
    RequiresOpening:      false,
    RequiresClosing:      false,
    Container:            'mkv',
    RunTimeTicks:         runtimeTicks,
    MediaStreams: [
      { Type: 'Video', Index: 0, Codec: 'h264', IsDefault: true },
      { Type: 'Audio', Index: 1, Codec: 'aac',  IsDefault: true, Language: 'eng' },
    ],
  }
}

async function playbackMediaSourcesFor(
  opts: JellyfinRouteOptions,
  input: {
    itemId: string
    sourceId: string
    origin: string
    playPath: string
    name: string
    runtimeTicks: number
    playbackClient: string
  },
) {
  if (config.mediaSourceSelection && opts.buildPlaybackMediaSources) {
    const sources = await opts.buildPlaybackMediaSources(input).catch(() => [])
    if (sources.length) return sources
  }
  return [defaultPlaybackMediaSource(
    input.sourceId,
    input.name,
    createSignedPlaybackUrl(input.origin, input.playPath),
    input.runtimeTicks,
  )]
}

function candidateTokenFromMediaSourceId(mediaSourceId: string | undefined): string | null {
  const match = mediaSourceId?.match(/:candidate:([0-9a-f]{32})$/i)
  return match?.[1] ?? null
}

function playbackProfileFromMediaSourceId(mediaSourceId: string | undefined, itemId?: string): PlaybackProfile | null {
  if (!mediaSourceId) return null
  if (itemId && !mediaSourceId.startsWith(`${itemId}:profile:`)) return null
  const match = mediaSourceId.match(/:profile:([^:]+)$/i)
  return playbackProfileForKey(match?.[1])
}

function signedPlaybackUrlForMediaSource(origin: string, playPath: string, mediaSourceId: string | undefined): string {
  const url = new URL(createSignedPlaybackUrl(origin, playPath))
  const candidate = candidateTokenFromMediaSourceId(mediaSourceId)
  if (candidate) url.searchParams.set('candidate', candidate)
  const profile = playbackProfileFromMediaSourceId(mediaSourceId)
  if (profile) url.searchParams.set('profile', profile.key)
  return url.toString()
}

// ── Route registration ────────────────────────────────────────────────────────

export async function jellyfinRoutes(app: FastifyInstance, opts: JellyfinRouteOptions = {}) {
  const routeServerId = opts.searchOnly ? SEARCH_SERVER_GUID : SERVER_GUID
  const routeServerName = () => opts.searchOnly ? `${config.serverName} Search` : config.serverName
  const emptyItems = (startIndex = 0) => ({ Items: [], TotalRecordCount: 0, StartIndex: startIndex })

  function routeServerPayload<T>(payload: T): T {
    if (!opts.searchOnly || payload == null || typeof payload !== 'object') return payload
    if (payload instanceof Uint8Array || payload instanceof ArrayBuffer) return payload
    if (Array.isArray(payload)) return payload.map(item => routeServerPayload(item)) as T
    const output: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
      if (key === 'ServerId' && value === SERVER_GUID) {
        output[key] = routeServerId
      } else if (key === 'ServerName' && value === config.serverName) {
        output[key] = routeServerName()
      } else {
        output[key] = routeServerPayload(value)
      }
    }
    return output as T
  }

  if (opts.searchOnly) {
    app.addHook('preSerialization', async (_req, _reply, payload) => routeServerPayload(payload))
  }

  function requireJellyfinUser(
    headers: Record<string, string | string[] | undefined>,
    reply: FastifyReply,
  ): AppUser | null {
    if (!authEnabled()) {
      reply.code(503).send({ error: 'User auth is not configured.' })
      return null
    }
    const user = requestUser(headers)
    if (!user) {
      reply.code(401).send({ error: 'Unauthorized' })
      return null
    }
    return user
  }

  // System info — probed before and after auth
  app.get('/System/Info',        async () => systemInfo())
  app.get('/System/Info/Public', async () => systemInfo())

  function systemInfo() {
    return {
      ServerName:             routeServerName(),
      Id:                     routeServerId,
      Version:                '10.11.0',
      ProductName:            'Jellyfin Server',
      OperatingSystem:        'Linux',
      StartupWizardCompleted: true,
    }
  }

  // Plugins/Packages — return empty lists
  app.get('/Plugins',  async () => ([]))
  app.get('/Packages', async () => ([]))

  // Branding / discovery — keep these lightweight for Jellyfin clients that probe them during startup
  app.get('/Branding/Splashscreen', async () => null)
  app.get('/Branding/Configuration', async () => ({}))
  app.get('/QuickConnect/Enabled', async () => false)

  // Display preferences — return minimal defaults
  app.get('/DisplayPreferences/:id', async () => ({
    Id:               'usersettings',
    SortBy:           'SortName',
    SortOrder:        'Ascending',
    RememberSorting:  false,
    RememberIndexing: false,
    ShowBackdrop:     true,
    ShowSidebar:      false,
    CustomPrefs:      {},
    Client:           'emby',
  }))

  // Auth — verify app user credentials for Jellyfin-compatible clients
  app.post('/Users/AuthenticateByName', async (req, reply) => {
    if (!authEnabled()) return reply.code(503).send({ error: 'User auth is not configured.' })
    const rateKey = clientIp(req.headers)
    const state = loginRateState(rateKey)
    if (state.count >= LOGIN_MAX_ATTEMPTS) {
      return reply.code(429).send({ error: 'Too many login attempts. Please try again later.' })
    }
    const body = req.body as Record<string, unknown> | undefined
    const username = bodyString(body, ['Username', 'UserName', 'username', 'Name', 'name']).trim()
    const password = bodyString(body, ['Pw', 'Password', 'password', 'Pass', 'pass'])
    const user = verifyUserCredentials(username, password)
    if (!user) {
      state.count += 1
      const existingUser = username ? getUserByUsername(username) : null
      const reason = !username
        ? 'missing username'
        : !existingUser
          ? 'unknown user'
          : !password
            ? 'missing password'
            : 'password mismatch'
      app.log.warn(
        `auth: Jellyfin login failed for ${username ? `"${username}"` : 'missing username'} from ${rateKey} (${reason})`
      )
      return reply.code(401).send({ error: 'Invalid credentials' })
    }
    loginAttempts.delete(rateKey)
    const accessToken = createJellyfinToken(user.id)
    return {
      AccessToken: accessToken,
      ServerId:    routeServerId,
      SessionInfo: jellyfinSessionInfo(user, accessToken, routeServerId, Boolean(opts.searchOnly)),
      User:        jellyfinUser(user, routeServerId, routeServerName()),
    }
  })

  // Public users — used by Jellyfin clients during login and server discovery
  app.get('/Users/Public', async () => listUsers().map(user => jellyfinUser(user, routeServerId, routeServerName())))

  // User profile
  app.get('/Users/:id', async (req, reply) => {
    const user = requireJellyfinUser(req.headers, reply)
    if (!user) return
    return jellyfinUser(user, routeServerId, routeServerName())
  })
  app.get('/Users/Me',  async (req, reply) => {
    const user = requireJellyfinUser(req.headers, reply)
    if (!user) return
    return jellyfinUser(user, routeServerId, routeServerName())
  })

  // Library sections
  app.get('/Library/VirtualFolders', async () => opts.searchOnly ? [] : ([
    { Name: 'Movies', CollectionType: 'movies', ItemId: MOVIES_FOLDER_ID, Locations: ['/movies'] },
    { Name: 'Shows',  CollectionType: 'tvshows', ItemId: SHOWS_FOLDER_ID,  Locations: ['/shows'] },
    ...(hasAnyCollections()
      ? [{ Name: 'Collections', CollectionType: 'boxsets', ItemId: COLLECTIONS_FOLDER_ID, Locations: ['/collections'] }]
      : []),
    ...config.traktLists.filter(slug => isTraktEntryVisible(slug)).map(slug => {
      const name = humanizeCollectionSlug(slug.split('/').pop() ?? slug)
      return { Name: name, CollectionType: 'boxsets', ItemId: traktFolderSlugToId(slug), Locations: [`/trakt/${slug}`] }
    }),
    ...config.mdblistLists.filter(entry => isMdblistEntryVisible(entry)).map(entry => {
      const p = mdblistListPathFromUrl(entry.url)
      return { Name: nameForMdblistUrl(entry.url), CollectionType: 'boxsets', ItemId: mdblistFolderIdFromPath(p), Locations: [`/mdblist/${p}`] }
    }),
    ...(isDiscoverFolderVisible()
      ? [{ Name: 'Discover', CollectionType: 'boxsets', ItemId: DISCOVER_FOLDER_ID, Locations: ['/discover'] }]
      : []),
  ]))
  app.get('/Library/SelectableMediaFolders', async () => null)

  // Grouping options
  app.get('/Users/:id/GroupingOptions', async () => opts.searchOnly ? [] : ([
    { Name: 'Movies', Id: MOVIES_FOLDER_ID, Type: 'movies' },
    { Name: 'Shows',  Id: SHOWS_FOLDER_ID,  Type: 'tvshows' },
    ...(hasAnyCollections() ? [{ Name: 'Collections', Id: COLLECTIONS_FOLDER_ID, Type: 'boxsets' }] : []),
    ...config.traktLists.filter(slug => isTraktEntryVisible(slug)).map(slug => ({
      Name: humanizeCollectionSlug(slug.split('/').pop() ?? slug), Id: traktFolderSlugToId(slug), Type: 'boxsets',
    })),
    ...config.mdblistLists.filter(entry => isMdblistEntryVisible(entry)).map(entry => {
      const p = mdblistListPathFromUrl(entry.url)
      return { Name: nameForMdblistUrl(entry.url), Id: mdblistFolderIdFromPath(p), Type: 'boxsets' }
    }),
    ...(isDiscoverFolderVisible() ? [{ Name: 'Discover', Id: DISCOVER_FOLDER_ID, Type: 'boxsets' }] : []),
  ]))
  app.get('/UserViews/GroupingOptions', async () => opts.searchOnly ? [] : ([
    { Name: 'Movies', Id: MOVIES_FOLDER_ID, Type: 'movies' },
    { Name: 'Shows',  Id: SHOWS_FOLDER_ID,  Type: 'tvshows' },
    ...(hasAnyCollections() ? [{ Name: 'Collections', Id: COLLECTIONS_FOLDER_ID, Type: 'boxsets' }] : []),
    ...config.traktLists.filter(slug => isTraktEntryVisible(slug)).map(slug => ({
      Name: humanizeCollectionSlug(slug.split('/').pop() ?? slug), Id: traktFolderSlugToId(slug), Type: 'boxsets',
    })),
    ...config.mdblistLists.filter(entry => isMdblistEntryVisible(entry)).map(entry => {
      const p = mdblistListPathFromUrl(entry.url)
      return { Name: nameForMdblistUrl(entry.url), Id: mdblistFolderIdFromPath(p), Type: 'boxsets' }
    }),
    ...(isDiscoverFolderVisible() ? [{ Name: 'Discover', Id: DISCOVER_FOLDER_ID, Type: 'boxsets' }] : []),
  ]))

  // Views — library sections
  function viewItemsResponse(user: AppUser) {
    if (opts.searchOnly) return emptyItems()
    const moviesCount = filterMoviesForUser(user, listMovies({ limit: 10_000, offset: 0, userId: user.id, ...apiLibraryFilter() })).length
    const showsCount = filterShowsForUser(user, listShows({ limit: 10_000, offset: 0, userId: user.id, ...apiLibraryFilter() })).length
    const items = [
      {
        Name:               'Movies',
        Id:                 MOVIES_FOLDER_ID,
        ServerId:           SERVER_GUID,
        Type:               'CollectionFolder',
        CollectionType:     'movies',
        ImageTags:          rootFolderImageTags(MOVIES_FOLDER_ID),
        IsFolder:           true,
        ChildCount:         moviesCount,
        RecursiveItemCount: moviesCount,
        UserData: { PlaybackPositionTicks: 0, PlayCount: 0, IsFavorite: false, Played: false, Key: MOVIES_FOLDER_ID },
      },
      {
        Name:               'Shows',
        Id:                 SHOWS_FOLDER_ID,
        ServerId:           SERVER_GUID,
        Type:               'CollectionFolder',
        CollectionType:     'tvshows',
        ImageTags:          rootFolderImageTags(SHOWS_FOLDER_ID),
        IsFolder:           true,
        ChildCount:         showsCount,
        RecursiveItemCount: showsCount,
        UserData: { PlaybackPositionTicks: 0, PlayCount: 0, IsFavorite: false, Played: false, Key: SHOWS_FOLDER_ID },
      },
      ...(hasAnyCollections() ? [traktCollectionsFolderToItem(user)] : []),
      ...config.traktLists.filter(slug => isTraktEntryVisible(slug)).map(slug => buildTraktFolderItem(slug, collectionMembersForUser(user, slug).length)),
      ...config.mdblistLists.filter(entry => isMdblistEntryVisible(entry)).map(entry => buildMdblistFolderItem(entry.url, mdblistFolderMembers(user, entry.url).length)),
      ...(isDiscoverFolderVisible() ? [buildDiscoverRootFolderItem(user)] : []),
    ]
    return {
      Items: items,
      TotalRecordCount: items.length,
      StartIndex: 0,
    }
  }

  app.get('/Users/:id/Views', async (req, reply) => {
    const user = requireJellyfinUser(req.headers, reply)
    if (!user) return
    return viewItemsResponse(user)
  })
  app.get('/UserViews', async (req, reply) => {
    const user = requireJellyfinUser(req.headers, reply)
    if (!user) return
    return viewItemsResponse(user)
  })

  // Browse + search — /Users/{id}/Items and /Items
  async function handleItems(
    req: { query: Record<string, string | string[] | undefined>; headers: Record<string, string | string[] | undefined> },
    reply: FastifyReply,
  ) {
    const user = requireRequestUser(req.headers, reply)
    if (!user) return
    // Infuse sends params in camelCase (parentId, sortBy, startIndex, limit).
    // Normalize to lowercase keys so we handle both cases transparently.
    const q: Record<string, string> = {}
    for (const [k, v] of Object.entries(req.query)) q[k.toLowerCase()] = queryValue(v)

    const SearchTerm      = q.searchterm || q.namestartswith
    const SortBy          = q.sortby
    const SortOrder       = q.sortorder
    const ParentId        = q.parentid
    const includeTypes    = (q.includeitemtypes ?? '').toLowerCase()
    const excludedLocationTypes = new Set(
      (q.excludelocationtypes ?? '')
        .split(',')
        .map(value => value.trim().toLowerCase())
        .filter(Boolean),
    )
    const limit           = q.limit ? parseInt(q.limit) : 10_000
    const offset          = parseInt(q.startindex ?? '0')

    if (opts.searchOnly && SearchTerm) {
      return buildSearchResultItems(SearchTerm, includeTypes, SortBy, SortOrder, limit, offset, user, true, excludedLocationTypes)
    }

    // ── Shows folder ───────────────────────────────────────────────────────────
    if (ParentId === SHOWS_FOLDER_ID) {
      if (opts.searchOnly) return emptyItems(offset)
      // Infuse scans the library with three separate recursive queries:
      // includeItemTypes=Season  → flat list of all seasons across all shows
      // includeItemTypes=Episode → flat list of all aired episodes across all shows
      // includeItemTypes=Series  → list of series (default)
      if (hasAnyCollections() && includeTypes.includes('boxset')) {
        const traktItems = traktCollectionItemsForUser(user)
        const mdblistItems = mdblistCollectionItems(user)
        const discoverItems = discoverCollectionItemsForUser(user)
        const collections = sortCollectionItems([...traktItems, ...mdblistItems, ...discoverItems], SortBy, SortOrder)
        return { Items: pagedItems(collections, offset, limit), TotalRecordCount: collections.length, StartIndex: offset }
      }
      if (includeTypes.includes('season')) {
        const allPairs = await withReadCache(`items:season-pairs:${user.id}`, async () => {
          const shows = filterShowsForUser(user, listShows({ limit: 100_000, userId: user.id, ...apiLibraryFilter() }))
          return shows.flatMap(show =>
            visibleSeasonsForShow(show).map(season => ({ show, season }))
          )
        })
        const total = allPairs.length
        if (limit <= 0) return { Items: [], TotalRecordCount: total, StartIndex: offset }
        const items = pagedItems(allPairs, offset, limit).map(({ show, season }) => seasonToItem(season, show, user.id))
        return { Items: items, TotalRecordCount: total, StartIndex: offset }
      }
      if (includeTypes.includes('episode')) {
        const allPairs = await withReadCache(`items:episode-pairs:${user.id}`, async () => {
          const shows = filterShowsForUser(user, listShows({ limit: 100_000, userId: user.id, ...apiLibraryFilter() }))
          return shows.flatMap(show =>
            visibleAiredEpisodesForShow(show).map(ep => ({ show, ep }))
          )
        })
        const total = allPairs.length
        if (limit <= 0) return { Items: [], TotalRecordCount: total, StartIndex: offset }
        const items = pagedItems(allPairs, offset, limit).map(({ show, ep }) => episodeToItem(ep, show, user.id))
        return { Items: items, TotalRecordCount: total, StartIndex: offset }
      }
      // Default: series list
      if (SearchTerm) {
        return buildSearchResultItems(SearchTerm, 'series', SortBy, SortOrder, limit, offset, user, false, excludedLocationTypes)
      }
      const allShows = filterShowsForUser(user, listShows({ search: SearchTerm, sortBy: SortBy, sortOrder: SortOrder, limit: 10_000, offset: 0, userId: user.id, ...apiLibraryFilter() }))
      return { Items: pagedItems(allShows, offset, limit).map(show => showToSeriesItem(show, user.id)), TotalRecordCount: allShows.length, StartIndex: offset }
    }

    const stremioSeries = ParentId ? idToStremioSearchMeta(ParentId) : null
    if (stremioSeries?.mediaType === 'series') {
      if (!await canUserAccessStremioMeta(user, stremioSeries.meta, 'series')) {
        return { Items: [], TotalRecordCount: 0, StartIndex: offset }
      }
      const seriesMeta = await hydrateStremioSeriesMeta(stremioSeries.meta)
      const visibleEpisodes = await visibleStremioEpisodes(seriesMeta)
      if (includeTypes.includes('episode')) {
        return {
          Items: pagedItems(visibleEpisodes, offset, limit).map(ep => stremioEpisodeToItem(seriesMeta, ep)),
          TotalRecordCount: visibleEpisodes.length,
          StartIndex: offset,
        }
      }
      const seasonNumbers = stremioSeriesSeasons(visibleEpisodes)
      return {
        Items: seasonNumbers.map(seasonNumber => stremioSeasonToItem(seriesMeta, seasonNumber)),
        TotalRecordCount: seasonNumbers.length,
        StartIndex: offset,
      }
    }

    const stremioSeasonRef = ParentId ? idToStremioSeason(ParentId) : null
    if (stremioSeasonRef) {
      if (!await canUserAccessStremioMeta(user, stremioSeasonRef.series, 'series')) {
        return { Items: [], TotalRecordCount: 0, StartIndex: offset }
      }
      const episodes = (await visibleStremioEpisodes(stremioSeasonRef.series))
        .filter(ep => stremioEpisodeSeasonNumber(ep) === stremioSeasonRef.seasonNumber)
      return {
        Items: pagedItems(episodes, offset, limit).map(ep => stremioEpisodeToItem(stremioSeasonRef.series, ep)),
        TotalRecordCount: episodes.length,
        StartIndex: offset,
      }
    }

    // ── Series ID: list seasons ────────────────────────────────────────────────
    const seriesRef = ParentId ? idToShowTmdb(ParentId) : null
    if (seriesRef) {
      if (isLibraryItemHidden('show', seriesRef)) return { Items: [], TotalRecordCount: 0, StartIndex: offset }
      const show = getShowByTmdbId(seriesRef) ?? await fetchShowByTmdbId(seriesRef)
      if (!show) return { Items: [], TotalRecordCount: 0, StartIndex: offset }
      if (!canUserAccessShow(user, show)) return { Items: [], TotalRecordCount: 0, StartIndex: offset }
      await ensureShowSeasonsCached(show).catch(() => {})
      const seasons = visibleSeasonsForShow(show)
      return { Items: seasons.map(s => seasonToItem(s, show, user.id)), TotalRecordCount: seasons.length, StartIndex: offset }
    }

    // ── Season ID: list episodes ───────────────────────────────────────────────
    const seasonRef = ParentId ? idToSeason(ParentId) : null
    if (seasonRef) {
      if (isLibraryItemHidden('show', seasonRef.showTmdbId)) return { Items: [], TotalRecordCount: 0, StartIndex: offset }
      const show = getShowByTmdbId(seasonRef.showTmdbId) ?? await fetchShowByTmdbId(seasonRef.showTmdbId)
      if (!show) return { Items: [], TotalRecordCount: 0, StartIndex: offset }
      if (!canUserAccessShow(user, show)) return { Items: [], TotalRecordCount: 0, StartIndex: offset }
      if (!getEpisodesForSeason(show.tmdbId, seasonRef.seasonNum).length) {
        await fetchAndCacheSeasonDetails(show.tmdbId, seasonRef.seasonNum).catch(() => {})
      }
      const visibleSeasonNums = new Set(visibleSeasonsForShow(show).map(s => s.seasonNumber))
      const episodes = visibleSeasonNums.has(seasonRef.seasonNum)
        ? getAiredEpisodesForSeason(show.tmdbId, seasonRef.seasonNum)
        : []
      return { Items: episodes.map(e => episodeToItem(e, show, user.id)), TotalRecordCount: episodes.length, StartIndex: offset }
    }

    if (opts.searchOnly) return emptyItems(offset)

    const mdblistUrl = mdblistFolderUrlForId(ParentId)
    if (mdblistUrl) {
      const items = await mdblistFolderContents(mdblistUrl, user, SortBy, SortOrder)
      return { Items: pagedItems(items, offset, limit), TotalRecordCount: items.length, StartIndex: offset }
    }
    const mdblistCollectionUrl = mdblistCollectionUrlForId(ParentId)
    if (mdblistCollectionUrl) {
      const items = await mdblistFolderContents(mdblistCollectionUrl, user, SortBy, SortOrder)
      return { Items: pagedItems(items, offset, limit), TotalRecordCount: items.length, StartIndex: offset }
    }

    const folderSlug = ParentId ? idToTraktFolderSlug(ParentId) : null
    if (folderSlug && isTraktEntryVisible(folderSlug)) {
      const items = await traktCollectionContents(folderSlug, user)
      return { Items: pagedItems(items, offset, limit), TotalRecordCount: items.length, StartIndex: offset }
    }
    const collectionSlug = ParentId ? idToTraktCollectionSlug(ParentId) : null
    if (collectionSlug && isTraktEntryCollection(collectionSlug)) {
      const items = await traktCollectionContents(collectionSlug, user)
      return { Items: pagedItems(items, offset, limit), TotalRecordCount: items.length, StartIndex: offset }
    }

    if (ParentId === DISCOVER_FOLDER_ID && isDiscoverFolderVisible()) {
      const items = discoverFolderItemsForUser(user)
      return { Items: pagedItems(items, offset, limit), TotalRecordCount: items.length, StartIndex: offset }
    }
    const discoverFolderSlug = idToDiscoverFolderSlug(ParentId)
    if (discoverFolderSlug) {
      const items = await discoverCategoryContents(discoverFolderSlug, user)
      return { Items: pagedItems(items, offset, limit), TotalRecordCount: items.length, StartIndex: offset }
    }
    const discoverCollectionSlug = idToDiscoverCollectionSlug(ParentId)
    if (discoverCollectionSlug) {
      const items = await discoverCategoryContents(discoverCollectionSlug, user)
      return { Items: pagedItems(items, offset, limit), TotalRecordCount: items.length, StartIndex: offset }
    }

    if (ParentId === COLLECTIONS_FOLDER_ID && hasAnyCollections()) {
      const traktItems = traktCollectionItemsForUser(user)
      const mdblistItems = mdblistCollectionItems(user)
      const discoverItems = discoverCollectionItemsForUser(user)
      const collections = sortCollectionItems([...traktItems, ...mdblistItems, ...discoverItems], SortBy, SortOrder)
      return { Items: pagedItems(collections, offset, limit), TotalRecordCount: collections.length, StartIndex: offset }
    }

    if (
      hasAnyCollections() &&
      includeTypes.includes('boxset') &&
      (!ParentId || ParentId === MOVIES_FOLDER_ID || ParentId === SHOWS_FOLDER_ID)
    ) {
      const traktItems = traktCollectionItemsForUser(user)
      const mdblistItems = mdblistCollectionItems(user)
      const discoverItems = discoverCollectionItemsForUser(user)
      const collections = sortCollectionItems([...traktItems, ...mdblistItems, ...discoverItems], SortBy, SortOrder)
      return { Items: pagedItems(collections, offset, limit), TotalRecordCount: collections.length, StartIndex: offset }
    }

    // ── Search: movies + shows ─────────────────────────────────────────────────
    if (SearchTerm) {
      return buildSearchResultItems(SearchTerm, includeTypes, SortBy, SortOrder, limit, offset, user, false, excludedLocationTypes)
    }

    // ── No parentId: route by includeItemTypes or return folders ─────────────
    if (!ParentId) {
      // Infuse main page "TV Shows" calls Items?includeItemTypes=Series&recursive=true
      if (includeTypes.includes('series')) {
        const shows = filterShowsForUser(user, listShows({ search: SearchTerm, sortBy: SortBy, sortOrder: SortOrder, limit: 10_000, offset: 0, userId: user.id, ...apiLibraryFilter() }))
        return { Items: pagedItems(shows, offset, limit).map(show => showToSeriesItem(show, user.id)), TotalRecordCount: shows.length, StartIndex: offset }
      }
      // Infuse main page "Movies" calls Items?includeItemTypes=Movie&recursive=true
      if (includeTypes.includes('movie')) {
        const movies = filterMoviesForUser(user, listMovies({ search: SearchTerm, sortBy: SortBy, sortOrder: SortOrder, limit: 10_000, offset: 0, userId: user.id, ...apiLibraryFilter() }))
        return { Items: pagedItems(movies, offset, limit).map(movie => movieToItem(movie, user.id)), TotalRecordCount: movies.length, StartIndex: offset }
      }
      // True root listing: return collection folders
      const nMovies = filterMoviesForUser(user, listMovies({ limit: 10_000, offset: 0, userId: user.id, ...apiLibraryFilter() })).length
      const nShows  = filterShowsForUser(user, listShows({ limit: 10_000, offset: 0, userId: user.id, ...apiLibraryFilter() })).length
      const folders = [
        {
          Id: MOVIES_FOLDER_ID, ServerId: SERVER_GUID, Name: 'Movies',
          Type: 'CollectionFolder', CollectionType: 'movies', IsFolder: true,
          ChildCount: nMovies, RecursiveItemCount: nMovies, ImageTags: rootFolderImageTags(MOVIES_FOLDER_ID),
          UserData: { PlaybackPositionTicks: 0, PlayCount: 0, IsFavorite: false, Played: false, Key: MOVIES_FOLDER_ID },
        },
        {
          Id: SHOWS_FOLDER_ID, ServerId: SERVER_GUID, Name: 'Shows',
          Type: 'CollectionFolder', CollectionType: 'tvshows', IsFolder: true,
          ChildCount: nShows, RecursiveItemCount: nShows, ImageTags: rootFolderImageTags(SHOWS_FOLDER_ID),
          UserData: { PlaybackPositionTicks: 0, PlayCount: 0, IsFavorite: false, Played: false, Key: SHOWS_FOLDER_ID },
        },
        ...(hasAnyCollections() ? [traktCollectionsFolderToItem(user)] : []),
        ...config.traktLists.filter(slug => isTraktEntryVisible(slug)).map(slug => buildTraktFolderItem(slug, collectionMembersForUser(user, slug).length)),
        ...config.mdblistLists.filter(entry => isMdblistEntryVisible(entry)).map(entry => buildMdblistFolderItem(entry.url, mdblistFolderMembers(user, entry.url).length)),
        ...(isDiscoverFolderVisible() ? [buildDiscoverRootFolderItem(user)] : []),
      ]
      return {
        Items: folders,
        TotalRecordCount: folders.length,
        StartIndex: offset,
      }
    }

    // ── Movies folder: list movies (Season/Episode queries return empty) ──────
    if (includeTypes.includes('season') || includeTypes.includes('episode')) {
      return { Items: [], TotalRecordCount: 0, StartIndex: offset }
    }
    if (SearchTerm) {
      return buildSearchResultItems(SearchTerm, 'movie', SortBy, SortOrder, limit, offset, user, false, excludedLocationTypes)
    }
    const movies = filterMoviesForUser(user, listMovies({ search: SearchTerm, sortBy: SortBy, sortOrder: SortOrder, limit: 10_000, offset: 0, userId: user.id, ...apiLibraryFilter() }))
    return { Items: pagedItems(movies, offset, limit).map(movie => movieToItem(movie, user.id)), TotalRecordCount: movies.length, StartIndex: offset }
  }

  app.get('/Items',           async (req, reply) => handleItems(req as never, reply as never))
  app.get('/Users/:id/Items', async (req, reply) => handleItems(req as never, reply as never))

  async function handleSearchHints(
    req: { query: Record<string, string>; headers: Record<string, string | string[] | undefined> },
    reply: FastifyReply,
  ) {
    const user = requireRequestUser(req.headers, reply)
    if (!user) return
    const q: Record<string, string> = {}
    for (const [k, v] of Object.entries(req.query)) q[k.toLowerCase()] = v

    const SearchTerm = q.searchterm ?? q.term ?? ''
    const includeTypes = (q.includeitemtypes ?? '').toLowerCase()
    const limit = q.limit ? parseInt(q.limit, 10) : 20
    const offset = parseInt(q.startindex ?? '0', 10)

    if (!SearchTerm.trim()) {
      return { SearchHints: [], TotalRecordCount: 0 }
    }

    const results = await buildSearchResultItems(SearchTerm, includeTypes, undefined, undefined, 10_000, 0, user)
    const hints = results.Items.map(item => {
      const typed = item as Record<string, unknown>
      return {
        ItemId: typed.Id,
        Id: typed.Id,
        Name: typed.Name,
        ProductionYear: typed.ProductionYear,
        PrimaryImageTag: (typed.ImageTags as Record<string, unknown> | undefined)?.Primary,
        BackdropImageTag: (typed.BackdropImageTags as string[] | undefined)?.[0],
        BackdropImageItemId: typed.Id,
        Type: typed.Type,
        RunTimeTicks: typed.RunTimeTicks,
        MediaType: typed.MediaType,
        Artists: [],
        ChannelId: null,
        PrimaryImageAspectRatio: typed.PrimaryImageAspectRatio,
      }
    })

    return {
      SearchHints: pagedItems(hints, offset, limit),
      TotalRecordCount: hints.length,
    }
  }

  app.get('/Search/Hints', async (req, reply) => handleSearchHints(req as never, reply as never))
  app.get('/Users/:id/Search/Hints', async (req, reply) => handleSearchHints(req as never, reply as never))

  function emptyLibraryResult(req: { query?: Record<string, string> }) {
    const startIndexRaw = req.query?.startindex ?? req.query?.StartIndex ?? '0'
    const startIndex = Number.parseInt(String(startIndexRaw), 10)
    return {
      Items: [],
      TotalRecordCount: 0,
      StartIndex: Number.isFinite(startIndex) ? startIndex : 0,
    }
  }

  app.get('/Persons', async (req) => emptyLibraryResult(req as never))
  app.get('/Users/:id/Persons', async (req) => emptyLibraryResult(req as never))
  app.get('/Artists', async (req) => emptyLibraryResult(req as never))
  app.get('/Users/:id/Artists', async (req) => emptyLibraryResult(req as never))
  app.get('/Artists/AlbumArtists', async (req) => emptyLibraryResult(req as never))
  app.get('/Users/:id/Artists/AlbumArtists', async (req) => emptyLibraryResult(req as never))
  app.get('/Genres', async (req) => emptyLibraryResult(req as never))
  app.get('/Users/:id/Genres', async (req) => emptyLibraryResult(req as never))
  app.get('/Studios', async (req) => emptyLibraryResult(req as never))
  app.get('/Users/:id/Studios', async (req) => emptyLibraryResult(req as never))

  app.get('/Shows/NextUp', async (req, reply) => {
    const user = requireRequestUser(req.headers, reply as never)
    if (!user) return
    const rawQuery = (req as never as { query: Record<string, string> }).query
    const q: Record<string, string> = {}
    for (const [k, v] of Object.entries(rawQuery)) q[k.toLowerCase()] = v
    const limit = parseInt(q.limit ?? '16', 10)
    const offset = parseInt(q.startindex ?? '0', 10)
    if (opts.searchOnly) return emptyItems(offset)
    const seriesTmdbId = q.seriesid ? idToShowTmdb(q.seriesid) : null
    const allNextUp = await withReadCache(`nextup:${user.id}`, async () => {
      const playedIds = getAllPlayedItemIds(user.id)
      const resumeIds = new Set(listResumeItemIds(10_000, 0, user.id))
      return filterShowsForUser(user, listShows({ limit: 100_000, userId: user.id, ...apiLibraryFilter() }))
        .map(show => {
          const ep = findNextUpEpisode(show, playedIds, resumeIds, user.id)
          return ep ? { show, ep } : null
        })
        .filter((value): value is { show: Show; ep: Episode } => value !== null)
        .sort((a, b) => {
          const aDate = a.ep.airDate || ''
          const bDate = b.ep.airDate || ''
          if (aDate !== bDate) return bDate.localeCompare(aDate)
          return a.show.title.localeCompare(b.show.title)
        })
    })

    const nextUpItems = seriesTmdbId
      ? allNextUp.filter(({ show }) => show.tmdbId === seriesTmdbId)
      : allNextUp
    const paged = nextUpItems.slice(offset, offset + limit)
    return {
      Items: paged.map(({ show, ep }) => episodeToItem(ep, show, user.id)),
      TotalRecordCount: nextUpItems.length,
      StartIndex: offset,
    }
  })

  // Resume / Continue Watching
  async function handleResumeItems(
    req: { query: Record<string, string>; headers: Record<string, string | string[] | undefined> },
    reply: FastifyReply,
  ) {
    const user = requireRequestUser(req.headers, reply)
    if (!user) return
    const q: Record<string, string> = {}
    for (const [k, v] of Object.entries(req.query)) q[k.toLowerCase()] = v
    const limit = q.limit ? parseInt(q.limit, 10) : 50
    const offset = q.startindex ? parseInt(q.startindex, 10) : 0
    if (opts.searchOnly) return emptyItems(offset)
    return withReadCache(`resume:${user.id}:${offset}:${limit}`, async () => {
      const ids = listResumeItemIds(limit, offset, user.id)
      const items = []
      for (const id of ids) {
        const item = await handleItem(id, {
          code: () => ({ send: () => null }),
        }, user)
        if (
          item &&
          typeof item === 'object' &&
          (item as Record<string, unknown>).Type !== 'Season' &&
          (item as Record<string, unknown>).Type !== 'Series'
        ) {
          items.push(item)
        }
      }
      return { Items: items, TotalRecordCount: countResumeItems(user.id), StartIndex: offset }
    })
  }
  app.get('/Users/:id/Items/Resume', async (req, reply) => handleResumeItems(req as never, reply as never))
  app.get('/UserItems/Resume', async (req, reply) => handleResumeItems(req as never, reply as never))

  // Latest / Recently Added
  app.get('/Users/:id/Items/Latest', async (req, reply) => {
    const user = requireRequestUser(req.headers, reply as never)
    if (!user) return
    const rawQuery = (req as never as { query: Record<string, string> }).query
    const q: Record<string, string> = {}
    for (const [k, v] of Object.entries(rawQuery)) q[k.toLowerCase()] = v
    const lim      = parseInt(q.limit ?? '16')
    const parentId = q.parentid
    if (opts.searchOnly) return []

    if (parentId === SHOWS_FOLDER_ID) {
      const shows = filterShowsForUser(user, listShows({ sortBy: 'dateadded', sortOrder: 'DESC', limit: lim, userId: user.id, ...apiLibraryFilter() }))
      const items: Record<string, unknown>[] = []
      for (const show of shows) {
        const ep = getFirstEpisodeOfFirstUnplayedSeason(show, user.id)
        if (ep) items.push({ ...episodeToItem(ep, show, user.id), DateCreated: show.syncedAt })
      }
      return items
    }
    return filterMoviesForUser(user, listMovies({ sortBy: 'dateadded', sortOrder: 'DESC', limit: lim, userId: user.id, ...apiLibraryFilter() })).map(movie => movieToItem(movie, user.id))
  })

  // Single item — /Items/:id and /Users/:userId/Items/:itemId
  async function addDetailMediaSources(
    item: Record<string, unknown>,
    headers: Record<string, string | string[] | undefined> | undefined,
    input: {
      itemId: string
      sourceId: string
      playPath: string
      name: string
      runtimeTicks: number
    },
  ) {
    if (!headers) return item
    const normalizedHeaders = Object.fromEntries(
      Object.entries(headers).map(([key, value]) => [key, Array.isArray(value) ? value[0] ?? '' : value ?? '']),
    )
    const mediaSources = await playbackMediaSourcesFor(opts, {
      ...input,
      origin: buildPlaybackOrigin(normalizedHeaders),
      playbackClient: playbackClientFromHeaders(headers),
    })
    return {
      ...item,
      MediaSources: mediaSources,
      AlternateMediaSources: mediaSources,
      MediaSourceCount: mediaSources.length,
    }
  }

  async function addMovieDetailMediaSources(
    item: Record<string, unknown>,
    headers: Record<string, string | string[] | undefined> | undefined,
    input: {
      itemId: string
      sourceId: string
      imdbId: string
      name: string
      runtimeTicks: number
    },
  ) {
    return addDetailMediaSources(item, headers, {
      itemId: input.itemId,
      sourceId: input.sourceId,
      playPath: `/play/${input.imdbId}`,
      name: input.name,
      runtimeTicks: input.runtimeTicks,
    })
  }

  async function addStremioMovieDetailMediaSources(
    item: Record<string, unknown>,
    headers: Record<string, string | string[] | undefined> | undefined,
    input: {
      itemId: string
      sourceId: string
      externalId: string
      name: string
      runtimeTicks: number
    },
  ) {
    return addDetailMediaSources(item, headers, {
      itemId: input.itemId,
      sourceId: input.sourceId,
      playPath: `/play/stremio/movie/${encodeURIComponent(input.externalId)}`,
      name: input.name,
      runtimeTicks: input.runtimeTicks,
    })
  }

  async function handleItem(
    id: string,
    reply: { code: (n: number) => { send: (v: unknown) => unknown } },
    user?: AppUser | null,
    headers?: Record<string, string | string[] | undefined>,
  ) {
    const currentUser = user === undefined ? fallbackUser() : user
    if (!currentUser) return reply.code(401).send({ error: 'Unauthorized' })
    if (id === SEARCH_DISABLED_ITEM_ID) {
      return searchDisabledItem('')
    }
    // Collection folders
    if (id === MOVIES_FOLDER_ID) {
      const n = filterMoviesForUser(currentUser, listMovies({ limit: 10_000, offset: 0, userId: currentUser.id, ...apiLibraryFilter() })).length
      return { Name: 'Movies', Id: MOVIES_FOLDER_ID, ServerId: SERVER_GUID,
        Type: 'CollectionFolder', CollectionType: 'movies', IsFolder: true, Path: '/movies',
        RecursiveItemCount: n, ChildCount: n, ImageTags: rootFolderImageTags(MOVIES_FOLDER_ID),
        UserData: { PlaybackPositionTicks: 0, PlayCount: 0, IsFavorite: false, Played: false, Key: MOVIES_FOLDER_ID } }
    }
    if (id === SHOWS_FOLDER_ID) {
      const n = filterShowsForUser(currentUser, listShows({ limit: 10_000, offset: 0, userId: currentUser.id, ...apiLibraryFilter() })).length
      return { Name: 'Shows', Id: SHOWS_FOLDER_ID, ServerId: SERVER_GUID,
        Type: 'CollectionFolder', CollectionType: 'tvshows', IsFolder: true, Path: '/shows',
        RecursiveItemCount: n, ChildCount: n, ImageTags: rootFolderImageTags(SHOWS_FOLDER_ID),
        UserData: { PlaybackPositionTicks: 0, PlayCount: 0, IsFavorite: false, Played: false, Key: SHOWS_FOLDER_ID } }
    }
    if (id === COLLECTIONS_FOLDER_ID && hasAnyCollections()) {
      return traktCollectionsFolderToItem(currentUser)
    }
    if (id === DISCOVER_FOLDER_ID && isDiscoverFolderVisible()) {
      return buildDiscoverRootFolderItem(currentUser)
    }
    const discoverFolderSlugForId = idToDiscoverFolderSlug(id)
    if (discoverFolderSlugForId) {
      const def = DISCOVER_CATEGORIES.find(d => d.slug === discoverFolderSlugForId)!
      return buildDiscoverCategoryFolderItem(def, discoverCategoryMembers(currentUser, def.slug).length)
    }
    const discoverCollectionSlugForId = idToDiscoverCollectionSlug(id)
    if (discoverCollectionSlugForId) {
      const def = DISCOVER_CATEGORIES.find(d => d.slug === discoverCollectionSlugForId)!
      return buildDiscoverCategoryCollectionItem(def, discoverCategoryMembers(currentUser, def.slug).length)
    }

    const folderSlug = idToTraktFolderSlug(id)
    if (folderSlug && isTraktEntryVisible(folderSlug)) {
      return buildTraktFolderItem(folderSlug, collectionMembersForUser(currentUser, folderSlug).length)
    }
    const collectionSlug = idToTraktCollectionSlug(id)
    if (collectionSlug && isTraktEntryCollection(collectionSlug)) {
      return traktCollectionToItem(collectionSlug, currentUser)
    }

    const mdblistCollectionUrl = mdblistCollectionUrlForId(id)
    if (mdblistCollectionUrl) {
      const entry = config.mdblistLists.find(e => e.url === mdblistCollectionUrl)
      if (entry) return buildMdblistCollectionItem(entry, mdblistFolderMembers(currentUser, mdblistCollectionUrl).length)
    }

    const mdblistUrl = mdblistFolderUrlForId(id)
    if (mdblistUrl) {
      return buildMdblistFolderItem(mdblistUrl, mdblistFolderMembers(currentUser, mdblistUrl).length)
    }

    const stremioEpisode = idToStremioEpisode(id)
    if (stremioEpisode) {
      if (!await canUserAccessStremioMeta(currentUser, stremioEpisode.series, 'series')) return reply.code(404).send({ error: 'Not found' })
      const item = stremioEpisodeToItem(stremioEpisode.series, stremioEpisode.episode) as Record<string, unknown>
      const { series, episode } = stremioEpisode
      const externalId = episode.id || `${series.id}:${stremioEpisodeSeasonNumber(episode)}:${stremioEpisodeNumber(episode)}`
      const playPath = `/play/stremio/series/${encodeURIComponent(externalId)}`
      const name = `${stremioMetaName(series)} - ${stremioMetaName(episode)}`
      return addDetailMediaSources(item, headers, {
        itemId: id,
        sourceId: id,
        playPath,
        name,
        runtimeTicks: stremioRuntimeTicks(episode, 45),
      })
    }

    const stremioSeason = idToStremioSeason(id)
    if (stremioSeason) {
      if (!await canUserAccessStremioMeta(currentUser, stremioSeason.series, 'series')) return reply.code(404).send({ error: 'Not found' })
      return stremioSeasonToItem(stremioSeason.series, stremioSeason.seasonNumber)
    }

    const stremioSearch = idToStremioSearchMeta(id)
    if (stremioSearch) {
      if (!await canUserAccessStremioMeta(currentUser, stremioSearch.meta, stremioSearch.mediaType)) return reply.code(404).send({ error: 'Not found' })
      const rating = await stremioRatingForVisibleMeta(currentUser, stremioSearch.meta, stremioSearch.mediaType)
      const meta = stremioSearch.mediaType === 'series'
        ? await hydrateStremioSeriesMeta(stremioSearch.meta)
        : stremioSearch.meta
      const item = stremioSearchMetaToItem(meta, stremioSearch.mediaType, stremioSearch.requestedId, { officialRating: rating }) as Record<string, unknown>
      if (stremioSearch.mediaType !== 'movie') return item
      const movieItem = searchMovieAutoplayItem(item)
      const externalId = meta.imdb_id || meta.imdbId || meta.id
      return addStremioMovieDetailMediaSources(movieItem, headers, {
        itemId: stremioSearch.requestedId,
        sourceId: stremioSearch.sourceId,
        externalId,
        name: stremioMetaName(meta),
        runtimeTicks: stremioRuntimeTicks(meta, 90),
      })
    }

    // Episode
    const epRef = idToEpisode(id)
    if (epRef) {
      if (isLibraryItemHidden('show', epRef.showTmdbId)) return reply.code(404).send({ error: 'Not found' })
      const show = getShowByTmdbId(epRef.showTmdbId) ?? await fetchShowByTmdbId(epRef.showTmdbId)
      if (!show) return reply.code(404).send({ error: 'Not found' })
      if (!canUserAccessShow(currentUser, show)) return reply.code(404).send({ error: 'Not found' })
      let [ep] = getEpisodesForSeason(show.tmdbId, epRef.seasonNum)
        .filter(e => e.episodeNumber === epRef.episodeNum)
      if (!ep) {
        const eps = await fetchAndCacheSeasonDetails(show.tmdbId, epRef.seasonNum).catch(() => [])
        ep = eps.find(e => e.episodeNumber === epRef.episodeNum)!
      }
      if (!ep) return reply.code(404).send({ error: 'Not found' })
      if (!isEpisodeVisibleToLibrary(ep)) return reply.code(404).send({ error: 'Not found' })
      const item = episodeToItem(ep, show, currentUser.id) as Record<string, unknown>
      if (!show.imdbId) return item
      const playPath = `/play/${show.imdbId}/${ep.seasonNumber}/${ep.episodeNumber}`
      return addDetailMediaSources(item, headers, {
        itemId: id,
        sourceId: id,
        playPath,
        name: `${show.title} - ${ep.name || `S${ep.seasonNumber}E${ep.episodeNumber}`}`,
        runtimeTicks: (ep.runtimeMins || 45) * 60 * 10_000_000,
      })
    }

    // Season
    const seasonRef = idToSeason(id)
    if (seasonRef) {
      if (isLibraryItemHidden('show', seasonRef.showTmdbId)) return reply.code(404).send({ error: 'Not found' })
      const show = getShowByTmdbId(seasonRef.showTmdbId) ?? await fetchShowByTmdbId(seasonRef.showTmdbId)
      if (!show) return reply.code(404).send({ error: 'Not found' })
      if (!canUserAccessShow(currentUser, show)) return reply.code(404).send({ error: 'Not found' })
      let season = getSeason(show.tmdbId, seasonRef.seasonNum)
      if (!season) {
        await fetchAndCacheSeasonDetails(show.tmdbId, seasonRef.seasonNum).catch(() => {})
        season = getSeason(show.tmdbId, seasonRef.seasonNum)
      }
      if (!season) return reply.code(404).send({ error: 'Not found' })
      return seasonToItem(season, show, currentUser.id)
    }

    // Series
    const searchShowTmdbId = idToSearchShowTmdb(id)
    if (searchShowTmdbId) {
      const show = await fetchShowByTmdbId(searchShowTmdbId)
      if (!show) return reply.code(404).send({ error: 'Not found' })
      if (!canUserAccessShow(currentUser, show)) return reply.code(404).send({ error: 'Not found' })
      return showToSearchSeriesItem(show)
    }

    const showTmdbId = idToShowTmdb(id)
    if (showTmdbId) {
      if (isLibraryItemHidden('show', showTmdbId)) return reply.code(404).send({ error: 'Not found' })
      const show = getShowByTmdbId(showTmdbId) ?? await fetchShowByTmdbId(showTmdbId)
      if (!show) return reply.code(404).send({ error: 'Not found' })
      if (!canUserAccessShow(currentUser, show)) return reply.code(404).send({ error: 'Not found' })
      return showToSeriesItem(show, currentUser.id)
    }

    // Movie
    const searchMovieTmdbId = idToSearchMovieTmdb(id)
    if (searchMovieTmdbId) {
      const movie = await fetchMovieByTmdbId(searchMovieTmdbId)
      if (!movie) return reply.code(404).send({ error: 'Not found' })
      if (!canUserAccessMovie(currentUser, movie)) return reply.code(404).send({ error: 'Not found' })
      const item = movieToSearchItem(movie) as Record<string, unknown>
      const movieItem = searchMovieAutoplayItem(item)
      if (!movie.imdbId || !isMovieVisibleToLibrary(movie)) return movieItem
      return addMovieDetailMediaSources(movieItem, headers, {
        itemId: id,
        sourceId: id,
        imdbId: movie.imdbId,
        name: movie.title,
        runtimeTicks: (movie.runtimeMins || 90) * 60 * 10_000_000,
      })
    }

    const tmdbId = idToTmdb(id)
    if (!tmdbId) return reply.code(404).send({ error: 'Not found' })
    if (isLibraryItemHidden('movie', tmdbId)) return reply.code(404).send({ error: 'Not found' })
    if (!hasAnySourceItem('movie', tmdbId)) return reply.code(404).send({ error: 'Not found' })
    const movie = getMovieByTmdbId(tmdbId) ?? await fetchMovieByTmdbId(tmdbId)
    if (!movie) return reply.code(404).send({ error: 'Not found' })
    if (!canUserAccessMovie(currentUser, movie)) return reply.code(404).send({ error: 'Not found' })
    const item = movieToItem(movie, currentUser.id) as Record<string, unknown>
    if (!movie.imdbId) return item
    return addMovieDetailMediaSources(item, headers, {
      itemId: id,
      sourceId: id,
      imdbId: movie.imdbId,
      name: movie.title,
      runtimeTicks: (movie.runtimeMins || 90) * 60 * 10_000_000,
    })
  }

  app.get('/Items/:id', async (req, reply) => {
    reply.header('Cache-Control', 'no-store')
    const user = requireRequestUser(req.headers, reply as never)
    if (!user) return
    return handleItem((req.params as { id: string }).id, reply as never, user, req.headers)
  })
  app.get('/Users/:userId/Items/:itemId', async (req, reply) => {
    reply.header('Cache-Control', 'no-store')
    const user = requireRequestUser(req.headers, reply as never)
    if (!user) return
    return handleItem((req.params as { itemId: string }).itemId, reply as never, user, req.headers)
  })

  // Seasons list for a series — Infuse calls this when opening a show
  app.get('/Shows/:seriesId/Seasons', async (req, reply) => {
    const user = requestUser(req.headers)
    if (!user) return reply.code(401).send({ error: 'Unauthorized' })
    const { seriesId } = req.params as { seriesId: string }
    if (seriesId === SEARCH_DISABLED_ITEM_ID) return { Items: [], TotalRecordCount: 0, StartIndex: 0 }
    const stremioSeries = idToStremioSearchMeta(seriesId)
    if (stremioSeries?.mediaType === 'series') {
      if (!await canUserAccessStremioMeta(user, stremioSeries.meta, 'series')) {
        return { Items: [], TotalRecordCount: 0, StartIndex: 0 }
      }
      const seriesMeta = await hydrateStremioSeriesMeta(stremioSeries.meta)
      const visibleEpisodes = await visibleStremioEpisodes(seriesMeta)
      const seasonNumbers = stremioSeriesSeasons(visibleEpisodes)
      return {
        Items: seasonNumbers.map(seasonNumber => stremioSeasonToItem(seriesMeta, seasonNumber)),
        TotalRecordCount: seasonNumbers.length,
        StartIndex: 0,
      }
    }
    const searchShowTmdbId = idToSearchShowTmdb(seriesId)
    if (searchShowTmdbId) return { Items: [], TotalRecordCount: 0, StartIndex: 0 }
    return withReadCache(`show-seasons:${user.id}:${seriesId}`, async () => {
      const showTmdbId = idToShowTmdb(seriesId)
      if (!showTmdbId) return reply.code(404).send({ error: 'Not found' })
      if (isLibraryItemHidden('show', showTmdbId)) return reply.code(404).send({ error: 'Not found' })
      const show = getShowByTmdbId(showTmdbId) ?? await fetchShowByTmdbId(showTmdbId)
      if (!show) return reply.code(404).send({ error: 'Not found' })
      if (!canUserAccessShow(user, show)) return reply.code(404).send({ error: 'Not found' })
      await ensureShowSeasonsCached(show).catch(() => {})
      const seasons = visibleSeasonsForShow(show)
      return { Items: seasons.map(s => seasonToItem(s, show, user.id)), TotalRecordCount: seasons.length, StartIndex: 0 }
    })
  })

  // Episodes list for a series — Infuse calls this with optional SeasonId filter
  app.get('/Shows/:seriesId/Episodes', async (req, reply) => {
    const user = requestUser(req.headers)
    if (!user) return reply.code(401).send({ error: 'Unauthorized' })
    const { seriesId } = req.params as { seriesId: string }
    if (seriesId === SEARCH_DISABLED_ITEM_ID) return { Items: [], TotalRecordCount: 0, StartIndex: 0 }
    const rawQ = (req as never as { query: Record<string, string | string[] | undefined> }).query
    const q: Record<string, string> = {}
    for (const [k, v] of Object.entries(rawQ)) q[k.toLowerCase()] = queryValue(v)
    const SeasonId = q.seasonid
    const stremioSeries = idToStremioSearchMeta(seriesId)
    if (stremioSeries?.mediaType === 'series') {
      if (!await canUserAccessStremioMeta(user, stremioSeries.meta, 'series')) {
        return { Items: [], TotalRecordCount: 0, StartIndex: 0 }
      }
      const seriesMeta = await hydrateStremioSeriesMeta(stremioSeries.meta)
      const stremioSeason = SeasonId ? idToStremioSeason(SeasonId) : null
      const visibleEpisodes = await visibleStremioEpisodes(seriesMeta)
      const episodes = stremioSeason
        ? visibleEpisodes.filter(ep => stremioEpisodeSeasonNumber(ep) === stremioSeason.seasonNumber)
        : visibleEpisodes
      return {
        Items: episodes.map(ep => stremioEpisodeToItem(seriesMeta, ep)),
        TotalRecordCount: episodes.length,
        StartIndex: 0,
      }
    }
    const searchShowTmdbId = idToSearchShowTmdb(seriesId)
    if (searchShowTmdbId) return { Items: [], TotalRecordCount: 0, StartIndex: 0 }
    return withReadCache(`show-episodes:${user.id}:${seriesId}:${SeasonId ?? 'all'}`, async () => {
      const pathSeasonRef = idToSeason(seriesId)
      const showTmdbId = pathSeasonRef?.showTmdbId ?? idToShowTmdb(seriesId)
      if (!showTmdbId) return reply.code(404).send({ error: 'Not found' })
      if (isLibraryItemHidden('show', showTmdbId)) return reply.code(404).send({ error: 'Not found' })
      const show = getShowByTmdbId(showTmdbId) ?? await fetchShowByTmdbId(showTmdbId)
      if (!show) return reply.code(404).send({ error: 'Not found' })
      if (!canUserAccessShow(user, show)) return reply.code(404).send({ error: 'Not found' })

      const effectiveSeasonId = SeasonId ?? (pathSeasonRef ? seasonToId(pathSeasonRef.showTmdbId, pathSeasonRef.seasonNum) : null)
      if (effectiveSeasonId || pathSeasonRef) {
        const seasonRef = effectiveSeasonId ? idToSeason(effectiveSeasonId) : pathSeasonRef
        if (!seasonRef) return reply.code(404).send({ error: 'Not found' })
        if (!getEpisodesForSeason(show.tmdbId, seasonRef.seasonNum).length) {
          await fetchAndCacheSeasonDetails(show.tmdbId, seasonRef.seasonNum).catch(() => {})
        }
        const visibleSeasonNums = new Set(visibleSeasonsForShow(show).map(s => s.seasonNumber))
        const episodes = visibleSeasonNums.has(seasonRef.seasonNum)
          ? getAiredEpisodesForSeason(show.tmdbId, seasonRef.seasonNum)
          : []
        return { Items: episodes.map(e => episodeToItem(e, show, user.id)), TotalRecordCount: episodes.length, StartIndex: 0 }
      }

      await ensureShowSeasonsCached(show).catch(() => {})
      const allEpisodes = visibleAiredEpisodesForShow(show)
      return { Items: allEpisodes.map(e => episodeToItem(e, show, user.id)), TotalRecordCount: allEpisodes.length, StartIndex: 0 }
    })
  })

  // Images — proxy TMDB/TVDB bytes so clients don't need to follow external redirects
  // Jellyfin image URL can be /Items/:id/Images/:type OR /Items/:id/Images/:type/:index
  async function handleImage(
    id: string,
    type: string,
    query: ImageQuery | undefined,
    headers: Record<string, string | string[] | undefined>,
    reply: FastifyReply,
  ) {
    const isBackdrop = type.toLowerCase() === 'backdrop'
    const isLogo = type.toLowerCase() === 'logo'
    const isThumb = type.toLowerCase() === 'thumb'
    const kind = imageKindForType(type)
    const rootFolderUser = requestUser(headers) ?? fallbackUser()

    const personTmdbId = idToPersonTmdb(id)
    if (personTmdbId) {
      const profilePath = getPersonProfilePath(personTmdbId)
      if (!profilePath) return reply.code(404).send()
      return sendImageUrl(reply, headers, profilePath, 'profile', query)
    }

    if (id === MOVIES_FOLDER_ID || id === SHOWS_FOLDER_ID || id === COLLECTIONS_FOLDER_ID) {
      const representative = bestRootFolderImage(id, rootFolderUser)
      if (!representative) return reply.code(404).send()
      return sendImageUrl(reply, headers, representative.path, representative.kind, query)
    }

    const folderSlug = idToTraktFolderSlug(id)
    if (folderSlug && isTraktEntryVisible(folderSlug)) {
      return sendTraktCollectionImage(folderSlug, type, query, headers, reply)
    }
    const collectionSlug = idToTraktCollectionSlug(id)
    if (collectionSlug && isTraktEntryCollection(collectionSlug)) {
      return sendTraktCollectionImage(collectionSlug, type, query, headers, reply)
    }

    const mdblistCollectionImageUrl = mdblistCollectionUrlForId(id)
    if (mdblistCollectionImageUrl) {
      return sendMdblistFolderImage(mdblistCollectionImageUrl, type, query, headers, reply)
    }
    const mdblistImageUrl = mdblistFolderUrlForId(id)
    if (mdblistImageUrl) {
      return sendMdblistFolderImage(mdblistImageUrl, type, query, headers, reply)
    }

    const stremioEpisode = idToStremioEpisode(id)
    if (stremioEpisode) {
      if (rootFolderUser && !await canUserAccessStremioMeta(rootFolderUser, stremioEpisode.series, 'series')) return reply.code(404).send()
      const path = stremioEpisode.episode.poster || stremioEpisode.series.poster
      if (path) return sendImageUrl(reply, headers, path, 'poster', query)
      return reply.code(404).send()
    }

    const stremioSeason = idToStremioSeason(id)
    if (stremioSeason) {
      if (rootFolderUser && !await canUserAccessStremioMeta(rootFolderUser, stremioSeason.series, 'series')) return reply.code(404).send()
      if (stremioSeason.series.poster) return sendImageUrl(reply, headers, stremioSeason.series.poster, 'poster', query)
      return reply.code(404).send()
    }

    const stremioSearch = idToStremioSearchMeta(id)
    if (stremioSearch) {
      const { meta } = stremioSearch
      if (rootFolderUser && !await canUserAccessStremioMeta(rootFolderUser, meta, stremioSearch.mediaType)) return reply.code(404).send()
      if (isLogo && meta.logo) return sendImageUrl(reply, headers, meta.logo, 'logo', query)
      if (isThumb && meta.background) return sendImageUrl(reply, headers, meta.background, 'backdrop', query)
      if (isBackdrop && meta.background) return sendImageUrl(reply, headers, meta.background, 'backdrop', query)
      if (meta.poster) return sendImageUrl(reply, headers, meta.poster, 'poster', query)
      return reply.code(404).send()
    }

    // Episode primary/backdrop still → fall back to season poster → series poster
    const epRef = idToEpisode(id)
    if (epRef) {
      const show = getShowByTmdbId(epRef.showTmdbId)
      if (isLogo && show?.logoPath) return sendImageUrl(reply, headers, show.logoPath, 'logo', query)
      const eps = getEpisodesForSeason(epRef.showTmdbId, epRef.seasonNum)
      const ep = eps.find(e => e.episodeNumber === epRef.episodeNum)
      const season = getSeason(epRef.showTmdbId, epRef.seasonNum)
      if (isThumb && show?.backdropPath) return sendImageUrl(reply, headers, show.backdropPath, 'backdrop', query)
      if (ep?.stillPath) return sendImageUrl(reply, headers, ep.stillPath, kind, query)
      if (show?.backdropPath) return sendImageUrl(reply, headers, show.backdropPath, 'backdrop', query)
      if (season?.posterPath) return sendImageUrl(reply, headers, season.posterPath, 'poster', query)
      if (show?.posterPath) return sendImageUrl(reply, headers, show.posterPath, 'poster', query)
      return reply.code(404).send()
    }

    // Series — Primary poster or Backdrop
    const searchShowTmdbId = idToSearchShowTmdb(id)
    if (searchShowTmdbId) {
      const show = await fetchShowByTmdbId(searchShowTmdbId)
      if (!show) return reply.code(404).send()
      if (isLogo && show.logoPath) return sendImageUrl(reply, headers, show.logoPath, 'logo', query)
      if (isThumb && show.backdropPath) return sendImageUrl(reply, headers, show.backdropPath, 'backdrop', query)
      if (isBackdrop && show.backdropPath) return sendImageUrl(reply, headers, show.backdropPath, 'backdrop', query)
      if (show.posterPath) return sendImageUrl(reply, headers, show.posterPath, 'poster', query)
      return reply.code(404).send()
    }

    const showTmdbId = idToShowTmdb(id)
    if (showTmdbId) {
      const show = getShowByTmdbId(showTmdbId) ?? await fetchShowByTmdbId(showTmdbId)
      if (!show) return reply.code(404).send()
      if (isLogo && show.logoPath) return sendImageUrl(reply, headers, show.logoPath, 'logo', query)
      if (isThumb && show.backdropPath) return sendImageUrl(reply, headers, show.backdropPath, 'backdrop', query)
      if (isBackdrop && show.backdropPath) return sendImageUrl(reply, headers, show.backdropPath, 'backdrop', query)
      if (show.posterPath) return sendImageUrl(reply, headers, show.posterPath, 'poster', query)
      return reply.code(404).send()
    }

    // Season poster → fall back to series poster
    const seasonRef = idToSeason(id)
    if (seasonRef) {
      let season = getSeason(seasonRef.showTmdbId, seasonRef.seasonNum)
      if (!season) {
        await fetchAndCacheSeasonDetails(seasonRef.showTmdbId, seasonRef.seasonNum).catch(() => {})
        season = getSeason(seasonRef.showTmdbId, seasonRef.seasonNum)
      }
      if (season?.posterPath) return sendImageUrl(reply, headers, season.posterPath, 'poster', query)
      const show = getShowByTmdbId(seasonRef.showTmdbId)
      if (show?.posterPath) return sendImageUrl(reply, headers, show.posterPath, 'poster', query)
      return reply.code(404).send()
    }

    // Movie poster or backdrop
    const searchMovieTmdbId = idToSearchMovieTmdb(id)
    if (searchMovieTmdbId) {
      const movie = await fetchMovieByTmdbId(searchMovieTmdbId)
      if (!movie) return reply.code(404).send()
      if (isLogo && movie.logoPath) return sendImageUrl(reply, headers, movie.logoPath, 'logo', query)
      if (isThumb && movie.backdropPath) return sendImageUrl(reply, headers, movie.backdropPath, 'backdrop', query)
      if (isBackdrop && movie.backdropPath) return sendImageUrl(reply, headers, movie.backdropPath, 'backdrop', query)
      if (movie.posterPath) return sendImageUrl(reply, headers, movie.posterPath, 'poster', query)
      return reply.code(404).send()
    }

    const tmdbId = idToTmdb(id)
    const movie = tmdbId ? (getMovieByTmdbId(tmdbId) ?? await fetchMovieByTmdbId(tmdbId)) : null
    if (!movie) return reply.code(404).send()
    if (isLogo && movie.logoPath) return sendImageUrl(reply, headers, movie.logoPath, 'logo', query)
    if (isThumb && movie.backdropPath) return sendImageUrl(reply, headers, movie.backdropPath, 'backdrop', query)
    if (isBackdrop && movie.backdropPath) return sendImageUrl(reply, headers, movie.backdropPath, 'backdrop', query)
    if (movie.posterPath) return sendImageUrl(reply, headers, movie.posterPath, 'poster', query)
    return reply.code(404).send()
  }

  app.get('/Items/:id/Images/:type', async (req, reply) => {
    const params = req.params as { id: string; type: string }
    const query = req.query as ImageQuery | undefined
    return handleImage(params.id, params.type, query, req.headers, reply as never)
  })
  app.get('/Items/:id/Images/:type/:index', async (req, reply) => {
    const params = req.params as { id: string; type: string }
    const query = req.query as ImageQuery | undefined
    return handleImage(params.id, params.type, query, req.headers, reply as never)
  })

  // Stubs for endpoints Infuse probes but we don't need to implement
  app.get('/Items/:itemId/Similar', async (req, reply) => {
    const { itemId } = req.params as { itemId: string }
    const user = requireRequestUser(req.headers as Record<string, string | string[] | undefined>, reply)
    if (!user) return
    const q = req.query as Record<string, string | string[] | undefined>
    const limit = parseInt(queryValue(q.limit ?? q.Limit)) || 12
    if (!config.tmdbApiKey) return { Items: [], TotalRecordCount: 0, StartIndex: 0 }
    const items = await buildSimilarItems(itemId, user, limit)
    return { Items: items, TotalRecordCount: items.length, StartIndex: 0 }
  })
  app.get('/Items/:itemId/LocalTrailers', async () => [])
  app.get('/Items/:itemId/SpecialFeatures', async () => [])
  app.get('/Users/:userId/Items/:itemId/LocalTrailers', async () => [])
  app.get('/MediaSegments/:id', async () => ({ Items: [], TotalRecordCount: 0, StartIndex: 0 }))
  app.get('/Users/:userId/Items/:itemId/SpecialFeatures', async () => [])
  app.get('/UserImage', async (_req, reply) => reply.code(204).send())
  const handleBitrateTest = async (
    req: { query: Record<string, string | string[] | undefined> },
    reply: { header: (name: string, value: string) => unknown },
  ) => {
    const rawQ = req.query
    const sizeRaw = rawQ.size ?? rawQ.Size
    const sizeValue = Array.isArray(sizeRaw) ? sizeRaw[0] : sizeRaw
    const requested = Number.parseInt(String(sizeValue ?? '0'), 10)
    const bytes = Number.isFinite(requested) && requested > 0 ? Math.min(requested, 10_000_000) : 0
    const res = reply as { header: (name: string, value: string) => { header: (name: string, value: string) => unknown } }
    res.header('Content-Type', 'application/octet-stream')
      .header('Content-Length', String(bytes))
    return Buffer.alloc(bytes)
  }
  app.get('/Playback/BitrateTest', async (req, reply) => handleBitrateTest(req as never, reply as never))
  app.post('/Playback/BitrateTest', async (req, reply) => handleBitrateTest(req as never, reply as never))
  app.post('/Sessions/Playing',         async () => ({}))
  app.post('/Sessions/Playing/Progress', async (req, reply) => {
    const user = requireRequestUser((req as { headers: Record<string, string | string[] | undefined> }).headers, reply as never)
    if (!user) return
    const body = (req as never as { body: Record<string, unknown> }).body
    const itemId       = body?.ItemId       as string | undefined
    const positionTicks = body?.PositionTicks as number | undefined
    if (itemId && positionTicks != null) {
      const canonicalItemId = normalizePlaybackItemId(itemId)
      opts.touchPlaybackItem?.(canonicalItemId)
      saveProgress(canonicalItemId, positionTicks, user.id)
      if (canonicalItemId !== itemId) {
        app.log.info(`progress: normalized ${itemId} -> ${canonicalItemId}`)
      }
      app.log.info(`progress: saved ${canonicalItemId} at ${positionTicks} ticks`)
    } else {
      app.log.warn(`progress: missing item or position in /Sessions/Playing/Progress payload`)
    }
    return {}
  })
  app.post('/Sessions/Playing/Progres', async (req, reply) => {
    const user = requireRequestUser((req as { headers: Record<string, string | string[] | undefined> }).headers, reply as never)
    if (!user) return
    const body = (req as never as { body: Record<string, unknown> }).body
    const itemId       = body?.ItemId       as string | undefined
    const positionTicks = body?.PositionTicks as number | undefined
    if (itemId && positionTicks != null) {
      const canonicalItemId = normalizePlaybackItemId(itemId)
      opts.touchPlaybackItem?.(canonicalItemId)
      saveProgress(canonicalItemId, positionTicks, user.id)
      if (canonicalItemId !== itemId) {
        app.log.info(`progress: normalized ${itemId} -> ${canonicalItemId}`)
      }
      app.log.info(`progress: saved ${canonicalItemId} at ${positionTicks} ticks`)
    } else {
      app.log.warn(`progress: missing item or position in /Sessions/Playing/Progress payload`)
    }
    return {}
  })
  app.post('/Sessions/Playing/Stopped', async (req, reply) => {
    const user = requireRequestUser(req.headers, reply as never)
    if (!user) return
    const body = (req as never as { body: Record<string, unknown> }).body
    const itemId            = body?.ItemId             as string  | undefined
    const positionTicks     = body?.PositionTicks      as number  | undefined
    const bodyRuntimeTicks  = body?.RunTimeTicks       as number  | undefined
    const playedToCompletion = body?.PlayedToCompletion as boolean | undefined
    if (itemId) {
      const canonicalItemId = normalizePlaybackItemId(itemId)
      opts.stopPlaybackItem?.(canonicalItemId)
      idToStremioSearchMeta(canonicalItemId) // refresh TTL so 15-min cleanup window starts from stop time
      const runtimeTicks = bodyRuntimeTicks ?? runtimeTicksForItem(canonicalItemId) ?? undefined
      if (playedToCompletion || reachedCompletionThreshold(positionTicks, runtimeTicks)) {
        markPlayed(canonicalItemId, user.id)
        if (playedToCompletion) {
          app.log.info(`progress: marked played ${canonicalItemId}`)
        } else {
          app.log.info(`progress: auto-marked played ${canonicalItemId} at ${positionTicks} / ${runtimeTicks} ticks`)
        }
      } else if (positionTicks != null) {
        saveProgress(canonicalItemId, positionTicks, user.id)
        if (canonicalItemId !== itemId) {
          app.log.info(`progress: normalized ${itemId} -> ${canonicalItemId}`)
        }
        app.log.info(`progress: stopped ${canonicalItemId} at ${positionTicks} ticks`)
      } else {
        app.log.warn(`progress: missing stop position for ${canonicalItemId}`)
      }
    }
    return {}
  })
  async function handleMarkPlayed(req: { params: { itemId: string }; headers: Record<string, string | string[] | undefined> }, reply: FastifyReply) {
    const { itemId } = req.params
    const user = requireRequestUser(req.headers, reply)
    if (!user) return
    app.log.info('watched: marking played ' + itemId + ' for user ' + user.id)
    const seasonRef = idToSeason(itemId)
    if (seasonRef) {
      for (const ep of getEpisodesForSeason(seasonRef.showTmdbId, seasonRef.seasonNum)) {
        markPlayed(episodeToId(seasonRef.showTmdbId, ep.seasonNumber, ep.episodeNumber), user.id)
      }
    }
    markPlayed(itemId, user.id)
    const ud = getUserData(itemId, user.id)
    return { PlayCount: ud.playCount, Played: ud.played, LastPlayedDate: ud.lastPlayedDate || undefined }
  }

  async function handleMarkUnplayed(req: { params: { itemId: string }; headers: Record<string, string | string[] | undefined> }, reply: FastifyReply) {
    const { itemId } = req.params
    const user = requireRequestUser(req.headers, reply)
    if (!user) return
    app.log.info('watched: marking unplayed ' + itemId + ' for user ' + user.id)
    const seasonRef = idToSeason(itemId)
    if (seasonRef) {
      for (const ep of getEpisodesForSeason(seasonRef.showTmdbId, seasonRef.seasonNum)) {
        markUnplayed(episodeToId(seasonRef.showTmdbId, ep.seasonNumber, ep.episodeNumber), user.id)
      }
    }
    markUnplayed(itemId, user.id)
    return {}
  }

  app.post('/Users/:userId/PlayedItems/:itemId', async (req, reply) => handleMarkPlayed(req as never, reply as never))
  app.delete('/Users/:userId/PlayedItems/:itemId', async (req, reply) => handleMarkUnplayed(req as never, reply as never))
  app.post('/UserPlayedItems/:itemId', async (req, reply) => handleMarkPlayed(req as never, reply as never))
  app.delete('/UserPlayedItems/:itemId', async (req, reply) => handleMarkUnplayed(req as never, reply as never))

  // Playback — handles both movies and episodes
  async function handlePlaybackInfo(
    req: { params: { id: string }; headers: Record<string, string> },
    reply: { code: (n: number) => { send: (v: unknown) => unknown } },
  ) {
    const user = requestUser(req.headers)
    if (!user) return reply.code(401).send({ error: 'Unauthorized' })
    const { id } = req.params
    if (id === SEARCH_DISABLED_ITEM_ID) {
      return searchDisabledPlaybackInfo(buildPlaybackOrigin(req.headers))
    }

    const stremioEpisode = idToStremioEpisode(id)
    if (stremioEpisode) {
      const { series, episode } = stremioEpisode
      if (!await canUserAccessStremioMeta(user, series, 'series')) return reply.code(404).send({ error: 'Not found' })
      const externalId = episode.id || `${series.id}:${stremioEpisodeSeasonNumber(episode)}:${stremioEpisodeNumber(episode)}`
      const playPath = `/play/stremio/series/${encodeURIComponent(externalId)}`
      const playUrl = createSignedPlaybackUrl(buildPlaybackOrigin(req.headers), playPath)
      const name = `${stremioMetaName(series)} - ${stremioMetaName(episode)}`
      const runtimeTicks = stremioRuntimeTicks(episode, 45)
      const playbackClient = playbackClientFromHeaders(req.headers)
      const mediaSources = config.mediaSourceSelection
        ? await playbackMediaSourcesFor(opts, {
            itemId: id,
            sourceId: id,
            origin: buildPlaybackOrigin(req.headers),
            playPath,
            name,
            runtimeTicks,
            playbackClient,
          })
        : [defaultPlaybackMediaSource(id, name, playUrl, runtimeTicks)]
      app.log.info(`playback: Stremio "${name}" → ${playUrl}`)
      opts.registerPlaybackItem?.(id, playPath)
      opts.registerPlaybackClient?.(playPath, playbackClient)
      opts.prewarmPlayback?.(playPath, name)
      return {
        MediaSources: mediaSources,
        AlternateMediaSources: mediaSources,
        PlaySessionId: `fetcherr-${id}`,
      }
    }

    const stremioSearch = idToStremioSearchMeta(id)
    if (stremioSearch) {
      const { meta, mediaType, sourceId } = stremioSearch
      if (mediaType !== 'movie') return reply.code(404).send({ error: 'Not playable' })
      if (!await canUserAccessStremioMeta(user, meta, mediaType)) return reply.code(404).send({ error: 'Not found' })
      const externalId = meta.imdb_id || meta.imdbId || meta.id
      const playPath = `/play/stremio/movie/${encodeURIComponent(externalId)}`
      const playUrl = createSignedPlaybackUrl(buildPlaybackOrigin(req.headers), playPath)
      const name = stremioMetaName(meta)
      const runtimeTicks = stremioRuntimeTicks(meta, 90)
      const playbackClient = playbackClientFromHeaders(req.headers)
      const mediaSources = config.mediaSourceSelection
        ? await playbackMediaSourcesFor(opts, {
            itemId: id,
            sourceId,
            origin: buildPlaybackOrigin(req.headers),
            playPath,
            name,
            runtimeTicks,
            playbackClient,
          })
        : [defaultPlaybackMediaSource(sourceId, name, playUrl, runtimeTicks)]
      app.log.info(`playback: Stremio "${name}" → ${playUrl}`)
      opts.registerPlaybackItem?.(id, playPath)
      opts.registerPlaybackClient?.(playPath, playbackClient)
      opts.prewarmPlayback?.(playPath, name)
      return {
        MediaSources: mediaSources,
        AlternateMediaSources: mediaSources,
        PlaySessionId: `fetcherr-${id}`,
      }
    }

    // Episode playback
    const epRef = idToEpisode(id)
    if (epRef) {
      if (isLibraryItemHidden('show', epRef.showTmdbId)) return reply.code(404).send({ error: 'Not found' })
      const show = getShowByTmdbId(epRef.showTmdbId) ?? await fetchShowByTmdbId(epRef.showTmdbId)
      if (!show?.imdbId) return reply.code(404).send({ error: 'No IMDb ID for this show' })
      if (!canUserAccessShow(user, show)) return reply.code(404).send({ error: 'Not found' })
      let [ep] = getEpisodesForSeason(show.tmdbId, epRef.seasonNum)
        .filter(e => e.episodeNumber === epRef.episodeNum)
      if (!ep) {
        const eps = await fetchAndCacheSeasonDetails(show.tmdbId, epRef.seasonNum).catch(() => [])
        ep = eps.find(e => e.episodeNumber === epRef.episodeNum)!
      }
      if (!ep || !isEpisodeVisibleToLibrary(ep)) {
        return reply.code(409).send({ error: 'Episode not yet available', message: 'Not Yet Aired' })
      }
      const playPath = `/play/${show.imdbId}/${epRef.seasonNum}/${epRef.episodeNum}`
      const playUrl = createSignedPlaybackUrl(buildPlaybackOrigin(req.headers), playPath)
      const label = ep ? ep.name : `S${epRef.seasonNum}E${epRef.episodeNum}`
      const name = `${show.title} - ${label}`
      const runtimeTicks = (ep?.runtimeMins || 45) * 60 * 10_000_000
      const playbackClient = playbackClientFromHeaders(req.headers)
      const mediaSources = config.mediaSourceSelection
        ? await playbackMediaSourcesFor(opts, {
            itemId: id,
            sourceId: id,
            origin: buildPlaybackOrigin(req.headers),
            playPath,
            name,
            runtimeTicks,
            playbackClient,
          })
        : [defaultPlaybackMediaSource(id, name, playUrl, runtimeTicks)]
      app.log.info(`playback: "${show.title}" ${label} → ${playUrl}`)
      opts.registerPlaybackItem?.(id, playPath)
      opts.registerPlaybackClient?.(playPath, playbackClient)
      opts.prewarmPlayback?.(playPath, `${show.title} ${label}`)
      return {
        MediaSources: mediaSources,
        AlternateMediaSources: mediaSources,
        PlaySessionId: `fetcherr-${id}`,
      }
    }

    // Movie playback
    const searchMovieTmdbId = idToSearchMovieTmdb(id)
    if (searchMovieTmdbId) {
      const movie = await fetchMovieByTmdbId(searchMovieTmdbId)
      if (!movie?.imdbId) return reply.code(404).send({ error: 'No IMDb ID for this title' })
      if (!canUserAccessMovie(user, movie)) return reply.code(404).send({ error: 'Not found' })
      if (!isMovieVisibleToLibrary(movie)) {
        return reply.code(409).send({ error: 'Title not yet available', message: 'Not Yet Released' })
      }
      const playPath = `/play/${movie.imdbId}`
      const playUrl = createSignedPlaybackUrl(buildPlaybackOrigin(req.headers), playPath)
      const runtimeTicks = (movie.runtimeMins || 90) * 60 * 10_000_000
      const playbackClient = playbackClientFromHeaders(req.headers)
      const mediaSources = config.mediaSourceSelection
        ? await playbackMediaSourcesFor(opts, {
            itemId: id,
            sourceId: id,
            origin: buildPlaybackOrigin(req.headers),
            playPath,
            name: movie.title,
            runtimeTicks,
            playbackClient,
          })
        : [defaultPlaybackMediaSource(id, movie.title, playUrl, runtimeTicks)]
      app.log.info(`playback: "${movie.title}" → ${playUrl}`)
      opts.registerPlaybackItem?.(id, playPath)
      opts.registerPlaybackClient?.(playPath, playbackClient)
      opts.prewarmPlayback?.(playPath, movie.title)
      return {
        MediaSources: mediaSources,
        AlternateMediaSources: mediaSources,
        PlaySessionId: `fetcherr-${id}`,
      }
    }

    const tmdbId = idToTmdb(id)
    if (!tmdbId) return reply.code(404).send({ error: 'Not found' })
    const movie = getMovieByTmdbId(tmdbId) ?? await fetchMovieByTmdbId(tmdbId)
    if (!movie?.imdbId) return reply.code(404).send({ error: 'No IMDb ID for this title' })
    if (!canUserAccessMovie(user, movie)) return reply.code(404).send({ error: 'Not found' })
    if (!isMovieVisibleToLibrary(movie)) {
      return reply.code(409).send({ error: 'Title not yet available', message: 'Not Yet Released' })
    }

    const playPath = `/play/${movie.imdbId}`
    const playUrl = createSignedPlaybackUrl(buildPlaybackOrigin(req.headers), playPath)
    const runtimeTicks = (movie.runtimeMins || 90) * 60 * 10_000_000
    const playbackClient = playbackClientFromHeaders(req.headers)
    const mediaSources = config.mediaSourceSelection
      ? await playbackMediaSourcesFor(opts, {
          itemId: id,
          sourceId: id,
          origin: buildPlaybackOrigin(req.headers),
          playPath,
          name: movie.title,
          runtimeTicks,
          playbackClient,
        })
      : [defaultPlaybackMediaSource(id, movie.title, playUrl, runtimeTicks)]
    app.log.info(`playback: "${movie.title}" → ${playUrl}`)
    opts.registerPlaybackItem?.(id, playPath)
    opts.registerPlaybackClient?.(playPath, playbackClient)
    opts.prewarmPlayback?.(playPath, movie.title)
    return {
      MediaSources: mediaSources,
      AlternateMediaSources: mediaSources,
      PlaySessionId: `fetcherr-${id}`,
    }
  }

  app.get('/Items/:id/PlaybackInfo',  async (req, reply) => {
    reply.header('Cache-Control', 'no-store')
    return handlePlaybackInfo(req as never, reply as never)
  })
  app.post('/Items/:id/PlaybackInfo', async (req, reply) => {
    reply.header('Cache-Control', 'no-store')
    return handlePlaybackInfo(req as never, reply as never)
  })

  // Video stream redirect (fallback for some Infuse/VidHub versions)
  app.get('/Videos/:id/stream', async (req, reply) => {
    const { id } = req.params as { id: string }
    const query = req.query as { playSessionId?: string; PlaySessionId?: string; mediaSourceId?: string; MediaSourceId?: string; api_key?: string } | undefined
    const mediaSourceId = query?.mediaSourceId ?? query?.MediaSourceId
    const sessionMatches = (query?.playSessionId ?? query?.PlaySessionId) === `fetcherr-${id}`
    const sourceMatches = (query?.mediaSourceId ?? query?.MediaSourceId) === id
    const candidate = candidateTokenFromMediaSourceId(mediaSourceId)
    const candidateMatches = Boolean(
      candidate
      && mediaSourceId?.startsWith(`${id}:candidate:`)
      && opts.validatePlaybackCandidate?.(candidate, id),
    )
    const profileMatches = Boolean(playbackProfileFromMediaSourceId(mediaSourceId, id))
    const headersWithToken = query?.api_key
      ? { ...req.headers as Record<string, string | string[] | undefined>, 'x-emby-token': query.api_key }
      : req.headers as Record<string, string | string[] | undefined>
    const user = requestUser(headersWithToken) ?? ((sessionMatches || sourceMatches || candidateMatches || profileMatches) ? fallbackUser() : null)

    if (!user) return reply.code(401).send({ error: 'Unauthorized' })

    const origin = buildPlaybackOrigin(req.headers as Record<string, string | undefined>)
    if (id === SEARCH_DISABLED_ITEM_ID) {
      return reply.code(409).send({ error: 'Search disabled', message: 'Fetcherr Search Disabled' })
    }

    const stremioEpisode = idToStremioEpisode(id)
    if (stremioEpisode) {
      const { series, episode } = stremioEpisode
      if (!await canUserAccessStremioMeta(user, series, 'series')) return reply.code(404).send()
      const externalId = episode.id || `${series.id}:${stremioEpisodeSeasonNumber(episode)}:${stremioEpisodeNumber(episode)}`
      const playPath = `/play/stremio/series/${encodeURIComponent(externalId)}`
      return reply.redirect(signedPlaybackUrlForMediaSource(origin, playPath, mediaSourceId), 302)
    }

    const stremioSearch = idToStremioSearchMeta(id)
    if (stremioSearch) {
      const { meta, mediaType } = stremioSearch
      if (mediaType !== 'movie') return reply.code(404).send()
      if (!await canUserAccessStremioMeta(user, meta, mediaType)) return reply.code(404).send()
      const externalId = meta.imdb_id || meta.imdbId || meta.id
      const playPath = `/play/stremio/movie/${encodeURIComponent(externalId)}`
      return reply.redirect(signedPlaybackUrlForMediaSource(origin, playPath, mediaSourceId), 302)
    }

    const epRef = idToEpisode(id)
    if (epRef) {
      if (isLibraryItemHidden('show', epRef.showTmdbId)) return reply.code(404).send()
      const show = getShowByTmdbId(epRef.showTmdbId) ?? await fetchShowByTmdbId(epRef.showTmdbId)
      if (!show?.imdbId) return reply.code(404).send()
      if (!canUserAccessShow(user, show)) return reply.code(404).send()
      const playPath = `/play/${show.imdbId}/${epRef.seasonNum}/${epRef.episodeNum}`
      return reply.redirect(signedPlaybackUrlForMediaSource(origin, playPath, mediaSourceId), 302)
    }

    const searchMovieTmdbId = idToSearchMovieTmdb(id)
    if (searchMovieTmdbId) {
      const movie = await fetchMovieByTmdbId(searchMovieTmdbId)
      if (!movie?.imdbId) return reply.code(404).send()
      if (!canUserAccessMovie(user, movie)) return reply.code(404).send()
      if (!isMovieVisibleToLibrary(movie)) return reply.code(409).send({ error: 'Title not yet available', message: 'Not Yet Released' })
      const playPath = `/play/${movie.imdbId}`
      return reply.redirect(signedPlaybackUrlForMediaSource(origin, playPath, mediaSourceId), 302)
    }

    const tmdbId = idToTmdb(id)
    const movie = tmdbId ? (getMovieByTmdbId(tmdbId) ?? await fetchMovieByTmdbId(tmdbId)) : null
    if (!movie?.imdbId) return reply.code(404).send()
    if (!canUserAccessMovie(user, movie)) return reply.code(404).send()
    if (!isMovieVisibleToLibrary(movie)) return reply.code(409).send({ error: 'Title not yet available', message: 'Not Yet Released' })
    const playPath = `/play/${movie.imdbId}`
    return reply.redirect(signedPlaybackUrlForMediaSource(origin, playPath, mediaSourceId), 302)
  })
}
