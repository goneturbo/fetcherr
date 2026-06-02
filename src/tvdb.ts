import { config } from './config.js'

const BASE = 'https://api4.thetvdb.com/v4'

let cachedToken = ''
let cachedTokenExpiresAt = 0

interface TvdbLoginResponse {
  data?: {
    token?: string
  }
}

interface TvdbEpisodeRecord {
  number?: number
  seasonNumber?: number
  image?: string | null
}

interface TvdbEpisodesResponse {
  data?: {
    episodes?: TvdbEpisodeRecord[]
  } | TvdbEpisodeRecord[]
}

interface TvdbSeriesResponse {
  data?: {
    language?: string | null
    originalLanguage?: string | null
    original_language?: string | null
  } | null
}

interface TvdbContentRating {
  name?: string | null
  country?: string | null
  contentType?: string | null
}

interface TvdbExtendedRatingResponse {
  data?: {
    contentRatings?: TvdbContentRating[]
  } | null
}

interface TvdbRemoteSearchResponse {
  data?: Array<{
    movie?: { id?: number | null } | null
    series?: { id?: number | null } | null
  }>
}

async function login(): Promise<string> {
  if (!config.tvdbApiKey) throw new Error('TVDB_API_KEY not configured')
  if (cachedToken && Date.now() < cachedTokenExpiresAt) return cachedToken

  const res = await fetch(`${BASE}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apikey: config.tvdbApiKey }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`TVDB login failed with ${res.status}`)
  const json = await res.json() as TvdbLoginResponse
  const token = json.data?.token ?? ''
  if (!token) throw new Error('TVDB login returned no token')

  cachedToken = token
  cachedTokenExpiresAt = Date.now() + (24 * 60 * 60 * 1000)
  return token
}

async function tvdbGet(path: string, retry = true): Promise<unknown> {
  const token = await login()
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(20_000),
  })
  if (res.status === 401 && retry) {
    cachedToken = ''
    cachedTokenExpiresAt = 0
    return tvdbGet(path, false)
  }
  if (!res.ok) throw new Error(`TVDB ${res.status} for ${path}`)
  return res.json()
}

export async function fetchEpisodeStillFallbacks(tvdbId: number, seasonNumber: number): Promise<Map<number, string>> {
  if (!config.tvdbApiKey || !tvdbId || seasonNumber <= 0) return new Map()

  const json = await tvdbGet(`/series/${tvdbId}/episodes/official?season=${seasonNumber}`) as TvdbEpisodesResponse
  const rawEpisodes = Array.isArray(json.data) ? json.data : (json.data?.episodes ?? [])
  const map = new Map<number, string>()

  for (const episode of rawEpisodes) {
    if (episode.seasonNumber != null && episode.seasonNumber !== seasonNumber) continue
    const num = episode.number
    const image = episode.image ?? ''
    if (typeof num === 'number' && image) {
      map.set(num, image)
    }
  }

  return map
}

export async function fetchSeriesLanguage(tvdbId: number): Promise<string> {
  if (!config.tvdbApiKey || !tvdbId) return ''
  const paths = [
    `/series/${tvdbId}`,
    `/series/${tvdbId}/extended`,
  ]
  for (const path of paths) {
    try {
      const json = await tvdbGet(path) as TvdbSeriesResponse
      const language = (json.data?.originalLanguage ?? json.data?.original_language ?? json.data?.language ?? '').trim().toLowerCase()
      if (language) return language
    } catch {
      // ignore and try the next endpoint shape
    }
  }
  return ''
}

function pickUsContentRating(ratings: TvdbContentRating[] | undefined, mediaType: 'movie' | 'series'): string {
  const expectedContentType = mediaType === 'series' ? 'series' : 'movie'
  const matches = (ratings ?? []).filter(rating => {
    const country = (rating.country ?? '').trim().toLowerCase()
    const contentType = (rating.contentType ?? '').trim().toLowerCase()
    const isUs = country === 'us' || country === 'usa' || country === 'united states'
    const matchesType = !contentType || contentType === expectedContentType
    return isUs && matchesType && rating.name
  })
  return matches[0]?.name?.trim() ?? ''
}

async function fetchContentRatingByTvdbId(mediaType: 'movie' | 'series', tvdbId: number): Promise<string> {
  if (!config.tvdbApiKey || !tvdbId) return ''
  const path = mediaType === 'movie' ? `/movies/${tvdbId}/extended?short=true` : `/series/${tvdbId}/extended?short=true`
  try {
    const json = await tvdbGet(path) as TvdbExtendedRatingResponse
    return pickUsContentRating(json.data?.contentRatings, mediaType)
  } catch {
    return ''
  }
}

export async function fetchContentRatingFallback(
  mediaType: 'movie' | 'series',
  opts: { imdbId?: string; tvdbId?: number },
): Promise<string> {
  if (!config.tvdbApiKey) return ''
  if (opts.tvdbId) {
    const rating = await fetchContentRatingByTvdbId(mediaType, opts.tvdbId)
    if (rating) return rating
  }

  const imdbId = (opts.imdbId ?? '').trim()
  if (!imdbId) return ''
  try {
    const json = await tvdbGet(`/search/remoteid/${encodeURIComponent(imdbId)}`) as TvdbRemoteSearchResponse
    for (const result of json.data ?? []) {
      const tvdbId = mediaType === 'movie' ? result.movie?.id : result.series?.id
      if (!tvdbId) continue
      const rating = await fetchContentRatingByTvdbId(mediaType, tvdbId)
      if (rating) return rating
    }
  } catch {
    return ''
  }
  return ''
}
