import Fastify from 'fastify'
import { parseTorrentTitle, type ParsedResult as ParsedTorrentTitleResult } from '@viren070/parse-torrent-title'
import { randomBytes } from 'node:crypto'
import { collectStreamProviderUrls, config, normalizeSootioUrl, parseAudioLanguage, parseBooleanSetting, parseEnglishStreamMode, parseMdblistLists, parseMediaSourceLimit, parseMovieReleaseMode, parseMusicAddonUrls, parseShowAddDefaultMode, parseStreamProviderUrls, parseStreamRankingMode, parseTraktLists } from './config.js'
import { getDb, getAllSettings } from './db.js'
import { jellyfinRoutes, resolveJellyfinUser } from './jellyfin/index.js'
import { uiRoutes } from './ui/routes.js'
import { wrapFastifyLogger } from './logger.js'
import { markSyncComplete } from './sync-state.js'
import { cleanupRemovedTraktListSources, syncTraktWatchlist, syncTraktShowsWatchlist, syncTraktList, syncTraktWatchedStatus, startDeviceAuth, tokenStatus } from './trakt.js'
import { cleanupRemovedMdblistListSources, normalizeMdblistEntries, syncMdblistList } from './mdblist.js'
import { fetchRankedStreams, fetchRankedEpisodeStreams, fetchRankedStremioStreams, extractHashFromStream, summarizeStreamForLog, type StremioMediaType, type Stream } from './sootio.js'
import { resolveStream, probeAudioLanguages, NotCachedError, ProviderUnavailableError, type ResolvedStream } from './rd.js'
import {
  markPlaybackStarted as markTorBoxPlaybackStarted,
  resolveStream as tbResolveStream,
  rehydrateTorBoxCleanupJobs,
  touchDownloadUrl as touchTorBoxDownloadUrl,
} from './torbox.js'
import { getShowByImdbId, getEpisodesForSeason, getLatestSeasonNumberForShow, isEpisodeVisibleToLibrary, listLatestSeasonShowSubscriptions, listMovies, listShows, pruneAllOrphanedMovies, pruneAllOrphanedShows, removeSourceKey, upsertManualShowSubscription } from './db.js'
import { ensureShowSeasonsCached, refreshShowMetadataIfNeeded, refreshMovieMetadataIfNeeded } from './tmdb.js'
import { getSessionUser, getTokenFromCookie, isUiAuthConfigured, isValidSession } from './ui/auth.js'
import { createSignedPlaybackUrl, verifySignedPlaybackPath } from './play-auth.js'
import { hasAudioLanguage, hasNonPreferredAudioMarker, hasPreferredAudioMarker } from './streamLanguage.js'
import { streamMetadataText } from './streamUtils.js'

const app = Fastify({
  logger: { level: 'info' },
  trustProxy: true,
  routerOptions: { ignoreTrailingSlash: true },
  rewriteUrl: (req) => req.url!.replace(/\/\/+/g, '/').replace(/\.view(\?|$)/, '$1'),
})

app.removeContentTypeParser('application/json')
app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
  const text = String(body ?? '').trim()
  if (!text) {
    done(null, {})
    return
  }
  try {
    done(null, JSON.parse(text))
  } catch (err) {
    done(err as Error)
  }
})

app.addHook('onRequest', async (_req, reply) => {
  reply.header('X-Content-Type-Options', 'nosniff')
  reply.header('X-Frame-Options', 'DENY')
  reply.header('Referrer-Policy', 'same-origin')
  reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
  reply.header(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "base-uri 'self'",
      "connect-src 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "img-src 'self' data: https://image.tmdb.org",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
    ].join('; '),
  )
})

// Initialise DB
getDb()

// Apply any DB-persisted settings on top of env vars
{
  const s = getAllSettings()
  if (s.sootioUrl)          config.sootioUrl          = normalizeSootioUrl(s.sootioUrl)
  if (s.rdApiKey)           config.rdApiKey            = s.rdApiKey
  if (s.torBoxApiKey)       config.torBoxApiKey        = s.torBoxApiKey
  if (s.torBoxUserIp)       config.torBoxUserIp        = s.torBoxUserIp
  if (s.tmdbApiKey)         config.tmdbApiKey          = s.tmdbApiKey
  if (s.tvdbApiKey)         config.tvdbApiKey          = s.tvdbApiKey
  if (s.serverUrl)          config.serverUrl           = s.serverUrl
  if (s.traktClientId)      config.traktClientId       = s.traktClientId
  if (s.traktClientSecret)  config.traktClientSecret   = s.traktClientSecret
  if (s.traktLists != null) config.traktLists          = parseTraktLists(s.traktLists)
  if (s.traktWatchlistMovies != null) config.traktWatchlistMovies = parseBooleanSetting(s.traktWatchlistMovies, true)
  if (s.traktWatchlistShows != null)  config.traktWatchlistShows  = parseBooleanSetting(s.traktWatchlistShows, true)
  if (s.traktWatchHistory != null) config.traktWatchHistory = parseBooleanSetting(s.traktWatchHistory, false)
  if (s.traktCollections != null) config.traktCollections = parseBooleanSetting(s.traktCollections, false)
  if (s.traktFolders != null) config.traktFolders = parseBooleanSetting(s.traktFolders, false)
  if (s.mdblistApiKey)        config.mdblistApiKey       = s.mdblistApiKey
  if (s.mdblistLists != null) config.mdblistLists = normalizeMdblistEntries(parseMdblistLists(s.mdblistLists))
  if (s.mdblistFolders != null) config.mdblistFolders = parseBooleanSetting(s.mdblistFolders, false)
  if (s.showAddDefaultMode != null) config.showAddDefaultMode = parseShowAddDefaultMode(s.showAddDefaultMode)
  if (s.movieReleaseMode != null) config.movieReleaseMode = parseMovieReleaseMode(s.movieReleaseMode)
  if (s.musicAddonUrls != null) config.musicAddonUrls = parseMusicAddonUrls(s.musicAddonUrls)
  if (s.preferredAudioLanguage != null) config.preferredAudioLanguage = parseAudioLanguage(s.preferredAudioLanguage)
  if (s.englishStreamMode != null) config.englishStreamMode = parseEnglishStreamMode(s.englishStreamMode)
  if (s.streamRankingMode != null) config.streamRankingMode = parseStreamRankingMode(s.streamRankingMode)
  if (s.mediaSourceSelection != null) config.mediaSourceSelection = parseBooleanSetting(s.mediaSourceSelection, false)
  if (s.mediaSourceLimit != null) config.mediaSourceLimit = parseMediaSourceLimit(s.mediaSourceLimit)
  const bothConfigured = Boolean(config.rdApiKey && config.torBoxApiKey)
  if (bothConfigured) {
    config.streamProviderUrls = collectStreamProviderUrls(
      s.rdStreamProviderUrls ?? '',
      s.torBoxStreamProviderUrls ?? '',
      s.streamProviderUrls ?? '',
    )
  } else if (config.torBoxApiKey) {
    config.streamProviderUrls = collectStreamProviderUrls(
      s.torBoxStreamProviderUrls ?? '',
      s.streamProviderUrls ?? '',
      config.streamProviderUrls.join('\n'),
    )
  } else {
    config.streamProviderUrls = collectStreamProviderUrls(
      s.rdStreamProviderUrls ?? '',
      s.streamProviderUrls ?? '',
      config.streamProviderUrls.join('\n'),
    )
  }
  config.stremioSearchProviderUrls = collectStreamProviderUrls(
    s.rdStreamProviderUrls ?? '',
    s.torBoxStreamProviderUrls ?? '',
    s.streamProviderUrls ?? '',
    config.streamProviderUrls.join('\n'),
    config.sootioUrl,
  )
}

rehydrateTorBoxCleanupJobs()

// Wrap Fastify logger so UI log viewer captures it
wrapFastifyLogger(app)

// Healthcheck
app.get('/healthz', async () => ({ status: 'ok' }))

function requireUiSession(
  req: { headers: Record<string, string | undefined> },
  reply: { code: (n: number) => { send: (v: unknown) => unknown } },
): boolean {
  if (!isUiAuthConfigured()) {
    reply.code(503).send({ error: 'UI auth is not configured. Create an admin account first.' })
    return false
  }
  const token = getTokenFromCookie(req.headers.cookie)
  if (!token || !isValidSession(token) || !getSessionUser(token)) {
    reply.code(401).send({ error: 'Unauthorized' })
    return false
  }
  return true
}

function requireAdminUiSession(
  req: { headers: Record<string, string | undefined> },
  reply: { code: (n: number) => { send: (v: unknown) => unknown } },
): boolean {
  if (!requireUiSession(req, reply)) return false
  const token = getTokenFromCookie(req.headers.cookie)
  const user = token ? getSessionUser(token) : null
  if (!user || user.role !== 'admin') {
    reply.code(403).send({ error: 'Admin access required' })
    return false
  }
  return true
}

function requestPlaybackUser(headers: Record<string, string | string[] | undefined>) {
  const cookieHeader = Array.isArray(headers.cookie) ? headers.cookie[0] : headers.cookie
  const token = getTokenFromCookie(cookieHeader)
  if (token && isValidSession(token)) {
    const uiUser = getSessionUser(token)
    if (uiUser) return uiUser
  }
  return resolveJellyfinUser(headers)
}

// ── Play endpoint ─────────────────────────────────────────────────────────────
// Called by Infuse when it follows the URL returned from PlaybackInfo.
// Queries AIOStreams for the best RD-cached stream and 302s to the direct URL.

function pad2(n: number) { return n.toString().padStart(2, '0') }

const FAILED_PLAY_TTL_MS = 3 * 60 * 1000
const PLAYBACK_PREWARM_TTL_MS = 5 * 60 * 1000
const MAX_RD_TRANSIENT_FAILURES = 3
type FailedPlayCacheEntry = { expiresAt: number; reason: string }
const failedPlayCache = new Map<string, FailedPlayCacheEntry>()
type PlayResolution = { url: string; filename?: string; bytes?: number; sourceHash?: string; provider?: string }
type PlaybackPrewarmEntry = { expiresAt: number; promise: Promise<PlayResolution> }
const playbackPrewarmCache = new Map<string, PlaybackPrewarmEntry>()
let activePlaybackPrewarmPath: string | null = null
const PLAYBACK_ITEM_TTL_MS = 6 * 60 * 60 * 1000
const PLAYBACK_CANDIDATE_TTL_MS = 10 * 60 * 1000
const playbackItemPaths = new Map<string, { playPath: string; expiresAt: number }>()
const playbackClientNames = new Map<string, { clientName: string; expiresAt: number }>()
const torBoxPlaybackUrls = new Map<string, { url: string; expiresAt: number }>()
const playbackCandidates = new Map<string, { stream: Stream; playPath: string; label: string; fileHint?: string; expiresAt: number }>()

class PlaybackResolutionError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly response: { error: string; message: string },
  ) {
    super(message)
  }
}

