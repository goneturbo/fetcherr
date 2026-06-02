import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import Database from 'better-sqlite3'
import { config } from './config.js'

export interface Movie {
  id:                 number
  tmdbId:             number
  imdbId:             string
  mediaLanguage:      string
  title:              string
  year:               number
  overview:           string
  posterPath:         string
  backdropPath:       string
  logoPath:           string
  genres:             string   // JSON string array
  runtimeMins:        number
  popularity:         number
  officialRating:     string
  communityRating:    number
  studiosJson:        string
  tagsJson:           string
  releaseDate:        string   // theatrical release date (YYYY-MM-DD)
  digitalReleaseDate: string   // digital/streaming release date (YYYY-MM-DD)
  syncedAt:           string
}

export interface Show {
  id:           number
  tmdbId:       number
  imdbId:       string
  tvdbId:       number
  mediaLanguage: string
  title:        string
  year:         number
  overview:     string
  posterPath:   string
  backdropPath: string
  logoPath:     string
  genres:       string  // JSON string array
  status:       string
  numSeasons:   number
  popularity:   number
  officialRating:  string
  communityRating: number
  studiosJson:     string
  tagsJson:        string
  syncedAt:     string
}

export interface Season {
  id:           number
  showTmdbId:   number
  seasonNumber: number
  name:         string
  overview:     string
  posterPath:   string
  episodeCount: number
  airDate:      string
  syncedAt:     string
}

export interface Episode {
  id:            number
  showTmdbId:    number
  seasonNumber:  number
  episodeNumber: number
  name:          string
  overview:      string
  stillPath:     string
  runtimeMins:   number
  communityRating: number
  airDate:       string
  syncedAt:      string
}

export type MediaType = 'movie' | 'show'
export type ManualShowMode = 'all' | 'latest'
export type AppUserRole = 'admin' | 'user' | 'kids'

export interface AppUser {
  id: string
  username: string
  passwordHash: string
  role: AppUserRole
  maxRating: string
  createdAt: string
  updatedAt: string
}

export interface ManualShowSubscription {
  showTmdbId: number
  mode: ManualShowMode
  activeSeasonNumber: number
  updatedAt: string
}

export interface ManualMovieAvailabilityOverride {
  movieTmdbId: number
  ignoreReleaseGate: boolean
  updatedAt: string
}

export interface HiddenLibraryItem {
  mediaType: MediaType
  tmdbId: number
  hiddenAt: string
}

export interface UiSession {
  token: string
  userId: string
  expiresAt: number
  createdAt: string
}

export interface MusicRelease {
  hash: string
  title: string
  artist: string
  album: string
  year: number
  bytes: number
  seeders: number
  category: string
  resolvedAt: string
  lastSeenAt: string
}

export interface MusicTrack {
  id: string
  releaseHash: string
  fileIdx: number
  filePath: string
  title: string
  trackNum: number
  artist: string
  album: string
  year: number
  bytes: number
  durationSecs: number
  ext: string
  createdAt: string
}

export interface MusicCandidate {
  id: string
  queryKey: string
  releaseHash: string
  rank: number
  createdAt: string
}

export interface MusicMetaAlbum {
  id: string
  source: string
  sourceId: string
  name: string
  artist: string
  year: number
  artworkUrl: string
  trackCount: number
  durationSecs: number
  updatedAt: string
}

export interface MusicMetaTrack {
  id: string
  albumId: string
  sourceTrackId: string
  title: string
  artist: string
  album: string
  trackNum: number
  discNum: number
  durationSecs: number
  artworkUrl: string
  youtubeId: string
  youtubeResolvedAt: string
  updatedAt: string
}

export interface TorBoxCleanupJob {
  downloadUrl: string
  torrentId: number
  deleteAt: number
  updatedAt: string
}

export const DEFAULT_ADMIN_USER_ID = 'a0000000-0000-0000-0000-000000000002'
export const MAX_RATING_OPTIONS = [
  'unrestricted',
  '0',
  '1',
  '2',
  '3',
  '4',
] as const

export type MaxRating = typeof MAX_RATING_OPTIONS[number]
export type RatingLimit = MaxRating

const schema = `
CREATE TABLE IF NOT EXISTS movies (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  tmdb_id              INTEGER NOT NULL UNIQUE,
  imdb_id              TEXT    NOT NULL DEFAULT '',
  title                TEXT    NOT NULL,
  year                 INTEGER NOT NULL DEFAULT 0,
  overview             TEXT    NOT NULL DEFAULT '',
  poster_path          TEXT    NOT NULL DEFAULT '',
  backdrop_path        TEXT    NOT NULL DEFAULT '',
  logo_path            TEXT    NOT NULL DEFAULT '',
  genres               TEXT    NOT NULL DEFAULT '[]',
  runtime_mins         INTEGER NOT NULL DEFAULT 0,
  popularity           REAL    NOT NULL DEFAULT 0,
  official_rating      TEXT    NOT NULL DEFAULT '',
  community_rating     REAL    NOT NULL DEFAULT 0,
  studios_json         TEXT    NOT NULL DEFAULT '[]',
  tags_json            TEXT    NOT NULL DEFAULT '[]',
  release_date         TEXT    NOT NULL DEFAULT '',
  digital_release_date TEXT    NOT NULL DEFAULT '',
  synced_at            TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS movies_title      ON movies(title);
CREATE INDEX IF NOT EXISTS movies_popularity ON movies(popularity DESC);

CREATE TABLE IF NOT EXISTS shows (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  tmdb_id        INTEGER NOT NULL UNIQUE,
  imdb_id        TEXT    NOT NULL DEFAULT '',
  tvdb_id        INTEGER NOT NULL DEFAULT 0,
  title          TEXT    NOT NULL,
  year           INTEGER NOT NULL DEFAULT 0,
  overview       TEXT    NOT NULL DEFAULT '',
  poster_path    TEXT    NOT NULL DEFAULT '',
  backdrop_path  TEXT    NOT NULL DEFAULT '',
  logo_path      TEXT    NOT NULL DEFAULT '',
  genres         TEXT    NOT NULL DEFAULT '[]',
  status         TEXT    NOT NULL DEFAULT '',
  num_seasons    INTEGER NOT NULL DEFAULT 0,
  popularity     REAL    NOT NULL DEFAULT 0,
  official_rating TEXT   NOT NULL DEFAULT '',
  community_rating REAL  NOT NULL DEFAULT 0,
  studios_json    TEXT   NOT NULL DEFAULT '[]',
  tags_json       TEXT   NOT NULL DEFAULT '[]',
  synced_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS shows_title      ON shows(title);
CREATE INDEX IF NOT EXISTS shows_popularity ON shows(popularity DESC);
CREATE INDEX IF NOT EXISTS shows_imdb_id    ON shows(imdb_id);

CREATE TABLE IF NOT EXISTS seasons (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  show_tmdb_id   INTEGER NOT NULL,
  season_number  INTEGER NOT NULL,
  name           TEXT    NOT NULL DEFAULT '',
  overview       TEXT    NOT NULL DEFAULT '',
  poster_path    TEXT    NOT NULL DEFAULT '',
  episode_count  INTEGER NOT NULL DEFAULT 0,
  air_date       TEXT    NOT NULL DEFAULT '',
  synced_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE(show_tmdb_id, season_number)
);
CREATE INDEX IF NOT EXISTS seasons_show ON seasons(show_tmdb_id);

CREATE TABLE IF NOT EXISTS episodes (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  show_tmdb_id   INTEGER NOT NULL,
  season_number  INTEGER NOT NULL,
  episode_number INTEGER NOT NULL,
  name           TEXT    NOT NULL DEFAULT '',
  overview       TEXT    NOT NULL DEFAULT '',
  still_path     TEXT    NOT NULL DEFAULT '',
  runtime_mins   INTEGER NOT NULL DEFAULT 0,
  community_rating REAL  NOT NULL DEFAULT 0,
  air_date       TEXT    NOT NULL DEFAULT '',
  synced_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE(show_tmdb_id, season_number, episode_number)
);
CREATE INDEX IF NOT EXISTS episodes_show   ON episodes(show_tmdb_id);
CREATE INDEX IF NOT EXISTS episodes_season ON episodes(show_tmdb_id, season_number);

CREATE TABLE IF NOT EXISTS app_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS torbox_cleanup_jobs (
  download_url TEXT PRIMARY KEY,
  torrent_id   INTEGER NOT NULL,
  delete_at    INTEGER NOT NULL,
  updated_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS torbox_cleanup_jobs_delete_at ON torbox_cleanup_jobs(delete_at);

CREATE TABLE IF NOT EXISTS app_users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL DEFAULT '',
  role          TEXT NOT NULL CHECK (role IN ('admin', 'user', 'kids')),
  max_rating    TEXT NOT NULL DEFAULT 'unrestricted',
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE IF NOT EXISTS ui_sessions (
  token         TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  expires_at    INTEGER NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS ui_sessions_user_id    ON ui_sessions(user_id);
CREATE INDEX IF NOT EXISTS ui_sessions_expires_at ON ui_sessions(expires_at);

CREATE TABLE IF NOT EXISTS source_items (
  source_key TEXT    NOT NULL,
  media_type TEXT    NOT NULL CHECK (media_type IN ('movie', 'show')),
  tmdb_id    INTEGER NOT NULL,
  synced_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  PRIMARY KEY (source_key, media_type, tmdb_id)
);
CREATE INDEX IF NOT EXISTS source_items_media ON source_items(media_type, tmdb_id);

CREATE TABLE IF NOT EXISTS hidden_library_items (
  media_type TEXT    NOT NULL CHECK (media_type IN ('movie', 'show')),
  tmdb_id    INTEGER NOT NULL,
  hidden_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  PRIMARY KEY (media_type, tmdb_id)
);
CREATE INDEX IF NOT EXISTS hidden_library_items_media ON hidden_library_items(media_type, tmdb_id);

CREATE TABLE IF NOT EXISTS manual_show_subscriptions (
  show_tmdb_id           INTEGER PRIMARY KEY,
  mode                   TEXT    NOT NULL CHECK (mode IN ('all', 'latest')),
  active_season_number   INTEGER NOT NULL DEFAULT 0,
  updated_at             TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE IF NOT EXISTS manual_movie_availability_overrides (
  movie_tmdb_id          INTEGER PRIMARY KEY,
  ignore_release_gate    INTEGER NOT NULL DEFAULT 0,
  updated_at             TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE IF NOT EXISTS movie_release_preferences (
  movie_tmdb_id          INTEGER PRIMARY KEY,
  mode                   TEXT    NOT NULL CHECK (mode IN ('digital', 'theatrical')),
  updated_at             TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE IF NOT EXISTS user_data (
  item_id          TEXT    PRIMARY KEY,
  played           INTEGER NOT NULL DEFAULT 0,
  play_count       INTEGER NOT NULL DEFAULT 0,
  position_ticks   INTEGER NOT NULL DEFAULT 0,
  last_played_date TEXT    NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS user_item_data (
  user_id          TEXT    NOT NULL,
  item_id          TEXT    NOT NULL,
  played           INTEGER NOT NULL DEFAULT 0,
  play_count       INTEGER NOT NULL DEFAULT 0,
  position_ticks   INTEGER NOT NULL DEFAULT 0,
  last_played_date TEXT    NOT NULL DEFAULT '',
  watch_state_source TEXT  NOT NULL DEFAULT '',
  watch_state_updated_at TEXT NOT NULL DEFAULT '',
  trakt_last_watched_at TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (user_id, item_id)
);
CREATE INDEX IF NOT EXISTS user_item_data_resume ON user_item_data(user_id, played, last_played_date);

CREATE TABLE IF NOT EXISTS music_releases (
  hash          TEXT    PRIMARY KEY,
  title         TEXT    NOT NULL,
  artist        TEXT    NOT NULL DEFAULT '',
  album         TEXT    NOT NULL DEFAULT '',
  year          INTEGER NOT NULL DEFAULT 0,
  bytes         INTEGER NOT NULL DEFAULT 0,
  seeders       INTEGER NOT NULL DEFAULT 0,
  category      TEXT    NOT NULL DEFAULT '',
  resolved_at   TEXT    NOT NULL DEFAULT '',
  last_seen_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS music_releases_last_seen ON music_releases(last_seen_at DESC);
CREATE INDEX IF NOT EXISTS music_releases_title ON music_releases(title);

CREATE TABLE IF NOT EXISTS music_tracks (
  id             TEXT    PRIMARY KEY,
  release_hash   TEXT    NOT NULL,
  file_idx       INTEGER NOT NULL,
  file_path      TEXT    NOT NULL DEFAULT '',
  title          TEXT    NOT NULL,
  track_num      INTEGER NOT NULL DEFAULT 0,
  artist         TEXT    NOT NULL DEFAULT '',
  album          TEXT    NOT NULL DEFAULT '',
  year           INTEGER NOT NULL DEFAULT 0,
  bytes          INTEGER NOT NULL DEFAULT 0,
  duration_secs  INTEGER NOT NULL DEFAULT 0,
  ext            TEXT    NOT NULL DEFAULT '',
  created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE(release_hash, file_idx)
);
CREATE INDEX IF NOT EXISTS music_tracks_release ON music_tracks(release_hash, track_num, title);

CREATE TABLE IF NOT EXISTS music_candidates (
  id            TEXT    PRIMARY KEY,
  query_key     TEXT    NOT NULL,
  release_hash  TEXT    NOT NULL,
  rank          INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE(query_key, release_hash)
);
CREATE INDEX IF NOT EXISTS music_candidates_query ON music_candidates(query_key, rank);

CREATE TABLE IF NOT EXISTS music_meta_albums (
  id             TEXT    PRIMARY KEY,
  source         TEXT    NOT NULL,
  source_id      TEXT    NOT NULL,
  name           TEXT    NOT NULL,
  artist         TEXT    NOT NULL DEFAULT '',
  year           INTEGER NOT NULL DEFAULT 0,
  artwork_url    TEXT    NOT NULL DEFAULT '',
  track_count    INTEGER NOT NULL DEFAULT 0,
  duration_secs  INTEGER NOT NULL DEFAULT 0,
  updated_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE(source, source_id)
);
CREATE INDEX IF NOT EXISTS music_meta_albums_search ON music_meta_albums(artist, name);

CREATE TABLE IF NOT EXISTS music_meta_tracks (
  id                   TEXT    PRIMARY KEY,
  album_id             TEXT    NOT NULL,
  source_track_id      TEXT    NOT NULL,
  title                TEXT    NOT NULL,
  artist               TEXT    NOT NULL DEFAULT '',
  album                TEXT    NOT NULL DEFAULT '',
  track_num            INTEGER NOT NULL DEFAULT 0,
  disc_num             INTEGER NOT NULL DEFAULT 0,
  duration_secs        INTEGER NOT NULL DEFAULT 0,
  artwork_url          TEXT    NOT NULL DEFAULT '',
  youtube_id           TEXT    NOT NULL DEFAULT '',
  youtube_resolved_at  TEXT    NOT NULL DEFAULT '',
  updated_at           TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE(album_id, source_track_id)
);
CREATE INDEX IF NOT EXISTS music_meta_tracks_album ON music_meta_tracks(album_id, disc_num, track_num, title);

`

