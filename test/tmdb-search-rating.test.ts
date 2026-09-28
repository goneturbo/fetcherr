import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { startFakeTmdb, FAKE_TMDB_KEY, type FakeTmdbMovie, type FakeTmdbSeries } from './fake-tmdb.js'
import { installFakeCinemeta } from './fake-cinemeta.js'

const databasePath = join(tmpdir(), `fetcherr-tmdb-search-rating-${randomUUID()}.db`)
process.env.DATABASE_PATH = databasePath
process.env.TMDB_API_KEY = ''
// TVDB is the rating fallback. Without a key it answers nothing, so an unknown
// rating stays unknown.
process.env.TVDB_API_KEY = ''

const db = await import('../src/db.js')
const { config } = await import('../src/config.js')
const { jellyfinRoutes, resolveJellyfinUser } = await import('../src/jellyfin/index.js')
const { clearTmdbSearchCache } = await import('../src/tmdb-search.js')
const { primeStremioRating } = await import('../src/stremio-rating.js')

const heistMovies: FakeTmdbMovie[] = [
  { id: 6001, title: 'Heist PG', imdb: 'tt6001', certification: 'PG' },
  { id: 6002, title: 'Heist R', imdb: 'tt6002', certification: 'R' },
  { id: 6003, title: 'Heist Unknown', imdb: 'tt6003' },
]
const heistSeries: FakeTmdbSeries[] = [
  { id: 6101, name: 'Heist Show', imdb: 'tt6101' },
  { id: 6102, name: 'Heist Show MA', imdb: 'tt6102' },
  { id: 6103, name: 'Heist Show Unknown', imdb: 'tt6103' },
]
// TMDB lists the exact title last, behind 30 looser ones.
const ratedMovies: FakeTmdbMovie[] = [
  ...Array.from({ length: 30 }, (_, i) => ({ id: 6201 + i, title: `Rated Movie ${i + 1}`, imdb: `tt${6201 + i}`, certification: 'PG' })),
  { id: 6200, title: 'Rated', imdb: 'tt6200', certification: 'PG' },
]
const ratedSeries: FakeTmdbSeries[] = Array.from({ length: 20 }, (_, i) => ({ id: 6301 + i, name: `Rated Show ${i + 1}`, imdb: `tt${6301 + i}` }))
// Forty exact matches, so all forty pass the title-match rank and all forty
// need a rating check: nothing here should ever wait behind more than nine others.
const throttledMovies: FakeTmdbMovie[] = Array.from({ length: 40 }, (_, i) => ({
  id: 6401 + i, title: 'Throttled', imdb: `tt${6401 + i}`, certification: 'PG',
}))

const tmdb = await startFakeTmdb({
  movies: [...heistMovies, ...ratedMovies, ...throttledMovies], series: [...heistSeries, ...ratedSeries],
  // Fast enough to stay inside the search timeout below, slow enough to force overlap.
  slowMs: 40,
})
// No metas: series keep the name TMDB gave them.
const cinemeta = installFakeCinemeta()
test.after(async () => {
  cinemeta.restore()
  await tmdb.close()
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${databasePath}${suffix}`, { force: true })
})

// The series gate reads this cache before it reaches TMDB or TVDB. Heist Show
// Unknown is left out on purpose, so its lookup finds nothing.
primeStremioRating({ id: 'tt6101', type: 'series' }, 'series', 'TV-PG')
primeStremioRating({ id: 'tt6102', type: 'series' }, 'series', 'TV-MA')
for (const show of ratedSeries) primeStremioRating({ id: String(show.imdb), type: 'series' }, 'series', 'TV-PG')

// The first account created takes the default admin id, so it goes first.
const admin = db.createUser('admin', 'pw', 'admin', 'unrestricted')
const adult = db.createUser('adult', 'pw', 'user', 'unrestricted')
const teen = db.createUser('teen', 'pw', 'user', 'PG-13')

resolveJellyfinUser({ 'x-emby-token': 'no-such-token' })
function issueToken(userId: string): string {
  const token = randomUUID()
  db.getDb().prepare(`INSERT INTO jellyfin_tokens (token, user_id, expires_at) VALUES (?, ?, ?)`).run(token, userId, Date.now() + 3_600_000)
  return token
}
const tokens = { admin: issueToken(admin.id), adult: issueToken(adult.id), teen: issueToken(teen.id) }

const PRODUCTION_ROUTER_OPTIONS = {
  routerOptions: { ignoreTrailingSlash: true },
  rewriteUrl: (req: { url?: string }) => req.url!.replace(/\/\/+/g, '/').replace(/\.view(\?|$)/, '$1'),
}

async function search(term: string, token: string): Promise<Array<Record<string, unknown>>> {
  Object.assign(config, {
    stremioSearchEnabled: true, stremioSearchSource: 'tmdb', tmdbApiKey: FAKE_TMDB_KEY, tmdbBaseUrl: tmdb.url, tmdbSearchTimeoutMs: 2000,
  })
  clearTmdbSearchCache()
  tmdb.requests.length = 0
  const app = Fastify(PRODUCTION_ROUTER_OPTIONS as never)
  await app.register(jellyfinRoutes, {} as never)
  const res = await app.inject({
    method: 'GET',
    url: `/Users/${admin.id}/Items?SearchTerm=${encodeURIComponent(term)}&IncludeItemTypes=Movie,Series&Recursive=true&Limit=50`,
    headers: { 'x-emby-token': token },
  })
  await app.close()
  assert.equal(res.statusCode, 200, res.body)
  return res.json().Items
}

test('unrestricted accounts make no rating lookups', async () => {
  for (const token of [tokens.admin, tokens.adult]) {
    const items = await search('heist', token)
    assert.deepEqual(items.map(item => item.Name), ['Heist PG', 'Heist R', 'Heist Unknown', 'Heist Show', 'Heist Show MA', 'Heist Show Unknown'])
    assert.deepEqual([tmdb.count('movie-details'), tmdb.count('find')], [0, 0])
  }
})

test('a rating-limited account keeps what its limit allows and loses the rest', async () => {
  const items = await search('heist', tokens.teen)
  assert.deepEqual(items.map(item => [item.Name, item.OfficialRating]), [['Heist PG', 'PG'], ['Heist Show', 'TV-PG']])
  // One rating lookup per movie. The series nobody rated is looked up, found
  // nowhere, and refused.
  assert.equal(tmdb.count('movie-details'), 3)
  assert.deepEqual(tmdb.requests.filter(r => r.scope === 'find').map(r => r.path), ['/find/tt6103'])
})

test('rating checks stop at the 40 best title matches', async () => {
  const items = await search('rated', tokens.teen)
  assert.equal(items.length, 40)
  assert.equal(items[0].Name, 'Rated')
  const shown = new Set(items.map(item => item.Name))
  assert.ok(shown.has('Rated Show 9') && !shown.has('Rated Show 10'), 'the cap is not where the title ranking puts it')
  assert.equal(tmdb.count('movie-details'), 31)
})

test('forty rating checks for a limited account never have more than ten requests open at the fake TMDB', async () => {
  tmdb.setMode('movie-details', 'slow')
  let items: Array<Record<string, unknown>>
  try {
    items = await search('throttled', tokens.teen)
  } finally {
    tmdb.setMode('movie-details', 'answers')
  }
  assert.equal(items.length, 40)
  assert.ok(tmdb.maxInFlight() <= 10, `expected at most 10 requests in flight, saw ${tmdb.maxInFlight()}`)
})
