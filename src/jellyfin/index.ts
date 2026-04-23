import type { FastifyInstance, FastifyReply } from 'fastify'
import { createHash } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from '../config.js'
import {
  listMovies, countMovies, getMovieByTmdbId,
  getUserData, saveProgress, markPlayed, markUnplayed, listResumeItemIds, countResumeItems, getAllPlayedItemIds,
  getEffectiveShowMode, listShows, countShows, getShowByTmdbId,
  getSeasonsForShow, getSeason, getEpisodesForSeason, getAiredEpisodesForSeason, isMovieVisibleToLibrary, hasAnySourceItem,
  authEnabled, canUserAccessMovie, canUserAccessShow, getUserById, verifyUserCredentials, DEFAULT_ADMIN_USER_ID, type AppUser,
} from '../db.js'
import {
  searchTmdb, fetchMovieByTmdbId, posterUrl,
  fetchShowByTmdbId, searchTmdbShows,
  fetchAndCacheSeasonDetails, ensureShowSeasonsCached,
} from '../tmdb.js'
import type { Movie, Show, Season, Episode } from '../db.js'
import { buildPlaybackOrigin, createSignedPlaybackUrl } from '../play-auth.js'

// ── ID helpers ────────────────────────────────────────────────────────────────
// Real Jellyfin uses GUIDs for all IDs. Infuse validates this client-side.
// We encode TMDB IDs as deterministic GUIDs and decode them back on request.
//
// Encoding scheme (last 12 hex chars carry the payload):
//   Movie:   00000000-0000-4000-8000-{tmdbId 12 hex}
//   Series:  00000000-0000-4000-8001-{tmdbId 12 hex}
//   Season:  00000000-0000-4000-8002-{showTmdbId 8 hex}{seasonNum 4 hex}
//   Episode: 00000000-0000-4000-8003-{showTmdbId 6 hex}{seasonNum 3 hex}{episodeNum 3 hex}
//   Search Movie:  00000000-0000-4000-8004-{tmdbId 12 hex}
//   Search Series: 00000000-0000-4000-8005-{tmdbId 12 hex}

const MOVIES_FOLDER_ID = 'a0000000-0000-4000-8000-000000000001'
const SHOWS_FOLDER_ID  = 'a0000000-0000-4000-8000-000000000002'
const SERVER_GUID      = 'a0000000-0000-0000-0000-000000000001'
// Keep old name as alias so existing code still compiles
const FOLDER_ID = MOVIES_FOLDER_ID
const __dir = dirname(fileURLToPath(import.meta.url))
const ROOT_FOLDER_ART: Record<string, string> = {
  [MOVIES_FOLDER_ID]: join(__dir, '..', 'ui', 'static', 'movies-folder.png'),
  [SHOWS_FOLDER_ID]: join(__dir, '..', 'ui', 'static', 'shows-folder.png'),
}

const API_LIBRARY_FILTER = { availableOnly: true as const }
const READ_CACHE_TTL_MS = 3_000
const IMAGE_PROXY_TTL_MS = 60 * 60 * 1000
const PLAYED_COMPLETION_THRESHOLD = 0.95
const JELLYFIN_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000
const LOGIN_WINDOW_MS = 15 * 60 * 1000
const LOGIN_MAX_ATTEMPTS = 10
const jellyfinTokens = new Map<string, { userId: string; expiresAt: number }>()
const loginAttempts = new Map<string, { count: number; resetAt: number }>()
const proxiedImageCache = new Map<string, { buffer: Buffer; contentType: string; expiresAt: number }>()
type ImageKind = 'poster' | 'backdrop' | 'logo'
type ImageQuery = {
  tag?: string
  width?: string
  maxWidth?: string
  height?: string
  maxHeight?: string
  quality?: string
}

function tmdbToId(tmdbId: number): string {
  return `00000000-0000-4000-8000-${tmdbId.toString(16).padStart(12, '0')}`
}

function idToTmdb(id: string): number {
  const m = id.match(/^00000000-0000-4000-8000-([0-9a-f]{12})$/i)
  if (m) return parseInt(m[1], 16)
  const n = parseInt(id)           // backward-compat for numeric string IDs
  return isNaN(n) ? 0 : n
}

function showTmdbToId(tmdbId: number): string {
  return `00000000-0000-4000-8001-${tmdbId.toString(16).padStart(12, '0')}`
}

function idToShowTmdb(id: string): number | null {
  const m = id.match(/^00000000-0000-4000-8001-([0-9a-f]{12})$/i)
  return m ? parseInt(m[1], 16) : null
}

function searchMovieTmdbToId(tmdbId: number): string {
  return `00000000-0000-4000-8004-${tmdbId.toString(16).padStart(12, '0')}`
}

function idToSearchMovieTmdb(id: string): number | null {
  const m = id.match(/^00000000-0000-4000-8004-([0-9a-f]{12})$/i)
  return m ? parseInt(m[1], 16) : null
}

function searchShowTmdbToId(tmdbId: number): string {
  return `00000000-0000-4000-8005-${tmdbId.toString(16).padStart(12, '0')}`
}

function idToSearchShowTmdb(id: string): number | null {
  const m = id.match(/^00000000-0000-4000-8005-([0-9a-f]{12})$/i)
  return m ? parseInt(m[1], 16) : null
}

function seasonToId(showTmdbId: number, seasonNum: number): string {
  return `00000000-0000-4000-8002-${showTmdbId.toString(16).padStart(8, '0')}${seasonNum.toString(16).padStart(4, '0')}`
}

function idToSeason(id: string): { showTmdbId: number; seasonNum: number } | null {
  const m = id.match(/^00000000-0000-4000-8002-([0-9a-f]{8})([0-9a-f]{4})$/i)
  return m ? { showTmdbId: parseInt(m[1], 16), seasonNum: parseInt(m[2], 16) } : null
}

function episodeToId(showTmdbId: number, seasonNum: number, episodeNum: number): string {
  return `00000000-0000-4000-8003-${showTmdbId.toString(16).padStart(6, '0')}${seasonNum.toString(16).padStart(3, '0')}${episodeNum.toString(16).padStart(3, '0')}`
}

function idToEpisode(id: string): { showTmdbId: number; seasonNum: number; episodeNum: number } | null {
  const m = id.match(/^00000000-0000-4000-8003-([0-9a-f]{6})([0-9a-f]{3})([0-9a-f]{3})$/i)
  return m ? { showTmdbId: parseInt(m[1], 16), seasonNum: parseInt(m[2], 16), episodeNum: parseInt(m[3], 16) } : null
}

// ── Helpers ───────────────────────────────────────────────────────────────────

type DetailEntity = {
  id: number
  name: string
}

function stableMetaId(kind: string, value: string): string {
  return createHash('md5').update(`${kind}:${value}`).digest('hex')
}

interface ReadCacheEntry<T> {
  expiresAt: number
  inFlight?: Promise<T>
  value?: T
}

const readCache = new Map<string, ReadCacheEntry<unknown>>()

async function withReadCache<T>(key: string, loader: () => Promise<T>): Promise<T> {
  const now = Date.now()
  const existing = readCache.get(key) as ReadCacheEntry<T> | undefined
  if (existing?.value !== undefined && existing.expiresAt > now) return existing.value
  if (existing?.inFlight) return existing.inFlight

  const inFlight = loader().then(value => {
    readCache.set(key, { value, expiresAt: Date.now() + READ_CACHE_TTL_MS })
    return value
  }).finally(() => {
    const latest = readCache.get(key) as ReadCacheEntry<T> | undefined
    if (latest?.inFlight) readCache.set(key, { value: latest.value, expiresAt: latest.expiresAt })
  })

  readCache.set(key, { expiresAt: now + READ_CACHE_TTL_MS, inFlight })
  return inFlight
}

function clientIp(headers: Record<string, string | string[] | undefined>): string {
  const cfIp = headers['cf-connecting-ip']
  if (typeof cfIp === 'string' && cfIp.trim()) return cfIp.trim()
  const forwardedFor = headers['x-forwarded-for']
  if (typeof forwardedFor === 'string' && forwardedFor.trim()) return forwardedFor.split(',')[0].trim()
  return 'unknown'
}

function loginRateState(ip: string) {
  const now = Date.now()
  const existing = loginAttempts.get(ip)
  if (!existing || now > existing.resetAt) {
    const fresh = { count: 0, resetAt: now + LOGIN_WINDOW_MS }
    loginAttempts.set(ip, fresh)
    return fresh
  }
  return existing
}

