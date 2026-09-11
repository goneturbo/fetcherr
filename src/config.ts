export function normalizeSootioUrl(value: string): string {
  return value.trim().replace(/\/manifest\.json\/?$/i, '').replace(/\/$/, '')
}

export function parseStreamProviderUrls(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map(s => normalizeSootioUrl(s))
    .filter(Boolean)
}

export function collectStreamProviderUrls(...values: Array<string | undefined>): string[] {
  return [...new Set(values.flatMap(value => parseStreamProviderUrls(value ?? '')))]
}

export function parseMusicAddonUrls(value: string): string[] {
  return value
    .split(/[\r\n,]+/)
    .map(s => normalizeSootioUrl(s))
    .filter(Boolean)
}

export function parseTraktLists(value: string): string[] {
  return value.split(',').map(s => s.trim()).filter(Boolean)
}

export type TraktListMode = 'library' | 'folder' | 'collection' | 'browse_only'
export type ListPresentationMode = TraktListMode

export interface ListPresentation {
  includeInLibrary: boolean
  showAsFolder: boolean
  showAsCollection: boolean
}

export const DEFAULT_LIST_PRESENTATION: ListPresentation = {
  includeInLibrary: true,
  showAsFolder: false,
  showAsCollection: false,
}

const LIST_PRESENTATION_MODES = new Set<string>(['library', 'folder', 'collection', 'browse_only'])

export function presentationFromLegacyMode(mode: unknown): ListPresentation | null {
  if (mode === 'library') return { includeInLibrary: true, showAsFolder: false, showAsCollection: false }
  if (mode === 'folder') return { includeInLibrary: true, showAsFolder: true, showAsCollection: false }
  if (mode === 'browse_only') return { includeInLibrary: false, showAsFolder: true, showAsCollection: false }
  if (mode === 'collection') return { includeInLibrary: true, showAsFolder: false, showAsCollection: true }
  return null
}

export function normalizeListPresentation(value: unknown, fallback: ListPresentation = DEFAULT_LIST_PRESENTATION): ListPresentation {
  const legacy = presentationFromLegacyMode(value)
  if (legacy) return legacy
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>
    const nestedLegacy = presentationFromLegacyMode(record.mode)
    const base = nestedLegacy ?? fallback
    return {
      includeInLibrary: typeof record.includeInLibrary === 'boolean' ? record.includeInLibrary : base.includeInLibrary,
      showAsFolder: typeof record.showAsFolder === 'boolean' ? record.showAsFolder : base.showAsFolder,
      showAsCollection: typeof record.showAsCollection === 'boolean' ? record.showAsCollection : base.showAsCollection,
    }
  }
  return { ...fallback }
}

export function isListPresentationEnabled(presentation: ListPresentation): boolean {
  return presentation.includeInLibrary || presentation.showAsFolder || presentation.showAsCollection
}

export function parseTraktListModes(value: string): Record<string, ListPresentation> {
  if (!value.trim()) return {}
  try {
    const parsed = JSON.parse(value)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const result: Record<string, ListPresentation> = {}
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === 'string' && LIST_PRESENTATION_MODES.has(v)) {
          result[k] = normalizeListPresentation(v)
        } else if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
          result[k] = normalizeListPresentation(v)
        }
      }
      return result
    }
  } catch { /* ignore */ }
  return {}
}

export type MdblistListMode = 'library' | 'folder' | 'collection' | 'browse_only'

export interface MdblistListEntry {
  url: string
  name?: string
  mode?: MdblistListMode
  includeInLibrary?: boolean
  showAsFolder?: boolean
  showAsCollection?: boolean
  maxItems?: number
}

const MDBLIST_MODES = new Set<string>(['library', 'folder', 'collection', 'browse_only'])

function mdblistEntryPresentation(entry: Record<string, unknown>): ListPresentation | null {
  const hasFlags = typeof entry.includeInLibrary === 'boolean'
    || typeof entry.showAsFolder === 'boolean'
    || typeof entry.showAsCollection === 'boolean'
  if (hasFlags) return normalizeListPresentation(entry)
  return presentationFromLegacyMode(entry.mode)
}