function getFailedPlayReason(cacheKey: string): string | null {
  const entry = failedPlayCache.get(cacheKey)
  if (!entry) return null
  if (entry.expiresAt <= Date.now()) {
    failedPlayCache.delete(cacheKey)
    return null
  }
  return entry.reason
}

function cacheFailedPlay(cacheKey: string, reason: string) {
  failedPlayCache.set(cacheKey, {
    expiresAt: Date.now() + FAILED_PLAY_TTL_MS,
    reason,
  })
}

function clearFailedPlay(cacheKey: string) {
  failedPlayCache.delete(cacheKey)
}

function cleanupPlaybackPrewarmCache() {
  const now = Date.now()
  for (const [key, entry] of playbackPrewarmCache) {
    if (entry.expiresAt <= now) playbackPrewarmCache.delete(key)
  }
  for (const [key, entry] of playbackItemPaths) {
    if (entry.expiresAt <= now) playbackItemPaths.delete(key)
  }
  for (const [key, entry] of playbackClientNames) {
    if (entry.expiresAt <= now) playbackClientNames.delete(key)
  }
  for (const [key, entry] of torBoxPlaybackUrls) {
    if (entry.expiresAt <= now) torBoxPlaybackUrls.delete(key)
  }
  for (const [key, entry] of playbackCandidates) {
    if (entry.expiresAt <= now) playbackCandidates.delete(key)
  }
}

function registerPlaybackItem(itemId: string, playPath: string): void {
  cleanupPlaybackPrewarmCache()
  playbackItemPaths.set(itemId, { playPath, expiresAt: Date.now() + PLAYBACK_ITEM_TTL_MS })
}

function registerPlaybackClient(playPath: string, clientName: string): void {
  cleanupPlaybackPrewarmCache()
  playbackClientNames.set(playPath, { clientName, expiresAt: Date.now() + PLAYBACK_ITEM_TTL_MS })
}

function playbackClientName(playPath: string): string {
  cleanupPlaybackPrewarmCache()
  return playbackClientNames.get(playPath)?.clientName ?? ''
}

function rememberTorBoxPlaybackUrl(playPath: string, resolved: PlayResolution): void {
  if (resolved.provider !== 'TorBox') return
  torBoxPlaybackUrls.set(playPath, { url: resolved.url, expiresAt: Date.now() + PLAYBACK_ITEM_TTL_MS })
}

function touchPlaybackItem(itemId: string): void {
  cleanupPlaybackPrewarmCache()
  const item = playbackItemPaths.get(itemId)
  if (!item) return
  item.expiresAt = Date.now() + PLAYBACK_ITEM_TTL_MS
  const resolved = torBoxPlaybackUrls.get(item.playPath)
  if (!resolved) return
  resolved.expiresAt = Date.now() + PLAYBACK_ITEM_TTL_MS
  touchTorBoxDownloadUrl(resolved.url)
}

function stopPlaybackItem(itemId: string): void {
  touchPlaybackItem(itemId)
}

function getOrCreatePlaybackResolution(
  cacheKey: string,
  label: string,
  resolver: () => Promise<PlayResolution>,
): { promise: Promise<PlayResolution>; reused: boolean } {
  cleanupPlaybackPrewarmCache()
  const existing = playbackPrewarmCache.get(cacheKey)
  if (existing && existing.expiresAt > Date.now()) {
    return { promise: existing.promise, reused: true }
  }

  const promise = resolver().catch(err => {
    const current = playbackPrewarmCache.get(cacheKey)
    if (current?.promise === promise) playbackPrewarmCache.delete(cacheKey)
    throw err
  })
  playbackPrewarmCache.set(cacheKey, {
    expiresAt: Date.now() + PLAYBACK_PREWARM_TTL_MS,
    promise,
  })
  app.log.info(`play: started resolver for ${label}`)
  return { promise, reused: false }
}

function prewarmPlayback(playPath: string, label: string): void {
  cleanupPlaybackPrewarmCache()
  if (getFailedPlayReason(playPath)) return
  if (playbackPrewarmCache.has(playPath)) return
  if (activePlaybackPrewarmPath && activePlaybackPrewarmPath !== playPath) {
    app.log.info(`prewarm: skipping ${label}, another playback prewarm is active`)
    return
  }

  const stremioRouteMatch = playPath.match(/^\/play\/stremio\/(movie|series)\/(.+)$/)
  const episodeMatch = playPath.match(/^\/play\/([^/]+)\/(\d+)\/(\d+)$/)
  const movieMatch = playPath.match(/^\/play\/([^/]+)$/)
  const clientName = playbackClientName(playPath)
  const resolver = stremioRouteMatch
    ? () => resolveStremioPlayback(stremioRouteMatch[1] as StremioMediaType, decodeURIComponent(stremioRouteMatch[2]), clientName)
    : episodeMatch
    ? () => resolveEpisodePlayback(episodeMatch[1], Number.parseInt(episodeMatch[2], 10), Number.parseInt(episodeMatch[3], 10), clientName)
    : movieMatch
      ? () => resolveMoviePlayback(movieMatch[1], clientName)
      : null
  if (!resolver) return

  activePlaybackPrewarmPath = playPath
  const { promise, reused } = getOrCreatePlaybackResolution(playPath, label, resolver)
  app.log.info(`prewarm: ${reused ? 'reusing resolver' : 'started'} for ${label}`)
  promise
    .then(resolved => {
      app.log.info(`prewarm: ready for ${label}${resolved.filename ? ` → ${resolved.filename}` : ''}`)
    })
    .catch(err => app.log.info(`prewarm: ended for ${label}: ${err}`))
    .finally(() => {
      if (activePlaybackPrewarmPath === playPath) activePlaybackPrewarmPath = null
    })
}

function isNonRetryableRdError(err: ProviderUnavailableError): boolean {
  return err.status === 401 || err.status === 403 || err.status === 429
}

function terminalProviderHashFailureReason(err: unknown): string | null {
  if (err instanceof NotCachedError) return 'not cached'
  if (err instanceof ProviderUnavailableError && isNonRetryableRdError(err)) {
    return `provider returned ${err.status ?? 'a non-retryable error'}`
  }
  const message = err instanceof Error ? err.message : String(err)
  if (/\binfringing_file\b|error_code"?\s*:\s*35|[→-]\s*451\b/.test(message)) {
    return 'provider rejected hash'
  }
  return null
}

const VIDEO_EXTS = new Set(['mkv','mp4','avi','mov','m4v','ts','m2ts','wmv','flv','webm'])

function isVideoFile(filename: string): boolean {
  const ext = filename.split('.').pop()?.toLowerCase() ?? ''
  return VIDEO_EXTS.has(ext)
}

function isLikelyBadResolvedFilename(filename: string): boolean {
  const lower = filename.toLowerCase()
  const ext = lower.split('.').pop() ?? ''
  if (/\bsample\b|\btrailer\b|\bextras?\b|\bfeaturette\b/.test(lower)) return true
  if (ext === 'm2ts' || ext === 'ts') return true
  if (/^\d{4,6}\.(m2ts|ts)$/.test(lower)) return true
  return false
}

function streamFilenameHint(stream: { behaviorHints?: Record<string, unknown> }): string | undefined {
  const filename = stream.behaviorHints?.filename
  return typeof filename === 'string' && filename.trim() ? filename : undefined
}

function streamClearlyPreferredLanguage(stream: { name?: string; title?: string; description?: string; behaviorHints?: Record<string, unknown> }): boolean {
  const text = streamMetadataText(stream)
  const preferredLanguage = config.preferredAudioLanguage
  const hasPreferred = hasPreferredAudioMarker(text, preferredLanguage)
  const hasNonPreferred = hasNonPreferredAudioMarker(text, preferredLanguage)
  return hasPreferred && !hasNonPreferred
}

function streamClearlyNonPreferredLanguage(stream: { name?: string; title?: string; description?: string; behaviorHints?: Record<string, unknown> }): boolean {
  const text = streamMetadataText(stream)
  const preferredLanguage = config.preferredAudioLanguage
  const hasPreferred = hasPreferredAudioMarker(text, preferredLanguage)
  const hasNonPreferred = hasNonPreferredAudioMarker(text, preferredLanguage)
  return hasNonPreferred && !hasPreferred
}

function streamClearlyTorBoxCached(stream: { name?: string; title?: string; description?: string; behaviorHints?: Record<string, unknown> }): boolean {
  const text = streamMetadataText(stream)
  return /\btorbox\s*\(\s*(instant|cached)\s*\)|\binstant\s*\(\s*tb\s*\)|\[tb\+\]|\[tb ⚡\]|\[tb⚡\]|\btb\+\b|\bready\s*\(\s*tb\s*\)/.test(text)
}

function streamClearlyRealDebridCached(stream: { name?: string; title?: string; description?: string; behaviorHints?: Record<string, unknown> }): boolean {
  const text = streamMetadataText(stream)
  return /\breal[-\s]?debrid\s*\(\s*(instant|cached)\s*\)|\binstant\s*\(\s*rd\s*\)|\[rd\+\]|\[rd ⚡\]|\[rd⚡\]|\brd\+\b|\bready\s*\(\s*rd\s*\)/.test(text)
}

function activeDebridIsTorBox(): boolean {
  return Boolean(config.torBoxApiKey)
}

function activeDebridIsRealDebrid(): boolean {
  return Boolean(config.rdApiKey)
}

function activeDebridProviderName(): 'RD' | 'TorBox' | null {
  if (activeDebridIsRealDebrid()) return 'RD'
  if (activeDebridIsTorBox()) return 'TorBox'
  return null
}

function directStreamMatchesActiveDebrid(stream: { name?: string; title?: string; description?: string; behaviorHints?: Record<string, unknown> }): boolean {
  const hasBoth = activeDebridIsRealDebrid() && activeDebridIsTorBox()
  if (hasBoth) return true
  if (activeDebridIsRealDebrid()) return streamClearlyRealDebridCached(stream) || !streamClearlyTorBoxCached(stream)
  if (activeDebridIsTorBox()) return streamClearlyTorBoxCached(stream) || !streamClearlyRealDebridCached(stream)
  return true
}

function directStreamConflictsWithActiveDebrid(stream: { name?: string; title?: string; description?: string; behaviorHints?: Record<string, unknown> }): boolean {
  const hasBoth = activeDebridIsRealDebrid() && activeDebridIsTorBox()
  if (hasBoth) return false
  if (activeDebridIsRealDebrid()) return streamClearlyTorBoxCached(stream) && !streamClearlyRealDebridCached(stream)
  if (activeDebridIsTorBox()) return streamClearlyRealDebridCached(stream) && !streamClearlyTorBoxCached(stream)
  return false
}

function streamClearlyDirectDebrid(stream: { name?: string; title?: string; description?: string; behaviorHints?: Record<string, unknown> }): boolean {
  return streamClearlyRealDebridCached(stream) || streamClearlyTorBoxCached(stream)
}

