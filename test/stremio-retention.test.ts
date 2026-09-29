import test from 'node:test'
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const databasePath = join(tmpdir(), `fetcherr-retention-${randomUUID()}.db`)
process.env.DATABASE_PATH = databasePath
const db = await import('../src/db.js')
const torbox = await import('../src/torbox.js')

// Every TorBox resolution schedules its own deletion 15 minutes out and saves that
// row right away, so a restart before anything else happens still finds it. The
// Jellyfin routes push the deadline back through touchDownloadUrl each time a
// client reports progress. A Stremio client follows our 302 once and then
// streams the CDN URL directly, so no second request ever reaches us and
// nothing will ever extend it beyond what retainAddonPlayback saves here.

// A tracked entry only exists for a requestdl URL, since that is what carries the
// torrent id cleanup needs.
const requestdlUrl = (torrentId: number) =>
  `https://api.torbox.app/v1/api/torrents/requestdl?token=t&torrent_id=${torrentId}&file_id=0`

const jobFor = (url: string) => db.listTorBoxCleanupJobs().find(job => job.downloadUrl === url) ?? null
const hoursOut = (deleteAt: number) => (deleteAt - Date.now()) / 3_600_000
const minutesOut = (deleteAt: number) => (deleteAt - Date.now()) / 60_000

test('retaining an addon play pushes the deletion deadline out by six hours', () => {
  const url = requestdlUrl(1001)
  torbox.trackDirectTorBoxUrl(url)
  const fresh = jobFor(url)
  assert.notEqual(fresh, null, 'a freshly tracked URL has a row so a restart before the first touch does not lose it')
  assert.ok(minutesOut(fresh!.deleteAt) > 14.9 && minutesOut(fresh!.deleteAt) < 15.1, `expected ~15 minutes, got ${minutesOut(fresh!.deleteAt)}`)

  torbox.retainAddonPlayback({ url, provider: 'TorBox' })

  const job = jobFor(url)
  assert.notEqual(job, null, 'retention must reschedule, which persists the new deadline')
  assert.equal(job!.torrentId, 1001)
  assert.ok(hoursOut(job!.deleteAt) > 5.9 && hoursOut(job!.deleteAt) < 6.1, `expected ~6 hours, got ${hoursOut(job!.deleteAt)}`)
  assert.equal(torbox.ADDON_PLAYBACK_RETENTION_MS, 6 * 60 * 60 * 1000)
})

test('a resolution from another provider is left alone', () => {
  const url = requestdlUrl(1002)
  torbox.trackDirectTorBoxUrl(url)
  const before = jobFor(url)!.deleteAt
  torbox.retainAddonPlayback({ url, provider: 'RealDebrid' })
  torbox.retainAddonPlayback({ url, provider: 'Premiumize' })
  torbox.retainAddonPlayback({ url })
  assert.equal(jobFor(url)!.deleteAt, before, 'only a TorBox resolution should push the deadline out')
})

test('retention never pulls a deadline back in', () => {
  const url = requestdlUrl(1003)
  torbox.trackDirectTorBoxUrl(url)
  torbox.retainAddonPlayback({ url, provider: 'TorBox' })
  const first = jobFor(url)!.deleteAt
  torbox.retainAddonPlayback({ url, provider: 'TorBox' })
  const second = jobFor(url)!.deleteAt
  assert.ok(second >= first, 'a repeat call must not shorten the window')
  assert.ok(hoursOut(second) > 5.9, 'and must leave it around six hours out')
})

// A retention failure must never fail a play, so anything untracked returns
// quietly rather than throwing.
test('an untracked or malformed URL is a quiet no-op, not a throw', () => {
  for (const url of [requestdlUrl(9999), 'https://cdn.example.test/file.mkv', 'not a url at all', '']) {
    assert.doesNotThrow(() => torbox.retainAddonPlayback({ url, provider: 'TorBox' }))
    assert.equal(jobFor(url), null, `${url} should not have been scheduled`)
  }
})

test('an admin who set cleanup to keep is not overridden', () => {
  const url = requestdlUrl(1004)
  db.setSetting('torBoxCleanupMode', 'keep')
  try {
    torbox.trackDirectTorBoxUrl(url)
    torbox.retainAddonPlayback({ url, provider: 'TorBox' })
    assert.equal(jobFor(url), null, 'retention must not schedule a deletion the admin turned off')
  } finally {
    db.setSetting('torBoxCleanupMode', '')
  }
})

// better-sqlite3 leaves the database plus its -wal and -shm sidecars in tmpdir,
// once per run per file. Nothing else cleans them up.
test.after(() => {
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${databasePath}${suffix}`, { force: true })
})
