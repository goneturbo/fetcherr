import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { startFakeTmdb, FAKE_TMDB_KEY } from './fake-tmdb.js'
import { installFakeCinemeta } from './fake-cinemeta.js'

process.env.DATABASE_PATH = join(tmpdir(), `fetcherr-tmdb-search-settings-${randomUUID()}.db`)
// No network: config reads keys once at load, and unset keys keep every lookup offline.
process.env.TMDB_API_KEY = ''
process.env.TVDB_API_KEY = ''
const db = await import('../src/db.js')
const { config, parseStremioSearchSource } = await import('../src/config.js')
const { uiRoutes } = await import('../src/ui/routes.js')
const { createSession } = await import('../src/ui/auth.js')
const { findTmdbTitles } = await import('../src/tmdb-search.js')
const { searchStremioMetas, fetchStremioMeta } = await import('../src/sootio.js')

const admin = db.createUser('admin', 'pw', 'admin', 'unrestricted')
const adminHeaders = { cookie: `infuse_session=${createSession(admin.id)}` }

async function buildApp() {
  const app = Fastify()
  await app.register(uiRoutes)
  return app
}
type App = Awaited<ReturnType<typeof buildApp>>

const save = (app: App, payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: '/ui/settings-data', headers: adminHeaders, payload: payload as never })
const read = (app: App) => app.inject({ method: 'GET', url: '/ui/settings-data', headers: adminHeaders })

test('the tmdb source is accepted, and anything unknown is still cinemeta', () => {
  assert.equal(parseStremioSearchSource('tmdb'), 'tmdb')
  assert.equal(parseStremioSearchSource('trakt'), 'trakt')
  assert.equal(parseStremioSearchSource('bogus'), 'cinemeta')
  assert.equal(parseStremioSearchSource(undefined), 'cinemeta')
})

test('saving tmdb stores it and applies it', async () => {
  const app = await buildApp()
  assert.equal((await save(app, { stremioSearchSource: 'tmdb' })).statusCode, 200)
  assert.equal(db.getSetting('stremioSearchSource'), 'tmdb')
  assert.equal(config.stremioSearchSource, 'tmdb')
  assert.equal((await read(app)).json().stremioSearchSource, 'tmdb')
  await app.close()
})

test('settings say whether a TMDB key is configured, wherever it came from', async () => {
  const app = await buildApp()
  config.tmdbApiKey = ''
  assert.equal((await read(app)).json().tmdbApiKeyConfigured, false)
  // Set the way TMDB_API_KEY sets it: in config, with nothing stored.
  config.tmdbApiKey = 'key-from-env-7c1d'
  const fromEnv = await read(app)
  assert.equal(fromEnv.json().tmdbApiKeyConfigured, true)
  assert.equal(fromEnv.json().hasTmdbApiKey, false)
  assert.ok(!fromEnv.body.includes('key-from-env-7c1d'), 'the key itself was sent to the page')
  config.tmdbApiKey = ''
  await save(app, { tmdbApiKey: 'key-saved-in-settings-2b9e' })
  assert.equal((await read(app)).json().tmdbApiKeyConfigured, true)
  await app.close()
})

test('the settings page offers TMDB and says when no key is set', async () => {
  const app = await buildApp()
  const res = await app.inject({ method: 'GET', url: '/ui/settings', headers: adminHeaders })
  assert.equal(res.statusCode, 200)
  assert.match(res.body, /<option value="tmdb">TMDB: matches original and translated titles \(needs the TMDB API key\)<\/option>/)
  assert.match(res.body, /<div class="field-note" id="stremioSearchSourceNote" hidden>No TMDB API key is set, so search uses Cinemeta\.<\/div>/)
  assert.match(res.body, /tmdbApiKeyConfigured = d\.tmdbApiKeyConfigured === true/)
  await app.close()
})

test('any settings save drops cached TMDB answers', async t => {
  const fake = await startFakeTmdb({ movies: [{ id: 4001, title: 'Heat', imdb: 'tt4001' }] })
  t.after(() => fake.close())
  Object.assign(config, { tmdbApiKey: FAKE_TMDB_KEY, tmdbBaseUrl: fake.url })
  const app = await buildApp()
  await findTmdbTitles('heat', ['movie'])
  await findTmdbTitles('heat', ['movie'])
  assert.equal(fake.count('movie'), 1)
  await save(app, {})
  await findTmdbTitles('heat', ['movie'])
  assert.equal(fake.count('movie'), 2)
  await app.close()
})

test('a settings save ends a rest, so a newly saved key is tried at once', async t => {
  t.mock.method(console, 'warn', () => {})
  const fake = await startFakeTmdb({ movies: [{ id: 4002, title: 'Ronin', imdb: 'tt4002' }] })
  t.after(() => fake.close())
  Object.assign(config, { tmdbApiKey: 'not-the-key', tmdbBaseUrl: fake.url })
  const app = await buildApp()
  assert.equal((await findTmdbTitles('ronin', ['movie'])).movies, null)
  await save(app, { tmdbApiKey: FAKE_TMDB_KEY })
  assert.deepEqual((await findTmdbTitles('ronin', ['movie'])).movies?.map(m => m.tmdbId), [4002])
  await app.close()
})

test('with the source set to tmdb, Stremio search and series metadata still read Cinemeta', async t => {
  const cinemeta = installFakeCinemeta()
  const previousProviders = config.streamProviderUrls
  t.after(() => {
    cinemeta.restore()
    config.streamProviderUrls = previousProviders
  })
  config.stremioSearchSource = 'tmdb'
  // aiostreams serves streams, not metas. It must not be asked.
  config.streamProviderUrls = ['https://aiostreams.example.test']
  await searchStremioMetas('heat', ['movie', 'series'])
  await fetchStremioMeta('series', 'tt0312172')
  assert.deepEqual(cinemeta.requests.sort(), [
    '/catalog/movie/top/search=heat.json', '/catalog/series/top/search=heat.json', '/meta/series/tt0312172.json',
  ])
  assert.deepEqual(cinemeta.passedThrough, [])
})
