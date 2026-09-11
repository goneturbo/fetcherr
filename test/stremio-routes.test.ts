import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const databasePath = join(tmpdir(), `fetcherr-routes-${randomUUID()}.db`)
process.env.DATABASE_PATH = databasePath
// No network from these tests. The rating gate resolves through TMDB and TVDB,
// and without keys both return early, which is also the production behaviour
// for a rating that cannot be established. Set before the dynamic imports
// below, because config reads them once at module load.
process.env.TMDB_API_KEY = ''
process.env.TVDB_API_KEY = ''
const db = await import('../src/db.js')
const { stremioAddonRoutes, redactStremioToken } = await import('../src/stremio-addon.js')

const hashA = 'a'.repeat(40)
const hashB = 'b'.repeat(40)

const friend = db.createUser('friend', 'pw', 'user', 'unrestricted')
db.setStremioEnabled(friend.id, true)
const token = db.mintStremioToken(friend.id)

const off = db.createUser('revoked', 'pw', 'user', 'unrestricted')
const offToken = db.mintStremioToken(off.id)

let resolvedWith: { streams: unknown[]; label: string } | null = null

// The router options src/index.ts:38-43 builds. Without them the tests measure a
// configuration that is not deployed: ignoreTrailingSlash alone turns a
// trailing-slash manifest from a catch-all 404 in a bare instance into a real 200
// in the server.
const PRODUCTION_ROUTER_OPTIONS = {
  routerOptions: { ignoreTrailingSlash: true },
  rewriteUrl: (req: { url?: string }) => req.url!.replace(/\/\/+/g, '/').replace(/\.view(\?|$)/, '$1'),
}

async function buildApp(overrides: Record<string, unknown> = {}) {
  const app = Fastify(PRODUCTION_ROUTER_OPTIONS as never)
  await app.register(stremioAddonRoutes, {
    fetchStreams: async () => [{ name: 'A', infoHash: hashA }, { name: 'B', infoHash: hashB }],
    resolvePlayback: async (streams: never, label: string) => {
      resolvedWith = { streams: streams as unknown[], label }
      return { url: 'https://cdn.torbox.test/file.mkv' }
    },
    fetchMeta: async () => ({ id: 'tt0111161', name: 'Shawshank' }),
    ...overrides,
  } as never)
  return app
}

test('serves the manifest for a valid token', async () => {
  const app = await buildApp()
  const res = await app.inject({ method: 'GET', url: `/stremio/${token}/manifest.json` })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json().resources, ['stream'])
  await app.close()
})

test('a bad token and a revoked account are indistinguishable', async () => {
  const app = await buildApp()
  const bad = await app.inject({ method: 'GET', url: '/stremio/nonsense/manifest.json' })
  const revoked = await app.inject({ method: 'GET', url: `/stremio/${offToken}/manifest.json` })
  assert.equal(bad.statusCode, 404)
  assert.equal(revoked.statusCode, 404)
  assert.deepEqual(bad.json(), revoked.json())
  await app.close()
})

test('returns mapped streams for a movie', async () => {
  const app = await buildApp()
  const res = await app.inject({ method: 'GET', url: `/stremio/${token}/stream/movie/tt0111161.json` })
  assert.equal(res.statusCode, 200)
  const streams = res.json().streams as Array<{ url: string }>
  assert.equal(streams.length, 2)
  assert.ok(streams[0].url.endsWith(`/stremio/${token}/play/movie/tt0111161/${hashA}`))
  await app.close()
})

test('an unsupported id yields a notice, not an empty list', async () => {
  const app = await buildApp()
  const res = await app.inject({ method: 'GET', url: `/stremio/${token}/stream/movie/kitsu:1.json` })
  assert.equal(res.statusCode, 200)
  const streams = res.json().streams as Array<{ description: string; url?: string }>
  assert.equal(streams.length, 1)
  assert.equal(streams[0].url, undefined)
  await app.close()
})

test('an empty provider response yields a notice, not an empty list', async () => {
  const app = await buildApp({ fetchStreams: async () => [] })
  const res = await app.inject({ method: 'GET', url: `/stremio/${token}/stream/movie/tt0111161.json` })
  const streams = res.json().streams as Array<{ description: string }>
  assert.equal(streams.length, 1)
  assert.match(streams[0].description, /no streams/i)
  await app.close()
})

test('a provider that throws yields a notice, not a 500', async () => {
  const app = await buildApp({ fetchStreams: async () => { throw new Error('boom') } })
  const res = await app.inject({ method: 'GET', url: `/stremio/${token}/stream/movie/tt0111161.json` })
  assert.equal(res.statusCode, 200)
  assert.equal((res.json().streams as unknown[]).length, 1)
  await app.close()
})

