import { config } from './config.js'
import { rankSearchResults } from './search-rank.js'
import { trimCacheMap } from './cache-utils.js'
import type { Movie } from './db.js'
import type { StremioMediaType, StremioMeta } from './sootio.js'

// TMDB as a search source. It matches original and translated titles, which
// Cinemeta does not, and it goes deeper. Streams are looked up by IMDb id, so
// every hit is resolved through external_ids, and a title TMDB has no IMDb id
// for is left out: nothing could play it.

export const TMDB_MOVIES_PER_SEARCH = 40
// The apps show at most 24 (VidHub) or 50 (Infuse) results in all.
export const TMDB_SERIES_PER_SEARCH = 20

const PAGE_TTL_MS = 10 * 60 * 1000
const PAGE_CACHE_MAX = 500
// IMDb ids never change, so they are kept for good. The cap only stops a
// process that runs for months from growing without bound.
const IMDB_CACHE_MAX = 10_000
// A missing one often gets filled in, above all for new titles, so "none" is
// asked again after a day rather than hiding the title until a restart.
const NO_IMDB_ID_TTL_MS = 24 * 60 * 60 * 1000
// TMDB allows about 50 requests a second per key and about 20 connections from
// one address, which the poster route shares. Ten in flight ran 80 lookups in
// 1.2 to 5.6 s on 2026-09-27 without a single refusal. It is one budget for the
// whole process, because every keystroke starts a new search.
const REQUESTS_IN_FLIGHT = 10
const FAILURE_LOG_INTERVAL_MS = 10 * 60 * 1000
// After a search call fails, TMDB is not asked for this long. Failures are not
// cached, so a TMDB that hangs would otherwise cost every keystroke a timeout
// before Cinemeta is asked.
const REST_AFTER_FAILURE_MS = 60 * 1000
const IMDB_ID = /^tt\d+$/
const DATE = /^\d{4}-\d{2}-\d{2}$/
// TMDB sends bare image paths. Anything else did not come from TMDB and is not
// handed to the image proxy.
const IMAGE_PATH = /^\/[\w.-]+$/

export interface TmdbMovieHit {
  tmdbId: number
  imdbId: string
  title: string
  // Jellyfin's OriginalTitle: the title in its own language. A search term in
  // that language often matches it better than the English title does.
  originalTitle: string
  originalLanguage: string
  releaseDate: string
  year: number
  overview: string
  posterPath: string
  backdropPath: string
  popularity: number
  voteAverage: number
}

export interface TmdbSeriesHit {
  tmdbId: number
  imdbId: string
  name: string
  originalTitle: string
  firstAirDate: string
  year: number
  overview: string
  posterPath: string
  backdropPath: string
  popularity: number
}

// What the library already holds, so TMDB does not repeat it and no lookup is spent on it.
export interface TmdbSkip {
  movieTmdbIds: ReadonlySet<number>
  movieImdbIds: ReadonlySet<string>
  seriesTmdbIds: ReadonlySet<number>
  seriesImdbIds: ReadonlySet<string>
}

// null: TMDB could not answer for that type, and the caller asks Cinemeta instead.
// []: TMDB answered with nothing usable, or the type was not asked for.
export interface TmdbHits {
  movies: TmdbMovieHit[] | null
  series: TmdbSeriesHit[] | null
}

type Kind = 'movie' | 'tv'
type MovieCandidate = Omit<TmdbMovieHit, 'imdbId'>
type SeriesCandidate = Omit<TmdbSeriesHit, 'imdbId'>
interface Page<T> {
  results: T[]
  totalPages: number
}

const NOTHING_TO_SKIP: TmdbSkip = { movieTmdbIds: new Set(), movieImdbIds: new Set(), seriesTmdbIds: new Set(), seriesImdbIds: new Set() }

const pageCache = new Map<string, { promise: Promise<Page<unknown>>; expiresAt: number }>()
// '' is an answer too: TMDB has no IMDb id for that title, until expiresAt.
const imdbCache = new Map<string, { imdbId: string; expiresAt: number }>()
const lookupsInFlight = new Map<string, Promise<string | null>>()
let lastFailureLogAt: number | undefined
let restingUntil: number | undefined
let requestsInFlight = 0
// Each search's number, higher for newer ones. A user typing a title starts a
// search per keystroke and sees only the last, so the newest goes first.
let searchesStarted = 0
const waitingForTurn: Array<{ priority: number; start: () => void }> = []

