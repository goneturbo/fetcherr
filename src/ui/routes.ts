import type { FastifyInstance } from 'fastify'
import { readFileSync, existsSync } from 'fs'
import { fileURLToPath } from 'url'
import { join, dirname } from 'path'
import {
  listMovies, countMovies, listShows, countShows, countAiredEpisodes,
  addSourceItem, getEffectiveShowMode, getMovieByTmdbId, getShowByTmdbId, getSetting,
  getLatestSeasonNumberForShow, getEpisodesForShow, getMovieEligibleDate, getMovieReleaseModeForLibrary,
  getManualMovieAvailabilityOverride, materializeMovieReleaseModeForExistingLibrary,
  countHiddenLibraryItems, hasAnySourceItem, hasSourceItem, hideLibraryItem, isLibraryItemHidden,
  listAiredShowTmdbIds, listHiddenLibraryItems, listManualMovieAvailabilityOverrides,
  listManualShowSubscriptionsById, listMovieReleaseModePreferences, listSourceKeysForItem, listSourceKeysForItems,
  pruneOrphanedMovies, pruneOrphanedShows, removeSourceItem, setManualMovieAvailabilityOverride,
  setMovieReleaseModePreference,
  setSetting, upsertManualShowSubscription, isMovieAvailable, isMovieVisibleToLibrary,
  canUserAccessMovie, canUserAccessShow, createUser, deleteUser, listUsers, unhideLibraryItem, updateUser,
} from '../db.js'
import { getLogs } from '../logger.js'
import { lastSyncAt, nextSyncAt } from '../sync-state.js'
import {
  createSession, getSessionUser, isValidSession, deleteSession, checkCredentials, isUiAuthConfigured,
  getSessionCookie, clearSessionCookie, getTokenFromCookie,
} from './auth.js'
import { config } from '../config.js'
import { collectStreamProviderUrls, normalizeSootioUrl, parseAudioLanguage, parseBooleanSetting, parseEnglishStreamMode, parseMdblistLists, parseMediaSourceLimit, parseMovieReleaseMode, parseShowAddDefaultMode, parseStreamProviderUrls, parseStreamRankingMode, parseTraktLists } from '../config.js'
import { fetchMovieByTmdbId, fetchMovieCollection, fetchShowByTmdbId, ensureShowSeasonsCached } from '../tmdb.js'
import { cleanupRemovedTraktListSources, fetchTraktUserLists } from '../trakt.js'
import { cleanupRemovedMdblistListSources, normalizeMdblistEntries } from '../mdblist.js'
import { getProviderFetchMetrics } from '../sootio.js'

const __dir = dirname(fileURLToPath(import.meta.url))

type AppBuildInfo = {
  version: string
  label: string
  title: string
  commit: string
  imageTag: string
  buildDate: string
}

function loadPackageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(__dir, '..', '..', 'package.json'), 'utf8')) as { version?: unknown }
    return typeof pkg.version === 'string' && pkg.version ? pkg.version : 'dev'
  } catch {
    return 'dev'
  }
}

function cleanVersionPart(value: string | undefined): string {
  return value?.trim() ?? ''
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function loadAppBuildInfo(): AppBuildInfo {
  const version = cleanVersionPart(process.env.FETCHERR_VERSION) || loadPackageVersion()
  const commit = cleanVersionPart(process.env.FETCHERR_COMMIT)
  const imageTag = cleanVersionPart(process.env.FETCHERR_IMAGE_TAG)
  const buildDate = cleanVersionPart(process.env.FETCHERR_BUILD_DATE)
  const shortCommit = commit ? commit.slice(0, 7) : ''
  const label = `v${version}${shortCommit ? `+${shortCommit}` : ''}`
  const details = [
    `Fetcherr ${label}`,
    imageTag ? `Image: ${imageTag}` : '',
    commit ? `Commit: ${commit}` : '',
    buildDate ? `Built: ${buildDate}` : '',
  ].filter(Boolean)
  return {
    version,
    label,
    title: details.join('\n'),
    commit,
    imageTag,
    buildDate,
  }
}

const APP_BUILD = loadAppBuildInfo()

const STATIC_MIME: Record<string, string> = {
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  ico: 'image/x-icon',
  js:  'text/javascript',
  css: 'text/css',
}

type ApiKeyService = 'rd' | 'tmdb' | 'tvdb' | 'tb'
type LibraryStatusFilter = 'all' | 'available' | 'pending' | 'hidden' | 'manual' | 'list'

interface TvdbValidationResponse {
  data?: {
    token?: string
  }
}

function apiKeyServiceLabel(service: ApiKeyService): string {
  if (service === 'rd') return 'Real-Debrid'
  if (service === 'tmdb') return 'TMDB'
  if (service === 'tb') return 'TorBox'
  return 'TVDB'
}

function isApiKeyService(value: unknown): value is ApiKeyService {
  return value === 'rd' || value === 'tmdb' || value === 'tvdb' || value === 'tb'
}

function configuredApiKeyForService(service: ApiKeyService): string {
  if (service === 'rd') return getSetting('rdApiKey') || config.rdApiKey
  if (service === 'tmdb') return config.tmdbApiKey
  if (service === 'tb') return getSetting('torBoxApiKey') || config.torBoxApiKey
  return config.tvdbApiKey
}

async function validateTorBoxApiKey(key: string) {
  const res = await fetch('https://api.torbox.app/v1/api/user/me', {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`TorBox rejected the key (${res.status}).`)
  const json = await res.json() as { data?: { email?: string } }
  return {
    label: json.data?.email ? `Account: ${json.data.email}` : 'TorBox account verified',
  }
}

async function validateRealDebridApiKey(key: string) {
  const res = await fetch('https://api.real-debrid.com/rest/1.0/user', {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`Real-Debrid rejected the key (${res.status}).`)
  const json = await res.json() as { username?: string }
  return {
    label: json.username ? `Account: ${json.username}` : 'Real-Debrid account verified',
  }
}

async function validateTmdbApiKey(key: string) {
  const url = new URL('https://api.themoviedb.org/3/configuration')
  url.searchParams.set('api_key', key)
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) })
  if (!res.ok) throw new Error(`TMDB rejected the key (${res.status}).`)
  const json = await res.json() as { images?: unknown }
  if (!json.images) throw new Error('TMDB accepted the request but returned an unexpected response.')
  return {
    label: 'TMDB key verified',
  }
}

