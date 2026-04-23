import { config } from './config.js'
import { DEFAULT_ADMIN_USER_ID, getDb, getSetting, hasAnySourceItem, listSourceKeys, pruneOrphanedMovies, pruneOrphanedShows, removeSourceKey, replaceSourceItems, setSetting, syncPlayed, upsertManualShowSubscription } from './db.js'
import { fetchMovieByTmdbId, fetchShowByTmdbId } from './tmdb.js'

const TRAKT_MOVIES_SOURCE = 'trakt:watchlist:movies'
const TRAKT_SHOWS_SOURCE = 'trakt:watchlist:shows'

function traktListSource(slug: string): string {
  return `trakt:list:${slug}`
}

function movieItemId(tmdbId: number): string {
  return `00000000-0000-4000-8000-${tmdbId.toString(16).padStart(12, '0')}`
}

function episodeItemId(showTmdbId: number, seasonNum: number, episodeNum: number): string {
  return `00000000-0000-4000-8003-${showTmdbId.toString(16).padStart(6, '0')}${seasonNum.toString(16).padStart(3, '0')}${episodeNum.toString(16).padStart(3, '0')}`
}

export function cleanupRemovedTraktListSources(activeSlugs: string[]): {
  removedSourceKeys: string[]
  prunedMovies: number
  prunedShows: number
} {
  const activeKeys = new Set(activeSlugs.map(traktListSource))
  const staleKeys = listSourceKeys('trakt:list:').filter(key => !activeKeys.has(key))

  let prunedMovies = 0
  let prunedShows = 0

  for (const sourceKey of staleKeys) {
    const removedMovieIds = removeSourceKey(sourceKey, 'movie')
    const removedShowIds = removeSourceKey(sourceKey, 'show')
    prunedMovies += pruneOrphanedMovies(removedMovieIds)
    prunedShows += pruneOrphanedShows(removedShowIds)
  }

  return {
    removedSourceKeys: staleKeys,
    prunedMovies,
    prunedShows,
  }
}

// ── Token storage ──────────────────────────────────────────────────────────────

function initTokenSchema(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS trakt_tokens (
      id            INTEGER PRIMARY KEY CHECK (id = 1),
      access_token  TEXT NOT NULL,
      refresh_token TEXT NOT NULL,
      expires_at    TEXT NOT NULL
    )
  `)
}

interface StoredToken {
  accessToken:  string
  refreshToken: string
  expiresAt:    Date
}

function loadToken(): StoredToken | null {
  initTokenSchema()
  const row = getDb().prepare(`SELECT * FROM trakt_tokens WHERE id = 1`).get() as
    Record<string, string> | undefined
  if (!row) return null
  return {
    accessToken:  row.access_token,
    refreshToken: row.refresh_token,
    expiresAt:    new Date(row.expires_at),
  }
}

function saveToken(accessToken: string, refreshToken: string, expiresAt: Date): void {
  initTokenSchema()
  getDb().prepare(`
    INSERT INTO trakt_tokens (id, access_token, refresh_token, expires_at)
    VALUES (1, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      access_token  = excluded.access_token,
      refresh_token = excluded.refresh_token,
      expires_at    = excluded.expires_at
  `).run(accessToken, refreshToken, expiresAt.toISOString())
}

// ── Trakt HTTP ─────────────────────────────────────────────────────────────────

async function traktRequest(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  accessToken?: string,
): Promise<{ status: number; data: unknown; headers: Headers }> {
  let lastError: Error | null = null
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`https://api.trakt.tv${path}`, {
        method,
        headers: {
          'trakt-api-version': '2',
          'trakt-api-key':     config.traktClientId,
          'Content-Type':      'application/json',
          'User-Agent':        'fetcherr/1.0',
          ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15_000),
      })
      const text = await res.text()
      let data: unknown = null
      try {
        data = text ? JSON.parse(text) : null
      } catch {
        if ([502, 503, 504].includes(res.status) && attempt < 2) {
          await new Promise(r => setTimeout(r, 500 * (attempt + 1)))
          continue
        }
        throw new Error(`Trakt ${method} ${path} → ${res.status} (non-JSON): ${text.slice(0, 300)}`)
      }
      if ([502, 503, 504].includes(res.status) && attempt < 2) {
        await new Promise(r => setTimeout(r, 500 * (attempt + 1)))
        continue
      }
      return { status: res.status, data, headers: res.headers }
    } catch (err) {
      lastError = err as Error
      if (attempt < 2) {
        await new Promise(r => setTimeout(r, 500 * (attempt + 1)))
        continue
      }
    }
  }
  throw lastError ?? new Error(`Trakt ${method} ${path} failed`)
}