function streamEligibleForMediaSourceSelection(stream: { name?: string; title?: string; description?: string; behaviorHints?: Record<string, unknown> }): boolean {
  const text = streamMetadataText(stream)
  return streamClearlyDirectDebrid(stream) || /\bcached\b|\binstant\b|⚡/.test(text)
}

function streamMarkedNotWebReady(stream: { behaviorHints?: Record<string, unknown> }): boolean {
  return stream.behaviorHints?.notWebReady === true
}

function directPlaybackPenalty(stream: { name?: string; title?: string; description?: string; behaviorHints?: Record<string, unknown>; url?: string }): number {
  if (!isDirectPlaybackUrl(stream.url)) return 0
  const text = streamMetadataText(stream)
  // Debrid-resolved CDN streams (TB+, RD+) are already optimal — trust original quality ranking
  if (/\[rd\+\]|\[rd ⚡\]|\[rd⚡\]|\brd\+\b|\[tb\+\]|\[tb ⚡\]|\[tb⚡\]|\btb\+\b/.test(text)) return 0
  const size = typeof stream.behaviorHints?.videoSize === 'number' ? stream.behaviorHints.videoSize : 0
  let penalty = 0
  if (/\b(2160p|4k|uhd)\b/.test(text)) penalty += 100
  if (/\bremux\b/.test(text)) penalty += 80
  if (/\b(dv|dolby[ ._-]*vision|hdr10?|hdr)\b/.test(text)) penalty += 50
  if (/\b(atmos|truehd|dts[ ._-]*hd|dts-hd)\b/.test(text)) penalty += 40
  if (/\b(hevc|h\.?265|x265|10bit)\b/.test(text)) penalty += 30
  if (size > 20_000_000_000) penalty += 80
  else if (size > 10_000_000_000) penalty += 40
  else if (size > 5_000_000_000) penalty += 20
  if (/\b(h\.?264|x264|avc)\b/.test(text)) penalty -= 20
  return penalty
}

function isRemoteAudioProbeUnreliable(filename: string): boolean {
  return /\.(mp4|m4v)$/i.test(filename)
}

function isDirectPlaybackUrl(url?: string): url is string {
  if (!url) return false
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

function resolutionAttemptKey(hash: string, fileHint?: string): string {
  return `${hash.toLowerCase()}|${(fileHint || '').toLowerCase()}`
}

function filenameFromDirectPlaybackUrl(url?: string): string | undefined {
  if (!url) return undefined
  try {
    const parsed = new URL(url)
    const lastSegment = parsed.pathname.split('/').filter(Boolean).pop()
    return lastSegment ? decodeURIComponent(lastSegment) : undefined
  } catch {
    return undefined
  }
}

function directUrlHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return 'unknown host'
  }
}

function isAioPlaybackUrl(url: URL): boolean {
  return /^\/api\/v\d+\/debrid\/playback\//.test(url.pathname)
}

function configuredAioOrigins(): string[] {
  const urls = [
    ...config.streamProviderUrls,
    ...config.stremioSearchProviderUrls,
    config.sootioUrl,
  ]
  const origins = new Set<string>()
  for (const value of urls) {
    if (!value) continue
    try {
      origins.add(new URL(value).origin)
    } catch { /* ignore invalid provider values */ }
  }
  return [...origins]
}

function aioPlaybackRedirectCandidates(url: string): string[] {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return []
  }
  if (!isAioPlaybackUrl(parsed)) return []

  const candidates = new Set<string>()
  for (const origin of configuredAioOrigins()) {
    try {
      const candidate = new URL(`${parsed.pathname}${parsed.search}`, origin)
      if (candidate.origin !== parsed.origin) candidates.add(candidate.toString())
    } catch { /* ignore invalid origin */ }
  }
  candidates.add(parsed.toString())
  return [...candidates]
}

async function resolveAioPlaybackRedirectUrl(url: string): Promise<string | null> {
  const candidates = aioPlaybackRedirectCandidates(url)
  if (!candidates.length) return null

  for (const candidate of candidates) {
    try {
      const res = await fetch(candidate, {
        method: 'GET',
        redirect: 'manual',
        headers: { Range: 'bytes=0-0' },
        signal: AbortSignal.timeout(10_000),
      })
      const location = res.headers.get('location')
      if (location && res.status >= 300 && res.status < 400) {
        const resolved = new URL(location, candidate).toString()
        app.log.info(`play: AIO playback URL unwrapped to ${directUrlHost(resolved)}`)
        return resolved
      }
      app.log.warn(`play: AIO playback unwrap returned ${res.status} from ${directUrlHost(candidate)}`)
      await res.body?.cancel().catch(() => {})
    } catch (err) {
      app.log.warn(`play: AIO playback unwrap failed via ${directUrlHost(candidate)}: ${summarizeProbeError(err)}`)
    }
  }

  return null
}

async function resolveDirectPlaybackUrl(url: string): Promise<string> {
  const aioRedirect = await resolveAioPlaybackRedirectUrl(url)
  if (aioRedirect) return aioRedirect

  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      headers: { Range: 'bytes=0-0' },
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok && res.status !== 206) {
      throw new Error(`direct playback probe returned ${res.status}`)
    }
    if (res.url && res.url !== url) {
      let host = 'unknown host'
      try { host = new URL(res.url).host } catch { /* ignore */ }
      app.log.info(`play: direct playback URL resolved to ${host}`)
    }
    return res.url || url
  } catch (err) {
    app.log.warn(`play: direct playback URL probe failed: ${summarizeProbeError(err)}`)
    return url
  }
}

async function maybeResolveDirectPlaybackCandidate(
  stream: Awaited<ReturnType<typeof fetchRankedStreams>>[number],
  label: string,
  hint?: string,
): Promise<PlayResolution | null> {
  if (!isDirectPlaybackUrl(stream.url)) return null
  if (directStreamConflictsWithActiveDebrid(stream)) {
    app.log.info(`play: skipping direct stream for ${label}, marked for another debrid provider`)
    return null
  }

  const directFilename = hint ?? filenameFromDirectPlaybackUrl(stream.url)
  if (directFilename && !isVideoFile(directFilename)) {
    app.log.info(`play: skipping non-video direct stream ${directFilename}, trying next`)
    return null
  }
  if (directFilename && isLikelyBadResolvedFilename(directFilename)) {
    app.log.info(`play: skipping suspicious direct stream ${directFilename}, trying next`)
    return null
  }
  if (
    directFilename
    && config.englishStreamMode === 'require'
    && isRemoteAudioProbeUnreliable(directFilename)
    && !streamClearlyPreferredLanguage(stream)
  ) {
    app.log.info(`play: skipping unprobeable ${directFilename}, no confirmed preferred-language metadata`)
    return null
  }

  const isDebridCachedStream = streamClearlyDirectDebrid(stream)
  if (!isDebridCachedStream && streamMarkedNotWebReady(stream) && !config.allowNotWebReadyDirectStreams) {
    app.log.info(`play: skipping notWebReady direct stream for ${label}${directFilename ? ` → ${directFilename}` : ''}`)
    return null
  }
  if (!isDebridCachedStream && streamMarkedNotWebReady(stream)) {
    app.log.warn(`play: allowing experimental notWebReady direct stream for ${label}${directFilename ? ` → ${directFilename}` : ''}`)
  }

  if (!isDebridCachedStream && directFilename && shouldProbePreferredAudio(stream, directFilename)) {
    try {
      const audioLanguages = await probeAudioLanguages(stream.url)
      app.log.info(`play: ffprobe audio languages for ${directFilename}: ${audioLanguages.join(', ') || 'none'}`)
      const noLanguageInfo = audioLanguages.length === 0
      const allowsUndetermined = (hasOnlyUndeterminedAudio(audioLanguages) || noLanguageInfo) && !streamClearlyNonPreferredLanguage(stream)
      if (config.englishStreamMode === 'require' && !hasAudioLanguage(audioLanguages, config.preferredAudioLanguage) && !allowsUndetermined) {
        app.log.info(`play: skipping ${directFilename}, no preferred audio detected`)
        return null
      }
    } catch (err) {
      app.log.warn(`play: ffprobe failed for ${directFilename}: ${summarizeProbeError(err)}`)
    }
  }

  const resolvedUrl = await resolveDirectPlaybackUrl(stream.url)
  app.log.info(
    `play: direct HTTP stream selected for ${label} from ${directUrlHost(resolvedUrl)}` +
    (directFilename ? ` → ${directFilename}` : '')
  )
  return { url: resolvedUrl, filename: directFilename, provider: stream.providerLabel }
}

function shouldProbePreferredAudio(
  stream: { name?: string; title?: string; description?: string; behaviorHints?: Record<string, unknown> },
  filename: string,
): boolean {
  if (config.englishStreamMode !== 'require') return false
  if (streamClearlyPreferredLanguage(stream)) return false
  if (streamClearlyNonPreferredLanguage(stream)) return false
  if (isRemoteAudioProbeUnreliable(filename)) return false
  return true
}

function hasOnlyUndeterminedAudio(languages: string[]): boolean {
  const normalized = languages
    .map(lang => lang.trim().toLowerCase())
    .filter(Boolean)
  // 'und' = undetermined, 'zxx' = no linguistic content (dialogue-free / language-neutral media)
  return normalized.length > 0 && normalized.every(lang => lang === 'und' || lang === 'undetermined' || lang === 'zxx')
}

function summarizeProbeError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  return message
    .replace(/https?:\/\/\S+/g, '[url]')
    .split('\n')[0]
    .slice(0, 500)
}

function playbackClientFromHeaders(headers: Record<string, string | undefined>): string {
  return (
    headers['x-emby-client']
    || headers['x-media-browser-client']
    || headers['user-agent']
    || ''
  ).toString()
}