test('play redirects to the resolved CDN URL with the pin first', async () => {
  const app = await buildApp()
  const res = await app.inject({ method: 'GET', url: `/stremio/${token}/play/movie/tt0111161/${hashB}` })
  assert.equal(res.statusCode, 302)
  assert.equal(res.headers.location, 'https://cdn.torbox.test/file.mkv')
  assert.equal((resolvedWith?.streams[0] as { infoHash: string }).infoHash, hashB)
  assert.equal(db.countStremioPlaysToday(friend.id), 1)
  await app.close()
})

test('play refuses a malformed hash without calling the resolver', async () => {
  const app = await buildApp()
  resolvedWith = null
  const res = await app.inject({ method: 'GET', url: `/stremio/${token}/play/movie/tt0111161/not-a-hash` })
  assert.equal(res.statusCode, 404)
  assert.equal(resolvedWith, null)
  await app.close()
})

test('play stops at the cap and does not count the refusal', async () => {
  const capped = db.createUser('capped', 'pw', 'user', 'unrestricted')
  db.setStremioEnabled(capped.id, true)
  db.setStremioPlayCap(capped.id, 1)
  const cappedToken = db.mintStremioToken(capped.id)
  const app = await buildApp()
  // Two different titles: repeating one title is deliberately one slot now.
  const first = await app.inject({ method: 'GET', url: `/stremio/${cappedToken}/play/movie/tt0111161/${hashA}` })
  const second = await app.inject({ method: 'GET', url: `/stremio/${cappedToken}/play/movie/tt0903747/${hashA}` })
  assert.equal(first.statusCode, 302)
  assert.equal(second.statusCode, 429)
  assert.equal(db.countStremioPlaysToday(capped.id), 1)
  await app.close()
})

test('a rating-limited account gets a notice instead of streams', async () => {
  const kid = db.createUser('kid', 'pw', 'kids', '1')
  db.setStremioEnabled(kid.id, true)
  const kidToken = db.mintStremioToken(kid.id)
  const app = await buildApp()
  const res = await app.inject({ method: 'GET', url: `/stremio/${kidToken}/stream/movie/tt0111161.json` })
  const streams = res.json().streams as Array<{ description: string; url?: string }>
  assert.equal(streams.length, 1)
  assert.equal(streams[0].url, undefined)
  await app.close()
})

test('nothing outside the addon prefix is served by this plugin', async () => {
  const app = await buildApp()
  for (const url of ['/manifest.json', `/play/movie/tt0111161/${hashA}`, `/stremio/${token}/configure`]) {
    assert.equal((await app.inject({ method: 'GET', url })).statusCode, 404)
  }
  await app.close()
})

// ── The dispatch's corrections ───────────────────────────────────────────────

test('the stream route refuses a token whose account is revoked', async () => {
  const app = await buildApp()
  const bad = await app.inject({ method: 'GET', url: '/stremio/nonsense/stream/movie/tt0111161.json' })
  const revoked = await app.inject({ method: 'GET', url: `/stremio/${offToken}/stream/movie/tt0111161.json` })
  assert.equal(bad.statusCode, 404)
  assert.equal(revoked.statusCode, 404)
  assert.deepEqual(bad.json(), revoked.json())
  await app.close()
})

test('the play route refuses a bad token and a revoked account identically', async () => {
  const app = await buildApp()
  resolvedWith = null
  const bad = await app.inject({ method: 'GET', url: `/stremio/nonsense/play/movie/tt0111161/${hashA}` })
  const revoked = await app.inject({ method: 'GET', url: `/stremio/${offToken}/play/movie/tt0111161/${hashA}` })
  assert.equal(bad.statusCode, 404)
  assert.equal(revoked.statusCode, 404)
  assert.deepEqual(bad.json(), revoked.json())
  assert.equal(resolvedWith, null)
  await app.close()
})

test('an uppercase hash in the play path is canonicalized, not refused', async () => {
  let pinnedFirst: string | undefined
  const app = Fastify()
  await app.register(stremioAddonRoutes, {
    fetchStreams: async () => [{ name: 'A', infoHash: hashA }, { name: 'B', infoHash: hashB }],
    resolvePlayback: async (streams: Array<{ infoHash?: string }>) => {
      pinnedFirst = streams[0]?.infoHash
      return { url: 'https://cdn.torbox.test/file.mkv' }
    },
    fetchMeta: async () => null,
  } as never)
  const res = await app.inject({ method: 'GET', url: `/stremio/${token}/play/movie/tt0111161/${hashB.toUpperCase()}` })
  assert.equal(res.statusCode, 302)
  assert.equal(pinnedFirst, hashB)
  await app.close()
})