async function fetchProxiedImage(url: string): Promise<{ buffer: Buffer; contentType: string } | null> {
  const now = Date.now()
  const cached = proxiedImageCache.get(url)
  if (cached && cached.expiresAt > now) {
    return { buffer: cached.buffer, contentType: cached.contentType }
  }

  try {
    const res = await fetch(url, {
      redirect: 'follow',
      headers: {
        'user-agent': 'Fetcherr/1.0',
        'accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      },
    })
    if (!res.ok) return null

    const arrayBuffer = await res.arrayBuffer()
    const buffer = Buffer.from(arrayBuffer)
    const contentType = res.headers.get('content-type') || 'image/jpeg'
    proxiedImageCache.set(url, { buffer, contentType, expiresAt: now + IMAGE_PROXY_TTL_MS })
    return { buffer, contentType }
  } catch {
    return null
  }
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  if (typeof value === 'string') return value
  return value?.[0]
}

function parsePositiveInt(value: string | undefined): number | null {
  if (!value) return null
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function requestedImageWidth(query: ImageQuery | undefined): number | null {
  return parsePositiveInt(query?.width) ?? parsePositiveInt(query?.maxWidth)
}

function imageKindForType(type: string): ImageKind {
  const normalized = type.toLowerCase()
  if (normalized === 'logo') return 'logo'
  if (normalized === 'backdrop' || normalized === 'thumb') return 'backdrop'
  return 'poster'
}

function imageEtag(tag: string | undefined, url: string): string {
  return `"${tag || createHash('sha1').update(url).digest('hex')}"`
}

function jellyfinPremiereDate(date: string | undefined): string | undefined {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return undefined
  return `${date}T00:00:00.000Z`
}

async function sendImageUrl(
  reply: FastifyReply,
  headers: Record<string, string | string[] | undefined>,
  pathOrUrl: string | undefined,
  kind: ImageKind,
  query?: ImageQuery,
): Promise<FastifyReply> {
  if (!pathOrUrl) return reply.code(404).send()
  const url = posterUrl(pathOrUrl, { kind, width: requestedImageWidth(query) })
  const etag = imageEtag(query?.tag, url)
  if (firstHeaderValue(headers['if-none-match']) === etag) {
    reply.header('Cache-Control', 'public, max-age=31536000, immutable')
    reply.header('ETag', etag)
    return reply.code(304).send()
  }
  const proxied = await fetchProxiedImage(url)
  if (!proxied) return reply.code(404).send()
  reply.header('Cache-Control', 'public, max-age=31536000, immutable')
  reply.header('ETag', etag)
  reply.type(proxied.contentType)
  return reply.send(proxied.buffer)
}

function runtimeTicksForItem(itemId: string): number | null {
  const epRef = idToEpisode(itemId)
  if (epRef) {
    const episode = getEpisodesForSeason(epRef.showTmdbId, epRef.seasonNum)
      .find(e => e.episodeNumber === epRef.episodeNum)
    return episode ? (episode.runtimeMins || 45) * 60 * 10_000_000 : null
  }

  const tmdbId = idToTmdb(itemId)
  if (!tmdbId) return null
  const movie = getMovieByTmdbId(tmdbId)
  return movie ? (movie.runtimeMins || 90) * 60 * 10_000_000 : null
}

function reachedCompletionThreshold(positionTicks: number | undefined, runtimeTicks: number | undefined): boolean {
  if (positionTicks == null || runtimeTicks == null || runtimeTicks <= 0) return false
  return (positionTicks / runtimeTicks) >= PLAYED_COMPLETION_THRESHOLD
}

function parseJsonArray<T>(value: string): T[] {
  try {
    const parsed = JSON.parse(value || '[]')
    return Array.isArray(parsed) ? parsed as T[] : []
  } catch {
    return []
  }
}

function genreItems(genres: string[]) {
  return genres.map(name => ({ Name: name, Id: stableMetaId('genre', name) }))
}

function detailStudios(studiosJson: string) {
  const studios = parseJsonArray<DetailEntity>(studiosJson)
  return studios.map(studio => ({
    Name: studio.name,
    Id: stableMetaId('studio', String(studio.id || studio.name)),
  }))
}

function externalUrls(type: 'movie' | 'show', imdbId: string, tmdbId: number) {
  const urls = []
  if (imdbId) urls.push({ Name: 'IMDb', Url: `https://www.imdb.com/title/${imdbId}` })
  urls.push({ Name: 'TMDB', Url: `https://www.themoviedb.org/${type === 'show' ? 'tv' : 'movie'}/${tmdbId}` })
  if (imdbId) {
    urls.push({
      Name: 'Trakt',
      Url: `https://trakt.tv/${type === 'movie' ? 'movies' : 'shows'}/${imdbId}`,
    })
  }
  return urls
}

function episodeExternalUrls(showTmdbId: number, seasonNumber: number, episodeNumber: number) {
  return [{
    Name: 'TMDB',
    Url: `https://www.themoviedb.org/tv/${showTmdbId}/season/${seasonNumber}/episode/${episodeNumber}`,
  }]
}

function userDataForItem(itemId: string, ud: { played: boolean; playCount: number; positionTicks: number; lastPlayedDate: string }, runtimeTicks = 0) {
  const playedPercentage = runtimeTicks > 0
    ? Math.max(0, Math.min(100, (ud.positionTicks / runtimeTicks) * 100))
    : undefined
  return {
    PlayedPercentage:      playedPercentage,
    PlaybackPositionTicks: ud.positionTicks,
    PlayCount:             ud.playCount,
    IsFavorite:            false,
    LastPlayedDate:        ud.lastPlayedDate || undefined,
    Played:                ud.played,
    Key:                   itemId,
    ItemId:                itemId,
  }
}

function movieToItem(m: Movie, userId = DEFAULT_ADMIN_USER_ID) {
  const genres: string[] = JSON.parse(m.genres || '[]')
  const runtimeTicks = (m.runtimeMins || 90) * 60 * 10_000_000
  const fakePath = `/movies/${m.title.replace(/[/\\:*?"<>|]/g, '')} (${m.year}).mkv`
  const id = tmdbToId(m.tmdbId)
  const ud = getUserData(id, userId)
  const posterTag = m.posterPath ? m.posterPath.replace(/\W/g, '').slice(0, 16) : undefined
  const thumbTag = (m.backdropPath || m.posterPath) ? (m.backdropPath || m.posterPath).replace(/\W/g, '').slice(0, 16) : undefined
  const logoTag = m.logoPath ? m.logoPath.replace(/\W/g, '').slice(0, 16) : undefined
  return {
    Id:                 id,
    ServerId:           SERVER_GUID,
    Name:               m.title,
    SortName:           m.title.replace(/^(the|a|an)\s+/i, '').toLowerCase(),
    Type:               'Movie',
    MediaType:          'Video',
    VideoType:          'VideoFile',
    LocationType:       'FileSystem',
    PlayAccess:         'Full',
    IsPlayable:         true,
    CanDelete:          false,
    CanDownload:        false,
    ProductionYear:     m.year,
    Overview:           m.overview,
    Genres:             genres,
    GenreItems:         genreItems(genres),
    Studios:            detailStudios(m.studiosJson),
    Tags:               parseJsonArray<string>(m.tagsJson),
    OfficialRating:     m.officialRating || undefined,
    CommunityRating:    m.communityRating || undefined,
    ExternalUrls:       externalUrls('movie', m.imdbId, m.tmdbId),
    PremiereDate:       jellyfinPremiereDate(m.releaseDate || m.digitalReleaseDate),
    DateCreated:        m.syncedAt,
    RunTimeTicks:       runtimeTicks,
    IsFolder:           false,
    Path:               fakePath,
    ImageTags:          {
      ...(posterTag ? { Primary: posterTag } : {}),
      ...(logoTag ? { Logo: logoTag } : {}),
      ...(thumbTag ? { Thumb: thumbTag } : {}),
    },
    PrimaryImageTag:    null,
    BackdropImageTags:  m.backdropPath ? [m.backdropPath.replace(/\W/g, '').slice(0, 16)] : [],
    ParentId:           FOLDER_ID,
    MediaSources: [{
      Protocol:             'File',
      Id:                   id,
      Type:                 'Default',
      Container:            'mkv',
      Size:                 0,
      Name:                 m.title,
      Path:                 fakePath,
      IsRemote:             false,
      RunTimeTicks:         runtimeTicks,
      SupportsTranscoding:  false,
      SupportsDirectStream: true,
      SupportsDirectPlay:   true,
      IsInfiniteStream:     false,
      RequiresOpening:      false,
      RequiresClosing:      false,
    }],
    ProviderIds:        { Imdb: m.imdbId || undefined, Tmdb: String(m.tmdbId) },
    UserData:           userDataForItem(id, ud, runtimeTicks),
  }
}

function showToSeriesItem(s: Show, userId = DEFAULT_ADMIN_USER_ID) {
  const genres: string[] = JSON.parse(s.genres || '[]')
  const id = showTmdbToId(s.tmdbId)
  const ud = getUserData(id, userId)
  const showMode = getEffectiveShowMode(s.tmdbId)
  const childCount = showMode.mode === 'latest' ? 1 : s.numSeasons
  const posterTag = s.posterPath ? s.posterPath.replace(/\W/g, '').slice(0, 16) : undefined
  const thumbTag = (s.backdropPath || s.posterPath) ? (s.backdropPath || s.posterPath).replace(/\W/g, '').slice(0, 16) : undefined
  const logoTag = s.logoPath ? s.logoPath.replace(/\W/g, '').slice(0, 16) : undefined
  return {
    Id:                 id,
    ServerId:           SERVER_GUID,
    Name:               s.title,
    SortName:           s.title.replace(/^(the|a|an)\s+/i, '').toLowerCase(),
    Type:               'Series',
    MediaType:          'Video',
    LocationType:       'FileSystem',
    PlayAccess:         'Full',
    IsPlayable:         false,
    CanDelete:          false,
    CanDownload:        false,
    ProductionYear:     s.year,
    Overview:           s.overview,
    Genres:             genres,
    GenreItems:         genreItems(genres),
    Studios:            detailStudios(s.studiosJson),
    Tags:               parseJsonArray<string>(s.tagsJson),
    OfficialRating:     s.officialRating || undefined,
    CommunityRating:    s.communityRating || undefined,
    ExternalUrls:       externalUrls('show', s.imdbId, s.tmdbId),
    DateCreated:        s.syncedAt,
    IsFolder:           true,
    ChildCount:         childCount,
    RecursiveItemCount: childCount,
    Status:             s.status,
    ImageTags:          {
      ...(posterTag ? { Primary: posterTag } : {}),
      ...(logoTag ? { Logo: logoTag } : {}),
      ...(thumbTag ? { Thumb: thumbTag } : {}),
    },
    PrimaryImageTag:    null,
    BackdropImageTags:  s.backdropPath ? [s.backdropPath.replace(/\W/g, '').slice(0, 16)] : [],
    ParentId:           SHOWS_FOLDER_ID,
    ProviderIds:        { Imdb: s.imdbId || undefined, Tmdb: String(s.tmdbId) },
    UserData:           userDataForItem(id, ud),
  }
}

function movieToSearchItem(m: Movie) {
  const genres: string[] = JSON.parse(m.genres || '[]')
  const id = searchMovieTmdbToId(m.tmdbId)
  const posterTag = m.posterPath ? m.posterPath.replace(/\W/g, '').slice(0, 16) : undefined
  const thumbTag = (m.backdropPath || m.posterPath) ? (m.backdropPath || m.posterPath).replace(/\W/g, '').slice(0, 16) : undefined
  const logoTag = m.logoPath ? m.logoPath.replace(/\W/g, '').slice(0, 16) : undefined
  return {
    Id:                 id,
    ServerId:           SERVER_GUID,
    Name:               m.title,
    SortName:           m.title.replace(/^(the|a|an)\s+/i, '').toLowerCase(),
    Type:               'Movie',
    MediaType:          'Video',
    VideoType:          'VideoFile',
    LocationType:       'Virtual',
    PlayAccess:         'None',
    IsPlayable:         false,
    CanDelete:          false,
    CanDownload:        false,
    ProductionYear:     m.year,
    Overview:           m.overview,
    Genres:             genres,
    GenreItems:         genreItems(genres),
    Studios:            detailStudios(m.studiosJson),
    Tags:               [...parseJsonArray<string>(m.tagsJson), 'Not In Library'],
    OfficialRating:     m.officialRating || undefined,
    CommunityRating:    m.communityRating || undefined,
    ExternalUrls:       externalUrls('movie', m.imdbId, m.tmdbId),
    PremiereDate:       jellyfinPremiereDate(m.releaseDate || m.digitalReleaseDate),
    DateCreated:        m.syncedAt,
    IsFolder:           false,
    ImageTags:          {
      ...(posterTag ? { Primary: posterTag } : {}),
      ...(logoTag ? { Logo: logoTag } : {}),
      ...(thumbTag ? { Thumb: thumbTag } : {}),
    },
    PrimaryImageTag:    null,
    BackdropImageTags:  m.backdropPath ? [m.backdropPath.replace(/\W/g, '').slice(0, 16)] : [],
    ParentId:           FOLDER_ID,
    ProviderIds:        { Imdb: m.imdbId || undefined, Tmdb: String(m.tmdbId) },
    UserData:           userDataForItem(id, { played: false, playCount: 0, positionTicks: 0, lastPlayedDate: '' }),
  }
}

function showToSearchSeriesItem(s: Show) {
  const genres: string[] = JSON.parse(s.genres || '[]')
  const id = searchShowTmdbToId(s.tmdbId)
  const posterTag = s.posterPath ? s.posterPath.replace(/\W/g, '').slice(0, 16) : undefined
  const thumbTag = (s.backdropPath || s.posterPath) ? (s.backdropPath || s.posterPath).replace(/\W/g, '').slice(0, 16) : undefined
  const logoTag = s.logoPath ? s.logoPath.replace(/\W/g, '').slice(0, 16) : undefined
  return {
    Id:                 id,
    ServerId:           SERVER_GUID,
    Name:               s.title,
    SortName:           s.title.replace(/^(the|a|an)\s+/i, '').toLowerCase(),
    Type:               'Series',
    MediaType:          'Video',
    LocationType:       'Virtual',
    PlayAccess:         'None',
    IsPlayable:         false,
    CanDelete:          false,
    CanDownload:        false,
    ProductionYear:     s.year,
    Overview:           s.overview,
    Genres:             genres,
    GenreItems:         genreItems(genres),
    Studios:            detailStudios(s.studiosJson),
    Tags:               [...parseJsonArray<string>(s.tagsJson), 'Not In Library'],
    OfficialRating:     s.officialRating || undefined,
    CommunityRating:    s.communityRating || undefined,
    ExternalUrls:       externalUrls('show', s.imdbId, s.tmdbId),
    DateCreated:        s.syncedAt,
    IsFolder:           true,
    ChildCount:         0,
    RecursiveItemCount: 0,
    Status:             s.status,
    ImageTags:          {
      ...(posterTag ? { Primary: posterTag } : {}),
      ...(logoTag ? { Logo: logoTag } : {}),
      ...(thumbTag ? { Thumb: thumbTag } : {}),
    },
    PrimaryImageTag:    null,
    BackdropImageTags:  s.backdropPath ? [s.backdropPath.replace(/\W/g, '').slice(0, 16)] : [],
    ParentId:           SHOWS_FOLDER_ID,
    ProviderIds:        { Imdb: s.imdbId || undefined, Tmdb: String(s.tmdbId) },
    UserData:           userDataForItem(id, { played: false, playCount: 0, positionTicks: 0, lastPlayedDate: '' }),
  }
}

function visibleSeasonsForShow(show: Show): Season[] {
  const seasons = getSeasonsForShow(show.tmdbId)
  const showMode = getEffectiveShowMode(show.tmdbId)
  if (showMode.mode !== 'latest' || !showMode.activeSeasonNumber) return seasons
  return seasons.filter(s => s.seasonNumber === showMode.activeSeasonNumber)
}

function visibleAiredEpisodesForShow(show: Show): Episode[] {
  return visibleSeasonsForShow(show).flatMap(s => getAiredEpisodesForSeason(show.tmdbId, s.seasonNumber))
}

function filterMoviesForUser(user: AppUser, movies: Movie[]): Movie[] {
  return movies.filter(movie => canUserAccessMovie(user, movie))
}

function filterShowsForUser(user: AppUser, shows: Show[]): Show[] {
  return shows.filter(show => canUserAccessShow(user, show))
}

function fallbackUser(): AppUser | null {
  return getUserById(DEFAULT_ADMIN_USER_ID)
}

function requestUser(headers: Record<string, string | string[] | undefined>): AppUser | null {
  return resolveJellyfinUser(headers) ?? (authEnabled() ? null : fallbackUser())
}

function pagedItems<T>(items: T[], offset: number, limit: number): T[] {
  if (limit <= 0) return []
  return items.slice(offset, offset + limit)
}

function rootFolderImageTags(id: string) {
  return ROOT_FOLDER_ART[id] ? { Primary: 'root' } : {}
}

function compareEpisodeOrder(a: Pick<Episode, 'seasonNumber' | 'episodeNumber'>, b: Pick<Episode, 'seasonNumber' | 'episodeNumber'>): number {
  if (a.seasonNumber !== b.seasonNumber) return a.seasonNumber - b.seasonNumber
  return a.episodeNumber - b.episodeNumber
}

async function buildSearchResultItems(
  searchTerm: string,
  includeTypes: string,
  sortBy: string | undefined,
  sortOrder: string | undefined,
  limit: number,
  offset: number,
  user: AppUser,
) {
  const wantMovies = !includeTypes || includeTypes.includes('movie')
  const wantShows = !includeTypes || includeTypes.includes('series')

  const [externalMovies, externalShows] = await Promise.all([
    wantMovies ? searchTmdb(searchTerm).catch(() => []) : Promise.resolve([]),
    wantShows ? searchTmdbShows(searchTerm).catch(() => []) : Promise.resolve([]),
  ])

  const localMovies = wantMovies
    ? filterMoviesForUser(user, listMovies({ search: searchTerm, sortBy, sortOrder, limit: 10_000, offset: 0, userId: user.id, ...API_LIBRARY_FILTER }))
    : []
  const localShows = wantShows
    ? filterShowsForUser(user, listShows({ search: searchTerm, sortBy, sortOrder, limit: 10_000, offset: 0, userId: user.id, ...API_LIBRARY_FILTER }))
    : []

  const localMovieIds = new Set(localMovies.map(movie => movie.tmdbId))
  const localShowIds = new Set(localShows.map(show => show.tmdbId))

  const searchOnlyMovies = externalMovies
    .filter(movie => canUserAccessMovie(user, movie))
    .filter(movie => !localMovieIds.has(movie.tmdbId) && !hasAnySourceItem('movie', movie.tmdbId))
    .map(movieToSearchItem)

  const searchOnlyShows = externalShows
    .filter(show => canUserAccessShow(user, show))
    .filter(show => !localShowIds.has(show.tmdbId) && !hasAnySourceItem('show', show.tmdbId))
    .map(showToSearchSeriesItem)

  const combined = [
    ...localMovies.map(movie => movieToItem(movie, user.id)),
    ...localShows.map(show => showToSeriesItem(show, user.id)),
    ...searchOnlyMovies,
    ...searchOnlyShows,
  ]

  return {
    Items: pagedItems(combined, offset, limit),
    TotalRecordCount: combined.length,
    StartIndex: offset,
  }
}

function findNextUpEpisode(show: Show, playedIds: Set<string>): Episode | null {
  const airedEpisodes = visibleAiredEpisodesForShow(show)
  if (!airedEpisodes.length) return null

  let highestPlayed: Episode | null = null
  for (const ep of airedEpisodes) {
    if (!playedIds.has(episodeToId(show.tmdbId, ep.seasonNumber, ep.episodeNumber))) continue
    if (!highestPlayed || compareEpisodeOrder(ep, highestPlayed) > 0) {
      highestPlayed = ep
    }
  }

  if (!highestPlayed) return null

  for (const ep of airedEpisodes) {
    if (compareEpisodeOrder(ep, highestPlayed) <= 0) continue
    if (!playedIds.has(episodeToId(show.tmdbId, ep.seasonNumber, ep.episodeNumber))) return ep
  }

  return null
}

function seasonToItem(season: Season, show: Show, userId = DEFAULT_ADMIN_USER_ID) {
  const seriesId = showTmdbToId(show.tmdbId)
  const id = seasonToId(show.tmdbId, season.seasonNumber)
  const ud = getUserData(id, userId)
  return {
    Id:                 id,
    ServerId:           SERVER_GUID,
    SeriesId:           seriesId,
    SeriesName:         show.title,
    Name:               season.name || `Season ${season.seasonNumber}`,
    SortName:           `season ${season.seasonNumber.toString().padStart(4, '0')}`,
    Type:               'Season',
    LocationType:       'FileSystem',
    PlayAccess:         'Full',
    IsPlayable:         false,
    CanDelete:          false,
    CanDownload:        false,
    ProductionYear:     season.airDate ? parseInt(season.airDate.slice(0, 4)) : show.year,
    Overview:           season.overview,
    PremiereDate:       jellyfinPremiereDate(season.airDate),
    DateCreated:        season.syncedAt,
    IsFolder:           true,
    IndexNumber:        season.seasonNumber,
    ChildCount:         season.episodeCount,
    RecursiveItemCount: season.episodeCount,
    ImageTags:          season.posterPath ? { Primary: 'poster' } : {},
    PrimaryImageTag:    season.posterPath ? 'poster' : undefined,
    BackdropImageTags:  [],
    ParentId:           seriesId,
    UserData:           userDataForItem(id, ud),
  }
}

function episodeToItem(ep: Episode, show: Show, userId = DEFAULT_ADMIN_USER_ID) {
  const genres: string[] = JSON.parse(show.genres || '[]')
  const seriesId  = showTmdbToId(show.tmdbId)
  const seasonId  = seasonToId(show.tmdbId, ep.seasonNumber)
  const id        = episodeToId(show.tmdbId, ep.seasonNumber, ep.episodeNumber)
  const ud        = getUserData(id, userId)
  const runtimeTicks = (ep.runtimeMins || 45) * 60 * 10_000_000
  const safeShowTitle = show.title.replace(/[/\\:*?"<>|]/g, '')
  const safeEpisodeName = (ep.name || `Episode ${ep.episodeNumber}`).replace(/[/\\:*?"<>|]/g, '')
  const fakeFilename = `${safeShowTitle} - S${ep.seasonNumber.toString().padStart(2, '0')}E${ep.episodeNumber.toString().padStart(2, '0')} - ${safeEpisodeName}.mkv`
  const fakePath = `/shows/${safeShowTitle}/Season ${ep.seasonNumber}/${fakeFilename}`
  const showPosterTag = show.posterPath ? show.posterPath.replace(/\W/g, '').slice(0, 16) : undefined
  const showBackdropTag = show.backdropPath ? show.backdropPath.replace(/\W/g, '').slice(0, 16) : undefined
  const showLogoTag = show.logoPath ? show.logoPath.replace(/\W/g, '').slice(0, 16) : undefined
  return {
    Id:                    id,
    ServerId:              SERVER_GUID,
    SeriesId:              seriesId,
    SeriesName:            show.title,
    SeasonId:              seasonId,
    Name:                  ep.name || `Episode ${ep.episodeNumber}`,
    SortName:              `s${ep.seasonNumber.toString().padStart(4,'0')}e${ep.episodeNumber.toString().padStart(4,'0')}`,
    Type:                  'Episode',
    MediaType:             'Video',
    VideoType:             'VideoFile',
    LocationType:          'FileSystem',
    PlayAccess:            'Full',
    IsPlayable:            true,
    CanDelete:             false,
    CanDownload:           false,
    ProductionYear:        ep.airDate ? parseInt(ep.airDate.slice(0, 4)) : show.year,
    Overview:              ep.overview,
    Genres:                genres,
    GenreItems:            genreItems(genres),
    Studios:               null,
    Tags:                  null,
    OfficialRating:        undefined,
    CommunityRating:       ep.communityRating || undefined,
    ExternalUrls:          null,
    PremiereDate:          jellyfinPremiereDate(ep.airDate),
    DateCreated:           ep.syncedAt,
    IsFolder:              false,
    IndexNumber:           ep.episodeNumber,
    ParentIndexNumber:     ep.seasonNumber,
    RunTimeTicks:          runtimeTicks,
    Path:                  fakePath,
    ImageTags:             ep.stillPath ? { Primary: 'still' } : {},
    PrimaryImageTag:       undefined,
    BackdropImageTags:     [],
    ParentId:              seasonId,
    SeriesPrimaryImageTag: showPosterTag,
    SeasonPrimaryImageTag: undefined,
    ParentThumbItemId:     seriesId,
    ParentThumbImageTag:   showPosterTag,
    ParentBackdropItemId:  seriesId,
    ParentBackdropImageTags: showBackdropTag ? [showBackdropTag] : [],
    ParentLogoItemId:      showLogoTag ? seriesId : undefined,
    ParentLogoImageTag:    showLogoTag,
    MediaSources: [{
      Protocol:             'File',
      Id:                   id,
      Type:                 'Default',
      Container:            'mkv',
      Size:                 0,
      Name:                 ep.name || `S${ep.seasonNumber}E${ep.episodeNumber}`,
      Path:                 fakePath,
      IsRemote:             false,
      RunTimeTicks:         runtimeTicks,
      SupportsTranscoding:  false,
      SupportsDirectStream: true,
      SupportsDirectPlay:   true,
      IsInfiniteStream:     false,
      RequiresOpening:      false,
      RequiresClosing:      false,
    }],
    UserData:              userDataForItem(id, ud, runtimeTicks),
  }
}

function createJellyfinToken(userId: string): string {
  const token = createHash('sha256').update(`${userId}:${Date.now()}:${Math.random()}`).digest('hex')
  jellyfinTokens.set(token, { userId, expiresAt: Date.now() + JELLYFIN_TOKEN_TTL_MS })
  return token
}

function parseJellyfinToken(headers: Record<string, string | string[] | undefined>): string | null {
  const direct = headers['x-emby-token'] ?? headers['x-mediabrowser-token']
  if (typeof direct === 'string' && direct.trim()) return direct.trim()
  const auth = headers.authorization
  if (typeof auth !== 'string') return null
  const match = auth.match(/\bToken="?([^",\s]+)"?/i)
  return match ? match[1] : null
}

export function resolveJellyfinUser(headers: Record<string, string | string[] | undefined>): AppUser | null {
  const token = parseJellyfinToken(headers)
  if (!token) return null
  const record = jellyfinTokens.get(token)
  if (!record) return null
  if (record.expiresAt <= Date.now()) {
    jellyfinTokens.delete(token)
    return null
  }
  return getUserById(record.userId)
}

function jellyfinUser(user: AppUser) {
  return {
    Name:                  user.username,
    Id:                    user.id,
    HasPassword:           true,
    HasConfiguredPassword: true,
    EnableAutoLogin:       false,
    Policy: {
      IsAdministrator: user.role === 'admin',
      EnableAllFolders: true,
      EnableMediaPlayback: true,
    },
  }
}

// ── Route registration ────────────────────────────────────────────────────────

export async function jellyfinRoutes(app: FastifyInstance) {

  function requireJellyfinUser(
    headers: Record<string, string | string[] | undefined>,
    reply: FastifyReply,
  ): AppUser | null {
    if (!authEnabled()) {
      reply.code(503).send({ error: 'User auth is not configured.' })
      return null
    }
    const user = requestUser(headers)
    if (!user) {
      reply.code(401).send({ error: 'Unauthorized' })
      return null
    }
    return user
  }

  // System info — probed before and after auth
  app.get('/System/Info',        async () => systemInfo())
  app.get('/System/Info/Public', async () => systemInfo())

  function systemInfo() {
    return {
      ServerName:             config.serverName,
      Id:                     SERVER_GUID,
      Version:                '10.9.0',
      ProductName:            'Jellyfin Server',
      OperatingSystem:        'Linux',
      StartupWizardCompleted: true,
    }
  }

  // Plugins/Packages — return empty lists
  app.get('/Plugins',  async () => ([]))
  app.get('/Packages', async () => ([]))

  // Display preferences — return minimal defaults
  app.get('/DisplayPreferences/:id', async () => ({
    Id:               'usersettings',
    SortBy:           'SortName',
    SortOrder:        'Ascending',
    RememberSorting:  false,
    RememberIndexing: false,
    ShowBackdrop:     true,
    ShowSidebar:      false,
    CustomPrefs:      {},
    Client:           'emby',
  }))

  // Auth — verify credentials if UI_PASSWORD is set
  app.post('/Users/AuthenticateByName', async (req, reply) => {
    if (!authEnabled()) return reply.code(503).send({ error: 'User auth is not configured.' })
    const rateKey = clientIp(req.headers)
    const state = loginRateState(rateKey)
    if (state.count >= LOGIN_MAX_ATTEMPTS) {
      return reply.code(429).send({ error: 'Too many login attempts. Please try again later.' })
    }
    const body = req.body as { Username?: string; Pw?: string } | undefined
    const username = body?.Username ?? ''
    const password = body?.Pw ?? ''
    const user = verifyUserCredentials(username, password)
    if (!user) {
      state.count += 1
      return reply.code(401).send({ error: 'Invalid credentials' })
    }
    loginAttempts.delete(rateKey)
    return {
      AccessToken: createJellyfinToken(user.id),
      ServerId:    SERVER_GUID,
      User:        jellyfinUser(user),
    }
  })

  // User profile
  app.get('/Users/:id', async (req, reply) => {
    const user = requireJellyfinUser(req.headers, reply)
    if (!user) return
    return jellyfinUser(user)
  })
  app.get('/Users/Me',  async (req, reply) => {
    const user = requireJellyfinUser(req.headers, reply)
    if (!user) return
    return jellyfinUser(user)
  })

  // Library sections
  app.get('/Library/VirtualFolders', async () => ([
    { Name: 'Movies', CollectionType: 'movies', ItemId: MOVIES_FOLDER_ID, Locations: ['/movies'] },
    { Name: 'Shows',  CollectionType: 'tvshows', ItemId: SHOWS_FOLDER_ID,  Locations: ['/shows'] },
  ]))

  // Grouping options
  app.get('/Users/:id/GroupingOptions', async () => ([
    { Name: 'Movies', Id: MOVIES_FOLDER_ID, Type: 'movies' },
    { Name: 'Shows',  Id: SHOWS_FOLDER_ID,  Type: 'tvshows' },
  ]))
  app.get('/UserViews/GroupingOptions', async () => ([
    { Name: 'Movies', Id: MOVIES_FOLDER_ID, Type: 'movies' },
    { Name: 'Shows',  Id: SHOWS_FOLDER_ID,  Type: 'tvshows' },
  ]))

  // Views — library sections
  function viewItemsResponse(user: AppUser) {
    const moviesCount = filterMoviesForUser(user, listMovies({ limit: 10_000, offset: 0, userId: user.id, ...API_LIBRARY_FILTER })).length
    const showsCount = filterShowsForUser(user, listShows({ limit: 10_000, offset: 0, userId: user.id, ...API_LIBRARY_FILTER })).length
    return {
      Items: [
        {
          Name:               'Movies',
          Id:                 MOVIES_FOLDER_ID,
          ServerId:           SERVER_GUID,
          Type:               'CollectionFolder',
          CollectionType:     'movies',
          ImageTags:          rootFolderImageTags(MOVIES_FOLDER_ID),
          IsFolder:           true,
          ChildCount:         moviesCount,
          RecursiveItemCount: moviesCount,
          UserData: { PlaybackPositionTicks: 0, PlayCount: 0, IsFavorite: false, Played: false, Key: MOVIES_FOLDER_ID },
        },
        {
          Name:               'Shows',
          Id:                 SHOWS_FOLDER_ID,
          ServerId:           SERVER_GUID,
          Type:               'CollectionFolder',
          CollectionType:     'tvshows',
          ImageTags:          rootFolderImageTags(SHOWS_FOLDER_ID),
          IsFolder:           true,
          ChildCount:         showsCount,
          RecursiveItemCount: showsCount,
          UserData: { PlaybackPositionTicks: 0, PlayCount: 0, IsFavorite: false, Played: false, Key: SHOWS_FOLDER_ID },
        },
      ],
      TotalRecordCount: 2,
      StartIndex: 0,
    }
  }

  app.get('/Users/:id/Views', async (req, reply) => {
    const user = requireJellyfinUser(req.headers, reply)
    if (!user) return
    return viewItemsResponse(user)
  })
  app.get('/UserViews', async (req, reply) => {
    const user = requireJellyfinUser(req.headers, reply)
    if (!user) return
    return viewItemsResponse(user)
  })

  // Browse + search — /Users/{id}/Items and /Items
  async function handleItems(req: { query: Record<string, string>; headers: Record<string, string | string[] | undefined> }) {
    const user = requestUser(req.headers)
    if (!user) return { Items: [], TotalRecordCount: 0, StartIndex: 0 }
    // Infuse sends params in camelCase (parentId, sortBy, startIndex, limit).
    // Normalize to lowercase keys so we handle both cases transparently.
    const q: Record<string, string> = {}
    for (const [k, v] of Object.entries(req.query)) q[k.toLowerCase()] = v

    const SearchTerm      = q.searchterm
    const SortBy          = q.sortby
    const SortOrder       = q.sortorder
    const ParentId        = q.parentid
    const includeTypes    = (q.includeitemtypes ?? '').toLowerCase()
    const limit           = q.limit ? parseInt(q.limit) : 10_000
    const offset          = parseInt(q.startindex ?? '0')

    // ── Shows folder ───────────────────────────────────────────────────────────
    if (ParentId === SHOWS_FOLDER_ID) {
      // Infuse scans the library with three separate recursive queries:
      // includeItemTypes=Season  → flat list of all seasons across all shows
      // includeItemTypes=Episode → flat list of all aired episodes across all shows
      // includeItemTypes=Series  → list of series (default)
      if (includeTypes.includes('season')) {
        const allPairs = await withReadCache(`items:season-pairs:${user.id}`, async () => {
          const shows = filterShowsForUser(user, listShows({ limit: 100_000, userId: user.id, ...API_LIBRARY_FILTER }))
          return shows.flatMap(show =>
            visibleSeasonsForShow(show).map(season => ({ show, season }))
          )
        })
        const total = allPairs.length
        if (limit <= 0) return { Items: [], TotalRecordCount: total, StartIndex: offset }
        const items = pagedItems(allPairs, offset, limit).map(({ show, season }) => seasonToItem(season, show, user.id))
        return { Items: items, TotalRecordCount: total, StartIndex: offset }
      }
      if (includeTypes.includes('episode')) {
        const allPairs = await withReadCache(`items:episode-pairs:${user.id}`, async () => {
          const shows = filterShowsForUser(user, listShows({ limit: 100_000, userId: user.id, ...API_LIBRARY_FILTER }))
          return shows.flatMap(show =>
            visibleAiredEpisodesForShow(show).map(ep => ({ show, ep }))
          )
        })
        const total = allPairs.length
        if (limit <= 0) return { Items: [], TotalRecordCount: total, StartIndex: offset }
        const items = pagedItems(allPairs, offset, limit).map(({ show, ep }) => episodeToItem(ep, show, user.id))
        return { Items: items, TotalRecordCount: total, StartIndex: offset }
      }
      // Default: series list
      if (SearchTerm) {
        return buildSearchResultItems(SearchTerm, 'series', SortBy, SortOrder, limit, offset, user)
      }
      const allShows = filterShowsForUser(user, listShows({ search: SearchTerm, sortBy: SortBy, sortOrder: SortOrder, limit: 10_000, offset: 0, userId: user.id, ...API_LIBRARY_FILTER }))
      return { Items: pagedItems(allShows, offset, limit).map(show => showToSeriesItem(show, user.id)), TotalRecordCount: allShows.length, StartIndex: offset }
    }

    // ── Series ID: list seasons ────────────────────────────────────────────────
    const seriesRef = ParentId ? idToShowTmdb(ParentId) : null
    if (seriesRef) {
      const show = getShowByTmdbId(seriesRef) ?? await fetchShowByTmdbId(seriesRef)
      if (!show) return { Items: [], TotalRecordCount: 0, StartIndex: offset }
      if (!canUserAccessShow(user, show)) return { Items: [], TotalRecordCount: 0, StartIndex: offset }
      await ensureShowSeasonsCached(show).catch(() => {})
      const seasons = visibleSeasonsForShow(show)
      return { Items: seasons.map(s => seasonToItem(s, show, user.id)), TotalRecordCount: seasons.length, StartIndex: offset }
    }

    // ── Season ID: list episodes ───────────────────────────────────────────────
    const seasonRef = ParentId ? idToSeason(ParentId) : null
    if (seasonRef) {
      const show = getShowByTmdbId(seasonRef.showTmdbId) ?? await fetchShowByTmdbId(seasonRef.showTmdbId)
      if (!show) return { Items: [], TotalRecordCount: 0, StartIndex: offset }
      if (!canUserAccessShow(user, show)) return { Items: [], TotalRecordCount: 0, StartIndex: offset }
      if (!getEpisodesForSeason(show.tmdbId, seasonRef.seasonNum).length) {
        await fetchAndCacheSeasonDetails(show.tmdbId, seasonRef.seasonNum).catch(() => {})
      }
      const visibleSeasonNums = new Set(visibleSeasonsForShow(show).map(s => s.seasonNumber))
      const episodes = visibleSeasonNums.has(seasonRef.seasonNum)
        ? getAiredEpisodesForSeason(show.tmdbId, seasonRef.seasonNum)
        : []
      return { Items: episodes.map(e => episodeToItem(e, show, user.id)), TotalRecordCount: episodes.length, StartIndex: offset }
    }

    // ── Search: movies + shows ─────────────────────────────────────────────────
    if (SearchTerm) {
      return buildSearchResultItems(SearchTerm, includeTypes, SortBy, SortOrder, limit, offset, user)
    }

    // ── No parentId: route by includeItemTypes or return folders ─────────────
    if (!ParentId) {
      // Infuse main page "TV Shows" calls Items?includeItemTypes=Series&recursive=true
      if (includeTypes.includes('series')) {
        const shows = filterShowsForUser(user, listShows({ search: SearchTerm, sortBy: SortBy, sortOrder: SortOrder, limit: 10_000, offset: 0, userId: user.id, ...API_LIBRARY_FILTER }))
        return { Items: pagedItems(shows, offset, limit).map(show => showToSeriesItem(show, user.id)), TotalRecordCount: shows.length, StartIndex: offset }
      }
      // Infuse main page "Movies" calls Items?includeItemTypes=Movie&recursive=true
      if (includeTypes.includes('movie')) {
        const movies = filterMoviesForUser(user, listMovies({ search: SearchTerm, sortBy: SortBy, sortOrder: SortOrder, limit: 10_000, offset: 0, userId: user.id, ...API_LIBRARY_FILTER }))
        return { Items: pagedItems(movies, offset, limit).map(movie => movieToItem(movie, user.id)), TotalRecordCount: movies.length, StartIndex: offset }
      }
      // True root listing: return collection folders
      const nMovies = filterMoviesForUser(user, listMovies({ limit: 10_000, offset: 0, userId: user.id, ...API_LIBRARY_FILTER })).length
      const nShows  = filterShowsForUser(user, listShows({ limit: 10_000, offset: 0, userId: user.id, ...API_LIBRARY_FILTER })).length
      return {
        Items: [
          {
            Id: MOVIES_FOLDER_ID, ServerId: SERVER_GUID, Name: 'Movies',
            Type: 'CollectionFolder', CollectionType: 'movies', IsFolder: true,
            ChildCount: nMovies, RecursiveItemCount: nMovies, ImageTags: rootFolderImageTags(MOVIES_FOLDER_ID),
            UserData: { PlaybackPositionTicks: 0, PlayCount: 0, IsFavorite: false, Played: false, Key: MOVIES_FOLDER_ID },
          },
          {
            Id: SHOWS_FOLDER_ID, ServerId: SERVER_GUID, Name: 'Shows',
            Type: 'CollectionFolder', CollectionType: 'tvshows', IsFolder: true,
            ChildCount: nShows, RecursiveItemCount: nShows, ImageTags: rootFolderImageTags(SHOWS_FOLDER_ID),
            UserData: { PlaybackPositionTicks: 0, PlayCount: 0, IsFavorite: false, Played: false, Key: SHOWS_FOLDER_ID },
          },
        ],
        TotalRecordCount: 2,
        StartIndex: offset,
      }
    }

    // ── Movies folder: list movies (Season/Episode queries return empty) ──────
    if (includeTypes.includes('season') || includeTypes.includes('episode')) {
      return { Items: [], TotalRecordCount: 0, StartIndex: offset }
    }
    if (SearchTerm) {
      return buildSearchResultItems(SearchTerm, 'movie', SortBy, SortOrder, limit, offset, user)
    }
    const movies = filterMoviesForUser(user, listMovies({ search: SearchTerm, sortBy: SortBy, sortOrder: SortOrder, limit: 10_000, offset: 0, userId: user.id, ...API_LIBRARY_FILTER }))
    return { Items: pagedItems(movies, offset, limit).map(movie => movieToItem(movie, user.id)), TotalRecordCount: movies.length, StartIndex: offset }
  }

  app.get('/Items',           async (req) => handleItems(req as never))
  app.get('/Users/:id/Items', async (req) => handleItems(req as never))

  async function handleSearchHints(req: { query: Record<string, string>; headers: Record<string, string | string[] | undefined> }) {
    const user = requestUser(req.headers)
    if (!user) return { SearchHints: [], TotalRecordCount: 0 }
    const q: Record<string, string> = {}
    for (const [k, v] of Object.entries(req.query)) q[k.toLowerCase()] = v

    const SearchTerm = q.searchterm ?? q.term ?? ''
    const includeTypes = (q.includeitemtypes ?? '').toLowerCase()
    const limit = q.limit ? parseInt(q.limit, 10) : 20
    const offset = parseInt(q.startindex ?? '0', 10)

    if (!SearchTerm.trim()) {
      return { SearchHints: [], TotalRecordCount: 0 }
    }

    const results = await buildSearchResultItems(SearchTerm, includeTypes, undefined, undefined, limit, offset, user)
    return {
      SearchHints: results.Items,
      TotalRecordCount: results.TotalRecordCount,
    }
  }

  app.get('/Search/Hints', async (req) => handleSearchHints(req as never))
  app.get('/Users/:id/Search/Hints', async (req) => handleSearchHints(req as never))

  app.get('/Shows/NextUp', async (req) => {
    const user = requestUser(req.headers)
    if (!user) return { Items: [], TotalRecordCount: 0, StartIndex: 0 }
    const rawQuery = (req as never as { query: Record<string, string> }).query
    const q: Record<string, string> = {}
    for (const [k, v] of Object.entries(rawQuery)) q[k.toLowerCase()] = v
    const limit = parseInt(q.limit ?? '16', 10)
    const offset = parseInt(q.startindex ?? '0', 10)
    const nextUpItems = await withReadCache(`nextup:${user.id}`, async () => {
      const playedIds = getAllPlayedItemIds(user.id)
      return filterShowsForUser(user, listShows({ limit: 100_000, userId: user.id, ...API_LIBRARY_FILTER }))
        .map(show => {
          const ep = findNextUpEpisode(show, playedIds)
          return ep ? { show, ep } : null
        })
        .filter((value): value is { show: Show; ep: Episode } => value !== null)
        .sort((a, b) => {
          const aDate = a.ep.airDate || ''
          const bDate = b.ep.airDate || ''
          if (aDate !== bDate) return bDate.localeCompare(aDate)
          return a.show.title.localeCompare(b.show.title)
        })
    })

    const paged = nextUpItems.slice(offset, offset + limit)
    return {
      Items: paged.map(({ show, ep }) => episodeToItem(ep, show, user.id)),
      TotalRecordCount: nextUpItems.length,
      StartIndex: offset,
    }
  })

  // Resume / Continue Watching
  async function handleResumeItems(req: { query: Record<string, string>; headers: Record<string, string | string[] | undefined> }) {
    const user = requestUser(req.headers)
    if (!user) return { Items: [], TotalRecordCount: 0, StartIndex: 0 }
    const q: Record<string, string> = {}
    for (const [k, v] of Object.entries(req.query)) q[k.toLowerCase()] = v
    const limit = q.limit ? parseInt(q.limit, 10) : 50
    const offset = q.startindex ? parseInt(q.startindex, 10) : 0
    return withReadCache(`resume:${user.id}:${offset}:${limit}`, async () => {
      const ids = listResumeItemIds(limit, offset, user.id)
      const items = []
      for (const id of ids) {
        const item = await handleItem(id, {
          code: () => ({ send: () => null }),
        }, user)
        if (item && typeof item === 'object' && (item as Record<string, unknown>).Type !== 'Season' && (item as Record<string, unknown>).Type !== 'Series') {
          items.push(item)
        }
      }
      return { Items: items, TotalRecordCount: countResumeItems(user.id), StartIndex: offset }
    })
  }
  app.get('/Users/:id/Items/Resume', async (req) => handleResumeItems(req as never))
  app.get('/UserItems/Resume', async (req) => handleResumeItems(req as never))

  // Latest / Recently Added
  app.get('/Users/:id/Items/Latest', async (req) => {
    const user = requestUser(req.headers)
    if (!user) return []
    const rawQuery = (req as never as { query: Record<string, string> }).query
    const q: Record<string, string> = {}
    for (const [k, v] of Object.entries(rawQuery)) q[k.toLowerCase()] = v
    const lim      = parseInt(q.limit ?? '16')
    const parentId = q.parentid

    if (parentId === SHOWS_FOLDER_ID) {
      return filterShowsForUser(user, listShows({ sortBy: 'popularity', sortOrder: 'DESC', limit: lim, userId: user.id, ...API_LIBRARY_FILTER })).map(show => showToSeriesItem(show, user.id))
    }
    return filterMoviesForUser(user, listMovies({ sortBy: 'popularity', sortOrder: 'DESC', limit: lim, userId: user.id, ...API_LIBRARY_FILTER })).map(movie => movieToItem(movie, user.id))
  })

  // Single item — /Items/:id and /Users/:userId/Items/:itemId
  async function handleItem(id: string, reply: { code: (n: number) => { send: (v: unknown) => unknown } }, user?: AppUser | null) {
    const currentUser = user ?? fallbackUser()
    if (!currentUser) return reply.code(401).send({ error: 'Unauthorized' })
    // Collection folders
    if (id === MOVIES_FOLDER_ID) {
      const n = filterMoviesForUser(currentUser, listMovies({ limit: 10_000, offset: 0, userId: currentUser.id, ...API_LIBRARY_FILTER })).length
      return { Name: 'Movies', Id: MOVIES_FOLDER_ID, ServerId: SERVER_GUID,
        Type: 'CollectionFolder', CollectionType: 'movies', IsFolder: true, Path: '/movies',
        RecursiveItemCount: n, ChildCount: n, ImageTags: rootFolderImageTags(MOVIES_FOLDER_ID),
        UserData: { PlaybackPositionTicks: 0, PlayCount: 0, IsFavorite: false, Played: false, Key: MOVIES_FOLDER_ID } }
    }
    if (id === SHOWS_FOLDER_ID) {
      const n = filterShowsForUser(currentUser, listShows({ limit: 10_000, offset: 0, userId: currentUser.id, ...API_LIBRARY_FILTER })).length
      return { Name: 'Shows', Id: SHOWS_FOLDER_ID, ServerId: SERVER_GUID,
        Type: 'CollectionFolder', CollectionType: 'tvshows', IsFolder: true, Path: '/shows',
        RecursiveItemCount: n, ChildCount: n, ImageTags: rootFolderImageTags(SHOWS_FOLDER_ID),
        UserData: { PlaybackPositionTicks: 0, PlayCount: 0, IsFavorite: false, Played: false, Key: SHOWS_FOLDER_ID } }
    }

    // Episode
    const epRef = idToEpisode(id)
    if (epRef) {
      const show = getShowByTmdbId(epRef.showTmdbId) ?? await fetchShowByTmdbId(epRef.showTmdbId)
      if (!show) return reply.code(404).send({ error: 'Not found' })
      if (!canUserAccessShow(currentUser, show)) return reply.code(404).send({ error: 'Not found' })
      let [ep] = getEpisodesForSeason(show.tmdbId, epRef.seasonNum)
        .filter(e => e.episodeNumber === epRef.episodeNum)
      if (!ep) {
        const eps = await fetchAndCacheSeasonDetails(show.tmdbId, epRef.seasonNum).catch(() => [])
        ep = eps.find(e => e.episodeNumber === epRef.episodeNum)!
      }
      if (!ep) return reply.code(404).send({ error: 'Not found' })
      return episodeToItem(ep, show, currentUser.id)
    }

    // Season
    const seasonRef = idToSeason(id)
    if (seasonRef) {
      const show = getShowByTmdbId(seasonRef.showTmdbId) ?? await fetchShowByTmdbId(seasonRef.showTmdbId)
      if (!show) return reply.code(404).send({ error: 'Not found' })
      if (!canUserAccessShow(currentUser, show)) return reply.code(404).send({ error: 'Not found' })
      let season = getSeason(show.tmdbId, seasonRef.seasonNum)
      if (!season) {
        await fetchAndCacheSeasonDetails(show.tmdbId, seasonRef.seasonNum).catch(() => {})
        season = getSeason(show.tmdbId, seasonRef.seasonNum)
      }
      if (!season) return reply.code(404).send({ error: 'Not found' })
      return seasonToItem(season, show, currentUser.id)
    }

    // Series
    const searchShowTmdbId = idToSearchShowTmdb(id)
    if (searchShowTmdbId) {
      const show = await fetchShowByTmdbId(searchShowTmdbId)
      if (!show) return reply.code(404).send({ error: 'Not found' })
      if (!canUserAccessShow(currentUser, show)) return reply.code(404).send({ error: 'Not found' })
      return showToSearchSeriesItem(show)
    }

    const showTmdbId = idToShowTmdb(id)
    if (showTmdbId) {
      const show = getShowByTmdbId(showTmdbId) ?? await fetchShowByTmdbId(showTmdbId)
      if (!show) return reply.code(404).send({ error: 'Not found' })
      if (!canUserAccessShow(currentUser, show)) return reply.code(404).send({ error: 'Not found' })
      return showToSeriesItem(show, currentUser.id)
    }

    // Movie
    const searchMovieTmdbId = idToSearchMovieTmdb(id)
    if (searchMovieTmdbId) {
      const movie = await fetchMovieByTmdbId(searchMovieTmdbId)
      if (!movie) return reply.code(404).send({ error: 'Not found' })
      if (!canUserAccessMovie(currentUser, movie)) return reply.code(404).send({ error: 'Not found' })
      return movieToSearchItem(movie)
    }

    const tmdbId = idToTmdb(id)
    if (!tmdbId) return reply.code(404).send({ error: 'Not found' })
    const movie = getMovieByTmdbId(tmdbId) ?? await fetchMovieByTmdbId(tmdbId)
    if (!movie) return reply.code(404).send({ error: 'Not found' })
    if (!canUserAccessMovie(currentUser, movie)) return reply.code(404).send({ error: 'Not found' })
    return movieToItem(movie, currentUser.id)
  }

  app.get('/Items/:id',                  async (req, reply) => handleItem((req.params as { id: string }).id, reply as never, requestUser(req.headers)))
  app.get('/Users/:userId/Items/:itemId', async (req, reply) => handleItem((req.params as { itemId: string }).itemId, reply as never, requestUser(req.headers)))

  // Seasons list for a series — Infuse calls this when opening a show
  app.get('/Shows/:seriesId/Seasons', async (req, reply) => {
    const user = requestUser(req.headers)
    if (!user) return reply.code(401).send({ error: 'Unauthorized' })
    const { seriesId } = req.params as { seriesId: string }
    const searchShowTmdbId = idToSearchShowTmdb(seriesId)
    if (searchShowTmdbId) return { Items: [], TotalRecordCount: 0, StartIndex: 0 }
    return withReadCache(`show-seasons:${user.id}:${seriesId}`, async () => {
      const showTmdbId = idToShowTmdb(seriesId)
      if (!showTmdbId) return reply.code(404).send({ error: 'Not found' })
      const show = getShowByTmdbId(showTmdbId) ?? await fetchShowByTmdbId(showTmdbId)
      if (!show) return reply.code(404).send({ error: 'Not found' })
      if (!canUserAccessShow(user, show)) return reply.code(404).send({ error: 'Not found' })
      await ensureShowSeasonsCached(show).catch(() => {})
      const seasons = visibleSeasonsForShow(show)
      return { Items: seasons.map(s => seasonToItem(s, show, user.id)), TotalRecordCount: seasons.length, StartIndex: 0 }
    })
  })

  // Episodes list for a series — Infuse calls this with optional SeasonId filter
  app.get('/Shows/:seriesId/Episodes', async (req, reply) => {
    const user = requestUser(req.headers)
    if (!user) return reply.code(401).send({ error: 'Unauthorized' })
    const { seriesId } = req.params as { seriesId: string }
    const rawQ = (req as never as { query: Record<string, string> }).query
    const SeasonId = rawQ.SeasonId ?? rawQ.seasonId ?? rawQ.seasonid
    const searchShowTmdbId = idToSearchShowTmdb(seriesId)
    if (searchShowTmdbId) return { Items: [], TotalRecordCount: 0, StartIndex: 0 }
    return withReadCache(`show-episodes:${user.id}:${seriesId}:${SeasonId ?? 'all'}`, async () => {
      const showTmdbId = idToShowTmdb(seriesId)
      if (!showTmdbId) return reply.code(404).send({ error: 'Not found' })
      const show = getShowByTmdbId(showTmdbId) ?? await fetchShowByTmdbId(showTmdbId)
      if (!show) return reply.code(404).send({ error: 'Not found' })
      if (!canUserAccessShow(user, show)) return reply.code(404).send({ error: 'Not found' })

      if (SeasonId) {
        const seasonRef = idToSeason(SeasonId)
        if (!seasonRef) return reply.code(404).send({ error: 'Not found' })
        if (!getEpisodesForSeason(show.tmdbId, seasonRef.seasonNum).length) {
          await fetchAndCacheSeasonDetails(show.tmdbId, seasonRef.seasonNum).catch(() => {})
        }
        const visibleSeasonNums = new Set(visibleSeasonsForShow(show).map(s => s.seasonNumber))
        const episodes = visibleSeasonNums.has(seasonRef.seasonNum)
          ? getAiredEpisodesForSeason(show.tmdbId, seasonRef.seasonNum)
          : []
        return { Items: episodes.map(e => episodeToItem(e, show, user.id)), TotalRecordCount: episodes.length, StartIndex: 0 }
      }

      await ensureShowSeasonsCached(show).catch(() => {})
      const allEpisodes = visibleAiredEpisodesForShow(show)
      return { Items: allEpisodes.map(e => episodeToItem(e, show, user.id)), TotalRecordCount: allEpisodes.length, StartIndex: 0 }
    })
  })

  // Images — proxy TMDB/TVDB bytes so clients don't need to follow external redirects
  // Jellyfin image URL can be /Items/:id/Images/:type OR /Items/:id/Images/:type/:index
  async function handleImage(
    id: string,
    type: string,
    query: ImageQuery | undefined,
    headers: Record<string, string | string[] | undefined>,
    user: AppUser | null,
    reply: FastifyReply,
  ) {
    const isBackdrop = type.toLowerCase() === 'backdrop'
    const isLogo = type.toLowerCase() === 'logo'
    const isThumb = type.toLowerCase() === 'thumb'
    const kind = imageKindForType(type)
    const rootFolderArt = ROOT_FOLDER_ART[id]
    if (rootFolderArt && existsSync(rootFolderArt)) {
      reply.type('image/png')
      return reply.send(readFileSync(rootFolderArt))
    }

    // Episode primary/backdrop still → fall back to season poster → series poster
    const epRef = idToEpisode(id)
    if (epRef) {
      const show = getShowByTmdbId(epRef.showTmdbId)
      if (isLogo && show?.logoPath) return sendImageUrl(reply, headers, show.logoPath, 'logo', query)
      const eps = getEpisodesForSeason(epRef.showTmdbId, epRef.seasonNum)
      const ep = eps.find(e => e.episodeNumber === epRef.episodeNum)
      const season = getSeason(epRef.showTmdbId, epRef.seasonNum)
      if (isThumb && show?.backdropPath) return sendImageUrl(reply, headers, show.backdropPath, 'backdrop', query)
      if (ep?.stillPath) return sendImageUrl(reply, headers, ep.stillPath, kind, query)
      if (season?.posterPath) return sendImageUrl(reply, headers, season.posterPath, 'poster', query)
      if (show?.posterPath) return sendImageUrl(reply, headers, show.posterPath, 'poster', query)
      return reply.code(404).send()
    }

    // Series — Primary poster or Backdrop
    const searchShowTmdbId = idToSearchShowTmdb(id)
    if (searchShowTmdbId) {
      const show = await fetchShowByTmdbId(searchShowTmdbId)
      if (!show) return reply.code(404).send()
      if (isLogo && show.logoPath) return sendImageUrl(reply, headers, show.logoPath, 'logo', query)
      if (isThumb && show.backdropPath) return sendImageUrl(reply, headers, show.backdropPath, 'backdrop', query)
      if (isBackdrop && show.backdropPath) return sendImageUrl(reply, headers, show.backdropPath, 'backdrop', query)
      if (show.posterPath) return sendImageUrl(reply, headers, show.posterPath, 'poster', query)
      return reply.code(404).send()
    }

    const showTmdbId = idToShowTmdb(id)
    if (showTmdbId) {
      const show = getShowByTmdbId(showTmdbId) ?? await fetchShowByTmdbId(showTmdbId)
      if (!show) return reply.code(404).send()
      if (isLogo && show.logoPath) return sendImageUrl(reply, headers, show.logoPath, 'logo', query)
      if (isThumb && show.backdropPath) return sendImageUrl(reply, headers, show.backdropPath, 'backdrop', query)
      if (isBackdrop && show.backdropPath) return sendImageUrl(reply, headers, show.backdropPath, 'backdrop', query)
      if (show.posterPath) return sendImageUrl(reply, headers, show.posterPath, 'poster', query)
      return reply.code(404).send()
    }

    // Season poster → fall back to series poster
    const seasonRef = idToSeason(id)
    if (seasonRef) {
      let season = getSeason(seasonRef.showTmdbId, seasonRef.seasonNum)
      if (!season) {
        await fetchAndCacheSeasonDetails(seasonRef.showTmdbId, seasonRef.seasonNum).catch(() => {})
        season = getSeason(seasonRef.showTmdbId, seasonRef.seasonNum)
      }
      if (season?.posterPath) return sendImageUrl(reply, headers, season.posterPath, 'poster', query)
      const show = getShowByTmdbId(seasonRef.showTmdbId)
      if (show?.posterPath) return sendImageUrl(reply, headers, show.posterPath, 'poster', query)
      return reply.code(404).send()
    }

    // Movie poster or backdrop
    const searchMovieTmdbId = idToSearchMovieTmdb(id)
    if (searchMovieTmdbId) {
      const movie = await fetchMovieByTmdbId(searchMovieTmdbId)
      if (!movie) return reply.code(404).send()
      if (isLogo && movie.logoPath) return sendImageUrl(reply, headers, movie.logoPath, 'logo', query)
      if (isThumb && movie.backdropPath) return sendImageUrl(reply, headers, movie.backdropPath, 'backdrop', query)
      if (isBackdrop && movie.backdropPath) return sendImageUrl(reply, headers, movie.backdropPath, 'backdrop', query)
      if (movie.posterPath) return sendImageUrl(reply, headers, movie.posterPath, 'poster', query)
      return reply.code(404).send()
    }

    const tmdbId = idToTmdb(id)
    const movie = tmdbId ? (getMovieByTmdbId(tmdbId) ?? await fetchMovieByTmdbId(tmdbId)) : null
    if (!movie) return reply.code(404).send()
    if (isLogo && movie.logoPath) return sendImageUrl(reply, headers, movie.logoPath, 'logo', query)
    if (isThumb && movie.backdropPath) return sendImageUrl(reply, headers, movie.backdropPath, 'backdrop', query)
    if (isBackdrop && movie.backdropPath) return sendImageUrl(reply, headers, movie.backdropPath, 'backdrop', query)
    if (movie.posterPath) return sendImageUrl(reply, headers, movie.posterPath, 'poster', query)
    return reply.code(404).send()
  }

  app.get('/Items/:id/Images/:type', async (req, reply) => {
    const params = req.params as { id: string; type: string }
    const query = req.query as ImageQuery | undefined
    return handleImage(params.id, params.type, query, req.headers, requestUser(req.headers), reply as never)
  })
  app.get('/Items/:id/Images/:type/:index', async (req, reply) => {
    const params = req.params as { id: string; type: string }
    const query = req.query as ImageQuery | undefined
    return handleImage(params.id, params.type, query, req.headers, requestUser(req.headers), reply as never)
  })

  // Stubs for endpoints Infuse probes but we don't need to implement
  app.get('/Users/:userId/Items/:itemId/LocalTrailers', async () => [])
  app.get('/MediaSegments/:id', async () => ({ Items: [], TotalRecordCount: 0, StartIndex: 0 }))
  app.get('/Users/:userId/Items/:itemId/SpecialFeatures', async () => [])
  app.post('/Sessions/Playing',         async () => ({}))
  app.post('/Sessions/Playing/Progress', async (req) => {
    const user = requestUser((req as { headers: Record<string, string | string[] | undefined> }).headers)
    if (!user) return {}
    const body = (req as never as { body: Record<string, unknown> }).body
    const itemId       = body?.ItemId       as string | undefined
    const positionTicks = body?.PositionTicks as number | undefined
    if (itemId && positionTicks != null) {
      saveProgress(itemId, positionTicks, user.id)
      app.log.info(`progress: saved ${itemId} at ${positionTicks} ticks`)
    } else {
      app.log.warn(`progress: missing item or position in /Sessions/Playing/Progress payload`)
    }
    return {}
  })
  app.post('/Sessions/Playing/Progres', async (req) => {
    const user = requestUser((req as { headers: Record<string, string | string[] | undefined> }).headers)
    if (!user) return {}
    const body = (req as never as { body: Record<string, unknown> }).body
    const itemId       = body?.ItemId       as string | undefined
    const positionTicks = body?.PositionTicks as number | undefined
    if (itemId && positionTicks != null) {
      saveProgress(itemId, positionTicks, user.id)
      app.log.info(`progress: saved ${itemId} at ${positionTicks} ticks`)
    } else {
      app.log.warn(`progress: missing item or position in /Sessions/Playing/Progress payload`)
    }
    return {}
  })
  app.post('/Sessions/Playing/Stopped', async (req) => {
    const user = requestUser(req.headers)
    if (!user) return {}
    const body = (req as never as { body: Record<string, unknown> }).body
    const itemId            = body?.ItemId             as string  | undefined
    const positionTicks     = body?.PositionTicks      as number  | undefined
    const bodyRuntimeTicks  = body?.RunTimeTicks       as number  | undefined
    const playedToCompletion = body?.PlayedToCompletion as boolean | undefined
    if (itemId) {
      const runtimeTicks = bodyRuntimeTicks ?? runtimeTicksForItem(itemId) ?? undefined
      if (playedToCompletion || reachedCompletionThreshold(positionTicks, runtimeTicks)) {
        markPlayed(itemId, user.id)
        if (playedToCompletion) {
          app.log.info(`progress: marked played ${itemId}`)
        } else {
          app.log.info(`progress: auto-marked played ${itemId} at ${positionTicks} / ${runtimeTicks} ticks`)
        }
      } else if (positionTicks != null) {
        saveProgress(itemId, positionTicks, user.id)
        app.log.info(`progress: stopped ${itemId} at ${positionTicks} ticks`)
      } else {
        app.log.warn(`progress: missing stop position for ${itemId}`)
      }
    }
    return {}
  })
  app.post('/Users/:userId/PlayedItems/:itemId', async (req) => {
    const { itemId } = (req as never as { params: { itemId: string } }).params
    const user = requestUser(req.headers)
    if (!user) return {}
    markPlayed(itemId, user.id)
    const ud = getUserData(itemId, user.id)
    return { PlayCount: ud.playCount, Played: ud.played, LastPlayedDate: ud.lastPlayedDate || undefined }
  })
  app.delete('/Users/:userId/PlayedItems/:itemId', async (req) => {
    const { itemId } = (req as never as { params: { itemId: string } }).params
    const user = requestUser(req.headers)
    if (!user) return {}
    markUnplayed(itemId, user.id)
    return {}
  })

  // Playback — handles both movies and episodes
  async function handlePlaybackInfo(
    req: { params: { id: string }; headers: Record<string, string> },
    reply: { code: (n: number) => { send: (v: unknown) => unknown } },
  ) {
    const user = requestUser(req.headers)
    if (!user) return reply.code(401).send({ error: 'Unauthorized' })
    const { id } = req.params

    // Episode playback
    const epRef = idToEpisode(id)
    if (epRef) {
      const show = getShowByTmdbId(epRef.showTmdbId) ?? await fetchShowByTmdbId(epRef.showTmdbId)
      if (!show?.imdbId) return reply.code(404).send({ error: 'No IMDb ID for this show' })
      if (!canUserAccessShow(user, show)) return reply.code(404).send({ error: 'Not found' })
      let [ep] = getEpisodesForSeason(show.tmdbId, epRef.seasonNum)
        .filter(e => e.episodeNumber === epRef.episodeNum)
      if (!ep) {
        const eps = await fetchAndCacheSeasonDetails(show.tmdbId, epRef.seasonNum).catch(() => [])
        ep = eps.find(e => e.episodeNumber === epRef.episodeNum)!
      }
      const playPath = `/play/${show.imdbId}/${epRef.seasonNum}/${epRef.episodeNum}`
      const playUrl = createSignedPlaybackUrl(buildPlaybackOrigin(req.headers), playPath)
      const label = ep ? ep.name : `S${epRef.seasonNum}E${epRef.episodeNum}`
      app.log.info(`playback: "${show.title}" ${label} → ${playUrl}`)
      return {
        MediaSources: [{
          Id:                   id,
          Name:                 `${show.title} - ${label}`,
          Type:                 'Default',
          Protocol:             'Http',
          Path:                 playUrl,
          IsRemote:             true,
          SupportsDirectPlay:   true,
          SupportsDirectStream: true,
          SupportsTranscoding:  false,
          RequiresOpening:      false,
          RequiresClosing:      false,
          Container:            'mkv',
          RunTimeTicks:         (ep?.runtimeMins || 45) * 60 * 10_000_000,
          MediaStreams: [
            { Type: 'Video', Index: 0, Codec: 'h264', IsDefault: true },
            { Type: 'Audio', Index: 1, Codec: 'aac',  IsDefault: true, Language: 'eng' },
          ],
        }],
        PlaySessionId: `fetcherr-${id}`,
      }
    }

    // Movie playback
    const tmdbId = idToTmdb(id)
    if (!tmdbId) return reply.code(404).send({ error: 'Not found' })
    const movie = getMovieByTmdbId(tmdbId) ?? await fetchMovieByTmdbId(tmdbId)
    if (!movie?.imdbId) return reply.code(404).send({ error: 'No IMDb ID for this title' })
    if (!canUserAccessMovie(user, movie)) return reply.code(404).send({ error: 'Not found' })
    if (!isMovieVisibleToLibrary(movie)) {
      return reply.code(409).send({ error: 'Title not yet available', message: 'Not Yet Released' })
    }

    const playPath = `/play/${movie.imdbId}`
    const playUrl = createSignedPlaybackUrl(buildPlaybackOrigin(req.headers), playPath)
    app.log.info(`playback: "${movie.title}" → ${playUrl}`)
    return {
      MediaSources: [{
        Id:                   id,
        Name:                 movie.title,
        Type:                 'Default',
        Protocol:             'Http',
        Path:                 playUrl,
        IsRemote:             true,
        SupportsDirectPlay:   true,
        SupportsDirectStream: true,
        SupportsTranscoding:  false,
        RequiresOpening:      false,
        RequiresClosing:      false,
        Container:            'mkv',
        RunTimeTicks:         (movie.runtimeMins || 90) * 60 * 10_000_000,
        MediaStreams: [
          { Type: 'Video', Index: 0, Codec: 'h264', IsDefault: true },
          { Type: 'Audio', Index: 1, Codec: 'aac',  IsDefault: true, Language: 'eng' },
        ],
      }],
      PlaySessionId: `fetcherr-${id}`,
    }
  }

  app.get('/Items/:id/PlaybackInfo',  async (req, reply) => handlePlaybackInfo(req as never, reply as never))
  app.post('/Items/:id/PlaybackInfo', async (req, reply) => handlePlaybackInfo(req as never, reply as never))

  // Video stream redirect (fallback for some Infuse versions)
  app.get('/Videos/:id/stream', async (req, reply) => {
    const { id } = req.params as { id: string }
    const origin = buildPlaybackOrigin(req.headers as Record<string, string | undefined>)

    const epRef = idToEpisode(id)
    if (epRef) {
      const show = getShowByTmdbId(epRef.showTmdbId) ?? await fetchShowByTmdbId(epRef.showTmdbId)
      if (!show?.imdbId) return reply.code(404).send()
      return reply.redirect(createSignedPlaybackUrl(origin, `/play/${show.imdbId}/${epRef.seasonNum}/${epRef.episodeNum}`), 302)
    }

    const tmdbId = idToTmdb(id)
    const movie = tmdbId ? (getMovieByTmdbId(tmdbId) ?? await fetchMovieByTmdbId(tmdbId)) : null
    if (!movie?.imdbId) return reply.code(404).send()
    if (!isMovieVisibleToLibrary(movie)) return reply.code(409).send({ error: 'Title not yet available', message: 'Not Yet Released' })
    return reply.redirect(createSignedPlaybackUrl(origin, `/play/${movie.imdbId}`), 302)
  })
}