let _db: Database.Database | null = null

export function getDb(): Database.Database {
  if (!_db) {
    _db = new Database(config.dbPath)
    _db.pragma('journal_mode = WAL')
    _db.pragma('busy_timeout = 5000')
    _db.pragma('synchronous = NORMAL')
    _db.exec(schema)
    // Migrations for columns added after initial schema
    try { _db.exec(`ALTER TABLE movies ADD COLUMN backdrop_path TEXT NOT NULL DEFAULT ''`) } catch { /* already exists */ }
    try { _db.exec(`ALTER TABLE shows ADD COLUMN backdrop_path TEXT NOT NULL DEFAULT ''`) } catch { /* already exists */ }
    try { _db.exec(`ALTER TABLE movies ADD COLUMN logo_path TEXT NOT NULL DEFAULT ''`) } catch { /* already exists */ }
    try { _db.exec(`ALTER TABLE shows ADD COLUMN logo_path TEXT NOT NULL DEFAULT ''`) } catch { /* already exists */ }
    try { _db.exec(`ALTER TABLE movies ADD COLUMN official_rating TEXT NOT NULL DEFAULT ''`) } catch { /* already exists */ }
    try { _db.exec(`ALTER TABLE movies ADD COLUMN community_rating REAL NOT NULL DEFAULT 0`) } catch { /* already exists */ }
    try { _db.exec(`ALTER TABLE movies ADD COLUMN studios_json TEXT NOT NULL DEFAULT '[]'`) } catch { /* already exists */ }
    try { _db.exec(`ALTER TABLE movies ADD COLUMN tags_json TEXT NOT NULL DEFAULT '[]'`) } catch { /* already exists */ }
    try { _db.exec(`ALTER TABLE shows ADD COLUMN official_rating TEXT NOT NULL DEFAULT ''`) } catch { /* already exists */ }
    try { _db.exec(`ALTER TABLE shows ADD COLUMN community_rating REAL NOT NULL DEFAULT 0`) } catch { /* already exists */ }
    try { _db.exec(`ALTER TABLE shows ADD COLUMN studios_json TEXT NOT NULL DEFAULT '[]'`) } catch { /* already exists */ }
    try { _db.exec(`ALTER TABLE shows ADD COLUMN tags_json TEXT NOT NULL DEFAULT '[]'`) } catch { /* already exists */ }
    try { _db.exec(`ALTER TABLE shows ADD COLUMN tvdb_id INTEGER NOT NULL DEFAULT 0`) } catch { /* already exists */ }
    try { _db.exec(`CREATE INDEX IF NOT EXISTS shows_imdb_id ON shows(imdb_id)`) } catch { /* already exists */ }
    try { _db.exec(`ALTER TABLE episodes ADD COLUMN community_rating REAL NOT NULL DEFAULT 0`) } catch { /* already exists */ }
    try { _db.exec(`ALTER TABLE movies ADD COLUMN release_date TEXT NOT NULL DEFAULT ''`) } catch { /* already exists */ }
    try { _db.exec(`ALTER TABLE movies ADD COLUMN digital_release_date TEXT NOT NULL DEFAULT ''`) } catch { /* already exists */ }
    try { _db.exec(`ALTER TABLE movies ADD COLUMN media_language TEXT NOT NULL DEFAULT ''`) } catch { /* already exists */ }
    try { _db.exec(`ALTER TABLE shows ADD COLUMN media_language TEXT NOT NULL DEFAULT ''`) } catch { /* already exists */ }
    try { _db.exec(`ALTER TABLE user_item_data ADD COLUMN watch_state_source TEXT NOT NULL DEFAULT ''`) } catch { /* already exists */ }
    try { _db.exec(`ALTER TABLE user_item_data ADD COLUMN watch_state_updated_at TEXT NOT NULL DEFAULT ''`) } catch { /* already exists */ }
    try { _db.exec(`ALTER TABLE user_item_data ADD COLUMN trakt_last_watched_at TEXT NOT NULL DEFAULT ''`) } catch { /* already exists */ }
    try { _db.exec(`ALTER TABLE music_meta_tracks ADD COLUMN youtube_id TEXT NOT NULL DEFAULT ''`) } catch { /* already exists */ }
    try { _db.exec(`ALTER TABLE music_meta_tracks ADD COLUMN youtube_resolved_at TEXT NOT NULL DEFAULT ''`) } catch { /* already exists */ }
    try { _db.exec(`CREATE TABLE IF NOT EXISTS torbox_cleanup_jobs (
      download_url TEXT PRIMARY KEY,
      torrent_id   INTEGER NOT NULL,
      delete_at    INTEGER NOT NULL,
      updated_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    )`) } catch { /* already exists */ }
    try { _db.exec(`CREATE INDEX IF NOT EXISTS torbox_cleanup_jobs_delete_at ON torbox_cleanup_jobs(delete_at)`) } catch { /* already exists */ }
    migrateAppUserRoles(_db)
    migrateLegacyUserData(_db)
  }
  return _db
}

function hashPassword(password: string, saltHex = randomBytes(16).toString('hex')): string {
  const derived = scryptSync(password, saltHex, 64).toString('hex')
  return `${saltHex}:${derived}`
}

function verifyPasswordHash(password: string, passwordHash: string): boolean {
  const [saltHex, derivedHex] = passwordHash.split(':', 2)
  if (!saltHex || !derivedHex) return false
  const actual = Buffer.from(derivedHex, 'hex')
  const expected = scryptSync(password, saltHex, actual.length)
  if (actual.length !== expected.length) return false
  return timingSafeEqual(actual, expected)
}

function normalizeUsername(username: string): string {
  return username.trim()
}

function normalizeMaxRating(value: string | null | undefined): MaxRating {
  const raw = (value ?? '').trim()
  if (!raw) return 'unrestricted'
  if (['0', '1', '2', '3', '4'].includes(raw)) return raw as MaxRating
  if (raw.toLowerCase() === 'unrestricted') return 'unrestricted'
  const severity = ratingSeverity(raw)
  return severity == null ? 'unrestricted' : String(severity) as MaxRating
}

function normalizeUserRole(value: string | null | undefined): AppUserRole {
  const normalized = (value ?? '').trim().toLowerCase()
  if (normalized === 'admin') return 'admin'
  if (normalized === 'kids') return 'kids'
  return 'user'
}

function effectiveMaxRatingForRole(role: AppUserRole, maxRating: string): MaxRating {
  if (role === 'admin') return 'unrestricted'
  return normalizeMaxRating(maxRating)
}

function row2appUser(r: Record<string, unknown>): AppUser {
  const role = normalizeUserRole(r.role as string)
  return {
    id: r.id as string,
    username: r.username as string,
    passwordHash: (r.password_hash as string) ?? '',
    role,
    maxRating: effectiveMaxRatingForRole(role, (r.max_rating as string) ?? 'unrestricted'),
    createdAt: (r.created_at as string) ?? '',
    updatedAt: (r.updated_at as string) ?? '',
  }
}

function row2musicRelease(r: Record<string, unknown>): MusicRelease {
  return {
    hash:       r.hash as string,
    title:      r.title as string,
    artist:     (r.artist as string) ?? '',
    album:      (r.album as string) ?? '',
    year:       (r.year as number) ?? 0,
    bytes:      (r.bytes as number) ?? 0,
    seeders:    (r.seeders as number) ?? 0,
    category:   (r.category as string) ?? '',
    resolvedAt: (r.resolved_at as string) ?? '',
    lastSeenAt: (r.last_seen_at as string) ?? '',
  }
}

function row2musicTrack(r: Record<string, unknown>): MusicTrack {
  return {
    id:           r.id as string,
    releaseHash:  r.release_hash as string,
    fileIdx:      (r.file_idx as number) ?? 0,
    filePath:     (r.file_path as string) ?? '',
    title:        r.title as string,
    trackNum:     (r.track_num as number) ?? 0,
    artist:       (r.artist as string) ?? '',
    album:        (r.album as string) ?? '',
    year:         (r.year as number) ?? 0,
    bytes:        (r.bytes as number) ?? 0,
    durationSecs: (r.duration_secs as number) ?? 0,
    ext:          (r.ext as string) ?? '',
    createdAt:    (r.created_at as string) ?? '',
  }
}

function row2musicMetaAlbum(r: Record<string, unknown>): MusicMetaAlbum {
  return {
    id:           r.id as string,
    source:       r.source as string,
    sourceId:     r.source_id as string,
    name:         r.name as string,
    artist:       (r.artist as string) ?? '',
    year:         (r.year as number) ?? 0,
    artworkUrl:   (r.artwork_url as string) ?? '',
    trackCount:   (r.track_count as number) ?? 0,
    durationSecs: (r.duration_secs as number) ?? 0,
    updatedAt:    (r.updated_at as string) ?? '',
  }
}

