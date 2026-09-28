import test from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { startFakeTmdb, FAKE_TMDB_KEY, type FakeTmdbMovie, type FakeTmdbOptions } from './fake-tmdb.js'

// fetchMovieByTmdbId stores what it fetches, so the last test needs a database.
process.env.DATABASE_PATH = join(tmpdir(), `fetcherr-tmdb-search-${randomUUID()}.db`)
process.env.TMDB_API_KEY = ''
process.env.TVDB_API_KEY = ''
const { config } = await import('../src/config.js')
const { findTmdbTitles, clearTmdbSearchCache, tmdbMovieToMovie, tmdbSeriesToMeta } = await import('../src/tmdb-search.js')
const { fetchMovieByTmdbId } = await import('../src/tmdb.js')

const NO_SKIP = { movieTmdbIds: new Set<number>(), movieImdbIds: new Set<string>(), seriesTmdbIds: new Set<number>(), seriesImdbIds: new Set<string>() }

async function fakeTmdb(t: { after: (fn: () => unknown) => void }, options: FakeTmdbOptions = {}, overrides: Record<string, unknown> = {}) {
  const fake = await startFakeTmdb(options)
  t.after(() => fake.close())
  Object.assign(config, { tmdbApiKey: FAKE_TMDB_KEY, tmdbBaseUrl: fake.url, tmdbSearchTimeoutMs: 2000, ...overrides })
  clearTmdbSearchCache()
  return fake
}

const numbered = (count: number, firstId: number, title: (n: number) => string): FakeTmdbMovie[] =>
  Array.from({ length: count }, (_, i) => ({ id: firstId + i, title: title(i + 1), imdb: `tt${firstId + i}` }))

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function until(condition: () => boolean, what: string) {
  const started = Date.now()
  while (!condition()) {
    if (Date.now() - started > 2000) throw new Error(`gave up waiting for ${what}`)
    await sleep(5)
  }
}

test('a movie result becomes a search-movie record with its IMDb id', () => {
  const movie = tmdbMovieToMovie({
    tmdbId: 32601, imdbId: 'tt0093549', title: 'The Moromete Family', originalTitle: 'Moromeții', originalLanguage: 'ro', releaseDate: '1987-01-05',
    year: 1987, overview: 'A village in 1937.', posterPath: '/p.jpg', backdropPath: '/b.jpg', popularity: 3.5, voteAverage: 7.9,
  })
  assert.match(movie.syncedAt, /^\d{4}-\d{2}-\d{2}T/)
  assert.deepEqual({ ...movie, syncedAt: '' }, {
    id: 0, tmdbId: 32601, imdbId: 'tt0093549', mediaLanguage: 'ro', title: 'The Moromete Family', year: 1987,
    overview: 'A village in 1937.', posterPath: '/p.jpg', backdropPath: '/b.jpg', logoPath: '', genres: '[]', runtimeMins: 0,
    popularity: 3.5, officialRating: '', communityRating: 7.9, studiosJson: '[]', tagsJson: '[]', castJson: '[]',
    releaseDate: '1987-01-05', digitalReleaseDate: '', syncedAt: '',
  })
})

test('a series result becomes a Stremio series meta keyed by its IMDb id', () => {
  assert.deepEqual(tmdbSeriesToMeta({
    tmdbId: 62476, imdbId: 'tt4063800', name: 'The Bureau', originalTitle: 'Le Bureau des Légendes', firstAirDate: '2015-04-27', year: 2015,
    overview: 'Spies.', posterPath: '/bureau.jpg', backdropPath: '', popularity: 12.3,
  }), { id: 'tt4063800', type: 'series', name: 'The Bureau', tmdbId: 62476, poster: '/bureau.jpg', description: 'Spies.', releaseInfo: '2015' })
})