test('a pin that no longer resolves is logged, not served silently', async () => {
  const lines: string[] = []
  const app = Fastify({ logger: { level: 'warn', stream: { write: (line: string) => { lines.push(line) } } } })
  await app.register(stremioAddonRoutes, {
    fetchStreams: async () => [{ name: 'A', infoHash: hashA }],
    resolvePlayback: async () => ({ url: 'https://cdn.torbox.test/file.mkv' }),
    fetchMeta: async () => null,
  } as never)
  const gone = 'c'.repeat(40)
  const res = await app.inject({ method: 'GET', url: `/stremio/${token}/play/movie/tt0111161/${gone}` })
  assert.equal(res.statusCode, 302)
  const warning = lines.find(line => line.includes(gone))
  assert.ok(warning, `expected a warning naming the requested hash, got: ${lines.join('')}`)
  assert.ok(warning.includes(hashA), 'the warning must also name what is being played instead')
  await app.close()
})

test('no log line carries the raw token', async () => {
  const lines: string[] = []
  const app = Fastify({ ...PRODUCTION_ROUTER_OPTIONS, logger: { level: 'trace', stream: { write: (line: string) => { lines.push(line) } } } } as never)
  await app.register(stremioAddonRoutes, {
    fetchStreams: async () => [{ name: 'A', infoHash: hashA }],
    resolvePlayback: async () => ({ url: 'https://cdn.torbox.test/file.mkv', filename: 'a.mkv' }),
    fetchMeta: async () => null,
  } as never)
  for (const url of [
    `/stremio/${token}/manifest.json`,
    `/stremio/${token}/stream/movie/tt0111161.json`,
    `/stremio/${token}/play/movie/tt0111161/${hashA}`,
  ]) await app.inject({ method: 'GET', url })
  // Unmatched paths under the prefix are most of what a probing or misconfigured
  // client sends: /configure is what the containment test requests, and /meta/
  // is what a client tries when it has a manifest cached from another
  // configuration. Each of these used to log the token twice.
  for (const url of [
    `/stremio/${token}/configure`,
    `/stremio/${token}/meta/movie/tt0111161.json`,
    `/stremio/${token}/catalog/movie/top.json`,
    `/stremio/${token}/manifest.json/`,
  ]) await app.inject({ method: 'GET', url })
  await app.inject({ method: 'POST', url: `/stremio/${token}/manifest.json` })
  await app.close()
  const logged = lines.join('')
  assert.ok(lines.length > 0, 'expected the logger to have produced output')
  assert.ok(!logged.includes(token), `the raw token leaked into the logs: ${logged}`)
})

test('unmatched paths under the prefix answer like an invalid token', async () => {
  const app = await buildApp()
  const invalid = await app.inject({ method: 'GET', url: '/stremio/nonsense/manifest.json' })
  for (const url of [
    `/stremio/${token}/configure`,
    `/stremio/${token}/meta/movie/tt0111161.json`,
  ]) {
    const res = await app.inject({ method: 'GET', url })
    assert.equal(res.statusCode, 404)
    assert.deepEqual(res.json(), invalid.json())
  }
  const wrongMethod = await app.inject({ method: 'POST', url: `/stremio/${token}/manifest.json` })
  assert.equal(wrongMethod.statusCode, 404)
  assert.deepEqual(wrongMethod.json(), invalid.json())
  await app.close()
})

// Production sets ignoreTrailingSlash, so this is the real route rather than the
// catch-all: same token check, same silencing, same redaction. Pinned because a
// bare Fastify instance answers 404 here and the difference is easy to mistake
// for a bug in either direction.
test('a trailing slash reaches the manifest route, as it does in the server', async () => {
  const app = await buildApp()
  const res = await app.inject({ method: 'GET', url: `/stremio/${token}/manifest.json/` })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json().resources, ['stream'])
  const bad = await app.inject({ method: 'GET', url: '/stremio/nonsense/manifest.json/' })
  assert.equal(bad.statusCode, 404)
  await app.close()
})

test('the catch-all does not shadow the three real routes', async () => {
  const app = await buildApp()
  const manifest = await app.inject({ method: 'GET', url: `/stremio/${token}/manifest.json` })
  const stream = await app.inject({ method: 'GET', url: `/stremio/${token}/stream/movie/tt0111161.json` })
  const play = await app.inject({ method: 'GET', url: `/stremio/${token}/play/movie/tt0111161/${hashB}` })
  assert.equal(manifest.statusCode, 200)
  assert.deepEqual(manifest.json().resources, ['stream'])
  assert.equal(stream.statusCode, 200)
  assert.equal((stream.json().streams as unknown[]).length, 2)
  assert.equal(play.statusCode, 302)
  await app.close()
})

