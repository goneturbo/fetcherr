import Fastify from 'fastify'
import { config, normalizeSootioUrl, parseBooleanSetting, parseEnglishStreamMode, parseMovieReleaseMode, parseShowAddDefaultMode, parseStreamProviderUrls, parseTraktLists } from './config.js'
import { getDb, getAllSettings } from './db.js'
import { jellyfinRoutes, resolveJellyfinUser } from './jellyfin/index.js'
import { castRoutes } from './cast/routes.js'
import { initCastSchema } from './cast/db.js'
import { uiRoutes } from './ui/routes.js'
import { wrapFastifyLogger } from './logger.js'
import { markSyncComplete } from './sync-state.js'
import { cleanupRemovedTraktListSources, syncTraktWatchlist, syncTraktShowsWatchlist, syncTraktList, syncTraktWatchedStatus, startDeviceAuth, tokenStatus } from './trakt.js'
import { fetchRankedStreams, fetchRankedEpisodeStreams, extractHashFromStream } from './sootio.js'
import { resolveStream, probeAudioLanguages, NotCachedError } from './rd.js'
import { getMovieByTmdbId, getShowByImdbId, getEpisodesForSeason, getLatestSeasonNumberForShow, listLatestSeasonShowSubscriptions, listMovies, listShows, pruneAllOrphanedMovies, pruneAllOrphanedShows, removeSourceKey, upsertManualShowSubscription } from './db.js'
import { ensureShowSeasonsCached, refreshShowMetadataIfNeeded, refreshMovieMetadataIfNeeded } from './tmdb.js'
import { getSessionUser, getTokenFromCookie, isUiAuthConfigured, isValidSession } from './ui/auth.js'
import { verifySignedPlaybackPath } from './play-auth.js'
import { hasEnglishAudioMarker, hasNonEnglishAudioMarker } from './streamLanguage.js'

const app = Fastify({
  logger: { level: 'info' },
  trustProxy: true,
  routerOptions: { ignoreTrailingSlash: true },
  rewriteUrl: (req) => req.url!.replace(/\/\/+/g, '/'),
})

// Initialise DB
getDb()
initCastSchema()

// Apply any DB-persisted settings on top of env vars
{
  const s = getAllSettings()
  if (s.sootioUrl)          config.sootioUrl          = normalizeSootioUrl(s.sootioUrl)
  if (s.rdApiKey)           config.rdApiKey            = s.rdApiKey
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
  if (s.showAddDefaultMode != null) config.showAddDefaultMode = parseShowAddDefaultMode(s.showAddDefaultMode)
  if (s.movieReleaseMode != null) config.movieReleaseMode = parseMovieReleaseMode(s.movieReleaseMode)
  if (s.streamProviderUrls != null) config.streamProviderUrls = parseStreamProviderUrls(s.streamProviderUrls)
  if (s.englishStreamMode != null) config.englishStreamMode = parseEnglishStreamMode(s.englishStreamMode)
}

// Wrap Fastify logger so UI log viewer captures it
wrapFastifyLogger(app)

// Register routes
await app.register(jellyfinRoutes)
await app.register(jellyfinRoutes, { prefix: '/emby' })
await app.register(castRoutes)
await app.register(uiRoutes)

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
type FailedPlayCacheEntry = { expiresAt: number; reason: string }
const failedPlayCache = new Map<string, FailedPlayCacheEntry>()

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

function streamMetadataText(stream: { name?: string; title?: string; description?: string; behaviorHints?: Record<string, unknown> }): string {
  const filename = typeof stream.behaviorHints?.filename === 'string' ? stream.behaviorHints.filename : ''
  return `${stream.name ?? ''} ${stream.title ?? ''} ${stream.description ?? ''} ${filename}`.toLowerCase()
}

function streamFilenameHint(stream: { behaviorHints?: Record<string, unknown> }): string | undefined {
  const filename = stream.behaviorHints?.filename
  return typeof filename === 'string' && filename.trim() ? filename : undefined
}