// Called on every settings save. A new key should be tried, and its failure
// logged, on the next keystroke, not after a rest or ten minutes later.
export function clearTmdbSearchCache(): void {
  pageCache.clear()
  lastFailureLogAt = undefined
  restingUntil = undefined
}

export async function findTmdbTitles(term: string, types: StremioMediaType[], skip: TmdbSkip = NOTHING_TO_SKIP): Promise<TmdbHits> {
  if (!term.trim()) return { movies: [], series: [] }
  if (resting()) {
    return { movies: types.includes('movie') ? null : [], series: types.includes('series') ? null : [] }
  }
  const priority = ++searchesStarted
  const [movies, series] = await Promise.all([
    types.includes('movie') ? searchType('movie', term, parseMovie, priority) : Promise.resolve([] as MovieCandidate[]),
    types.includes('series') ? searchType('tv', term, parseSeries, priority) : Promise.resolve([] as SeriesCandidate[]),
  ])
  const movieCandidates = (movies ?? []).filter(movie => !skip.movieTmdbIds.has(movie.tmdbId)).slice(0, TMDB_MOVIES_PER_SEARCH)
  // Ranked before the cap, because TMDB's popularity order puts loose matches
  // ahead of the exact title, and exact titles often have no IMDb id.
  const seriesCandidates = rankByName((series ?? []).filter(show => !skip.seriesTmdbIds.has(show.tmdbId)), show => show.name, term)
  const imdbIds = await resolveImdbIds(term, movieCandidates, seriesCandidates, skip.seriesImdbIds, priority)
  return {
    movies: movies === null ? null : withImdbIds(movieCandidates, 'movie', imdbIds, skip.movieImdbIds).slice(0, TMDB_MOVIES_PER_SEARCH),
    series: series === null ? null : withImdbIds(seriesCandidates, 'tv', imdbIds, skip.seriesImdbIds).slice(0, TMDB_SERIES_PER_SEARCH),
  }
}

// The record a search-movie item is built from, minus what only the full fetch
// knows (cast, runtime, rating). Opening the item fetches that.
export function tmdbMovieToMovie(hit: TmdbMovieHit): Movie {
  return {
    id: 0,
    tmdbId: hit.tmdbId,
    imdbId: hit.imdbId,
    mediaLanguage: hit.originalLanguage,
    title: hit.title,
    year: hit.year,
    overview: hit.overview,
    posterPath: hit.posterPath,
    backdropPath: hit.backdropPath,
    logoPath: '',
    genres: '[]',
    runtimeMins: 0,
    popularity: hit.popularity,
    officialRating: '',
    communityRating: hit.voteAverage,
    studiosJson: '[]',
    tagsJson: '[]',
    castJson: '[]',
    releaseDate: hit.releaseDate,
    digitalReleaseDate: '',
    syncedAt: new Date().toISOString(),
  }
}

// Keyed by IMDb id like a Cinemeta series result, so it opens, lists seasons and
// plays through the same Stremio series path. The image paths stay bare;
// posterUrl sizes them when a client asks.
export function tmdbSeriesToMeta(hit: TmdbSeriesHit): StremioMeta {
  return {
    id: hit.imdbId,
    type: 'series',
    name: hit.name,
    ...(hit.posterPath ? { poster: hit.posterPath } : {}),
    ...(hit.backdropPath ? { background: hit.backdropPath } : {}),
    ...(hit.overview ? { description: hit.overview } : {}),
    ...(hit.year ? { releaseInfo: String(hit.year) } : {}),
  }
}

async function searchType<T>(kind: Kind, term: string, parse: (entry: unknown) => T | null, priority: number): Promise<T[] | null> {
  let first: Page<T>
  try {
    first = await cachedPage(kind, term, 1, parse, priority)
  } catch (err) {
    searchFailed(err)
    return null
  }
  if (first.totalPages < 2) return first.results
  try {
    const second = await cachedPage(kind, term, 2, parse, priority)
    return [...first.results, ...second.results]
  } catch (err) {
    // Page 1 is an answer, so Cinemeta is not asked for this type.
    searchFailed(err)
    return first.results
  }
}

