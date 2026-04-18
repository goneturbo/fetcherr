import Database from 'better-sqlite3'
import { config } from './config.js'

export interface Movie {
  id:                 number
  tmdbId:             number
  imdbId:             string
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

CREATE TABLE IF NOT EXISTS source_items (
  source_key TEXT    NOT NULL,
  media_type TEXT    NOT NULL CHECK (media_type IN ('movie', 'show')),
  tmdb_id    INTEGER NOT NULL,
  synced_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  PRIMARY KEY (source_key, media_type, tmdb_id)
);
CREATE INDEX IF NOT EXISTS source_items_media ON source_items(media_type, tmdb_id);

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

CREATE TABLE IF NOT EXISTS user_data (
  item_id          TEXT    PRIMARY KEY,
  played           INTEGER NOT NULL DEFAULT 0,
  play_count       INTEGER NOT NULL DEFAULT 0,
  position_ticks   INTEGER NOT NULL DEFAULT 0,
  last_played_date TEXT    NOT NULL DEFAULT ''
);
`

let _db: Database.Database | null = null

export function getDb(): Database.Database {
  if (!_db) {
    _db = new Database(config.dbPath)
    _db.pragma('journal_mode = WAL')
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
    try { _db.exec(`CREATE INDEX IF NOT EXISTS shows_imdb_id ON shows(imdb_id)`) } catch { /* already exists */ }
    try { _db.exec(`ALTER TABLE episodes ADD COLUMN community_rating REAL NOT NULL DEFAULT 0`) } catch { /* already exists */ }
    try { _db.exec(`ALTER TABLE movies ADD COLUMN release_date TEXT NOT NULL DEFAULT ''`) } catch { /* already exists */ }
    try { _db.exec(`ALTER TABLE movies ADD COLUMN digital_release_date TEXT NOT NULL DEFAULT ''`) } catch { /* already exists */ }
  }
  return _db
}

function row2movie(r: Record<string, unknown>): Movie {
  return {
    id:           r.id            as number,
    tmdbId:       r.tmdb_id       as number,
    imdbId:       r.imdb_id       as string,
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
    INSERT INTO movies (tmdb_id, imdb_id, title, year, overview, poster_path, backdrop_path, logo_path, genres, runtime_mins, popularity, official_rating, community_rating, studios_json, tags_json, release_date, digital_release_date, synced_at)
    VALUES (@tmdbId, @imdbId, @title, @year, @overview, @posterPath, @backdropPath, @logoPath, @genres, @runtimeMins, @popularity, @officialRating, @communityRating, @studiosJson, @tagsJson, @releaseDate, @digitalReleaseDate, COALESCE(NULLIF(@syncedAt, ''), strftime('%Y-%m-%dT%H:%M:%SZ','now')))
    ON CONFLICT(tmdb_id) DO UPDATE SET
      imdb_id              = excluded.imdb_id,
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
}

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10)
}

export function getMovieEligibleDate(
  movie: Pick<Movie, 'releaseDate' | 'digitalReleaseDate'>,
): string | null {
  if (movie.digitalReleaseDate) return movie.digitalReleaseDate
  if (movie.releaseDate) return addDaysIso(movie.releaseDate, 45) || null
  return null
}

export function isMovieAvailable(movie: Pick<Movie, 'releaseDate' | 'digitalReleaseDate'>, today = todayIsoDate()): boolean {
  const eligibleDate = getMovieEligibleDate(movie)
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
  return getManualMovieAvailabilityOverride(movie.tmdbId) || isMovieAvailable(movie, today)
}

function addDaysIso(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return ''
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

function sortColumn(sortBy?: string): string {
  if (['SortName', 'title'].includes(sortBy ?? '')) {
    return "trim(case when lower(title) like 'the %' then substr(title, 5) when lower(title) like 'an %' then substr(title, 4) when lower(title) like 'a %' then substr(title, 3) else title end) collate nocase"
  }
  if (['ProductionYear', 'year'].includes(sortBy ?? '')) return 'year'
  return 'popularity'
}

function movieAvailabilityWhere(availableOnly: boolean): string {
  const clauses = [
    `EXISTS (
      SELECT 1
      FROM source_items
      WHERE source_items.media_type = 'movie'
        AND source_items.tmdb_id = movies.tmdb_id
    )`,
  ]
  if (availableOnly) {
    clauses.push(`(
      EXISTS (
        SELECT 1
        FROM manual_movie_availability_overrides
        WHERE manual_movie_availability_overrides.movie_tmdb_id = movies.tmdb_id
          AND manual_movie_availability_overrides.ignore_release_gate = 1
      )
      OR
      (
      (digital_release_date != '' AND digital_release_date <= date('now'))
      OR (
        digital_release_date = ''
        AND release_date != ''
        AND date(release_date, '+45 day') <= date('now')
      )
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
  ]
  if (availableOnly) {
    clauses.push(`EXISTS (
      SELECT 1
      FROM episodes
      WHERE episodes.show_tmdb_id = shows.tmdb_id
        AND episodes.air_date != ''
        AND episodes.air_date <= date('now')
    )`)
  }
  return `WHERE ${clauses.join('\n  AND ')}`
}

export function listMovies(opts: ListOpts = {}): Movie[] {
  const { search, sortBy, sortOrder, limit = 50, offset = 0, availableOnly = false } = opts

  const col = sortColumn(sortBy)
  const dir = (sortOrder ?? '').toLowerCase() === 'asc' ? 'ASC' : 'DESC'
  const baseWhere = movieAvailabilityWhere(availableOnly)

  if (search) {
    return (getDb().prepare(
      `SELECT * FROM movies ${baseWhere}${baseWhere ? ' AND' : ' WHERE'} title LIKE ? ORDER BY ${col} ${dir} LIMIT ? OFFSET ?`
    ).all(`%${search}%`, limit, offset) as Record<string, unknown>[]).map(row2movie)
  }
  return (getDb().prepare(
    `SELECT * FROM movies ${baseWhere} ORDER BY ${col} ${dir} LIMIT ? OFFSET ?`
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

// ── Shows ─────────────────────────────────────────────────────────────────────

function row2show(r: Record<string, unknown>): Show {
  return {
    id:           r.id            as number,
    tmdbId:       r.tmdb_id       as number,
    imdbId:       r.imdb_id       as string,
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
    INSERT INTO shows (tmdb_id, imdb_id, title, year, overview, poster_path, backdrop_path, logo_path, genres, status, num_seasons, popularity, official_rating, community_rating, studios_json, tags_json, synced_at)
    VALUES (@tmdbId, @imdbId, @title, @year, @overview, @posterPath, @backdropPath, @logoPath, @genres, @status, @numSeasons, @popularity, @officialRating, @communityRating, @studiosJson, @tagsJson, COALESCE(NULLIF(@syncedAt, ''), strftime('%Y-%m-%dT%H:%M:%SZ','now')))
    ON CONFLICT(tmdb_id) DO UPDATE SET
      imdb_id      = excluded.imdb_id,
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
  const { search, sortBy, sortOrder, limit = 50, offset = 0, availableOnly = false } = opts
  const col = sortColumn(sortBy)
  const dir = (sortOrder ?? '').toLowerCase() === 'asc' ? 'ASC' : 'DESC'
  const baseWhere = showAvailabilityWhere(availableOnly)
  if (search) {
    return (getDb().prepare(
      `SELECT * FROM shows ${baseWhere}${baseWhere ? ' AND' : ' WHERE'} title LIKE ? ORDER BY ${col} ${dir} LIMIT ? OFFSET ?`
    ).all(`%${search}%`, limit, offset) as Record<string, unknown>[]).map(row2show)
  }
  return (getDb().prepare(
    `SELECT * FROM shows ${baseWhere} ORDER BY ${col} ${dir} LIMIT ? OFFSET ?`
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
    INSERT INTO seasons (show_tmdb_id, season_number, name, overview, poster_path, episode_count, air_date)
    VALUES (@showTmdbId, @seasonNumber, @name, @overview, @posterPath, @episodeCount, @airDate)
    ON CONFLICT(show_tmdb_id, season_number) DO UPDATE SET
      name          = excluded.name,
      overview      = excluded.overview,
      poster_path   = excluded.poster_path,
      episode_count = excluded.episode_count,
      air_date      = excluded.air_date
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
    INSERT INTO episodes (show_tmdb_id, season_number, episode_number, name, overview, still_path, runtime_mins, community_rating, air_date)
    VALUES (@showTmdbId, @seasonNumber, @episodeNumber, @name, @overview, @stillPath, @runtimeMins, @communityRating, @airDate)
    ON CONFLICT(show_tmdb_id, season_number, episode_number) DO UPDATE SET
      name         = excluded.name,
      overview     = excluded.overview,
      still_path   = excluded.still_path,
      runtime_mins = excluded.runtime_mins,
      community_rating = excluded.community_rating,
      air_date     = excluded.air_date
  `).run(e)
}

export function getEpisodesForSeason(showTmdbId: number, seasonNumber: number): Episode[] {
  return (getDb().prepare(
    `SELECT * FROM episodes WHERE show_tmdb_id = ? AND season_number = ? ORDER BY episode_number ASC`
  ).all(showTmdbId, seasonNumber) as Record<string, unknown>[]).map(row2episode)
}

export function getAiredEpisodesForSeason(showTmdbId: number, seasonNumber: number): Episode[] {
  const today = new Date().toISOString().slice(0, 10)
  return (getDb().prepare(
    `SELECT * FROM episodes WHERE show_tmdb_id = ? AND season_number = ?
     AND air_date != '' AND air_date <= ? ORDER BY episode_number ASC`
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
  const today = new Date().toISOString().slice(0, 10)
  return (getDb().prepare(
    `SELECT * FROM episodes WHERE air_date != '' AND air_date <= ?
     ORDER BY show_tmdb_id ASC, season_number ASC, episode_number ASC`
  ).all(today) as Record<string, unknown>[]).map(row2episode)
}

export function countAiredEpisodes(): number {
  const today = new Date().toISOString().slice(0, 10)
  return (getDb().prepare(
    `SELECT COUNT(*) as n FROM episodes WHERE air_date != '' AND air_date <= ?`
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

function row2manualShowSubscription(r: Record<string, unknown>): ManualShowSubscription {
  return {
    showTmdbId:         r.show_tmdb_id as number,
    mode:               r.mode as ManualShowMode,
    activeSeasonNumber: r.active_season_number as number,
    updatedAt:          r.updated_at as string,
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

export function removeManualShowSubscription(showTmdbId: number): number {
  const info = getDb().prepare(`
    DELETE FROM manual_show_subscriptions WHERE show_tmdb_id = ?
  `).run(showTmdbId)
  return info.changes
}

export function getLatestSeasonNumberForShow(showTmdbId: number): number | null {
  const today = new Date().toISOString().slice(0, 10)
  const aired = getDb().prepare(`
    SELECT MAX(season_number) as n
    FROM seasons
    WHERE show_tmdb_id = ?
      AND season_number > 0
      AND air_date != ''
      AND air_date <= ?
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

  const nonManual = !!getDb().prepare(`
    SELECT 1
    FROM source_items
    WHERE media_type = 'show'
      AND tmdb_id = ?
      AND source_key != 'manual:ui'
    LIMIT 1
  `).get(showTmdbId)

  if (manual.mode === 'latest' && !nonManual) {
    return {
      mode: 'latest',
      manualMode: 'latest',
      activeSeasonNumber: manual.activeSeasonNumber || null,
    }
  }

  return {
    mode: 'all',
    manualMode: manual.mode,
    activeSeasonNumber: manual.activeSeasonNumber || null,
  }
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
  const info = getDb().prepare(`
    DELETE FROM movies WHERE tmdb_id IN (${sqlPlaceholders(orphaned.length)})
  `).run(...orphaned)
  return info.changes
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

export function getUserData(itemId: string): UserData {
  const r = getDb().prepare(`SELECT * FROM user_data WHERE item_id = ?`).get(itemId) as Record<string, unknown> | undefined
  if (!r) return { played: false, playCount: 0, positionTicks: 0, lastPlayedDate: '' }
  const positionTicks = Math.max(0, Number(r.position_ticks ?? 0))
  return {
    played:         !!(r.played as number),
    playCount:       r.play_count       as number,
    positionTicks:   positionTicks >= MIN_RESUME_TICKS ? positionTicks : 0,
    lastPlayedDate:  r.last_played_date as string,
  }
}

export function clearProgress(itemId: string): void {
  getDb().prepare(`
    INSERT INTO user_data (item_id, position_ticks)
    VALUES (?, 0)
    ON CONFLICT(item_id) DO UPDATE SET position_ticks = 0
  `).run(itemId)
}

export function saveProgress(itemId: string, positionTicks: number): void {
  if (positionTicks < MIN_RESUME_TICKS) {
    const existing = getUserData(itemId)
    if (existing.positionTicks >= MIN_RESUME_TICKS) return
    clearProgress(itemId)
    return
  }
  getDb().prepare(`
    INSERT INTO user_data (item_id, played, position_ticks, last_played_date)
    VALUES (?, 0, ?, ?)
    ON CONFLICT(item_id) DO UPDATE SET position_ticks = excluded.position_ticks
                                        , played = 0
                                        , last_played_date = excluded.last_played_date
  `).run(itemId, positionTicks, new Date().toISOString())
}

export function listResumeItemIds(limit = 50, offset = 0): string[] {
  const rows = getDb().prepare(`
    SELECT item_id
    FROM user_data
    WHERE position_ticks >= ?
      AND played = 0
    ORDER BY
      CASE WHEN last_played_date = '' THEN 1 ELSE 0 END,
      last_played_date DESC,
      item_id ASC
    LIMIT ?
    OFFSET ?
  `).all(MIN_RESUME_TICKS, limit, offset) as Array<{ item_id: string }>
  return rows.map(r => r.item_id)
}

export function countResumeItems(): number {
  const row = getDb().prepare(`
    SELECT COUNT(*) AS n
    FROM user_data
    WHERE position_ticks >= ?
      AND played = 0
  `).get(MIN_RESUME_TICKS) as { n: number }
  return row.n
}

export function markPlayed(itemId: string): void {
  getDb().prepare(`
    INSERT INTO user_data (item_id, played, play_count, position_ticks, last_played_date)
    VALUES (?, 1, 1, 0, ?)
    ON CONFLICT(item_id) DO UPDATE SET
      played           = 1,
      play_count       = play_count + 1,
      position_ticks   = 0,
      last_played_date = excluded.last_played_date
  `).run(itemId, new Date().toISOString())
}

export function markUnplayed(itemId: string): void {
  getDb().prepare(`
    INSERT INTO user_data (item_id, played, position_ticks)
    VALUES (?, 0, 0)
    ON CONFLICT(item_id) DO UPDATE SET
      played         = 0,
      position_ticks = 0
  `).run(itemId)
}