export function parseMdblistLists(value: string): MdblistListEntry[] {
  if (!value.trim()) return []
  const trimmed = value.trim()
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed)
      if (Array.isArray(parsed)) {
        return (parsed as unknown[])
          .filter((e): e is Record<string, unknown> => typeof e === 'object' && e !== null && typeof (e as Record<string, unknown>).url === 'string')
          .map(e => {
            const presentation = mdblistEntryPresentation(e)
            return {
              url: String(e.url).trim(),
              ...(e.name && String(e.name).trim() ? { name: String(e.name).trim() } : {}),
              ...(typeof e.mode === 'string' && MDBLIST_MODES.has(e.mode) && !presentation ? { mode: e.mode as MdblistListMode } : {}),
              ...(presentation ? presentation : {}),
              ...(Number.isFinite(Number(e.maxItems)) && Number(e.maxItems) > 0 ? { maxItems: Math.trunc(Number(e.maxItems)) } : {}),
            }
          })
          .filter(e => e.url)
      }
    } catch { /* fall through to legacy */ }
  }
  return trimmed
    .split(/[\r\n,]+/)
    .map(s => s.trim())
    .filter(Boolean)
    .map(url => ({ url }))
}

export interface DiscoverCategoryDef {
  slug: string
  mediaType: 'movie' | 'show'
  label: string
}

export const DISCOVER_CATEGORIES: DiscoverCategoryDef[] = [
  { slug: 'trending-movies',   mediaType: 'movie', label: 'Trending Movies' },
  { slug: 'trending-shows',    mediaType: 'show',  label: 'Trending Shows' },
  { slug: 'popular-movies',    mediaType: 'movie', label: 'Popular Movies' },
  { slug: 'popular-shows',     mediaType: 'show',  label: 'Popular Shows' },
  { slug: 'top-rated-movies',  mediaType: 'movie', label: 'Top Rated Movies' },
  { slug: 'top-rated-shows',   mediaType: 'show',  label: 'Top Rated Shows' },
  { slug: 'upcoming-movies',   mediaType: 'movie', label: 'Upcoming Movies' },
  { slug: 'on-the-air-shows',  mediaType: 'show',  label: 'On The Air' },
]

export type DiscoverPresentationMode = 'folder' | 'collection' | 'library'
const DISCOVER_PRESENTATION_MODES = new Set<string>(['folder', 'collection', 'library'])

export function parseDiscoverPresentationMode(value: string | undefined, fallback: DiscoverPresentationMode = 'folder'): DiscoverPresentationMode {
  const normalized = (value ?? '').trim().toLowerCase()
  return DISCOVER_PRESENTATION_MODES.has(normalized) ? normalized as DiscoverPresentationMode : fallback
}

export function discoverPresentationFromMode(mode: DiscoverPresentationMode): ListPresentation {
  if (mode === 'collection') return { includeInLibrary: false, showAsFolder: false, showAsCollection: true }
  if (mode === 'library') return { includeInLibrary: true, showAsFolder: false, showAsCollection: false }
  return { includeInLibrary: false, showAsFolder: true, showAsCollection: false }
}

export function parseBooleanSetting(value: string | undefined, fallback = false): boolean {
  if (value == null || value === '') return fallback
  const normalized = value.trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  return fallback
}

export type ListFoldersSetting = boolean | string[]

export function parseFoldersSetting(value: string | undefined, fallback: ListFoldersSetting = false): ListFoldersSetting {
  if (value == null || value === '') return fallback
  const normalized = value.trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  return value.split(',').map(s => s.trim()).filter(Boolean)
}

export function serializeFoldersSetting(setting: ListFoldersSetting): string {
  if (typeof setting === 'boolean') return setting ? 'true' : 'false'
  return setting.join(',')
}

