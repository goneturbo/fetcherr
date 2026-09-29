import test from 'node:test'
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const databasePath = join(tmpdir(), `fetcherr-torbox-restart-${randomUUID()}.db`)
process.env.DATABASE_PATH = databasePath
const db = await import('../src/db.js')
const { config } = await import('../src/config.js')
const torbox = await import('../src/torbox.js')

// rehydrateTorBoxCleanupJobs does nothing without a TorBox key, same as the
// live server would with the addon unconfigured. Restart recovery needs one.
config.torBoxApiKey = 'test-key'

// A tracked entry only exists for a requestdl URL, since that is what carries the
// torrent id cleanup needs.
const requestdlUrl = (torrentId: number) =>
  `https://api.torbox.app/v1/api/torrents/requestdl?token=t&torrent_id=${torrentId}&file_id=0`

const jobFor = (url: string) => db.listTorBoxCleanupJobs().find(job => job.downloadUrl === url) ?? null
const hoursOut = (deleteAt: number) => (deleteAt - Date.now()) / 3_600_000
const minutesOut = (deleteAt: number) => (deleteAt - Date.now()) / 60_000

test('a freshly tracked URL has a row whose deadline is fifteen minutes out', () => {
  const url = requestdlUrl(2001)
  torbox.trackDirectTorBoxUrl(url)
  const job = jobFor(url)
  assert.notEqual(job, null, 'a restart before the first touch must still find this torrent')
  assert.equal(job!.torrentId, 2001)
  assert.ok(minutesOut(job!.deleteAt) > 14.9 && minutesOut(job!.deleteAt) < 15.1, `expected ~15 minutes, got ${minutesOut(job!.deleteAt)}`)
})

test('touching a tracked URL more than a minute later saves a new fifteen minute deadline', (t) => {
  const url = requestdlUrl(2002)
  torbox.trackDirectTorBoxUrl(url)

  const trackedAt = Date.now()
  t.mock.timers.enable({ apis: ['Date'], now: trackedAt })
  t.mock.timers.tick(65_000) // past CLEANUP_RESCHEDULE_GRANULARITY_MS (60s)

  torbox.touchDownloadUrl(url)

  const job = jobFor(url)
  assert.notEqual(job, null)
  assert.ok(minutesOut(job!.deleteAt) > 14.9 && minutesOut(job!.deleteAt) < 15.1, `expected ~15 minutes from the touch, got ${minutesOut(job!.deleteAt)}`)
})

test('with cleanup off, tracking saves no row', () => {
  const url = requestdlUrl(2004)
  db.setSetting('torBoxCleanupMode', 'keep')
  try {
    torbox.trackDirectTorBoxUrl(url)
    assert.equal(jobFor(url), null, 'tracking must not schedule a deletion the admin turned off')
  } finally {
    db.setSetting('torBoxCleanupMode', '')
  }
})

test('restart recovery leaves a future-dated row scheduled, not deleted', () => {
  const url = requestdlUrl(2005)
  db.upsertTorBoxCleanupJob(url, 2005, Date.now() + 6 * 60 * 60 * 1000)

  torbox.rehydrateTorBoxCleanupJobs()

  const job = jobFor(url)
  assert.notEqual(job, null, 'a deadline that has not passed yet must not be deleted')
  assert.ok(hoursOut(job!.deleteAt) > 5.9, `expected the row to stay around six hours out, got ${hoursOut(job!.deleteAt)}`)
})

test('restart recovery deletes a row whose deadline has already passed', async () => {
  const url = requestdlUrl(2006)
  db.upsertTorBoxCleanupJob(url, 2006, Date.now() - 1_000)

  const realFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response(JSON.stringify({ success: true }), { status: 200 })) as typeof globalThis.fetch
  try {
    torbox.rehydrateTorBoxCleanupJobs()
    await new Promise(r => setTimeout(r, 50))
  } finally {
    globalThis.fetch = realFetch
  }

  assert.equal(jobFor(url), null, 'a deadline already in the past must be cleared')
})

// better-sqlite3 leaves the database plus its -wal and -shm sidecars in tmpdir,
// once per run per file. Nothing else cleans them up.
test.after(() => {
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${databasePath}${suffix}`, { force: true })
})