function row2musicMetaTrack(r: Record<string, unknown>): MusicMetaTrack {
  return {
    id:                r.id as string,
    albumId:           r.album_id as string,
    sourceTrackId:     r.source_track_id as string,
    title:             r.title as string,
    artist:            (r.artist as string) ?? '',
    album:             (r.album as string) ?? '',
    trackNum:          (r.track_num as number) ?? 0,
    discNum:           (r.disc_num as number) ?? 0,
    durationSecs:      (r.duration_secs as number) ?? 0,
    artworkUrl:        (r.artwork_url as string) ?? '',
    youtubeId:         (r.youtube_id as string) ?? '',
    youtubeResolvedAt: (r.youtube_resolved_at as string) ?? '',
    updatedAt:         (r.updated_at as string) ?? '',
  }
}

function migrateAppUserRoles(db: Database.Database): void {
  const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'app_users'`).get() as { sql?: string } | undefined
  const sql = String(row?.sql ?? '')
  if (!sql || sql.includes("'kids'")) return
  db.transaction(() => {
    db.exec(`
      CREATE TABLE app_users_new (
        id            TEXT PRIMARY KEY,
        username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
        password_hash TEXT NOT NULL DEFAULT '',
        role          TEXT NOT NULL CHECK (role IN ('admin', 'user', 'kids')),
        max_rating    TEXT NOT NULL DEFAULT 'unrestricted',
        created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
        updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
      );
      INSERT INTO app_users_new (id, username, password_hash, role, max_rating, created_at, updated_at)
      SELECT id, username, password_hash, role, max_rating, created_at, updated_at
      FROM app_users;
      DROP TABLE app_users;
      ALTER TABLE app_users_new RENAME TO app_users;
    `)
  })()
}

function migrateLegacyUserData(db: Database.Database): void {
  const legacyCount = db.prepare(`SELECT COUNT(*) AS n FROM user_data`).get() as { n: number }
  if (legacyCount.n === 0) return
  const migratedCount = db.prepare(`SELECT COUNT(*) AS n FROM user_item_data`).get() as { n: number }
  if (migratedCount.n > 0) return
  const hasAdmin = db.prepare(`SELECT 1 FROM app_users WHERE id = ? LIMIT 1`).get(DEFAULT_ADMIN_USER_ID)
  if (!hasAdmin) return
  db.prepare(`
    INSERT INTO user_item_data (user_id, item_id, played, play_count, position_ticks, last_played_date)
    SELECT ?, item_id, played, play_count, position_ticks, last_played_date
    FROM user_data
  `).run(DEFAULT_ADMIN_USER_ID)
}

function sqlStringLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

function randomGuidLikeId(): string {
  const hex = randomBytes(16).toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function row2movie(r: Record<string, unknown>): Movie {
  return {
    id:           r.id            as number,
    tmdbId:       r.tmdb_id       as number,
    imdbId:       r.imdb_id       as string,
    mediaLanguage:(r.media_language as string) ?? '',
    title:        r.title         as string,
    year:         r.year          as number,
    overview:     r.overview      as string,
    posterPath:   r.poster_path   as string,
    backdropPath: (r.backdrop_path as string) ?? '',
    logoPath:     (r.logo_path as string) ?? '',
    genres:       r.genres        as string,
    runtimeMins:  r.runtime_mins  as number,
    popularity:          r.popularity           as number,
    officialRating:      (r.official_rating     as string) ?? '',
    communityRating:     (r.community_rating    as number) ?? 0,
    studiosJson:         (r.studios_json        as string) ?? '[]',
    tagsJson:            (r.tags_json           as string) ?? '[]',
    releaseDate:         (r.release_date         as string) ?? '',
    digitalReleaseDate:  (r.digital_release_date as string) ?? '',
    syncedAt:            r.synced_at             as string,
  }
}

export function upsertMovie(m: Omit<Movie, 'id'>): void {
  getDb().prepare(`
    INSERT INTO movies (tmdb_id, imdb_id, media_language, title, year, overview, poster_path, backdrop_path, logo_path, genres, runtime_mins, popularity, official_rating, community_rating, studios_json, tags_json, release_date, digital_release_date, synced_at)
    VALUES (@tmdbId, @imdbId, @mediaLanguage, @title, @year, @overview, @posterPath, @backdropPath, @logoPath, @genres, @runtimeMins, @popularity, @officialRating, @communityRating, @studiosJson, @tagsJson, @releaseDate, @digitalReleaseDate, COALESCE(NULLIF(@syncedAt, ''), strftime('%Y-%m-%dT%H:%M:%SZ','now')))
    ON CONFLICT(tmdb_id) DO UPDATE SET
      imdb_id              = excluded.imdb_id,
      media_language       = excluded.media_language,
      title                = excluded.title,
      year                 = excluded.year,
      overview             = excluded.overview,
      poster_path          = excluded.poster_path,
      backdrop_path        = excluded.backdrop_path,
      logo_path            = excluded.logo_path,
      genres               = excluded.genres,
      runtime_mins         = excluded.runtime_mins,
      popularity           = excluded.popularity,
      official_rating      = excluded.official_rating,
      community_rating     = excluded.community_rating,
      studios_json         = excluded.studios_json,
      tags_json            = excluded.tags_json,
      release_date         = excluded.release_date,
      digital_release_date = excluded.digital_release_date
  `).run(m)
}

export interface ListOpts {
  search?:    string
  sortBy?:    string
  sortOrder?: string
  limit?:     number
  offset?:    number
  availableOnly?: boolean
  userId?: string
}

export function todayIsoDate(): string {
  const now = new Date()
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function isEpisodeVisibleToLibrary(episode: Pick<Episode, 'airDate'>): boolean {
  return !!episode.airDate && episode.airDate < todayIsoDate()
}

export function getMovieEligibleDate(
  movie: Pick<Movie, 'releaseDate' | 'digitalReleaseDate'>,
  mode?: 'digital' | 'theatrical',
): string | null {
  const effectiveMode = mode ?? config.movieReleaseMode
  if (effectiveMode === 'theatrical') {
    if (movie.releaseDate) return movie.releaseDate
    if (movie.digitalReleaseDate) return movie.digitalReleaseDate
    return null
  }
  if (movie.digitalReleaseDate) return movie.digitalReleaseDate
  if (movie.releaseDate) return addDaysIso(movie.releaseDate, 45) || null
  return null
}

export function getMovieReleaseModeForLibrary(movieTmdbId: number): 'digital' | 'theatrical' {
  const row = getDb().prepare(`
    SELECT mode
    FROM movie_release_preferences
    WHERE movie_tmdb_id = ?
  `).get(movieTmdbId) as { mode?: string } | undefined
  return row?.mode === 'theatrical' ? 'theatrical' : row?.mode === 'digital' ? 'digital' : config.movieReleaseMode
}

export function listMovieReleaseModePreferences(movieTmdbIds: number[]): Map<number, 'digital' | 'theatrical'> {
  const ids = uniqTmdbIds(movieTmdbIds)
  if (!ids.length) return new Map()
  const rows = getDb().prepare(`
    SELECT movie_tmdb_id, mode
    FROM movie_release_preferences
    WHERE movie_tmdb_id IN (${sqlPlaceholders(ids.length)})
  `).all(...ids) as Array<{ movie_tmdb_id: number; mode: string }>
  return new Map(rows.map(row => [
    row.movie_tmdb_id,
    row.mode === 'theatrical' ? 'theatrical' : 'digital',
  ]))
}

export function setMovieReleaseModePreference(movieTmdbId: number, mode: 'digital' | 'theatrical'): void {
  getDb().prepare(`
    INSERT INTO movie_release_preferences (movie_tmdb_id, mode, updated_at)
    VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    ON CONFLICT(movie_tmdb_id) DO UPDATE SET
      mode = excluded.mode,
      updated_at = excluded.updated_at
  `).run(movieTmdbId, mode)
}

export function materializeMovieReleaseModeForExistingLibrary(mode: 'digital' | 'theatrical'): number {
  const info = getDb().prepare(`
    INSERT INTO movie_release_preferences (movie_tmdb_id, mode, updated_at)
    SELECT DISTINCT si.tmdb_id, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now')
    FROM source_items si
    WHERE si.media_type = 'movie'
      AND NOT EXISTS (
        SELECT 1
        FROM movie_release_preferences mp
        WHERE mp.movie_tmdb_id = si.tmdb_id
      )
  `).run(mode)
  return info.changes
}

export function isMovieAvailable(
  movie: Pick<Movie, 'tmdbId' | 'releaseDate' | 'digitalReleaseDate'>,
  today = todayIsoDate(),
): boolean {
  const eligibleDate = getMovieEligibleDate(movie, getMovieReleaseModeForLibrary(movie.tmdbId))
  if (eligibleDate && eligibleDate <= today) return true
  return false
}

export function getManualMovieAvailabilityOverride(tmdbId: number): boolean {
  const row = getDb().prepare(`
    SELECT ignore_release_gate
    FROM manual_movie_availability_overrides
    WHERE movie_tmdb_id = ?
  `).get(tmdbId) as { ignore_release_gate: number } | undefined
  return !!row?.ignore_release_gate
}

export function listManualMovieAvailabilityOverrides(movieTmdbIds: number[]): Set<number> {
  const ids = uniqTmdbIds(movieTmdbIds)
  if (!ids.length) return new Set()
  const rows = getDb().prepare(`
    SELECT movie_tmdb_id
    FROM manual_movie_availability_overrides
    WHERE ignore_release_gate = 1
      AND movie_tmdb_id IN (${sqlPlaceholders(ids.length)})
  `).all(...ids) as Array<{ movie_tmdb_id: number }>
  return new Set(rows.map(row => row.movie_tmdb_id))
}

export function setManualMovieAvailabilityOverride(tmdbId: number, ignoreReleaseGate: boolean): void {
  if (!ignoreReleaseGate) {
    getDb().prepare(`
      DELETE FROM manual_movie_availability_overrides WHERE movie_tmdb_id = ?
    `).run(tmdbId)
    return
  }
  getDb().prepare(`
    INSERT INTO manual_movie_availability_overrides (movie_tmdb_id, ignore_release_gate, updated_at)
    VALUES (?, 1, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    ON CONFLICT(movie_tmdb_id) DO UPDATE SET
      ignore_release_gate = 1,
      updated_at = excluded.updated_at
  `).run(tmdbId)
}

export function isMovieVisibleToLibrary(
  movie: Pick<Movie, 'tmdbId' | 'releaseDate' | 'digitalReleaseDate'>,
  today = todayIsoDate(),
): boolean {
  if (isLibraryItemHidden('movie', movie.tmdbId)) return false
  return getManualMovieAvailabilityOverride(movie.tmdbId) || isMovieAvailable(movie, today)
}

function addDaysIso(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return ''
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

function normalizeSortBy(sortBy?: string): string {
  return (sortBy ?? '')
    .split(',')[0]
    .trim()
    .toLowerCase()
}

type SortSpec = {
  expr: string
  directional: boolean
}

function movieSortSpec(sortBy?: string, userId = DEFAULT_ADMIN_USER_ID): SortSpec {
  const normalized = normalizeSortBy(sortBy)
  if (['sortname', 'title'].includes(normalized)) {
    return {
      expr: "trim(case when lower(title) like 'the %' then substr(title, 5) when lower(title) like 'an %' then substr(title, 4) when lower(title) like 'a %' then substr(title, 3) else title end) collate nocase",
      directional: true,
    }
  }
  if (['productionyear', 'year', 'releasedate', 'premieredate'].includes(normalized)) {
    return {
      expr: "coalesce(nullif(release_date, ''), nullif(digital_release_date, ''), printf('%04d-01-01', year))",
      directional: true,
    }
  }
  if (['communityrating', 'imdbrating', 'rating'].includes(normalized)) return { expr: 'community_rating', directional: true }
  if (['officialrating', 'parentalrating'].includes(normalized)) return { expr: 'official_rating collate nocase', directional: true }
  if (['datecreated'].includes(normalized)) return { expr: "coalesce(nullif(release_date, ''), nullif(digital_release_date, ''), '')", directional: true }
  if (['dateshowadded', 'dateadded', 'addeddate'].includes(normalized)) return { expr: 'synced_at', directional: true }
  if (['dateplayed', 'lastplayeddate'].includes(normalized)) {
    return {
      expr: `(SELECT last_played_date FROM user_item_data WHERE user_id = ${sqlStringLiteral(userId)} AND item_id = ('00000000-0000-4000-8000-' || lower(printf('%012x', movies.tmdb_id))))`,
      directional: true,
    }
  }
  if (normalized === 'random') return { expr: 'random()', directional: false }
  return { expr: 'popularity', directional: true }
}

function showSortSpec(sortBy?: string, userId = DEFAULT_ADMIN_USER_ID): SortSpec {
  const normalized = normalizeSortBy(sortBy)
  if (['sortname', 'title'].includes(normalized)) {
    return {
      expr: "trim(case when lower(title) like 'the %' then substr(title, 5) when lower(title) like 'an %' then substr(title, 4) when lower(title) like 'a %' then substr(title, 3) else title end) collate nocase",
      directional: true,
    }
  }
  if (['productionyear', 'year', 'releasedate', 'premieredate'].includes(normalized)) return { expr: 'year', directional: true }
  if (['communityrating', 'imdbrating', 'rating'].includes(normalized)) return { expr: 'community_rating', directional: true }
  if (['officialrating', 'parentalrating'].includes(normalized)) return { expr: 'official_rating collate nocase', directional: true }
  if (['dateshowadded', 'dateadded', 'addeddate'].includes(normalized)) return { expr: 'synced_at', directional: true }
  if (['dateepisodeadded', 'episodeaddeddate'].includes(normalized)) {
    return {
      expr: `(SELECT max(e.synced_at) FROM episodes e WHERE e.show_tmdb_id = shows.tmdb_id)`,
      directional: true,
    }
  }
  if (['dateplayed', 'lastplayeddate'].includes(normalized)) {
    return {
      expr: `(SELECT max(u.last_played_date)
        FROM user_item_data u
        JOIN episodes e
          ON u.item_id = ('00000000-0000-4000-8003-' || lower(printf('%06x%03x%03x', e.show_tmdb_id, e.season_number, e.episode_number)))
       WHERE u.user_id = ${sqlStringLiteral(userId)}
         AND e.show_tmdb_id = shows.tmdb_id)`,
      directional: true,
    }
  }
  if (normalized === 'random') return { expr: 'random()', directional: false }
  return { expr: 'popularity', directional: true }
}

function sortDirection(sortOrder?: string): 'ASC' | 'DESC' {
  const normalized = (sortOrder ?? '')
    .split(',')[0]
    .trim()
    .toLowerCase()
  return normalized === 'asc' || normalized === 'ascending' ? 'ASC' : 'DESC'
}

function movieAvailabilityWhere(availableOnly: boolean): string {
  const clauses = [
    `EXISTS (
      SELECT 1
      FROM source_items
      WHERE source_items.media_type = 'movie'
        AND source_items.tmdb_id = movies.tmdb_id
    )`,
    `NOT EXISTS (
      SELECT 1
      FROM hidden_library_items
      WHERE hidden_library_items.media_type = 'movie'
        AND hidden_library_items.tmdb_id = movies.tmdb_id
    )`,
  ]
  if (availableOnly) {
    const effectiveReleaseMode = `COALESCE((
      SELECT mode
      FROM movie_release_preferences
      WHERE movie_release_preferences.movie_tmdb_id = movies.tmdb_id
    ), ${sqlStringLiteral(config.movieReleaseMode)})`
    const theatricalAvailability = `(
      (release_date != '' AND release_date <= date('now'))
      OR (
        release_date = ''
        AND digital_release_date != ''
        AND digital_release_date <= date('now')
      )
    )`
    const digitalAvailability = `(
      (digital_release_date != '' AND digital_release_date <= date('now'))
      OR (
        digital_release_date = ''
        AND release_date != ''
        AND date(release_date, '+45 day') <= date('now')
      )
    )`
    clauses.push(`(
        EXISTS (
          SELECT 1
          FROM manual_movie_availability_overrides
          WHERE manual_movie_availability_overrides.movie_tmdb_id = movies.tmdb_id
            AND manual_movie_availability_overrides.ignore_release_gate = 1
        )
        OR (
          CASE ${effectiveReleaseMode}
            WHEN 'theatrical' THEN ${theatricalAvailability}
            ELSE ${digitalAvailability}
          END
        )
      )`)
  }
  return `WHERE ${clauses.join('\n  AND ')}`
}

function showAvailabilityWhere(availableOnly: boolean): string {
  const clauses = [
    `EXISTS (
      SELECT 1
      FROM source_items
      WHERE source_items.media_type = 'show'
        AND source_items.tmdb_id = shows.tmdb_id
    )`,
    `NOT EXISTS (
      SELECT 1
      FROM hidden_library_items
      WHERE hidden_library_items.media_type = 'show'
        AND hidden_library_items.tmdb_id = shows.tmdb_id
    )`,
  ]
  if (availableOnly) {
    const today = sqlStringLiteral(todayIsoDate())
    clauses.push(`EXISTS (
      SELECT 1
      FROM episodes
      WHERE episodes.show_tmdb_id = shows.tmdb_id
        AND episodes.air_date != ''
        AND episodes.air_date < ${today}
    )`)
  }
  return `WHERE ${clauses.join('\n  AND ')}`
}

export function listMovies(opts: ListOpts = {}): Movie[] {
  const { search, sortBy, sortOrder, limit = 50, offset = 0, availableOnly = false, userId = DEFAULT_ADMIN_USER_ID } = opts

  const sortSpec = movieSortSpec(sortBy, userId)
  const orderClause = sortSpec.directional ? `${sortSpec.expr} ${sortDirection(sortOrder)}` : sortSpec.expr
  const baseWhere = movieAvailabilityWhere(availableOnly)

  if (search) {
    return (getDb().prepare(
      `SELECT * FROM movies ${baseWhere}${baseWhere ? ' AND' : ' WHERE'} title LIKE ? ORDER BY ${orderClause} LIMIT ? OFFSET ?`
    ).all(`%${search}%`, limit, offset) as Record<string, unknown>[]).map(row2movie)
  }
  return (getDb().prepare(
    `SELECT * FROM movies ${baseWhere} ORDER BY ${orderClause} LIMIT ? OFFSET ?`
  ).all(limit, offset) as Record<string, unknown>[]).map(row2movie)
}

export function countMovies(search?: string, availableOnly = false): number {
  const baseWhere = movieAvailabilityWhere(availableOnly)
  if (search) {
    return (getDb().prepare(
      `SELECT COUNT(*) as n FROM movies ${baseWhere}${baseWhere ? ' AND' : ' WHERE'} title LIKE ?`
    )
      .get(`%${search}%`) as { n: number }).n
  }
  return (getDb().prepare(`SELECT COUNT(*) as n FROM movies ${baseWhere}`).get() as { n: number }).n
}

export function getMovieByTmdbId(tmdbId: number): Movie | null {
  const r = getDb().prepare(`SELECT * FROM movies WHERE tmdb_id = ?`).get(tmdbId)
  return r ? row2movie(r as Record<string, unknown>) : null
}

export function getMovieByImdbId(imdbId: string): Movie | null {
  const r = getDb().prepare(`SELECT * FROM movies WHERE imdb_id = ? LIMIT 1`).get(imdbId)
  return r ? row2movie(r as Record<string, unknown>) : null
}

// ── Shows ─────────────────────────────────────────────────────────────────────

function row2show(r: Record<string, unknown>): Show {
  return {
    id:           r.id            as number,
    tmdbId:       r.tmdb_id       as number,
    imdbId:       r.imdb_id       as string,
    tvdbId:       (r.tvdb_id as number) ?? 0,
    mediaLanguage:(r.media_language as string) ?? '',
    title:        r.title         as string,
    year:         r.year          as number,
    overview:     r.overview      as string,
    posterPath:   r.poster_path   as string,
    backdropPath: (r.backdrop_path as string) ?? '',
    logoPath:     (r.logo_path as string) ?? '',
    genres:       r.genres        as string,
    status:       r.status        as string,
    numSeasons:   r.num_seasons   as number,
    popularity:   r.popularity    as number,
    officialRating:  (r.official_rating as string) ?? '',
    communityRating: (r.community_rating as number) ?? 0,
    studiosJson:     (r.studios_json as string) ?? '[]',
    tagsJson:        (r.tags_json as string) ?? '[]',
    syncedAt:     r.synced_at     as string,
  }
}

export function upsertShow(s: Omit<Show, 'id'>): void {
  getDb().prepare(`
    INSERT INTO shows (tmdb_id, imdb_id, tvdb_id, media_language, title, year, overview, poster_path, backdrop_path, logo_path, genres, status, num_seasons, popularity, official_rating, community_rating, studios_json, tags_json, synced_at)
    VALUES (@tmdbId, @imdbId, @tvdbId, @mediaLanguage, @title, @year, @overview, @posterPath, @backdropPath, @logoPath, @genres, @status, @numSeasons, @popularity, @officialRating, @communityRating, @studiosJson, @tagsJson, COALESCE(NULLIF(@syncedAt, ''), strftime('%Y-%m-%dT%H:%M:%SZ','now')))
    ON CONFLICT(tmdb_id) DO UPDATE SET
      imdb_id      = excluded.imdb_id,
      tvdb_id      = excluded.tvdb_id,
      media_language = excluded.media_language,
      title        = excluded.title,
      year         = excluded.year,
      overview     = excluded.overview,
      poster_path  = excluded.poster_path,
      backdrop_path = excluded.backdrop_path,
      logo_path    = excluded.logo_path,
      genres       = excluded.genres,
      status       = excluded.status,
      num_seasons  = excluded.num_seasons,
      popularity   = excluded.popularity,
      official_rating = excluded.official_rating,
      community_rating = excluded.community_rating,
      studios_json = excluded.studios_json,
      tags_json = excluded.tags_json
  `).run(s)
}

export function listShows(opts: ListOpts = {}): Show[] {
  const { search, sortBy, sortOrder, limit = 50, offset = 0, availableOnly = false, userId = DEFAULT_ADMIN_USER_ID } = opts
  const sortSpec = showSortSpec(sortBy, userId)
  const orderClause = sortSpec.directional ? `${sortSpec.expr} ${sortDirection(sortOrder)}` : sortSpec.expr
  const baseWhere = showAvailabilityWhere(availableOnly)
  if (search) {
    return (getDb().prepare(
      `SELECT * FROM shows ${baseWhere}${baseWhere ? ' AND' : ' WHERE'} title LIKE ? ORDER BY ${orderClause} LIMIT ? OFFSET ?`
    ).all(`%${search}%`, limit, offset) as Record<string, unknown>[]).map(row2show)
  }
  return (getDb().prepare(
    `SELECT * FROM shows ${baseWhere} ORDER BY ${orderClause} LIMIT ? OFFSET ?`
  ).all(limit, offset) as Record<string, unknown>[]).map(row2show)
}

export function countShows(search?: string, availableOnly = false): number {
  const baseWhere = showAvailabilityWhere(availableOnly)
  if (search) {
    return (getDb().prepare(
      `SELECT COUNT(*) as n FROM shows ${baseWhere}${baseWhere ? ' AND' : ' WHERE'} title LIKE ?`
    )
      .get(`%${search}%`) as { n: number }).n
  }
  return (getDb().prepare(`SELECT COUNT(*) as n FROM shows ${baseWhere}`).get() as { n: number }).n
}

export function getShowByTmdbId(tmdbId: number): Show | null {
  const r = getDb().prepare(`SELECT * FROM shows WHERE tmdb_id = ?`).get(tmdbId)
  return r ? row2show(r as Record<string, unknown>) : null
}

export function getShowByImdbId(imdbId: string): Show | null {
  const r = getDb().prepare(`SELECT * FROM shows WHERE imdb_id = ? LIMIT 1`).get(imdbId)
  return r ? row2show(r as Record<string, unknown>) : null
}

// ── Seasons ───────────────────────────────────────────────────────────────────

function row2season(r: Record<string, unknown>): Season {
  return {
    id:           r.id            as number,
    showTmdbId:   r.show_tmdb_id  as number,
    seasonNumber: r.season_number as number,
    name:         r.name          as string,
    overview:     r.overview      as string,
    posterPath:   r.poster_path   as string,
    episodeCount: r.episode_count as number,
    airDate:      r.air_date      as string,
    syncedAt:     r.synced_at     as string,
  }
}

export function upsertSeason(s: Omit<Season, 'id'>): void {
  getDb().prepare(`
    INSERT INTO seasons (show_tmdb_id, season_number, name, overview, poster_path, episode_count, air_date, synced_at)
    VALUES (@showTmdbId, @seasonNumber, @name, @overview, @posterPath, @episodeCount, @airDate, COALESCE(NULLIF(@syncedAt, ''), strftime('%Y-%m-%dT%H:%M:%SZ','now')))
    ON CONFLICT(show_tmdb_id, season_number) DO UPDATE SET
      name          = excluded.name,
      overview      = excluded.overview,
      poster_path   = excluded.poster_path,
      episode_count = excluded.episode_count,
      air_date      = excluded.air_date,
      synced_at     = excluded.synced_at
  `).run(s)
}

export function getSeasonsForShow(showTmdbId: number): Season[] {
  return (getDb().prepare(
    `SELECT * FROM seasons WHERE show_tmdb_id = ? ORDER BY season_number ASC`
  ).all(showTmdbId) as Record<string, unknown>[]).map(row2season)
}

export function getSeason(showTmdbId: number, seasonNumber: number): Season | null {
  const r = getDb().prepare(
    `SELECT * FROM seasons WHERE show_tmdb_id = ? AND season_number = ?`
  ).get(showTmdbId, seasonNumber)
  return r ? row2season(r as Record<string, unknown>) : null
}

// ── Episodes ──────────────────────────────────────────────────────────────────

function row2episode(r: Record<string, unknown>): Episode {
  return {
    id:            r.id             as number,
    showTmdbId:    r.show_tmdb_id   as number,
    seasonNumber:  r.season_number  as number,
    episodeNumber: r.episode_number as number,
    name:          r.name           as string,
    overview:      r.overview       as string,
    stillPath:     r.still_path     as string,
    runtimeMins:   r.runtime_mins   as number,
    communityRating: (r.community_rating as number) ?? 0,
    airDate:       r.air_date       as string,
    syncedAt:      r.synced_at      as string,
  }
}

export function upsertEpisode(e: Omit<Episode, 'id'>): void {
  getDb().prepare(`
    INSERT INTO episodes (show_tmdb_id, season_number, episode_number, name, overview, still_path, runtime_mins, community_rating, air_date, synced_at)
    VALUES (@showTmdbId, @seasonNumber, @episodeNumber, @name, @overview, @stillPath, @runtimeMins, @communityRating, @airDate, COALESCE(NULLIF(@syncedAt, ''), strftime('%Y-%m-%dT%H:%M:%SZ','now')))
    ON CONFLICT(show_tmdb_id, season_number, episode_number) DO UPDATE SET
      name         = excluded.name,
      overview     = excluded.overview,
      still_path   = excluded.still_path,
      runtime_mins = excluded.runtime_mins,
      community_rating = excluded.community_rating,
      air_date     = excluded.air_date,
      synced_at    = excluded.synced_at
  `).run(e)
}

export function getEpisodesForSeason(showTmdbId: number, seasonNumber: number): Episode[] {
  return (getDb().prepare(
    `SELECT * FROM episodes WHERE show_tmdb_id = ? AND season_number = ? ORDER BY episode_number ASC`
  ).all(showTmdbId, seasonNumber) as Record<string, unknown>[]).map(row2episode)
}

export function getAiredEpisodesForSeason(showTmdbId: number, seasonNumber: number): Episode[] {
  const today = todayIsoDate()
  return (getDb().prepare(
    `SELECT * FROM episodes WHERE show_tmdb_id = ? AND season_number = ?
     AND air_date != '' AND air_date < ? ORDER BY episode_number ASC`
  ).all(showTmdbId, seasonNumber, today) as Record<string, unknown>[]).map(row2episode)
}

export function getEpisodesForShow(showTmdbId: number): Episode[] {
  return (getDb().prepare(
    `SELECT * FROM episodes WHERE show_tmdb_id = ? ORDER BY season_number ASC, episode_number ASC`
  ).all(showTmdbId) as Record<string, unknown>[]).map(row2episode)
}

export function getAllSeasons(): Season[] {
  return (getDb().prepare(
    `SELECT * FROM seasons ORDER BY show_tmdb_id ASC, season_number ASC`
  ).all() as Record<string, unknown>[]).map(row2season)
}

export function getAllAiredEpisodes(): Episode[] {
  const today = todayIsoDate()
  return (getDb().prepare(
    `SELECT * FROM episodes WHERE air_date != '' AND air_date < ?
     ORDER BY show_tmdb_id ASC, season_number ASC, episode_number ASC`
  ).all(today) as Record<string, unknown>[]).map(row2episode)
}

export function countAiredEpisodes(): number {
  const today = todayIsoDate()
  return (getDb().prepare(
    `SELECT COUNT(*) as n FROM episodes WHERE air_date != '' AND air_date < ?`
  ).get(today) as { n: number }).n
}

// ── App settings ──────────────────────────────────────────────────────────────

export function getSetting(key: string): string | null {
  const row = getDb().prepare(`SELECT value FROM app_settings WHERE key = ?`).get(key) as { value: string } | undefined
  return row?.value ?? null
}

export function setSetting(key: string, value: string): void {
  getDb().prepare(
    `INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, value)
}