function streamClearlyEnglish(stream: { name?: string; title?: string; description?: string; behaviorHints?: Record<string, unknown> }): boolean {
  const text = streamMetadataText(stream)
  const hasEnglish = hasEnglishAudioMarker(text)
  const hasNonEnglish = hasNonEnglishAudioMarker(text)
  return hasEnglish && !hasNonEnglish
}

function streamClearlyNonEnglish(stream: { name?: string; title?: string; description?: string; behaviorHints?: Record<string, unknown> }): boolean {
  const text = streamMetadataText(stream)
  const hasEnglish = hasEnglishAudioMarker(text)
  const hasNonEnglish = hasNonEnglishAudioMarker(text)
  return hasNonEnglish && !hasEnglish
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

function shouldProbeEnglishAudio(
  stream: { name?: string; title?: string; description?: string; behaviorHints?: Record<string, unknown> },
  filename: string,
): boolean {
  if (config.englishStreamMode === 'off') return false
  if (streamClearlyEnglish(stream)) return false
  if (streamClearlyNonEnglish(stream)) return false
  if (isRemoteAudioProbeUnreliable(filename)) return false
  return true
}

function hasEnglishAudio(languages: string[]): boolean {
  return languages.some(lang =>
    /^(en|eng|english)$/.test(lang) || /\beng(lish)?\b/.test(lang),
  )
}

function hasOnlyUndeterminedAudio(languages: string[]): boolean {
  const normalized = languages
    .map(lang => lang.trim().toLowerCase())
    .filter(Boolean)
  return normalized.length > 0 && normalized.every(lang => lang === 'und' || lang === 'undetermined')
}

async function resolveAndRedirect(
  streams: Awaited<ReturnType<typeof fetchRankedStreams>>,
  label: string,
  cacheKey: string,
  reply: { redirect: (url: string, code: number) => unknown; code: (n: number) => { send: (v: unknown) => unknown } },
  fileHint?: string,
) {
  if (config.rdApiKey) {
    const failedProviderOrders = new Set<number>()
    app.log.info(`play: trying ${streams.length} ranked candidate${streams.length === 1 ? '' : 's'} for ${label}`)
    for (const stream of streams) {
      const providerOrder = stream.providerOrder ?? 999
      if (failedProviderOrders.has(providerOrder)) continue

      const hash = extractHashFromStream(stream)
      const hashLabel = hash ? hash.slice(0, 8) : 'direct-url'
      try {
        if (config.englishStreamMode === 'require' && streamClearlyNonEnglish(stream)) {
          app.log.info(`play: skipping stream metadata for ${label}, clearly non-English`)
          continue
        }

        if (!hash) {
          app.log.info(`play: skipping providerOrder=${providerOrder} for ${label}, no torrent hash exposed`)
          continue
        }

        app.log.info(`play: trying providerOrder=${providerOrder} hash ${hash.slice(0, 8)}… for ${label}`)
        const resolved = await resolveStream(hash, streamFilenameHint(stream) ?? fileHint)
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
          && !streamClearlyEnglish(stream)
        ) {
          app.log.info(`play: skipping unprobeable ${resolved.filename}, no confirmed English metadata`)
          continue
        }
        if (shouldProbeEnglishAudio(stream, resolved.filename)) {
          try {
            const audioLanguages = await probeAudioLanguages(resolved.url)
            app.log.info(`play: ffprobe audio languages for ${resolved.filename}: ${audioLanguages.join(', ') || 'none'}`)
            const allowsUndetermined = hasOnlyUndeterminedAudio(audioLanguages) && !streamClearlyNonEnglish(stream)
            if (config.englishStreamMode === 'require' && !hasEnglishAudio(audioLanguages) && !allowsUndetermined) {
              app.log.info(`play: skipping ${resolved.filename}, no English audio detected`)
              continue
            }
          } catch (err) {
            app.log.warn(`play: ffprobe failed for ${resolved.filename}: ${err}`)
          }
        }
        app.log.info(`play: RD resolved ${resolved.filename} from hash ${hash.slice(0, 8)}…`)
        clearFailedPlay(cacheKey)
        return reply.redirect(resolved.url, 302)
      } catch (err) {
        if (err instanceof NotCachedError) {
          app.log.info(`play: hash ${hashLabel}… not cached, trying next`)
          continue
        }
        app.log.warn(`play: RD error for providerOrder=${providerOrder} hash ${hashLabel}…: ${err}; skipping remaining provider candidates`)
        failedProviderOrders.add(providerOrder)
      }
    }
    app.log.warn(`play: no usable RD-cached stream found for ${label}`)
    cacheFailedPlay(cacheKey, 'No cached stream available')
    return reply.code(404).send({ error: 'No cached stream available', message: 'No Cached Streams Found' })
  }
  const best = config.englishStreamMode === 'require'
    ? streams.find(stream => streamClearlyEnglish(stream))
    : streams[0]
  if (!best?.url) {
    cacheFailedPlay(cacheKey, 'No streams found')
    return reply.code(404).send({ error: 'No usable stream available', message: 'No Streams Found' })
  }
  app.log.info(`play: fallback direct stream selected for ${label}`)
  clearFailedPlay(cacheKey)
  return reply.redirect(best.url, 302)
}