async function resolvePlayableStream(
  streams: Awaited<ReturnType<typeof fetchRankedStreams>>,
  label: string,
  cacheKey: string,
  fileHint?: string,
  allowDirectUrls = false,
): Promise<PlayResolution> {
  if (config.rdApiKey || config.torBoxApiKey) {
    let rdTransientFailures = 0
    let tbTransientFailures = 0
    const attemptedRdResolutions = new Set<string>()
    const attemptedTorBoxResolutions = new Set<string>()
    const failedRdHashes = new Map<string, string>()
    const failedTorBoxHashes = new Map<string, string>()
    app.log.info(`play: trying ${streams.length} ordered candidate${streams.length === 1 ? '' : 's'} for ${label}`)
    const orderedStreams = allowDirectUrls || config.streamRankingMode === 'provider'
      ? streams
      : streams
          .map((stream, index) => ({ stream, index }))
          .sort((a, b) => {
            const aHash = extractHashFromStream(a.stream)
            const bHash = extractHashFromStream(b.stream)
            const aDirect = !aHash && isDirectPlaybackUrl(a.stream.url)
            const bDirect = !bHash && isDirectPlaybackUrl(b.stream.url)
            if (aHash && !bHash) return -1
            if (!aHash && bHash) return 1
            if (aDirect && bDirect) {
              return directPlaybackPenalty(a.stream) - directPlaybackPenalty(b.stream) || a.index - b.index
            }
            return a.index - b.index
          })
          .map(entry => entry.stream)
    for (const stream of orderedStreams) {
      const providerOrder = stream.providerOrder ?? 999
      const providerLabel = stream.providerLabel || `providerOrder=${providerOrder}`
      const hash = extractHashFromStream(stream)
      const hashLabel = hash ? hash.slice(0, 8) : 'direct-url'
      try {
        if (config.englishStreamMode === 'require' && streamClearlyNonPreferredLanguage(stream)) {
          app.log.info(`play: skipping stream metadata for ${label}, clearly not the preferred language`)
          continue
        }

        const hint = streamFilenameHint(stream) ?? fileHint
        const directOnlyCandidate = !hash && isDirectPlaybackUrl(stream.url)
        const shouldTryDirectCandidate = directOnlyCandidate
          && (allowDirectUrls || !streamClearlyDirectDebrid(stream) || directStreamMatchesActiveDebrid(stream))

        if (allowDirectUrls && isDirectPlaybackUrl(stream.url)) {
          const activeProvider = activeDebridProviderName()
          if (activeProvider && hash) {
            app.log.info(`play: resolving Stremio hash ${hashLabel}… for ${label} through ${activeProvider} cleanup-managed resolver`)
          } else {
            const useDirectUrl = !activeProvider || directStreamMatchesActiveDebrid(stream) || (!hash && !streamClearlyDirectDebrid(stream))
            if (!useDirectUrl) {
              if (directStreamConflictsWithActiveDebrid(stream) && !hash) {
                app.log.info(`play: skipping direct Stremio stream for ${label}, marked for another debrid provider while ${activeProvider} is active`)
                continue
              }
              if (hash) {
                const reason = directStreamConflictsWithActiveDebrid(stream) ? 'provider-mismatched' : 'unmarked'
                app.log.info(`play: deferring ${reason} direct Stremio stream for ${label} to ${activeProvider} hash resolver`)
              } else {
                app.log.info(`play: skipping unverified direct Stremio stream for ${label} while ${activeProvider} is active, no torrent hash exposed`)
                continue
              }
            } else {
              const resolvedDirect = await maybeResolveDirectPlaybackCandidate(stream, label, hint)
              if (resolvedDirect) {
                clearFailedPlay(cacheKey)
                return resolvedDirect
              }
              continue
            }
          }
        }

        if (!hash) {
          if (shouldTryDirectCandidate) {
            const resolvedDirect = await maybeResolveDirectPlaybackCandidate(stream, label, hint)
            if (resolvedDirect) {
              clearFailedPlay(cacheKey)
              return resolvedDirect
            }
            continue
          }

          if (!config.torBoxApiKey || config.directPlaybackMode !== 'all' || !isDirectPlaybackUrl(stream.url)) {
            app.log.info(`play: skipping ${providerLabel} for ${label}, no torrent hash exposed; ${summarizeStreamForLog(stream)}`)
            continue
          }

          const directFilename = hint ?? filenameFromDirectPlaybackUrl(stream.url)
          if (directFilename && !isVideoFile(directFilename)) {
            app.log.info(`play: skipping non-video direct stream ${directFilename}, trying next`)
            continue
          }
          if (directFilename && isLikelyBadResolvedFilename(directFilename)) {
            app.log.info(`play: skipping suspicious direct stream ${directFilename}, trying next`)
            continue
          }
          if (
            directFilename
            && config.englishStreamMode === 'require'
            && isRemoteAudioProbeUnreliable(directFilename)
            && !streamClearlyPreferredLanguage(stream)
          ) {
            app.log.info(`play: skipping unprobeable ${directFilename}, no confirmed preferred-language metadata`)
            continue
          }
          const isDebridCachedStream = /\[rd\+\]|\[rd ⚡\]|\[rd⚡\]|\brd\+\b|\[tb\+\]|\[tb ⚡\]|\[tb⚡\]|\btb\+\b/.test(streamMetadataText(stream))
          // Skip ffprobe for debrid-cached streams — their proxy URLs will be resolved to
          // CDN URLs at play-time; probing here would waste a TorBox add/delete cycle.
          if (!isDebridCachedStream && directFilename && shouldProbePreferredAudio(stream, directFilename)) {
            try {
              const audioLanguages = await probeAudioLanguages(stream.url)
              app.log.info(`play: ffprobe audio languages for ${directFilename}: ${audioLanguages.join(', ') || 'none'}`)
              const noLanguageInfo = audioLanguages.length === 0
              const allowsUndetermined = (hasOnlyUndeterminedAudio(audioLanguages) || noLanguageInfo) && !streamClearlyNonPreferredLanguage(stream)
              if (config.englishStreamMode === 'require' && !hasAudioLanguage(audioLanguages, config.preferredAudioLanguage) && !allowsUndetermined) {
                app.log.info(`play: skipping ${directFilename}, no preferred audio detected`)
                continue
              }
            } catch (err) {
              app.log.warn(`play: ffprobe failed for ${directFilename}: ${summarizeProbeError(err)}`)
            }
          }

          const resolvedUrl = await resolveDirectPlaybackUrl(stream.url)
          app.log.info(`play: direct stream selected for ${label} from ${directUrlHost(resolvedUrl)}${directFilename ? ` → ${directFilename}` : ''}`)
          clearFailedPlay(cacheKey)
          return { url: resolvedUrl, filename: directFilename }
        }

        app.log.info(`play: trying ${providerLabel} hash ${hash.slice(0, 8)}… for ${label}`)
        let resolved: ResolvedStream | null = null
        let provider = ''
        const attemptKey = resolutionAttemptKey(hash, hint)
        const normalizedHash = hash.toLowerCase()

        // Try the provider indicated by stream cache markers first; default to RD→TorBox
        const tbFirst = config.torBoxApiKey && streamClearlyTorBoxCached(stream) && !streamClearlyRealDebridCached(stream)
        let torBoxTriedFirst = false

        if (tbFirst) {
          torBoxTriedFirst = true
          const tbFirstFailedReason = failedTorBoxHashes.get(normalizedHash)
          if (tbFirstFailedReason) {
            app.log.info(`play: skipping TorBox hash ${hashLabel}… for ${label}, already failed: ${tbFirstFailedReason}`)
          } else if (attemptedTorBoxResolutions.has(attemptKey)) {
            app.log.info(`play: skipping duplicate TorBox hash ${hashLabel}… for ${label}`)
          } else {
            attemptedTorBoxResolutions.add(attemptKey)
            try {
              resolved = await tbResolveStream(hash, hint)
              provider = 'TorBox'
            } catch (tbErr) {
              if (tbErr instanceof NotCachedError) {
                failedTorBoxHashes.set(normalizedHash, 'not cached')
                app.log.info(`play: hash ${hashLabel}… not cached on TorBox${config.rdApiKey ? ', trying RD' : ''}`)
                if (!config.rdApiKey) continue
              } else if (tbErr instanceof ProviderUnavailableError) {
                tbTransientFailures += 1
                const retryable = !isNonRetryableRdError(tbErr) && tbTransientFailures < MAX_RD_TRANSIENT_FAILURES
                if (retryable) {
                  app.log.warn(
                    `play: TorBox error for providerOrder=${providerOrder} hash ${hashLabel}…: ${tbErr}; ` +
                    `trying next candidate (${tbTransientFailures}/${MAX_RD_TRANSIENT_FAILURES})`
                  )
                  continue
                }
                const terminalReason = terminalProviderHashFailureReason(tbErr)
                if (terminalReason) failedTorBoxHashes.set(normalizedHash, terminalReason)
                app.log.warn(
                  `play: TorBox unavailable for ${label} after ${tbTransientFailures} failure${tbTransientFailures === 1 ? '' : 's'}: ${tbErr}` +
                  (config.rdApiKey ? '; falling back to RD' : '')
                )
                if (!config.rdApiKey) {
                  throw new PlaybackResolutionError(
                    'Debrid provider unavailable',
                    503,
                    { error: 'Debrid provider unavailable', message: 'Debrid Unavailable' },
                  )
                }
              } else {
                const terminalReason = terminalProviderHashFailureReason(tbErr)
                if (terminalReason) failedTorBoxHashes.set(normalizedHash, terminalReason)
                app.log.warn(`play: hash ${hashLabel}… TorBox failed: ${tbErr}; trying next`)
                continue
              }
            }
          }
        }

        if (!resolved && config.rdApiKey) {
          const failedReason = failedRdHashes.get(normalizedHash)
          if (failedReason) {
            app.log.info(`play: skipping RD hash ${hashLabel}… for ${label}, already failed: ${failedReason}`)
          } else if (attemptedRdResolutions.has(attemptKey)) {
            app.log.info(`play: skipping duplicate RD hash ${hashLabel}… for ${label}`)
          } else {
            attemptedRdResolutions.add(attemptKey)
            try {
              resolved = await resolveStream(hash, hint)
              provider = 'RD'
            } catch (rdErr) {
              if (rdErr instanceof NotCachedError) {
                failedRdHashes.set(normalizedHash, 'not cached')
                app.log.info(`play: hash ${hashLabel}… not cached on RD${config.torBoxApiKey && !torBoxTriedFirst ? ', trying TorBox' : ''}`)
              } else if (rdErr instanceof ProviderUnavailableError) {
                rdTransientFailures += 1
                const retryable = !isNonRetryableRdError(rdErr) && rdTransientFailures < MAX_RD_TRANSIENT_FAILURES
                if (retryable) {
                  app.log.warn(
                    `play: RD error for providerOrder=${providerOrder} hash ${hashLabel}…: ${rdErr}; ` +
                    `trying next candidate (${rdTransientFailures}/${MAX_RD_TRANSIENT_FAILURES})`
                  )
                } else {
                  const terminalReason = terminalProviderHashFailureReason(rdErr)
                  if (terminalReason) failedRdHashes.set(normalizedHash, terminalReason)
                  app.log.warn(
                    `play: RD unavailable for ${label} after ${rdTransientFailures} failure${rdTransientFailures === 1 ? '' : 's'}: ${rdErr}` +
                    (config.torBoxApiKey && !torBoxTriedFirst ? '; falling back to TorBox' : '; not caching playback miss')
                  )
                  if (!config.torBoxApiKey || torBoxTriedFirst) {
                    throw new PlaybackResolutionError(
                      'Real-Debrid unavailable',
                      503,
                      { error: 'Real-Debrid unavailable', message: 'Real-Debrid Unavailable' },
                    )
                  }
                }
              } else {
                const terminalReason = terminalProviderHashFailureReason(rdErr)
                if (terminalReason) failedRdHashes.set(normalizedHash, terminalReason)
                app.log.warn(`play: hash ${hashLabel}… RD failed: ${rdErr}`)
              }
            }
          }
        }

        if (!resolved && config.torBoxApiKey && !torBoxTriedFirst) {
          const failedReason = failedTorBoxHashes.get(normalizedHash)
          if (failedReason) {
            app.log.info(`play: skipping TorBox hash ${hashLabel}… for ${label}, already failed: ${failedReason}`)
            continue
          }
          if (attemptedTorBoxResolutions.has(attemptKey)) {
            app.log.info(`play: skipping duplicate TorBox hash ${hashLabel}… for ${label}`)
            continue
          }
          attemptedTorBoxResolutions.add(attemptKey)
          try {
            resolved = await tbResolveStream(hash, hint)
            provider = 'TorBox'
          } catch (tbErr) {
            if (tbErr instanceof NotCachedError) {
              failedTorBoxHashes.set(normalizedHash, 'not cached')
              app.log.info(`play: hash ${hashLabel}… not cached on TorBox, trying next`)
              continue
            }
            if (tbErr instanceof ProviderUnavailableError) {
              tbTransientFailures += 1
              const retryable = !isNonRetryableRdError(tbErr) && tbTransientFailures < MAX_RD_TRANSIENT_FAILURES
              if (retryable) {
                app.log.warn(
                  `play: TorBox error for providerOrder=${providerOrder} hash ${hashLabel}…: ${tbErr}; ` +
                  `trying next candidate (${tbTransientFailures}/${MAX_RD_TRANSIENT_FAILURES})`
                )
                continue
              }
              const terminalReason = terminalProviderHashFailureReason(tbErr)
              if (terminalReason) failedTorBoxHashes.set(normalizedHash, terminalReason)
              app.log.warn(
                `play: TorBox unavailable for ${label} after ${tbTransientFailures} failure${tbTransientFailures === 1 ? '' : 's'}: ${tbErr}; ` +
                'not caching playback miss'
              )
              throw new PlaybackResolutionError(
                'Debrid provider unavailable',
                503,
                { error: 'Debrid provider unavailable', message: 'Debrid Unavailable' },
              )
            }
            const terminalReason = terminalProviderHashFailureReason(tbErr)
            if (terminalReason) failedTorBoxHashes.set(normalizedHash, terminalReason)
            app.log.warn(`play: hash ${hashLabel}… TorBox failed: ${tbErr}; trying next`)
            continue
          }
        }

        if (!resolved) continue

        if (!isVideoFile(resolved.filename)) {
          app.log.info(`play: skipping non-video file ${resolved.filename}, trying next`)
          continue
        }
        if (isLikelyBadResolvedFilename(resolved.filename)) {
          app.log.info(`play: skipping suspicious file ${resolved.filename}, trying next`)
          continue
        }
        if (
          config.englishStreamMode === 'require'
          && isRemoteAudioProbeUnreliable(resolved.filename)
          && !streamClearlyPreferredLanguage(stream)
        ) {
          app.log.info(`play: skipping unprobeable ${resolved.filename}, no confirmed preferred-language metadata`)
          continue
        }
        if (shouldProbePreferredAudio(stream, resolved.filename)) {
          try {
            const audioLanguages = await probeAudioLanguages(resolved.url)
            app.log.info(`play: ffprobe audio languages for ${resolved.filename}: ${audioLanguages.join(', ') || 'none'}`)
            const noLanguageInfo = audioLanguages.length === 0
            const allowsUndetermined = (hasOnlyUndeterminedAudio(audioLanguages) || noLanguageInfo) && !streamClearlyNonPreferredLanguage(stream)
            if (config.englishStreamMode === 'require' && !hasAudioLanguage(audioLanguages, config.preferredAudioLanguage) && !allowsUndetermined) {
              app.log.info(`play: skipping ${resolved.filename}, no preferred audio detected`)
              continue
            }
          } catch (err) {
            app.log.warn(`play: ffprobe failed for ${resolved.filename}: ${summarizeProbeError(err)}`)
          }
        }
        app.log.info(`play: ${provider} resolved ${resolved.filename} from hash ${hash.slice(0, 8)}…`)
        clearFailedPlay(cacheKey)
        return { url: resolved.url, filename: resolved.filename, bytes: resolved.bytes, sourceHash: hash, provider }
      } catch (err) {
        if (err instanceof PlaybackResolutionError) throw err
        app.log.warn(`play: hash ${hashLabel}… failed: ${err}; trying next`)
      }
    }
    app.log.warn(`play: no usable cached stream found for ${label}`)
    cacheFailedPlay(cacheKey, 'No cached stream available')
    throw new PlaybackResolutionError(
      'No cached stream available',
      404,
      { error: 'No cached stream available', message: 'No Cached Streams Found' },
    )
  }
  const best = config.englishStreamMode === 'require'
    ? (streams.find(stream => streamClearlyPreferredLanguage(stream)) ?? streams.find(stream => !streamClearlyNonPreferredLanguage(stream)))
    : streams[0]
  if (!best?.url) {
    cacheFailedPlay(cacheKey, 'No streams found')
    throw new PlaybackResolutionError(
      'No usable stream available',
      404,
      { error: 'No usable stream available', message: 'No Streams Found' },
    )
  }
  app.log.info(`play: fallback direct stream selected for ${label}`)
  clearFailedPlay(cacheKey)
  return { url: best.url }
}