export function getAllSettings(): Record<string, string> {
  const rows = getDb().prepare(`SELECT key, value FROM app_settings`).all() as { key: string; value: string }[]
  return Object.fromEntries(rows.map(r => [r.key, r.value]))
}

// ── TorBox cleanup jobs ───────────────────────────────────────────────────────

export function upsertTorBoxCleanupJob(downloadUrl: string, torrentId: number, deleteAt: number): void {
  getDb().prepare(`
    INSERT INTO torbox_cleanup_jobs (download_url, torrent_id, delete_at, updated_at)
    VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    ON CONFLICT(download_url) DO UPDATE SET
      torrent_id = excluded.torrent_id,
      delete_at = excluded.delete_at,
      updated_at = excluded.updated_at
  `).run(downloadUrl, torrentId, deleteAt)
}

export function deleteTorBoxCleanupJob(downloadUrl: string): void {
  getDb().prepare(`DELETE FROM torbox_cleanup_jobs WHERE download_url = ?`).run(downloadUrl)
}

export function listTorBoxCleanupJobs(): TorBoxCleanupJob[] {
  const rows = getDb().prepare(`
    SELECT download_url, torrent_id, delete_at, updated_at
    FROM torbox_cleanup_jobs
    ORDER BY delete_at ASC
  `).all() as Array<{ download_url: string; torrent_id: number; delete_at: number; updated_at: string }>
  return rows.map(row => ({
    downloadUrl: row.download_url,
    torrentId: row.torrent_id,
    deleteAt: row.delete_at,
    updatedAt: row.updated_at,
  }))
}

