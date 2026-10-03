import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

// src/config.ts reads this once at module load, so it must be set before the
// dynamic import below — a static import would be hoisted above it.
const databasePath = join(tmpdir(), `fetcherr-legacy-migrate-${randomUUID()}.db`)
process.env.DATABASE_PATH = databasePath

const db = await import('../src/db.js')

const TICKS_PER_SEC = 10_000_000
const TICKS_PER_MIN = 60 * TICKS_PER_SEC
const UNDER_FLOOR_ITEM_ID = 'legacy-under-floor'
const UNDER_FLOOR_TICKS = 60 * TICKS_PER_SEC // under MIN_RESUME_TICKS (2 min)
const LONG_WATCH_ITEM_ID = 'legacy-long-watch'
const LONG_WATCH_TICKS = 10 * TICKS_PER_MIN // at or above MIN_RESUME_TICKS

// migrateLegacyUserData only runs once, inside getDb()'s own first-call setup,
// and only migrates when an admin row already exists — so both the legacy
// user_data rows and the admin row have to exist in the file before db.ts
// opens it for the first time. Pre-populate that file with a raw connection,
// copying the two relevant CREATE TABLE statements from src/db.ts's schema
// verbatim so the real schema exec (CREATE TABLE IF NOT EXISTS) is a no-op
// against them and leaves these rows in place.
function seedLegacyDatabase(): void {
  const raw = new Database(databasePath)
  raw.exec(`
    CREATE TABLE app_users (
      id            TEXT PRIMARY KEY,
      username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL DEFAULT '',
      role          TEXT NOT NULL CHECK (role IN ('admin', 'user', 'kids')),
      max_rating    TEXT NOT NULL DEFAULT 'unrestricted',
      search_enabled INTEGER NOT NULL DEFAULT 1,
      auth_source   TEXT NOT NULL DEFAULT 'local',
      created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );
    CREATE TABLE user_data (
      item_id          TEXT    PRIMARY KEY,
      played           INTEGER NOT NULL DEFAULT 0,
      play_count       INTEGER NOT NULL DEFAULT 0,
      position_ticks   INTEGER NOT NULL DEFAULT 0,
      last_played_date TEXT    NOT NULL DEFAULT ''
    );
  `)
  raw.prepare(`INSERT INTO app_users (id, username, role) VALUES (?, ?, 'admin')`)
    .run(db.DEFAULT_ADMIN_USER_ID, 'legacy-admin')
  raw.prepare(`
    INSERT INTO user_data (item_id, played, play_count, position_ticks, last_played_date)
    VALUES (?, 0, 1, ?, '2020-01-01T00:00:00Z'), (?, 0, 1, ?, '2020-01-01T00:00:00Z')
  `).run(UNDER_FLOOR_ITEM_ID, UNDER_FLOOR_TICKS, LONG_WATCH_ITEM_ID, LONG_WATCH_TICKS)
  raw.close()
}

seedLegacyDatabase()

// Any exported call triggers getDb()'s one-time setup, which runs the
// migration against the rows seeded above.
db.getDb()

function migratedPosition(itemId: string): number {
  const row = db.getDb()
    .prepare(`SELECT position_ticks FROM user_item_data WHERE user_id = ? AND item_id = ?`)
    .get(db.DEFAULT_ADMIN_USER_ID, itemId) as { position_ticks: number } | undefined
  assert.ok(row, `${itemId} did not migrate into user_item_data`)
  return row!.position_ticks
}

test('a legacy position under two minutes migrates as none', () => {
  assert.equal(migratedPosition(UNDER_FLOOR_ITEM_ID), 0)
})

test('a legacy position at ten minutes migrates unchanged', () => {
  assert.equal(migratedPosition(LONG_WATCH_ITEM_ID), LONG_WATCH_TICKS)
})

// better-sqlite3 leaves the database plus its -wal and -shm sidecars in tmpdir,
// once per run per file. Nothing else cleans them up.
test.after(() => {
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${databasePath}${suffix}`, { force: true })
})
