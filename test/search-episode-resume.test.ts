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
const { config } = await import('../src/config.js')

const TICKS_PER_MIN = 60 * 10_000_000
const TICKS_PER_SEC = 10_000_000

// ── A fake Cinemeta: manifest, catalog search and per-episode meta lookups ──

interface FakeShow { id: string; name: string }
const SHOW_A: FakeShow = { id: 'tt9990001', name: 'Resume Test Show' }
const SHOW_B: FakeShow = { id: 'tt9990002', name: 'Flaky Refetch Show' }
const SHOW_C: FakeShow = { id: 'tt9990003', name: 'Hanging Refetch Show' }
const SHOW_D: FakeShow = { id: 'tt9990004', name: 'Retry After Failure Show' }
const SHOW_E: FakeShow = { id: 'tt9990005', name: 'Rewrite Guard Show' }
const SHOWS = [SHOW_A, SHOW_B, SHOW_C, SHOW_D, SHOW_E]

function seriesVideos(show: FakeShow) {
  return [
    { id: `${show.id}:1:1`, season: 1, episode: 1, name: 'Pilot', released: '2020-01-01' },
    { id: `${show.id}:1:2`, season: 1, episode: 2, name: 'Second Episode', released: '2020-01-08' },
  ]
}

const metaFetchCounts = new Map<string, number>()
const failingSeriesIds = new Set<string>()
// Per-series artificial delay (ms) before a /meta/series/ response, and a set
// of series ids whose response never arrives at all — for Important 1's
// parallel-prefetch and hung-Cinemeta tests below.
const seriesFetchDelayMs = new Map<string, number>()
const hangingSeriesIds = new Set<string>()

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

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
    const delay = seriesFetchDelayMs.get(seriesId)
    if (delay) await sleep(delay)
    // Simulates a Cinemeta that hangs rather than answers: the response never
    // arrives, so only handleResumeItems' own bound can move the caller on.
    if (hangingSeriesIds.has(seriesId)) return new Promise<Response>(() => {})
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

async function stopPlaying(app: ReturnType<typeof Fastify>, token: string, itemId: string, positionTicks: number) {
  const res = await app.inject({
    method: 'POST',
    url: '/Sessions/Playing/Stopped',
    headers: { 'x-emby-token': token },
    payload: { ItemId: itemId, PositionTicks: positionTicks },
  })
  assert.equal(res.statusCode, 200, `stop report failed: ${res.body}`)
}

async function getResume(app: ReturnType<typeof Fastify>, token: string, userId: string) {
  const res = await app.inject({ method: 'GET', url: `/Users/${userId}/Items/Resume`, headers: { 'x-emby-token': token } })
  assert.equal(res.statusCode, 200, `resume failed: ${res.body}`)
  return res.json() as { Items: Array<Record<string, unknown>>; TotalRecordCount: number }
}

// Finds a series' 32-hex "Stremio Search" id via the same search call
// discoverEpisodes makes, without minting any 8009- episode ids.
async function findSeriesId(app: ReturnType<typeof Fastify>, token: string, show: FakeShow): Promise<string> {
  const res = await app.inject({
    method: 'GET',
    url: `/Users/anyone/Items?searchterm=${encodeURIComponent(show.name)}`,
    headers: { 'x-emby-token': token },
  })
  assert.equal(res.statusCode, 200, `search for ${show.name} failed: ${res.body}`)
  const seriesItem = (res.json().Items as Array<{ Id: string; Name: string }>).find(item => item.Name === show.name)
  assert.ok(seriesItem, `series ${show.name} not found in search results`)
  return seriesItem!.Id
}

async function listShowEpisodes(app: ReturnType<typeof Fastify>, token: string, seriesId: string, seasonId?: string) {
  const url = seasonId ? `/Shows/${seriesId}/Episodes?seasonId=${seasonId}` : `/Shows/${seriesId}/Episodes`
  const res = await app.inject({ method: 'GET', url, headers: { 'x-emby-token': token } })
  assert.equal(res.statusCode, 200, `episode list failed: ${res.body}`)
  return res.json() as { Items: Array<Record<string, unknown>>; TotalRecordCount: number }
}