// ── Fix round 1, commit 1: the rating gate belongs on play too ───────────────
//
// The stream route's refusal is cosmetic if play does not enforce it: the URL
// is fully derivable from the account's own token, which the account holder
// necessarily has, and orderByPinnedHash's fallback means even a random hash
// plays the top candidate.

test('a rating-limited account gets no 302 from play, with a real or a random hash', async () => {
  const kid = db.createUser('kid-play', 'pw', 'kids', '1')
  db.setStremioEnabled(kid.id, true)
  const kidToken = db.mintStremioToken(kid.id)
  const app = await buildApp()

  const real = await app.inject({ method: 'GET', url: `/stremio/${kidToken}/play/movie/tt0111161/${hashA}` })
  const random = await app.inject({ method: 'GET', url: `/stremio/${kidToken}/play/movie/tt0111161/${'f'.repeat(40)}` })

  assert.equal(real.statusCode, 404)
  assert.equal(random.statusCode, 404)
  assert.equal(db.countStremioPlaysToday(kid.id), 0)
  await app.close()
})

test('a rating-limited account is refused when the meta lookup fails, not permitted', async () => {
  const kid = db.createUser('kid-meta', 'pw', 'kids', '1')
  db.setStremioEnabled(kid.id, true)
  const kidToken = db.mintStremioToken(kid.id)
  const app = await buildApp({ fetchMeta: async () => { throw new Error('tmdb down') } })
  const res = await app.inject({ method: 'GET', url: `/stremio/${kidToken}/play/movie/tt0111161/${hashA}` })
  assert.equal(res.statusCode, 404)
  assert.equal(db.countStremioPlaysToday(kid.id), 0)
  await app.close()
})

test('an unrestricted account still plays with the gate in place', async () => {
  const adult = db.createUser('adult-play', 'pw', 'user', 'unrestricted')
  db.setStremioEnabled(adult.id, true)
  const adultToken = db.mintStremioToken(adult.id)
  const app = await buildApp()
  const res = await app.inject({ method: 'GET', url: `/stremio/${adultToken}/play/movie/tt0111161/${hashA}` })
  assert.equal(res.statusCode, 302)
  assert.equal(db.countStremioPlaysToday(adult.id), 1)
  await app.close()
})

// ── Fix round 1, commit 2: the cap must hold under concurrency ───────────────
//
// better-sqlite3 is synchronous and node is single-threaded, so every request
// in a burst finished its count read before the first write landed. The window
// was the whole burst, which on a leaked token is the containment mechanism
// gone: N concurrent requests bought N debrid resolutions.

test('20 concurrent plays of different files against a cap of 1 yield exactly one 302', async () => {
  const burst = db.createUser('burst', 'pw', 'user', 'unrestricted')
  db.setStremioEnabled(burst.id, true)
  db.setStremioPlayCap(burst.id, 1)
  const burstToken = db.mintStremioToken(burst.id)
  const app = await buildApp()

  // Distinct files, which is the abuse shape: a leaked token firing N plays. A
  // burst of the same file is one viewing and is covered by the test below.
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) =>
    app.inject({ method: 'GET', url: `/stremio/${burstToken}/play/movie/tt0111161/${i.toString(16).padStart(40, '0')}` })))

  const redirects = results.filter(res => res.statusCode === 302)
  const refusals = results.filter(res => res.statusCode === 429)
  assert.equal(redirects.length, 1, `expected exactly one 302, got ${redirects.length}`)
  assert.equal(refusals.length, 19)
  assert.equal(db.countStremioPlaysToday(burst.id), 1)
  await app.close()
})

test('20 concurrent requests for the SAME file all succeed on one slot', async () => {
  const seeker = db.createUser('seeker', 'pw', 'user', 'unrestricted')
  db.setStremioEnabled(seeker.id, true)
  db.setStremioPlayCap(seeker.id, 1)
  const seekerToken = db.mintStremioToken(seeker.id)
  const app = await buildApp()

  const results = await Promise.all(Array.from({ length: 20 }, () =>
    app.inject({ method: 'GET', url: `/stremio/${seekerToken}/play/movie/tt0111161/${hashA}` })))

  assert.equal(results.filter(res => res.statusCode === 302).length, 20, 'range requests and seeks must not be refused')
  assert.equal(db.countStremioPlaysToday(seeker.id), 1)
  await app.close()
})

