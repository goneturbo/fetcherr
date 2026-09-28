import { createServer, type Server } from 'node:http'

// A stand-in TMDB over real HTTP, so the search client really connects, really
// times out and really parses JSON. It answers the calls fetcherr makes during
// a search and a rating check: /search/movie, /search/tv,
// /{movie|tv}/{id}/external_ids, /movie/{id}, /tv/{id} and /find/{imdb}.
// Behaviour is chosen per scope and can be switched mid-test.
//
// Not a test file itself: `npm test` globs test/*.test.ts.

export const FAKE_TMDB_KEY = 'fake-tmdb-key'

export type FakeTmdbScope = 'movie' | 'tv' | 'movie-ids' | 'tv-ids' | 'movie-details' | 'tv-details' | 'find'
export type FakeTmdbMode = 'answers' | 'empty' | 'slow' | 'unauthorized' | 'error'

export interface FakeTmdbMovie {
  id: number
  title: string
  original_title?: string
  // null: TMDB knows the title but has no IMDb id for it.
  imdb: string | null
  release_date?: string
  overview?: string
  poster_path?: string | null
  // The US certification /movie/{id} reports. Unset: none at all.
  certification?: string
  // Default 1, matching every fixture from before popularity ordering mattered.
  popularity?: number
}

export interface FakeTmdbSeries {
  id: number
  name: string
  original_name?: string
  imdb: string | null
  first_air_date?: string
  overview?: string
  poster_path?: string | null
  popularity?: number
  // The US content rating /tv/{id} reports. Unset: none at all.
  certification?: string
}

export interface FakeTmdbOptions {
  movies?: FakeTmdbMovie[]
  series?: FakeTmdbSeries[]
  // How long 'slow' waits before answering. Default 5000 ms.
  slowMs?: number
}

export interface FakeTmdbRequest {
  scope: FakeTmdbScope | 'unknown'
  // The path as it arrived, without the query string.
  path: string
  // The decoded query string, without api_key.
  query: Record<string, string>
}

export interface FakeTmdb {
  url: string
  requests: FakeTmdbRequest[]
  count: (scope: FakeTmdbScope) => number
  // A page narrows the mode to that page of a search scope.
  setMode: (scope: FakeTmdbScope, mode: FakeTmdbMode, page?: number) => void
  // Answer a search scope with this body verbatim. null goes back to the fixtures.
  setRaw: (scope: 'movie' | 'tv', body: string | null) => void
  // Ids whose external_ids lookup answers HTTP 500.
  failLookups: Set<number>
  // Ids whose external_ids lookup waits, unanswered, until release() lets it go.
  holdLookups: Set<number>
  // How many held lookups are waiting.
  held: () => number
  // Answers the oldest n held lookups, or all of them.
  release: (n?: number) => void
  // The most requests that were ever open at once.
  maxInFlight: () => number
  close: () => Promise<void>
}

const PAGE_SIZE = 20
const INVALID_KEY = '{"success":false,"status_code":7,"status_message":"Invalid API key: You must be granted a valid key."}'
const NOT_FOUND = '{"success":false,"status_code":34,"status_message":"The resource you requested could not be found."}'

// TMDB matches without case or accents, on the translated and the original title.
const fold = (value: string) => value.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')