// ── Token lifecycle ────────────────────────────────────────────────────────────

async function refreshAccessToken(refreshToken: string): Promise<StoredToken> {
  const { status, data } = await traktRequest('POST', '/oauth/token', {
    refresh_token: refreshToken,
    client_id:     config.traktClientId,
    client_secret: config.traktClientSecret,
    redirect_uri:  'urn:ietf:wg:oauth:2.0:oob',
    grant_type:    'refresh_token',
  })
  if (status !== 200) {
    const detail = data == null ? '' : ` ${JSON.stringify(data)}`
    throw new Error(`Token refresh failed: ${status}${detail}`)
  }
  const d = data as { access_token: string; refresh_token: string; expires_in: number; created_at: number }
  const expiresAt = new Date((d.created_at + d.expires_in) * 1000)
  saveToken(d.access_token, d.refresh_token, expiresAt)
  return { accessToken: d.access_token, refreshToken: d.refresh_token, expiresAt }
}

let refreshInFlight: Promise<StoredToken> | null = null

/** Get a valid access token, refreshing if it expires within 1 day. */
export async function getValidToken(): Promise<string | null> {
  const token = loadToken()
  if (!token) return null

  const oneDay = 24 * 60 * 60 * 1000
  if (token.expiresAt.getTime() - Date.now() < oneDay) {
    try {
      refreshInFlight ??= refreshAccessToken(token.refreshToken).finally(() => {
        refreshInFlight = null
      })
      const refreshed = await refreshInFlight
      return refreshed.accessToken
    } catch (err) {
      console.error(`trakt: token refresh failed: ${err}`)
      return token.accessToken  // return old token, may still work
    }
  }

  return token.accessToken
}

export function hasToken(): boolean {
  const token = loadToken()
  return !!token && token.expiresAt > new Date()
}

export function tokenStatus(): { authenticated: boolean; expiresAt?: string } {
  const token = loadToken()
  if (!token) return { authenticated: false }
  return {
    authenticated: token.expiresAt > new Date(),
    expiresAt:     token.expiresAt.toISOString(),
  }
}

export interface TraktUserList {
  name: string
  slug: string
}

async function syncAuthenticatedUsername(accessToken: string): Promise<string | null> {
  const { status, data } = await traktRequest('GET', '/users/settings', undefined, accessToken)
  if (status !== 200) throw new Error(`Trakt user settings fetch failed: ${status}`)
  const username = (data as { user?: { username?: string } } | null)?.user?.username?.trim() ?? ''
  if (!username) return null
  setSetting('traktUsername', username)
  config.traktUsername = username
  return username
}

async function ensureTraktUsername(accessToken?: string | null): Promise<string | null> {
  const configured = config.traktUsername.trim() || (getSetting('traktUsername') ?? '').trim()
  if (configured) {
    config.traktUsername = configured
    return configured
  }
  if (!accessToken) return null
  return syncAuthenticatedUsername(accessToken)
}

