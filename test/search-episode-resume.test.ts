import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

// No real network, and no touching the real database. src/config.ts reads
// these once at module load, so they must be set before the dynamic imports
// below — a static import would be hoisted above these assignments.
const databasePath = join(tmpdir(), `fetcherr-search-episode-resume-${randomUUID()}.db`)
process.env.DATABASE_PATH = databasePath
process.env.TMDB_API_KEY = ''
process.env.TVDB_API_KEY = ''
process.env.STREMIO_SEARCH_ENABLED = 'true'

const db = await import('../src/db.js')
const { jellyfinRoutes, resolveJellyfinUser } = await import('../src/jellyfin/index.js')

const TICKS_PER_MIN = 60 * 10_000_000

// ── A fake Cinemeta: manifest, catalog search and per-episode meta lookups ──

interface FakeShow { id: string; name: string }
const SHOW_A: FakeShow = { id: 'tt9990001', name: 'Resume Test Show' }
const SHOW_B: FakeShow = { id: 'tt9990002', name: 'Flaky Refetch Show' }
const SHOWS = [SHOW_A, SHOW_B]

function seriesVideos(show: FakeShow) {
  return [
    { id: `${show.id}:1:1`, season: 1, episode: 1, name: 'Pilot', released: '2020-01-01' },
    { id: `${show.id}:1:2`, season: 1, episode: 2, name: 'Second Episode', released: '2020-01-08' },
  ]
}

const metaFetchCounts = new Map<string, number>()
const failingSeriesIds = new Set<string>()

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

const realFetch = globalThis.fetch
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = String(input)

  if (url.endsWith('/manifest.json')) {
    return jsonResponse({ catalogs: [{ id: 'top', type: 'series', extra: [{ name: 'search' }] }] })
  }

  const catalogMatch = url.match(/\/catalog\/series\/top\/search=([^/]+)\.json$/)
  if (catalogMatch) {
    const query = decodeURIComponent(catalogMatch[1])
    const show = SHOWS.find(s => s.name === query)
    return jsonResponse({ metas: show ? [{ id: show.id, type: 'series', name: show.name }] : [] })
  }

  const metaMatch = url.match(/\/meta\/series\/([^/]+)\.json$/)
  if (metaMatch) {
    const seriesId = metaMatch[1]
    metaFetchCounts.set(seriesId, (metaFetchCounts.get(seriesId) ?? 0) + 1)
    const show = SHOWS.find(s => s.id === seriesId)
    if (!show) return jsonResponse({}, 404)
    if (failingSeriesIds.has(seriesId)) return jsonResponse({ error: 'boom' }, 500)
    return jsonResponse({ meta: { id: show.id, type: 'series', name: show.name, videos: seriesVideos(show) } })
  }

  throw new Error(`search-episode-resume test: unexpected fetch ${url}`)
}) as typeof globalThis.fetch

// ── A mockable clock: STREMIO_CACHE_TTL_MS is 15 minutes, and each call below
// jumps it 16 minutes further, always enough to expire anything cached since
// the previous jump, however many tests have run so far. ──────────────────

const realNow = Date.now
let clockOffsetMs = 0
Date.now = () => realNow() + clockOffsetMs
function expireStremioCaches(): void {
  clockOffsetMs += 16 * 60 * 1000
}

// ── Users, auth, and the app under test ─────────────────────────────────────
// Same token setup as the other Jellyfin route tests: a real user row plus a
// row in jellyfin_tokens, then the token on every request as x-emby-token.

function authedUser(username: string) {
  const user = db.createUser(username, 'pw', 'user', 'unrestricted')
  // jellyfin_tokens is created lazily on first use inside src/jellyfin/index.ts;
  // this lookup (which misses) is what creates it, before the raw insert below.
  resolveJellyfinUser({ 'x-emby-token': 'no-such-token' })
  const token = randomUUID()
  db.getDb()
    .prepare(`INSERT INTO jellyfin_tokens (token, user_id, expires_at) VALUES (?, ?, ?)`)
    .run(token, user.id, realNow() + 24 * 3_600_000)
  return { user, token }
}

