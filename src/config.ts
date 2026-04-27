export function normalizeSootioUrl(value: string): string {
  return value.trim().replace(/\/manifest\.json\/?$/i, '').replace(/\/$/, '')
}

export function parseStreamProviderUrls(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map(s => normalizeSootioUrl(s))
    .filter(Boolean)
}

export function parseTraktLists(value: string): string[] {
  return value.split(',').map(s => s.trim()).filter(Boolean)
}

export function parseMdblistLists(value: string): string[] {
  return value
    .split(/[\r\n,]+/)
    .map(s => s.trim())
    .filter(Boolean)
}

export function parseBooleanSetting(value: string | undefined, fallback = false): boolean {
  if (value == null || value === '') return fallback
  const normalized = value.trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  return fallback
}

export type EnglishStreamMode = 'off' | 'prefer' | 'require'
export type ShowAddDefaultMode = 'all' | 'latest'
export type MovieReleaseMode = 'digital' | 'theatrical'

export function parseEnglishStreamMode(value: string): EnglishStreamMode {
  return value === 'off' || value === 'require' ? value : 'prefer'
}

export function parseShowAddDefaultMode(value: string | undefined): ShowAddDefaultMode {
  return value === 'latest' ? 'latest' : 'all'
}

export function parseMovieReleaseMode(value: string | undefined): MovieReleaseMode {
  return value === 'theatrical' ? 'theatrical' : 'digital'
}

export const config = {
  port:       parseInt(process.env.PORT ?? '9990'),
  host:       process.env.HOST ?? '0.0.0.0',
  dbPath:     process.env.DATABASE_PATH ?? '/app/data/fetcherr.db',
  tmdbApiKey: process.env.TMDB_API_KEY ?? '',
  tvdbApiKey: process.env.TVDB_API_KEY ?? '',
  sootioUrl:  normalizeSootioUrl(process.env.AIOSTREAM_URL ?? process.env.SOOTIO_URL ?? ''),
  serverName: process.env.SERVER_NAME ?? 'Fetcherr',
  serverId:   process.env.SERVER_ID  ?? 'fetcherr-001',
  rdApiKey:      process.env.RD_API_KEY ?? '',
  traktClientId:     process.env.TRAKT_CLIENT_ID ?? '',
  traktClientSecret: process.env.TRAKT_CLIENT_SECRET ?? '',
  traktUsername:     process.env.TRAKT_USERNAME ?? '',
  traktLists:        parseTraktLists(process.env.TRAKT_LISTS ?? ''),
  traktWatchlistMovies: parseBooleanSetting(process.env.TRAKT_WATCHLIST_MOVIES, true),
  traktWatchlistShows:  parseBooleanSetting(process.env.TRAKT_WATCHLIST_SHOWS, true),
  traktWatchHistory: parseBooleanSetting(process.env.TRAKT_WATCH_HISTORY, false),
  traktCollections: parseBooleanSetting(process.env.TRAKT_COLLECTIONS, false),
  mdblistLists: parseMdblistLists(process.env.MDBLIST_LISTS ?? ''),
  showAddDefaultMode: parseShowAddDefaultMode(process.env.SHOW_ADD_DEFAULT_MODE),
  movieReleaseMode: parseMovieReleaseMode(process.env.MOVIE_RELEASE_MODE),
  streamProviderUrls: parseStreamProviderUrls(process.env.STREAM_PROVIDER_URLS ?? ''),
  englishStreamMode: parseEnglishStreamMode(process.env.ENGLISH_STREAM_MODE ?? ''),
  serverUrl:         (process.env.SERVER_URL ?? 'http://localhost:9990').replace(/\/$/, ''),
}