function cachedPage<T>(kind: Kind, term: string, page: number, parse: (entry: unknown) => T | null, priority: number): Promise<Page<T>> {
  const key = `${kind}|${page}|${term}`
  const now = Date.now()
  const cached = pageCache.get(key)
  if (cached && cached.expiresAt > now) return cached.promise as Promise<Page<T>>
  // Deleted first, so the fresh entry goes to the back of the eviction order.
  pageCache.delete(key)
  const path = `/search/${kind}`
  // The same length of time for waiting in line and, once sent, for TMDB's answer.
  const promise = tmdbSearchGet(path, { query: term, language: 'en-US', include_adult: 'false', page: String(page) },
    AbortSignal.timeout(config.tmdbSearchTimeoutMs), priority, config.tmdbSearchTimeoutMs).then(raw => parsePage(raw, parse, path))
  const entry = { promise: promise as Promise<Page<unknown>>, expiresAt: now + PAGE_TTL_MS }
  pageCache.set(key, entry)
  trimCacheMap(pageCache, PAGE_CACHE_MAX)
  // Failures are not kept: the next keystroke asks again.
  promise.catch(() => {
    if (pageCache.get(key) === entry) pageCache.delete(key)
  })
  return promise
}

function parsePage<T>(raw: unknown, parse: (entry: unknown) => T | null, path: string): Page<T> {
  if (!isRecord(raw) || !Array.isArray(raw.results)) throw new Error(`${path} answered without a results list`)
  const totalPages = typeof raw.total_pages === 'number' && Number.isFinite(raw.total_pages) ? raw.total_pages : 1
  return { results: raw.results.map(entry => parse(entry)).filter((entry): entry is T => entry !== null), totalPages }
}

function rankByName<T extends { originalTitle: string }>(items: T[], name: (item: T) => string, term: string): T[] {
  return rankSearchResults(items.map(item => ({ Name: name(item), OriginalTitle: item.originalTitle, item })), term).map(entry => entry.item)
}

// Keyed `${kind}:${tmdbId}`: an IMDb id, '' for none, null for a failed lookup.
async function resolveImdbIds(
  term: string,
  movies: MovieCandidate[],
  series: SeriesCandidate[],
  seriesSkipImdbIds: ReadonlySet<string>,
  priority: number,
): Promise<Map<string, string | null>> {
  // Best title matches go first, so a window that closes early costs the loosest ones.
  const queue = rankSearchResults([
    ...movies.map(movie => ({ Name: movie.title, OriginalTitle: movie.originalTitle, kind: 'movie' as Kind, tmdbId: movie.tmdbId })),
    ...series.map(show => ({ Name: show.name, OriginalTitle: show.originalTitle, kind: 'tv' as Kind, tmdbId: show.tmdbId })),
  ], term)
  const found = new Map<string, string | null>()
  if (!queue.length) return found
  // One window for the whole search, so a slow TMDB costs one timeout rather
  // than one per ten titles.
  const window = AbortSignal.timeout(config.tmdbSearchTimeoutMs)
  let next = 0
  // Series are cut to 20 once looked up, and the queue is in rank order, so the
  // ones after the twentieth to have a usable id could never be shown.
  const seriesKept = new Set<string>()
  const worker = async () => {
    while (next < queue.length && !window.aborted) {
      const { kind, tmdbId } = queue[next++]
      if (kind === 'tv' && seriesKept.size >= TMDB_SERIES_PER_SEARCH) continue
      const imdbId = await imdbIdFor(kind, tmdbId, window, priority)
      found.set(`${kind}:${tmdbId}`, imdbId)
      if (kind === 'tv' && imdbId && !seriesSkipImdbIds.has(imdbId)) seriesKept.add(imdbId)
    }
  }
  await Promise.all(Array.from({ length: Math.min(REQUESTS_IN_FLIGHT, queue.length) }, worker))
  // A window that closed early stopped the workers, but an id already known
  // costs nothing to fill in.
  for (const { kind, tmdbId } of queue) {
    const key = `${kind}:${tmdbId}`
    if (found.get(key) != null) continue
    const known = knownImdbId(key)
    if (known !== undefined) found.set(key, known)
  }
  return found
}