async function buildApp(overrides: Record<string, unknown> = {}) {
  const app = Fastify()
  await app.register(jellyfinRoutes, overrides as never)
  return app
}

// Drives the real discovery path a client uses: search finds the series (a
// 32-hex "Stremio Search" id), then browsing its episodes mints the 8009- ids
// under test. Returns the episode ids in season/episode order.
async function discoverEpisodes(app: ReturnType<typeof Fastify>, token: string, userId: string, show: FakeShow): Promise<string[]> {
  const searchRes = await app.inject({
    method: 'GET',
    url: `/Users/${userId}/Items?searchterm=${encodeURIComponent(show.name)}`,
    headers: { 'x-emby-token': token },
  })
  assert.equal(searchRes.statusCode, 200, `search for ${show.name} failed: ${searchRes.body}`)
  const seriesItem = (searchRes.json().Items as Array<{ Id: string; Name: string }>).find(item => item.Name === show.name)
  assert.ok(seriesItem, `series ${show.name} not found in search results`)

  const browseRes = await app.inject({
    method: 'GET',
    url: `/Users/${userId}/Items?ParentId=${seriesItem!.Id}&IncludeItemTypes=Episode`,
    headers: { 'x-emby-token': token },
  })
  assert.equal(browseRes.statusCode, 200, `browsing ${show.name}'s episodes failed: ${browseRes.body}`)
  const episodes = browseRes.json().Items as Array<{ Id: string; IndexNumber: number }>
  return episodes.sort((a, b) => a.IndexNumber - b.IndexNumber).map(ep => ep.Id)
}

async function reportProgress(app: ReturnType<typeof Fastify>, token: string, itemId: string, positionTicks: number) {
  const res = await app.inject({
    method: 'POST',
    url: '/Sessions/Playing/Progress',
    headers: { 'x-emby-token': token },
    payload: { ItemId: itemId, PositionTicks: positionTicks },
  })
  assert.equal(res.statusCode, 200, `progress report failed: ${res.body}`)
}

async function getResume(app: ReturnType<typeof Fastify>, token: string, userId: string) {
  const res = await app.inject({ method: 'GET', url: `/Users/${userId}/Items/Resume`, headers: { 'x-emby-token': token } })
  assert.equal(res.statusCode, 200, `resume failed: ${res.body}`)
  return res.json() as { Items: Array<Record<string, unknown>>; TotalRecordCount: number }
}

// ── The tests ────────────────────────────────────────────────────────────────

test('a ref written while the cache is warm lets a search episode resume after it expires', async () => {
  const { user, token } = authedUser('ref-written')
  const app = await buildApp()
  const [ep1] = await discoverEpisodes(app, token, user.id, SHOW_A)

  await reportProgress(app, token, ep1, 5 * TICKS_PER_MIN)
  assert.ok(db.getStremioEpisodeRef(ep1), 'expected a ref to be written while the cache was warm')

  expireStremioCaches()

  const resume = await getResume(app, token, user.id)
  assert.equal(resume.TotalRecordCount, 1)
  assert.equal(resume.Items.length, 1)
  assert.equal(resume.Items[0].Name, 'Pilot')
  assert.equal((resume.Items[0].UserData as { PlaybackPositionTicks: number }).PlaybackPositionTicks, 5 * TICKS_PER_MIN)
  await app.close()
})

test('an 8009 id with saved progress but no ref is left out of resume, and is not counted', async () => {
  const { user, token } = authedUser('no-ref')
  const fakeId = '00000000-0000-4000-8009-abcdefabcdef'
  db.saveProgress(fakeId, 5 * TICKS_PER_MIN, user.id)
  assert.equal(db.getStremioEpisodeRef(fakeId), null)

  const app = await buildApp()
  const resume = await getResume(app, token, user.id)
  assert.equal(resume.Items.length, 0)
  assert.equal(resume.TotalRecordCount, resume.Items.length)
  await app.close()
})