export type AudioLanguage =
  | 'en'
  | 'ja'
  | 'es'
  | 'fr'
  | 'de'
  | 'it'
  | 'ko'
  | 'zh'
  | 'pt'
  | 'ru'
  | 'hi'
  | 'ar'

export type EnglishStreamMode = 'off' | 'prefer' | 'require'
export type DirectPlaybackMode = 'off' | 'torrentsOnly' | 'all'
export type StreamRankingMode = 'fetcherr' | 'provider'
export type StremioSearchSource = 'cinemeta' | 'addon' | 'trakt'

export function parseStremioSearchSource(value: string | undefined): StremioSearchSource {
  if (value === 'addon' || value === 'trakt') return value
  return 'cinemeta'
}
export type MediaSourceLimit = 5 | 10 | 20

export function parseStreamRankingMode(value: string | undefined): StreamRankingMode {
  return value === 'fetcherr' ? 'fetcherr' : 'provider'
}

export function parseMediaSourceLimit(value: string | undefined): MediaSourceLimit {
  if (value === '5') return 5
  if (value === '20') return 20
  return 10
}

export type ShowAddDefaultMode = 'all' | 'latest'
export type MovieReleaseMode = 'digital' | 'theatrical'

const AUDIO_LANGUAGE_ALIASES: Record<AudioLanguage, string[]> = {
  en: ['en', 'eng', 'english'],
  ja: ['ja', 'jpn', 'japanese'],
  es: ['es', 'spa', 'spanish', 'espanol', 'español', 'castellano', 'latino', 'latam'],
  fr: ['fr', 'fre', 'fra', 'french', 'francais', 'français'],
  de: ['de', 'ger', 'deu', 'german', 'deutsch'],
  it: ['it', 'ita', 'italian', 'italiano'],
  ko: ['ko', 'kor', 'korean'],
  zh: ['zh', 'zho', 'chi', 'chs', 'cht', 'zhs', 'zht', 'chinese', 'mandarin', 'cantonese'],
  pt: ['pt', 'por', 'portuguese', 'portugues', 'português', 'pt-br', 'ptbr', 'brazilian'],
  ru: ['ru', 'rus', 'russian'],
  hi: ['hi', 'hin', 'hindi'],
  ar: ['ar', 'ara', 'arabic'],
}

export function parseAudioLanguage(value: string | undefined): AudioLanguage {
  const normalized = (value ?? '').trim().toLowerCase()
  for (const [language, aliases] of Object.entries(AUDIO_LANGUAGE_ALIASES) as Array<[AudioLanguage, string[]]>) {
    if (aliases.includes(normalized)) return language
  }
  return 'en'
}

export function parseEnglishStreamMode(value: string): EnglishStreamMode {
  return value === 'off' || value === 'require' ? value : 'prefer'
}

export function parseDirectPlaybackMode(value: string | undefined): DirectPlaybackMode {
  return value === 'off' || value === 'all' ? value : 'torrentsOnly'
}

export function parseShowAddDefaultMode(value: string | undefined): ShowAddDefaultMode {
  return value === 'latest' ? 'latest' : 'all'
}

export function parseMovieReleaseMode(value: string | undefined): MovieReleaseMode {
  return value === 'theatrical' ? 'theatrical' : 'digital'
}

