import { config } from './config.js'
import {
  upsertMovie, getMovieByTmdbId, type Movie,
  upsertShow, getShowByTmdbId, type Show,
  upsertSeason, getSeasonsForShow, type Season,
  upsertEpisode, type Episode, getAiredEpisodesForSeason,
} from './db.js'
import { fetchEpisodeStillFallbacks } from './tvdb.js'

const BASE = 'https://api.themoviedb.org/3'

async function tmdbGet(path: string): Promise<unknown> {
  const sep = path.includes('?') ? '&' : '?'
  const res = await fetch(`${BASE}${path}${sep}api_key=${config.tmdbApiKey}`)
  if (!res.ok) throw new Error(`TMDB ${res.status} for ${path}`)
  return res.json()
}

interface TmdbMovieRaw {
  id:            number
  title:         string
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
    releaseDate:        r.release_date ?? '',
    digitalReleaseDate: extractDigitalReleaseDate(r),
    syncedAt:           listedAt,
  }
}

async function fetchImdbId(tmdbId: number): Promise<string> {
  try {
    const d = await tmdbGet(`/movie/${tmdbId}/external_ids`) as { imdb_id?: string }
    return d.imdb_id ?? ''
  } catch {
    return ''
  }
}

export async function seedPopular(): Promise<void> {
  if (!config.tmdbApiKey) return
  console.log('tmdb: seeding popular movies')
  let total = 0
  for (let page = 1; page <= 10; page++) {
    const d = await tmdbGet(`/movie/popular?language=en-US&page=${page}`) as { results: TmdbMovieRaw[] }
    if (!d.results?.length) break
    for (const r of d.results) {
      const imdbId = await fetchImdbId(r.id)
      upsertMovie(raw2movie(r, imdbId))
      total++
    }
    console.log(`tmdb: seeded page ${page} (${total} total)`)
  }
  console.log(`tmdb: seed complete — ${total} movies`)
}

export async function searchTmdb(query: string): Promise<Movie[]> {
  if (!config.tmdbApiKey) return []
  const d = await tmdbGet(
    `/search/movie?query=${encodeURIComponent(query)}&include_adult=false&language=en-US`
  ) as { results: TmdbMovieRaw[] }
  const out = await Promise.all((d.results ?? []).map(async (r) => {
    const imdbId = await fetchImdbId(r.id)
    const m = raw2movie(r, imdbId)
    return { id: 0, ...m }
  }))
  return out
}

/**
 * Re-fetch movie metadata from TMDB to fill in any missing fields (e.g. backdrop_path).
 * Only hits TMDB if the movie is missing a backdrop.
 */