test('a French title is found by its original name', async t => {
  const fake = await fakeTmdb(t, {
    series: [
      { id: 62476, name: 'The Bureau', original_name: 'Le Bureau des Légendes', imdb: 'tt4063800', first_air_date: '2015-04-27' },
      { id: 1001, name: 'Unrelated', imdb: 'tt1001' },
    ],
  })
  const hits = await findTmdbTitles('Le Bureau des légendes', ['movie', 'series'], NO_SKIP)
  assert.deepEqual(hits.movies, [])
  assert.deepEqual(hits.series?.map(s => [s.tmdbId, s.imdbId, s.name, s.year]), [[62476, 'tt4063800', 'The Bureau', 2015]])
  assert.deepEqual(fake.requests.find(r => r.scope === 'tv')?.query, {
    query: 'Le Bureau des légendes', language: 'en-US', include_adult: 'false', page: '1',
  })
  // Both answers said one page, so neither type asks for page 2.
  assert.deepEqual([fake.count('movie'), fake.count('tv')], [1, 1])
})

test('the term reaches TMDB exactly as typed', async t => {
  const fake = await fakeTmdb(t)
  const terms = ['Moromeții', 'Dix pour cent !', "C'est la vie & co", '50% + 1']
  for (const term of terms) await findTmdbTitles(term, ['movie'], NO_SKIP)
  assert.deepEqual(fake.requests.map(r => r.query.query), terms)
  // The cache is keyed by the same exact term.
  await findTmdbTitles('Moromeții', ['movie'], NO_SKIP)
  assert.equal(fake.count('movie'), 4)
})

test('a movies-only search makes no TV calls', async t => {
  const fake = await fakeTmdb(t, {
    movies: [{ id: 1201, title: 'Heat', imdb: 'tt1201' }],
    series: [{ id: 1202, name: 'Heat Wave', imdb: 'tt1202' }],
  })
  const hits = await findTmdbTitles('heat', ['movie'], NO_SKIP)
  assert.deepEqual(hits.movies?.map(m => m.imdbId), ['tt1201'])
  assert.deepEqual(hits.series, [])
  assert.deepEqual(fake.requests.map(r => r.scope), ['movie', 'movie-ids'])
})

test('page 2 is asked for only when page 1 reports more, and a search keeps 40 movies', async t => {
  const fake = await fakeTmdb(t, {
    movies: numbered(60, 1301, n => `Agent ${n}`),
    series: numbered(5, 1401, n => `Agent Show ${n}`).map(({ title, ...rest }) => ({ ...rest, name: title })),
  })
  const hits = await findTmdbTitles('agent', ['movie', 'series'], NO_SKIP)
  assert.equal(hits.movies?.length, 40)
  assert.equal(hits.series?.length, 5)
  assert.deepEqual(fake.requests.filter(r => r.scope === 'movie').map(r => r.query.page), ['1', '2'])
  assert.deepEqual(fake.requests.filter(r => r.scope === 'tv').map(r => r.query.page), ['1'])
  assert.equal(fake.count('movie-ids'), 40)
})

test('titles without an IMDb id are left out', async t => {
  await fakeTmdb(t, {
    movies: [{ id: 1501, title: 'Monk', imdb: 'tt1501' }, { id: 1502, title: 'Monk', imdb: null }],
    series: [{ id: 1601, name: 'Monk', imdb: 'tt0312172' }, { id: 1602, name: 'Monk', imdb: null }],
  })
  const hits = await findTmdbTitles('monk', ['movie', 'series'], NO_SKIP)
  assert.deepEqual(hits.movies?.map(m => m.tmdbId), [1501])
  assert.deepEqual(hits.series?.map(s => s.tmdbId), [1601])
})

test('results that share an IMDb id collapse to the first', async t => {
  await fakeTmdb(t, {
    movies: [{ id: 1701, title: 'Solaris', imdb: 'tt0069293' }, { id: 1702, title: 'Solaris', imdb: 'tt0069293' }],
    series: [{ id: 1801, name: 'Solaris', imdb: 'tt1801' }, { id: 1802, name: 'Solaris', imdb: 'tt1801' }],
  })
  const hits = await findTmdbTitles('solaris', ['movie', 'series'], NO_SKIP)
  assert.deepEqual(hits.movies?.map(m => m.tmdbId), [1701])
  assert.deepEqual(hits.series?.map(s => s.tmdbId), [1801])
})

