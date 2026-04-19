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

export type EnglishStreamMode = 'off' | 'prefer' | 'require'

export function parseEnglishStreamMode(value: string): EnglishStreamMode {
  return value === 'off' || value === 'require' ? value : 'prefer'
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
  streamProviderUrls: parseStreamProviderUrls(process.env.STREAM_PROVIDER_URLS ?? ''),
  englishStreamMode: parseEnglishStreamMode(process.env.ENGLISH_STREAM_MODE ?? ''),
  serverUrl:         (process.env.SERVER_URL ?? 'http://localhost:9990').replace(/\/$/, ''),
  uiUsername:        process.env.UI_USERNAME ?? 'admin',
  uiPassword:        process.env.UI_PASSWORD ?? '',
}