app.get('/play/:imdbId', async (req, reply) => {
  if (!requestPlaybackUser(req.headers)) {
    app.log.warn(`play: rejected unauthenticated playback request for ${(req.params as { imdbId: string }).imdbId}`)
    return reply.code(401).send({ error: 'Unauthorized' })
  }
  const { imdbId } = req.params as { imdbId: string }
  const query = req.query as { token?: string; expires?: string } | undefined
  const playPath = `/play/${imdbId}`
  if (!verifySignedPlaybackPath(playPath, query?.token, query?.expires)) {
    app.log.warn(`play: rejected unsigned or expired playback request for ${imdbId}`)
    return reply.code(401).send({ error: 'Unauthorized' })
  }
  const failedReason = getFailedPlayReason(playPath)
  if (failedReason) {
    app.log.info(`play: cached miss for ${imdbId} (${failedReason})`)
    return reply.code(404).send({ error: failedReason, message: 'No Streams Found' })
  }
  app.log.info(`play: resolving stream for ${imdbId}`)
  try {
    const streams = await fetchRankedStreams(imdbId)
    return resolveAndRedirect(streams, imdbId, playPath, reply as never)
  } catch (err) {
    app.log.warn(`play: no stream for ${imdbId}: ${err}`)
    cacheFailedPlay(playPath, 'No streams found')
    return reply.code(404).send({ error: 'No stream available', message: 'No Streams Found' })
  }
})

app.get('/play/:imdbId/:season/:episode', async (req, reply) => {
  if (!requestPlaybackUser(req.headers)) {
    const { imdbId, season, episode } = req.params as { imdbId: string; season: string; episode: string }
    app.log.warn(`play: rejected unauthenticated episode playback request for ${imdbId} S${season}E${episode}`)
    return reply.code(401).send({ error: 'Unauthorized' })
  }
  const { imdbId, season, episode } = req.params as { imdbId: string; season: string; episode: string }
  const query = req.query as { token?: string; expires?: string } | undefined
  const playPath = `/play/${imdbId}/${season}/${episode}`
  if (!verifySignedPlaybackPath(playPath, query?.token, query?.expires)) {
    app.log.warn(`play: rejected unsigned or expired episode playback request for ${imdbId} S${season}E${episode}`)
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
    const show = getShowByImdbId(imdbId)
    const episode = show
      ? getEpisodesForSeason(show.tmdbId, s).find(ep => ep.episodeNumber === e)
      : null
    const episodeAirYear = episode?.airDate ? Number.parseInt(episode.airDate.slice(0, 4), 10) : undefined
    const streams = await fetchRankedEpisodeStreams(
      imdbId,
      s,
      e,
      show?.year || undefined,
      Number.isFinite(episodeAirYear) ? episodeAirYear : undefined,
    )
    return resolveAndRedirect(streams, `${imdbId} S${s}E${e}`, playPath, reply as never, `s${pad2(s)}e${pad2(e)}`)
  } catch (err) {
    app.log.warn(`play: no stream for ${imdbId} S${s}E${e}: ${err}`)
    cacheFailedPlay(playPath, 'No streams found')
    return reply.code(404).send({ error: 'No stream available', message: 'No Streams Found' })
  }
})

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
