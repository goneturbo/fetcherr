import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { startFakeTmdb, FAKE_TMDB_KEY } from './fake-tmdb.js'
import { installFakeCinemeta } from './fake-cinemeta.js'

const databasePath = join(tmpdir(), `fetcherr-jellyfin-tmdb-search-${randomUUID()}.db`)
process.env.DATABASE_PATH = databasePath
// A fixed secret keeps the signed play URLs deterministic.
process.env.PLAYBACK_SIGNING_SECRET = 'jellyfin-tmdb-search-test-secret'
process.env.TMDB_API_KEY = ''
process.env.TVDB_API_KEY = ''

const db = await import('../src/db.js')
const { config } = await import('../src/config.js')
const { jellyfinRoutes, resolveJellyfinUser } = await import('../src/jellyfin/index.js')
const { clearTmdbSearchCache } = await import('../src/tmdb-search.js')

// TMDB as it answered on 2026-09-27 for the spec's searches, cut down. The
// IMDb ids of the made-up entries are made up too.
const tmdb = await startFakeTmdb({
  movies: [
    { id: 1365884, title: 'Call My Agent! The Movie', original_title: 'Dix Pour Cent ! Le Film', imdb: 'tt30000001', release_date: '2025-01-01' },
    { id: 32601, title: 'The Moromete Family', original_title: 'Moromeții', imdb: 'tt0093549', release_date: '1987-01-05' },
    { id: 527465, title: 'Moromete Family: On the Edge of Time', original_title: 'Moromeţii 2', imdb: 'tt7000002', release_date: '2018-03-02' },
    { id: 449217, title: 'Monk', imdb: 'tt7000003', release_date: '2017-01-01', popularity: 2 },
    { id: 1468718, title: 'Monk', imdb: null, release_date: '2021-01-01' },
    { id: 124391, title: 'The Monk', imdb: 'tt0068972', release_date: '1972-01-01' },
    { id: 5201, title: 'Monk in Pieces', imdb: 'tt5201', release_date: '2025-01-01' },
    { id: 949, title: 'Heat', imdb: 'tt0113277', release_date: '1995-12-15' },
    { id: 5001, title: 'Heat Wave', imdb: 'tt5001', release_date: '2020-01-01' },
    { id: 194, title: 'Amélie', original_title: "Le Fabuleux Destin d'Amélie Poulain", imdb: 'tt0211915', release_date: '2001-04-25' },
    { id: 5501, title: 'Amélie: The Making Of', original_title: "Le Fabuleux Destin d'Amélie Poulain : le tournage", imdb: 'tt5501', release_date: '2002-01-01' },
    // TMDB has this title with no release date at all.
    { id: 5701, title: 'Yearless', imdb: 'tt5701', release_date: '' },
  ],
  series: [
    { id: 62476, name: 'The Bureau', original_name: 'Le Bureau des Légendes', imdb: 'tt4063800', first_air_date: '2015-04-27' },
    { id: 64165, name: 'Call My Agent!', original_name: 'Dix pour cent', imdb: 'tt4209256', first_air_date: '2015-10-14' },
    { id: 1695, name: 'Monk', imdb: 'tt0312172', first_air_date: '2002-07-12', popularity: 60 },
    { id: 5301, name: 'Monkey Island', imdb: 'tt5301' },
    { id: 69740, name: 'Ozark', imdb: 'tt5071412', first_air_date: '2017-07-21' },
    { id: 5401, name: 'Spiral', original_name: 'Engrenages', imdb: 'tt5401', first_air_date: '2005-12-13' },
    { id: 5601, name: 'Kaamelott', imdb: 'tt5601', first_air_date: '2005-01-03' },
  ],
})
const cinemeta = installFakeCinemeta({
  movies: [{ id: 'tt9000001', type: 'movie', name: 'Heat of the Night' }],
  series: [{ id: 'tt9000002', type: 'series', name: 'Heat Street' }],
  metas: {
    tt4063800: {
      id: 'tt4063800', type: 'series', name: 'The Bureau',
      videos: [
        { id: 'tt4063800:1:1', season: 1, episode: 1, name: 'Episode 1', released: '2015-04-27T00:00:00.000Z' },
        { id: 'tt4063800:1:2', season: 1, episode: 2, name: 'Episode 2', released: '2015-05-04T00:00:00.000Z' },
        { id: 'tt4063800:2:1', season: 2, episode: 1, name: 'Episode 1', released: '2016-05-02T00:00:00.000Z' },
      ],
    },
    tt5601: {
      id: 'tt5601', type: 'series', name: 'Kaamelott',
      videos: [{ id: 'tt5601:1:1', season: 1, episode: 1, name: 'Episode 1', released: '2005-01-03T00:00:00.000Z' }],
    },
  },
})
test.after(async () => {
  cinemeta.restore()
  await tmdb.close()
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${databasePath}${suffix}`, { force: true })
})

// The first account created takes the default admin id, so it goes first.
const admin = db.createUser('admin', 'pw', 'admin', 'unrestricted')
const noSearch = db.createUser('nosearch', 'pw', 'user', 'unrestricted', false)

// In the library: Heat and Amélie, and Ozark and Spiral with an aired episode.
db.upsertMovie({
  tmdbId: 949, imdbId: 'tt0113277', mediaLanguage: 'en', title: 'Heat', year: 1995, overview: '', posterPath: '', backdropPath: '',
  logoPath: '', genres: '[]', runtimeMins: 170, popularity: 0, officialRating: 'R', communityRating: 0, studiosJson: '[]',
  tagsJson: '[]', castJson: '[]', releaseDate: '1995-12-15', digitalReleaseDate: '1996-06-01', syncedAt: new Date().toISOString(),
})
db.addSourceItem('manual:test', 'movie', 949)
db.upsertMovie({
  tmdbId: 194, imdbId: 'tt0211915', mediaLanguage: 'fr', title: 'Amélie', year: 2001, overview: '', posterPath: '', backdropPath: '',
  logoPath: '', genres: '[]', runtimeMins: 122, popularity: 0, officialRating: 'R', communityRating: 0, studiosJson: '[]',
  tagsJson: '[]', castJson: '[]', releaseDate: '2001-04-25', digitalReleaseDate: '2002-07-16', syncedAt: new Date().toISOString(),
})
db.addSourceItem('manual:test', 'movie', 194)
db.upsertShow({
  tmdbId: 69740, imdbId: 'tt5071412', tvdbId: 0, mediaLanguage: 'en', title: 'Ozark', year: 2017, overview: '', posterPath: '',
  backdropPath: '', logoPath: '', genres: '[]', status: 'Ended', numSeasons: 4, popularity: 0, officialRating: 'TV-MA',
  communityRating: 0, studiosJson: '[]', tagsJson: '[]', castJson: '[]', syncedAt: new Date().toISOString(),
})
db.addSourceItem('manual:test', 'show', 69740)
db.upsertEpisode({
  showTmdbId: 69740, seasonNumber: 1, episodeNumber: 1, name: 'Sugarwood', overview: '', stillPath: '', runtimeMins: 60,
  communityRating: 0, airDate: '2017-07-21', syncedAt: new Date().toISOString(),
})
db.upsertShow({
  tmdbId: 5401, imdbId: 'tt5401', tvdbId: 0, mediaLanguage: 'fr', title: 'Spiral', year: 2005, overview: '', posterPath: '',
  backdropPath: '', logoPath: '', genres: '[]', status: 'Ended', numSeasons: 8, popularity: 0, officialRating: 'TV-MA',
  communityRating: 0, studiosJson: '[]', tagsJson: '[]', castJson: '[]', syncedAt: new Date().toISOString(),
})
db.addSourceItem('manual:test', 'show', 5401)
db.upsertEpisode({
  showTmdbId: 5401, seasonNumber: 1, episodeNumber: 1, name: 'Episode 1', overview: '', stillPath: '', runtimeMins: 52,
  communityRating: 0, airDate: '2005-12-13', syncedAt: new Date().toISOString(),
})

// resolveJellyfinUser creates the jellyfin_tokens table on its first read.
resolveJellyfinUser({ 'x-emby-token': 'no-such-token' })
function issueToken(userId: string): string {
  const token = randomUUID()
  db.getDb().prepare(`INSERT INTO jellyfin_tokens (token, user_id, expires_at) VALUES (?, ?, ?)`).run(token, userId, Date.now() + 3_600_000)
  return token
}
const tokens = { admin: issueToken(admin.id), noSearch: issueToken(noSearch.id) }

// The router options src/index.ts builds, so the tests measure what is deployed.
const PRODUCTION_ROUTER_OPTIONS = {
  routerOptions: { ignoreTrailingSlash: true },
  rewriteUrl: (req: { url?: string }) => req.url!.replace(/\/\/+/g, '/').replace(/\.view(\?|$)/, '$1'),
}

type Item = Record<string, unknown>

async function request(url: string, token = tokens.admin, options: Record<string, unknown> = {}) {
  const app = Fastify(PRODUCTION_ROUTER_OPTIONS as never)
  await app.register(jellyfinRoutes, options as never)
  const res = await app.inject({ method: 'GET', url, headers: { 'x-emby-token': token } })
  await app.close()
  assert.equal(res.statusCode, 200, res.body)
  return res.json() as Item
}

async function search(term: string, types = 'Movie,Series', token = tokens.admin): Promise<Item[]> {
  const body = await request(`/Users/${admin.id}/Items?SearchTerm=${encodeURIComponent(term)}&IncludeItemTypes=${types}&Recursive=true&Limit=50`, token)
  return body.Items as Item[]
}

function configure(overrides: Record<string, unknown> = {}) {
  Object.assign(config, {
    stremioSearchEnabled: true, stremioSearchSource: 'tmdb', tmdbApiKey: FAKE_TMDB_KEY, tmdbBaseUrl: tmdb.url,
    tmdbSearchTimeoutMs: 2000, ...overrides,
  })
  tmdb.setMode('movie', 'answers')
  tmdb.setMode('tv', 'answers')
  clearTmdbSearchCache()
  tmdb.requests.length = 0
  cinemeta.requests.length = 0
  cinemeta.setFailing([])
}

const names = (items: Item[]) => items.map(item => item.Name)
const catalogSearches = () => cinemeta.requests.filter(path => path.startsWith('/catalog/')).sort()

test('Le Bureau des légendes finds The Bureau as a series that opens', async () => {
  configure()
  const items = await search('Le Bureau des légendes')
  assert.deepEqual(items.map(item => [item.Name, item.Type]), [['The Bureau', 'Series']])
  assert.match(String(items[0].Id), /^[0-9a-f]{32}$/)
  assert.deepEqual(tmdb.requests.map(r => r.scope).sort(), ['movie', 'tv', 'tv-ids'])
  // Cinemeta gives the episodes, and is not searched.
  assert.deepEqual(cinemeta.requests, ['/meta/series/tt4063800.json'])
})

test('Dix pour cent and Moromeții find their titles by the original names', async () => {
  configure()
  const agent = await search('Dix pour cent')
  // The series is Dix pour cent itself; the movie only starts with it.
  assert.deepEqual(agent.map(item => [item.Name, item.OriginalTitle, item.Type]), [
    ['Call My Agent!', 'Dix pour cent', 'Series'], ['Call My Agent! The Movie', 'Dix Pour Cent ! Le Film', 'Movie'],
  ])
  assert.match(String(agent[1].Id), /^00000000-0000-4000-8004-/)
  assert.equal(agent[1].IsPlayable, true)
  assert.equal((agent[1].ProviderIds as Item).Imdb, 'tt30000001')
  assert.deepEqual(names(await search('Moromeții')), ['The Moromete Family', 'Moromete Family: On the Edge of Time'])
  assert.deepEqual(catalogSearches(), [])
})

test('monk puts exact matches first and leaves out what cannot play', async () => {
  configure()
  const items = await search('monk')
  assert.deepEqual(items.map(item => [item.Name, item.Type]), [
    // The series is far more popular on TMDB than the 2017 movie of the same
    // name, and both are exact title matches, so TMDB's popularity, not the
    // movies-then-series order the two lists arrived in, decides which comes first.
    ['Monk', 'Series'], ['Monk', 'Movie'], ['The Monk', 'Movie'], ['Monk in Pieces', 'Movie'], ['Monkey Island', 'Series'],
  ])
  assert.ok(!items.some(item => (item.ProviderIds as Item | undefined)?.Tmdb === '1468718'), 'a title with no IMDb id was listed')
  assert.deepEqual(catalogSearches(), [])
})

test('a movies-only request makes no TV calls', async () => {
  configure()
  assert.deepEqual(names(await search('heat', 'Movie')), ['Heat', 'Heat Wave'])
  assert.deepEqual(tmdb.requests.map(r => r.scope), ['movie', 'movie-ids'])
})

test('a TMDB movie with no release date has no year, not year zero', async () => {
  configure()
  const items = await search('Yearless', 'Movie')
  assert.deepEqual(names(items), ['Yearless'])
  assert.equal(items[0].ProductionYear, undefined)
  assert.ok(!('ProductionYear' in items[0]), 'ProductionYear should be left out, not set to 0')
})

test('library titles come first and are not repeated', async () => {
  configure()
  const shows = await search('ozark', 'Series')
  assert.deepEqual(names(shows), ['Ozark'])
  assert.equal(shows[0].Id, `00000000-0000-4000-8001-${(69740).toString(16).padStart(12, '0')}`)
  assert.equal(tmdb.count('tv-ids'), 0)
  assert.deepEqual(names(await search('heat')), ['Heat', 'Heat Wave'])
  assert.ok(!tmdb.requests.some(r => r.path === '/movie/949/external_ids'), 'a lookup was spent on a library title')
})

test('a library title found by its original name comes back as the library item', async () => {
  configure()
  // The library search matches the English title only, so only TMDB finds these.
  // A movie's search id is the same either way; the record behind it is not.
  // It ranks by the name TMDB matched too, so it comes before a looser match.
  const movies = await search("Le Fabuleux Destin d'Amélie Poulain")
  assert.deepEqual(movies.map(movie => [movie.Name, movie.OfficialRating]), [['Amélie', 'R'], ['Amélie: The Making Of', undefined]])
  const shows = await search('Engrenages')
  assert.deepEqual(shows.map(show => [show.Name, show.Id]), [['Spiral', `00000000-0000-4000-8001-${(5401).toString(16).padStart(12, '0')}`]])
})

test('TMDB failing entirely gives Cinemeta the whole answer, as today', async t => {
  t.mock.method(console, 'warn', () => {})
  configure({ stremioSearchSource: 'cinemeta' })
  const today = await search('heat')
  configure()
  tmdb.setMode('movie', 'unauthorized')
  tmdb.setMode('tv', 'unauthorized')
  const failed = await search('heat')
  assert.deepEqual(names(failed), ['Heat', 'Heat of the Night', 'Heat Street'])
  assert.deepEqual(failed.map(item => item.Id), today.map(item => item.Id))
  assert.deepEqual(catalogSearches(), ['/catalog/movie/top/search=heat.json', '/catalog/series/top/search=heat.json'])
})

test('TMDB failing for series only gives TMDB movies plus Cinemeta series', async t => {
  t.mock.method(console, 'warn', () => {})
  configure()
  tmdb.setMode('tv', 'error')
  assert.deepEqual(names(await search('heat')), ['Heat', 'Heat Wave', 'Heat Street'])
  assert.deepEqual(catalogSearches(), ['/catalog/series/top/search=heat.json'])
})

test('without a TMDB key, or with another source, TMDB is not asked', async () => {
  configure({ tmdbApiKey: '' })
  assert.deepEqual(names(await search('heat')), ['Heat', 'Heat of the Night', 'Heat Street'])
  assert.equal(tmdb.requests.length, 0)
  configure({ stremioSearchSource: 'cinemeta' })
  await search('monk')
  assert.equal(tmdb.requests.length, 0)
  assert.deepEqual(catalogSearches(), ['/catalog/movie/top/search=monk.json', '/catalog/series/top/search=monk.json'])
})

test('a one-letter search goes to Cinemeta, as it did before TMDB', async () => {
  configure()
  assert.deepEqual(names(await search('h')), ['Heat', 'Heat of the Night', 'Heat Street'])
  assert.equal(tmdb.requests.length, 0)
  assert.deepEqual(catalogSearches(), ['/catalog/movie/top/search=h.json', '/catalog/series/top/search=h.json'])
})

test('an account without search, or a search for people only, asks nobody', async () => {
  configure()
  assert.deepEqual(names(await search('heat', 'Movie,Series', tokens.noSearch)), ['Heat'])
  await search('heat', 'Person')
  assert.equal(tmdb.requests.length, 0)
  assert.deepEqual(cinemeta.requests, [])
})

test('a series found through TMDB opens, lists its seasons and episodes, and plays', async () => {
  configure()
  const [bureau] = await search('Le Bureau des légendes', 'Series')
  const item = await request(`/Users/${admin.id}/Items/${bureau.Id}`)
  assert.deepEqual([item.Name, item.Type], ['The Bureau', 'Series'])
  const seasons = (await request(`/Shows/${bureau.Id}/Seasons`)).Items as Item[]
  assert.deepEqual(seasons.map(season => season.IndexNumber), [1, 2])
  const episodes = (await request(`/Shows/${bureau.Id}/Episodes?SeasonId=${seasons[0].Id}`)).Items as Item[]
  assert.deepEqual(names(episodes), ['Episode 1', 'Episode 2'])

  const registered: Array<[unknown, string]> = []
  const info = await request(`/Items/${episodes[0].Id}/PlaybackInfo`, tokens.admin, {
    registerPlaybackItem: (id: string, playPath: string) => { registered.push([id, playPath]) },
  })
  assert.deepEqual(registered, [[episodes[0].Id, '/play/stremio/series/tt4063800%3A1%3A1']])
  assert.equal((info.MediaSources as Item[]).length, 1)
})

test('a movie found through TMDB opens and plays by its IMDb id', async () => {
  configure()
  const [movie] = await search('Dix pour cent', 'Movie')
  const item = await request(`/Users/${admin.id}/Items/${movie.Id}`)
  assert.deepEqual([item.Name, (item.ProviderIds as Item).Imdb], ['Call My Agent! The Movie', 'tt30000001'])
  const registered: Array<[unknown, string]> = []
  await request(`/Items/${movie.Id}/PlaybackInfo`, tokens.admin, {
    registerPlaybackItem: (id: string, playPath: string) => { registered.push([id, playPath]) },
  })
  assert.deepEqual(registered, [[movie.Id, '/play/tt30000001']])
  // Opening it fetched the full record once; playing it read that record back.
  assert.deepEqual(tmdb.requests.filter(r => r.scope === 'movie-details').map(r => r.path), ['/movie/1365884'])
})

test('each keystroke of a series search reuses the episodes already fetched', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
  configure()
  const metaFetches = () => cinemeta.requests.filter(path => path === '/meta/series/tt5601.json').length
  for (const term of ['Kaam', 'Kaame', 'Kaamel', 'Kaamelott']) assert.deepEqual(names(await search(term, 'Series')), ['Kaamelott'])
  assert.equal(metaFetches(), 1)
  // Kept ten minutes, so new episodes still show up.
  t.mock.timers.tick(10 * 60 * 1000)
  await search('Kaamelott', 'Series')
  assert.equal(metaFetches(), 2)
})

test('a slow TMDB costs one timeout, then Cinemeta answers', async t => {
  t.mock.method(console, 'warn', () => {})
  configure({ tmdbSearchTimeoutMs: 300 })
  tmdb.setMode('movie', 'slow')
  tmdb.setMode('tv', 'slow')
  const started = Date.now()
  assert.deepEqual(names(await search('heat')), ['Heat', 'Heat of the Night', 'Heat Street'])
  assert.ok(Date.now() - started < 2000, `waited ${Date.now() - started} ms`)
  // The next keystroke goes straight to Cinemeta rather than waiting again.
  const searchesBefore = tmdb.requests.length
  const next = Date.now()
  assert.deepEqual(names(await search('hea')), ['Heat', 'Heat of the Night', 'Heat Street'])
  assert.ok(Date.now() - next < 250, `waited ${Date.now() - next} ms`)
  assert.equal(tmdb.requests.length, searchesBefore)
})
