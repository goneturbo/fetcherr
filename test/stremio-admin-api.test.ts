import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const databasePath = join(tmpdir(), `fetcherr-admin-api-${randomUUID()}.db`)
process.env.DATABASE_PATH = databasePath
// No network: the settings payload touches nothing remote, but config reads keys
// once at load and an unset key is what keeps the rating lookups offline.
process.env.TMDB_API_KEY = ''
process.env.TVDB_API_KEY = ''
// An install URL is for another person's device, so it must name the configured
// public host rather than whatever Host the admin's browser happened to send.
process.env.SERVER_URL = 'https://streaming.example.net'
const db = await import('../src/db.js')
const { uiRoutes } = await import('../src/ui/routes.js')
// The session is established through production code, the same call the login
// route makes, so no test-only backdoor is added to src/.
const { createSession } = await import('../src/ui/auth.js')

const admin = db.createUser('admin', 'pw', 'admin', 'unrestricted')
const plainUser = db.createUser('plain', 'pw', 'user', 'unrestricted')
const friend = db.createUser('friend', 'pw', 'user', 'unrestricted')

const adminHeaders = { cookie: `infuse_session=${createSession(admin.id)}` }
const userHeaders = { cookie: `infuse_session=${createSession(plainUser.id)}` }

async function buildApp() {
  const app = Fastify()
  await app.register(uiRoutes)
  return app
}

const post = (app: Awaited<ReturnType<typeof buildApp>>, id: string, payload: unknown, headers = adminHeaders) =>
  app.inject({ method: 'POST', url: `/api/users/${id}/stremio`, headers, payload: payload as never })

const tokenFromUrl = (installUrl: string) => installUrl.split('/stremio/')[1].replace('/manifest.json', '')

test('mint returns an install URL under the addon prefix', async () => {
  const app = await buildApp()
  const res = await post(app, friend.id, { action: 'mint' })
  assert.equal(res.statusCode, 200)
  assert.match(res.json().installUrl, new RegExp(`/stremio/[A-Za-z0-9_-]{43}/manifest\\.json$`))
  assert.equal(res.json().stremioEnabled, true)
  await app.close()
})

test('rotate replaces the install URL and invalidates the old one', async () => {
  const app = await buildApp()
  const first = await post(app, friend.id, { action: 'mint' })
  const second = await post(app, friend.id, { action: 'rotate' })
  assert.notEqual(first.json().installUrl, second.json().installUrl)
  // Resolved through the lookup, not just compared as strings: a URL that
  // differs but still resolves would leave the leaked one live.
  assert.equal(db.getUserByStremioToken(tokenFromUrl(first.json().installUrl)), null)
  assert.equal(db.getUserByStremioToken(tokenFromUrl(second.json().installUrl))?.id, friend.id)
  await app.close()
})

test('clear revokes both the token and the flag', async () => {
  const app = await buildApp()
  await post(app, friend.id, { action: 'mint' })
  const res = await post(app, friend.id, { action: 'clear' })
  assert.equal(res.json().installUrl, '')
  assert.equal(res.json().stremioEnabled, false)
  assert.equal(db.getUserById(friend.id)!.stremioToken, '')
  assert.equal(db.getUserById(friend.id)!.stremioEnabled, false)
  await app.close()
})

test('disable keeps the token but blocks access', async () => {
  const app = await buildApp()
  const minted = await post(app, friend.id, { action: 'mint' })
  const token = tokenFromUrl(minted.json().installUrl)
  await post(app, friend.id, { action: 'disable' })
  assert.equal(db.getUserById(friend.id)!.stremioToken, token)
  assert.equal(db.getUserById(friend.id)!.stremioEnabled, false)
  await app.close()
})

test('enable turns access back on without minting a new token', async () => {
  const app = await buildApp()
  const minted = await post(app, friend.id, { action: 'mint' })
  const token = tokenFromUrl(minted.json().installUrl)
  await post(app, friend.id, { action: 'disable' })
  const res = await post(app, friend.id, { action: 'enable' })
  assert.equal(res.json().stremioEnabled, true)
  assert.equal(tokenFromUrl(res.json().installUrl), token)
  await app.close()
})

test('a cap sent with an action is applied', async () => {
  const app = await buildApp()
  const res = await post(app, friend.id, { action: 'enable', cap: 7 })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().stremioPlayCap, 7)
  assert.equal(db.getUserById(friend.id)!.stremioPlayCap, 7)
  await app.close()
})

test('a cap of zero is accepted, since it means no plays', async () => {
  const app = await buildApp()
  const res = await post(app, friend.id, { action: 'enable', cap: 0 })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().stremioPlayCap, 0)
  await app.close()
})