export async function fetchTraktUserLists(): Promise<TraktUserList[]> {
  if (!config.traktClientId) return []
  const accessToken = await getValidToken()
  if (!accessToken) return []
  const username = await ensureTraktUsername(accessToken)
  if (!username) return []

  const lists: TraktUserList[] = []
  const limit = 1000
  let page = 1
  let totalPages = 1

  while (page <= totalPages) {
    const { status, data, headers } = await traktRequest(
      'GET',
      `/users/${username}/lists?limit=${limit}&page=${page}`,
      undefined,
      accessToken,
    )
    if (status !== 200) throw new Error(`Trakt lists fetch failed: ${status}`)

    lists.push(...(((data as Array<{ name?: string; ids?: { slug?: string } }>) ?? [])
      .map(item => ({ name: item.name ?? item.ids?.slug ?? '', slug: item.ids?.slug ?? '' }))
      .filter(item => item.slug)))

    const pageCount = parseInt(headers.get('X-Pagination-Page-Count') ?? '1')
    totalPages = Number.isFinite(pageCount) && pageCount > 0 ? Math.min(pageCount, 100) : 1
    page++
  }

  return lists
}

// ── Device auth flow ───────────────────────────────────────────────────────────

interface DeviceCodeResponse {
  device_code:       string
  user_code:         string
  verification_url:  string
  expires_in:        number  // seconds
  interval:          number  // poll interval in seconds
}

interface DeviceTokenResponse {
  access_token:  string
  refresh_token: string
  expires_in:    number
  created_at:    number
}

export interface DeviceAuthStart {
  userCode:        string
  verificationUrl: string
  expiresIn:       number
}

/**
 * Start the device auth flow. Returns the user_code and URL to show the user.
 * Kicks off background polling — resolves the returned promise when the user
 * approves (token saved to DB) or rejects on timeout/error.
 */
export async function startDeviceAuth(): Promise<{
  instructions: DeviceAuthStart
  approved: Promise<void>
}> {
  if (!config.traktClientId || !config.traktClientSecret) {
    throw new Error('TRAKT_CLIENT_ID and TRAKT_CLIENT_SECRET must be set')
  }

  const { status, data } = await traktRequest('POST', '/oauth/device/code', {
    client_id: config.traktClientId,
  })
  if (status !== 200) throw new Error(`Device code request failed: ${status}`)

  const dc = data as DeviceCodeResponse
  const instructions: DeviceAuthStart = {
    userCode:        dc.user_code,
    verificationUrl: dc.verification_url,
    expiresIn:       dc.expires_in,
  }

  const approved = new Promise<void>((resolve, reject) => {
    const intervalMs = (dc.interval + 1) * 1000  // +1s buffer to avoid rate limit
    const deadline   = Date.now() + dc.expires_in * 1000
    let   timer: ReturnType<typeof setTimeout>

    async function poll() {
      if (Date.now() > deadline) {
        reject(new Error('Device auth expired — restart with POST /trakt/auth'))
        return
      }
      try {
        const { status: s, data: d } = await traktRequest('POST', '/oauth/device/token', {
          code:          dc.device_code,
          client_id:     config.traktClientId,
          client_secret: config.traktClientSecret,
        })
        if (s === 200) {
          const t = d as DeviceTokenResponse
          const expiresAt = new Date((t.created_at + t.expires_in) * 1000)
          saveToken(t.access_token, t.refresh_token, expiresAt)
          await syncAuthenticatedUsername(t.access_token).catch(err => {
            console.error(`trakt: unable to detect authenticated username: ${err}`)
          })
          console.log('trakt: authenticated successfully, token saved')
          resolve()
          return
        }
        // 400 = pending, 409 = already approved, 410 = expired, 418 = denied
        if (s === 410 || s === 418) {
          reject(new Error(`Device auth failed with status ${s}`))
          return
        }
        // 400 = still pending — keep polling
      } catch (err) {
        console.error(`trakt: poll error: ${err}`)
      }
      timer = setTimeout(poll, intervalMs)
    }

    timer = setTimeout(poll, intervalMs)
  })

  return { instructions, approved }
}

// ── Watchlist sync ─────────────────────────────────────────────────────────────

interface TraktWatchlistItem {
  listed_at: string
  movie: {
    title: string
    year:  number
    ids:   { trakt: number; slug: string; imdb: string; tmdb: number }
  }
}

