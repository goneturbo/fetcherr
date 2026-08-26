import { config } from './config.js'
import {
  upsertMovie, getMovieByTmdbId, getMovieByImdbId, type Movie,
  upsertShow, getShowByTmdbId, getShowByImdbId, type Show,
  upsertSeason, getSeasonsForShow, type Season,
  upsertEpisode, type Episode, getAiredEpisodesForSeason, getEffectiveShowMode,
  upsertPeople,
} from './db.js'
import { fetchContentRatingFallback, fetchEpisodeStillFallbacks, fetchSeriesLanguage } from './tvdb.js'

const BASE = 'https://api.themoviedb.org/3'
const MISSING_STILL_RETRY_MS = 7 * 24 * 60 * 60 * 1000
const ACTIVE_SHOW_REFRESH_MS = 6 * 60 * 60 * 1000

const LANG_LOCALE: Record<string, string> = {
  en: 'en-US', pt: 'pt-BR', ja: 'ja-JP', es: 'es-ES',
  fr: 'fr-FR', de: 'de-DE', it: 'it-IT', ko: 'ko-KR', zh: 'zh-CN',
}

export function tmdbLocale(): string {
  const lang = config.preferredAudioLanguage || 'en'
  return LANG_LOCALE[lang] ?? lang
}

async function tmdbGet(path: string): Promise<unknown> {
  const sep = path.includes('?') ? '&' : '?'
  const res = await fetch(`${BASE}${path}${sep}api_key=${config.tmdbApiKey}&language=${tmdbLocale()}`, {
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`TMDB ${res.status} for ${path}`)
  return res.json()
}

export async function findTmdbIdByImdbId(imdbId: string, mediaType: 'movie' | 'show'): Promise<number | null> {
  const result = await tmdbGet(`/find/${encodeURIComponent(imdbId)}?external_source=imdb_id`) as {
    movie_results?: Array<{ id: number }>
    tv_results?: Array<{ id: number }>
  }
  const match = (mediaType === 'movie' ? result.movie_results : result.tv_results)?.[0]
  return match?.id && Number.isFinite(match.id) ? match.id : null
}

function shouldRetryMissingStillBackfill(episodes: Episode[]): boolean {
  const now = Date.now()
  return episodes.some(ep => {
    if (ep.stillPath) return false
    const syncedAt = Date.parse(ep.syncedAt)
    if (Number.isNaN(syncedAt)) return true
    return now - syncedAt >= MISSING_STILL_RETRY_MS
  })
}

function isOngoingShow(show: Pick<Show, 'status'>): boolean {
  const status = show.status.trim().toLowerCase()
  return status !== 'ended' && status !== 'canceled' && status !== 'cancelled'
}

function isStaleSyncedAt(value: string, maxAgeMs: number): boolean {
  const syncedAt = Date.parse(value)
  if (Number.isNaN(syncedAt)) return true
  return Date.now() - syncedAt >= maxAgeMs
}

function latestSeasonNumber(seasons: Season[]): number {
  return seasons.reduce((max, season) => season.seasonNumber > 0 ? Math.max(max, season.seasonNumber) : max, 0)
}

async function refreshShowMetadata(show: Show): Promise<Show> {
  try {
    const r = await tmdbGet(`/tv/${show.tmdbId}?append_to_response=external_ids,images,content_ratings,keywords,credits&include_image_language=en,null`) as
      TmdbShowRaw & { external_ids?: { imdb_id?: string; tvdb_id?: number }; images?: TmdbImagesResponse; keywords?: TmdbKeywordsResponse }
    const imdbId = r.external_ids?.imdb_id ?? show.imdbId
    const tvdbId = r.external_ids?.tvdb_id ?? show.tvdbId
    const mediaLanguage = (r.original_language ?? '').trim().toLowerCase() || await fetchSeriesLanguage(tvdbId)
    const updated = { ...raw2show(r, imdbId, tvdbId, show.syncedAt), mediaLanguage }
    upsertShow(updated)
    return getShowByTmdbId(show.tmdbId) ?? { id: show.id, ...updated }
  } catch {
    return show
  }
}

interface TmdbMovieRaw {
  id:            number
  title:         string
  original_language?: string
  overview:      string
  poster_path:   string | null
  backdrop_path: string | null
  popularity:    number
  release_date:  string
  genre_ids?:    number[]
  genres?:       { name: string }[]
  runtime?:      number
  vote_average?: number
  production_companies?: Array<{ id: number; name: string }>
  release_dates?: {
    results: {
      iso_3166_1:    string
      release_dates: { type: number; release_date: string; certification?: string }[]
    }[]
  }
  belongs_to_collection?: {
    id: number
    name: string
  } | null
  credits?: TmdbCreditsResponse
}

interface TmdbCastMember {
  id: number
  name: string
  character?: string
  profile_path?: string | null
  order?: number
}

interface TmdbCrewMember {
  id: number
  name: string
  job?: string
  department?: string
  profile_path?: string | null
}

interface TmdbCreditsResponse {
  cast?: TmdbCastMember[]
  crew?: TmdbCrewMember[]
}

export interface CreditPerson {
  id: number
  name: string
  role: string
  type: 'Actor' | 'Director' | 'Writer' | 'Producer'
  profilePath: string
}

const CREW_ROLE_TYPE: Record<string, CreditPerson['type']> = {
  Director: 'Director',
  Writer: 'Writer',
  Screenplay: 'Writer',
  Creator: 'Writer',
  'Executive Producer': 'Producer',
  Producer: 'Producer',
}

function pickCredits(credits?: TmdbCreditsResponse, createdBy?: Array<{ id: number; name: string; profile_path?: string | null }>): string {
  const cast: CreditPerson[] = (credits?.cast ?? [])
    .slice(0, 15)
    .map(c => ({ id: c.id, name: c.name, role: c.character ?? '', type: 'Actor', profilePath: c.profile_path ?? '' }))
  const crew: CreditPerson[] = (credits?.crew ?? [])
    .filter(c => c.job != null && CREW_ROLE_TYPE[c.job] != null)
    .slice(0, 8)
    .map(c => ({ id: c.id, name: c.name, role: c.job!, type: CREW_ROLE_TYPE[c.job!], profilePath: c.profile_path ?? '' }))
  const creators: CreditPerson[] = (createdBy ?? [])
    .map(c => ({ id: c.id, name: c.name, role: 'Creator', type: 'Writer' as const, profilePath: c.profile_path ?? '' }))
  const merged = [...cast, ...crew, ...creators]
  upsertPeople(merged.filter(p => p.profilePath).map(p => ({ tmdbId: p.id, name: p.name, profilePath: p.profilePath })))
  return JSON.stringify(merged)
}

interface TmdbCollectionPartRaw {
  id: number
  title: string
  release_date: string
  poster_path: string | null
}

interface TmdbCollectionRaw {
  id: number
  name: string
  parts?: TmdbCollectionPartRaw[]
}

export interface MovieCollectionItem {
  collectionId: number
  collectionName: string
  tmdbId: number
  title: string
  year: number
  releaseDate: string
  posterUrl: string | null
}

interface TmdbKeyword {
  id: number
  name: string
}

interface TmdbKeywordsResponse {
  keywords?: TmdbKeyword[]
  results?: TmdbKeyword[]
}

interface TmdbFindResponse {
  movie_results?: Array<{ id?: number }>
  tv_results?: Array<{ id?: number }>
}

async function findTmdbMovieIdByImdbId(imdbId: string): Promise<number | null> {
  if (!config.tmdbApiKey || !imdbId.trim()) return null
  try {
    const r = await tmdbGet(`/find/${encodeURIComponent(imdbId)}?external_source=imdb_id`) as TmdbFindResponse
    const tmdbId = r.movie_results?.find(result => typeof result.id === 'number')?.id
    return tmdbId && Number.isFinite(tmdbId) ? tmdbId : null
  } catch {
    return null
  }
}

async function findTmdbShowIdByImdbId(imdbId: string): Promise<number | null> {
  if (!config.tmdbApiKey || !imdbId.trim()) return null
  try {
    const r = await tmdbGet(`/find/${encodeURIComponent(imdbId)}?external_source=imdb_id`) as TmdbFindResponse
    const tmdbId = r.tv_results?.find(result => typeof result.id === 'number')?.id
    return tmdbId && Number.isFinite(tmdbId) ? tmdbId : null
  } catch {
    return null
  }
}

interface TmdbImageFile {
  file_path: string
  iso_639_1?: string | null
}

interface TmdbImagesResponse {
  logos?: TmdbImageFile[]
}

function pickLogoPath(images?: TmdbImagesResponse | null): string {
  const logos = images?.logos ?? []
  const preferred = logos.find(l => l.iso_639_1 === 'en')
    ?? logos.find(l => l.iso_639_1 == null)
    ?? logos[0]
  return preferred?.file_path ?? ''
}

function extractOfficialMovieRating(raw: TmdbMovieRaw): string {
  const us = raw.release_dates?.results?.find(r => r.iso_3166_1 === 'US')
  return us?.release_dates.find(d => d.certification)?.certification ?? ''
}

function parseYear(date: string): number {
  return date?.length >= 4 ? parseInt(date.slice(0, 4)) : 0
}

function extractDigitalReleaseDate(raw: TmdbMovieRaw): string {
  const results = raw.release_dates?.results
  if (!results?.length) return ''
  // Prefer US, then any region
  const ordered = [
    results.find(r => r.iso_3166_1 === 'US'),
    ...results.filter(r => r.iso_3166_1 !== 'US'),
  ].filter((region): region is NonNullable<TmdbMovieRaw['release_dates']>['results'][number] => Boolean(region))
  for (const region of ordered) {
    const digital = region.release_dates.find(d => d.type === 4)
    if (digital?.release_date) return digital.release_date.slice(0, 10)
  }
  return ''
}

function raw2movie(r: TmdbMovieRaw, imdbId = '', listedAt = ''): Omit<Movie, 'id'> {
  const genres = r.genres?.map(g => g.name) ?? []
  return {
    tmdbId:             r.id,
    imdbId,
    mediaLanguage:      (r.original_language ?? '').trim().toLowerCase(),
    title:              r.title,
    year:               parseYear(r.release_date),
    overview:           r.overview ?? '',
    posterPath:         r.poster_path ?? '',
    backdropPath:       r.backdrop_path ?? '',
    logoPath:           pickLogoPath((r as TmdbMovieRaw & { images?: TmdbImagesResponse }).images),
    genres:             JSON.stringify(genres),
    runtimeMins:        r.runtime ?? 0,
    popularity:         r.popularity ?? 0,
    officialRating:     extractOfficialMovieRating(r),
    communityRating:    r.vote_average ?? 0,
    studiosJson:        JSON.stringify((r.production_companies ?? []).map(s => ({ id: s.id, name: s.name }))),
    tagsJson:           JSON.stringify((((r as TmdbMovieRaw & { keywords?: TmdbKeywordsResponse }).keywords?.keywords) ?? []).map(k => k.name)),
    castJson:           pickCredits(r.credits),
    releaseDate:        r.release_date ?? '',
    digitalReleaseDate: extractDigitalReleaseDate(r),
    syncedAt:           listedAt,
  }
}

/**
 * Re-fetch movie metadata from TMDB to fill in any missing fields (e.g. backdrop_path).
 * Only hits TMDB if the movie is missing a backdrop.
 */
export async function refreshMovieMetadataIfNeeded(movie: Movie): Promise<void> {
  if (!config.tmdbApiKey) return
  // Refresh if missing backdrop or release date info
  if (movie.backdropPath && movie.logoPath && movie.releaseDate && movie.officialRating && movie.communityRating && movie.studiosJson !== '[]' && movie.castJson !== '[]') return
  try {
    const r = await tmdbGet(`/movie/${movie.tmdbId}?append_to_response=external_ids,release_dates,images,keywords,credits&include_image_language=en,null`) as
      TmdbMovieRaw & { external_ids?: { imdb_id?: string }; images?: TmdbImagesResponse; keywords?: TmdbKeywordsResponse }
    const imdbId = r.external_ids?.imdb_id ?? movie.imdbId
    upsertMovie(raw2movie(r, imdbId))
  } catch {
    // ignore
  }
}

export async function fetchMovieByTmdbId(tmdbId: number, listedAt = ''): Promise<Movie | null> {
  if (!config.tmdbApiKey) return null
  // Check cache first
  const cached = getMovieByTmdbId(tmdbId)
  if (cached?.imdbId && cached.castJson !== '[]') return cached

  try {
    const r = await tmdbGet(`/movie/${tmdbId}?append_to_response=external_ids,release_dates,images,keywords,credits&include_image_language=en,null`) as
      TmdbMovieRaw & { external_ids?: { imdb_id?: string }; images?: TmdbImagesResponse; keywords?: TmdbKeywordsResponse }
    const imdbId = r.external_ids?.imdb_id ?? ''
    const m = raw2movie(r, imdbId, listedAt)
    upsertMovie(m)
    return { id: 0, ...m }
  } catch {
    return null
  }
}

export async function fetchMovieByImdbId(imdbId: string): Promise<Movie | null> {
  const normalized = imdbId.trim()
  if (!normalized) return null
  const cached = getMovieByImdbId(normalized)
  if (cached) return cached
  const tmdbId = await findTmdbMovieIdByImdbId(normalized)
  return tmdbId ? fetchMovieByTmdbId(tmdbId) : null
}

export async function fetchMovieOfficialRatingByIds(opts: { tmdbId?: number | null; imdbId?: string }): Promise<string> {
  const tmdbId = opts.tmdbId && Number.isFinite(opts.tmdbId) ? opts.tmdbId : null
  const imdbId = (opts.imdbId ?? '').trim()
  let movie = tmdbId ? await fetchMovieByTmdbId(tmdbId) : null
  if (!movie && imdbId) movie = await fetchMovieByImdbId(imdbId)
  if (movie?.officialRating) return movie.officialRating

  const fallback = await fetchContentRatingFallback('movie', { imdbId: movie?.imdbId || imdbId })
  if (fallback && movie) {
    const { id: _id, ...stored } = movie
    upsertMovie({ ...stored, officialRating: fallback })
  }
  return fallback
}

export async function fetchMovieCollection(movieTmdbId: number): Promise<MovieCollectionItem[]> {
  if (!config.tmdbApiKey) return []
  try {
    const movie = await tmdbGet(`/movie/${movieTmdbId}`) as TmdbMovieRaw
    const collection = movie.belongs_to_collection
    if (!collection?.id) return []

    const raw = await tmdbGet(`/collection/${collection.id}`) as TmdbCollectionRaw
    return (raw.parts ?? [])
      .sort((a, b) => (a.release_date || '').localeCompare(b.release_date || '') || a.title.localeCompare(b.title))
      .map(part => ({
        collectionId: raw.id,
        collectionName: raw.name,
        tmdbId: part.id,
        title: part.title,
        year: parseYear(part.release_date),
        releaseDate: part.release_date ?? '',
        posterUrl: part.poster_path ? `https://image.tmdb.org/t/p/w185${part.poster_path}` : null,
      }))
  } catch {
    return []
  }
}

async function fetchTmdbIdList(path: string, pages = 2): Promise<number[]> {
  const ids: number[] = []
  for (let page = 1; page <= pages; page++) {
    try {
      const sep = path.includes('?') ? '&' : '?'
      const r = await tmdbGet(`${path}${sep}page=${page}`) as { results?: { id: number }[]; total_pages?: number }
      ids.push(...(r.results ?? []).map(item => item.id))
      if (r.total_pages != null && page >= r.total_pages) break
    } catch {
      break
    }
  }
  return ids
}

export function fetchTrendingMovies(): Promise<number[]> {
  return config.tmdbApiKey ? fetchTmdbIdList('/trending/movie/week') : Promise.resolve([])
}
export function fetchTrendingShows(): Promise<number[]> {
  return config.tmdbApiKey ? fetchTmdbIdList('/trending/tv/week') : Promise.resolve([])
}
export function fetchPopularMovies(): Promise<number[]> {
  return config.tmdbApiKey ? fetchTmdbIdList('/movie/popular') : Promise.resolve([])
}
export function fetchPopularShows(): Promise<number[]> {
  return config.tmdbApiKey ? fetchTmdbIdList('/tv/popular') : Promise.resolve([])
}
export function fetchTopRatedMovies(): Promise<number[]> {
  return config.tmdbApiKey ? fetchTmdbIdList('/movie/top_rated') : Promise.resolve([])
}
export function fetchTopRatedShows(): Promise<number[]> {
  return config.tmdbApiKey ? fetchTmdbIdList('/tv/top_rated') : Promise.resolve([])
}
export function fetchUpcomingMovies(): Promise<number[]> {
  return config.tmdbApiKey ? fetchTmdbIdList('/movie/upcoming') : Promise.resolve([])
}
export function fetchOnTheAirShows(): Promise<number[]> {
  return config.tmdbApiKey ? fetchTmdbIdList('/tv/on_the_air') : Promise.resolve([])
}

export async function fetchMovieRecommendations(tmdbId: number, limit = 20): Promise<number[]> {
  if (!config.tmdbApiKey) return []
  try {
    const r = await tmdbGet(`/movie/${tmdbId}/recommendations`) as { results?: TmdbMovieRaw[] }
    let ids = (r.results ?? []).map(m => m.id)
    if (!ids.length) {
      const s = await tmdbGet(`/movie/${tmdbId}/similar`) as { results?: TmdbMovieRaw[] }
      ids = (s.results ?? []).map(m => m.id)
    }
    return ids.slice(0, limit)
  } catch {
    return []
  }
}

export async function fetchShowRecommendations(tmdbId: number, limit = 20): Promise<number[]> {
  if (!config.tmdbApiKey) return []
  try {
    const r = await tmdbGet(`/tv/${tmdbId}/recommendations`) as { results?: TmdbShowRaw[] }
    let ids = (r.results ?? []).map(s => s.id)
    if (!ids.length) {
      const s = await tmdbGet(`/tv/${tmdbId}/similar`) as { results?: TmdbShowRaw[] }
      ids = (s.results ?? []).map(s => s.id)
    }
    return ids.slice(0, limit)
  } catch {
    return []
  }
}

type TmdbImageKind = 'poster' | 'backdrop' | 'logo' | 'profile'

function pickTmdbImageSize(kind: TmdbImageKind, requestedWidth?: number | null): string {
  const widths = kind === 'backdrop'
    ? [300, 780, 1280]
    : kind === 'profile'
    ? [45, 185]
    : [92, 154, 185, 342, 500, 780]
  const fallback = kind === 'backdrop' ? 1280 : kind === 'profile' ? 185 : 500
  const target = requestedWidth && requestedWidth > 0 ? requestedWidth : fallback
  const chosen = widths.find(width => width >= target) ?? widths[widths.length - 1]
  return `w${chosen}`
}

export function posterUrl(
  posterPath: string,
  options?: { kind?: TmdbImageKind; width?: number | null },
): string {
  if (!posterPath) return ''
  if (posterPath.startsWith('http://') || posterPath.startsWith('https://')) return posterPath
  const size = pickTmdbImageSize(options?.kind ?? 'poster', options?.width)
  return `https://image.tmdb.org/t/p/${size}${posterPath}`
}

// ── TV Shows ──────────────────────────────────────────────────────────────────

interface TmdbShowRaw {
  id:               number
  name:             string
  original_language?: string
  overview:         string
  poster_path:      string | null
  backdrop_path:    string | null
  popularity:       number
  first_air_date:   string
  genres?:          { name: string }[]
  status?:          string
  number_of_seasons?: number
  vote_average?:    number
  production_companies?: Array<{ id: number; name: string }>
  networks?: Array<{ id: number; name: string }>
  external_ids?:    { imdb_id?: string; tvdb_id?: number }
  content_ratings?: { results?: Array<{ iso_3166_1: string; rating: string }> }
  credits?:         TmdbCreditsResponse
  created_by?:      Array<{ id: number; name: string; profile_path?: string | null }>
}

interface TmdbSeasonRaw {
  season_number: number
  name:          string
  overview:      string
  poster_path:   string | null
  air_date:      string
  episodes?:     TmdbEpisodeRaw[]
}

interface TmdbEpisodeRaw {
  episode_number: number
  name:           string
  overview:       string
  still_path:     string | null
  runtime?:       number
  vote_average?:  number
  air_date:       string
}

function raw2show(r: TmdbShowRaw, imdbId = '', tvdbId = 0, listedAt = ''): Omit<Show, 'id'> {
  return {
    tmdbId:       r.id,
    imdbId,
    tvdbId,
    mediaLanguage: (r.original_language ?? '').trim().toLowerCase(),
    title:        r.name,
    year:         parseYear(r.first_air_date),
    overview:     r.overview ?? '',
    posterPath:   r.poster_path ?? '',
    backdropPath: r.backdrop_path ?? '',
    logoPath:     pickLogoPath((r as TmdbShowRaw & { images?: TmdbImagesResponse }).images),
    genres:       JSON.stringify(r.genres?.map(g => g.name) ?? []),
    status:       r.status ?? '',
    numSeasons:   r.number_of_seasons ?? 0,
    popularity:   r.popularity ?? 0,
    officialRating: (r.content_ratings?.results?.find(x => x.iso_3166_1 === 'US')?.rating) ?? '',
    communityRating: r.vote_average ?? 0,
    studiosJson: JSON.stringify((r.production_companies ?? r.networks ?? []).map(s => ({ id: s.id, name: s.name }))),
    tagsJson: JSON.stringify((((r as TmdbShowRaw & { keywords?: TmdbKeywordsResponse }).keywords?.results) ?? []).map(k => k.name)),
    castJson: pickCredits(r.credits, r.created_by),
    syncedAt:     listedAt,
  }
}

export async function fetchShowByTmdbId(tmdbId: number, listedAt = ''): Promise<Show | null> {
  if (!config.tmdbApiKey) return null
  const cached = getShowByTmdbId(tmdbId)
  if (cached?.imdbId && (!config.tvdbApiKey || cached.tvdbId) && cached.castJson !== '[]') return cached

  try {
    const r = await tmdbGet(`/tv/${tmdbId}?append_to_response=external_ids,images,content_ratings,keywords,credits&include_image_language=en,null`) as
      TmdbShowRaw & { external_ids?: { imdb_id?: string; tvdb_id?: number }; images?: TmdbImagesResponse; keywords?: TmdbKeywordsResponse }
    const imdbId = r.external_ids?.imdb_id ?? ''
    const tvdbId = r.external_ids?.tvdb_id ?? 0
    const mediaLanguage = (r.original_language ?? '').trim().toLowerCase() || await fetchSeriesLanguage(tvdbId)
    const s = { ...raw2show(r, imdbId, tvdbId, listedAt), mediaLanguage }
    upsertShow(s)
    return { id: 0, ...s }
  } catch {
    return null
  }
}

export async function fetchShowByImdbId(imdbId: string): Promise<Show | null> {
  const normalized = imdbId.trim()
  if (!normalized) return null
  const cached = getShowByImdbId(normalized)
  if (cached) return cached
  const tmdbId = await findTmdbShowIdByImdbId(normalized)
  return tmdbId ? fetchShowByTmdbId(tmdbId) : null
}

export async function fetchShowOfficialRatingByIds(opts: { tmdbId?: number | null; imdbId?: string; tvdbId?: number }): Promise<string> {
  const tmdbId = opts.tmdbId && Number.isFinite(opts.tmdbId) ? opts.tmdbId : null
  const imdbId = (opts.imdbId ?? '').trim()
  let show = tmdbId ? await fetchShowByTmdbId(tmdbId) : null
  if (!show && imdbId) show = await fetchShowByImdbId(imdbId)
  if (show?.officialRating) return show.officialRating

  const fallback = await fetchContentRatingFallback('series', {
    imdbId: show?.imdbId || imdbId,
    tvdbId: show?.tvdbId || opts.tvdbId,
  })
  if (fallback && show) {
    const { id: _id, ...stored } = show
    upsertShow({ ...stored, officialRating: fallback })
  }
  return fallback
}

/**
 * Fetch season details (including episodes) from TMDB and cache in DB.
 * Skip season 0 (specials). Returns the list of episodes stored.
 */
export async function fetchAndCacheSeasonDetails(
  showTmdbId: number,
  seasonNumber: number,
): Promise<Episode[]> {
  if (!config.tmdbApiKey) return []
  try {
    let show = getShowByTmdbId(showTmdbId) ?? await fetchShowByTmdbId(showTmdbId)
    const r = await tmdbGet(`/tv/${showTmdbId}/season/${seasonNumber}`) as TmdbSeasonRaw
    const season: Omit<Season, 'id'> = {
      showTmdbId,
      seasonNumber:  r.season_number,
      name:          r.name ?? `Season ${seasonNumber}`,
      overview:      r.overview ?? '',
      posterPath:    r.poster_path ?? '',
      episodeCount:  r.episodes?.length ?? 0,
      airDate:       r.air_date ?? '',
      syncedAt:      new Date().toISOString(),
    }
    upsertSeason(season)
    const episodes: Episode[] = []
    for (const e of r.episodes ?? []) {
      const ep: Omit<Episode, 'id'> = {
        showTmdbId,
        seasonNumber,
      episodeNumber: e.episode_number,
      name:          e.name ?? '',
      overview:      e.overview ?? '',
      stillPath:     e.still_path ?? '',
      runtimeMins:   e.runtime ?? 0,
      communityRating: e.vote_average ?? 0,
      airDate:       e.air_date ?? '',
      syncedAt:      new Date().toISOString(),
    }
      upsertEpisode(ep)
      episodes.push({ id: 0, ...ep })
    }

    const missingStillEpisodes = episodes.filter(ep => !ep.stillPath)
    if (config.tvdbApiKey && missingStillEpisodes.length) {
      if (show && !show.tvdbId) {
        const refreshedShow = await fetchShowByTmdbId(showTmdbId).catch(() => null)
        if (refreshedShow?.tvdbId) {
          show = refreshedShow
          console.log(`tvdb: backfilled tvdbId ${show.tvdbId} for ${show.title}`)
        }
      }
      if (show?.tvdbId) {
        try {
          const fallbackStills = await fetchEpisodeStillFallbacks(show.tvdbId, seasonNumber)
          let filledCount = 0
          for (const episode of missingStillEpisodes) {
            const fallbackStill = fallbackStills.get(episode.episodeNumber)
            if (!fallbackStill) continue
            const updated: Omit<Episode, 'id'> = {
              showTmdbId: episode.showTmdbId,
              seasonNumber: episode.seasonNumber,
              episodeNumber: episode.episodeNumber,
              name: episode.name,
              overview: episode.overview,
              stillPath: fallbackStill,
              runtimeMins: episode.runtimeMins,
              communityRating: episode.communityRating,
              airDate: episode.airDate,
              syncedAt: episode.syncedAt,
            }
            upsertEpisode(updated)
            episode.stillPath = fallbackStill
            filledCount += 1
          }
          console.log(`tvdb: ${show.title} S${seasonNumber} filled ${filledCount}/${missingStillEpisodes.length} missing stills`)
        } catch {
          // ignore TVDB fallback failures; TMDB remains source of truth
        }
      } else {
        console.log(`tvdb: skipping still fallback for show ${showTmdbId} S${seasonNumber} — missing tvdbId`)
      }
    }

    return episodes
  } catch {
    return []
  }
}

/**
 * Re-fetch show metadata from TMDB to fill in any missing fields (e.g. backdrop_path).
 * Only hits TMDB if the show is missing a backdrop.
 */
export async function refreshShowMetadataIfNeeded(show: Show): Promise<void> {
  if ((show.backdropPath && show.logoPath && show.officialRating && show.communityRating && show.studiosJson !== '[]' && show.castJson !== '[]' && (!config.tvdbApiKey || show.tvdbId)) || !config.tmdbApiKey) return
  try {
    const r = await tmdbGet(`/tv/${show.tmdbId}?append_to_response=external_ids,images,content_ratings,keywords,credits&include_image_language=en,null`) as
      TmdbShowRaw & { external_ids?: { imdb_id?: string; tvdb_id?: number }; images?: TmdbImagesResponse; keywords?: TmdbKeywordsResponse }
    const imdbId = r.external_ids?.imdb_id ?? show.imdbId
    const tvdbId = r.external_ids?.tvdb_id ?? show.tvdbId
    upsertShow(raw2show(r, imdbId, tvdbId))
  } catch {
    // ignore
  }
}

/**
 * Ensure all seasons for a show are cached in DB.
 * Fetches any season not yet present.
 */
export async function ensureShowSeasonsCached(show: Show): Promise<void> {
  let effectiveShow = show
  let cached = getSeasonsForShow(show.tmdbId)
  const cachedLatestSeason = latestSeasonNumber(cached)
  const cachedLatest = cached.find(season => season.seasonNumber === cachedLatestSeason)
  if (config.tmdbApiKey && isOngoingShow(effectiveShow) && (!cachedLatest || isStaleSyncedAt(cachedLatest.syncedAt, ACTIVE_SHOW_REFRESH_MS))) {
    effectiveShow = await refreshShowMetadata(effectiveShow)
    cached = getSeasonsForShow(effectiveShow.tmdbId)
  }

  const cachedNums = new Set(cached.map(s => s.seasonNumber))
  const cachedByNumber = new Map(cached.map(season => [season.seasonNumber, season]))
  const showMode = getEffectiveShowMode(effectiveShow.tmdbId)
  const latestKnownSeasonNumber = effectiveShow.numSeasons > 0 ? effectiveShow.numSeasons : (showMode.activeSeasonNumber || 0)
  const seasonNumbers = showMode.mode === 'latest'
    ? [...new Set([showMode.activeSeasonNumber || latestKnownSeasonNumber, latestKnownSeasonNumber])].filter(n => n > 0)
    : Array.from({ length: effectiveShow.numSeasons }, (_, idx) => idx + 1)
  const activeSeasonNumber = seasonNumbers.reduce((max, n) => Math.max(max, n), 0)

  for (const n of seasonNumbers) {
    if (!cachedNums.has(n)) {
      await fetchAndCacheSeasonDetails(effectiveShow.tmdbId, n)
      continue
    }

    const cachedSeason = cachedByNumber.get(n)
    if (cachedSeason && n === activeSeasonNumber && isOngoingShow(effectiveShow) && isStaleSyncedAt(cachedSeason.syncedAt, ACTIVE_SHOW_REFRESH_MS)) {
      await fetchAndCacheSeasonDetails(effectiveShow.tmdbId, n)
      continue
    }

    // Refresh already-cached seasons when aired episodes are missing stills.
    // This lets newly aired episodes pick up thumbnails after TMDB backfills
    // still_path without forcing all seasons with permanently missing artwork
    // to be re-fetched on every sync.
    const airedEpisodes = getAiredEpisodesForSeason(effectiveShow.tmdbId, n)
    if (shouldRetryMissingStillBackfill(airedEpisodes)) {
      await fetchAndCacheSeasonDetails(effectiveShow.tmdbId, n)
    }
  }
}