// ── Music catalog ─────────────────────────────────────────────────────────────

export function upsertMusicRelease(release: Omit<MusicRelease, 'lastSeenAt'> & { lastSeenAt?: string }): void {
  getDb().prepare(`
    INSERT INTO music_releases (hash, title, artist, album, year, bytes, seeders, category, resolved_at, last_seen_at)
    VALUES (@hash, @title, @artist, @album, @year, @bytes, @seeders, @category, @resolvedAt, COALESCE(NULLIF(@lastSeenAt, ''), strftime('%Y-%m-%dT%H:%M:%SZ','now')))
    ON CONFLICT(hash) DO UPDATE SET
      title = excluded.title,
      artist = COALESCE(NULLIF(excluded.artist, ''), music_releases.artist),
      album = COALESCE(NULLIF(excluded.album, ''), music_releases.album),
      year = CASE WHEN excluded.year > 0 THEN excluded.year ELSE music_releases.year END,
      bytes = CASE WHEN excluded.bytes > 0 THEN excluded.bytes ELSE music_releases.bytes END,
      seeders = excluded.seeders,
      category = COALESCE(NULLIF(excluded.category, ''), music_releases.category),
      resolved_at = COALESCE(NULLIF(excluded.resolved_at, ''), music_releases.resolved_at),
      last_seen_at = excluded.last_seen_at
  `).run({
    ...release,
    lastSeenAt: release.lastSeenAt ?? '',
  })
}

export function getMusicRelease(hash: string): MusicRelease | null {
  const row = getDb().prepare(`
    SELECT *
    FROM music_releases
    WHERE hash = ?
  `).get(hash.toLowerCase()) as Record<string, unknown> | undefined
  return row ? row2musicRelease(row) : null
}

export function replaceMusicTracks(releaseHash: string, tracks: Array<Omit<MusicTrack, 'createdAt'>>): void {
  const db = getDb()
  db.transaction(() => {
    db.prepare(`DELETE FROM music_tracks WHERE release_hash = ?`).run(releaseHash)
    const insert = db.prepare(`
      INSERT INTO music_tracks (id, release_hash, file_idx, file_path, title, track_num, artist, album, year, bytes, duration_secs, ext)
      VALUES (@id, @releaseHash, @fileIdx, @filePath, @title, @trackNum, @artist, @album, @year, @bytes, @durationSecs, @ext)
    `)
    for (const track of tracks) insert.run(track)
  })()
}

export function getMusicTracksForRelease(releaseHash: string): MusicTrack[] {
  const rows = getDb().prepare(`
    SELECT *
    FROM music_tracks
    WHERE release_hash = ?
    ORDER BY track_num ASC, title COLLATE NOCASE ASC
  `).all(releaseHash.toLowerCase()) as Record<string, unknown>[]
  return rows.map(row2musicTrack)
}

export function searchPlayableMusicReleases(query: string, limit = 25): Array<MusicRelease & { songCount: number; durationSecs: number }> {
  const pattern = `%${query.trim()}%`
  if (!query.trim()) return []
  const rows = getDb().prepare(`
    SELECT
      r.*,
      COUNT(t.id) AS song_count,
      COALESCE(SUM(t.duration_secs), 0) AS duration_secs
    FROM music_releases r
    JOIN music_tracks t ON t.release_hash = r.hash
    WHERE r.artist LIKE ? COLLATE NOCASE
       OR r.album LIKE ? COLLATE NOCASE
       OR r.title LIKE ? COLLATE NOCASE
    GROUP BY r.hash
    ORDER BY r.last_seen_at DESC
    LIMIT ?
  `).all(pattern, pattern, pattern, limit) as Array<Record<string, unknown> & { song_count: number; duration_secs: number }>
  return rows.map(row => ({
    ...row2musicRelease(row),
    songCount: row.song_count ?? 0,
    durationSecs: row.duration_secs ?? 0,
  }))
}

export function replaceMusicCandidates(queryKey: string, releaseHashes: string[]): void {
  const db = getDb()
  db.transaction(() => {
    db.prepare(`DELETE FROM music_candidates WHERE query_key = ?`).run(queryKey)
    const insert = db.prepare(`
      INSERT INTO music_candidates (id, query_key, release_hash, rank)
      VALUES (@id, @queryKey, @releaseHash, @rank)
      ON CONFLICT(query_key, release_hash) DO UPDATE SET
        rank = excluded.rank,
        created_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
    `)
    releaseHashes.forEach((releaseHash, rank) => {
      insert.run({
        id: `${queryKey}:${releaseHash}`,
        queryKey,
        releaseHash,
        rank,
      })
    })
  })()
}

export function listMusicCandidateReleases(queryKey: string, limit = 25): MusicRelease[] {
  const rows = getDb().prepare(`
    SELECT r.*
    FROM music_candidates c
    JOIN music_releases r ON r.hash = c.release_hash
    WHERE c.query_key = ?
    ORDER BY c.rank ASC
    LIMIT ?
  `).all(queryKey, limit) as Record<string, unknown>[]
  return rows.map(row2musicRelease)
}