async function getItem(app: ReturnType<typeof Fastify>, token: string, userId: string, itemId: string) {
  const res = await app.inject({ method: 'GET', url: `/Users/${userId}/Items/${itemId}`, headers: { 'x-emby-token': token } })
  assert.equal(res.statusCode, 200, `open ${itemId} failed: ${res.body}`)
  return res.json() as Record<string, unknown>
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

test('a search episode stopped early on the restart path still has its ref written, and resumes after its cache expires', async () => {
  const { user, token } = authedUser('restart-path-ref')
  const app = await buildApp()
  const [ep1] = await discoverEpisodes(app, token, user.id, SHOW_A)

  // An existing resume point, same as a real resume-and-jump-back: the first
  // report is a real position above MIN_RESUME_TICKS, so the episode already
  // had a saved point before the restart-and-give-up below.
  await reportProgress(app, token, ep1, 5 * TICKS_PER_MIN)
  await reportProgress(app, token, ep1, 1 * TICKS_PER_SEC)
  await stopPlaying(app, token, ep1, 90 * TICKS_PER_SEC)
  const opened = await getItem(app, token, user.id, ep1)
  assert.equal((opened.UserData as Record<string, unknown>).PlaybackPositionTicks, 90 * TICKS_PER_SEC)

  expireStremioCaches()

  const resume = await getResume(app, token, user.id)
  assert.equal(resume.TotalRecordCount, 1)
  assert.equal(resume.Items.length, 1)
  assert.equal(resume.Items[0].Name, 'Pilot')
  assert.equal((resume.Items[0].UserData as { PlaybackPositionTicks: number }).PlaybackPositionTicks, 90 * TICKS_PER_SEC)
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

test('resume resolves two different series in parallel, not one after another', async () => {
  const { user, token } = authedUser('parallel-resolve')
  const app = await buildApp()
  const [ep1A] = await discoverEpisodes(app, token, user.id, SHOW_A)
  const [ep1B] = await discoverEpisodes(app, token, user.id, SHOW_B)
  await reportProgress(app, token, ep1A, 3 * TICKS_PER_MIN)
  await reportProgress(app, token, ep1B, 3 * TICKS_PER_MIN)

  expireStremioCaches()
  // Each series answers after ~300ms; run one after another that's ~600ms,
  // run in parallel it's close to 300ms. The threshold below sits well under
  // the serial sum, with generous margin either side.
  seriesFetchDelayMs.set(SHOW_A.id, 300)
  seriesFetchDelayMs.set(SHOW_B.id, 300)
  try {
    const start = Date.now()
    const resume = await getResume(app, token, user.id)
    const elapsed = Date.now() - start
    assert.equal(resume.TotalRecordCount, 2)
    assert.ok(elapsed < 550, `expected well under the ~600ms serial sum, took ${elapsed}ms`)
  } finally {
    seriesFetchDelayMs.delete(SHOW_A.id)
    seriesFetchDelayMs.delete(SHOW_B.id)
  }
  await app.close()
})

test('a hung Cinemeta does not hold up library rows for more than the prefetch bound, and its episode is left out', async () => {
  const { user, token } = authedUser('hung-refetch')
  const app = await buildApp()

  // A real library movie: before this feature, resume for rows like this made
  // no network calls at all, and that must still hold when a search episode
  // on the same list is stuck behind a Cinemeta that never answers.
  const movieTmdbId = 4_242_001
  const movieItemId = `00000000-0000-4000-8000-${movieTmdbId.toString(16).padStart(12, '0')}`
  db.upsertMovie({
    tmdbId: movieTmdbId,
    imdbId: 'tt4242001',
    mediaLanguage: 'en',
    title: 'Library Movie',
    year: 2020,
    overview: '',
    posterPath: '',
    backdropPath: '',
    logoPath: '',
    genres: '[]',
    runtimeMins: 100,
    popularity: 0,
    officialRating: '',
    communityRating: 0,
    studiosJson: '[]',
    tagsJson: '[]',
    castJson: '[]',
    releaseDate: '2020-01-01',
    digitalReleaseDate: '2020-01-01',
    syncedAt: new Date().toISOString(),
  })
  // handleItem's plain-movie branch also requires a source item on file
  // (the sign a title is actually in the library, not just cached TMDB meta).
  db.addSourceItem('resume-test', 'movie', movieTmdbId)
  db.saveProgress(movieItemId, 5 * TICKS_PER_MIN, user.id)

  const [ep1] = await discoverEpisodes(app, token, user.id, SHOW_C)
  await reportProgress(app, token, ep1, 2 * TICKS_PER_MIN)

  expireStremioCaches()
  hangingSeriesIds.add(SHOW_C.id)
  try {
    const start = Date.now()
    const resume = await getResume(app, token, user.id)
    const elapsed = Date.now() - start
    assert.ok(elapsed < 3_500, `expected the bound (~3s) to cap the wait, took ${elapsed}ms`)
    assert.equal(resume.TotalRecordCount, 1)
    assert.equal(resume.Items.length, 1)
    assert.equal(resume.Items[0].Name, 'Library Movie')
  } finally {
    hangingSeriesIds.delete(SHOW_C.id)
  }
  await app.close()
})

test('a failed series refetch is not remembered for 15 minutes: the next resolve retries', async () => {
  const { user, token } = authedUser('retry-after-failure')
  const app = await buildApp()
  const [ep1] = await discoverEpisodes(app, token, user.id, SHOW_D)
  await reportProgress(app, token, ep1, 2 * TICKS_PER_MIN)

  expireStremioCaches()
  failingSeriesIds.add(SHOW_D.id)
  const failedRes = await app.inject({ method: 'GET', url: `/Users/${user.id}/Items/${ep1}`, headers: { 'x-emby-token': token } })
  assert.equal(failedRes.statusCode, 404, 'expected the failed refetch to leave the episode unresolved')
  failingSeriesIds.delete(SHOW_D.id)

  // No clock jump and no cache-clearing hook here: if the failure were cached
  // for the full 15-minute TTL like a success, this immediate next call would
  // still see it and 404 again.
  const retryRes = await app.inject({ method: 'GET', url: `/Users/${user.id}/Items/${ep1}`, headers: { 'x-emby-token': token } })
  assert.equal(retryRes.statusCode, 200, 'expected the next resolve to retry rather than reuse the failed lookup')
  assert.equal(retryRes.json().Name, 'Pilot')
  await app.close()
})

test('an unchanged ref is not rewritten by a later progress report', async () => {
  const { user, token } = authedUser('rewrite-guard')
  const app = await buildApp()
  const [ep1] = await discoverEpisodes(app, token, user.id, SHOW_E)
  await reportProgress(app, token, ep1, 1 * TICKS_PER_MIN)
  const original = db.getStremioEpisodeRef(ep1)
  assert.ok(original, 'expected the first progress report to write a ref')

  // Tamper the stored row directly. A rewrite on the next progress report
  // would put the real series id back; skipping the rewrite, as this fix
  // does, leaves the tampered value in place — that is the observable
  // difference between rewriting an unchanged ref and skipping it.
  db.getDb().prepare(`UPDATE stremio_episode_refs SET series_id = ? WHERE item_id = ?`).run('tampered-series-id', ep1)
  assert.equal(db.getStremioEpisodeRef(ep1)?.seriesId, 'tampered-series-id')

  await reportProgress(app, token, ep1, 2 * TICKS_PER_MIN)
  assert.equal(db.getStremioEpisodeRef(ep1)?.seriesId, 'tampered-series-id', 'expected the second report to skip the upsert, not restore the real series id')
  await app.close()
})

test('the stream route redirects a search episode with an expired cache through its ref', async () => {
  const { user, token } = authedUser('stream-redirect')
  const app = await buildApp()
  const [ep1] = await discoverEpisodes(app, token, user.id, SHOW_A)
  await reportProgress(app, token, ep1, 2 * TICKS_PER_MIN)

  expireStremioCaches()

  const res = await app.inject({ method: 'GET', url: `/Videos/${ep1}/stream`, headers: { 'x-emby-token': token } })
  assert.equal(res.statusCode, 302)
  assert.match(res.headers.location as string, /\/play\/stremio\/series\/tt9990001%3A1%3A1/i)
  await app.close()
})

test('the search identity still answers resume with no items', async () => {
  const { user, token } = authedUser('search-identity')
  const app = await buildApp({ searchOnly: true })
  const resume = await getResume(app, token, user.id)
  assert.deepEqual(resume, { Items: [], TotalRecordCount: 0, StartIndex: 0 })
  await app.close()
})

// Task 2: search episodes and search films carry the user's real watch state
// wherever they are listed, not just at the one click-through path task 1
// covered. Infuse reads the season's episode list before PlaybackInfo, so a
// zero there restarts an in-progress episode even though PlaybackInfo itself
// would have reported the real position.

// A movie stubbed straight into the movies table, with imdbId and a non-empty
// castJson: fetchMovieByTmdbId's cache check returns it without a network
// call, so this works with the fake, non-network TMDB key set just below.
function stubSearchFilm(tmdbId: number, title: string): string {
  db.upsertMovie({
    tmdbId,
    imdbId: `tt${tmdbId}`,
    mediaLanguage: 'en',
    title,
    year: 2019,
    overview: '',
    posterPath: '',
    backdropPath: '',
    logoPath: '',
    genres: '[]',
    runtimeMins: 100,
    popularity: 0,
    officialRating: '',
    communityRating: 0,
    studiosJson: '[]',
    tagsJson: '[]',
    castJson: '[{"id":1,"name":"Someone","type":"cast"}]',
    releaseDate: '2019-01-01',
    digitalReleaseDate: '2019-01-01',
    syncedAt: new Date().toISOString(),
  })
  return `00000000-0000-4000-8004-${tmdbId.toString(16).padStart(12, '0')}`
}

test('a search episode with a saved position shows it in the series list, the season list, and when opened directly', async () => {
  const { user, token } = authedUser('episode-userdata')
  const app = await buildApp()
  const seriesId = await findSeriesId(app, token, SHOW_A)
  const [ep1] = await discoverEpisodes(app, token, user.id, SHOW_A)
  await reportProgress(app, token, ep1, 5 * TICKS_PER_MIN)

  const seriesList = await listShowEpisodes(app, token, seriesId)
  const seriesEntry = seriesList.Items.find(item => item.Id === ep1)
  assert.ok(seriesEntry, 'expected the played episode in the series-level list')
  assert.equal((seriesEntry!.UserData as Record<string, unknown>).PlaybackPositionTicks, 5 * TICKS_PER_MIN)

  const seasonId = seriesEntry!.SeasonId as string
  const seasonList = await listShowEpisodes(app, token, seriesId, seasonId)
  const seasonEntry = seasonList.Items.find(item => item.Id === ep1)
  assert.ok(seasonEntry, 'expected the played episode in the season-filtered list')
  assert.equal((seasonEntry!.UserData as Record<string, unknown>).PlaybackPositionTicks, 5 * TICKS_PER_MIN)

  const opened = await getItem(app, token, user.id, ep1)
  assert.equal((opened.UserData as Record<string, unknown>).PlaybackPositionTicks, 5 * TICKS_PER_MIN)
  await app.close()
})

test('a search episode marked played shows Played: true in the episode list', async () => {
  const { user, token } = authedUser('episode-played')
  const app = await buildApp()
  const seriesId = await findSeriesId(app, token, SHOW_B)
  const [ep1] = await discoverEpisodes(app, token, user.id, SHOW_B)

  const markRes = await app.inject({ method: 'POST', url: `/UserPlayedItems/${ep1}`, headers: { 'x-emby-token': token } })
  assert.equal(markRes.statusCode, 200, `mark played failed: ${markRes.body}`)

  const list = await listShowEpisodes(app, token, seriesId)
  const entry = list.Items.find(item => item.Id === ep1)
  assert.ok(entry, 'expected the marked-played episode in the episode list')
  assert.equal((entry!.UserData as Record<string, unknown>).Played, true)
  await app.close()
})

test('a search film with a saved position shows it in /Items/{id} and in resume', async () => {
  const { user, token } = authedUser('search-film')
  const originalKey = config.tmdbApiKey
  config.tmdbApiKey = 'fake-search-film-key'
  try {
    const app = await buildApp()
    const filmId = stubSearchFilm(4_242_555, 'Search-Only Film')
    db.saveProgress(filmId, 7 * TICKS_PER_MIN, user.id)

    const opened = await getItem(app, token, user.id, filmId)
    assert.equal(opened.Name, 'Search-Only Film')
    assert.equal((opened.UserData as Record<string, unknown>).PlaybackPositionTicks, 7 * TICKS_PER_MIN)

    const resume = await getResume(app, token, user.id)
    assert.equal(resume.TotalRecordCount, 1)
    assert.equal(resume.Items[0].Name, 'Search-Only Film')
    assert.equal((resume.Items[0].UserData as Record<string, unknown>).PlaybackPositionTicks, 7 * TICKS_PER_MIN)
    await app.close()
  } finally {
    config.tmdbApiKey = originalKey
  }
})

test('another user sees their own watch state on a search episode, not this user\'s', async () => {
  const { user: userA, token: tokenA } = authedUser('multi-user-a')
  const { token: tokenB } = authedUser('multi-user-b')
  const app = await buildApp()
  const seriesId = await findSeriesId(app, tokenA, SHOW_A)
  const [ep1] = await discoverEpisodes(app, tokenA, userA.id, SHOW_A)
  await reportProgress(app, tokenA, ep1, 5 * TICKS_PER_MIN)

  const listForA = await listShowEpisodes(app, tokenA, seriesId)
  const entryForA = listForA.Items.find(item => item.Id === ep1)
  assert.equal((entryForA!.UserData as Record<string, unknown>).PlaybackPositionTicks, 5 * TICKS_PER_MIN)

  const listForB = await listShowEpisodes(app, tokenB, seriesId)
  const entryForB = listForB.Items.find(item => item.Id === ep1)
  assert.ok(entryForB, 'expected the other user to see the episode too, just not its position')
  assert.equal((entryForB!.UserData as Record<string, unknown>).PlaybackPositionTicks, 0)
  await app.close()
})

test('a search episode and a search film with no saved data still show today\'s zeros', async () => {
  const { user, token } = authedUser('no-saved-data')
  const app = await buildApp()
  const seriesId = await findSeriesId(app, token, SHOW_A)
  const [ep1] = await discoverEpisodes(app, token, user.id, SHOW_A)

  const list = await listShowEpisodes(app, token, seriesId)
  const entry = list.Items.find(item => item.Id === ep1)
  assert.ok(entry)
  const epUserData = entry!.UserData as Record<string, unknown>
  assert.equal(epUserData.PlaybackPositionTicks, 0)
  assert.equal(epUserData.Played, false)

  const originalKey = config.tmdbApiKey
  config.tmdbApiKey = 'fake-search-film-key'
  try {
    const filmId = stubSearchFilm(4_242_777, 'Untouched Search Film')
    const opened = await getItem(app, token, user.id, filmId)
    const filmUserData = opened.UserData as Record<string, unknown>
    assert.equal(filmUserData.PlaybackPositionTicks, 0)
    assert.equal(filmUserData.Played, false)
  } finally {
    config.tmdbApiKey = originalKey
  }
  await app.close()
})

// better-sqlite3 leaves the database plus its -wal and -shm sidecars in tmpdir,
// once per run per file. Nothing else cleans them up.
test.after(() => {
  globalThis.fetch = realFetch
  Date.now = realNow
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${databasePath}${suffix}`, { force: true })
})