export async function syncTraktWatchlist(): Promise<{ synced: number; total: number }> {
  if (!config.traktClientId) {
    console.log('trakt: TRAKT_CLIENT_ID not configured, skipping')
    return { synced: 0, total: 0 }
  }

  const accessToken = await getValidToken()
  if (!accessToken) {
    console.log('trakt: not authenticated — run POST /trakt/auth to connect your account')
    return { synced: 0, total: 0 }
  }
  const username = await ensureTraktUsername(accessToken)
  if (!username) {
    console.log('trakt: authenticated username unavailable, skipping')
    return { synced: 0, total: 0 }
  }

  console.log(`trakt: syncing watchlist for @${username}`)

  const items: TraktWatchlistItem[] = []
  let page = 1
  let totalPages = 1

  while (page <= totalPages) {
    const res = await fetch(
      `https://api.trakt.tv/users/${username}/watchlist/movies?limit=1000&page=${page}`,
      {
        headers: {
          'trakt-api-version': '2',
          'trakt-api-key':     config.traktClientId,
          'User-Agent':        'fetcherr/1.0',
          Authorization:       `Bearer ${accessToken}`,
        },
        signal: AbortSignal.timeout(15_000),
      }
    )
    if (!res.ok) throw new Error(`Trakt ${res.status} fetching watchlist page ${page}`)

    const pageCount = parseInt(res.headers.get('X-Pagination-Page-Count') ?? '1')
    totalPages = Math.min(pageCount, 10)
    const data = await res.json() as TraktWatchlistItem[]
    if (!data.length) break
    items.push(...data)
    page++
  }

  console.log(`trakt: found ${items.length} movies in watchlist`)

  let synced = 0
  const tmdbIds: number[] = []
  for (const item of items) {
    const tmdbId = item.movie?.ids?.tmdb
    if (!tmdbId) {
      console.log(`trakt: skipping "${item.movie?.title}" — no TMDB ID`)
      continue
    }
    tmdbIds.push(tmdbId)
    const movie = await fetchMovieByTmdbId(tmdbId, item.listed_at)
    if (movie) synced++
  }

  const removed = replaceSourceItems(TRAKT_MOVIES_SOURCE, 'movie', tmdbIds)
  const pruned = pruneOrphanedMovies(removed)

  console.log(`trakt: sync complete — ${synced}/${items.length} movies stored, ${pruned} removed`)
  return { synced, total: items.length }
}

// ── Shows watchlist sync ───────────────────────────────────────────────────────

interface TraktShowWatchlistItem {
  listed_at: string
  show: {
    title: string
    year:  number
    ids:   { trakt: number; slug: string; imdb: string; tmdb: number }
  }
}