function rememberPlaybackCandidate(playPath: string, label: string, stream: Stream, fileHint?: string): string {
  cleanupPlaybackPrewarmCache()
  const token = randomBytes(16).toString('hex')
  playbackCandidates.set(token, {
    stream,
    playPath,
    label,
    fileHint,
    expiresAt: Date.now() + PLAYBACK_CANDIDATE_TTL_MS,
  })
  return token
}

function getPlaybackCandidate(token: string | undefined, playPath: string) {
  cleanupPlaybackPrewarmCache()
  if (!token) return null
  const entry = playbackCandidates.get(token)
  if (!entry || entry.playPath !== playPath) return null
  return entry
}

function streamOptionName(stream: Stream, fallbackName: string, index: number): string {
  const text = rawStreamMetadataText(stream)
  const parsed = parseStreamMetadata(stream, text)
  const tokens = dedupeMediaSourceTokens([
    compactCacheLabel(stream),
    compactResolutionLabel(parsed, text),
    compactSourceLabel(parsed, text),
    compactCodecLabel(parsed, text),
    compactHdrLabel(parsed, text),
    compactFeatureLabel(parsed, text),
    compactAudioLabel(parsed, text),
    compactSizeLabel(stream, parsed),
    compactProviderLabel(stream, index),
  ])
  const compact = sanitizeMediaSourceText(tokens.join(' '))
  if (compact) return compact.slice(0, 64)
  const title = stremioFormattedStreamTitle(stream) || stream.description || stream.name || fallbackName
  return sanitizeMediaSourceText(title).slice(0, 64) || `Option ${index + 1}`
}

function rawStreamMetadataText(stream: Stream): string {
  const filename = typeof stream.behaviorHints?.filename === 'string' ? stream.behaviorHints.filename : ''
  return `${stream.name ?? ''} ${stream.title ?? ''} ${stream.description ?? ''} ${filename}`
}

function parseStreamMetadata(stream: Stream, fallbackText: string): ParsedTorrentTitleResult {
  const filename = typeof stream.behaviorHints?.filename === 'string' ? stream.behaviorHints.filename : ''
  const title = stremioFormattedStreamTitle(stream)
  const parseTarget = filename || title || fallbackText
  try {
    return parseTorrentTitle(parseTarget)
  } catch {
    return {}
  }
}

function dedupeMediaSourceTokens(tokens: Array<string | undefined>): string[] {
  const seen = new Set<string>()
  const compact: string[] = []
  for (const token of tokens) {
    if (!token) continue
    const key = token.toLowerCase().replace(/[^a-z0-9+]+/g, '')
    if (!key || seen.has(key)) continue
    seen.add(key)
    compact.push(token)
  }
  return compact
}

function compactProviderLabel(stream: Stream, index: number): string | undefined {
  const provider = streamProviderName(stream, index)
    .replace(/\bsearch\b/ig, '')
    .replace(/\bstreams?\b/ig, '')
    .replace(/\badd-?on\b/ig, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!provider || /^option\s+\d+$/i.test(provider)) return undefined
  if (/easy\s*news/i.test(provider)) return 'EasyNews'
  if (/zilean/i.test(provider)) return 'Zilean'
  if (/real[-\s]?debrid|\brd\b/i.test(provider)) return 'RealDebrid'
  if (/torbox|\btb\b/i.test(provider)) return 'TorBox'
  if (/torrentio/i.test(provider)) return 'Torrentio'
  if (/mediafusion/i.test(provider)) return 'MediaFusion'
  if (/aio\s*streams?/i.test(provider)) return 'AIOStreams'
  if (/knight\s*crawler/i.test(provider)) return 'KnightCrawler'
  if (/jackettio|jackett/i.test(provider)) return 'Jackettio'
  if (/comet/i.test(provider)) return 'Comet'
  if (/annatar/i.test(provider)) return 'Annatar'
  if (/orion/i.test(provider)) return 'Orion'
  if (/peerflix/i.test(provider)) return 'Peerflix'
  if (/debridio/i.test(provider)) return 'Debridio'
  if (/strem\s*thru/i.test(provider)) return 'StremThru'
  if (/easy\s*debrid/i.test(provider)) return 'EasyDebrid'
  if (/all\s*debrid/i.test(provider)) return 'AllDebrid'
  if (/premiumize/i.test(provider)) return 'Premiumize'
  if (/debrid[-\s]?link/i.test(provider)) return 'DebridLink'
  if (/put\.?io/i.test(provider)) return 'Putio'
  return provider.split(/[/:|-]/)[0]?.trim().slice(0, 14) || undefined
}

function compactCacheLabel(stream: Stream): string | undefined {
  const text = `${rawStreamMetadataText(stream)} ${stream.url ?? ''} ${(stream.sources ?? []).join(' ')}`.toLowerCase()
  if (/\[(?:rd|tb)\s+download\]|\bnot\s+ready\b|\buncached\b|⏳/.test(text)) return '⏳'
  return undefined
}

function compactResolutionLabel(parsed: ParsedTorrentTitleResult, text: string): string | undefined {
  const resolution = parsed.resolution ?? ''
  if (/\b(2160p|4k|uhd)\b/i.test(`${resolution} ${text}`)) return '4K'
  if (/\b1440p\b/i.test(`${resolution} ${text}`)) return '1440p'
  if (/\b1080p\b/i.test(`${resolution} ${text}`)) return '1080p'
  if (/\b720p\b/i.test(`${resolution} ${text}`)) return '720p'
  if (/\b576p\b/i.test(`${resolution} ${text}`)) return '576p'
  if (/\b480p\b/i.test(`${resolution} ${text}`)) return '480p'
  return normalizedResolutionLabel(text)
}

function compactSourceLabel(parsed: ParsedTorrentTitleResult, text: string): string | undefined {
  const quality = parsed.quality ?? ''
  const combined = `${quality} ${text}`
  if (/\bremux\b/i.test(combined)) return 'Remux'
  if (/\buntouched\b/i.test(combined)) return 'Untouched'
  if (/\bblu[ ._-]?ray\b|\bbdrip\b|\bbdremux\b/i.test(combined)) return 'BD'
  if (/\bweb[ ._-]?dl\b/i.test(combined)) return 'WEB'
  if (/\bweb[ ._-]?rip\b/i.test(combined)) return 'WEBRip'
  if (/\bdvd[ ._-]?rip\b|\bdvdrip\b|\bdvd\b/i.test(combined)) return 'DVD'
  if (/\bhdrip\b/i.test(combined)) return 'HDRip'
  if (/\bhdtv\b/i.test(combined)) return 'HDTV'
  return undefined
}