async function validateTvdbApiKey(key: string) {
  const res = await fetch('https://api4.thetvdb.com/v4/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apikey: key }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`TVDB rejected the key (${res.status}).`)
  const json = await res.json() as TvdbValidationResponse
  if (!json.data?.token) throw new Error('TVDB accepted the request but did not return an auth token.')
  return {
    label: 'TVDB key verified',
  }
}

async function validateApiKeyForService(service: ApiKeyService, key: string) {
  if (service === 'rd') return validateRealDebridApiKey(key)
  if (service === 'tmdb') return validateTmdbApiKey(key)
  if (service === 'tb') return validateTorBoxApiKey(key)
  return validateTvdbApiKey(key)
}

function refreshStreamProviderConfig(): void {
  const rdProviderUrls = getSetting('rdStreamProviderUrls') ?? ''
  const torBoxProviderUrls = getSetting('torBoxStreamProviderUrls') ?? ''
  const genericProviderUrls = getSetting('streamProviderUrls') ?? ''
  config.streamProviderUrls = collectStreamProviderUrls(
    rdProviderUrls,
    torBoxProviderUrls,
    genericProviderUrls,
  )
  config.stremioSearchProviderUrls = collectStreamProviderUrls(
    rdProviderUrls,
    torBoxProviderUrls,
    genericProviderUrls,
    config.streamProviderUrls.join('\n'),
    config.sootioUrl,
  )
}

function html(file: string) {
  return readFileSync(join(__dir, file), 'utf8')
    .replaceAll('__APP_VERSION_LABEL__', escapeHtml(APP_BUILD.label))
    .replaceAll('__APP_VERSION_TITLE__', escapeHtml(APP_BUILD.title))
}

function tmdbToMovieGuid(tmdbId: number) {
  return `00000000-0000-4000-8000-${tmdbId.toString(16).padStart(12, '0')}`
}
function tmdbToShowGuid(tmdbId: number) {
  return `00000000-0000-4000-8001-${tmdbId.toString(16).padStart(12, '0')}`
}

function todayIsoDate(): string {
  const now = new Date()
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function parseLibraryStatusFilter(value: string | undefined): LibraryStatusFilter {
  if (value === 'available' || value === 'pending' || value === 'hidden' || value === 'manual' || value === 'list') return value
  return 'all'
}

function titleFromSourcePath(path: string): string {
  const parts = path.split('/').filter(Boolean)
  return decodeURIComponent(parts[parts.length - 1] ?? path)
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, letter => letter.toUpperCase())
}

function sourceLabel(sourceKey: string): string {
  if (sourceKey === 'manual:ui') return 'Manual'
  if (sourceKey === 'trakt:watchlist:movies' || sourceKey === 'trakt:watchlist:shows') return 'Trakt Watchlist'
  if (sourceKey.startsWith('trakt:list:')) return `Trakt: ${titleFromSourcePath(sourceKey.slice('trakt:list:'.length))}`
  if (sourceKey.startsWith('mdblist:list:')) return `MDBList: ${titleFromSourcePath(sourceKey.slice('mdblist:list:'.length))}`
  return sourceKey
}

function isListSourceKey(sourceKey: string): boolean {
  return sourceKey !== 'manual:ui'
}

function sourceSummaryForItem(mediaType: 'movie' | 'show', tmdbId: number) {
  const sourceKeys = listSourceKeysForItem(mediaType, tmdbId)
  return sourceSummaryFromKeys(sourceKeys)
}

function sourceSummaryFromKeys(sourceKeys: string[]) {
  return {
    sourceLabels: sourceKeys.map(sourceLabel),
    listBacked: sourceKeys.some(isListSourceKey),
  }
}

function movieReleaseModeFromPreferences(
  preferences: Map<number, 'digital' | 'theatrical'>,
  movieTmdbId: number,
): 'digital' | 'theatrical' {
  return preferences.get(movieTmdbId) ?? config.movieReleaseMode
}

function isMovieVisibleFromBatchedState(
  movie: { tmdbId: number; releaseDate: string; digitalReleaseDate: string },
  mode: 'digital' | 'theatrical',
  releaseGateOverrides: Set<number>,
  today: string,
): boolean {
  if (releaseGateOverrides.has(movie.tmdbId)) return true
  const eligibleDate = getMovieEligibleDate(movie, mode)
  return !!eligibleDate && eligibleDate <= today
}

const LOGIN_WINDOW_MS = 15 * 60 * 1000
const LOGIN_MAX_ATTEMPTS = 10
const loginAttempts = new Map<string, { count: number; resetAt: number }>()

function clientIp(req: { headers: Record<string, string | string[] | undefined>; ip?: string }): string {
  const cfIp = req.headers['cf-connecting-ip']
  if (typeof cfIp === 'string' && cfIp.trim()) return cfIp.trim()

  const forwardedFor = req.headers['x-forwarded-for']
  if (typeof forwardedFor === 'string' && forwardedFor.trim()) {
    return forwardedFor.split(',')[0].trim()
  }

  return req.ip || 'unknown'
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

function cookieHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

function currentUiUser(req: { headers: Record<string, string | string[] | undefined> }) {
  const token = getTokenFromCookie(cookieHeaderValue(req.headers.cookie))
  if (!token) return null
  return getSessionUser(token)
}

function requireAdmin(
  req: { headers: Record<string, string | string[] | undefined> },
  reply: { code: (n: number) => { send: (v: unknown) => unknown } },
) {
  const user = currentUiUser(req)
  if (!user) {
    reply.code(401).send({ error: 'Unauthorized' })
    return null
  }
  if (user.role !== 'admin') {
    reply.code(403).send({ error: 'Admin access required' })
    return null
  }
  return user
}

export async function uiRoutes(app: FastifyInstance) {

  // ── Static files ──────────────────────────────────────────────────────────
  app.get('/ui/static/:file', async (req, reply) => {
    const { file } = req.params as { file: string }
    // Only allow safe filenames (no path traversal)
    if (!/^[\w.-]+$/.test(file)) return reply.code(400).send()
    const filePath = join(__dir, 'static', file)
    if (!existsSync(filePath)) return reply.code(404).send()
    const ext = file.split('.').pop()?.toLowerCase() ?? ''
    reply.type(STATIC_MIME[ext] ?? 'application/octet-stream')
    return reply.send(readFileSync(filePath))
  })

  // ── Auth endpoints (no session required) ─────────────────────────────────
  app.get('/ui/login', async (_req, reply) => {
    if (!isUiAuthConfigured()) return reply.redirect('/ui/setup-admin', 302)
    return reply.type('text/html').send(html('login.html'))
  })

  app.get('/ui/setup-admin', async (_req, reply) => {
    if (isUiAuthConfigured()) return reply.redirect('/ui/login', 302)
    return reply.type('text/html').send(html('setup-admin.html'))
  })

  app.post('/ui/auth/setup', async (req, reply) => {
    if (isUiAuthConfigured()) {
      return reply.code(409).send({ error: 'Setup already completed' })
    }
    const body = req.body as { username?: string; password?: string } | undefined
    try {
      const user = createUser(body?.username ?? '', body?.password ?? '', 'admin', 'unrestricted')
      const token = createSession(user.id)
      reply.header('Set-Cookie', getSessionCookie(token, req.headers as never))
      return { ok: true }
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : 'Failed to create admin account' })
    }
  })

  app.post('/ui/auth/login', async (req, reply) => {
    if (!isUiAuthConfigured()) {
      return reply.code(409).send({ error: 'Setup required. Create an admin account first.' })
    }
    const rateKey = clientIp(req as never)
    const state = loginRateState(rateKey)
    if (state.count >= LOGIN_MAX_ATTEMPTS) {
      return reply.code(429).send({ error: 'Too many login attempts. Please try again later.' })
    }
    const body = req.body as { username?: string; password?: string } | undefined
    const username = body?.username ?? ''
    const password = body?.password ?? ''
    const user = checkCredentials(username, password)
    if (user) {
      loginAttempts.delete(rateKey)
      const token = createSession(user.id)
      reply.header('Set-Cookie', getSessionCookie(token, req.headers as never))
      return { ok: true }
    }
    state.count += 1
    return reply.code(401).send({ error: 'Incorrect username or password.' })
  })

  app.post('/ui/auth/logout', async (req, reply) => {
    const token = getTokenFromCookie(req.headers.cookie)
    if (token) deleteSession(token)
    reply.header('Set-Cookie', clearSessionCookie(req.headers as never))
    return { ok: true }
  })

  app.get('/ui/version', async () => APP_BUILD)

  // Auth status — tells the client whether auth is enabled
  app.get('/ui/auth/check', async (req, reply) => {
    if (!isUiAuthConfigured()) {
      return reply.code(503).send({ error: 'Setup required', setupRequired: true })
    }
    const token = getTokenFromCookie(req.headers.cookie)
    if (!token || !isValidSession(token)) {
      return reply.code(401).send({ error: 'Unauthorized' })
    }
    const user = getSessionUser(token)
    if (!user) {
      return reply.code(401).send({ error: 'Unauthorized' })
    }
    return { authEnabled: true, username: user?.username ?? '', role: user?.role ?? 'user', maxRating: user?.maxRating ?? 'unrestricted' }
  })

  // ── Auth middleware for all other /ui/* routes ────────────────────────────
  app.addHook('preHandler', async (req, reply) => {
    const url = req.url.split('?')[0]
    // Skip public routes
    if (
      url === '/ui/login' ||
      url === '/ui/setup-admin' ||
      url.startsWith('/ui/auth/') ||
      url.startsWith('/ui/static/')
    ) return

    if (!isUiAuthConfigured()) {
      const isApiRoute = /^\/ui\/(stats|movies|shows|logs-data|settings-data|users-data|search|library|trakt)/.test(url)
      if (isApiRoute) {
        return reply.code(503).send({ error: 'Setup required. Create an admin account first.' })
      }
      return reply.redirect('/ui/setup-admin', 302)
    }

    const token = getTokenFromCookie(req.headers.cookie)
    if (!token || !isValidSession(token) || !getSessionUser(token)) {
      const isApiRoute = /^\/ui\/(stats|movies|shows|logs-data|settings-data|users-data|search|library|trakt)/.test(url)
      if (isApiRoute) {
        return reply.code(401).send({ error: 'Unauthorized' })
      }
      return reply.redirect(`/ui/login?next=${encodeURIComponent(req.url)}`, 302)
    }
  })

  // ── Page routes ────────────────────────────────────────────────────────────
  app.get('/',              async (_req, reply) => reply.redirect('/ui/dashboard', 302))
  app.get('/ui',            async (_req, reply) => reply.redirect('/ui/dashboard', 302))
  app.get('/favicon.ico',   async (_req, reply) => reply.redirect('/ui/static/fetcherr.svg', 302))
  app.get('/apple-touch-icon.png', async (_req, reply) => reply.redirect('/ui/static/fetcherr.svg', 302))
  app.get('/apple-touch-icon-precomposed.png', async (_req, reply) => reply.redirect('/ui/static/fetcherr.svg', 302))
  app.get('/ui/dashboard',  async (_req, reply) => reply.type('text/html').send(html('dashboard.html')))
  app.get('/ui/setup',      async (_req, reply) => reply.redirect(isUiAuthConfigured() ? '/ui/settings' : '/ui/setup-admin'))
  app.get('/ui/logs',       async (req, reply) => {
    if (!requireAdmin(req, reply as never)) return
    return reply.type('text/html').send(html('logs.html'))
  })

  // ── Stats ──────────────────────────────────────────────────────────────────
  app.get('/ui/stats', async (req, reply) => {
    const user = currentUiUser(req as never)
    if (!user) return reply.code(401).send({ error: 'Unauthorized' })
    const visibleMovies = listMovies({ limit: 10_000, offset: 0, userId: user.id }).filter(movie => canUserAccessMovie(user, movie))
    const visibleShows = listShows({ limit: 10_000, offset: 0, userId: user.id }).filter(show => canUserAccessShow(user, show))
    const movies   = visibleMovies.length
    const shows    = visibleShows.length
    const episodes = countAiredEpisodes()
    return {
      movies,
      shows,
      episodes,
      hidden: user.role === 'admin' ? countHiddenLibraryItems() : 0,
      lastSyncAt,
      nextSyncAt,
      currentUser: { username: user.username, role: user.role, maxRating: user.maxRating },
    }
  })

  // ── Movies list ────────────────────────────────────────────────────────────
  app.get('/ui/movies', async (req) => {
    const user = currentUiUser(req as never)
    if (!user) return { items: [], total: 0 }
    const q      = (req as never as { query: Record<string, string> }).query
    const search = q.search || undefined
    const sortBy = q.sortBy || 'popularity'
    const sortOrder = q.sortOrder || 'DESC'
    const statusFilter = parseLibraryStatusFilter(q.filter)
    const limit  = Math.min(parseInt(q.limit ?? '100'), 500)
    const offset = parseInt(q.offset ?? '0')

    const accessibleItems = listMovies({ search, sortBy, sortOrder, limit: 10_000, offset: 0, userId: user.id })
      .filter(m => canUserAccessMovie(user, m))
    const movieIds = accessibleItems.map(m => m.tmdbId)
    const sourceKeysByMovie = listSourceKeysForItems('movie', movieIds)
    const movieReleaseModePreferences = listMovieReleaseModePreferences(movieIds)
    const releaseGateOverrides = listManualMovieAvailabilityOverrides(movieIds)
    const today = todayIsoDate()

    const allItems = accessibleItems.filter(m => {
        const sourceKeys = sourceKeysByMovie.get(m.tmdbId) ?? []
        const isAvailable = isMovieVisibleFromBatchedState(
          m,
          movieReleaseModeFromPreferences(movieReleaseModePreferences, m.tmdbId),
          releaseGateOverrides,
          today,
        )
        if (statusFilter === 'hidden') return false
        if (statusFilter === 'available') return isAvailable
        if (statusFilter === 'pending') return !isAvailable
        if (statusFilter === 'manual') return sourceKeys.includes('manual:ui')
        if (statusFilter === 'list') return sourceSummaryFromKeys(sourceKeys).listBacked
        return true
      })
    const items = allItems.slice(offset, offset + limit)
    const total = allItems.length

    return {
      items: items.map(m => {
        const sourceKeys = sourceKeysByMovie.get(m.tmdbId) ?? []
        const sources = sourceSummaryFromKeys(sourceKeys)
        const movieReleaseMode = movieReleaseModeFromPreferences(movieReleaseModePreferences, m.tmdbId)
        const isAvailable = isMovieVisibleFromBatchedState(m, movieReleaseMode, releaseGateOverrides, today)
        return {
        id:           m.id,
        tmdbId:       m.tmdbId,
        imdbId:       m.imdbId,
        title:        m.title,
        year:         m.year,
        releaseSortDate: m.releaseDate || m.digitalReleaseDate || (m.year ? `${m.year}-01-01` : ''),
        overview:     m.overview,
        syncedAt:     m.syncedAt,
        genres:       JSON.parse(m.genres || '[]') as string[],
        runtimeMins:  m.runtimeMins,
        popularity:   m.popularity,
        manualAdded:  sourceKeys.includes('manual:ui'),
        listBacked:   sources.listBacked,
        sourceLabels: sources.sourceLabels,
        movieReleaseMode,
        releaseWindowLabel: movieReleaseMode === 'theatrical' ? 'Theatrical Release' : 'Digital Release',
        isAvailable,
        pendingLabel: isAvailable ? null : `Pending ${movieReleaseMode === 'theatrical' ? 'Theatrical Release' : 'Digital Release'}`,
        posterUrl:    m.posterPath ? `https://image.tmdb.org/t/p/w185${m.posterPath}` : null,
        imageId:      tmdbToMovieGuid(m.tmdbId),
        }
      }),
      total,
    }
  })

  // ── Shows list ─────────────────────────────────────────────────────────────
  app.get('/ui/shows', async (req) => {
    const user = currentUiUser(req as never)
    if (!user) return { items: [], total: 0 }
    const q      = (req as never as { query: Record<string, string> }).query
    const search = q.search || undefined
    const sortBy = q.sortBy || 'popularity'
    const sortOrder = q.sortOrder || 'DESC'
    const statusFilter = parseLibraryStatusFilter(q.filter)
    const limit  = Math.min(parseInt(q.limit ?? '100'), 500)
    const offset = parseInt(q.offset ?? '0')

    const accessibleItems = listShows({ search, sortBy, sortOrder, limit: 10_000, offset: 0, userId: user.id })
      .filter(s => canUserAccessShow(user, s))
    const showIds = accessibleItems.map(s => s.tmdbId)
    const sourceKeysByShow = listSourceKeysForItems('show', showIds)
    const visibleShowIds = listAiredShowTmdbIds(showIds)
    const manualShowSubscriptions = listManualShowSubscriptionsById(showIds)

    const allItems = accessibleItems.filter(s => {
        const sourceKeys = sourceKeysByShow.get(s.tmdbId) ?? []
        const visibleToInfuse = visibleShowIds.has(s.tmdbId)
        if (statusFilter === 'hidden') return false
        if (statusFilter === 'available') return visibleToInfuse
        if (statusFilter === 'pending') return !visibleToInfuse
        if (statusFilter === 'manual') return sourceKeys.includes('manual:ui')
        if (statusFilter === 'list') return sourceSummaryFromKeys(sourceKeys).listBacked
        return true
      })
    const items = allItems.slice(offset, offset + limit)
    const total = allItems.length

    return {
      items: items.map(s => {
        const sourceKeys = sourceKeysByShow.get(s.tmdbId) ?? []
        const sources = sourceSummaryFromKeys(sourceKeys)
        const visibleToInfuse = visibleShowIds.has(s.tmdbId)
        return {
        id:         s.id,
        tmdbId:     s.tmdbId,
        imdbId:     s.imdbId,
        title:      s.title,
        year:       s.year,
        releaseSortDate: s.year ? `${s.year}-01-01` : '',
        overview:   s.overview,
        syncedAt:   s.syncedAt,
        genres:     JSON.parse(s.genres || '[]') as string[],
        status:     s.status,
        numSeasons: s.numSeasons,
        popularity: s.popularity,
        manualAdded: sourceKeys.includes('manual:ui'),
        listBacked: sources.listBacked,
        sourceLabels: sources.sourceLabels,
        visibleToInfuse,
        libraryMode: manualShowSubscriptions.get(s.tmdbId)?.mode ?? 'all',
        posterUrl:  s.posterPath ? `https://image.tmdb.org/t/p/w185${s.posterPath}` : null,
        imageId:    tmdbToShowGuid(s.tmdbId),
        }
      }),
      total,
    }
  })

  app.get('/ui/library/item', async (req, reply) => {
    const user = currentUiUser(req as never)
    if (!user) return reply.code(401).send({ error: 'Unauthorized' })
    const q = (req as never as { query: Record<string, string> }).query
    const type = q.type === 'tv' ? 'tv' : q.type === 'movie' ? 'movie' : ''
    const tmdbId = Number.parseInt(q.tmdbId ?? '', 10)
    if (!type || !Number.isFinite(tmdbId)) {
      return reply.code(400).send({ error: 'type and tmdbId are required' })
    }

    if (type === 'movie') {
      const movie = getMovieByTmdbId(tmdbId) ?? await fetchMovieByTmdbId(tmdbId)
      if (!movie) return reply.code(404).send({ error: 'Movie not found' })
      if (!canUserAccessMovie(user, movie)) return reply.code(404).send({ error: 'Movie not found' })

      const movieReleaseMode = getMovieReleaseModeForLibrary(movie.tmdbId)
      const eligibleDate = getMovieEligibleDate(movie, movieReleaseMode)
      const releaseGateOverridden = getManualMovieAvailabilityOverride(movie.tmdbId)
      const isAvailable = isMovieVisibleToLibrary(movie)
      const releaseWindowLabel = movieReleaseMode === 'theatrical' ? 'Theatrical Release' : 'Digital Release'
      const sources = sourceSummaryForItem('movie', movie.tmdbId)

      return {
        type,
        tmdbId: movie.tmdbId,
        title: movie.title,
        year: movie.year,
        overview: movie.overview,
        posterUrl: movie.posterPath ? `https://image.tmdb.org/t/p/w342${movie.posterPath}` : null,
        imdbId: movie.imdbId,
        hidden: isLibraryItemHidden('movie', movie.tmdbId),
        inLibrary: hasAnySourceItem('movie', movie.tmdbId) && !isLibraryItemHidden('movie', movie.tmdbId),
        manualAdded: hasSourceItem('manual:ui', 'movie', movie.tmdbId),
        listBacked: sources.listBacked,
        sourceLabels: sources.sourceLabels,
        visibleToInfuse: isAvailable,
        libraryStatusLabel: isAvailable
          ? (releaseGateOverridden && !isMovieAvailable(movie) ? 'In Library via Override' : 'In Library')
          : `Pending ${releaseWindowLabel}`,
        releaseGateOverridden,
        movieReleaseMode,
        releaseWindowLabel,
        eligibleDate,
        releaseDate: movie.releaseDate || null,
        digitalReleaseDate: movie.digitalReleaseDate || null,
        collectionItems: (await fetchMovieCollection(movie.tmdbId))
          .filter(item => item.tmdbId !== movie.tmdbId)
          .map(item => ({
          ...item,
          inLibrary: hasAnySourceItem('movie', item.tmdbId) && !isLibraryItemHidden('movie', item.tmdbId),
        })),
      }
    }

    const show = getShowByTmdbId(tmdbId) ?? await fetchShowByTmdbId(tmdbId)
    if (!show) return reply.code(404).send({ error: 'Show not found' })
    if (!canUserAccessShow(user, show)) return reply.code(404).send({ error: 'Show not found' })

    await ensureShowSeasonsCached(show).catch(() => {})
    const today = todayIsoDate()
    const episodes = getEpisodesForShow(show.tmdbId)
    const hidden = isLibraryItemHidden('show', show.tmdbId)
    const visibleToInfuse = !hidden && episodes.some(e => !!e.airDate && e.airDate < today)
    const nextEpisode = episodes.find(e => !!e.airDate && e.airDate >= today) ?? null
    const sources = sourceSummaryForItem('show', show.tmdbId)

    return {
      type,
      tmdbId: show.tmdbId,
      title: show.title,
      year: show.year,
      overview: show.overview,
      posterUrl: show.posterPath ? `https://image.tmdb.org/t/p/w342${show.posterPath}` : null,
      imdbId: show.imdbId,
      hidden,
      inLibrary: hasAnySourceItem('show', show.tmdbId) && !hidden,
      manualAdded: hasSourceItem('manual:ui', 'show', show.tmdbId),
      listBacked: sources.listBacked,
      sourceLabels: sources.sourceLabels,
      visibleToInfuse,
      libraryStatusLabel: visibleToInfuse ? 'In Library' : 'Pending First Episode',
      nextEpisodeAirDate: nextEpisode?.airDate || null,
      nextEpisodeName: nextEpisode?.name || null,
      nextEpisodeSeasonNumber: nextEpisode?.seasonNumber ?? null,
      nextEpisodeEpisodeNumber: nextEpisode?.episodeNumber ?? null,
      libraryMode: getEffectiveShowMode(show.tmdbId).mode,
      status: show.status,
      numSeasons: show.numSeasons,
    }
  })

  // ── Logs ───────────────────────────────────────────────────────────────────
  app.get('/ui/logs-data', async (req, reply) => {
    if (!requireAdmin(req, reply as never)) return
    const q     = (req as never as { query: Record<string, string> }).query
    const level = q.level
    return { entries: getLogs(level), providerMetrics: getProviderFetchMetrics() }
  })

  // ── Settings page ──────────────────────────────────────────────────────────
  app.get('/ui/settings', async (req, reply) => {
    if (!requireAdmin(req, reply as never)) return
    return reply
      .header('Cache-Control', 'no-store')
      .type('text/html')
      .send(html('settings.html'))
  })

  // GET settings — returns current in-memory config values
  app.get('/ui/settings-data', async (req, reply) => {
    if (!requireAdmin(req, reply as never)) return
    reply.header('Cache-Control', 'no-store')
    return {
      sootioUrl:         config.sootioUrl,
      streamProviderUrls: config.streamProviderUrls.join('\n'),
      preferredAudioLanguage: config.preferredAudioLanguage,
      englishStreamMode: config.englishStreamMode,
      streamRankingMode: config.streamRankingMode,
      mediaSourceSelection: config.mediaSourceSelection,
      mediaSourceLimit: config.mediaSourceLimit,
      serverUrl:         config.serverUrl,
      traktClientId:     config.traktClientId,
      traktWatchlistMovies: config.traktWatchlistMovies,
      traktWatchlistShows: config.traktWatchlistShows,
      traktWatchHistory: config.traktWatchHistory,
      traktCollections: config.traktCollections,
      traktFolders: config.traktFolders,
      mdblistFolders: config.mdblistFolders,
      mdblistLists: config.mdblistLists,
      hasMdblistApiKey: !!getSetting('mdblistApiKey'),
      showAddDefaultMode: config.showAddDefaultMode,
      movieReleaseMode: config.movieReleaseMode,
      traktLists:        config.traktLists,
      hasSootioUrl:      !!getSetting('sootioUrl'),
      hasRdApiKey:       !!getSetting('rdApiKey'),
      hasTorBoxApiKey:   !!getSetting('torBoxApiKey'),
      torBoxCleanupEnabled: getSetting('torBoxCleanupMode') !== 'keep',
      hasTmdbApiKey:     !!getSetting('tmdbApiKey'),
      hasTvdbApiKey:     !!getSetting('tvdbApiKey'),
      hasTraktClientSecret: !!getSetting('traktClientSecret'),
      users: listUsers().map(user => ({
        id: user.id,
        username: user.username,
        role: user.role,
        maxRating: user.maxRating,
      })),
    }
  })

  app.get('/ui/client-config', async (req, reply) => {
    const user = currentUiUser(req as never)
    if (!user) return reply.code(401).send({ error: 'Unauthorized' })
    return {
      showAddDefaultMode: config.showAddDefaultMode,
      movieReleaseMode: config.movieReleaseMode,
    }
  })

  app.get('/ui/trakt/lists', async (req, reply) => {
    if (!requireAdmin(req, reply as never)) return
    try {
      const lists = await fetchTraktUserLists()
      return {
        lists,
        selected: config.traktLists,
      }
    } catch (err) {
      return reply.code(502).send({ error: `Failed to load Trakt lists: ${String(err)}` })
    }
  })

  app.post('/ui/settings-data/validate-key', async (req, reply) => {
    if (!requireAdmin(req, reply as never)) return
    const body = (req.body ?? {}) as { service?: unknown; value?: unknown }
    if (!isApiKeyService(body.service)) {
      return reply.code(400).send({ error: 'Unsupported API service.' })
    }

    const service = body.service
    const enteredKey = typeof body.value === 'string' ? body.value.trim() : ''
    const key = enteredKey || configuredApiKeyForService(service)
    if (!key) {
      return reply.code(400).send({ error: `${apiKeyServiceLabel(service)} API key is not configured.` })
    }

    try {
      const result = await validateApiKeyForService(service, key)
      return {
        ok: true,
        service,
        label: result.label,
        source: enteredKey ? 'entered' : 'stored',
      }
    } catch (err) {
      return reply.code(502).send({ error: err instanceof Error ? err.message : 'API key validation failed.' })
    }
  })

  // POST settings — persist to DB and update in-memory config
  app.post('/ui/settings-data', async (req, reply) => {
    const user = currentUiUser(req as never)
    if (!user || user.role !== 'admin') return reply.code(403).send({ error: 'Admin access required' })
    const body = (req.body ?? {}) as Record<string, string | string[] | boolean>
    const editable: (keyof typeof config)[] = [
      'sootioUrl', 'tmdbApiKey', 'tvdbApiKey', 'serverUrl', 'traktClientId', 'traktClientSecret', 'mdblistApiKey',
    ]
    for (const key of editable) {
      if (typeof body[key] === 'string') {
        let val = body[key].trim()
        if (key === 'sootioUrl') val = normalizeSootioUrl(val)
        if (key === 'serverUrl') val = val.replace(/\/$/, '')
        setSetting(key, val)
        config[key] = val as never
      }
    }
    if (typeof body.rdApiKey === 'string') {
      setSetting('rdApiKey', body.rdApiKey.trim())
    }
    if (typeof body.torBoxApiKey === 'string') {
      setSetting('torBoxApiKey', body.torBoxApiKey.trim())
    }
    const storedRdApiKey = getSetting('rdApiKey') || ''
    const storedTorBoxApiKey = getSetting('torBoxApiKey') || ''
    config.rdApiKey = storedRdApiKey
    config.torBoxApiKey = storedTorBoxApiKey
    if (typeof body.streamProviderUrls === 'string') {
      setSetting('streamProviderUrls', parseStreamProviderUrls(body.streamProviderUrls).join('\n'))
      setSetting('rdStreamProviderUrls', '')
      setSetting('torBoxStreamProviderUrls', '')
    }
    if (body.torBoxCleanupEnabled != null) {
      const enabled = parseBooleanSetting(String(body.torBoxCleanupEnabled), true)
      setSetting('torBoxCleanupMode', enabled ? 'delete' : 'keep')
    }
    refreshStreamProviderConfig()
    if (typeof body.englishStreamMode === 'string') {
      const mode = parseEnglishStreamMode(body.englishStreamMode)
      setSetting('englishStreamMode', mode)
      config.englishStreamMode = mode
    }
    if (typeof body.streamRankingMode === 'string') {
      const mode = parseStreamRankingMode(body.streamRankingMode)
      setSetting('streamRankingMode', mode)
      config.streamRankingMode = mode
    }
    if (body.mediaSourceSelection != null) {
      const enabled = parseBooleanSetting(String(body.mediaSourceSelection), false)
      setSetting('mediaSourceSelection', enabled ? 'true' : 'false')
      config.mediaSourceSelection = enabled
    }
    if (body.mediaSourceLimit != null) {
      const limit = parseMediaSourceLimit(String(body.mediaSourceLimit))
      setSetting('mediaSourceLimit', String(limit))
      config.mediaSourceLimit = limit
    }
    if (typeof body.preferredAudioLanguage === 'string') {
      const language = parseAudioLanguage(body.preferredAudioLanguage)
      setSetting('preferredAudioLanguage', language)
      config.preferredAudioLanguage = language
    }
    if (body.traktWatchlistMovies != null) {
      const enabled = parseBooleanSetting(String(body.traktWatchlistMovies), true)
      setSetting('traktWatchlistMovies', enabled ? 'true' : 'false')
      config.traktWatchlistMovies = enabled
    }
    if (body.traktWatchlistShows != null) {
      const enabled = parseBooleanSetting(String(body.traktWatchlistShows), true)
      setSetting('traktWatchlistShows', enabled ? 'true' : 'false')
      config.traktWatchlistShows = enabled
    }
    if (body.traktWatchHistory != null) {
      const enabled = parseBooleanSetting(String(body.traktWatchHistory), false)
      setSetting('traktWatchHistory', enabled ? 'true' : 'false')
      config.traktWatchHistory = enabled
    }
    if (body.traktCollections != null) {
      const enabled = parseBooleanSetting(String(body.traktCollections), false)
      setSetting('traktCollections', enabled ? 'true' : 'false')
      config.traktCollections = enabled
    }
    if (body.traktFolders != null) {
      const enabled = parseBooleanSetting(String(body.traktFolders), false)
      setSetting('traktFolders', enabled ? 'true' : 'false')
      config.traktFolders = enabled
    }
    if (body.mdblistFolders != null) {
      const enabled = parseBooleanSetting(String(body.mdblistFolders), false)
      setSetting('mdblistFolders', enabled ? 'true' : 'false')
      config.mdblistFolders = enabled
    }
    if (typeof body.showAddDefaultMode === 'string') {
      const mode = parseShowAddDefaultMode(body.showAddDefaultMode)
      setSetting('showAddDefaultMode', mode)
      config.showAddDefaultMode = mode
    }
    if (typeof body.movieReleaseMode === 'string') {
      const mode = parseMovieReleaseMode(body.movieReleaseMode)
      if (mode !== config.movieReleaseMode) {
        materializeMovieReleaseModeForExistingLibrary(config.movieReleaseMode)
      }
      setSetting('movieReleaseMode', mode)
      config.movieReleaseMode = mode
    }
    if (Array.isArray(body.traktLists)) {
      const lists = body.traktLists.map(v => String(v).trim()).filter(Boolean)
      setSetting('traktLists', lists.join(','))
      config.traktLists = lists
      cleanupRemovedTraktListSources(lists)
    } else if (typeof body.traktLists === 'string') {
      const lists = parseTraktLists(body.traktLists)
      setSetting('traktLists', lists.join(','))
      config.traktLists = lists
      cleanupRemovedTraktListSources(lists)
    }
    if (Array.isArray(body.mdblistLists)) {
      try {
        const raw = (body.mdblistLists as unknown[])
          .filter((v): v is { url: string; name?: string } => typeof v === 'object' && v !== null && typeof (v as Record<string, unknown>).url === 'string')
          .map(v => ({ url: v.url.trim(), ...(v.name?.trim() ? { name: v.name.trim() } : {}) }))
        const entries = normalizeMdblistEntries(raw)
        setSetting('mdblistLists', JSON.stringify(entries))
        config.mdblistLists = entries
        cleanupRemovedMdblistListSources(entries.map(e => e.url))
      } catch (err) {
        return reply.code(400).send({ error: String(err instanceof Error ? err.message : err) })
      }
    } else if (typeof body.mdblistLists === 'string') {
      try {
        const entries = normalizeMdblistEntries(parseMdblistLists(body.mdblistLists))
        setSetting('mdblistLists', JSON.stringify(entries))
        config.mdblistLists = entries
        cleanupRemovedMdblistListSources(entries.map(e => e.url))
      } catch (err) {
        return reply.code(400).send({ error: String(err instanceof Error ? err.message : err) })
      }
    }
    return { ok: true }
  })

  app.post('/ui/users-data', async (req, reply) => {
    const admin = requireAdmin(req, reply as never)
    if (!admin) return
    const body = (req.body ?? {}) as {
      id?: string
      username?: string
      password?: string
      role?: string
      maxRating?: string
      action?: string
    }
    const role = body.role != null
      ? (body.role === 'admin' ? 'admin' : body.role === 'kids' ? 'kids' : 'user')
      : undefined
    try {
      if (body.action === 'delete' && body.id) {
        deleteUser(body.id)
        return { ok: true }
      }
      if (body.id) {
        const user = updateUser(body.id, {
          username: body.username,
          password: body.password,
          role,
          maxRating: body.maxRating,
        })
        return { ok: true, user: { id: user.id, username: user.username, role: user.role, maxRating: user.maxRating } }
      }
      const user = createUser(body.username ?? '', body.password ?? '', role ?? 'user', body.maxRating ?? 'unrestricted')
      return { ok: true, user: { id: user.id, username: user.username, role: user.role, maxRating: user.maxRating } }
    } catch (err) {
      return reply.code(400).send({ error: String(err instanceof Error ? err.message : err) })
    }
  })

  // ── TMDB search (no upsert) ────────────────────────────────────────────────
  app.get('/ui/search', async (req, reply) => {
    const user = currentUiUser(req as never)
    if (!user) return reply.code(401).send({ error: 'Unauthorized' })
    const q     = (req as never as { query: Record<string, string> }).query
    const query = (q.q ?? '').trim()
    const type  = q.type === 'tv' ? 'tv' : 'movie'
    if (query.length < 2) return { results: [] }
    if (!config.tmdbApiKey) return reply.code(503).send({ error: 'TMDB API key not configured in Settings' })

    const url = `https://api.themoviedb.org/3/search/${type}?api_key=${config.tmdbApiKey}&query=${encodeURIComponent(query)}&include_adult=false&language=en-US`
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
    if (!res.ok) return reply.code(502).send({ error: 'TMDB search failed' })
    const data = await res.json() as { results: Record<string, unknown>[] }

    const results = (data.results ?? []).slice(0, 20).map(r => {
      const tmdbId    = r.id as number
      const title     = (type === 'tv' ? r.name : r.title) as string
      const year      = ((type === 'tv' ? r.first_air_date : r.release_date) as string ?? '').slice(0, 4)
      const poster    = r.poster_path ? `https://image.tmdb.org/t/p/w185${r.poster_path}` : null
      const mediaType = type === 'movie' ? 'movie' : 'show'
      const inLibrary = hasAnySourceItem(mediaType, tmdbId) && !isLibraryItemHidden(mediaType, tmdbId)
      return { tmdbId, title, year, poster, inLibrary, type }
    })

    return { results }
  })

  // ── Add to library ─────────────────────────────────────────────────────────
  app.post('/ui/library/add', async (req, reply) => {
    const user = currentUiUser(req as never)
    if (!user) return reply.code(401).send({ error: 'Unauthorized' })
    const body = (req.body ?? {}) as { tmdbId?: number; type?: string; mode?: string }
    const { tmdbId, type } = body
    const mode = body.mode === 'latest' ? 'latest' : body.mode === 'all' ? 'all' : config.showAddDefaultMode
    if (!tmdbId || !type) return reply.code(400).send({ error: 'tmdbId and type required' })
    if (!config.tmdbApiKey) return reply.code(503).send({ error: 'TMDB API key not configured' })

    if (type === 'movie') {
      const movie = await fetchMovieByTmdbId(tmdbId)
      if (!movie) return reply.code(404).send({ error: 'Movie not found on TMDB' })
      if (!canUserAccessMovie(user, movie)) return reply.code(403).send({ error: 'Rating policy blocks this title' })
      unhideLibraryItem('movie', tmdbId)
      addSourceItem('manual:ui', 'movie', tmdbId)
      return { ok: true, title: movie.title }
    }

    if (type === 'tv') {
      const show = await fetchShowByTmdbId(tmdbId)
      if (!show) return reply.code(404).send({ error: 'Show not found on TMDB' })
      if (!canUserAccessShow(user, show)) return reply.code(403).send({ error: 'Rating policy blocks this title' })
      const activeSeasonNumber = mode === 'latest'
        ? (getLatestSeasonNumberForShow(tmdbId) ?? Math.max(show.numSeasons, 1))
        : 0
      upsertManualShowSubscription(tmdbId, mode, activeSeasonNumber)
      unhideLibraryItem('show', tmdbId)
      addSourceItem('manual:ui', 'show', tmdbId)
      await ensureShowSeasonsCached(show).catch(() => {})
      return { ok: true, title: show.title, mode, activeSeasonNumber }
    }

    return reply.code(400).send({ error: 'type must be movie or tv' })
  })

  app.get('/ui/library/hidden', async (req, reply) => {
    if (!requireAdmin(req, reply as never)) return
    const q = (req as never as { query: Record<string, string> }).query
    const search = (q.search ?? '').trim().toLowerCase()
    const mediaTypeFilter = q.type === 'movie' ? 'movie' : q.type === 'tv' || q.type === 'show' ? 'show' : ''
    const parsedLimit = Number.parseInt(q.limit ?? '200', 10)
    const parsedOffset = Number.parseInt(q.offset ?? '0', 10)
    const limit = Math.min(Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 200, 500)
    const offset = Number.isFinite(parsedOffset) && parsedOffset > 0 ? parsedOffset : 0
    const hiddenRows = listHiddenLibraryItems(10_000, 0)
    const items: Array<Record<string, unknown>> = []

    for (const row of hiddenRows) {
      if (mediaTypeFilter && row.mediaType !== mediaTypeFilter) continue
      if (row.mediaType === 'movie') {
        const movie = getMovieByTmdbId(row.tmdbId)
        if (!movie || !hasAnySourceItem('movie', row.tmdbId)) continue
        if (search && !movie.title.toLowerCase().includes(search)) continue
        const sources = sourceSummaryForItem('movie', row.tmdbId)
        const movieReleaseMode = getMovieReleaseModeForLibrary(row.tmdbId)
        items.push({
          _type: 'movies',
          type: 'movie',
          hidden: true,
          hiddenAt: row.hiddenAt,
          tmdbId: movie.tmdbId,
          imdbId: movie.imdbId,
          title: movie.title,
          year: movie.year,
          overview: movie.overview,
          syncedAt: movie.syncedAt,
          genres: JSON.parse(movie.genres || '[]') as string[],
          runtimeMins: movie.runtimeMins,
          popularity: movie.popularity,
          manualAdded: hasSourceItem('manual:ui', 'movie', row.tmdbId),
          listBacked: sources.listBacked,
          sourceLabels: sources.sourceLabels,
          movieReleaseMode,
          releaseWindowLabel: movieReleaseMode === 'theatrical' ? 'Theatrical Release' : 'Digital Release',
          posterUrl: movie.posterPath ? `https://image.tmdb.org/t/p/w185${movie.posterPath}` : null,
          imageId: tmdbToMovieGuid(movie.tmdbId),
        })
        continue
      }

      const show = getShowByTmdbId(row.tmdbId)
      if (!show || !hasAnySourceItem('show', row.tmdbId)) continue
      if (search && !show.title.toLowerCase().includes(search)) continue
      const sources = sourceSummaryForItem('show', row.tmdbId)
      items.push({
        _type: 'shows',
        type: 'tv',
        hidden: true,
        hiddenAt: row.hiddenAt,
        tmdbId: show.tmdbId,
        imdbId: show.imdbId,
        title: show.title,
        year: show.year,
        overview: show.overview,
        syncedAt: show.syncedAt,
        genres: JSON.parse(show.genres || '[]') as string[],
        status: show.status,
        numSeasons: show.numSeasons,
        popularity: show.popularity,
        manualAdded: hasSourceItem('manual:ui', 'show', row.tmdbId),
        listBacked: sources.listBacked,
        sourceLabels: sources.sourceLabels,
        libraryMode: getEffectiveShowMode(row.tmdbId).mode,
        posterUrl: show.posterPath ? `https://image.tmdb.org/t/p/w185${show.posterPath}` : null,
        imageId: tmdbToShowGuid(show.tmdbId),
      })
    }

    return {
      items: items.slice(offset, offset + limit),
      total: items.length,
    }
  })

  app.post('/ui/library/show-mode', async (req, reply) => {
    const user = currentUiUser(req as never)
    if (!user || user.role !== 'admin') return reply.code(403).send({ error: 'Admin access required' })
    const body = (req.body ?? {}) as { tmdbId?: number; mode?: string }
    const tmdbId = body.tmdbId
    const mode = body.mode === 'latest' ? 'latest' : body.mode === 'all' ? 'all' : ''
    if (!tmdbId || !mode) return reply.code(400).send({ error: 'tmdbId and mode are required' })

    const show = getShowByTmdbId(tmdbId) ?? await fetchShowByTmdbId(tmdbId)
    if (!show) return reply.code(404).send({ error: 'Show not found' })
    if (!hasAnySourceItem('show', tmdbId)) return reply.code(404).send({ error: 'Show not found in library' })
    if (!canUserAccessShow(user, show)) return reply.code(403).send({ error: 'Rating policy blocks this title' })

    const activeSeasonNumber = mode === 'latest'
      ? (getLatestSeasonNumberForShow(tmdbId) ?? Math.max(show.numSeasons, 1))
      : 0
    upsertManualShowSubscription(tmdbId, mode, activeSeasonNumber)
    await ensureShowSeasonsCached(show).catch(() => {})
    return { ok: true, title: show.title, mode, activeSeasonNumber }
  })

  app.post('/ui/library/movie-release-mode', async (req, reply) => {
    const user = currentUiUser(req as never)
    if (!user || user.role !== 'admin') return reply.code(403).send({ error: 'Admin access required' })
    const body = (req.body ?? {}) as { tmdbId?: number; mode?: string }
    const tmdbId = body.tmdbId
    const mode = body.mode === 'theatrical' ? 'theatrical' : body.mode === 'digital' ? 'digital' : ''
    if (!tmdbId || !mode) return reply.code(400).send({ error: 'tmdbId and mode are required' })

    const movie = getMovieByTmdbId(tmdbId)
    if (!movie || !hasAnySourceItem('movie', tmdbId)) {
      return reply.code(404).send({ error: 'Movie not found in library' })
    }

    setMovieReleaseModePreference(tmdbId, mode)
    return {
      ok: true,
      title: movie.title,
      mode,
      releaseWindowLabel: mode === 'theatrical' ? 'Theatrical Release' : 'Digital Release',
    }
  })

  app.post('/ui/library/movie-availability', async (req, reply) => {
    const user = currentUiUser(req as never)
    if (!user || user.role !== 'admin') return reply.code(403).send({ error: 'Admin access required' })
    const body = (req.body ?? {}) as { tmdbId?: number; ignoreReleaseGate?: boolean }
    const tmdbId = body.tmdbId
    const ignoreReleaseGate = !!body.ignoreReleaseGate
    if (!tmdbId) return reply.code(400).send({ error: 'tmdbId is required' })
    const movie = getMovieByTmdbId(tmdbId)
    if (!movie || !hasAnySourceItem('movie', tmdbId)) {
      return reply.code(404).send({ error: 'Movie not found in library' })
    }
    setManualMovieAvailabilityOverride(tmdbId, ignoreReleaseGate)
    return {
      ok: true,
      title: movie?.title ?? '',
      ignoreReleaseGate,
    }
  })

  app.post('/ui/library/remove', async (req, reply) => {
    const user = currentUiUser(req as never)
    if (!user || user.role !== 'admin') return reply.code(403).send({ error: 'Admin access required' })
    const body = (req.body ?? {}) as { tmdbId?: number; type?: string }
    const { tmdbId, type } = body
    if (!tmdbId || !type) return reply.code(400).send({ error: 'tmdbId and type required' })

    if (type === 'movie') {
      setManualMovieAvailabilityOverride(tmdbId, false)
      const sourceKeys = listSourceKeysForItem('movie', tmdbId)
      const listBacked = sourceKeys.some(isListSourceKey)
      const removed = removeSourceItem('manual:ui', 'movie', tmdbId)
      if (listBacked) hideLibraryItem('movie', tmdbId)
      const pruned = listBacked ? 0 : pruneOrphanedMovies([tmdbId])
      const stillPresent = !!getMovieByTmdbId(tmdbId)
      return {
        ok: true,
        removedManual: removed > 0,
        hidden: listBacked,
        removedFromLibrary: listBacked || pruned > 0,
        stillPresent,
      }
    }

    if (type === 'tv') {
      const sourceKeys = listSourceKeysForItem('show', tmdbId)
      const listBacked = sourceKeys.some(isListSourceKey)
      const removed = removeSourceItem('manual:ui', 'show', tmdbId)
      if (listBacked) hideLibraryItem('show', tmdbId)
      const pruned = listBacked ? 0 : pruneOrphanedShows([tmdbId])
      const stillPresent = !!getShowByTmdbId(tmdbId)
      return {
        ok: true,
        removedManual: removed > 0,
        hidden: listBacked,
        removedFromLibrary: listBacked || pruned > 0,
        stillPresent,
      }
    }

    return reply.code(400).send({ error: 'type must be movie or tv' })
  })

  app.post('/ui/library/unhide', async (req, reply) => {
    if (!requireAdmin(req, reply as never)) return
    const body = (req.body ?? {}) as { tmdbId?: number; type?: string }
    const { tmdbId, type } = body
    if (!tmdbId || !type) return reply.code(400).send({ error: 'tmdbId and type required' })

    if (type === 'movie') {
      const removed = unhideLibraryItem('movie', tmdbId)
      const movie = getMovieByTmdbId(tmdbId)
      return { ok: true, unhidden: removed > 0, title: movie?.title ?? '' }
    }

    if (type === 'tv') {
      const removed = unhideLibraryItem('show', tmdbId)
      const show = getShowByTmdbId(tmdbId)
      return { ok: true, unhidden: removed > 0, title: show?.title ?? '' }
    }

    return reply.code(400).send({ error: 'type must be movie or tv' })
  })
}