export function upsertMusicMetaAlbum(album: Omit<MusicMetaAlbum, 'updatedAt'> & { updatedAt?: string }): void {
  getDb().prepare(`
    INSERT INTO music_meta_albums (id, source, source_id, name, artist, year, artwork_url, track_count, duration_secs, updated_at)
    VALUES (@id, @source, @sourceId, @name, @artist, @year, @artworkUrl, @trackCount, @durationSecs, COALESCE(NULLIF(@updatedAt, ''), strftime('%Y-%m-%dT%H:%M:%SZ','now')))
    ON CONFLICT(id) DO UPDATE SET
      source = excluded.source,
      source_id = excluded.source_id,
      name = excluded.name,
      artist = excluded.artist,
      year = excluded.year,
      artwork_url = excluded.artwork_url,
      track_count = excluded.track_count,
      duration_secs = excluded.duration_secs,
      updated_at = excluded.updated_at
  `).run({
    ...album,
    updatedAt: album.updatedAt ?? '',
  })
}

export function getMusicMetaAlbum(id: string): MusicMetaAlbum | null {
  const row = getDb().prepare(`
    SELECT *
    FROM music_meta_albums
    WHERE id = ?
  `).get(id) as Record<string, unknown> | undefined
  return row ? row2musicMetaAlbum(row) : null
}

export function replaceMusicMetaTracks(albumId: string, tracks: Array<Omit<MusicMetaTrack, 'updatedAt' | 'youtubeId' | 'youtubeResolvedAt'> & { youtubeId?: string; youtubeResolvedAt?: string; updatedAt?: string }>): void {
  const db = getDb()
  db.transaction(() => {
    db.prepare(`DELETE FROM music_meta_tracks WHERE album_id = ?`).run(albumId)
    const insert = db.prepare(`
      INSERT INTO music_meta_tracks (id, album_id, source_track_id, title, artist, album, track_num, disc_num, duration_secs, artwork_url, youtube_id, youtube_resolved_at, updated_at)
      VALUES (@id, @albumId, @sourceTrackId, @title, @artist, @album, @trackNum, @discNum, @durationSecs, @artworkUrl, @youtubeId, @youtubeResolvedAt, COALESCE(NULLIF(@updatedAt, ''), strftime('%Y-%m-%dT%H:%M:%SZ','now')))
      ON CONFLICT(id) DO UPDATE SET
        album_id = excluded.album_id,
        source_track_id = excluded.source_track_id,
        title = excluded.title,
        artist = excluded.artist,
        album = excluded.album,
        track_num = excluded.track_num,
        disc_num = excluded.disc_num,
        duration_secs = excluded.duration_secs,
        artwork_url = excluded.artwork_url,
        youtube_id = COALESCE(NULLIF(music_meta_tracks.youtube_id, ''), excluded.youtube_id),
        youtube_resolved_at = COALESCE(NULLIF(music_meta_tracks.youtube_resolved_at, ''), excluded.youtube_resolved_at),
        updated_at = excluded.updated_at
    `)
    for (const track of tracks) {
      insert.run({
        ...track,
        youtubeId: track.youtubeId ?? '',
        youtubeResolvedAt: track.youtubeResolvedAt ?? '',
        updatedAt: track.updatedAt ?? '',
      })
    }
  })()
}

export function getMusicMetaTrack(id: string): MusicMetaTrack | null {
  const row = getDb().prepare(`
    SELECT *
    FROM music_meta_tracks
    WHERE id = ?
  `).get(id) as Record<string, unknown> | undefined
  return row ? row2musicMetaTrack(row) : null
}

export function getMusicMetaTracksForAlbum(albumId: string): MusicMetaTrack[] {
  const rows = getDb().prepare(`
    SELECT *
    FROM music_meta_tracks
    WHERE album_id = ?
    ORDER BY disc_num ASC, track_num ASC, title COLLATE NOCASE ASC
  `).all(albumId) as Record<string, unknown>[]
  return rows.map(row2musicMetaTrack)
}

export function setMusicMetaTrackYoutubeId(id: string, youtubeId: string): void {
  getDb().prepare(`
    UPDATE music_meta_tracks
    SET youtube_id = ?,
        youtube_resolved_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
    WHERE id = ?
  `).run(youtubeId, id)
}

// ── App users ────────────────────────────────────────────────────────────────

export function listUsers(): AppUser[] {
  const rows = getDb().prepare(`
    SELECT * FROM app_users
    ORDER BY CASE role WHEN 'admin' THEN 0 ELSE 1 END ASC, username COLLATE NOCASE ASC
  `).all() as Record<string, unknown>[]
  return rows.map(row2appUser)
}

export function countUsers(): number {
  return (getDb().prepare(`SELECT COUNT(*) AS n FROM app_users`).get() as { n: number }).n
}

export function getUserById(userId: string): AppUser | null {
  const row = getDb().prepare(`SELECT * FROM app_users WHERE id = ?`).get(userId) as Record<string, unknown> | undefined
  return row ? row2appUser(row) : null
}

export function getUserByUsername(username: string): AppUser | null {
  const normalized = normalizeUsername(username)
  if (!normalized) return null
  const row = getDb().prepare(`SELECT * FROM app_users WHERE username = ? COLLATE NOCASE`).get(normalized) as Record<string, unknown> | undefined
  return row ? row2appUser(row) : null
}

export function verifyUserCredentials(username: string, password: string): AppUser | null {
  const user = getUserByUsername(username)
  if (!user || !user.passwordHash) return null
  return verifyPasswordHash(password, user.passwordHash) ? user : null
}

export function createUser(username: string, password: string, role: AppUserRole, maxRating: string): AppUser {
  const normalized = normalizeUsername(username)
  if (!normalized) throw new Error('Username is required')
  if (!password.trim()) throw new Error('Password is required')
  const id = role === 'admin' && countUsers() === 0 ? DEFAULT_ADMIN_USER_ID : randomGuidLikeId()
  const effectiveMaxRating = effectiveMaxRatingForRole(role, maxRating)
  getDb().prepare(`
    INSERT INTO app_users (id, username, password_hash, role, max_rating, updated_at)
    VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
  `).run(id, normalized, hashPassword(password), role, effectiveMaxRating)
  return getUserById(id)!
}

export function updateUser(
  userId: string,
  updates: { username?: string; password?: string; role?: AppUserRole; maxRating?: string },
): AppUser {
  const existing = getUserById(userId)
  if (!existing) throw new Error('User not found')
  const username = updates.username != null ? normalizeUsername(updates.username) : existing.username
  const role = updates.role ?? existing.role
  const maxRating = effectiveMaxRatingForRole(role, updates.maxRating != null ? updates.maxRating : existing.maxRating)
  const passwordHash = updates.password && updates.password.trim()
    ? hashPassword(updates.password)
    : existing.passwordHash
  if (!username) throw new Error('Username is required')
  if (existing.role === 'admin' && role !== 'admin') {
    const admins = getDb().prepare(`SELECT COUNT(*) AS n FROM app_users WHERE role = 'admin'`).get() as { n: number }
    if (admins.n <= 1) throw new Error('Cannot demote the last admin')
  }
  getDb().prepare(`
    UPDATE app_users
    SET username = ?, password_hash = ?, role = ?, max_rating = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
    WHERE id = ?
  `).run(username, passwordHash, role, maxRating, userId)
  return getUserById(userId)!
}

export function deleteUser(userId: string): void {
  const db = getDb()
  const user = getUserById(userId)
  if (!user) return
  if (user.role === 'admin') {
    const admins = db.prepare(`SELECT COUNT(*) AS n FROM app_users WHERE role = 'admin'`).get() as { n: number }
    if (admins.n <= 1) throw new Error('Cannot delete the last admin')
  }
  db.transaction(() => {
    db.prepare(`DELETE FROM ui_sessions WHERE user_id = ?`).run(userId)
    db.prepare(`DELETE FROM user_item_data WHERE user_id = ?`).run(userId)
    db.prepare(`DELETE FROM app_users WHERE id = ?`).run(userId)
  })()
}

export function authEnabled(): boolean {
  return countUsers() > 0
}

export function purgeExpiredUiSessions(now = Date.now()): number {
  const info = getDb().prepare(`DELETE FROM ui_sessions WHERE expires_at <= ?`).run(now)
  return info.changes
}

export function createUiSession(token: string, userId: string, expiresAt: number): void {
  purgeExpiredUiSessions()
  getDb().prepare(`
    INSERT INTO ui_sessions (token, user_id, expires_at, created_at)
    VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    ON CONFLICT(token) DO UPDATE SET
      user_id = excluded.user_id,
      expires_at = excluded.expires_at
  `).run(token, userId, expiresAt)
}

export function getUiSession(token: string): UiSession | null {
  const row = getDb().prepare(`SELECT * FROM ui_sessions WHERE token = ?`).get(token) as Record<string, unknown> | undefined
  if (!row) return null
  const session = row2uiSession(row)
  if (session.expiresAt <= Date.now()) {
    getDb().prepare(`DELETE FROM ui_sessions WHERE token = ?`).run(token)
    return null
  }
  return session
}

export function deleteUiSession(token: string): void {
  getDb().prepare(`DELETE FROM ui_sessions WHERE token = ?`).run(token)
}

function normalizeOfficialRating(rating: string): string {
  const raw = rating.trim().toUpperCase()
  if (!raw) return ''
  const compact = raw.replace(/\s+/g, '').replace(/_/g, '-')
  if (compact === 'TVY') return 'TV-Y'
  if (compact === 'TVY7' || compact === 'TVY7FV' || compact === 'TV-Y7-FV' || compact === 'Y7FV') return 'TV-Y7'
  if (compact === 'TVG') return 'TV-G'
  if (compact === 'TVPG') return 'TV-PG'
  if (compact === 'TV14') return 'TV-14'
  if (compact === 'TVMA') return 'TV-MA'
  if (compact === 'PG13') return 'PG-13'
  if (compact === 'NC17') return 'NC-17'
  if (compact === 'NOTRATED' || compact === 'UNRATED' || compact === 'NR' || compact === 'UR') return 'UNRATED'
  return compact
}

function ratingSeverity(rating: string): number | null {
  switch (normalizeOfficialRating(rating)) {
    case 'G':
    case 'TV-Y':
    case 'TV-G':
      return 0
    case 'PG':
    case 'TV-Y7':
    case 'TV-PG':
      return 1
    case 'PG-13':
    case 'TV-14':
      return 2
    case 'R':
    case 'TV-MA':
      return 3
    case 'NC-17':
      return 4
    default:
      return null
  }
}

export function canUserAccessRating(maxRating: string, officialRating: string): boolean {
  const normalizedMax = normalizeMaxRating(maxRating)
  if (normalizedMax === 'unrestricted') return true
  const limit = Number.parseInt(normalizedMax, 10)
  const actual = ratingSeverity(officialRating)
  if (!Number.isFinite(limit)) return true
  if (actual == null) return true
  return actual <= limit
}

export function canUserAccessKnownRating(maxRating: string, officialRating: string): boolean {
  const normalizedMax = normalizeMaxRating(maxRating)
  if (normalizedMax === 'unrestricted') return true
  const limit = Number.parseInt(normalizedMax, 10)
  const actual = ratingSeverity(officialRating)
  if (!Number.isFinite(limit)) return true
  if (actual == null) return false
  return actual <= limit
}

export function hasRatingLimit(user: Pick<AppUser, 'role' | 'maxRating'>): boolean {
  if (user.role === 'admin') return false
  return normalizeMaxRating(user.maxRating) !== 'unrestricted'
}

export function canUserAccessMovie(user: Pick<AppUser, 'role' | 'maxRating'>, movie: Pick<Movie, 'officialRating'>): boolean {
  if (user.role === 'admin') return true
  return canUserAccessKnownRating(effectiveMaxRatingForRole(user.role, user.maxRating), movie.officialRating)
}

export function canUserAccessShow(user: Pick<AppUser, 'role' | 'maxRating'>, show: Pick<Show, 'officialRating'>): boolean {
  if (user.role === 'admin') return true
  return canUserAccessKnownRating(effectiveMaxRatingForRole(user.role, user.maxRating), show.officialRating)
}