// setStremioPlayCap silently substitutes 30 for a bad value, so a typo would
// quietly reset a friend's cap to the default. The route rejects instead. The type
// guard covers non-finite values too: NaN and Infinity are not integers, and both
// JSON-serialize to null, which the null case below already stands for.
test('an invalid cap is refused and leaves the stored cap unchanged', async () => {
  const app = await buildApp()
  const capped = db.createUser('cap-victim', 'pw', 'user', 'unrestricted')
  await post(app, capped.id, { action: 'enable', cap: 5 })

  for (const cap of [-1, 1001, 7.5, '7', null, {}]) {
    const res = await post(app, capped.id, { action: 'enable', cap })
    assert.equal(res.statusCode, 400, `cap ${JSON.stringify(cap)} should be refused`)
    assert.match(res.json().error, /cap/i)
    assert.equal(db.getUserById(capped.id)!.stremioPlayCap, 5, `cap ${JSON.stringify(cap)} changed the stored value`)
  }
  await app.close()
})

test('an invalid cap does not mint a token either', async () => {
  const app = await buildApp()
  const untouched = db.createUser('cap-and-mint', 'pw', 'user', 'unrestricted')
  const res = await post(app, untouched.id, { action: 'mint', cap: -5 })
  assert.equal(res.statusCode, 400)
  assert.equal(db.getUserById(untouched.id)!.stremioToken, '')
  assert.equal(db.getUserById(untouched.id)!.stremioEnabled, false)
  await app.close()
})

test('an unknown action is rejected', async () => {
  const app = await buildApp()
  const res = await post(app, friend.id, { action: 'drop-table' })
  assert.equal(res.statusCode, 400)
  await app.close()
})

test('a missing action is rejected rather than defaulting to something', async () => {
  const app = await buildApp()
  assert.equal((await post(app, friend.id, {})).statusCode, 400)
  assert.equal((await post(app, friend.id, { action: 42 })).statusCode, 400)
  await app.close()
})

// mintStremioToken's UPDATE matches no rows for an unknown id and still returns
// a token, so this check is what stops a live-looking credential that resolves
// to nobody.
test('an unknown user id 404s and mints nothing', async () => {
  const app = await buildApp()
  const before = db.getDb().prepare(`SELECT COUNT(*) AS n FROM app_users WHERE stremio_token <> ''`).get() as { n: number }
  const res = await post(app, randomUUID(), { action: 'mint' })
  assert.equal(res.statusCode, 404)
  const after = db.getDb().prepare(`SELECT COUNT(*) AS n FROM app_users WHERE stremio_token <> ''`).get() as { n: number }
  assert.equal(after.n, before.n)
  await app.close()
})

test('a non-admin session is refused and changes nothing', async () => {
  const app = await buildApp()
  const target = db.createUser('untouchable', 'pw', 'user', 'unrestricted')
  const res = await post(app, target.id, { action: 'mint' }, userHeaders)
  assert.equal(res.statusCode, 403)
  assert.equal(db.getUserById(target.id)!.stremioToken, '')
  assert.equal(db.getUserById(target.id)!.stremioEnabled, false)
  await app.close()
})

// The sharper half: refusing to mint for a bare account proves little, since there
// was nothing to take. A non-admin must also be unable to break or steal access
// that already exists.
test('a non-admin cannot clear or rotate an account that already has a token', async () => {
  const app = await buildApp()
  const victim = db.createUser('has-access', 'pw', 'user', 'unrestricted')
  const minted = await post(app, victim.id, { action: 'mint' })
  const token = tokenFromUrl(minted.json().installUrl)

  for (const action of ['clear', 'rotate', 'disable', 'enable']) {
    const res = await post(app, victim.id, { action, cap: 1 }, userHeaders)
    assert.equal(res.statusCode, 403, `${action} must be refused`)
    assert.equal(db.getUserById(victim.id)!.stremioToken, token, `${action} must not change the token`)
    assert.equal(db.getUserById(victim.id)!.stremioEnabled, true, `${action} must not change access`)
    assert.equal(db.getUserById(victim.id)!.stremioPlayCap, 30, `${action} must not change the cap`)
  }
  // The token still resolves, so nothing was quietly rotated underneath.
  assert.equal(db.getUserByStremioToken(token)?.id, victim.id)
  await app.close()
})

test('the credential-bearing response is not cacheable', async () => {
  const app = await buildApp()
  const res = await post(app, friend.id, { action: 'mint' })
  assert.equal(res.headers['cache-control'], 'no-store')
  await app.close()
})