export async function refreshMovieMetadataIfNeeded(movie: Movie): Promise<void> {
  if (!config.tmdbApiKey) return
  // Refresh if missing backdrop or release date info
  if (movie.backdropPath && movie.logoPath && movie.releaseDate && movie.officialRating && movie.communityRating && movie.studiosJson !== '[]') return
  try {
    const r = await tmdbGet(`/movie/${movie.tmdbId}?append_to_response=external_ids,release_dates,images,keywords&include_image_language=en,null`) as
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
  if (cached?.imdbId) return cached

  try {
    const r = await tmdbGet(`/movie/${tmdbId}?append_to_response=external_ids,release_dates,images,keywords&include_image_language=en,null`) as
      TmdbMovieRaw & { external_ids?: { imdb_id?: string }; images?: TmdbImagesResponse; keywords?: TmdbKeywordsResponse }
    const imdbId = r.external_ids?.imdb_id ?? ''
    const m = raw2movie(r, imdbId, listedAt)
    upsertMovie(m)
    return { id: 0, ...m }
  } catch {
    return null
  }
}

export async function fetchMovieCollection(movieTmdbId: number): Promise<MovieCollectionItem[]> {
  if (!config.tmdbApiKey) return []
  try {
    const movie = await tmdbGet(`/movie/${movieTmdbId}`) as TmdbMovieRaw
    const collection = movie.belongs_to_collection
    if (!collection?.id) return []

    const raw = await tmdbGet(`/collection/${collection.id}?language=en-US`) as TmdbCollectionRaw
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

export function posterUrl(posterPath: string): string {
  if (!posterPath) return ''
  if (posterPath.startsWith('http://') || posterPath.startsWith('https://')) return posterPath
  return `https://image.tmdb.org/t/p/original${posterPath}`
}

// ── TV Shows ──────────────────────────────────────────────────────────────────

interface TmdbShowRaw {
  id:               number
  name:             string
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
    syncedAt:     listedAt,
  }
}

export async function fetchShowByTmdbId(tmdbId: number, listedAt = ''): Promise<Show | null> {
  if (!config.tmdbApiKey) return null
  const cached = getShowByTmdbId(tmdbId)
  if (cached?.imdbId && (!config.tvdbApiKey || cached.tvdbId)) return cached

  try {
    const r = await tmdbGet(`/tv/${tmdbId}?append_to_response=external_ids,images,content_ratings,keywords&include_image_language=en,null`) as
      TmdbShowRaw & { external_ids?: { imdb_id?: string; tvdb_id?: number }; images?: TmdbImagesResponse; keywords?: TmdbKeywordsResponse }
    const imdbId = r.external_ids?.imdb_id ?? ''
    const tvdbId = r.external_ids?.tvdb_id ?? 0
    const s = raw2show(r, imdbId, tvdbId, listedAt)
    upsertShow(s)
    return { id: 0, ...s }
  } catch {
    return null
  }
}

export async function searchTmdbShows(query: string): Promise<Show[]> {
  if (!config.tmdbApiKey) return []
  const d = await tmdbGet(
    `/search/tv?query=${encodeURIComponent(query)}&include_adult=false&language=en-US`
  ) as { results: TmdbShowRaw[] }
  const out = await Promise.all((d.results ?? []).map(async (r) => {
    const full = await tmdbGet(`/tv/${r.id}?append_to_response=external_ids,images,content_ratings,keywords&include_image_language=en,null`)
      .then(result => result as Partial<TmdbShowRaw> & { external_ids?: { imdb_id?: string; tvdb_id?: number }; images?: TmdbImagesResponse })
      .catch(() => ({} as Partial<TmdbShowRaw> & { external_ids?: { imdb_id?: string; tvdb_id?: number }; images?: TmdbImagesResponse }))
    const imdbId = full.external_ids?.imdb_id ?? ''
    const tvdbId = full.external_ids?.tvdb_id ?? 0
    const s = raw2show({ ...r, ...full, images: full.images } as TmdbShowRaw & { images?: TmdbImagesResponse }, imdbId, tvdbId)
    return { id: 0, ...s }
  }))
  return out
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
  if ((show.backdropPath && show.logoPath && show.officialRating && show.communityRating && show.studiosJson !== '[]' && (!config.tvdbApiKey || show.tvdbId)) || !config.tmdbApiKey) return
  try {
    const r = await tmdbGet(`/tv/${show.tmdbId}?append_to_response=external_ids,images,content_ratings,keywords&include_image_language=en,null`) as
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
  const cached = getSeasonsForShow(show.tmdbId)
  const cachedNums = new Set(cached.map(s => s.seasonNumber))
  for (let n = 1; n <= show.numSeasons; n++) {
    if (!cachedNums.has(n)) {
      await fetchAndCacheSeasonDetails(show.tmdbId, n)
      continue
    }

    // Refresh already-cached seasons when aired episodes are missing stills.
    // This lets newly aired episodes pick up thumbnails after TMDB backfills
    // still_path without forcing all seasons to be re-fetched on every sync.
    const airedEpisodes = getAiredEpisodesForSeason(show.tmdbId, n)
    if (airedEpisodes.some(ep => !ep.stillPath)) {
      await fetchAndCacheSeasonDetails(show.tmdbId, n)
    }
  }
}