export async function syncTraktShowsWatchlist(): Promise<{ synced: number; total: number }> {
  if (!config.traktClientId) {
    console.log('trakt: TRAKT_CLIENT_ID not configured, skipping shows sync')
    return { synced: 0, total: 0 }
  }

  const accessToken = await getValidToken()
  if (!accessToken) {
    console.log('trakt: not authenticated — run POST /trakt/auth to connect your account')
    return { synced: 0, total: 0 }
  }
  const username = await ensureTraktUsername(accessToken)
  if (!username) {
    console.log('trakt: authenticated username unavailable, skipping shows sync')
    return { synced: 0, total: 0 }
  }

  console.log(`trakt: syncing shows watchlist for @${username}`)

  const items: TraktShowWatchlistItem[] = []
  let page = 1
  let totalPages = 1

  while (page <= totalPages) {
    const res = await fetch(
      `https://api.trakt.tv/users/${username}/watchlist/shows?limit=1000&page=${page}`,
      {
        headers: {
          'trakt-api-version': '2',
          'trakt-api-key':     config.traktClientId,
          'User-Agent':        'fetcherr/1.0',
          Authorization:       `Bearer ${accessToken}`,
        },
        signal: AbortSignal.timeout(15_000),
      }
    )
    if (!res.ok) throw new Error(`Trakt ${res.status} fetching shows watchlist page ${page}`)

    const pageCount = parseInt(res.headers.get('X-Pagination-Page-Count') ?? '1')
    totalPages = Math.min(pageCount, 10)
    const data = await res.json() as TraktShowWatchlistItem[]
    if (!data.length) break
    items.push(...data)
    page++
  }

  console.log(`trakt: found ${items.length} shows in watchlist`)

  let synced = 0
  const tmdbIds: number[] = []
  for (const item of items) {
    const tmdbId = item.show?.ids?.tmdb
    if (!tmdbId) {
      console.log(`trakt: skipping "${item.show?.title}" — no TMDB ID`)
      continue
    }
    const isNewToLibrary = !hasAnySourceItem('show', tmdbId)
    tmdbIds.push(tmdbId)
    const show = await fetchShowByTmdbId(tmdbId, item.listed_at)
    if (show && isNewToLibrary && config.showAddDefaultMode === 'latest') {
      upsertManualShowSubscription(tmdbId, 'latest', 0)
    }
    if (show) synced++
  }

  const removed = replaceSourceItems(TRAKT_SHOWS_SOURCE, 'show', tmdbIds)
  const pruned = pruneOrphanedShows(removed)

  console.log(`trakt: shows sync complete — ${synced}/${items.length} shows stored, ${pruned} removed`)
  return { synced, total: items.length }
}

// ── Custom list sync ───────────────────────────────────────────────────────────

interface TraktListItem {
  type:      'movie' | 'show'
  listed_at: string
  movie?: TraktWatchlistItem['movie']
  show?:  TraktShowWatchlistItem['show']
}

export async function syncTraktList(
  slug: string,
): Promise<{ movies: number; shows: number }> {
  if (!config.traktClientId) return { movies: 0, shows: 0 }

  const accessToken = await getValidToken()
  if (!accessToken) {
    console.log('trakt: not authenticated, skipping list sync')
    return { movies: 0, shows: 0 }
  }
  const username = await ensureTraktUsername(accessToken)
  if (!username) {
    console.log(`trakt: authenticated username unavailable, skipping list "${slug}"`)
    return { movies: 0, shows: 0 }
  }

  console.log(`trakt: syncing list "${slug}" for @${username}`)

  const items: TraktListItem[] = []
  let page = 1
  let totalPages = 1

  while (page <= totalPages) {
    const res = await fetch(
      `https://api.trakt.tv/users/${username}/lists/${slug}/items?limit=1000&page=${page}`,
      {
        headers: {
          'trakt-api-version': '2',
          'trakt-api-key':     config.traktClientId,
          'User-Agent':        'fetcherr/1.0',
          Authorization:       `Bearer ${accessToken}`,
        },
        signal: AbortSignal.timeout(15_000),
      }
    )
    if (!res.ok) throw new Error(`Trakt ${res.status} fetching list "${slug}" page ${page}`)
    const pageCount = parseInt(res.headers.get('X-Pagination-Page-Count') ?? '1')
    totalPages = Math.min(pageCount, 10)
    const data = await res.json() as TraktListItem[]
    if (!data.length) break
    items.push(...data)
    page++
  }

  console.log(`trakt: list "${slug}" has ${items.length} items`)

  let movies = 0
  let shows = 0
  const movieTmdbIds: number[] = []
  const showTmdbIds: number[] = []
  for (const item of items) {
    if (item.type === 'movie' && item.movie?.ids?.tmdb) {
      movieTmdbIds.push(item.movie.ids.tmdb)
      const m = await fetchMovieByTmdbId(item.movie.ids.tmdb, item.listed_at)
      if (m) movies++
    } else if (item.type === 'show' && item.show?.ids?.tmdb) {
      const tmdbId = item.show.ids.tmdb
      const isNewToLibrary = !hasAnySourceItem('show', tmdbId)
      showTmdbIds.push(tmdbId)
      const s = await fetchShowByTmdbId(tmdbId, item.listed_at)
      if (s && isNewToLibrary && config.showAddDefaultMode === 'latest') {
        upsertManualShowSubscription(tmdbId, 'latest', 0)
      }
      if (s) shows++
    }
  }

  const sourceKey = traktListSource(slug)
  const removedMovies = replaceSourceItems(sourceKey, 'movie', movieTmdbIds)
  const removedShows = replaceSourceItems(sourceKey, 'show', showTmdbIds)
  const prunedMovies = pruneOrphanedMovies(removedMovies)
  const prunedShows = pruneOrphanedShows(removedShows)

  console.log(
    `trakt: list "${slug}" sync complete — ${movies} movies, ${shows} shows, ${prunedMovies} movies removed, ${prunedShows} shows removed`
  )
  return { movies, shows }
}