function row2manualShowSubscription(r: Record<string, unknown>): ManualShowSubscription {
  return {
    showTmdbId:         r.show_tmdb_id as number,
    mode:               r.mode as ManualShowMode,
    activeSeasonNumber: r.active_season_number as number,
    updatedAt:          r.updated_at as string,
  }
}

function row2uiSession(r: Record<string, unknown>): UiSession {
  return {
    token: r.token as string,
    userId: r.user_id as string,
    expiresAt: Number(r.expires_at ?? 0),
    createdAt: r.created_at as string,
  }
}

export function upsertManualShowSubscription(
  showTmdbId: number,
  mode: ManualShowMode,
  activeSeasonNumber = 0,
): void {
  getDb().prepare(`
    INSERT INTO manual_show_subscriptions (show_tmdb_id, mode, active_season_number, updated_at)
    VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    ON CONFLICT(show_tmdb_id) DO UPDATE SET
      mode = excluded.mode,
      active_season_number = excluded.active_season_number,
      updated_at = excluded.updated_at
  `).run(showTmdbId, mode, activeSeasonNumber)
}

export function getManualShowSubscription(showTmdbId: number): ManualShowSubscription | null {
  const row = getDb().prepare(`
    SELECT * FROM manual_show_subscriptions WHERE show_tmdb_id = ?
  `).get(showTmdbId)
  return row ? row2manualShowSubscription(row as Record<string, unknown>) : null
}

export function listLatestSeasonShowSubscriptions(): ManualShowSubscription[] {
  return (getDb().prepare(`
    SELECT * FROM manual_show_subscriptions
    WHERE mode = 'latest'
    ORDER BY show_tmdb_id ASC
  `).all() as Record<string, unknown>[]).map(row2manualShowSubscription)
}

export function materializeShowDefaultModeForExistingLibrary(mode: ManualShowMode): number {
  const today = sqlStringLiteral(todayIsoDate())
  const latestSeasonNumberExpr = `
    COALESCE((
      SELECT MAX(s.season_number)
      FROM seasons s
      WHERE s.show_tmdb_id = si.tmdb_id
        AND s.season_number > 0
        AND s.air_date != ''
        AND s.air_date < ${today}
    ), (
      SELECT MAX(s.season_number)
      FROM seasons s
      WHERE s.show_tmdb_id = si.tmdb_id
        AND s.season_number > 0
    ), 0)
  `
  const info = getDb().prepare(`
    INSERT INTO manual_show_subscriptions (show_tmdb_id, mode, active_season_number, updated_at)
    SELECT DISTINCT
      si.tmdb_id,
      ?,
      CASE WHEN ? = 'latest' THEN ${latestSeasonNumberExpr} ELSE 0 END,
      strftime('%Y-%m-%dT%H:%M:%SZ','now')
    FROM source_items si
    WHERE si.media_type = 'show'
      AND NOT EXISTS (
        SELECT 1
        FROM manual_show_subscriptions ms
        WHERE ms.show_tmdb_id = si.tmdb_id
      )
  `).run(mode, mode)
  return info.changes
}

export function removeManualShowSubscription(showTmdbId: number): number {
  const info = getDb().prepare(`
    DELETE FROM manual_show_subscriptions WHERE show_tmdb_id = ?
  `).run(showTmdbId)
  return info.changes
}

export function getLatestSeasonNumberForShow(showTmdbId: number): number | null {
  const today = todayIsoDate()
  const aired = getDb().prepare(`
    SELECT MAX(season_number) as n
    FROM seasons
    WHERE show_tmdb_id = ?
      AND season_number > 0
      AND air_date != ''
      AND air_date < ?
  `).get(showTmdbId, today) as { n: number | null }
  if (aired.n) return aired.n

  const anySeason = getDb().prepare(`
    SELECT MAX(season_number) as n
    FROM seasons
    WHERE show_tmdb_id = ?
      AND season_number > 0
  `).get(showTmdbId) as { n: number | null }
  return anySeason.n ?? null
}

export function getEffectiveShowMode(showTmdbId: number): {
  mode: ManualShowMode
  manualMode: ManualShowMode | null
  activeSeasonNumber: number | null
} {
  const manual = getManualShowSubscription(showTmdbId)
  if (!manual) {
    return { mode: 'all', manualMode: null, activeSeasonNumber: null }
  }
  return {
    mode: manual.mode,
    manualMode: manual.mode,
    activeSeasonNumber: manual.mode === 'latest'
      ? (manual.activeSeasonNumber || getLatestSeasonNumberForShow(showTmdbId))
      : null,
  }
}

export function listManualShowSubscriptionsById(showTmdbIds: number[]): Map<number, ManualShowSubscription> {
  const ids = uniqTmdbIds(showTmdbIds)
  if (!ids.length) return new Map()
  const rows = getDb().prepare(`
    SELECT *
    FROM manual_show_subscriptions
    WHERE show_tmdb_id IN (${sqlPlaceholders(ids.length)})
  `).all(...ids) as Record<string, unknown>[]
  return new Map(rows.map(row => {
    const sub = row2manualShowSubscription(row)
    return [sub.showTmdbId, sub]
  }))
}

function uniqTmdbIds(tmdbIds: number[]): number[] {
  return [...new Set(tmdbIds)].sort((a, b) => a - b)
}

function sqlPlaceholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ')
}

export function addSourceItem(sourceKey: string, mediaType: MediaType, tmdbId: number): void {
  getDb().prepare(`
    INSERT INTO source_items (source_key, media_type, tmdb_id, synced_at)
    VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    ON CONFLICT(source_key, media_type, tmdb_id) DO UPDATE SET
      synced_at = excluded.synced_at
  `).run(sourceKey, mediaType, tmdbId)
}

export function hasSourceItem(sourceKey: string, mediaType: MediaType, tmdbId: number): boolean {
  const row = getDb().prepare(`
    SELECT 1
    FROM source_items
    WHERE source_key = ? AND media_type = ? AND tmdb_id = ?
    LIMIT 1
  `).get(sourceKey, mediaType, tmdbId)
  return !!row
}

export function hasAnySourceItem(mediaType: MediaType, tmdbId: number): boolean {
  const row = getDb().prepare(`
    SELECT 1
    FROM source_items
    WHERE media_type = ? AND tmdb_id = ?
    LIMIT 1
  `).get(mediaType, tmdbId)
  return !!row
}

export function isLibraryItemHidden(mediaType: MediaType, tmdbId: number): boolean {
  const row = getDb().prepare(`
    SELECT 1
    FROM hidden_library_items
    WHERE media_type = ? AND tmdb_id = ?
    LIMIT 1
  `).get(mediaType, tmdbId)
  return !!row
}

export function hideLibraryItem(mediaType: MediaType, tmdbId: number): void {
  getDb().prepare(`
    INSERT INTO hidden_library_items (media_type, tmdb_id, hidden_at)
    VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    ON CONFLICT(media_type, tmdb_id) DO UPDATE SET
      hidden_at = excluded.hidden_at
  `).run(mediaType, tmdbId)
}

export function unhideLibraryItem(mediaType: MediaType, tmdbId: number): number {
  const info = getDb().prepare(`
    DELETE FROM hidden_library_items
    WHERE media_type = ? AND tmdb_id = ?
  `).run(mediaType, tmdbId)
  return info.changes
}

export function listHiddenLibraryItems(limit = 200, offset = 0): HiddenLibraryItem[] {
  const rows = getDb().prepare(`
    SELECT media_type, tmdb_id, hidden_at
    FROM hidden_library_items
    ORDER BY hidden_at DESC
    LIMIT ? OFFSET ?
  `).all(limit, offset) as { media_type: MediaType; tmdb_id: number; hidden_at: string }[]
  return rows.map(row => ({
    mediaType: row.media_type,
    tmdbId: row.tmdb_id,
    hiddenAt: row.hidden_at,
  }))
}

export function countHiddenLibraryItems(): number {
  return (getDb().prepare(`
    SELECT COUNT(*) AS n
    FROM hidden_library_items
  `).get() as { n: number }).n
}

export function listSourceKeys(prefix?: string): string[] {
  const rows = prefix
    ? getDb().prepare(`
        SELECT DISTINCT source_key
        FROM source_items
        WHERE source_key LIKE ?
        ORDER BY source_key ASC
      `).all(`${prefix}%`)
    : getDb().prepare(`
        SELECT DISTINCT source_key
        FROM source_items
        ORDER BY source_key ASC
      `).all()
  return (rows as { source_key: string }[]).map(r => r.source_key)
}

export function listSourceItems(sourceKey: string): Array<{ mediaType: MediaType; tmdbId: number }> {
  const rows = getDb().prepare(`
    SELECT media_type, tmdb_id
    FROM source_items
    WHERE source_key = ?
    ORDER BY media_type ASC, tmdb_id ASC
  `).all(sourceKey) as Array<{ media_type: MediaType; tmdb_id: number }>
  return rows.map(row => ({ mediaType: row.media_type, tmdbId: row.tmdb_id }))
}

export function listSourceKeysForItem(mediaType: MediaType, tmdbId: number): string[] {
  const rows = getDb().prepare(`
    SELECT source_key
    FROM source_items
    WHERE media_type = ? AND tmdb_id = ?
    ORDER BY source_key ASC
  `).all(mediaType, tmdbId) as { source_key: string }[]
  return rows.map(row => row.source_key)
}

export function listSourceKeysForItems(mediaType: MediaType, tmdbIds: number[]): Map<number, string[]> {
  const ids = uniqTmdbIds(tmdbIds)
  if (!ids.length) return new Map()
  const rows = getDb().prepare(`
    SELECT tmdb_id, source_key
    FROM source_items
    WHERE media_type = ?
      AND tmdb_id IN (${sqlPlaceholders(ids.length)})
    ORDER BY tmdb_id ASC, source_key ASC
  `).all(mediaType, ...ids) as Array<{ tmdb_id: number; source_key: string }>
  const out = new Map<number, string[]>()
  for (const row of rows) {
    const sourceKeys = out.get(row.tmdb_id) ?? []
    sourceKeys.push(row.source_key)
    out.set(row.tmdb_id, sourceKeys)
  }
  return out
}

export function listAiredShowTmdbIds(showTmdbIds: number[]): Set<number> {
  const ids = uniqTmdbIds(showTmdbIds)
  if (!ids.length) return new Set()
  const today = todayIsoDate()
  const rows = getDb().prepare(`
    SELECT DISTINCT show_tmdb_id
    FROM episodes
    WHERE show_tmdb_id IN (${sqlPlaceholders(ids.length)})
      AND air_date != ''
      AND air_date < ?
  `).all(...ids, today) as Array<{ show_tmdb_id: number }>
  return new Set(rows.map(row => row.show_tmdb_id))
}

export function removeSourceKey(sourceKey: string, mediaType: MediaType): number[] {
  const db = getDb()
  const tmdbIds = (db.prepare(`
    SELECT tmdb_id
    FROM source_items
    WHERE source_key = ? AND media_type = ?
    ORDER BY tmdb_id ASC
  `).all(sourceKey, mediaType) as { tmdb_id: number }[]).map(r => r.tmdb_id)

  if (!tmdbIds.length) return []

  db.prepare(`
    DELETE FROM source_items
    WHERE source_key = ? AND media_type = ?
  `).run(sourceKey, mediaType)

  return tmdbIds
}

export function removeSourceItem(sourceKey: string, mediaType: MediaType, tmdbId: number): number {
  const info = getDb().prepare(`
    DELETE FROM source_items
    WHERE source_key = ? AND media_type = ? AND tmdb_id = ?
  `).run(sourceKey, mediaType, tmdbId)
  return info.changes
}