function knownImdbId(key: string): string | undefined {
  const known = imdbCache.get(key)
  return known && known.expiresAt > Date.now() ? known.imdbId : undefined
}

function imdbIdFor(kind: Kind, tmdbId: number, window: AbortSignal, priority: number): Promise<string | null> {
  const key = `${kind}:${tmdbId}`
  const known = knownImdbId(key)
  if (known !== undefined) return Promise.resolve(known)
  const pending = lookupsInFlight.get(key)
  if (pending) return pending
  const lookup = tmdbSearchGet(`/${kind}/${tmdbId}/external_ids`, {}, window, priority)
    .then(raw => {
      const imdbId = isRecord(raw) && typeof raw.imdb_id === 'string' && IMDB_ID.test(raw.imdb_id) ? raw.imdb_id : ''
      // Deleted first, so a refreshed entry goes to the back of the eviction order.
      imdbCache.delete(key)
      imdbCache.set(key, { imdbId, expiresAt: imdbId ? Infinity : Date.now() + NO_IMDB_ID_TTL_MS })
      trimCacheMap(imdbCache, IMDB_CACHE_MAX)
      return imdbId
    }, (err: unknown) => {
      // Not cached: the next search asks again.
      logFailure(err)
      return null
    })
    .finally(() => lookupsInFlight.delete(key))
  lookupsInFlight.set(key, lookup)
  return lookup
}

function withImdbIds<T extends { tmdbId: number }>(
  candidates: T[],
  kind: Kind,
  imdbIds: Map<string, string | null>,
  skipImdbIds: ReadonlySet<string>,
): Array<T & { imdbId: string }> {
  const seen = new Set<string>()
  const hits: Array<T & { imdbId: string }> = []
  for (const candidate of candidates) {
    const imdbId = imdbIds.get(`${kind}:${candidate.tmdbId}`)
    if (!imdbId || seen.has(imdbId) || skipImdbIds.has(imdbId)) continue
    seen.add(imdbId)
    hits.push({ ...candidate, imdbId })
  }
  return hits
}

// Our own line ran out of time, not TMDB, so TMDB is not rested for it.
class NoTurnInTime extends Error {}

// The key travels in the query string, so every error names the path alone.
// `wait` bounds the time in line, and the request too unless it has a timeout
// of its own, which starts once it is sent. A request that waited behind newer
// searches then times out on TMDB's answer alone.
async function tmdbSearchGet(path: string, params: Record<string, string>, wait: AbortSignal, priority: number, timeoutMs?: number): Promise<unknown> {
  if (!await takeTurn(wait, priority)) throw new NoTurnInTime(`${path} timed out waiting for its turn`)
  const signal = timeoutMs === undefined ? wait : AbortSignal.timeout(timeoutMs)
  try {
    const query = new URLSearchParams({ ...params, api_key: config.tmdbApiKey })
    let res: Response
    try {
      res = await fetch(`${config.tmdbBaseUrl}${path}?${query}`, { signal })
    } catch {
      throw new Error(signal.aborted ? `${path} timed out` : `${path} could not be reached`)
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {})
      throw new Error(`${path} answered HTTP ${res.status}`)
    }
    try {
      return await res.json()
    } catch {
      throw new Error(signal.aborted ? `${path} timed out` : `${path} answered something other than JSON`)
    }
  } finally {
    endTurn()
  }
}

// False when the signal gave up first. A request that gives up leaves the line,
// so a search the user has typed past holds no place in it.
function takeTurn(signal: AbortSignal, priority: number): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false)
  if (requestsInFlight < REQUESTS_IN_FLIGHT) {
    requestsInFlight++
    return Promise.resolve(true)
  }
  return new Promise(resolve => {
    const waiter = {
      priority,
      start: () => {
        signal.removeEventListener('abort', leave)
        requestsInFlight++
        resolve(true)
      },
    }
    const leave = () => {
      waitingForTurn.splice(waitingForTurn.indexOf(waiter), 1)
      resolve(false)
    }
    signal.addEventListener('abort', leave, { once: true })
    waitingForTurn.push(waiter)
  })
}

