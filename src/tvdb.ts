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