function compactCodecLabel(parsed: ParsedTorrentTitleResult, text: string): string | undefined {
  const codec = parsed.codec ?? ''
  const combined = `${codec} ${text}`
  if (/\bav1\b/i.test(combined)) return 'AV1'
  if (/\bhevc\b|h\.?265\b|x265\b/i.test(combined)) return 'HEVC'
  if (/\bh\.?264\b|x264\b|avc\b/i.test(combined)) return 'H264'
  if (/\bvc[- .]?1\b/i.test(combined)) return 'VC1'
  if (/\bxvid\b/i.test(combined)) return 'XviD'
  return undefined
}

function compactHdrLabel(parsed: ParsedTorrentTitleResult, text: string): string | undefined {
  const hdr = (parsed.hdr ?? []).join(' ')
  const combined = `${hdr} ${text}`
  if (/\b(?:dolby[ ._-]?vision|dovi|dv)\b/i.test(combined)) return 'DV'
  if (/\bhdr10\+\b/i.test(combined)) return 'HDR10+'
  if (/\bhdr10\b/i.test(combined)) return 'HDR10'
  if (/\bhdr\b/i.test(combined)) return 'HDR'
  if (/\bsdr\b/i.test(combined)) return 'SDR'
  return undefined
}

function compactFeatureLabel(parsed: ParsedTorrentTitleResult, text: string): string | undefined {
  const editions = (parsed.editions ?? []).join(' ')
  const combined = `${editions} ${text}`
  if (/\bimax\b/i.test(combined)) return 'IMAX'
  if (parsed.upscaled || /\bai[ ._-]*upscale(?:d)?\b|\bupscale(?:d)?\b|\btopaz\b|\brealesrgan\b|\bai\b/i.test(combined)) return 'AI'
  return undefined
}

function compactAudioLabel(parsed: ParsedTorrentTitleResult, text: string): string | undefined {
  const audio = (parsed.audio ?? []).join(' ')
  const combined = `${audio} ${text}`
  if (/\batmos\b/i.test(combined)) return 'Atmos'
  if (/\btruehd\b/i.test(combined)) return 'TrueHD'
  if (/\bdts[ ._-]?x\b/i.test(combined)) return 'DTS-X'
  if (/\bdts[ ._-]?hd\b|\bdts\s+lossless\b/i.test(combined)) return 'DTS-HD'
  if (/\bdd\+|\be-?ac-?3\b/i.test(combined)) return 'DD+'
  if (/\bdolby[ ._-]?digital\b|\bdd\b|\bac3\b/i.test(combined)) return 'DD'
  if (/\bflac\b/i.test(combined)) return 'FLAC'
  if (/\baac\b/i.test(combined)) return 'AAC'
  return undefined
}

function compactSizeLabel(stream: Stream, parsed?: ParsedTorrentTitleResult): string | undefined {
  const nbsp = '\u202F'
  const bytes = streamSizeBytes(stream)
  if (bytes && bytes > 0) {
    if (bytes >= 1e12) return `${Math.round(bytes / 1e11) / 10}${nbsp}TB`
    if (bytes >= 1e9) return `${Math.round(bytes / 1e9)}${nbsp}GB`
    if (bytes >= 1e6) return `${Math.round(bytes / 1e6)}${nbsp}MB`
    if (bytes >= 1e3) return `${Math.round(bytes / 1e3)}${nbsp}KB`
    return `${bytes}${nbsp}B`
  }
  const size = parsed?.size?.match(/(\d+(?:\.\d+)?)\s*(TB|GB|MB|KB|B)/i)
  if (!size) return undefined
  const value = Number.parseFloat(size[1])
  if (!Number.isFinite(value)) return undefined
  return `${Math.round(value)}${nbsp}${size[2].toUpperCase()}`
}

function stremioFormattedStreamTitle(stream: Stream): string {
  const filename = typeof stream.behaviorHints?.filename === 'string' ? stream.behaviorHints.filename : ''
  const title = stream.title || ''
  if (!title) return ''
  return title
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && (!filename || !line.includes(filename)))
    .join(' ')
}

function streamProviderName(stream: Stream, index: number): string {
  const name = stream.name ?? ''
  const bracket = name.match(/^\[[^\]]+\]\s*([^0-9\n\r]+)/)
  if (bracket?.[1]?.trim()) return bracket[1].trim()
  if (name.trim()) return name.trim()
  if (stream.providerLabel) return stream.providerLabel.replace(/^provider#\d+\s+/, '').split('/')[0] || `Option ${index + 1}`
  return `Option ${index + 1}`
}

function normalizedResolutionLabel(text: string): string | undefined {
  if (/\b(2160p|4k|uhd)\b/i.test(text)) return '2160p'
  if (/\b1080p\b/i.test(text)) return '1080p'
  if (/\b720p\b/i.test(text)) return '720p'
  if (/\b480p\b/i.test(text)) return '480p'
  return undefined
}

function normalizedSourceLabel(text: string): string | undefined {
  if (/\bremux\b/i.test(text)) return 'REMUX'
  if (/\bblu[ -]?ray\b|\bbdrip\b/i.test(text)) return 'BluRay'
  if (/\bweb[ ._-]?dl\b/i.test(text)) return 'WEB-DL'
  if (/\bweb[ ._-]?rip\b/i.test(text)) return 'WEBRip'
  if (/\bhdtv\b/i.test(text)) return 'HDTV'
  return undefined
}

function normalizedCodecLabel(text: string): string | undefined {
  if (/\bav1\b/i.test(text)) return 'AV1'
  if (/\bhevc\b|h\.?265\b|x265\b/i.test(text)) return 'HEVC'
  if (/\bh\.?264\b|x264\b|avc\b/i.test(text)) return 'H.264'
  return undefined
}

type StreamResolutionBucket = '2160p' | '1080p' | '720p' | '480p' | 'unknown'
type StreamCodecBucket = 'h265' | 'h264' | 'av1' | 'other'
type StreamVarietyKey = `${StreamResolutionBucket}:${StreamCodecBucket}`

const STREAM_VARIETY_KEY_PRIORITY: StreamVarietyKey[] = [
  '2160p:h265',
  '2160p:h264',
  '1080p:h265',
  '1080p:h264',
  '2160p:av1',
  '1080p:av1',
  '2160p:other',
  '1080p:other',
  '720p:h265',
  '720p:h264',
  '720p:av1',
  '720p:other',
  '480p:h265',
  '480p:h264',
  '480p:av1',
  '480p:other',
  'unknown:h265',
  'unknown:h264',
  'unknown:av1',
  'unknown:other',
]

function streamResolutionBucket(stream: Stream): StreamResolutionBucket {
  const text = streamMetadataText(stream)
  if (/\b(2160p|4k|uhd)\b/i.test(text)) return '2160p'
  if (/\b1080p\b/i.test(text)) return '1080p'
  if (/\b720p\b/i.test(text)) return '720p'
  if (/\b480p\b/i.test(text)) return '480p'
  return 'unknown'
}

function streamCodecBucket(stream: Stream): StreamCodecBucket {
  const text = streamMetadataText(stream)
  if (/\bhevc\b|h\.?265\b|x265\b/i.test(text)) return 'h265'
  if (/\bh\.?264\b|x264\b|avc\b/i.test(text)) return 'h264'
  if (/\bav1\b/i.test(text)) return 'av1'
  return 'other'
}

function streamVarietyKey(stream: Stream): StreamVarietyKey {
  return `${streamResolutionBucket(stream)}:${streamCodecBucket(stream)}`
}

function selectPlaybackMediaSourceStreams(streams: Stream[], limit: number): Stream[] {
  if (limit <= 0) return []
  if (streams.length <= limit) return streams

  const buckets = new Map<StreamVarietyKey, Stream[]>()
  const firstSeenKeys: StreamVarietyKey[] = []
  for (const stream of streams) {
    const key = streamVarietyKey(stream)
    const bucket = buckets.get(key)
    if (bucket) {
      bucket.push(stream)
    } else {
      buckets.set(key, [stream])
      firstSeenKeys.push(key)
    }
  }

  const priorityKeys = [
    ...STREAM_VARIETY_KEY_PRIORITY.filter(key => buckets.has(key)),
    ...firstSeenKeys.filter(key => !STREAM_VARIETY_KEY_PRIORITY.includes(key)),
  ]
  const selected: Stream[] = []
  const selectedStreams = new Set<Stream>()

  while (selected.length < limit) {
    let addedInRound = false
    for (const key of priorityKeys) {
      const bucket = buckets.get(key)
      const stream = bucket?.shift()
      if (!stream || selectedStreams.has(stream)) continue
      selected.push(stream)
      selectedStreams.add(stream)
      addedInRound = true
      if (selected.length >= limit) break
    }
    if (!addedInRound) break
  }

  if (selected.length < limit) {
    for (const stream of streams) {
      if (selectedStreams.has(stream)) continue
      selected.push(stream)
      selectedStreams.add(stream)
      if (selected.length >= limit) break
    }
  }

  return selected
}

function streamBitrateSortValue(stream: Stream, runtimeTicks: number): number {
  return streamBitrate(streamSizeBytes(stream), runtimeTicks) ?? 0
}

function sortPlaybackMediaSourceStreamsByBitrate(streams: Stream[], runtimeTicks: number): Stream[] {
  return streams
    .map((stream, index) => ({
      stream,
      index,
      bitrate: streamBitrateSortValue(stream, runtimeTicks),
    }))
    .sort((a, b) => b.bitrate - a.bitrate || a.index - b.index)
    .map(entry => entry.stream)
}

function sanitizeMediaSourceText(value: string): string {
  return value
    .replace(/[\uD800-\uDFFF]/g, '')
    .replace(/[ \t\r\n\f\v\u00A0]+/g, ' ')
    .trim()
}

function appendCandidateToSignedUrl(url: string, candidate: string): string {
  const signed = new URL(url)
  signed.searchParams.set('candidate', candidate)
  return signed.toString()
}

function streamSizeBytes(stream: Stream): number | undefined {
  if (typeof stream.behaviorHints?.videoSize === 'number' && Number.isFinite(stream.behaviorHints.videoSize)) {
    return stream.behaviorHints.videoSize
  }
  const match = `${stream.name} ${stream.title} ${stream.description ?? ''}`.match(/(\d+(?:\.\d+)?)\s*(TB|GB|MB|KB)/i)
  if (!match) return undefined
  const value = Number.parseFloat(match[1])
  switch (match[2].toUpperCase()) {
    case 'TB': return Math.round(value * 1e12)
    case 'GB': return Math.round(value * 1e9)
    case 'MB': return Math.round(value * 1e6)
    case 'KB': return Math.round(value * 1e3)
    default: return undefined
  }
}