// The newest search first, and within one search the order it asked in, which
// puts its best title matches first.
function endTurn(): void {
  requestsInFlight--
  let next = -1
  for (let i = 0; i < waitingForTurn.length; i++) {
    if (next < 0 || waitingForTurn[i].priority > waitingForTurn[next].priority) next = i
  }
  if (next >= 0) waitingForTurn.splice(next, 1)[0].start()
}

// Rating checks for a limited account reach TMDB through src/tmdb.ts, outside
// this module. They take turns from the same budget, so one kids account typing
// a title cannot outrun the limit every other search keeps to. The priority is
// fixed and lower than any search's, so a lookup always goes first when both are
// waiting. `work` must not itself take a turn: nothing it reaches may call
// tmdbSearchGet, or it would wait behind a turn it is holding.
const RATING_CHECK_PRIORITY = 0

export async function withTmdbTurn<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T | null> {
  if (!await takeTurn(signal, RATING_CHECK_PRIORITY)) return null
  try {
    return await work()
  } finally {
    endTurn()
  }
}

function searchFailed(reason: unknown): void {
  if (reason instanceof NoTurnInTime) logFailure(reason)
  else rest(reason)
}

function resting(): boolean {
  return restingUntil !== undefined && Date.now() < restingUntil
}

// One line per rest, so at most one a minute however many keystrokes fail.
function rest(reason: unknown): void {
  if (resting()) return
  restingUntil = Date.now() + REST_AFTER_FAILURE_MS
  console.warn(`tmdb search: ${reason instanceof Error ? reason.message : String(reason)}, so Cinemeta answers for the next ${REST_AFTER_FAILURE_MS / 1000} s`)
}

// Search runs on every keystroke, so an outage would otherwise log a line per key.
function logFailure(reason: unknown): void {
  const now = Date.now()
  if (lastFailureLogAt !== undefined && now - lastFailureLogAt < FAILURE_LOG_INTERVAL_MS) return
  lastFailureLogAt = now
  console.warn(`tmdb search: ${reason instanceof Error ? reason.message : String(reason)}`)
}

function parseMovie(entry: unknown): MovieCandidate | null {
  if (!isRecord(entry)) return null
  const tmdbId = positiveInteger(entry.id)
  const title = text(entry.title)
  if (!tmdbId || !title) return null
  const releaseDate = isoDate(entry.release_date)
  return {
    tmdbId,
    title,
    originalTitle: text(entry.original_title),
    originalLanguage: text(entry.original_language).toLowerCase(),
    releaseDate,
    year: releaseDate ? Number(releaseDate.slice(0, 4)) : 0,
    overview: text(entry.overview),
    posterPath: imagePath(entry.poster_path),
    backdropPath: imagePath(entry.backdrop_path),
    popularity: finiteNumber(entry.popularity),
    voteAverage: finiteNumber(entry.vote_average),
  }
}

function parseSeries(entry: unknown): SeriesCandidate | null {
  if (!isRecord(entry)) return null
  const tmdbId = positiveInteger(entry.id)
  const name = text(entry.name)
  if (!tmdbId || !name) return null
  const firstAirDate = isoDate(entry.first_air_date)
  return {
    tmdbId,
    name,
    originalTitle: text(entry.original_name),
    firstAirDate,
    year: firstAirDate ? Number(firstAirDate.slice(0, 4)) : 0,
    overview: text(entry.overview),
    posterPath: imagePath(entry.poster_path),
    backdropPath: imagePath(entry.backdrop_path),
    popularity: finiteNumber(entry.popularity),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function positiveInteger(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : 0
}

function finiteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function isoDate(value: unknown): string {
  return typeof value === 'string' && DATE.test(value) ? value : ''
}

function imagePath(value: unknown): string {
  return typeof value === 'string' && IMAGE_PATH.test(value) ? value : ''
}
