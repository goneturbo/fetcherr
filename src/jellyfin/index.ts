import type { FastifyInstance } from 'fastify'
import { createHash } from 'node:crypto'
import { config } from '../config.js'
import {
  listMovies, countMovies, getMovieByTmdbId,
  getUserData, saveProgress, markPlayed, markUnplayed, listResumeItemIds, countResumeItems,
  getEffectiveShowMode, listShows, countShows, getShowByTmdbId,
  getSeasonsForShow, getSeason, getEpisodesForSeason, getAiredEpisodesForSeason, isMovieVisibleToLibrary,
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

const MOVIES_FOLDER_ID = 'a0000000-0000-4000-8000-000000000001'
const SHOWS_FOLDER_ID  = 'a0000000-0000-4000-8000-000000000002'
const SERVER_GUID      = 'a0000000-0000-0000-0000-000000000001'
const USER_ID          = 'a0000000-0000-0000-0000-000000000002'

// Keep old name as alias so existing code still compiles
const FOLDER_ID = MOVIES_FOLDER_ID

const API_LIBRARY_FILTER = { availableOnly: true as const }
const READ_CACHE_TTL_MS = 1_000

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

function movieToItem(m: Movie) {
  const genres: string[] = JSON.parse(m.genres || '[]')
  const runtimeTicks = (m.runtimeMins || 90) * 60 * 10_000_000
  const fakePath = `/movies/${m.title.replace(/[/\\:*?"<>|]/g, '')} (${m.year}).mkv`
  const id = tmdbToId(m.tmdbId)
  const ud = getUserData(id)
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

function showToSeriesItem(s: Show) {
  const genres: string[] = JSON.parse(s.genres || '[]')
  const id = showTmdbToId(s.tmdbId)
  const ud = getUserData(id)
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

function visibleSeasonsForShow(show: Show): Season[] {
  const seasons = getSeasonsForShow(show.tmdbId)
  const showMode = getEffectiveShowMode(show.tmdbId)
  if (showMode.mode !== 'latest' || !showMode.activeSeasonNumber) return seasons
  return seasons.filter(s => s.seasonNumber === showMode.activeSeasonNumber)
}

function visibleAiredEpisodesForShow(show: Show): Episode[] {
  return visibleSeasonsForShow(show).flatMap(s => getAiredEpisodesForSeason(show.tmdbId, s.seasonNumber))
}

function pagedItems<T>(items: T[], offset: number, limit: number): T[] {
  if (limit <= 0) return []
  return items.slice(offset, offset + limit)
}

function compareEpisodeOrder(a: Pick<Episode, 'seasonNumber' | 'episodeNumber'>, b: Pick<Episode, 'seasonNumber' | 'episodeNumber'>): number {
  if (a.seasonNumber !== b.seasonNumber) return a.seasonNumber - b.seasonNumber
  return a.episodeNumber - b.episodeNumber
}

function findNextUpEpisode(show: Show): Episode | null {
  const airedEpisodes = visibleAiredEpisodesForShow(show)
  if (!airedEpisodes.length) return null

  let highestPlayed: Episode | null = null
  for (const ep of airedEpisodes) {
    const ud = getUserData(episodeToId(show.tmdbId, ep.seasonNumber, ep.episodeNumber))
    if (!ud.played) continue
    if (!highestPlayed || compareEpisodeOrder(ep, highestPlayed) > 0) {
      highestPlayed = ep
    }
  }

  if (!highestPlayed) return null

  for (const ep of airedEpisodes) {
    if (compareEpisodeOrder(ep, highestPlayed) <= 0) continue
    const ud = getUserData(episodeToId(show.tmdbId, ep.seasonNumber, ep.episodeNumber))
    if (!ud.played) return ep
  }

  return null
}

function seasonToItem(season: Season, show: Show) {
  const seriesId = showTmdbToId(show.tmdbId)
  const id = seasonToId(show.tmdbId, season.seasonNumber)
  const ud = getUserData(id)
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

function episodeToItem(ep: Episode, show: Show) {
  const genres: string[] = JSON.parse(show.genres || '[]')
  const seriesId  = showTmdbToId(show.tmdbId)
  const seasonId  = seasonToId(show.tmdbId, ep.seasonNumber)
  const id        = episodeToId(show.tmdbId, ep.seasonNumber, ep.episodeNumber)
  const ud        = getUserData(id)
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

function fakeUser() {
  const hasPassword = !!config.uiPassword
  return {
    Name:                  config.uiUsername || 'admin',
    Id:                    USER_ID,
    HasPassword:           hasPassword,
    HasConfiguredPassword: hasPassword,
    EnableAutoLogin:       !hasPassword,
    Policy: { IsAdministrator: true, EnableAllFolders: true, EnableMediaPlayback: true },
  }
}

// ── Route registration ────────────────────────────────────────────────────────

export async function jellyfinRoutes(app: FastifyInstance) {

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
    if (config.uiPassword) {
      const body = req.body as { Username?: string; Pw?: string } | undefined
      const username = body?.Username ?? ''
      const password = body?.Pw ?? ''
      if (username !== config.uiUsername || password !== config.uiPassword) {
        return reply.code(401).send({ error: 'Invalid credentials' })
      }
    }
    return {
      AccessToken: 'fetcherr-token',
      ServerId:    SERVER_GUID,
      User:        fakeUser(),
    }
  })

  // User profile
  app.get('/Users/:id', async () => fakeUser())
  app.get('/Users/Me',  async () => fakeUser())

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
  function viewItemsResponse() {
    return {
      Items: [
        {
          Name:               'Movies',
          Id:                 MOVIES_FOLDER_ID,
          ServerId:           SERVER_GUID,
          Type:               'CollectionFolder',
          CollectionType:     'movies',
          ImageTags:          {},
          IsFolder:           true,
          ChildCount:         countMovies(undefined, API_LIBRARY_FILTER.availableOnly),
          RecursiveItemCount: countMovies(undefined, API_LIBRARY_FILTER.availableOnly),
          UserData: { PlaybackPositionTicks: 0, PlayCount: 0, IsFavorite: false, Played: false, Key: MOVIES_FOLDER_ID },
        },
        {
          Name:               'Shows',
          Id:                 SHOWS_FOLDER_ID,
          ServerId:           SERVER_GUID,
          Type:               'CollectionFolder',
          CollectionType:     'tvshows',
          ImageTags:          {},
          IsFolder:           true,
          ChildCount:         countShows(undefined, API_LIBRARY_FILTER.availableOnly),
          RecursiveItemCount: countShows(undefined, API_LIBRARY_FILTER.availableOnly),
          UserData: { PlaybackPositionTicks: 0, PlayCount: 0, IsFavorite: false, Played: false, Key: SHOWS_FOLDER_ID },
        },
      ],
      TotalRecordCount: 2,
      StartIndex: 0,
    }
  }

  app.get('/Users/:id/Views', async () => viewItemsResponse())
  app.get('/UserViews', async () => viewItemsResponse())

  // Browse + search — /Users/{id}/Items and /Items
  async function handleItems(req: { query: Record<string, string> }) {
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
        const shows = listShows({ limit: 100_000, ...API_LIBRARY_FILTER })
        const allPairs = shows.flatMap(show =>
          visibleSeasonsForShow(show).map(season => ({ show, season }))
        )
        const total = allPairs.length
        if (limit <= 0) return { Items: [], TotalRecordCount: total, StartIndex: offset }
        const items = pagedItems(allPairs, offset, limit).map(({ show, season }) => seasonToItem(season, show))
        return { Items: items, TotalRecordCount: total, StartIndex: offset }
      }
      if (includeTypes.includes('episode')) {
        const shows = listShows({ limit: 100_000, ...API_LIBRARY_FILTER })
        const allPairs = shows.flatMap(show =>
          visibleAiredEpisodesForShow(show).map(ep => ({ show, ep }))
        )
        const total = allPairs.length
        if (limit <= 0) return { Items: [], TotalRecordCount: total, StartIndex: offset }
        const items = pagedItems(allPairs, offset, limit).map(({ show, ep }) => episodeToItem(ep, show))
        return { Items: items, TotalRecordCount: total, StartIndex: offset }
      }
      // Default: series list
      if (SearchTerm) await searchTmdbShows(SearchTerm).catch(() => {})
      const shows = listShows({ search: SearchTerm, sortBy: SortBy, sortOrder: SortOrder, limit, offset, ...API_LIBRARY_FILTER })
      const total = countShows(SearchTerm, API_LIBRARY_FILTER.availableOnly)
      return { Items: shows.map(showToSeriesItem), TotalRecordCount: total, StartIndex: offset }
    }

    // ── Series ID: list seasons ────────────────────────────────────────────────
    const seriesRef = ParentId ? idToShowTmdb(ParentId) : null
    if (seriesRef) {
      const show = getShowByTmdbId(seriesRef) ?? await fetchShowByTmdbId(seriesRef)
      if (!show) return { Items: [], TotalRecordCount: 0, StartIndex: offset }
      await ensureShowSeasonsCached(show).catch(() => {})
      const seasons = visibleSeasonsForShow(show)
      return { Items: seasons.map(s => seasonToItem(s, show)), TotalRecordCount: seasons.length, StartIndex: offset }
    }

    // ── Season ID: list episodes ───────────────────────────────────────────────
    const seasonRef = ParentId ? idToSeason(ParentId) : null
    if (seasonRef) {
      const show = getShowByTmdbId(seasonRef.showTmdbId) ?? await fetchShowByTmdbId(seasonRef.showTmdbId)
      if (!show) return { Items: [], TotalRecordCount: 0, StartIndex: offset }
      if (!getEpisodesForSeason(show.tmdbId, seasonRef.seasonNum).length) {
        await fetchAndCacheSeasonDetails(show.tmdbId, seasonRef.seasonNum).catch(() => {})
      }
      const visibleSeasonNums = new Set(visibleSeasonsForShow(show).map(s => s.seasonNumber))
      const episodes = visibleSeasonNums.has(seasonRef.seasonNum)
        ? getAiredEpisodesForSeason(show.tmdbId, seasonRef.seasonNum)
        : []
      return { Items: episodes.map(e => episodeToItem(e, show)), TotalRecordCount: episodes.length, StartIndex: offset }
    }

    // ── Search: movies + shows ─────────────────────────────────────────────────
    if (SearchTerm) {
      await Promise.all([
        searchTmdb(SearchTerm).catch(() => {}),
        searchTmdbShows(SearchTerm).catch(() => {}),
      ])
      const movies = listMovies({ search: SearchTerm, sortBy: SortBy, sortOrder: SortOrder, limit, offset, ...API_LIBRARY_FILTER })
      const shows  = listShows({ search: SearchTerm, sortBy: SortBy, sortOrder: SortOrder, limit, offset, ...API_LIBRARY_FILTER })
      const items  = [...movies.map(movieToItem), ...shows.map(showToSeriesItem)]
      return { Items: items, TotalRecordCount: items.length, StartIndex: offset }
    }

    // ── No parentId: route by includeItemTypes or return folders ─────────────
    if (!ParentId) {
      // Infuse main page "TV Shows" calls Items?includeItemTypes=Series&recursive=true
      if (includeTypes.includes('series')) {
        const shows = listShows({ search: SearchTerm, sortBy: SortBy, sortOrder: SortOrder, limit, offset, ...API_LIBRARY_FILTER })
        const total = countShows(SearchTerm, API_LIBRARY_FILTER.availableOnly)
        return { Items: shows.map(showToSeriesItem), TotalRecordCount: total, StartIndex: offset }
      }
      // Infuse main page "Movies" calls Items?includeItemTypes=Movie&recursive=true
      if (includeTypes.includes('movie')) {
        const movies = listMovies({ search: SearchTerm, sortBy: SortBy, sortOrder: SortOrder, limit, offset, ...API_LIBRARY_FILTER })
        const total  = countMovies(SearchTerm, API_LIBRARY_FILTER.availableOnly)
        return { Items: movies.map(movieToItem), TotalRecordCount: total, StartIndex: offset }
      }
      // True root listing: return collection folders
      const nMovies = countMovies(undefined, API_LIBRARY_FILTER.availableOnly)
      const nShows  = countShows(undefined, API_LIBRARY_FILTER.availableOnly)
      return {
        Items: [
          {
            Id: MOVIES_FOLDER_ID, ServerId: SERVER_GUID, Name: 'Movies',
            Type: 'CollectionFolder', CollectionType: 'movies', IsFolder: true,
            ChildCount: nMovies, RecursiveItemCount: nMovies, ImageTags: {},
            UserData: { PlaybackPositionTicks: 0, PlayCount: 0, IsFavorite: false, Played: false, Key: MOVIES_FOLDER_ID },
          },
          {
            Id: SHOWS_FOLDER_ID, ServerId: SERVER_GUID, Name: 'Shows',
            Type: 'CollectionFolder', CollectionType: 'tvshows', IsFolder: true,
            ChildCount: nShows, RecursiveItemCount: nShows, ImageTags: {},
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
    const movies = listMovies({ search: SearchTerm, sortBy: SortBy, sortOrder: SortOrder, limit, offset, ...API_LIBRARY_FILTER })
    const total  = countMovies(SearchTerm, API_LIBRARY_FILTER.availableOnly)
    return { Items: movies.map(movieToItem), TotalRecordCount: total, StartIndex: offset }
  }

  app.get('/Items',           async (req) => handleItems(req as never))
  app.get('/Users/:id/Items', async (req) => handleItems(req as never))
  app.get('/Shows/NextUp', async (req) => {
    const rawQuery = (req as never as { query: Record<string, string> }).query
    const q: Record<string, string> = {}
    for (const [k, v] of Object.entries(rawQuery)) q[k.toLowerCase()] = v
    const limit = parseInt(q.limit ?? '16', 10)
    const offset = parseInt(q.startindex ?? '0', 10)

    const nextUpItems = listShows({ limit: 100_000, ...API_LIBRARY_FILTER })
      .map(show => {
        const ep = findNextUpEpisode(show)
        return ep ? { show, ep } : null
      })
      .filter((value): value is { show: Show; ep: Episode } => value !== null)
      .sort((a, b) => {
        const aDate = a.ep.airDate || ''
        const bDate = b.ep.airDate || ''
        if (aDate !== bDate) return bDate.localeCompare(aDate)
        return a.show.title.localeCompare(b.show.title)
      })

    const paged = nextUpItems.slice(offset, offset + limit)
    return {
      Items: paged.map(({ show, ep }) => episodeToItem(ep, show)),
      TotalRecordCount: nextUpItems.length,
      StartIndex: offset,
    }
  })

  // Resume / Continue Watching
  async function handleResumeItems(req: { query: Record<string, string> }) {
    const q: Record<string, string> = {}
    for (const [k, v] of Object.entries(req.query)) q[k.toLowerCase()] = v
    const limit = q.limit ? parseInt(q.limit, 10) : 50
    const offset = q.startindex ? parseInt(q.startindex, 10) : 0
    return withReadCache(`resume:${offset}:${limit}`, async () => {
      const ids = listResumeItemIds(limit, offset)
      const items = []
      for (const id of ids) {
        const item = await handleItem(id, {
          code: () => ({ send: () => null }),
        })
        if (item && typeof item === 'object' && (item as Record<string, unknown>).Type !== 'Season' && (item as Record<string, unknown>).Type !== 'Series') {
          items.push(item)
        }
      }
      return { Items: items, TotalRecordCount: countResumeItems(), StartIndex: offset }
    })
  }
  app.get('/Users/:id/Items/Resume', async (req) => handleResumeItems(req as never))
  app.get('/UserItems/Resume', async (req) => handleResumeItems(req as never))

  // Latest / Recently Added
  app.get('/Users/:id/Items/Latest', async (req) => {
    const rawQuery = (req as never as { query: Record<string, string> }).query
    const q: Record<string, string> = {}
    for (const [k, v] of Object.entries(rawQuery)) q[k.toLowerCase()] = v
    const lim      = parseInt(q.limit ?? '16')
    const parentId = q.parentid

    if (parentId === SHOWS_FOLDER_ID) {
      return listShows({ sortBy: 'popularity', sortOrder: 'DESC', limit: lim, ...API_LIBRARY_FILTER }).map(showToSeriesItem)
    }
    return listMovies({ sortBy: 'popularity', sortOrder: 'DESC', limit: lim, ...API_LIBRARY_FILTER }).map(movieToItem)
  })

  // Single item — /Items/:id and /Users/:userId/Items/:itemId
  async function handleItem(id: string, reply: { code: (n: number) => { send: (v: unknown) => unknown } }) {
    // Collection folders
    if (id === MOVIES_FOLDER_ID) {
      const n = countMovies(undefined, API_LIBRARY_FILTER.availableOnly)
      return { Name: 'Movies', Id: MOVIES_FOLDER_ID, ServerId: SERVER_GUID,
        Type: 'CollectionFolder', CollectionType: 'movies', IsFolder: true, Path: '/movies',
        RecursiveItemCount: n, ChildCount: n, ImageTags: {},
        UserData: { PlaybackPositionTicks: 0, PlayCount: 0, IsFavorite: false, Played: false, Key: MOVIES_FOLDER_ID } }
    }
    if (id === SHOWS_FOLDER_ID) {
      const n = countShows(undefined, API_LIBRARY_FILTER.availableOnly)
      return { Name: 'Shows', Id: SHOWS_FOLDER_ID, ServerId: SERVER_GUID,
        Type: 'CollectionFolder', CollectionType: 'tvshows', IsFolder: true, Path: '/shows',
        RecursiveItemCount: n, ChildCount: n, ImageTags: {},
        UserData: { PlaybackPositionTicks: 0, PlayCount: 0, IsFavorite: false, Played: false, Key: SHOWS_FOLDER_ID } }
    }

    // Episode
    const epRef = idToEpisode(id)
    if (epRef) {
      const show = getShowByTmdbId(epRef.showTmdbId) ?? await fetchShowByTmdbId(epRef.showTmdbId)
      if (!show) return reply.code(404).send({ error: 'Not found' })
      let [ep] = getEpisodesForSeason(show.tmdbId, epRef.seasonNum)
        .filter(e => e.episodeNumber === epRef.episodeNum)
      if (!ep) {
        const eps = await fetchAndCacheSeasonDetails(show.tmdbId, epRef.seasonNum).catch(() => [])
        ep = eps.find(e => e.episodeNumber === epRef.episodeNum)!
      }
      if (!ep) return reply.code(404).send({ error: 'Not found' })
      return episodeToItem(ep, show)
    }

    // Season
    const seasonRef = idToSeason(id)
    if (seasonRef) {
      const show = getShowByTmdbId(seasonRef.showTmdbId) ?? await fetchShowByTmdbId(seasonRef.showTmdbId)
      if (!show) return reply.code(404).send({ error: 'Not found' })
      let season = getSeason(show.tmdbId, seasonRef.seasonNum)
      if (!season) {
        await fetchAndCacheSeasonDetails(show.tmdbId, seasonRef.seasonNum).catch(() => {})
        season = getSeason(show.tmdbId, seasonRef.seasonNum)
      }
      if (!season) return reply.code(404).send({ error: 'Not found' })
      return seasonToItem(season, show)
    }

    // Series
    const showTmdbId = idToShowTmdb(id)
    if (showTmdbId) {
      const show = getShowByTmdbId(showTmdbId) ?? await fetchShowByTmdbId(showTmdbId)
      if (!show) return reply.code(404).send({ error: 'Not found' })
      return showToSeriesItem(show)
    }

    // Movie
    const tmdbId = idToTmdb(id)
    if (!tmdbId) return reply.code(404).send({ error: 'Not found' })
    const movie = getMovieByTmdbId(tmdbId) ?? await fetchMovieByTmdbId(tmdbId)
    if (!movie) return reply.code(404).send({ error: 'Not found' })
    return movieToItem(movie)
  }

  app.get('/Items/:id',                  async (req, reply) => handleItem((req.params as { id: string }).id, reply as never))
  app.get('/Users/:userId/Items/:itemId', async (req, reply) => handleItem((req.params as { itemId: string }).itemId, reply as never))

  // Seasons list for a series — Infuse calls this when opening a show
  app.get('/Shows/:seriesId/Seasons', async (req, reply) => {
    const { seriesId } = req.params as { seriesId: string }
    return withReadCache(`show-seasons:${seriesId}`, async () => {
      const showTmdbId = idToShowTmdb(seriesId)
      if (!showTmdbId) return reply.code(404).send({ error: 'Not found' })
      const show = getShowByTmdbId(showTmdbId) ?? await fetchShowByTmdbId(showTmdbId)
      if (!show) return reply.code(404).send({ error: 'Not found' })
      await ensureShowSeasonsCached(show).catch(() => {})
      const seasons = visibleSeasonsForShow(show)
      return { Items: seasons.map(s => seasonToItem(s, show)), TotalRecordCount: seasons.length, StartIndex: 0 }
    })
  })

  // Episodes list for a series — Infuse calls this with optional SeasonId filter
  app.get('/Shows/:seriesId/Episodes', async (req, reply) => {
    const { seriesId } = req.params as { seriesId: string }
    const rawQ = (req as never as { query: Record<string, string> }).query
    const SeasonId = rawQ.SeasonId ?? rawQ.seasonId ?? rawQ.seasonid
    return withReadCache(`show-episodes:${seriesId}:${SeasonId ?? 'all'}`, async () => {
      const showTmdbId = idToShowTmdb(seriesId)
      if (!showTmdbId) return reply.code(404).send({ error: 'Not found' })
      const show = getShowByTmdbId(showTmdbId) ?? await fetchShowByTmdbId(showTmdbId)
      if (!show) return reply.code(404).send({ error: 'Not found' })

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
        return { Items: episodes.map(e => episodeToItem(e, show)), TotalRecordCount: episodes.length, StartIndex: 0 }
      }

      await ensureShowSeasonsCached(show).catch(() => {})
      const allEpisodes = visibleAiredEpisodesForShow(show)
      return { Items: allEpisodes.map(e => episodeToItem(e, show)), TotalRecordCount: allEpisodes.length, StartIndex: 0 }
    })
  })

  // Images — redirect to TMDB CDN for movies, series, seasons, and episode stills
  // Jellyfin image URL can be /Items/:id/Images/:type OR /Items/:id/Images/:type/:index
  async function handleImage(
    id: string,
    type: string,
    tag: string | undefined,
    reply: Parameters<typeof app.get>[2] extends (...args: infer A) => unknown ? A[1] : never,
  ) {
    const isBackdrop = type.toLowerCase() === 'backdrop'
    const isLogo = type.toLowerCase() === 'logo'
    const isThumb = type.toLowerCase() === 'thumb'

    // Episode primary/backdrop still → fall back to season poster → series poster
    const epRef = idToEpisode(id)
    if (epRef) {
      const show = getShowByTmdbId(epRef.showTmdbId)
      if (isLogo && show?.logoPath) return reply.redirect(posterUrl(show.logoPath), 307)
      const eps = getEpisodesForSeason(epRef.showTmdbId, epRef.seasonNum)
      const ep = eps.find(e => e.episodeNumber === epRef.episodeNum)
      const season = getSeason(epRef.showTmdbId, epRef.seasonNum)
      if (isThumb && show?.backdropPath) return reply.redirect(posterUrl(show.backdropPath), 307)
      if (ep?.stillPath) return reply.redirect(posterUrl(ep.stillPath), 307)
      if (season?.posterPath) return reply.redirect(posterUrl(season.posterPath), 307)
      if (show?.posterPath) return reply.redirect(posterUrl(show.posterPath), 307)
      return reply.code(404).send()
    }

    // Series — Primary poster or Backdrop
    const showTmdbId = idToShowTmdb(id)
    if (showTmdbId) {
      const show = getShowByTmdbId(showTmdbId) ?? await fetchShowByTmdbId(showTmdbId)
      if (!show) return reply.code(404).send()
      if (isLogo && show.logoPath) return reply.redirect(posterUrl(show.logoPath), 307)
      if (isThumb && show.backdropPath) return reply.redirect(posterUrl(show.backdropPath), 307)
      if (isBackdrop && show.backdropPath) return reply.redirect(posterUrl(show.backdropPath), 307)
      if (show.posterPath) return reply.redirect(posterUrl(show.posterPath), 307)
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
      if (season?.posterPath) return reply.redirect(posterUrl(season.posterPath), 307)
      const show = getShowByTmdbId(seasonRef.showTmdbId)
      if (show?.posterPath) return reply.redirect(posterUrl(show.posterPath), 307)
      return reply.code(404).send()
    }

    // Movie poster or backdrop
    const tmdbId = idToTmdb(id)
    const movie = tmdbId ? (getMovieByTmdbId(tmdbId) ?? await fetchMovieByTmdbId(tmdbId)) : null
    if (!movie) return reply.code(404).send()
      if (isLogo && movie.logoPath) return reply.redirect(posterUrl(movie.logoPath), 307)
      if (isThumb && movie.backdropPath) return reply.redirect(posterUrl(movie.backdropPath), 307)
      if (isBackdrop && movie.backdropPath) return reply.redirect(posterUrl(movie.backdropPath), 307)
    if (movie.posterPath) return reply.redirect(posterUrl(movie.posterPath), 307)
    return reply.code(404).send()
  }

  app.get('/Items/:id/Images/:type', async (req, reply) => {
    const params = req.params as { id: string; type: string }
    const query = req.query as { tag?: string } | undefined
    return handleImage(params.id, params.type, query?.tag, reply as never)
  })
  app.get('/Items/:id/Images/:type/:index', async (req, reply) => {
    const params = req.params as { id: string; type: string }
    const query = req.query as { tag?: string } | undefined
    return handleImage(params.id, params.type, query?.tag, reply as never)
  })

  // Stubs for endpoints Infuse probes but we don't need to implement
  app.get('/Users/:userId/Items/:itemId/LocalTrailers', async () => [])
  app.get('/MediaSegments/:id', async () => ({ Items: [], TotalRecordCount: 0, StartIndex: 0 }))
  app.get('/Users/:userId/Items/:itemId/SpecialFeatures', async () => [])
  app.post('/Sessions/Playing',         async () => ({}))
  app.post('/Sessions/Playing/Progress', async (req) => {
    const body = (req as never as { body: Record<string, unknown> }).body
    const itemId       = body?.ItemId       as string | undefined
    const positionTicks = body?.PositionTicks as number | undefined
    if (itemId && positionTicks != null) {
      saveProgress(itemId, positionTicks)
      app.log.info(`progress: saved ${itemId} at ${positionTicks} ticks`)
    } else {
      app.log.warn(`progress: missing item or position in /Sessions/Playing/Progress payload`)
    }
    return {}
  })
  app.post('/Sessions/Playing/Stopped', async (req) => {
    const body = (req as never as { body: Record<string, unknown> }).body
    const itemId            = body?.ItemId             as string  | undefined
    const positionTicks     = body?.PositionTicks      as number  | undefined
    const playedToCompletion = body?.PlayedToCompletion as boolean | undefined
    if (itemId) {
      if (playedToCompletion) {
        markPlayed(itemId)
        app.log.info(`progress: marked played ${itemId}`)
      } else if (positionTicks != null) {
        saveProgress(itemId, positionTicks)
        app.log.info(`progress: stopped ${itemId} at ${positionTicks} ticks`)
      } else {
        app.log.warn(`progress: missing stop position for ${itemId}`)
      }
    }
    return {}
  })
  app.post('/Users/:userId/PlayedItems/:itemId', async (req) => {
    const { itemId } = (req as never as { params: { itemId: string } }).params
    markPlayed(itemId)
    const ud = getUserData(itemId)
    return { PlayCount: ud.playCount, Played: ud.played, LastPlayedDate: ud.lastPlayedDate || undefined }
  })
  app.delete('/Users/:userId/PlayedItems/:itemId', async (req) => {
    const { itemId } = (req as never as { params: { itemId: string } }).params
    markUnplayed(itemId)
    return {}
  })

  // Playback — handles both movies and episodes
  async function handlePlaybackInfo(
    req: { params: { id: string }; headers: Record<string, string> },
    reply: { code: (n: number) => { send: (v: unknown) => unknown } },
  ) {
    const { id } = req.params

    // Episode playback
    const epRef = idToEpisode(id)
    if (epRef) {
      const show = getShowByTmdbId(epRef.showTmdbId) ?? await fetchShowByTmdbId(epRef.showTmdbId)
      if (!show?.imdbId) return reply.code(404).send({ error: 'No IMDb ID for this show' })
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