interface TraktWatchedMovieItem {
  last_watched_at?: string
  plays?: number
  movie?: {
    ids?: { tmdb?: number }
  }
}

interface TraktWatchedShowEpisode {
  number?: number
  last_watched_at?: string
  plays?: number
}

interface TraktWatchedShowSeason {
  number?: number
  episodes?: TraktWatchedShowEpisode[]
}

interface TraktWatchedShowItem {
  show?: {
    ids?: { tmdb?: number }
  }
  seasons?: TraktWatchedShowSeason[]
}

export async function syncTraktWatchedStatus(): Promise<{ movies: number; episodes: number }> {
  if (!config.traktClientId) return { movies: 0, episodes: 0 }

  const accessToken = await getValidToken()
  if (!accessToken) {
    console.log('trakt: not authenticated, skipping watched-status sync')
    return { movies: 0, episodes: 0 }
  }

  let syncedMovies = 0
  let syncedEpisodes = 0

  const syncPaged = async <T>(path: string, handlePage: (items: T[]) => void): Promise<void> => {
    let page = 1
    let totalPages = 1

    while (page <= totalPages) {
      const { status, data, headers } = await traktRequest(
        'GET',
        `${path}${path.includes('?') ? '&' : '?'}limit=1000&page=${page}`,
        undefined,
        accessToken,
      )
      if (status !== 200) throw new Error(`Trakt watched-status fetch failed: ${status} for ${path}`)

      const items = (data as T[]) ?? []
      if (!items.length) break
      handlePage(items)

      const pageCount = parseInt(headers.get('X-Pagination-Page-Count') ?? '1')
      totalPages = Number.isFinite(pageCount) && pageCount > 0 ? Math.min(pageCount, 100) : 1
      page++
    }
  }

  console.log('trakt: syncing watched status for admin account')

  await syncPaged<TraktWatchedMovieItem>('/sync/watched/movies', items => {
    for (const item of items) {
      const tmdbId = item.movie?.ids?.tmdb
      if (!tmdbId) continue
      syncPlayed(movieItemId(tmdbId), item.last_watched_at ?? '', DEFAULT_ADMIN_USER_ID)
      syncedMovies++
    }
  })

  await syncPaged<TraktWatchedShowItem>('/sync/watched/shows', items => {
    for (const item of items) {
      const showTmdbId = item.show?.ids?.tmdb
      if (!showTmdbId) continue
      for (const season of item.seasons ?? []) {
        const seasonNum = season.number
        if (!seasonNum) continue
        for (const episode of season.episodes ?? []) {
          const episodeNum = episode.number
          if (!episodeNum) continue
          syncPlayed(
            episodeItemId(showTmdbId, seasonNum, episodeNum),
            episode.last_watched_at ?? '',
            DEFAULT_ADMIN_USER_ID,
          )
          syncedEpisodes++
        }
      }
    }
  })

  console.log(`trakt: watched-status sync complete — ${syncedMovies} movies, ${syncedEpisodes} episodes marked for admin`)
  return { movies: syncedMovies, episodes: syncedEpisodes }
}
