import type { FastifyInstance } from 'fastify'
import { readFileSync, existsSync } from 'fs'
import { fileURLToPath } from 'url'
import { join, dirname } from 'path'
import {
  listMovies, countMovies, listShows, countShows, countAiredEpisodes,
  addSourceItem, getMovieByTmdbId, getShowByTmdbId, getSetting, getManualShowSubscription,
  getLatestSeasonNumberForShow, getEpisodesForShow, getMovieEligibleDate,
  getManualMovieAvailabilityOverride,
  hasAnySourceItem, hasSourceItem, pruneOrphanedMovies, pruneOrphanedShows,
  removeManualShowSubscription, removeSourceItem, setManualMovieAvailabilityOverride,
  setSetting, upsertManualShowSubscription, isMovieAvailable, isMovieVisibleToLibrary,
} from '../db.js'
import { getLogs } from '../logger.js'
import { lastSyncAt, nextSyncAt } from '../sync-state.js'
import {
  createSession, isValidSession, deleteSession, checkCredentials,
  getSessionCookie, clearSessionCookie, getTokenFromCookie,
} from './auth.js'
import { config } from '../config.js'
import { normalizeSootioUrl, parseEnglishStreamMode, parseStreamProviderUrls, parseTraktLists } from '../config.js'
import { fetchMovieByTmdbId, fetchMovieCollection, fetchShowByTmdbId, ensureShowSeasonsCached } from '../tmdb.js'
import { cleanupRemovedTraktListSources, fetchTraktUserLists } from '../trakt.js'

const __dir = dirname(fileURLToPath(import.meta.url))

const STATIC_MIME: Record<string, string> = {
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  ico: 'image/x-icon',
  js:  'text/javascript',
  css: 'text/css',
}

function html(file: string) {
  return readFileSync(join(__dir, file), 'utf8')
}

