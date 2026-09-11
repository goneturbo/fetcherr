import test from 'node:test'
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const databasePath = join(tmpdir(), `fetcherr-stremio-${randomUUID()}.db`)
process.env.DATABASE_PATH = databasePath
const db = await import('../src/db.js')

const user = db.createUser('friend', 'pw', 'user', 'unrestricted')

test('a fresh user has no token and no access', () => {
  assert.equal(user.stremioToken, '')
  assert.equal(user.stremioEnabled, false)
  assert.equal(user.stremioPlayCap, 30)
})

test('minting returns a base64url token that resolves back to the user', () => {
  const token = db.mintStremioToken(user.id)
  assert.match(token, /^[A-Za-z0-9_-]{43}$/)
  assert.equal(db.getUserByStremioToken(token)?.id, user.id)
})

test('rotating invalidates the previous token', () => {
  const first = db.mintStremioToken(user.id)
  const second = db.mintStremioToken(user.id)
  assert.notEqual(first, second)
  assert.equal(db.getUserByStremioToken(first), null)
  assert.equal(db.getUserByStremioToken(second)?.id, user.id)
})

test('clearing removes the token without deleting the user', () => {
  const token = db.mintStremioToken(user.id)
  db.clearStremioToken(user.id)
  assert.equal(db.getUserByStremioToken(token), null)
  assert.equal(db.getUserById(user.id)?.stremioToken, '')
})

test('an empty token never resolves to a user', () => {
  assert.equal(db.getUserByStremioToken(''), null)
})

test('two users with no token do not collide', () => {
  const other = db.createUser('friend2', 'pw', 'user', 'unrestricted')
  assert.equal(other.stremioToken, '')
  assert.equal(db.getUserById(user.id)?.stremioToken, '')
})

test('enabled and cap round-trip', () => {
  db.setStremioEnabled(user.id, true)
  db.setStremioPlayCap(user.id, 5)
  const fresh = db.getUserById(user.id)!
  assert.equal(fresh.stremioEnabled, true)
  assert.equal(fresh.stremioPlayCap, 5)
})

test('plays are counted per user per day', () => {
  assert.equal(db.countStremioPlaysToday(user.id), 0)
  // Two distinct files, because reserving is the only way to write a play now and
  // a repeat of one file deliberately reuses its row.
  for (const infoHash of ['b'.repeat(40), 'c'.repeat(40)]) {
    const reservation = db.reserveStremioPlay({ userId: user.id, mediaType: 'movie', externalId: 'tt0111161', infoHash, cap: 30 })
    db.finalizeStremioPlay(reservation!.id, 'Shawshank 1080p')
  }
  assert.equal(db.countStremioPlaysToday(user.id), 2)
  const other = db.getUserByUsername('friend2')!
  assert.equal(db.countStremioPlaysToday(other.id), 0)
})

// Reserving counts the slot in the same statement that checks the cap, so a
// burst cannot read the count before the first write lands.

const play = (userId: string, overrides: Partial<{ mediaType: string; externalId: string; infoHash: string; cap: number }> = {}) => ({
  userId, mediaType: 'movie', externalId: 'tt0111161', infoHash: 'c'.repeat(40), cap: 2, ...overrides,
})

test('reserving stops at the cap and returns null', () => {
  const u = db.createUser('reserver', 'pw', 'user', 'unrestricted')
  // Distinct files, since a repeat of the same file reuses its row by design.
  assert.equal(db.reserveStremioPlay(play(u.id, { infoHash: 'a'.repeat(40) }))?.created, true)
  assert.equal(db.reserveStremioPlay(play(u.id, { infoHash: 'b'.repeat(40) }))?.created, true)
  assert.equal(db.reserveStremioPlay(play(u.id, { infoHash: 'c'.repeat(40) })), null)
  assert.equal(db.countStremioPlaysToday(u.id), 2)
})

// A slot is a title, not a request: the play redirect is no-store, so a client
// comes back on every range request and seek.
test('a repeat of the same file today reuses its row instead of taking a slot', () => {
  const u = db.createUser('rewatch', 'pw', 'user', 'unrestricted')
  const first = db.reserveStremioPlay(play(u.id, { cap: 1 }))
  assert.equal(first?.created, true)
  for (let i = 0; i < 4; i++) {
    const again = db.reserveStremioPlay(play(u.id, { cap: 1 }))
    assert.equal(again?.id, first!.id, 'the same file must map to the same row')
    assert.equal(again?.created, false, 'and must not report itself as newly created')
  }
  assert.equal(db.countStremioPlaysToday(u.id), 1)
})

test('a different file for the same title is a separate slot', () => {
  const u = db.createUser('twofiles', 'pw', 'user', 'unrestricted')
  const a = db.reserveStremioPlay(play(u.id, { infoHash: 'a'.repeat(40) }))
  const b = db.reserveStremioPlay(play(u.id, { infoHash: 'b'.repeat(40) }))
  assert.notEqual(a!.id, b!.id)
  assert.equal(b?.created, true)
  assert.equal(db.countStremioPlaysToday(u.id), 2)
})