test('a ref survives a restart: a fresh app with a cold cache still resolves it', async () => {
  const { user, token } = authedUser('restart')
  const setupApp = await buildApp()
  const [, ep2] = await discoverEpisodes(setupApp, token, user.id, SHOW_A)
  await reportProgress(setupApp, token, ep2, 4 * TICKS_PER_MIN)
  await setupApp.close()

  expireStremioCaches()

  const freshApp = await buildApp()
  const resume = await getResume(freshApp, token, user.id)
  assert.equal(resume.TotalRecordCount, 1)
  assert.equal(resume.Items[0].Name, 'Second Episode')
  await freshApp.close()
})

test('a failed refetch leaves the item out, without an uncounted phantom', async () => {
  const { user, token } = authedUser('flaky-refetch')
  const app = await buildApp()
  const [ep1] = await discoverEpisodes(app, token, user.id, SHOW_B)
  await reportProgress(app, token, ep1, 3 * TICKS_PER_MIN)
  assert.ok(db.getStremioEpisodeRef(ep1))

  expireStremioCaches()
  failingSeriesIds.add(SHOW_B.id)
  try {
    const resume = await getResume(app, token, user.id)
    assert.equal(resume.Items.length, 0)
    assert.equal(resume.TotalRecordCount, resume.Items.length)
  } finally {
    failingSeriesIds.delete(SHOW_B.id)
  }
  await app.close()
})

test('the library identity can open and play a resumed episode after its cache has expired', async () => {
  const { user, token } = authedUser('clicker')
  const app = await buildApp()
  const [ep1] = await discoverEpisodes(app, token, user.id, SHOW_A)
  await reportProgress(app, token, ep1, 6 * TICKS_PER_MIN)

  expireStremioCaches()

  const openRes = await app.inject({ method: 'GET', url: `/Users/${user.id}/Items/${ep1}`, headers: { 'x-emby-token': token } })
  assert.equal(openRes.statusCode, 200)
  const opened = openRes.json()
  assert.equal(opened.Name, 'Pilot')
  assert.equal(opened.UserData.PlaybackPositionTicks, 6 * TICKS_PER_MIN)

  const playbackRes = await app.inject({ method: 'POST', url: `/Items/${ep1}/PlaybackInfo`, headers: { 'x-emby-token': token } })
  assert.equal(playbackRes.statusCode, 200)
  const path = playbackRes.json().MediaSources[0].Path as string
  assert.match(path, /\/play\/stremio\/series\/tt9990001%3A1%3A1/i)
  await app.close()
})

test('two episodes of one show cost one Cinemeta fetch to resolve after expiry', async () => {
  const { user, token } = authedUser('shared-fetch')
  const app = await buildApp()
  const [ep1, ep2] = await discoverEpisodes(app, token, user.id, SHOW_A)
  await reportProgress(app, token, ep1, 3 * TICKS_PER_MIN)
  await reportProgress(app, token, ep2, 3 * TICKS_PER_MIN)

  expireStremioCaches()
  const before = metaFetchCounts.get(SHOW_A.id) ?? 0

  const resume = await getResume(app, token, user.id)
  assert.equal(resume.TotalRecordCount, 2)

  const after = metaFetchCounts.get(SHOW_A.id) ?? 0
  assert.equal(after - before, 1, 'expected exactly one Cinemeta fetch for two episodes of one show')
  await app.close()
})

test('the search identity still answers resume with no items', async () => {
  const { user, token } = authedUser('search-identity')
  const app = await buildApp({ searchOnly: true })
  const resume = await getResume(app, token, user.id)
  assert.deepEqual(resume, { Items: [], TotalRecordCount: 0, StartIndex: 0 })
  await app.close()
})

// better-sqlite3 leaves the database plus its -wal and -shm sidecars in tmpdir,
// once per run per file. Nothing else cleans them up.
test.after(() => {
  globalThis.fetch = realFetch
  Date.now = realNow
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${databasePath}${suffix}`, { force: true })
})