test('a resolver that throws leaves no play recorded', async () => {
  const flaky = db.createUser('flaky', 'pw', 'user', 'unrestricted')
  db.setStremioEnabled(flaky.id, true)
  const flakyToken = db.mintStremioToken(flaky.id)
  const app = await buildApp({ resolvePlayback: async () => { throw new Error('torbox down') } })
  const res = await app.inject({ method: 'GET', url: `/stremio/${flakyToken}/play/movie/tt0111161/${hashA}` })
  assert.equal(res.statusCode, 404)
  assert.equal(db.countStremioPlaysToday(flaky.id), 0)
  await app.close()
})

test('a released slot does not consume the cap', async () => {
  const retry = db.createUser('retry', 'pw', 'user', 'unrestricted')
  db.setStremioEnabled(retry.id, true)
  db.setStremioPlayCap(retry.id, 1)
  const retryToken = db.mintStremioToken(retry.id)

  const failing = await buildApp({ resolvePlayback: async () => { throw new Error('torbox down') } })
  assert.equal((await failing.inject({ method: 'GET', url: `/stremio/${retryToken}/play/movie/tt0111161/${hashA}` })).statusCode, 404)
  await failing.close()

  const working = await buildApp()
  assert.equal((await working.inject({ method: 'GET', url: `/stremio/${retryToken}/play/movie/tt0111161/${hashA}` })).statusCode, 302)
  assert.equal(db.countStremioPlaysToday(retry.id), 1)
  await working.close()
})

test("an admin's own cap column does not bind them", async () => {
  const boss = db.createUser('boss', 'pw', 'admin', 'unrestricted')
  db.setStremioEnabled(boss.id, true)
  db.setStremioPlayCap(boss.id, 1)
  const bossToken = db.mintStremioToken(boss.id)
  const app = await buildApp()
  // Three different titles against a stored cap of 1: admins use the role's own
  // cap, not the column, so all three play and all three are recorded.
  for (const imdbId of ['tt0111161', 'tt0903747', 'tt1375666']) {
    const res = await app.inject({ method: 'GET', url: `/stremio/${bossToken}/play/movie/${imdbId}/${hashA}` })
    assert.equal(res.statusCode, 302)
  }
  assert.equal(db.countStremioPlaysToday(boss.id), 3)
  await app.close()
})

// ── Fix round 1, commit 4: the cheap minors ─────────────────────────────────

test('a HEAD on the play route burns no cap slot and no resolution', async () => {
  const prober = db.createUser('prober', 'pw', 'user', 'unrestricted')
  db.setStremioEnabled(prober.id, true)
  db.setStremioPlayCap(prober.id, 1)
  const proberToken = db.mintStremioToken(prober.id)
  let resolverCalls = 0
  const app = Fastify()
  await app.register(stremioAddonRoutes, {
    fetchStreams: async () => [{ name: 'A', infoHash: hashA }],
    resolvePlayback: async () => { resolverCalls++; return { url: 'https://cdn.torbox.test/file.mkv' } },
    fetchMeta: async () => null,
  } as never)

  const head = await app.inject({ method: 'HEAD', url: `/stremio/${proberToken}/play/movie/tt0111161/${hashA}` })
  assert.notEqual(head.statusCode, 302)
  assert.equal(resolverCalls, 0)
  assert.equal(db.countStremioPlaysToday(prober.id), 0)

  // The quota the HEAD did not spend is still there for the real request.
  const get = await app.inject({ method: 'GET', url: `/stremio/${proberToken}/play/movie/tt0111161/${hashA}` })
  assert.equal(get.statusCode, 302)
  assert.equal(resolverCalls, 1)
  assert.equal(db.countStremioPlaysToday(prober.id), 1)
  await app.close()
})

test('a resolver that returns no url gets a 404, not a redirect to nowhere', async () => {
  const broken = db.createUser('broken-resolver', 'pw', 'user', 'unrestricted')
  db.setStremioEnabled(broken.id, true)
  const brokenToken = db.mintStremioToken(broken.id)
  const app = await buildApp({ resolvePlayback: async () => ({}) })
  const res = await app.inject({ method: 'GET', url: `/stremio/${brokenToken}/play/movie/tt0111161/${hashA}` })
  assert.equal(res.statusCode, 404)
  assert.equal(res.headers.location, undefined)
  assert.equal(db.countStremioPlaysToday(broken.id), 0)
  await app.close()
})

test('the play redirect is not cacheable, because it re-resolves at click time', async () => {
  const app = await buildApp()
  const res = await app.inject({ method: 'GET', url: `/stremio/${token}/play/movie/tt0111161/${hashA}` })
  assert.equal(res.statusCode, 302)
  assert.equal(res.headers['cache-control'], 'no-store')
  await app.close()
})