test('series are ranked by title before the cap of 20, past titles with no IMDb id', async t => {
  // TMDB's popularity order, as measured for `monk`: loose matches first, then
  // exact matches that mostly have no IMDb id, then the ones that do.
  const loose = Array.from({ length: 25 }, (_, i) => ({ id: 1901 + i, name: `Monkey Business ${i + 1}`, imdb: `tt${1901 + i}` }))
  const exactNoId = Array.from({ length: 5 }, (_, i) => ({ id: 1926 + i, name: 'Monk', imdb: null }))
  const exact = Array.from({ length: 3 }, (_, i) => ({ id: 1931 + i, name: 'Monk', imdb: `tt${1931 + i}` }))
  const fake = await fakeTmdb(t, { series: [...loose, ...exactNoId, ...exact] })
  const hits = await findTmdbTitles('monk', ['series'], NO_SKIP)
  assert.deepEqual(hits.series?.map(s => s.tmdbId), [1931, 1932, 1933, ...loose.slice(0, 17).map(s => s.id)])
  // The five exact titles with no id, then the twenty that have one.
  assert.ok(fake.count('tv-ids') >= 25, `${fake.count('tv-ids')} lookups`)
})

test('a series whose original name is the term is ranked first, before the cap', async t => {
  // Looser matches by original name, then the exact one, in TMDB's order.
  const loose = Array.from({ length: 25 }, (_, i) => ({ id: 1991 + i, name: `Loose ${i + 1}`, original_name: `Dix pour centimes ${i + 1}`, imdb: `tt${1991 + i}` }))
  const exact = { id: 2016, name: 'Call My Agent!', original_name: 'Dix pour cent', imdb: 'tt4209256' }
  await fakeTmdb(t, { series: [...loose, exact] })
  const hits = await findTmdbTitles('Dix pour cent', ['series'], NO_SKIP)
  assert.deepEqual(hits.series?.slice(0, 2).map(s => [s.tmdbId, s.originalTitle]), [[2016, 'Dix pour cent'], [1991, 'Dix pour centimes 1']])
})

test('series lookups stop once twenty series have an IMDb id', async t => {
  const shows = Array.from({ length: 40 }, (_, i) => ({ id: 1951 + i, name: `Agent Show ${i + 1}`, imdb: `tt${1951 + i}` }))
  const fake = await fakeTmdb(t, { series: shows })
  const hits = await findTmdbTitles('agent', ['series'], NO_SKIP)
  assert.deepEqual(hits.series?.map(s => s.tmdbId), shows.slice(0, 20).map(s => s.id))
  // Up to nine more were already on their way when the twentieth answered.
  assert.ok(fake.count('tv-ids') <= 29, `${fake.count('tv-ids')} lookups`)
})

test('library titles are skipped before any lookup', async t => {
  const fake = await fakeTmdb(t, {
    movies: [
      { id: 2001, title: 'Heat', imdb: 'tt2001' },
      { id: 2002, title: 'Heat', imdb: 'tt2002' },
      { id: 2003, title: 'Heat 2', imdb: 'tt2003' },
    ],
    series: [{ id: 2101, name: 'Heat', imdb: 'tt2101' }, { id: 2102, name: 'Heat Squad', imdb: 'tt2102' }],
  })
  const skip = { ...NO_SKIP, movieTmdbIds: new Set([2001]), movieImdbIds: new Set(['tt2003']), seriesTmdbIds: new Set([2101]) }
  const hits = await findTmdbTitles('heat', ['movie', 'series'], skip)
  assert.deepEqual(hits.movies?.map(m => m.tmdbId), [2002])
  assert.deepEqual(hits.series?.map(s => s.tmdbId), [2102])
  // A library title known by its IMDb id only needs its lookup to be recognised.
  assert.deepEqual(fake.requests.filter(r => r.scope.endsWith('-ids')).map(r => r.path).sort(), [
    '/movie/2002/external_ids', '/movie/2003/external_ids', '/tv/2102/external_ids',
  ])
})

