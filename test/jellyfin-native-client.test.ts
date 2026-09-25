import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const databasePath = join(tmpdir(), `fetcherr-native-client-${randomUUID()}.db`)
process.env.DATABASE_PATH = databasePath
// A fixed secret keeps the signed redirect deterministic instead of letting
// play-auth mint one and store it mid-test.
process.env.PLAYBACK_SIGNING_SECRET = 'native-client-test-secret'
// The rating gate resolves unknown ratings through TMDB and TVDB, and without
// keys both return early. Set before the dynamic imports, because config reads
// the environment once at module load.
process.env.TMDB_API_KEY = ''
process.env.TVDB_API_KEY = ''

const db = await import('../src/db.js')
const { jellyfinRoutes, resolveJellyfinUser } = await import('../src/jellyfin/index.js')

// The same item id jellyfin/index.ts derives for a movie: a v4-shaped uuid
// carrying the tmdb id in its low bits.
const itemIdForTmdb = (tmdbId: number) => `00000000-0000-4000-8000-${tmdbId.toString(16).padStart(12, '0')}`

const TMDB_ID = 278
const ITEM_ID = itemIdForTmdb(TMDB_ID)

// The first account created takes the default admin id, which is also the
// fallback user the stream route accepts for a matching play session. The
// second account is rating-limited below the movie, and that difference is how
// the tests below tell which of the two a request was attributed to.
const admin = db.createUser('admin', 'pw', 'admin', 'unrestricted')
const kid = db.createUser('kid', 'pw', 'user', '1')

db.upsertMovie({
  tmdbId: TMDB_ID,
  imdbId: 'tt0111161',
  mediaLanguage: 'en',
  title: 'The Shawshank Redemption',
  year: 1994,
  overview: '',
  posterPath: '',
  backdropPath: '',
  logoPath: '',
  genres: '[]',
  runtimeMins: 142,
  popularity: 0,
  officialRating: 'R',
  communityRating: 0,
  studiosJson: '[]',
  tagsJson: '[]',
  castJson: '[]',
  releaseDate: '1994-09-23',
  digitalReleaseDate: '1994-09-23',
  syncedAt: new Date().toISOString(),
})

// resolveJellyfinUser creates the jellyfin_tokens table on its first read, so
// this lookup of a token that cannot exist is what lets the inserts below have
// a table to target.
resolveJellyfinUser({ 'x-emby-token': 'no-such-token' })

function issueToken(userId: string): string {
  const token = randomUUID()
  db.getDb()
    .prepare(`INSERT INTO jellyfin_tokens (token, user_id, expires_at) VALUES (?, ?, ?)`)
    .run(token, userId, Date.now() + 3_600_000)
  return token
}

const adminToken = issueToken(admin.id)
const kidToken = issueToken(kid.id)

// The router options src/index.ts:38-43 builds. Without them these tests would
// measure a configuration that is not deployed.
const PRODUCTION_ROUTER_OPTIONS = {
  routerOptions: { ignoreTrailingSlash: true },
  rewriteUrl: (req: { url?: string }) => req.url!.replace(/\/\/+/g, '/').replace(/\.view(\?|$)/, '$1'),
}

async function buildApp() {
  const app = Fastify(PRODUCTION_ROUTER_OPTIONS as never)
  await app.register(jellyfinRoutes, {} as never)
  return app
}

// Every URL shape a native client builds for itself instead of following the
// MediaSource Path we hand it.
const NATIVE_STREAM_PATHS = [
  `/Videos/${ITEM_ID}/stream`,
  `/Videos/${ITEM_ID}/stream.mkv`,
  `/Videos/${ITEM_ID}/stream.avi`,
  `/Videos/${ITEM_ID}/stream.mp4`,
  `/Videos/${ITEM_ID}/original`,
  `/Videos/${ITEM_ID}/original.mkv`,
  `/videos/${ITEM_ID}/stream`,
  `/videos/${ITEM_ID}/stream.mkv`,
  `/videos/${ITEM_ID}/original`,
  `/videos/${ITEM_ID}/original.mkv`,
]

test('every native stream URL shape reaches the stream handler', async () => {
  const app = await buildApp()
  for (const path of NATIVE_STREAM_PATHS) {
    const res = await app.inject({ method: 'GET', url: path })
    assert.equal(res.statusCode, 401, `${path} should reach the handler`)
    assert.deepEqual(res.json(), { error: 'Unauthorized' }, path)
  }

  // The control that gives the assertions above their meaning: an unregistered
  // path answers from the router, not from the handler, so a 401 really does
  // say "this route exists" rather than "fastify replied something".
  const unregistered = await app.inject({ method: 'GET', url: `/Videos/${ITEM_ID}/streamz` })
  assert.equal(unregistered.statusCode, 404)
  assert.match(String(unregistered.json().message), /^Route GET:/)
  await app.close()
})

test('the access token is honoured under every spelling clients send', async () => {
  const app = await buildApp()
  // jellyfin-web sends api_key, Moonfin on webOS sends ApiKey, Emby-derived
  // players send X-Emby-Token.
  for (const key of ['api_key', 'ApiKey', 'X-Emby-Token', 'apikey']) {
    const res = await app.inject({
      method: 'GET',
      url: `/Videos/${ITEM_ID}/stream.mkv?${key}=${adminToken}`,
    })
    assert.equal(res.statusCode, 302, `${key} should authorize`)
    assert.match(res.headers.location as string, /\/play\/tt0111161\?/, key)
    assert.match(res.headers.location as string, /token=[0-9a-f]{64}/, key)
  }
  await app.close()
})

test('a query token decides the account, rather than the play-session fallback', async () => {
  const app = await buildApp()
  // A play session id that matches the item is what lets a tokenless native
  // client through, and it resolves to the admin fallback user.
  const fallbackOnly = await app.inject({
    method: 'GET',
    url: `/Videos/${ITEM_ID}/stream.mkv?playSessionId=fetcherr-${ITEM_ID}`,
  })
  assert.equal(fallbackOnly.statusCode, 302)

  // Same request, plus a rating-limited account's token spelled the way Moonfin
  // spells it. The token has to win: this account cannot see an R-rated movie,
  // so the answer is 404 rather than the fallback user's redirect. Reading only
  // api_key here attributed the play to the admin instead.
  const withKidToken = await app.inject({
    method: 'GET',
    url: `/Videos/${ITEM_ID}/stream.mkv?ApiKey=${kidToken}&playSessionId=fetcherr-${ITEM_ID}`,
  })
  assert.equal(withKidToken.statusCode, 404)
  await app.close()
})

test('Ancestors and GetUtcTime answer the probes native clients make', async () => {
  const app = await buildApp()
  // Fetcherr items are synthetic, so there is no ancestor chain to report, but
  // the route has to exist: Moonfin asks on every item open.
  const ancestors = await app.inject({ method: 'GET', url: `/Items/${ITEM_ID}/Ancestors` })
  assert.equal(ancestors.statusCode, 200)
  assert.deepEqual(ancestors.json(), [])

  const clock = await app.inject({ method: 'GET', url: '/GetUtcTime' })
  assert.equal(clock.statusCode, 200)
  const body = clock.json() as { RequestReceptionTime?: string; ResponseTransmissionTime?: string }
  for (const field of ['RequestReceptionTime', 'ResponseTransmissionTime'] as const) {
    assert.ok(body[field], `${field} missing`)
    assert.ok(Number.isFinite(Date.parse(body[field]!)), `${field} is not a timestamp`)
  }
  await app.close()
})