function streamContainer(stream: Stream): string {
  const text = streamMetadataText(stream)
  const match = text.match(/\.(mkv|mp4|m4v|avi|mov|wmv|webm|ts|m2ts)(?:\b|$)/i)
  return (match?.[1] ?? 'mkv').toLowerCase()
}

function streamVideoCodec(stream: Stream): string {
  const text = streamMetadataText(stream)
  if (/\bav1\b/i.test(text)) return 'av1'
  if (/\bhevc\b|h\.?265\b|x265\b/i.test(text)) return 'hevc'
  if (/\bh\.?264\b|x264\b|avc\b/i.test(text)) return 'h264'
  return 'h264'
}

function streamVideoDimensions(stream: Stream): { width: number; height: number } {
  const text = streamMetadataText(stream)
  if (/\b(2160p|4k|uhd)\b/i.test(text)) return { width: 3840, height: 2160 }
  if (/\b1080p\b/i.test(text)) return { width: 1920, height: 1080 }
  if (/\b720p\b/i.test(text)) return { width: 1280, height: 720 }
  if (/\b480p\b/i.test(text)) return { width: 854, height: 480 }
  return { width: 1920, height: 1080 }
}

function streamBitrate(sizeBytes: number | undefined, runtimeTicks: number): number | undefined {
  if (!sizeBytes || runtimeTicks <= 0) return undefined
  const seconds = runtimeTicks / 10_000_000
  if (seconds <= 0) return undefined
  return Math.round((sizeBytes * 8) / seconds)
}

function playbackMediaSource(id: string, name: string, path: string, runtimeTicks: number, stream?: Stream) {
  const size = stream ? streamSizeBytes(stream) : undefined
  const bitrate = streamBitrate(size, runtimeTicks)
  const { width, height } = stream ? streamVideoDimensions(stream) : { width: 1920, height: 1080 }
  const videoCodec = stream ? streamVideoCodec(stream) : 'h264'
  const container = stream ? streamContainer(stream) : 'mkv'
  return {
    Id:                   id,
    Name:                 name,
    Type:                 'Default',
    Protocol:             'Http',
    Path:                 path,
    IsRemote:             true,
    SupportsDirectPlay:   true,
    SupportsDirectStream: true,
    SupportsTranscoding:  false,
    RequiresOpening:      false,
    RequiresClosing:      false,
    Container:            container,
    Size:                 size,
    Bitrate:              bitrate,
    VideoType:            'VideoFile',
    RunTimeTicks:         runtimeTicks,
    DefaultAudioStreamIndex: 1,
    MediaStreams: [
      {
        Type: 'Video',
        Index: 0,
        Codec: videoCodec,
        IsDefault: true,
        Width: width,
        Height: height,
        BitRate: bitrate,
        RealFrameRate: 23.976,
        AverageFrameRate: 23.976,
      },
      { Type: 'Audio', Index: 1, Codec: 'aac', IsDefault: true, Language: 'eng' },
    ],
  }
}

async function playbackStreamsForPath(playPath: string, playbackClient: string): Promise<{ streams: Stream[]; label: string; fileHint?: string }> {
  const stremioMatch = playPath.match(/^\/play\/stremio\/(movie|series)\/(.+)$/)
  if (stremioMatch) {
    const mediaType = stremioMatch[1] as StremioMediaType
    const externalId = decodeURIComponent(stremioMatch[2])
    return {
      streams: await fetchRankedStremioStreams(mediaType, externalId, undefined, config.preferredAudioLanguage, '', playbackClient, true),
      label: `${mediaType} ${externalId}`,
    }
  }

  const episodeMatch = playPath.match(/^\/play\/([^/]+)\/(\d+)\/(\d+)$/)
  if (episodeMatch) {
    const imdbId = episodeMatch[1]
    const season = Number.parseInt(episodeMatch[2], 10)
    const episodeNumber = Number.parseInt(episodeMatch[3], 10)
    const show = getShowByImdbId(imdbId)
    const episode = show
      ? getEpisodesForSeason(show.tmdbId, season).find(ep => ep.episodeNumber === episodeNumber)
      : null
    const episodeAirYear = episode?.airDate ? Number.parseInt(episode.airDate.slice(0, 4), 10) : undefined
    return {
      streams: await fetchRankedEpisodeStreams(
        imdbId,
        season,
        episodeNumber,
        show?.year || undefined,
        Number.isFinite(episodeAirYear) ? episodeAirYear : undefined,
        config.preferredAudioLanguage,
        '',
        playbackClient,
        true,
      ),
      label: `${imdbId} S${season}E${episodeNumber}`,
      fileHint: `s${pad2(season)}e${pad2(episodeNumber)}`,
    }
  }

  const movieMatch = playPath.match(/^\/play\/([^/]+)$/)
  if (movieMatch) {
    const imdbId = movieMatch[1]
    return {
      streams: await fetchRankedStreams(imdbId, config.preferredAudioLanguage, '', playbackClient, true),
      label: imdbId,
    }
  }

  throw new Error(`Unsupported play path: ${playPath}`)
}

async function buildPlaybackMediaSources(input: {
  itemId: string
  sourceId: string
  origin: string
  playPath: string
  name: string
  runtimeTicks: number
  playbackClient: string
}) {
  const fallbackUrl = createSignedPlaybackUrl(input.origin, input.playPath)
  const fallbackSource = playbackMediaSource(input.sourceId, input.name, fallbackUrl, input.runtimeTicks)

  try {
    const { streams, label, fileHint } = await playbackStreamsForPath(input.playPath, input.playbackClient)
    const bitrateSorted = sortPlaybackMediaSourceStreamsByBitrate(
      streams.filter(stream => (stream.url || extractHashFromStream(stream)) && streamEligibleForMediaSourceSelection(stream)),
      input.runtimeTicks,
    )
    const usable = sortPlaybackMediaSourceStreamsByBitrate(
      selectPlaybackMediaSourceStreams(bitrateSorted, config.mediaSourceLimit),
      input.runtimeTicks,
    )

    if (!usable.length) return [fallbackSource]

    return usable.map((stream, index) => {
      const candidate = rememberPlaybackCandidate(input.playPath, label, stream, fileHint)
      const sourceId = `${input.itemId}:candidate:${candidate}`
      const sourceName = streamOptionName(stream, input.name, index)
      return playbackMediaSource(
        sourceId,
        sourceName,
        appendCandidateToSignedUrl(createSignedPlaybackUrl(input.origin, input.playPath), candidate),
        input.runtimeTicks,
        stream,
      )
    })
  } catch (err) {
    app.log.warn(`playback: failed to build stream options for ${input.name}: ${err}`)
    return [fallbackSource]
  }
}

async function resolveMoviePlayback(imdbId: string, playbackClient = ''): Promise<PlayResolution> {
  const playPath = `/play/${imdbId}`
  const streams = await fetchRankedStreams(imdbId, config.preferredAudioLanguage, '', playbackClient, true)
  return resolvePlayableStream(streams, imdbId, playPath, undefined, true)
}

async function resolveStremioPlayback(mediaType: StremioMediaType, externalId: string, playbackClient = ''): Promise<PlayResolution> {
  const playPath = `/play/stremio/${mediaType}/${encodeURIComponent(externalId)}`
  const streams = await fetchRankedStremioStreams(mediaType, externalId, undefined, config.preferredAudioLanguage, '', playbackClient, true)
  return resolvePlayableStream(streams, `${mediaType} ${externalId}`, playPath, undefined, true)
}

async function resolveEpisodePlayback(imdbId: string, season: number, episodeNumber: number, playbackClient = ''): Promise<PlayResolution> {
  const playPath = `/play/${imdbId}/${season}/${episodeNumber}`
  const show = getShowByImdbId(imdbId)
  const episode = show
    ? getEpisodesForSeason(show.tmdbId, season).find(ep => ep.episodeNumber === episodeNumber)
    : null
  if (episode && !isEpisodeVisibleToLibrary(episode)) {
    throw new PlaybackResolutionError(
      'Episode not yet available',
      409,
      { error: 'Episode not yet available', message: 'Not Yet Aired' },
    )
  }
  const episodeAirYear = episode?.airDate ? Number.parseInt(episode.airDate.slice(0, 4), 10) : undefined
  const streams = await fetchRankedEpisodeStreams(
    imdbId,
    season,
    episodeNumber,
    show?.year || undefined,
    Number.isFinite(episodeAirYear) ? episodeAirYear : undefined,
    config.preferredAudioLanguage,
    '',
    playbackClient,
    true,
  )
  return resolvePlayableStream(
    streams,
    `${imdbId} S${season}E${episodeNumber}`,
    playPath,
    `s${pad2(season)}e${pad2(episodeNumber)}`,
    true,
  )
}

async function resolvePlaybackCandidate(token: string | undefined, playPath: string): Promise<PlayResolution | null> {
  const candidate = getPlaybackCandidate(token, playPath)
  if (!candidate) return null
  app.log.info(`play: resolving selected candidate for ${candidate.label}`)
  return resolvePlayableStream(
    [candidate.stream],
    candidate.label,
    `${playPath}:candidate:${token}`,
    candidate.fileHint,
    true,
  )
}

app.get('/play/stremio/:mediaType/:externalId', async (req, reply) => {
  const { mediaType, externalId } = req.params as { mediaType: StremioMediaType; externalId: string }
  const query = req.query as { token?: string; expires?: string; candidate?: string } | undefined
  if (mediaType !== 'movie' && mediaType !== 'series') {
    return reply.code(404).send({ error: 'Unsupported Stremio media type' })
  }
  let decodedExternalId: string
  try { decodedExternalId = decodeURIComponent(externalId) }
  catch { return reply.code(400).send({ error: 'Invalid external ID encoding' }) }
  const playPath = `/play/stremio/${mediaType}/${encodeURIComponent(decodedExternalId)}`
  if (!verifySignedPlaybackPath(playPath, query?.token, query?.expires)) {
    if (!requestPlaybackUser(req.headers)) {
      app.log.warn(`play: rejected unauthenticated Stremio playback request for ${mediaType} ${decodedExternalId}`)
    } else {
      app.log.warn(`play: rejected unsigned or expired Stremio playback request for ${mediaType} ${decodedExternalId}`)
    }
    return reply.code(401).send({ error: 'Unauthorized' })
  }
  const failedReason = getFailedPlayReason(playPath)
  if (failedReason) {
    app.log.info(`play: cached miss for Stremio ${mediaType} ${decodedExternalId} (${failedReason})`)
    return reply.code(404).send({ error: failedReason, message: 'No Streams Found' })
  }
  try {
    const label = `Stremio ${mediaType} ${decodedExternalId}`
    const clientName = playbackClientName(playPath)
    const selectedCandidate = await resolvePlaybackCandidate(query?.candidate, playPath)
    const resolved = selectedCandidate ?? await (async () => {
      const { promise, reused } = getOrCreatePlaybackResolution(playPath, label, () => resolveStremioPlayback(mediaType, decodedExternalId, clientName))
      if (reused) app.log.info(`play: using in-flight resolver for ${label}`)
      return promise
    })()
    rememberTorBoxPlaybackUrl(playPath, resolved)
    return reply.redirect(resolved.url, 302)
  } catch (err) {
    if (err instanceof PlaybackResolutionError) {
      return reply.code(err.statusCode).send(err.response)
    }
    app.log.warn(`play: no Stremio stream for ${mediaType} ${decodedExternalId}: ${err}`)
    cacheFailedPlay(playPath, 'No streams found')
    return reply.code(404).send({ error: 'No stream available', message: 'No Streams Found' })
  }
})