function tmdbToMovieGuid(tmdbId: number) {
  return `00000000-0000-4000-8000-${tmdbId.toString(16).padStart(12, '0')}`
}
function tmdbToShowGuid(tmdbId: number) {
  return `00000000-0000-4000-8001-${tmdbId.toString(16).padStart(12, '0')}`
}

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10)
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
  app.get('/ui/login', async (_req, reply) => reply.type('text/html').send(html('login.html')))

  app.post('/ui/auth/login', async (req, reply) => {
    if (!config.uiPassword) {
      return reply.code(503).send({ error: 'UI auth is not configured. Set UI_PASSWORD first.' })
    }
    const rateKey = clientIp(req as never)
    const state = loginRateState(rateKey)
    if (state.count >= LOGIN_MAX_ATTEMPTS) {
      return reply.code(429).send({ error: 'Too many login attempts. Please try again later.' })
    }
    const body = req.body as { username?: string; password?: string } | undefined
    const username = body?.username ?? ''
    const password = body?.password ?? ''
    if (checkCredentials(username, password)) {
      loginAttempts.delete(rateKey)
      const token = createSession()
      reply.header('Set-Cookie', getSessionCookie(token, req.headers as never))
      return { ok: true }
    }
    state.count += 1
    return reply.code(401).send({ error: 'Invalid credentials' })
  })

  app.post('/ui/auth/logout', async (req, reply) => {
    const token = getTokenFromCookie(req.headers.cookie)
    if (token) deleteSession(token)
    reply.header('Set-Cookie', clearSessionCookie(req.headers as never))
    return { ok: true }
  })

  // Auth status — tells the client whether auth is enabled
  app.get('/ui/auth/check', async (req, reply) => {
    if (!config.uiPassword) {
      return reply.code(503).send({ error: 'UI auth is not configured. Set UI_PASSWORD first.' })
    }
    const token = getTokenFromCookie(req.headers.cookie)
    if (!token || !isValidSession(token)) {
      return reply.code(401).send({ error: 'Unauthorized' })
    }
    return { authEnabled: true }
  })

  // ── Auth middleware for all other /ui/* routes ────────────────────────────
  app.addHook('preHandler', async (req, reply) => {
    const url = req.url.split('?')[0]
    // Skip public routes
    if (
      url === '/ui/login' ||
      url.startsWith('/ui/auth/') ||
      url.startsWith('/ui/static/')
    ) return

    if (!config.uiPassword) {
      const isApiRoute = /^\/ui\/(stats|movies|shows|logs-data|settings-data|search|library|trakt)/.test(url)
      if (isApiRoute) {
        return reply.code(503).send({ error: 'UI auth is not configured. Set UI_PASSWORD first.' })
      }
      return reply.code(503).type('text/plain').send('UI auth is not configured. Set UI_PASSWORD first.')
    }

    const token = getTokenFromCookie(req.headers.cookie)
    if (!token || !isValidSession(token)) {
      const isApiRoute = /^\/ui\/(stats|movies|shows|logs-data|settings-data|search|library)/.test(url)
      if (isApiRoute) {
        return reply.code(401).send({ error: 'Unauthorized' })
      }
      return reply.redirect(`/ui/login?next=${encodeURIComponent(req.url)}`, 302)
    }
  })

  // ── Page routes ────────────────────────────────────────────────────────────
  app.get('/',              async (_req, reply) => reply.redirect('/ui/dashboard', 302))
  app.get('/ui/dashboard',  async (_req, reply) => reply.type('text/html').send(html('dashboard.html')))
  app.get('/ui/setup',      async (_req, reply) => reply.type('text/html').send(html('setup.html')))
  app.get('/ui/logs',       async (_req, reply) => reply.type('text/html').send(html('logs.html')))

  // ── Stats ──────────────────────────────────────────────────────────────────
  app.get('/ui/stats', async () => {
    const movies   = countMovies()
    const shows    = countShows()
    const episodes = countAiredEpisodes()
    return {
      movies,
      shows,
      episodes,
      lastSyncAt,
      nextSyncAt,
    }
  })

  // ── Movies list ────────────────────────────────────────────────────────────
  app.get('/ui/movies', async (req) => {
    const q      = (req as never as { query: Record<string, string> }).query
    const search = q.search || undefined
    const sortBy = q.sortBy || 'popularity'
    const sortOrder = q.sortOrder || 'DESC'
    const limit  = Math.min(parseInt(q.limit ?? '100'), 500)
    const offset = parseInt(q.offset ?? '0')

    const items = listMovies({ search, sortBy, sortOrder, limit, offset })
    const total = countMovies(search)

    return {
      items: items.map(m => ({
        id:           m.id,
        tmdbId:       m.tmdbId,
        imdbId:       m.imdbId,
        title:        m.title,
        year:         m.year,
        overview:     m.overview,
        genres:       JSON.parse(m.genres || '[]') as string[],
        runtimeMins:  m.runtimeMins,
        popularity:   m.popularity,
        manualAdded:  hasSourceItem('manual:ui', 'movie', m.tmdbId),
        isAvailable:  isMovieVisibleToLibrary(m),
        pendingLabel: isMovieVisibleToLibrary(m) ? null : 'Pending Digital Release',
        posterUrl:    m.posterPath ? `https://image.tmdb.org/t/p/w185${m.posterPath}` : null,
        imageId:      tmdbToMovieGuid(m.tmdbId),
      })),
      total,
    }
  })

  // ── Shows list ─────────────────────────────────────────────────────────────
  app.get('/ui/shows', async (req) => {
    const q      = (req as never as { query: Record<string, string> }).query
    const search = q.search || undefined
    const sortBy = q.sortBy || 'popularity'
    const sortOrder = q.sortOrder || 'DESC'
    const limit  = Math.min(parseInt(q.limit ?? '100'), 500)
    const offset = parseInt(q.offset ?? '0')

    const items = listShows({ search, sortBy, sortOrder, limit, offset })
    const total = countShows(search)

    return {
      items: items.map(s => ({
        id:         s.id,
        tmdbId:     s.tmdbId,
        imdbId:     s.imdbId,
        title:      s.title,
        year:       s.year,
        overview:   s.overview,
        genres:     JSON.parse(s.genres || '[]') as string[],
        status:     s.status,
        numSeasons: s.numSeasons,
        popularity: s.popularity,
        manualAdded: hasSourceItem('manual:ui', 'show', s.tmdbId),
        manualMode: getManualShowSubscription(s.tmdbId)?.mode ?? null,
        posterUrl:  s.posterPath ? `https://image.tmdb.org/t/p/w185${s.posterPath}` : null,
        imageId:    tmdbToShowGuid(s.tmdbId),
      })),
      total,
    }
  })

  app.get('/ui/library/item', async (req, reply) => {
    const q = (req as never as { query: Record<string, string> }).query
    const type = q.type === 'tv' ? 'tv' : q.type === 'movie' ? 'movie' : ''
    const tmdbId = Number.parseInt(q.tmdbId ?? '', 10)
    if (!type || !Number.isFinite(tmdbId)) {
      return reply.code(400).send({ error: 'type and tmdbId are required' })
    }

    if (type === 'movie') {
      const movie = getMovieByTmdbId(tmdbId) ?? await fetchMovieByTmdbId(tmdbId)
      if (!movie) return reply.code(404).send({ error: 'Movie not found' })

      const eligibleDate = getMovieEligibleDate(movie)
      const releaseGateOverridden = getManualMovieAvailabilityOverride(movie.tmdbId)
      const isAvailable = isMovieVisibleToLibrary(movie)

      return {
        type,
        tmdbId: movie.tmdbId,
        title: movie.title,
        year: movie.year,
        overview: movie.overview,
        posterUrl: movie.posterPath ? `https://image.tmdb.org/t/p/w342${movie.posterPath}` : null,
        imdbId: movie.imdbId,
        manualAdded: hasSourceItem('manual:ui', 'movie', movie.tmdbId),
        visibleToInfuse: isAvailable,
        libraryStatusLabel: isAvailable
          ? (releaseGateOverridden && !isMovieAvailable(movie) ? 'In Library via Override' : 'In Library')
          : 'Pending Digital Release',
        releaseGateOverridden,
        eligibleDate,
        releaseDate: movie.releaseDate || null,
        digitalReleaseDate: movie.digitalReleaseDate || null,
        collectionItems: (await fetchMovieCollection(movie.tmdbId))
          .filter(item => item.tmdbId !== movie.tmdbId)
          .map(item => ({
          ...item,
          inLibrary: hasAnySourceItem('movie', item.tmdbId),
        })),
      }
    }

    const show = getShowByTmdbId(tmdbId) ?? await fetchShowByTmdbId(tmdbId)
    if (!show) return reply.code(404).send({ error: 'Show not found' })

    await ensureShowSeasonsCached(show).catch(() => {})
    const today = todayIsoDate()
    const episodes = getEpisodesForShow(show.tmdbId)
    const visibleToInfuse = episodes.some(e => !!e.airDate && e.airDate <= today)
    const nextEpisode = episodes.find(e => !!e.airDate && e.airDate > today) ?? null

    return {
      type,
      tmdbId: show.tmdbId,
      title: show.title,
      year: show.year,
      overview: show.overview,
      posterUrl: show.posterPath ? `https://image.tmdb.org/t/p/w342${show.posterPath}` : null,
      imdbId: show.imdbId,
      manualAdded: hasSourceItem('manual:ui', 'show', show.tmdbId),
      visibleToInfuse,
      libraryStatusLabel: visibleToInfuse ? 'In Library' : 'Pending First Episode',
      nextEpisodeAirDate: nextEpisode?.airDate || null,
      nextEpisodeName: nextEpisode?.name || null,
      nextEpisodeSeasonNumber: nextEpisode?.seasonNumber ?? null,
      nextEpisodeEpisodeNumber: nextEpisode?.episodeNumber ?? null,
      manualMode: getManualShowSubscription(show.tmdbId)?.mode ?? null,
      status: show.status,
      numSeasons: show.numSeasons,
    }
  })

  // ── Logs ───────────────────────────────────────────────────────────────────
  app.get('/ui/logs-data', async (req) => {
    const q     = (req as never as { query: Record<string, string> }).query
    const level = q.level
    return { entries: getLogs(level) }
  })

  // ── Settings page ──────────────────────────────────────────────────────────
  app.get('/ui/settings', async (_req, reply) => reply.type('text/html').send(html('settings.html')))

  // GET settings — returns current in-memory config values
  app.get('/ui/settings-data', async () => ({
    sootioUrl:         config.sootioUrl,
    streamProviderUrls: config.streamProviderUrls.join('\n'),
    englishStreamMode: config.englishStreamMode,
    serverUrl:         config.serverUrl,
    traktClientId:     config.traktClientId,
    traktLists:        config.traktLists,
    hasSootioUrl:      !!getSetting('sootioUrl'),
    hasRdApiKey:       !!getSetting('rdApiKey'),
    hasTmdbApiKey:     !!getSetting('tmdbApiKey'),
    hasTraktClientSecret: !!getSetting('traktClientSecret'),
  }))

  app.get('/ui/trakt/lists', async (req, reply) => {
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

  // POST settings — persist to DB and update in-memory config
  app.post('/ui/settings-data', async (req) => {
    const body = (req.body ?? {}) as Record<string, string | string[]>
    const editable: (keyof typeof config)[] = [
      'sootioUrl', 'rdApiKey', 'tmdbApiKey', 'serverUrl', 'traktClientId', 'traktClientSecret',
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
    if (typeof body.streamProviderUrls === 'string') {
      const urls = parseStreamProviderUrls(body.streamProviderUrls)
      setSetting('streamProviderUrls', urls.join('\n'))
      config.streamProviderUrls = urls
    }
    if (typeof body.englishStreamMode === 'string') {
      const mode = parseEnglishStreamMode(body.englishStreamMode)
      setSetting('englishStreamMode', mode)
      config.englishStreamMode = mode
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
    return { ok: true }
  })

  // ── TMDB search (no upsert) ────────────────────────────────────────────────
  app.get('/ui/search', async (req, reply) => {
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
      const inLibrary = hasAnySourceItem(type === 'movie' ? 'movie' : 'show', tmdbId)
      return { tmdbId, title, year, poster, inLibrary, type }
    })

    return { results }
  })

  // ── Add to library ─────────────────────────────────────────────────────────
  app.post('/ui/library/add', async (req, reply) => {
    const body = (req.body ?? {}) as { tmdbId?: number; type?: string; mode?: string }
    const { tmdbId, type } = body
    const mode = body.mode === 'latest' ? 'latest' : 'all'
    if (!tmdbId || !type) return reply.code(400).send({ error: 'tmdbId and type required' })
    if (!config.tmdbApiKey) return reply.code(503).send({ error: 'TMDB API key not configured' })

    if (type === 'movie') {
      const movie = await fetchMovieByTmdbId(tmdbId)
      if (!movie) return reply.code(404).send({ error: 'Movie not found on TMDB' })
      addSourceItem('manual:ui', 'movie', tmdbId)
      return { ok: true, title: movie.title }
    }

    if (type === 'tv') {
      const show = await fetchShowByTmdbId(tmdbId)
      if (!show) return reply.code(404).send({ error: 'Show not found on TMDB' })
      await ensureShowSeasonsCached(show).catch(() => {})
      const activeSeasonNumber = mode === 'latest'
        ? (getLatestSeasonNumberForShow(tmdbId) ?? Math.max(show.numSeasons, 1))
        : 0
      upsertManualShowSubscription(tmdbId, mode, activeSeasonNumber)
      addSourceItem('manual:ui', 'show', tmdbId)
      return { ok: true, title: show.title, mode, activeSeasonNumber }
    }

    return reply.code(400).send({ error: 'type must be movie or tv' })
  })

  app.post('/ui/library/movie-availability', async (req, reply) => {
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
    const body = (req.body ?? {}) as { tmdbId?: number; type?: string }
    const { tmdbId, type } = body
    if (!tmdbId || !type) return reply.code(400).send({ error: 'tmdbId and type required' })

    if (type === 'movie') {
      setManualMovieAvailabilityOverride(tmdbId, false)
      const removed = removeSourceItem('manual:ui', 'movie', tmdbId)
      const pruned = pruneOrphanedMovies([tmdbId])
      const stillPresent = !!getMovieByTmdbId(tmdbId)
      return {
        ok: true,
        removedManual: removed > 0,
        removedFromLibrary: pruned > 0,
        stillPresent,
      }
    }

    if (type === 'tv') {
      const removed = removeSourceItem('manual:ui', 'show', tmdbId)
      removeManualShowSubscription(tmdbId)
      const pruned = pruneOrphanedShows([tmdbId])
      const stillPresent = !!getShowByTmdbId(tmdbId)
      return {
        ok: true,
        removedManual: removed > 0,
        removedFromLibrary: pruned > 0,
        stillPresent,
      }
    }

    return reply.code(400).send({ error: 'type must be movie or tv' })
  })
}