test('answers are kept ten minutes, and IMDb ids for the life of the process', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  const fake = await fakeTmdb(t, { movies: [{ id: 2201, title: 'Ronin', imdb: 'tt2201' }] })
  await findTmdbTitles('ronin', ['movie'], NO_SKIP)
  await findTmdbTitles('ronin', ['movie'], NO_SKIP)
  assert.deepEqual([fake.count('movie'), fake.count('movie-ids')], [1, 1])
  t.mock.timers.tick(10 * 60 * 1000 - 1)
  await findTmdbTitles('ronin', ['movie'], NO_SKIP)
  assert.equal(fake.count('movie'), 1)
  t.mock.timers.tick(1)
  const hits = await findTmdbTitles('ronin', ['movie'], NO_SKIP)
  assert.deepEqual([fake.count('movie'), fake.count('movie-ids')], [2, 1])
  assert.deepEqual(hits.movies?.map(m => m.imdbId), ['tt2201'])
  // A settings save drops answers but keeps IMDb ids, which never change.
  clearTmdbSearchCache()
  t.mock.timers.tick(24 * 60 * 60 * 1000)
  await findTmdbTitles('ronin', ['movie'], NO_SKIP)
  assert.deepEqual([fake.count('movie'), fake.count('movie-ids')], [3, 1])
})

test('a missing IMDb id is asked for again after a day, since TMDB often fills it in', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  const late: FakeTmdbMovie = { id: 2251, title: 'Brand New', imdb: null }
  const fake = await fakeTmdb(t, { movies: [late] })
  assert.deepEqual((await findTmdbTitles('brand new', ['movie'], NO_SKIP)).movies, [])
  late.imdb = 'tt2251'
  t.mock.timers.tick(24 * 60 * 60 * 1000 - 1)
  assert.deepEqual((await findTmdbTitles('brand new', ['movie'], NO_SKIP)).movies, [])
  assert.equal(fake.count('movie-ids'), 1)
  t.mock.timers.tick(1)
  assert.deepEqual((await findTmdbTitles('brand new', ['movie'], NO_SKIP)).movies?.map(m => m.imdbId), ['tt2251'])
  assert.equal(fake.count('movie-ids'), 2)
})

test('the answer cache keeps at most 500 entries, oldest dropped first', async t => {
  const fake = await fakeTmdb(t)
  for (let i = 0; i < 501; i++) await findTmdbTitles(`term ${i}`, ['movie'], NO_SKIP)
  assert.equal(fake.count('movie'), 501)
  await findTmdbTitles('term 500', ['movie'], NO_SKIP)
  await findTmdbTitles('term 1', ['movie'], NO_SKIP)
  assert.equal(fake.count('movie'), 501)
  await findTmdbTitles('term 0', ['movie'], NO_SKIP)
  assert.equal(fake.count('movie'), 502)
})

test('identical searches in flight share their requests', async t => {
  const fake = await fakeTmdb(t, {
    movies: [{ id: 2301, title: 'Heat', imdb: 'tt2301' }],
    series: [{ id: 2401, name: 'Heat', imdb: 'tt2401' }],
  })
  const answers = await Promise.all([1, 2, 3].map(() => findTmdbTitles('heat', ['movie', 'series'], NO_SKIP)))
  assert.deepEqual(answers.map(a => [a.movies?.length, a.series?.length]), [[1, 1], [1, 1], [1, 1]])
  assert.deepEqual([fake.count('movie'), fake.count('tv'), fake.count('movie-ids'), fake.count('tv-ids')], [1, 1, 1, 1])
})