test('the manifest and stream responses allow cross-origin reads, for Stremio Web', async () => {
  const app = await buildApp()
  const manifest = await app.inject({ method: 'GET', url: `/stremio/${token}/manifest.json` })
  const stream = await app.inject({ method: 'GET', url: `/stremio/${token}/stream/movie/tt0111161.json` })
  const notice = await app.inject({ method: 'GET', url: `/stremio/${token}/stream/movie/kitsu:1.json` })
  assert.equal(manifest.headers['access-control-allow-origin'], '*')
  assert.equal(stream.headers['access-control-allow-origin'], '*')
  assert.equal(notice.headers['access-control-allow-origin'], '*')
  await app.close()
})

// ── Fix round 1, commit 2: redaction must not depend on the mount path ───────
//
// The redactor used to be anchored on the literal ^/stremio/, so it was correct
// only because src/index.ts happens to register the plugin without a prefix. A
// later refactor that added one would have written account tokens into the logs
// with nothing failing. This is the test that makes that class of mistake
// impossible, so it asserts both halves: the routes work under a prefix, and
// nothing logs the token there either.

test('under a fastify prefix the routes answer and the token is still redacted', async () => {
  const lines: string[] = []
  const app = Fastify({ ...PRODUCTION_ROUTER_OPTIONS, logger: { level: 'trace', stream: { write: (line: string) => { lines.push(line) } } } } as never)
  await app.register(stremioAddonRoutes, {
    prefix: '/addon',
    fetchStreams: async () => [{ name: 'A', infoHash: hashA }],
    resolvePlayback: async () => ({ url: 'https://cdn.torbox.test/file.mkv', filename: 'a.mkv' }),
    fetchMeta: async () => null,
  } as never)

  const manifest = await app.inject({ method: 'GET', url: `/addon/stremio/${token}/manifest.json` })
  const stream = await app.inject({ method: 'GET', url: `/addon/stremio/${token}/stream/movie/tt0111161.json` })
  const play = await app.inject({ method: 'GET', url: `/addon/stremio/${token}/play/movie/tt0111161/${hashA}` })
  assert.equal(manifest.statusCode, 200, 'the manifest must answer under the prefix')
  assert.deepEqual(manifest.json().resources, ['stream'])
  assert.equal(stream.statusCode, 200)
  assert.equal(play.statusCode, 302)

  // Unmatched paths under the prefixed mount too.
  for (const url of [
    `/addon/stremio/${token}/configure`,
    `/addon/stremio/${token}/meta/movie/tt0111161.json`,
  ]) {
    const res = await app.inject({ method: 'GET', url })
    assert.equal(res.statusCode, 404)
    assert.deepEqual(res.json(), { error: 'Not found' })
  }
  // And the trailing-slash manifest, which ignoreTrailingSlash routes to the real
  // handler under the prefix as well.
  assert.equal((await app.inject({ method: 'GET', url: `/addon/stremio/${token}/manifest.json/` })).statusCode, 200)
  await app.close()

  const logged = lines.join('')
  assert.ok(lines.length > 0, 'expected the logger to have produced output')
  assert.ok(!logged.includes(token), `the raw token leaked under a prefix: ${logged}`)
  assert.ok(logged.includes('/addon/stremio/'), 'the redacted line should still show the mount path')
})

test('the redactor covers a prefixed path and leaves unrelated URLs alone', () => {
  const raw = 'A'.repeat(43)
  assert.equal(redactStremioToken(`/stremio/${raw}/manifest.json`), '/stremio/AAAAAA~/manifest.json')
  assert.equal(redactStremioToken(`/addon/stremio/${raw}/manifest.json`, '/addon'), '/addon/stremio/AAAAAA~/manifest.json')
  assert.equal(redactStremioToken(`/addon/stremio/${raw}/play/movie/tt0111161/${hashA}`, '/addon'), `/addon/stremio/AAAAAA~/play/movie/tt0111161/${hashA}`)
  assert.equal(redactStremioToken(`/stremio/${raw}?x=1`), '/stremio/AAAAAA~?x=1')
  assert.equal(redactStremioToken('/ui/settings'), '/ui/settings')
  // A prefixed URL with no mount path given must not be silently passed through
  // as if it held nothing sensitive.
  assert.equal(redactStremioToken(`/addon/stremio/${raw}/manifest.json`), `/addon/stremio/${raw}/manifest.json`)
})

// ── Final wave, commit 1: a slot is a title, not an HTTP request ─────────────
//
// Cache-Control: no-store on the 302 exists so a client cannot pin an expiring
// CDN URL, which means an obedient client re-enters the play route on every range
// request, seek and reconnect. Reserving a fresh row per GET turned that into
// "Daily play limit reached" mid-film, arriving as a dead stream rather than a
// readable notice.