test('another account is not affected by a reservation', () => {
  const mine = db.createUser('mine', 'pw', 'user', 'unrestricted')
  const theirs = db.createUser('theirs', 'pw', 'user', 'unrestricted')
  db.reserveStremioPlay(play(mine.id, { cap: 1 }))
  assert.equal(db.reserveStremioPlay(play(theirs.id, { cap: 1 }))?.created, true)
  assert.equal(db.countStremioPlaysToday(mine.id), 1)
  assert.equal(db.countStremioPlaysToday(theirs.id), 1)
})

test("yesterday's row does not satisfy today's reservation", () => {
  const u = db.createUser('yesterday', 'pw', 'user', 'unrestricted')
  const hash = 'd'.repeat(40)
  db.getDb().prepare(`
    INSERT INTO stremio_plays (user_id, played_on, media_type, external_id, info_hash, title)
    VALUES (?, strftime('%Y-%m-%d','now','localtime','-1 day'), 'movie', 'tt0111161', ?, 'old')
  `).run(u.id, hash)
  assert.equal(db.countStremioPlaysToday(u.id), 0, "yesterday's play must not count today")
  const reservation = db.reserveStremioPlay(play(u.id, { infoHash: hash, cap: 1 }))
  assert.equal(reservation?.created, true, 'today needs its own row')
  assert.equal(db.countStremioPlaysToday(u.id), 1)
})

test('a released reservation frees the slot again', () => {
  const u = db.createUser('releaser', 'pw', 'user', 'unrestricted')
  const reservation = db.reserveStremioPlay(play(u.id, { infoHash: 'e'.repeat(40), cap: 1 }))
  assert.notEqual(reservation, null)
  assert.equal(db.reserveStremioPlay(play(u.id, { infoHash: 'f'.repeat(40), cap: 1 })), null)
  db.releaseStremioPlay(reservation!.id)
  assert.equal(db.countStremioPlaysToday(u.id), 0)
  assert.equal(db.reserveStremioPlay(play(u.id, { infoHash: 'f'.repeat(40), cap: 1 }))?.created, true)
})

test('finalizing sets the title on the reserved row', () => {
  const u = db.createUser('finalizer', 'pw', 'user', 'unrestricted')
  const reservation = db.reserveStremioPlay(play(u.id, { cap: 5 }))
  db.finalizeStremioPlay(reservation!.id, 'Shawshank.1080p.mkv')
  const row = db.getDb().prepare(`SELECT title FROM stremio_plays WHERE id = ?`).get(reservation!.id) as { title: string }
  assert.equal(row.title, 'Shawshank.1080p.mkv')
})

test('a cap of zero refuses every reservation', () => {
  const u = db.createUser('zero-cap', 'pw', 'user', 'unrestricted')
  assert.equal(db.reserveStremioPlay(play(u.id, { cap: 0 })), null)
  assert.equal(db.countStremioPlaysToday(u.id), 0)
})

// better-sqlite3 leaves the database plus its -wal and -shm sidecars in tmpdir,
// once per run per file. Nothing else cleans them up.
test.after(() => {
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${databasePath}${suffix}`, { force: true })
})

// Two requests for one file share a row, so the loser of that race must not delete
// a play the winner already served.
test('releasing a finalized row is refused', () => {
  const u = db.createUser('adopted', 'pw', 'user', 'unrestricted')
  const reservation = db.reserveStremioPlay(play(u.id, { infoHash: '1'.repeat(40), cap: 5 }))
  assert.equal(db.finalizeStremioPlay(reservation!.id, 'served.mkv'), true)
  db.releaseStremioPlay(reservation!.id)
  assert.equal(db.countStremioPlaysToday(u.id), 1, 'a counted play must survive another request\'s release')
})

test('finalizing a row that is gone reports it rather than silently doing nothing', () => {
  const u = db.createUser('vanished', 'pw', 'user', 'unrestricted')
  const reservation = db.reserveStremioPlay(play(u.id, { infoHash: '2'.repeat(40), cap: 5 }))
  db.releaseStremioPlay(reservation!.id)
  assert.equal(db.countStremioPlaysToday(u.id), 0)
  assert.equal(db.finalizeStremioPlay(reservation!.id, 'too late.mkv'), false)
})

test('an unfinalized row is still released, so a failure does not consume a slot', () => {
  const u = db.createUser('unfinalized', 'pw', 'user', 'unrestricted')
  const reservation = db.reserveStremioPlay(play(u.id, { infoHash: '3'.repeat(40), cap: 1 }))
  db.releaseStremioPlay(reservation!.id)
  assert.equal(db.countStremioPlaysToday(u.id), 0)
  assert.equal(db.reserveStremioPlay(play(u.id, { infoHash: '4'.repeat(40), cap: 1 }))?.created, true)
})