test('a type TMDB could not answer comes back as failed', async t => {
  t.mock.method(console, 'warn', () => {})
  const fake = await fakeTmdb(t, {
    movies: [{ id: 2501, title: 'Heat', imdb: 'tt2501' }],
    series: [{ id: 2601, name: 'Heat', imdb: 'tt2601' }],
  }, { tmdbSearchTimeoutMs: 300 })
  const search = () => findTmdbTitles('heat', ['movie', 'series'], NO_SKIP)

  fake.setMode('tv', 'unauthorized')
  let hits = await search()
  assert.deepEqual(hits.movies?.map(m => m.tmdbId), [2501])
  assert.equal(hits.series, null)

  clearTmdbSearchCache()
  fake.setMode('tv', 'answers')
  fake.setMode('movie', 'error')
  hits = await search()
  assert.equal(hits.movies, null)
  assert.deepEqual(hits.series?.map(s => s.tmdbId), [2601])

  clearTmdbSearchCache()
  fake.setMode('movie', 'slow')
  const started = Date.now()
  hits = await search()
  assert.equal(hits.movies, null)
  assert.ok(Date.now() - started < 2000, `waited ${Date.now() - started} ms`)

  // A 200 that is not a TMDB answer counts as a failure too.
  fake.setMode('movie', 'answers')
  for (const body of ['{"results":"none"}', 'not json at all']) {
    clearTmdbSearchCache()
    fake.setRaw('movie', body)
    assert.equal((await search()).movies, null, body)
  }
})

test('a failed page 2 keeps page 1', async t => {
  t.mock.method(console, 'warn', () => {})
  const fake = await fakeTmdb(t, { movies: numbered(25, 2701, n => `Agent ${n}`) })
  fake.setMode('movie', 'error', 2)
  const hits = await findTmdbTitles('agent', ['movie'], NO_SKIP)
  assert.equal(hits.movies?.length, 20)
  assert.deepEqual(fake.requests.filter(r => r.scope === 'movie').map(r => r.query.page), ['1', '2'])
})

test('a failed IMDb lookup drops only that title, and is asked again next time', async t => {
  t.mock.method(console, 'warn', () => {})
  const fake = await fakeTmdb(t, {
    movies: [{ id: 2801, title: 'Heat', imdb: 'tt2801' }, { id: 2802, title: 'Heat Wave', imdb: 'tt2802' }],
  })
  fake.failLookups.add(2802)
  assert.deepEqual((await findTmdbTitles('heat', ['movie'], NO_SKIP)).movies?.map(m => m.tmdbId), [2801])
  fake.failLookups.clear()
  assert.deepEqual((await findTmdbTitles('heat', ['movie'], NO_SKIP)).movies?.map(m => m.tmdbId), [2801, 2802])
  assert.deepEqual(fake.requests.filter(r => r.scope === 'movie-ids').map(r => r.path).sort(), [
    '/movie/2801/external_ids', '/movie/2802/external_ids', '/movie/2802/external_ids',
  ])
})

test('searches in flight together share one budget of ten TMDB requests', async t => {
  // Every keystroke is a new search, and TMDB refuses more than about 20
  // connections from one address.
  const fake = await fakeTmdb(t, {
    movies: [...numbered(40, 3201, n => `Agent ${n}`), ...numbered(40, 3301, n => `Spy ${n}`)],
    slowMs: 40,
  })
  fake.setMode('movie', 'slow')
  fake.setMode('movie-ids', 'slow')
  const [agent, spy] = await Promise.all([
    findTmdbTitles('agent', ['movie'], NO_SKIP),
    findTmdbTitles('spy', ['movie'], NO_SKIP),
  ])
  assert.deepEqual([agent.movies?.length, spy.movies?.length], [40, 40])
  assert.equal(fake.maxInFlight(), 10)
})