async function countingApp(overrides: Record<string, unknown> = {}) {
  const cacheKeys: string[] = []
  const app = Fastify(PRODUCTION_ROUTER_OPTIONS as never)
  await app.register(stremioAddonRoutes, {
    fetchStreams: async () => [{ name: 'A', infoHash: hashA }, { name: 'B', infoHash: hashB }],
    resolvePlayback: async (_streams: never, _label: string, cacheKey: string) => {
      cacheKeys.push(cacheKey)
      return { url: 'https://cdn.torbox.test/file.mkv' }
    },
    fetchMeta: async () => null,
    ...overrides,
  } as never)
  return { app, cacheKeys }
}

function playbackUser(name: string, cap = 30) {
  const user = db.createUser(name, 'pw', 'user', 'unrestricted')
  db.setStremioEnabled(user.id, true)
  db.setStremioPlayCap(user.id, cap)
  return { user, token: db.mintStremioToken(user.id) }
}

test('five identical play requests cost one slot and reuse one cache key', async () => {
  const { user, token: tok } = playbackUser('rewatcher')
  const { app, cacheKeys } = await countingApp()
  const statuses: number[] = []
  for (let i = 0; i < 5; i++) {
    statuses.push((await app.inject({ method: 'GET', url: `/stremio/${tok}/play/movie/tt0111161/${hashA}` })).statusCode)
  }
  assert.deepEqual(statuses, [302, 302, 302, 302, 302])
  assert.equal(db.countStremioPlaysToday(user.id), 1, 'five GETs of one file must be one play')
  // The dedup of the resolution itself lives in src/index.ts's wrapper, which
  // feeds this cacheKey to getOrCreatePlaybackResolution. What the plugin owes it
  // is a key that is stable across repeats, which is what this pins.
  assert.equal(cacheKeys.length, 5)
  assert.equal(new Set(cacheKeys).size, 1, `expected one stable cache key, got ${JSON.stringify([...new Set(cacheKeys)])}`)
  assert.equal(cacheKeys[0], '/stremio/play/movie/tt0111161')
  await app.close()
})

test('two different titles are two slots', async () => {
  const { user, token: tok } = playbackUser('two-titles')
  const { app } = await countingApp()
  await app.inject({ method: 'GET', url: `/stremio/${tok}/play/movie/tt0111161/${hashA}` })
  await app.inject({ method: 'GET', url: `/stremio/${tok}/play/movie/tt0903747/${hashA}` })
  assert.equal(db.countStremioPlaysToday(user.id), 2)
  await app.close()
})

test('a different infohash for the same title is a second slot, being a different file', async () => {
  const { user, token: tok } = playbackUser('two-files')
  const { app } = await countingApp()
  await app.inject({ method: 'GET', url: `/stremio/${tok}/play/movie/tt0111161/${hashA}` })
  await app.inject({ method: 'GET', url: `/stremio/${tok}/play/movie/tt0111161/${hashB}` })
  assert.equal(db.countStremioPlaysToday(user.id), 2)
  await app.close()
})

test('a repeat still costs a slot once the cap is full of other titles', async () => {
  const { user, token: tok } = playbackUser('boundary', 2)
  const { app } = await countingApp()
  assert.equal((await app.inject({ method: 'GET', url: `/stremio/${tok}/play/movie/tt0111161/${hashA}` })).statusCode, 302)
  assert.equal((await app.inject({ method: 'GET', url: `/stremio/${tok}/play/movie/tt0903747/${hashA}` })).statusCode, 302)
  // Third distinct title is refused, but re-watching either of the first two is not.
  assert.equal((await app.inject({ method: 'GET', url: `/stremio/${tok}/play/movie/tt1375666/${hashA}` })).statusCode, 429)
  assert.equal((await app.inject({ method: 'GET', url: `/stremio/${tok}/play/movie/tt0111161/${hashA}` })).statusCode, 302)
  assert.equal(db.countStremioPlaysToday(user.id), 2)
  await app.close()
})

// ── Final wave, commit 3: admins get a finite cap too ───────────────────────
//
// The spec exempted admin. The owner's own install URL is the one pasted into a
// chat while showing someone how to install it, screenshotted during setup, and
// installed on the most devices, so two of the three brakes apply to it and the
// sharpest one did not.