export async function startFakeTmdb(options: FakeTmdbOptions = {}): Promise<FakeTmdb> {
  const movies = options.movies ?? []
  const series = options.series ?? []
  const modes = new Map<string, FakeTmdbMode>()
  const raw = new Map<string, string>()
  const failLookups = new Set<number>()
  const holdLookups = new Set<number>()
  const heldAnswers: Array<() => void> = []
  const requests: FakeTmdbRequest[] = []
  let inFlight = 0
  let maxInFlight = 0
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const later = (ms: number, fn: () => void) => {
    const timer = setTimeout(() => {
      timers.delete(timer)
      fn()
    }, ms)
    timers.add(timer)
  }

  const movieResult = (m: FakeTmdbMovie) => ({
    id: m.id, title: m.title, original_title: m.original_title ?? m.title, original_language: 'en',
    release_date: m.release_date ?? '2000-01-01', overview: m.overview ?? '',
    poster_path: m.poster_path === undefined ? `/m${m.id}.jpg` : m.poster_path, backdrop_path: null,
    popularity: m.popularity ?? 1, vote_average: 7,
  })
  const seriesResult = (s: FakeTmdbSeries) => ({
    id: s.id, name: s.name, original_name: s.original_name ?? s.name, original_language: 'en',
    first_air_date: s.first_air_date ?? '2000-01-01', overview: s.overview ?? '',
    poster_path: s.poster_path === undefined ? `/s${s.id}.jpg` : s.poster_path, backdrop_path: null,
    popularity: s.popularity ?? 1, vote_average: 7,
  })
  const movieDetails = (m: FakeTmdbMovie) => ({
    ...movieResult(m),
    runtime: 100,
    genres: [],
    external_ids: { imdb_id: m.imdb },
    release_dates: {
      results: m.certification === undefined ? [] : [{
        iso_3166_1: 'US',
        release_dates: [{ type: 3, release_date: `${m.release_date ?? '2000-01-01'}T00:00:00.000Z`, certification: m.certification }],
      }],
    },
    // A cast, because fetchMovieByTmdbId only trusts a stored record that has one.
    credits: { cast: [{ id: 1, name: 'Somebody', character: 'Someone', profile_path: null }], crew: [] },
  })
  const seriesDetails = (s: FakeTmdbSeries) => ({
    ...seriesResult(s),
    number_of_seasons: 1,
    genres: [],
    external_ids: { imdb_id: s.imdb },
    content_ratings: {
      results: s.certification === undefined ? [] : [{ iso_3166_1: 'US', rating: s.certification }],
    },
    // A cast, because fetchShowByTmdbId only trusts a stored record that has one.
    credits: { cast: [{ id: 1, name: 'Somebody', character: 'Someone', profile_path: null }], crew: [] },
  })

  function scopeOf(path: string): FakeTmdbScope | 'unknown' {
    if (path === '/search/movie') return 'movie'
    if (path === '/search/tv') return 'tv'
    if (/^\/movie\/\d+\/external_ids$/.test(path)) return 'movie-ids'
    if (/^\/tv\/\d+\/external_ids$/.test(path)) return 'tv-ids'
    if (/^\/movie\/\d+$/.test(path)) return 'movie-details'
    if (/^\/tv\/\d+$/.test(path)) return 'tv-details'
    if (/^\/find\/[^/]+$/.test(path)) return 'find'
    return 'unknown'
  }

  function searchBody(scope: 'movie' | 'tv', query: string, page: number, empty: boolean): string {
    const override = raw.get(scope)
    if (override !== undefined) return override
    const term = fold(query)
    const matches = empty ? [] : scope === 'movie'
      ? movies.filter(m => [m.title, m.original_title ?? ''].some(title => fold(title).includes(term))).map(movieResult)
      : series.filter(s => [s.name, s.original_name ?? ''].some(name => fold(name).includes(term))).map(seriesResult)
    return JSON.stringify({
      page,
      results: matches.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
      total_pages: Math.max(1, Math.ceil(matches.length / PAGE_SIZE)),
      total_results: matches.length,
    })
  }

  function answer(scope: FakeTmdbScope, path: string, query: Record<string, string>, mode: FakeTmdbMode): [number, string] {
    if (mode === 'unauthorized') return [401, INVALID_KEY]
    if (mode === 'error') return [500, '{"success":false,"status_code":11,"status_message":"Internal error."}']
    if (scope === 'movie' || scope === 'tv') {
      return [200, searchBody(scope, query.query ?? '', Number(query.page ?? '1'), mode === 'empty')]
    }
    if (scope === 'find') return [200, JSON.stringify({ movie_results: [], tv_results: [] })]
    const id = Number(path.split('/')[2])
    if (scope === 'movie-details') {
      const movie = movies.find(m => m.id === id)
      return movie ? [200, JSON.stringify(movieDetails(movie))] : [404, NOT_FOUND]
    }
    if (scope === 'tv-details') {
      const show = series.find(s => s.id === id)
      return show ? [200, JSON.stringify(seriesDetails(show))] : [404, NOT_FOUND]
    }
    if (failLookups.has(id)) return [500, '{"success":false,"status_code":11}']
    const item = scope === 'movie-ids' ? movies.find(m => m.id === id) : series.find(s => s.id === id)
    if (!item) return [404, NOT_FOUND]
    return [200, JSON.stringify({ id, imdb_id: mode === 'empty' ? null : item.imdb })]
  }

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://fake-tmdb')
    const scope = scopeOf(url.pathname)
    const key = url.searchParams.get('api_key')
    url.searchParams.delete('api_key')
    const query = Object.fromEntries(url.searchParams)
    requests.push({ scope, path: url.pathname, query })
    inFlight++
    maxInFlight = Math.max(maxInFlight, inFlight)
    // Fires once the answer is sent, or when the client gives up first.
    res.on('close', () => { inFlight-- })
    const send = ([status, body]: [number, string]) => {
      // The client may have given up and closed the socket already.
      if (res.destroyed || res.writableEnded) return
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(body)
    }
    if (scope === 'unknown') return send([404, NOT_FOUND])
    if (key !== FAKE_TMDB_KEY) return send([401, INVALID_KEY])
    const mode = modes.get(`${scope}:${query.page ?? ''}`) ?? modes.get(scope) ?? 'answers'
    const held = (scope === 'movie-ids' || scope === 'tv-ids') && holdLookups.has(Number(url.pathname.split('/')[2]))
    if (held) heldAnswers.push(() => send(answer(scope, url.pathname, query, mode)))
    else if (mode === 'slow') later(options.slowMs ?? 5000, () => send(answer(scope, url.pathname, query, 'answers')))
    else send(answer(scope, url.pathname, query, mode))
  })

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    count: scope => requests.filter(request => request.scope === scope).length,
    setMode: (scope, mode, page) => { modes.set(page === undefined ? scope : `${scope}:${page}`, mode) },
    setRaw: (scope, body) => { if (body === null) raw.delete(scope); else raw.set(scope, body) },
    failLookups,
    holdLookups,
    held: () => heldAnswers.length,
    release: n => { for (const answerHeld of heldAnswers.splice(0, n ?? heldAnswers.length)) answerHeld() },
    maxInFlight: () => maxInFlight,
    close: () => new Promise<void>(resolve => {
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
      server.closeAllConnections()
      server.close(() => resolve())
    }),
  }
}