test('when TMDB is busy, the newest search goes first', async t => {
  // Typing a title starts a search per keystroke, and only the last is on screen.
  const older = [...numbered(40, 3401, n => `Agent ${n}`), ...numbered(40, 3501, n => `Spy ${n}`), ...numbered(40, 3601, n => `Cop ${n}`)]
  const fake = await fakeTmdb(t, { movies: [...older, ...numbered(5, 3701, n => `Monk ${n}`)] })
  for (const movie of older) fake.holdLookups.add(movie.id)
  const olderSearches = ['agent', 'spy', 'cop'].map(term => findTmdbTitles(term, ['movie'], NO_SKIP))
  // All ten places are taken, and twenty more older lookups wait for one.
  await until(() => fake.held() === 10, 'ten held lookups')
  let answered = false
  const newest = findTmdbTitles('monk', ['movie'], NO_SKIP).finally(() => { answered = true })
  let released = 0
  while (!answered && released < 40) {
    fake.release(1)
    released++
    await sleep(25)
  }
  assert.deepEqual((await newest).movies?.map(m => m.tmdbId), [3701, 3702, 3703, 3704, 3705])
  // One place for its search page and one for its lookups, give or take a
  // slow machine. In arrival order it would wait behind twenty.
  assert.ok(released <= 5, `the newest search waited for ${released} older lookups`)
  fake.holdLookups.clear()
  fake.release()
  await Promise.all(olderSearches)
})

test('slow lookups give up together inside one window', async t => {
  t.mock.method(console, 'warn', () => {})
  const fake = await fakeTmdb(t, { movies: numbered(25, 2901, n => `Slow ${n}`) }, { tmdbSearchTimeoutMs: 300 })
  fake.setMode('movie-ids', 'slow')
  const started = Date.now()
  const hits = await findTmdbTitles('slow', ['movie'], NO_SKIP)
  assert.ok(Date.now() - started < 2000, `waited ${Date.now() - started} ms`)
  assert.deepEqual(hits.movies, [])
  // Ten in flight when the window closed, and nothing started after it.
  assert.equal(fake.count('movie-ids'), 10)
})

test('titles whose IMDb id is known still come back when the window closes early', async t => {
  t.mock.method(console, 'warn', () => {})
  const fake = await fakeTmdb(t, { movies: numbered(25, 4401, n => `Slow ${n}`) }, { tmdbSearchTimeoutMs: 300 })
  // Finds Slow 2 and Slow 20 to 25, and learns their ids.
  await findTmdbTitles('slow 2', ['movie'], NO_SKIP)
  fake.setMode('movie-ids', 'slow')
  const hits = await findTmdbTitles('slow', ['movie'], NO_SKIP)
  // The window closed on ten slow lookups, with Slow 20 to 25 queued behind them.
  assert.deepEqual(hits.movies?.map(m => m.tmdbId), [4402, 4420, 4421, 4422, 4423, 4424, 4425])
})

test('after a failed search TMDB rests for a minute, and Cinemeta answers', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  t.mock.method(console, 'warn', () => {})
  const fake = await fakeTmdb(t, { movies: [{ id: 3901, title: 'Heat', imdb: 'tt3901' }] }, { tmdbSearchTimeoutMs: 300 })
  fake.setMode('movie', 'slow')
  assert.equal((await findTmdbTitles('heat', ['movie'], NO_SKIP)).movies, null)
  fake.setMode('movie', 'answers')
  // Without the rest, every keystroke would wait out the timeout again.
  const started = Date.now()
  assert.deepEqual(await findTmdbTitles('heat w', ['movie', 'series'], NO_SKIP), { movies: null, series: null })
  assert.deepEqual(await findTmdbTitles('heat w', ['movie'], NO_SKIP), { movies: null, series: [] })
  t.mock.timers.tick(60_000 - 1)
  assert.equal((await findTmdbTitles('heat', ['movie'], NO_SKIP)).movies, null)
  assert.deepEqual([fake.count('movie'), fake.count('tv')], [1, 0])
  t.mock.timers.tick(1)
  assert.deepEqual((await findTmdbTitles('heat', ['movie'], NO_SKIP)).movies?.map(m => m.tmdbId), [3901])
  assert.equal(fake.count('movie'), 2)
  assert.ok(Date.now() - started >= 60_000)
})