export function replaceSourceItems(
  sourceKey: string,
  mediaType: MediaType,
  tmdbIds: number[],
): number[] {
  const db = getDb()
  const ids = uniqTmdbIds(tmdbIds)
  const current = (db.prepare(
    `SELECT tmdb_id FROM source_items WHERE source_key = ? AND media_type = ?`
  ).all(sourceKey, mediaType) as { tmdb_id: number }[]).map(r => r.tmdb_id)

  const nextSet = new Set(ids)
  const removed = current.filter(id => !nextSet.has(id))

  const insertStmt = db.prepare(`
    INSERT INTO source_items (source_key, media_type, tmdb_id, synced_at)
    VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    ON CONFLICT(source_key, media_type, tmdb_id) DO UPDATE SET
      synced_at = excluded.synced_at
  `)

  db.transaction(() => {
    for (const id of ids) insertStmt.run(sourceKey, mediaType, id)

    if (!ids.length) {
      db.prepare(`DELETE FROM source_items WHERE source_key = ? AND media_type = ?`).run(sourceKey, mediaType)
      return
    }

    if (removed.length) {
      db.prepare(`
        DELETE FROM source_items
        WHERE source_key = ? AND media_type = ? AND tmdb_id IN (${sqlPlaceholders(removed.length)})
      `).run(sourceKey, mediaType, ...removed)
    }
  })()

  return removed
}

function findOrphanedTmdbIds(mediaType: MediaType, tmdbIds: number[]): number[] {
  const ids = uniqTmdbIds(tmdbIds)
  if (!ids.length) return []
  const table = mediaType === 'movie' ? 'movies' : 'shows'
  return (getDb().prepare(`
    SELECT tmdb_id
    FROM ${table}
    WHERE tmdb_id IN (${sqlPlaceholders(ids.length)})
      AND NOT EXISTS (
        SELECT 1
        FROM source_items si
        WHERE si.media_type = ?
          AND si.tmdb_id = ${table}.tmdb_id
      )
  `).all(...ids, mediaType) as { tmdb_id: number }[]).map(r => r.tmdb_id)
}

function findAllOrphanedTmdbIds(mediaType: MediaType): number[] {
  const table = mediaType === 'movie' ? 'movies' : 'shows'
  return (getDb().prepare(`
    SELECT tmdb_id
    FROM ${table}
    WHERE NOT EXISTS (
      SELECT 1
      FROM source_items si
      WHERE si.media_type = ?
        AND si.tmdb_id = ${table}.tmdb_id
    )
    ORDER BY tmdb_id ASC
  `).all(mediaType) as { tmdb_id: number }[]).map(r => r.tmdb_id)
}

export function pruneOrphanedMovies(tmdbIds: number[]): number {
  const orphaned = findOrphanedTmdbIds('movie', tmdbIds)
  if (!orphaned.length) return 0
  const db = getDb()
  db.transaction(() => {
    db.prepare(`DELETE FROM movie_release_preferences WHERE movie_tmdb_id IN (${sqlPlaceholders(orphaned.length)})`).run(...orphaned)
    db.prepare(`DELETE FROM manual_movie_availability_overrides WHERE movie_tmdb_id IN (${sqlPlaceholders(orphaned.length)})`).run(...orphaned)
    db.prepare(`DELETE FROM hidden_library_items WHERE media_type = 'movie' AND tmdb_id IN (${sqlPlaceholders(orphaned.length)})`).run(...orphaned)
    db.prepare(`DELETE FROM movies WHERE tmdb_id IN (${sqlPlaceholders(orphaned.length)})`).run(...orphaned)
  })()
  return orphaned.length
}

export function pruneAllOrphanedMovies(): number {
  return pruneOrphanedMovies(findAllOrphanedTmdbIds('movie'))
}

export function pruneOrphanedShows(tmdbIds: number[]): number {
  const orphaned = findOrphanedTmdbIds('show', tmdbIds)
  if (!orphaned.length) return 0

  const db = getDb()
  db.transaction(() => {
    db.prepare(`DELETE FROM manual_show_subscriptions WHERE show_tmdb_id IN (${sqlPlaceholders(orphaned.length)})`).run(...orphaned)
    db.prepare(`DELETE FROM hidden_library_items WHERE media_type = 'show' AND tmdb_id IN (${sqlPlaceholders(orphaned.length)})`).run(...orphaned)
    db.prepare(`DELETE FROM episodes WHERE show_tmdb_id IN (${sqlPlaceholders(orphaned.length)})`).run(...orphaned)
    db.prepare(`DELETE FROM seasons WHERE show_tmdb_id IN (${sqlPlaceholders(orphaned.length)})`).run(...orphaned)
    db.prepare(`DELETE FROM shows WHERE tmdb_id IN (${sqlPlaceholders(orphaned.length)})`).run(...orphaned)
  })()

  return orphaned.length
}

export function pruneAllOrphanedShows(): number {
  return pruneOrphanedShows(findAllOrphanedTmdbIds('show'))
}

// ── User data (watch state) ────────────────────────────────────────────────────

export interface UserData {
  played:          boolean
  playCount:       number
  positionTicks:   number
  lastPlayedDate:  string
}

const MIN_RESUME_TICKS = 2 * 60 * 10_000_000

export function getUserData(itemId: string, userId = DEFAULT_ADMIN_USER_ID): UserData {
  const r = getDb().prepare(`SELECT * FROM user_item_data WHERE user_id = ? AND item_id = ?`).get(userId, itemId) as Record<string, unknown> | undefined
  if (!r) return { played: false, playCount: 0, positionTicks: 0, lastPlayedDate: '' }
  const positionTicks = Math.max(0, Number(r.position_ticks ?? 0))
  return {
    played:         !!(r.played as number),
    playCount:       r.play_count       as number,
    positionTicks:   positionTicks >= MIN_RESUME_TICKS ? positionTicks : 0,
    lastPlayedDate:  r.last_played_date as string,
  }
}

export function clearProgress(itemId: string, userId = DEFAULT_ADMIN_USER_ID): void {
  getDb().prepare(`
    INSERT INTO user_item_data (user_id, item_id, position_ticks)
    VALUES (?, ?, 0)
    ON CONFLICT(user_id, item_id) DO UPDATE SET position_ticks = 0
  `).run(userId, itemId)
}

export function saveProgress(itemId: string, positionTicks: number, userId = DEFAULT_ADMIN_USER_ID): void {
  if (positionTicks < MIN_RESUME_TICKS) {
    const existing = getUserData(itemId, userId)
    if (existing.positionTicks >= MIN_RESUME_TICKS) return
    clearProgress(itemId, userId)
    return
  }
  const now = new Date().toISOString()
  getDb().prepare(`
    INSERT INTO user_item_data (user_id, item_id, played, position_ticks, last_played_date, watch_state_source, watch_state_updated_at)
    VALUES (?, ?, 0, ?, ?, 'local', ?)
    ON CONFLICT(user_id, item_id) DO UPDATE SET position_ticks = excluded.position_ticks
                                               , played = 0
                                               , last_played_date = excluded.last_played_date
                                               , watch_state_source = 'local'
                                               , watch_state_updated_at = excluded.watch_state_updated_at
  `).run(userId, itemId, positionTicks, now, now)
}

export function listResumeItemIds(limit = 50, offset = 0, userId = DEFAULT_ADMIN_USER_ID): string[] {
  const rows = getDb().prepare(`
    SELECT item_id
    FROM user_item_data
    WHERE user_id = ?
      AND position_ticks >= ?
      AND played = 0
    ORDER BY
      CASE WHEN last_played_date = '' THEN 1 ELSE 0 END,
      last_played_date DESC,
      item_id ASC
    LIMIT ?
    OFFSET ?
  `).all(userId, MIN_RESUME_TICKS, limit, offset) as Array<{ item_id: string }>
  return rows.map(r => r.item_id)
}

export function countResumeItems(userId = DEFAULT_ADMIN_USER_ID): number {
  const row = getDb().prepare(`
    SELECT COUNT(*) AS n
    FROM user_item_data
    WHERE user_id = ?
      AND position_ticks >= ?
      AND played = 0
  `).get(userId, MIN_RESUME_TICKS) as { n: number }
  return row.n
}

export function getAllPlayedItemIds(userId = DEFAULT_ADMIN_USER_ID): Set<string> {
  const rows = getDb().prepare(`
    SELECT item_id
    FROM user_item_data
    WHERE user_id = ?
      AND played = 1
  `).all(userId) as Array<{ item_id: string }>
  return new Set(rows.map(r => r.item_id))
}

export function markPlayed(itemId: string, userId = DEFAULT_ADMIN_USER_ID): void {
  const now = new Date().toISOString()
  getDb().prepare(`
    INSERT INTO user_item_data (user_id, item_id, played, play_count, position_ticks, last_played_date, watch_state_source, watch_state_updated_at)
    VALUES (?, ?, 1, 1, 0, ?, 'local', ?)
    ON CONFLICT(user_id, item_id) DO UPDATE SET
      played                 = 1,
      play_count             = play_count + 1,
      position_ticks         = 0,
      last_played_date       = excluded.last_played_date,
      watch_state_source     = 'local',
      watch_state_updated_at = excluded.watch_state_updated_at
  `).run(userId, itemId, now, now)
}

export function syncPlayed(itemId: string, lastPlayedDate: string, userId = DEFAULT_ADMIN_USER_ID): void {
  const playedAt = lastPlayedDate || new Date().toISOString()
  const now = new Date().toISOString()
  getDb().prepare(`
    INSERT INTO user_item_data (user_id, item_id, played, play_count, position_ticks, last_played_date, watch_state_source, watch_state_updated_at, trakt_last_watched_at)
    VALUES (?, ?, 1, 1, 0, ?, 'trakt', ?, ?)
    ON CONFLICT(user_id, item_id) DO UPDATE SET
      played = CASE
        WHEN user_item_data.watch_state_source = 'local'
          AND user_item_data.watch_state_updated_at >= excluded.trakt_last_watched_at THEN user_item_data.played
        ELSE 1
      END,
      play_count = CASE
        WHEN user_item_data.watch_state_source = 'local'
          AND user_item_data.watch_state_updated_at >= excluded.trakt_last_watched_at THEN user_item_data.play_count
        WHEN user_item_data.play_count > 0 THEN user_item_data.play_count
        ELSE 1
      END,
      position_ticks = CASE
        WHEN user_item_data.watch_state_source = 'local'
          AND user_item_data.watch_state_updated_at >= excluded.trakt_last_watched_at THEN user_item_data.position_ticks
        ELSE 0
      END,
      last_played_date = CASE
        WHEN user_item_data.watch_state_source = 'local'
          AND user_item_data.watch_state_updated_at >= excluded.trakt_last_watched_at THEN user_item_data.last_played_date
        WHEN user_item_data.last_played_date = '' THEN excluded.last_played_date
        WHEN excluded.last_played_date = '' THEN user_item_data.last_played_date
        WHEN excluded.last_played_date > user_item_data.last_played_date THEN excluded.last_played_date
        ELSE user_item_data.last_played_date
      END,
      watch_state_source = CASE
        WHEN user_item_data.watch_state_source = 'local'
          AND user_item_data.watch_state_updated_at >= excluded.trakt_last_watched_at THEN user_item_data.watch_state_source
        ELSE 'trakt'
      END,
      watch_state_updated_at = CASE
        WHEN user_item_data.watch_state_source = 'local'
          AND user_item_data.watch_state_updated_at >= excluded.trakt_last_watched_at THEN user_item_data.watch_state_updated_at
        ELSE excluded.watch_state_updated_at
      END,
      trakt_last_watched_at = CASE
        WHEN excluded.trakt_last_watched_at > user_item_data.trakt_last_watched_at THEN excluded.trakt_last_watched_at
        ELSE user_item_data.trakt_last_watched_at
      END
  `).run(userId, itemId, playedAt, now, playedAt)
}

export function markUnplayed(itemId: string, userId = DEFAULT_ADMIN_USER_ID): void {
  const now = new Date().toISOString()
  getDb().prepare(`
    INSERT INTO user_item_data (user_id, item_id, played, play_count, position_ticks, last_played_date, watch_state_source, watch_state_updated_at)
    VALUES (?, ?, 0, 0, 0, '', 'local', ?)
    ON CONFLICT(user_id, item_id) DO UPDATE SET
      played                 = 0,
      play_count             = 0,
      position_ticks         = 0,
      last_played_date       = '',
      watch_state_source     = 'local',
      watch_state_updated_at = excluded.watch_state_updated_at
  `).run(userId, itemId, now)
}