app.get('/play/:imdbId', async (req, reply) => {
  const { imdbId } = req.params as { imdbId: string }
  const query = req.query as { token?: string; expires?: string; candidate?: string } | undefined
  const playPath = `/play/${imdbId}`
  if (!verifySignedPlaybackPath(playPath, query?.token, query?.expires)) {
    if (!requestPlaybackUser(req.headers)) {
      app.log.warn(`play: rejected unauthenticated playback request for ${imdbId}`)
    } else {
      app.log.warn(`play: rejected unsigned or expired playback request for ${imdbId}`)
    }
    return reply.code(401).send({ error: 'Unauthorized' })
  }
  const failedReason = getFailedPlayReason(playPath)
  if (failedReason) {
    app.log.info(`play: cached miss for ${imdbId} (${failedReason})`)
    return reply.code(404).send({ error: failedReason, message: 'No Streams Found' })
  }
  app.log.info(`play: resolving stream for ${imdbId}`)
  try {
    const clientName = playbackClientName(playPath)
    const selectedCandidate = await resolvePlaybackCandidate(query?.candidate, playPath)
    const resolved = selectedCandidate ?? await (async () => {
      const { promise, reused } = getOrCreatePlaybackResolution(playPath, imdbId, () => resolveMoviePlayback(imdbId, clientName))
      if (reused) app.log.info(`play: using in-flight resolver for ${imdbId}`)
      return promise
    })()
    rememberTorBoxPlaybackUrl(playPath, resolved)
    return reply.redirect(resolved.url, 302)
  } catch (err) {
    if (err instanceof PlaybackResolutionError) {
      return reply.code(err.statusCode).send(err.response)
    }
    app.log.warn(`play: no stream for ${imdbId}: ${err}`)
    cacheFailedPlay(playPath, 'No streams found')
    return reply.code(404).send({ error: 'No stream available', message: 'No Streams Found' })
  }
})

app.get('/play/:imdbId/:season/:episode', async (req, reply) => {
  const { imdbId, season, episode } = req.params as { imdbId: string; season: string; episode: string }
  const query = req.query as { token?: string; expires?: string; candidate?: string } | undefined
  const playPath = `/play/${imdbId}/${season}/${episode}`
  if (!verifySignedPlaybackPath(playPath, query?.token, query?.expires)) {
    if (!requestPlaybackUser(req.headers)) {
      app.log.warn(`play: rejected unauthenticated episode playback request for ${imdbId} S${season}E${episode}`)
    } else {
      app.log.warn(`play: rejected unsigned or expired episode playback request for ${imdbId} S${season}E${episode}`)
    }
    return reply.code(401).send({ error: 'Unauthorized' })
  }
  const failedReason = getFailedPlayReason(playPath)
  if (failedReason) {
    app.log.info(`play: cached miss for ${imdbId} S${season}E${episode} (${failedReason})`)
    return reply.code(404).send({ error: failedReason, message: 'No Streams Found' })
  }
  const s = parseInt(season)
  const e = parseInt(episode)
  app.log.info(`play: resolving episode stream for ${imdbId} S${s}E${e}`)
  try {
    const label = `${imdbId} S${s}E${e}`
    const clientName = playbackClientName(playPath)
    const selectedCandidate = await resolvePlaybackCandidate(query?.candidate, playPath)
    const resolved = selectedCandidate ?? await (async () => {
      const { promise, reused } = getOrCreatePlaybackResolution(playPath, label, () => resolveEpisodePlayback(imdbId, s, e, clientName))
      if (reused) app.log.info(`play: using in-flight resolver for ${label}`)
      return promise
    })()
    rememberTorBoxPlaybackUrl(playPath, resolved)
    return reply.redirect(resolved.url, 302)
  } catch (err) {
    if (err instanceof PlaybackResolutionError) {
      return reply.code(err.statusCode).send(err.response)
    }
    app.log.warn(`play: no stream for ${imdbId} S${s}E${e}: ${err}`)
    cacheFailedPlay(playPath, 'No streams found')
    return reply.code(404).send({ error: 'No stream available', message: 'No Streams Found' })
  }
})

await app.register(jellyfinRoutes, { prewarmPlayback, registerPlaybackItem, registerPlaybackClient, touchPlaybackItem, stopPlaybackItem, buildPlaybackMediaSources })
await app.register(jellyfinRoutes, { prefix: '/emby', prewarmPlayback, registerPlaybackItem, registerPlaybackClient, touchPlaybackItem, stopPlaybackItem, buildPlaybackMediaSources })
await app.register(uiRoutes)

// ── Trakt auth ────────────────────────────────────────────────────────────────

// GET /trakt/auth — check auth status
app.get('/trakt/auth', async (req, reply) => {
  if (!requireAdminUiSession(req as never, reply as never)) return
  return tokenStatus()
})

// POST /trakt/auth — start device flow
// Returns the code + URL to visit. Polls in background; token saved when approved.
app.post('/trakt/auth', async (req, reply) => {
  if (!requireAdminUiSession(req as never, reply as never)) return
  try {
    const { instructions, approved } = await startDeviceAuth()
    app.log.info(`trakt: device auth started — visit ${instructions.verificationUrl} and enter code: ${instructions.userCode}`)
    // Background: save token when user approves
    approved
      .then(async () => {
        app.log.info('trakt: OAuth approved, starting watchlist sync')
        await runSync()
      })
      .catch(err => app.log.error(`trakt: device auth failed: ${err}`))
    return {
      message:         `Visit ${instructions.verificationUrl} and enter this code`,
      code:            instructions.userCode,
      verificationUrl: instructions.verificationUrl,
      expiresInSecs:   instructions.expiresIn,
    }
  } catch (err) {
    return reply.code(500).send({ error: String(err) })
  }
})

// ── Manual sync ───────────────────────────────────────────────────────────────
// POST /sync  — re-fetch Trakt watchlist and update the DB in the background.

app.post('/sync', async (req, reply) => {
  if (!requireAdminUiSession(req as never, reply as never)) return
  runSync().catch(err => app.log.error(`Manual sync failed: ${err}`))
  return { status: 'sync started' }
})

let currentSync: Promise<void> | null = null

// Sync on startup, then every 60 minutes
async function runSyncInternal() {
  if (config.traktWatchlistMovies) {
    await syncTraktWatchlist()
  } else {
    const removed = removeSourceKey('trakt:watchlist:movies', 'movie')
    const pruned = pruneAllOrphanedMovies()
    if (removed.length || pruned) {
      app.log.info(`sync: movie watchlist disabled; removed ${removed.length} source items and pruned ${pruned} movies`)
    }
  }

  if (config.traktWatchlistShows) {
    await syncTraktShowsWatchlist()
  } else {
    const removed = removeSourceKey('trakt:watchlist:shows', 'show')
    const pruned = pruneAllOrphanedShows()
    if (removed.length || pruned) {
      app.log.info(`sync: show watchlist disabled; removed ${removed.length} source items and pruned ${pruned} shows`)
    }
  }

  for (const slug of config.traktLists) {
    await syncTraktList(slug).catch(err => app.log.error(`List sync "${slug}" failed: ${err}`))
  }
  if (config.traktWatchHistory) {
    await syncTraktWatchedStatus().catch(err => app.log.error(`Watched-status sync failed: ${err}`))
  }
  const staleListCleanup = cleanupRemovedTraktListSources(config.traktLists)
  if (staleListCleanup.removedSourceKeys.length) {
    app.log.warn(
      `sync: removed stale Trakt list sources — ${staleListCleanup.removedSourceKeys.join(', ')}; ` +
      `${staleListCleanup.prunedMovies} movies pruned, ${staleListCleanup.prunedShows} shows pruned`
    )
  }

  for (const entry of config.mdblistLists) {
    await syncMdblistList(entry.url).catch(err => app.log.error(`MDBList sync "${entry.url}" failed: ${err}`))
  }
  const staleMdblistCleanup = cleanupRemovedMdblistListSources(config.mdblistLists.map(e => e.url))
  if (staleMdblistCleanup.removedSourceKeys.length) {
    app.log.warn(
      `sync: removed stale MDBList sources — ${staleMdblistCleanup.removedSourceKeys.join(', ')}; ` +
      `${staleMdblistCleanup.prunedMovies} movies pruned, ${staleMdblistCleanup.prunedShows} shows pruned`
    )
  }

  // Refresh metadata (e.g. backdrop_path) for movies missing it
  const movies = listMovies({ limit: 100_000 })
  for (const movie of movies) {
    await refreshMovieMetadataIfNeeded(movie).catch(() => {})
  }

  // Also refresh metadata (e.g. backdrop_path) for shows missing it
  const shows = listShows({ limit: 100_000 })
  for (const show of shows) {
    await refreshShowMetadataIfNeeded(show).catch(() => {})
    await ensureShowSeasonsCached(show).catch(err =>
      app.log.warn(`Season fetch failed for "${show.title}": ${err}`)
    )
  }

  const latestSeasonSubs = listLatestSeasonShowSubscriptions()
  for (const sub of latestSeasonSubs) {
    const latestSeasonNumber = getLatestSeasonNumberForShow(sub.showTmdbId)
    if (latestSeasonNumber && latestSeasonNumber !== sub.activeSeasonNumber) {
      upsertManualShowSubscription(sub.showTmdbId, 'latest', latestSeasonNumber)
    }
  }

  const prunedMovies = pruneAllOrphanedMovies()
  const prunedShows = pruneAllOrphanedShows()
  if (prunedMovies || prunedShows) {
    app.log.warn(`sync: pruned orphaned rows — ${prunedMovies} movies, ${prunedShows} shows`)
  }

  markSyncComplete()

}

function runSync(): Promise<void> {
  if (currentSync) {
    app.log.info('sync: already in progress, reusing existing run')
    return currentSync
  }
  currentSync = runSyncInternal()
    .catch(err => {
      app.log.error(`Sync failed: ${err}`)
      throw err
    })
    .finally(() => {
      currentSync = null
    })
  return currentSync
}

runSync().catch(err => app.log.error(`Startup sync failed: ${err}`))
setInterval(
  () => runSync().catch(err => app.log.error(`Scheduled sync failed: ${err}`)),
  60 * 60 * 1000,
)

await app.listen({ port: config.port, host: config.host })