test('no session at all is refused', async () => {
  const app = await buildApp()
  const target = db.createUser('no-session', 'pw', 'user', 'unrestricted')
  const res = await post(app, target.id, { action: 'mint' }, {} as never)
  assert.equal(res.statusCode, 401)
  assert.equal(db.getUserById(target.id)!.stremioToken, '')
  await app.close()
})

test('the users payload carries the addon fields but never a raw token field', async () => {
  const app = await buildApp()
  const listed = db.createUser('listed', 'pw', 'user', 'unrestricted')
  const minted = await post(app, listed.id, { action: 'mint', cap: 12 })
  const token = tokenFromUrl(minted.json().installUrl)

  const res = await app.inject({ method: 'GET', url: '/ui/settings-data', headers: adminHeaders })
  assert.equal(res.statusCode, 200)
  const entry = (res.json().users as Array<Record<string, unknown>>).find(u => u.id === listed.id)!
  assert.equal(entry.stremioEnabled, true)
  assert.equal(entry.stremioPlayCap, 12)
  assert.match(String(entry.installUrl), new RegExp(`/stremio/${token}/manifest\\.json$`))
  // The token rides inside installUrl and nowhere else: no field may hold it bare.
  assert.equal(entry.stremioToken, undefined)
  for (const [key, value] of Object.entries(entry)) {
    if (key === 'installUrl') continue
    assert.notEqual(value, token, `field ${key} exposes the raw token`)
  }
  await app.close()
})

test('an account with no token lists an empty install URL', async () => {
  const app = await buildApp()
  const bare = db.createUser('bare', 'pw', 'user', 'unrestricted')
  const res = await app.inject({ method: 'GET', url: '/ui/settings-data', headers: adminHeaders })
  const entry = (res.json().users as Array<Record<string, unknown>>).find(u => u.id === bare.id)!
  assert.equal(entry.installUrl, '')
  assert.equal(entry.stremioEnabled, false)
  await app.close()
})

test('the payload reports the effective cap, so an admin row cannot claim the wrong one', async () => {
  const app = await buildApp()
  const res = await app.inject({ method: 'GET', url: '/ui/settings-data', headers: adminHeaders })
  const users = res.json().users as Array<Record<string, unknown>>
  const adminEntry = users.find(u => u.role === 'admin')!
  // playCapFor overrides an admin's stored column, so the payload must carry the
  // number actually enforced rather than leaving the UI to recompute the policy.
  assert.equal(adminEntry.stremioPlayCap, 200)
  assert.notEqual(db.getUserById(String(adminEntry.id))!.stremioPlayCap, 200)
  await app.close()
})

test('a stored LAN Server URL cannot leak into an install URL', async () => {
  const app = await buildApp()
  const { config } = await import('../src/config.js')
  const original = config.serverUrl
  // This is the live deployment's actual state: the stored setting overrides the
  // env at boot and pointed at the LAN address, which is how a broken link got
  // handed out in the first place.
  config.serverUrl = 'http://192.168.87.33:9990'
  try {
    const res = await app.inject({
      method: 'POST', url: `/api/users/${friend.id}/stremio`, headers: adminHeaders, payload: { action: 'mint' },
    })
    assert.equal(res.statusCode, 200)
    assert.match(String(res.json().installUrl), /^https:\/\/streaming\.example\.net\/stremio\//)
  } finally {
    config.serverUrl = original
  }
  await app.close()
})

test('the install URL names the configured public host, not the requesting one', async () => {
  const app = await buildApp()
  const minted = await app.inject({
    method: 'POST', url: `/api/users/${friend.id}/stremio`, headers: adminHeaders, payload: { action: 'mint' },
  })
  assert.equal(minted.statusCode, 200)
  // The admin browses over the LAN address; the person receiving the link cannot.
  const overLan = await app.inject({
    method: 'GET', url: '/ui/settings-data', headers: { ...adminHeaders, host: '192.168.87.33:9990' },
  })
  const entry = (overLan.json().users as Array<Record<string, unknown>>).find(u => u.id === friend.id)!
  assert.match(String(entry.installUrl), /^https:\/\/streaming\.example\.net\/stremio\//)
  assert.equal(String(minted.json().installUrl).startsWith('https://streaming.example.net/'), true)
  await app.close()
})

// better-sqlite3 leaves the database plus its -wal and -shm sidecars in tmpdir,
// once per run per file. Nothing else cleans them up.
test.after(() => {
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${databasePath}${suffix}`, { force: true })
})