test('a search that gave up waiting for its turn does not rest TMDB', async t => {
  t.mock.method(console, 'warn', () => {})
  const busy = numbered(10, 4001, n => `Agent ${n}`)
  const fake = await fakeTmdb(t, { movies: [...busy, { id: 4101, title: 'Heat', imdb: 'tt4101' }] })
  for (const movie of busy) fake.holdLookups.add(movie.id)
  const agent = findTmdbTitles('agent', ['movie'], NO_SKIP)
  await until(() => fake.held() === 10, 'ten held lookups')
  config.tmdbSearchTimeoutMs = 300
  assert.equal((await findTmdbTitles('heat', ['movie'], NO_SKIP)).movies, null)
  fake.release()
  await agent
  // TMDB itself never failed, so the next keystroke asks it.
  assert.deepEqual((await findTmdbTitles('heat', ['movie'], NO_SKIP)).movies?.map(m => m.tmdbId), [4101])
})

test('a busy queue is bounded to about one deadline for the request that waits, not the old worst case', async t => {
  t.mock.method(console, 'warn', () => {})
  const busy = numbered(10, 5001, n => `Filler ${n}`)
  const fake = await fakeTmdb(t, { movies: [...busy, { id: 6001, title: 'Agent', imdb: 'tt6001' }], slowMs: 220 })
  fake.setMode('movie', 'slow')
  for (const movie of busy) fake.holdLookups.add(movie.id)
  const filler = findTmdbTitles('filler', ['movie'], NO_SKIP)
  await until(() => fake.held() === 10, 'ten held lookups')
  config.tmdbSearchTimeoutMs = 300
  const started = Date.now()
  const search = findTmdbTitles('agent', ['movie'], NO_SKIP)
  await sleep(180)
  fake.release(1)
  const hits = await search
  // A full search can pass through up to three stages this way - page 1, page
  // 2, the IMDb window - each now bounded to one deadline. The bug this fixes
  // let a page that waited also keep a fresh timeout for TMDB's answer on top,
  // so a busy queue could cost close to five deadlines rather than about three.
  assert.ok(Date.now() - started < 300 * 3, `took ${Date.now() - started} ms`)
  assert.equal(hits.movies, null)
  fake.release()
  await filler
})

test('a page that waited in line and then ran out of time does not rest TMDB', async t => {
  t.mock.method(console, 'warn', () => {})
  const busy = numbered(10, 4201, n => `Agent ${n}`)
  const fake = await fakeTmdb(t, { movies: [...busy, { id: 4301, title: 'Heat', imdb: 'tt4301' }], slowMs: 220 })
  fake.setMode('movie', 'slow')
  for (const movie of busy) fake.holdLookups.add(movie.id)
  const agent = findTmdbTitles('agent', ['movie'], NO_SKIP)
  await until(() => fake.held() === 10, 'ten held lookups')
  config.tmdbSearchTimeoutMs = 300
  const heat = findTmdbTitles('heat', ['movie'], NO_SKIP)
  // 180 ms in line leaves only 120 ms of the one deadline for TMDB's answer,
  // and it is slow by 220 ms: not enough, but queueing cost the time, not TMDB.
  await sleep(180)
  fake.release(1)
  assert.equal((await heat).movies, null)
  fake.release()
  await agent
  // TMDB itself never failed, so the next keystroke asks it again at once.
  fake.setMode('movie', 'answers')
  assert.deepEqual((await findTmdbTitles('heat', ['movie'], NO_SKIP)).movies?.map(m => m.tmdbId), [4301])
})