export function parsePositiveIntegerSetting(value: string | undefined, fallback: number): number {
  if (value == null || value.trim() === '') return fallback
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
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
  torBoxApiKey:  process.env.TORBOX_API_KEY ?? '',
  torBoxUserIp:  process.env.TORBOX_USER_IP ?? '',
  premiumizeApiKey: process.env.PREMIUMIZE_API_KEY ?? '',
  traktClientId:     process.env.TRAKT_CLIENT_ID ?? '',
  traktClientSecret: process.env.TRAKT_CLIENT_SECRET ?? '',
  traktUsername:     process.env.TRAKT_USERNAME ?? '',
  traktLists:        parseTraktLists(process.env.TRAKT_LISTS ?? ''),
  traktListModes:    parseTraktListModes(process.env.TRAKT_LIST_MODES ?? ''),
  traktWatchlistMovies: parseBooleanSetting(process.env.TRAKT_WATCHLIST_MOVIES, true),
  traktWatchlistShows:  parseBooleanSetting(process.env.TRAKT_WATCHLIST_SHOWS, true),
  traktWatchHistory: parseBooleanSetting(process.env.TRAKT_WATCH_HISTORY, false),
  traktCollections: parseBooleanSetting(process.env.TRAKT_COLLECTIONS, false),
  traktFolders: parseFoldersSetting(process.env.TRAKT_FOLDERS, false),
  mdblistApiKey: process.env.MDBLIST_API_KEY ?? '',
  mdblistLists: parseMdblistLists(process.env.MDBLIST_LISTS ?? ''),
  mdblistFolders: parseFoldersSetting(process.env.MDBLIST_FOLDERS, false),
  mdblistMaxItems: parsePositiveIntegerSetting(process.env.MDBLIST_MAX_ITEMS, 1000),
  discoverEnabled: parseBooleanSetting(process.env.DISCOVER_ENABLED, false),
  discoverPresentationMode: parseDiscoverPresentationMode(process.env.DISCOVER_PRESENTATION_MODE),
  showAddDefaultMode: parseShowAddDefaultMode(process.env.SHOW_ADD_DEFAULT_MODE),
  movieReleaseMode: parseMovieReleaseMode(process.env.MOVIE_RELEASE_MODE),
  streamProviderUrls: parseStreamProviderUrls(process.env.STREAM_PROVIDER_URLS ?? ''),
  stremioSearchProviderUrls: [] as string[],
  allowNotWebReadyDirectStreams: parseBooleanSetting(process.env.ALLOW_NOT_WEB_READY_DIRECT_STREAMS, false),
  musicAddonUrls: parseMusicAddonUrls(process.env.MUSIC_ADDON_URLS ?? process.env.MUSIC_ADDON_URL ?? process.env.SPOTIFLAC_URL ?? ''),
  preferredAudioLanguage: parseAudioLanguage(process.env.PREFERRED_AUDIO_LANGUAGE),
  englishStreamMode: parseEnglishStreamMode(process.env.ENGLISH_STREAM_MODE ?? ''),
  directPlaybackMode: parseDirectPlaybackMode(process.env.DIRECT_PLAYBACK_MODE),
  streamRankingMode: parseStreamRankingMode(process.env.STREAM_RANKING_MODE),
  stremioSearchEnabled: parseBooleanSetting(process.env.STREMIO_SEARCH_ENABLED, false),
  stremioSearchSource: parseStremioSearchSource(process.env.STREMIO_SEARCH_SOURCE),
  mediaSourceSelection: parseBooleanSetting(process.env.MEDIA_SOURCE_SELECTION, false),
  mediaSourceLimit: parseMediaSourceLimit(process.env.MEDIA_SOURCE_LIMIT),
  serverUrl:         (process.env.SERVER_URL ?? 'http://localhost:9990').replace(/\/$/, ''),
  // The same value, kept out of reach of the stored settings that overwrite
  // serverUrl at boot. An operator can point Server URL at a LAN address for
  // their own convenience, and install URLs still have to name something a
  // stranger's device can reach.
  serverUrlFromEnv:  (process.env.SERVER_URL ?? '').replace(/\/$/, ''),
  newznabUrl:        (process.env.NEWZNAB_URL ?? '').replace(/\/$/, ''),
  newznabApiKey:     process.env.NEWZNAB_API_KEY ?? '',
  nntpHost:          process.env.NNTP_HOST ?? '',
  nntpPort:          parseInt(process.env.NNTP_PORT ?? '563', 10),
  nntpUser:          process.env.NNTP_USER ?? '',
  nntpPass:          process.env.NNTP_PASS ?? '',
  nntpConnections:   parsePositiveIntegerSetting(process.env.NNTP_CONNECTIONS, 4),
  nntpSsl:           parseBooleanSetting(process.env.NNTP_SSL, true),
}