test('an admin play is reserved and recorded like anyone else', async () => {
  const boss = db.createUser('finite-admin', 'pw', 'admin', 'unrestricted')
  db.setStremioEnabled(boss.id, true)
  const bossToken = db.mintStremioToken(boss.id)
  const app = await buildApp()
  assert.equal((await app.inject({ method: 'GET', url: `/stremio/${bossToken}/play/movie/tt0111161/${hashA}` })).statusCode, 302)
  assert.equal(db.countStremioPlaysToday(boss.id), 1)
  // And a repeat is one slot for an admin as well.
  await app.inject({ method: 'GET', url: `/stremio/${bossToken}/play/movie/tt0111161/${hashA}` })
  assert.equal(db.countStremioPlaysToday(boss.id), 1)
  await app.close()
})

test('an admin at the 200 cap is refused', async () => {
  const boss = db.createUser('busy-admin', 'pw', 'admin', 'unrestricted')
  db.setStremioEnabled(boss.id, true)
  const bossToken = db.mintStremioToken(boss.id)
  // Fill the day to the admin cap directly; 200 requests through the route would
  // be slow and would prove nothing extra.
  const insert = db.getDb().prepare(`
    INSERT INTO stremio_plays (user_id, played_on, media_type, external_id, info_hash, title)
    VALUES (?, strftime('%Y-%m-%d','now','localtime'), 'movie', 'tt0111161', ?, 'filler')
  `)
  for (let i = 0; i < 200; i++) insert.run(boss.id, i.toString(16).padStart(40, '0'))
  assert.equal(db.countStremioPlaysToday(boss.id), 200)

  const app = await buildApp()
  const res = await app.inject({ method: 'GET', url: `/stremio/${bossToken}/play/movie/tt0903747/${hashB}` })
  assert.equal(res.statusCode, 429, 'an admin is bounded too')
  assert.equal(db.countStremioPlaysToday(boss.id), 200, 'and the refusal is not counted')
  // A file already played today still works, because that row exists.
  const repeat = await app.inject({ method: 'GET', url: `/stremio/${bossToken}/play/movie/tt0111161/${'0'.repeat(40)}` })
  assert.equal(repeat.statusCode, 302)
  await app.close()
})

// better-sqlite3 leaves the database plus its -wal and -shm sidecars in tmpdir,
// once per run per file. Nothing else cleans them up.
test.after(() => {
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${databasePath}${suffix}`, { force: true })
})

// ── Leftovers, commit 2: no play may go uncounted ────────────────────────────
//
// Two requests for one file: the first creates the row, the second reads it as
// created:false. If the first then fails and releases the row, the second's
// finalize updates nothing and it returns 302 with zero counted plays. Before the
// slot-reuse change this could not happen, because every request held its own row.

test('a released shared row still leaves the succeeding request counted', async () => {
  const { user, token: tok } = playbackUser('racer')
  let gate: (() => void) | null = null
  const opened = new Promise<void>(resolve => { gate = resolve })
  let call = 0
  const app = Fastify(PRODUCTION_ROUTER_OPTIONS as never)
  await app.register(stremioAddonRoutes, {
    fetchStreams: async () => [{ name: 'A', infoHash: hashA }],
    resolvePlayback: async () => {
      call += 1
      if (call === 1) {
        // The failing request: hold until the second has reserved, so it really
        // does observe created:false, then flake.
        await opened
        throw new Error('provider flake')
      }
      return { url: 'https://cdn.torbox.test/file.mkv', filename: 'a.mkv' }
    },
    fetchMeta: async () => null,
  } as never)

  const failing = app.inject({ method: 'GET', url: `/stremio/${tok}/play/movie/tt0111161/${hashA}` })
  // Let the first request reserve and reach the resolver before the second starts.
  await new Promise(resolve => setTimeout(resolve, 10))
  const secondStarted = app.inject({ method: 'GET', url: `/stremio/${tok}/play/movie/tt0111161/${hashA}` })
  await new Promise(resolve => setTimeout(resolve, 10))
  gate!()

  const [first, second] = await Promise.all([failing, secondStarted])
  assert.equal(first.statusCode, 404, 'the flaking request fails')
  assert.equal(second.statusCode, 302, 'the good one still plays')
  assert.equal(db.countStremioPlaysToday(user.id), 1, 'and the play it served must be counted')
  await app.close()
})

test('twelve concurrent first-time requests for one title produce one row', async () => {
  const { user, token: tok } = playbackUser('twelve')
  const { app } = await countingApp()
  const results = await Promise.all(Array.from({ length: 12 }, () =>
    app.inject({ method: 'GET', url: `/stremio/${tok}/play/movie/tt0111161/${hashA}` })))
  assert.equal(results.filter(res => res.statusCode === 302).length, 12)
  assert.equal(db.countStremioPlaysToday(user.id), 1)
  await app.close()
})