test('TMDB resting is logged once per minute at most, without the key', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  const warn = t.mock.method(console, 'warn', () => {})
  const fake = await fakeTmdb(t, {}, { tmdbApiKey: 'wrong-key-5f3a9c' })
  const lines = () => warn.mock.calls.map(call => String(call.arguments[0])).filter(line => line.startsWith('tmdb search: '))

  // Both types fail together, and that is one line.
  await findTmdbTitles('heat', ['movie', 'series'], NO_SKIP)
  assert.equal(lines().length, 1)
  assert.match(lines()[0], /HTTP 401.*Cinemeta/)
  t.mock.timers.tick(30_000)
  await findTmdbTitles('heat', ['movie', 'series'], NO_SKIP)
  assert.equal(fake.count('movie'), 1)
  assert.equal(lines().length, 1)

  t.mock.timers.tick(30_000)
  await findTmdbTitles('heat', ['movie'], NO_SKIP)
  assert.equal(fake.count('movie'), 2)
  assert.equal(lines().length, 2)
  assert.ok(lines().every(line => !line.includes('wrong-key-5f3a9c')))
})

test('failed lookups are logged once per ten minutes, without the key', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  const warn = t.mock.method(console, 'warn', () => {})
  const fake = await fakeTmdb(t, { movies: [{ id: 3951, title: 'Heat', imdb: 'tt3951' }] })
  const lines = () => warn.mock.calls.map(call => String(call.arguments[0])).filter(line => line.startsWith('tmdb search: '))
  fake.failLookups.add(3951)

  await findTmdbTitles('heat', ['movie'], NO_SKIP)
  assert.equal(lines().length, 1)
  assert.match(lines()[0], /external_ids answered HTTP 500/)
  // A failed lookup is not cached, so this asks again, and still logs nothing new.
  await findTmdbTitles('heat', ['movie'], NO_SKIP)
  assert.equal(fake.count('movie-ids'), 2)
  assert.equal(lines().length, 1)

  t.mock.timers.tick(10 * 60 * 1000)
  await findTmdbTitles('heat', ['movie'], NO_SKIP)
  assert.equal(lines().length, 2)
  assert.ok(lines().every(line => !line.includes(FAKE_TMDB_KEY)))
})

test('malformed results are skipped, not fatal', async t => {
  const fake = await fakeTmdb(t, {
    movies: [{ id: 3001, title: 'Heat', imdb: 'tt3001' }, { id: 3003, title: 'Heat Again', imdb: 'tt3003' }],
  })
  fake.setRaw('movie', JSON.stringify({
    page: 1, total_pages: 1, total_results: 5,
    results: [
      { id: 3001, title: 'Heat', poster_path: null, backdrop_path: null },
      { id: 'x', title: 'Bad id' },
      { id: 3002 },
      null,
      { id: 3003, title: 'Heat Again', release_date: '', poster_path: 'https://elsewhere.example/p.jpg', overview: 7 },
    ],
  }))
  const hits = await findTmdbTitles('heat', ['movie'], NO_SKIP)
  assert.deepEqual(hits.movies?.map(m => [m.tmdbId, m.title, m.posterPath, m.releaseDate, m.year, m.overview]), [
    [3001, 'Heat', '', '', 0, ''],
    [3003, 'Heat Again', '', '', 0, ''],
  ])
})

test('a blank term asks TMDB nothing', async t => {
  const fake = await fakeTmdb(t)
  assert.deepEqual(await findTmdbTitles('   ', ['movie', 'series'], NO_SKIP), { movies: [], series: [] })
  assert.deepEqual(await findTmdbTitles('heat', [], NO_SKIP), { movies: [], series: [] })
  assert.equal(fake.requests.length, 0)
})

test('every TMDB call uses the configured base', async t => {
  const fake = await fakeTmdb(t, { movies: [{ id: 3101, title: 'Heat', imdb: 'tt3101', certification: 'R', release_date: '1995-12-15' }] })
  const movie = await fetchMovieByTmdbId(3101)
  assert.deepEqual([movie?.imdbId, movie?.officialRating], ['tt3101', 'R'])
  assert.deepEqual(fake.requests.map(r => r.path), ['/movie/3101'])
})
