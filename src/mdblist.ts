import { config, normalizeListPresentation, presentationFromLegacyMode, type MdblistListEntry } from './config.js'
import {
  hasAnySourceItem,
  listSourceKeys,
  pruneOrphanedMovies,
  pruneOrphanedShows,
  removeSourceKey,
  replaceSourceItemsWithPositions,
  upsertManualShowSubscription,
  type MediaType,
} from './db.js'
import { fetchMovieByTmdbId, fetchShowByTmdbId, findTmdbIdByImdbId } from './tmdb.js'

const MDBLIST_SOURCE_PREFIX = 'mdblist:list:'
const MDBLIST_WEB_ORIGIN = 'https://mdblist.com'

interface MdblistEntry {
  tmdbId: number
  mediaType: MediaType
  rank?: number
}

interface MdblistFetchResult {
  entries: MdblistEntry[]
  capped: boolean
  discoveredTotal?: number
}

export interface MdblistListSyncResult {
  listUrl: string
  sourceKey: string
  movies: number
  shows: number
  total: number
  prunedMovies: number
  prunedShows: number
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export function normalizeMdblistListUrl(value: string): string {
  const raw = value.trim()
  if (!raw) throw new Error('MDBList URL is empty')

  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`
  let parsed: URL
  try {
    parsed = new URL(withScheme)
  } catch {
    throw new Error(`Invalid MDBList URL: ${raw}`)
  }

  const host = parsed.hostname.toLowerCase()
  if (host !== 'mdblist.com' && host !== 'www.mdblist.com') {
    throw new Error(`MDBList URL must use mdblist.com: ${raw}`)
  }

  const path = parsed.pathname.replace(/\/+$/, '')
  if (path === '/toplists') {
    throw new Error('MDBList Top Lists is a directory. Open it and paste one or more individual list URLs.')
  }
  if (!path.startsWith('/lists/')) {
    throw new Error(`MDBList URL must start with https://mdblist.com/lists/: ${raw}`)
  }

  const listPath = path.slice('/lists/'.length)
  if (!listPath || listPath.includes('//')) {
    throw new Error(`MDBList URL is missing a list path: ${raw}`)
  }

  return `${MDBLIST_WEB_ORIGIN}/lists/${listPath}${parsed.search}`
}

export function normalizeMdblistListUrls(values: string[]): string[] {
  const normalized: string[] = []
  const seen = new Set<string>()
  for (const value of values) {
    if (!value.trim()) continue
    const url = normalizeMdblistListUrl(value)
    if (!seen.has(url)) {
      seen.add(url)
      normalized.push(url)
    }
  }
  return normalized
}

export function normalizeMdblistEntries(entries: MdblistListEntry[]): MdblistListEntry[] {
  const result: MdblistListEntry[] = []
  const seen = new Set<string>()
  for (const entry of entries) {
    if (!entry.url?.trim()) continue
    try {
      const url = normalizeMdblistListUrl(entry.url)
      if (!seen.has(url)) {
        seen.add(url)
        const hasPresentation = entry.includeInLibrary != null || entry.showAsFolder != null || entry.showAsCollection != null
        const presentation = hasPresentation
          ? normalizeListPresentation(entry)
          : presentationFromLegacyMode(entry.mode)
        result.push({
          url,
          ...(entry.name?.trim() ? { name: entry.name.trim() } : {}),
          ...(presentation ? presentation : {}),
          ...(Number.isFinite(Number(entry.maxItems)) && Number(entry.maxItems) > 0 ? { maxItems: Math.trunc(Number(entry.maxItems)) } : {}),
        })
      }
    } catch { /* skip invalid URLs */ }
  }
  return result
}

export function mdblistListPathFromUrl(listUrl: string): string {
  const normalized = normalizeMdblistListUrl(listUrl)
  const parsed = new URL(normalized)
  return parsed.pathname.slice('/lists/'.length).replace(/\/+$/, '')
}

function mdblistListSource(listUrl: string): string {
  return `${MDBLIST_SOURCE_PREFIX}${mdblistListPathFromUrl(listUrl)}`
}

export function cleanupRemovedMdblistListSources(activeListUrls: string[]): {
  removedSourceKeys: string[]
  prunedMovies: number
  prunedShows: number
} {
  const activeKeys = new Set<string>()
  let hasInvalidActiveUrl = false
  for (const listUrl of activeListUrls) {
    try {
      activeKeys.add(mdblistListSource(listUrl))
    } catch {
      hasInvalidActiveUrl = true
    }
  }
  if (hasInvalidActiveUrl) {
    console.warn('mdblist: skipped stale-source cleanup because one or more configured URLs are invalid')
    return { removedSourceKeys: [], prunedMovies: 0, prunedShows: 0 }
  }

  const staleKeys = listSourceKeys(MDBLIST_SOURCE_PREFIX).filter(key => !activeKeys.has(key))
  let prunedMovies = 0
  let prunedShows = 0

  for (const sourceKey of staleKeys) {
    const removedMovieIds = removeSourceKey(sourceKey, 'movie')
    const removedShowIds = removeSourceKey(sourceKey, 'show')
    prunedMovies += pruneOrphanedMovies(removedMovieIds)
    prunedShows += pruneOrphanedShows(removedShowIds)
  }

  return {
    removedSourceKeys: staleKeys,
    prunedMovies,
    prunedShows,
  }
}

async function fetchPublicListHtml(listUrl: string): Promise<string> {
  let lastError: Error | null = null
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(listUrl, {
        headers: { 'User-Agent': 'fetcherr/1.0' },
        signal: AbortSignal.timeout(20_000),
      })
      const text = await res.text()
      if (!res.ok) {
        if ([502, 503, 504].includes(res.status) && attempt < 2) {
          await sleep(500 * (attempt + 1))
          continue
        }
        throw new Error(`MDBList ${res.status}: ${text.slice(0, 300)}`)
      }
      return text
    } catch (err) {
      lastError = err as Error
      if (attempt < 2) {
        await sleep(500 * (attempt + 1))
        continue
      }
    }
  }

  throw lastError ?? new Error('MDBList public list fetch failed')
}

function extractPublicListEntries(html: string): MdblistEntry[] {
  const entries: MdblistEntry[] = []
  const seen = new Set<string>()
  const pattern = /(?:https?:)?\/\/(?:www\.)?themoviedb\.org\/(movie|tv)\/(\d+)/gi
  let match: RegExpExecArray | null

  while ((match = pattern.exec(html)) !== null) {
    const mediaType: MediaType = match[1].toLowerCase() === 'tv' ? 'show' : 'movie'
    const tmdbId = Number.parseInt(match[2], 10)
    if (!Number.isFinite(tmdbId) || tmdbId <= 0) continue

    const key = `${mediaType}:${tmdbId}`
    if (seen.has(key)) continue
    seen.add(key)
    entries.push({ mediaType, tmdbId })
  }

  return entries
}

function extractPublicListItemPaths(html: string): Array<{ mediaType: MediaType; path: string }> {
  const entries: Array<{ mediaType: MediaType; path: string }> = []
  const seen = new Set<string>()
  const pattern = /class="jw-chart-card__poster"\s+href="\/(movie|show)\/([^"]+)"/gi
  let match: RegExpExecArray | null
  while ((match = pattern.exec(html)) !== null) {
    const mediaType: MediaType = match[1].toLowerCase() === 'show' ? 'show' : 'movie'
    const path = `${mediaType}/${match[2]}`
    if (seen.has(path)) continue
    seen.add(path)
    entries.push({ mediaType, path })
  }
  return entries
}

async function extractCurrentPublicListEntries(html: string, maxEntries: number): Promise<MdblistEntry[]> {
  const directEntries = extractPublicListEntries(html)
  if (directEntries.length) return directEntries.slice(0, maxEntries)

  const itemPaths = extractPublicListItemPaths(html).slice(0, maxEntries)
  const resolved = await Promise.all(itemPaths.map(async ({ mediaType, path }, index) => {
    try {
      const detailHtml = await fetchPublicListHtml(`${MDBLIST_WEB_ORIGIN}/${path}`)
      const imdbMatch = detailHtml.match(/imdb\.com\/title\/(tt\d+)/i)
      if (!imdbMatch) return null
      const tmdbId = await findTmdbIdByImdbId(imdbMatch[1], mediaType)
      return tmdbId ? { tmdbId, mediaType, rank: index + 1 } : null
    } catch {
      return null
    }
  }))
  return resolved.filter((entry): entry is NonNullable<typeof entry> => !!entry)
}

interface MdblistApiItem {
  id?: number
  rank?: number
  mediatype?: string
  ids?: { tmdb?: number }
}

type MdblistApiEndpoint = {
  url: URL
  responseKind: 'standard-list' | 'justwatch-chart'
}

function mdblistApiItemsRequest(listUrl: string, limit: number, offset: number, apiKey: string): MdblistApiEndpoint {
  const normalized = normalizeMdblistListUrl(listUrl)
  const input = new URL(normalized)
  const parts = input.pathname.split('/').filter(Boolean)
  const mediaMap: Record<string, MediaType> = {
    movies: 'movie',
    shows: 'show',
  }

  if (parts[0] !== 'lists') {
    throw new Error('Unsupported MDBList URL')
  }

  if (parts[1] === 'official' && mediaMap[parts[2]]) {
    const mediaType = mediaMap[parts[2]]
    const slug = parts[3]
    if (!slug) throw new Error('Unsupported MDBList official list URL')

    if (slug === 'justwatch-streaming-charts') {
      const output = new URL(`https://api.mdblist.com/justwatch/streaming-charts/${mediaType}`)
      for (const name of ['locale', 'country', 'rank', 'period', 'provider', 'genre', 'subgenre', 'x']) {
        const value = input.searchParams.get(name)
        if (value !== null) output.searchParams.set(name, value)
      }
      if (!output.searchParams.has('x')) output.searchParams.set('x', '20')
      output.searchParams.set('apikey', apiKey)
      return { url: output, responseKind: 'justwatch-chart' }
    }

    const apiSlug = slug === 'streaming-charts' ? 'justwatch-streaming-charts' : slug
    const output = new URL(`https://api.mdblist.com/lists/official/${apiSlug}/items`)
    output.searchParams.set('limit', String(limit))
    output.searchParams.set('offset', String(offset))
    output.searchParams.set('mediatype', mediaType)
    output.searchParams.set('apikey', apiKey)
    return { url: output, responseKind: 'standard-list' }
  }

  if (parts.length === 3) {
    const [, username, slug] = parts
    const output = new URL(`https://api.mdblist.com/lists/${username}/${slug}/items`)
    output.searchParams.set('limit', String(limit))
    output.searchParams.set('offset', String(offset))
    output.searchParams.set('apikey', apiKey)
    return { url: output, responseKind: 'standard-list' }
  }

  throw new Error('Unsupported MDBList list URL')
}

async function fetchApiListEntries(listUrl: string, apiKey: string, maxEntries: number): Promise<MdblistFetchResult> {
  const entries: MdblistEntry[] = []
  const seen = new Set<string>()
  const limit = Math.max(1, Math.min(100, maxEntries))
  let offset = 0
  let capped = false

  const addEntry = (entry: MdblistEntry): void => {
    const key = `${entry.mediaType}:${entry.tmdbId}`
    if (seen.has(key) || entries.length >= maxEntries) return
    seen.add(key)
    entries.push(entry)
    if (entries.length >= maxEntries) capped = true
  }

  while (true) {
    const request = mdblistApiItemsRequest(listUrl, limit, offset, apiKey)
    let res: Response
    try {
      res = await fetch(request.url, {
        headers: { 'User-Agent': 'fetcherr/1.0' },
        signal: AbortSignal.timeout(20_000),
      })
    } catch (err) {
      throw new Error(`MDBList API request failed: ${err}`)
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`MDBList API ${res.status}: ${body.slice(0, 200)}`)
    }
        const data = await res.json() as { movies?: MdblistApiItem[]; shows?: MdblistApiItem[]; results?: MdblistApiItem[]; media_type?: string }
    if (request.responseKind === 'justwatch-chart') {
      const mediaType: MediaType = data.media_type === 'show' ? 'show' : 'movie'
      for (const item of data.results ?? []) {
        const tmdbId = item.ids?.tmdb ?? item.id
        if (!tmdbId || !Number.isFinite(tmdbId) || tmdbId <= 0) continue
        addEntry({ tmdbId, mediaType, rank: item.rank })
      }
      break
    }

    const pageMovies = data.movies ?? []
    const pageShows = data.shows ?? []

    for (const item of pageMovies) {
      const tmdbId = item.ids?.tmdb ?? item.id
      if (!tmdbId || !Number.isFinite(tmdbId) || tmdbId <= 0) continue
      addEntry({ tmdbId, mediaType: 'movie', rank: item.rank })
    }
    for (const item of pageShows) {
      const tmdbId = item.ids?.tmdb ?? item.id
      if (!tmdbId || !Number.isFinite(tmdbId) || tmdbId <= 0) continue
      addEntry({ tmdbId, mediaType: 'show', rank: item.rank })
    }

    if (entries.length >= maxEntries) break
    if (pageMovies.length + pageShows.length < limit) break
    offset += limit
  }

  return { entries, capped }
}

async function fetchMdblistEntries(listUrl: string, maxEntries: number): Promise<MdblistFetchResult> {
  if (config.mdblistApiKey) {
    const result = await fetchApiListEntries(listUrl, config.mdblistApiKey, maxEntries)
    const { entries } = result
    if (!entries.length) throw new Error('MDBList API returned no items for this list')
    return result
  }
  const html = await fetchPublicListHtml(listUrl)
  const allEntries = await extractCurrentPublicListEntries(html, maxEntries)
  if (!allEntries.length) {
    throw new Error('No TMDB links found on public MDBList page')
  }
  const entries = allEntries.slice(0, maxEntries)
  return {
    entries,
    capped: allEntries.length > entries.length,
    discoveredTotal: allEntries.length,
  }
}

export async function syncMdblistList(listUrl: string): Promise<MdblistListSyncResult> {
  const normalizedUrl = normalizeMdblistListUrl(listUrl)
  const sourceKey = mdblistListSource(normalizedUrl)

  if (!config.tmdbApiKey) {
    console.log('mdblist: TMDB_API_KEY not configured, skipping')
    return { listUrl: normalizedUrl, sourceKey, movies: 0, shows: 0, total: 0, prunedMovies: 0, prunedShows: 0 }
  }

  console.log(`mdblist: syncing ${normalizedUrl}`)
  const configuredEntry = config.mdblistLists.find(entry => normalizeMdblistListUrl(entry.url) === normalizedUrl)
  const maxItems = Math.max(1, configuredEntry?.maxItems ?? config.mdblistMaxItems)
  const { entries, capped, discoveredTotal } = await fetchMdblistEntries(normalizedUrl, maxItems)
  if (capped) {
    const totalLabel = discoveredTotal ? `${discoveredTotal} public TMDB links` : `at least ${entries.length} API items`
    console.warn(`mdblist: ${normalizedUrl} has ${totalLabel}; importing first ${entries.length}. Set MDBLIST_MAX_ITEMS to adjust this cap.`)
  } else {
    console.log(`mdblist: ${normalizedUrl} has ${entries.length} items`)
  }

  let movies = 0
  let shows = 0
  const movieSourceItems: Array<{ tmdbId: number; sourcePosition: number }> = []
  const showSourceItems: Array<{ tmdbId: number; sourcePosition: number }> = []

  for (const [idx, entry] of entries.entries()) {
    const sourcePosition = entry.rank && Number.isFinite(entry.rank) && entry.rank > 0 ? Math.trunc(entry.rank) : idx + 1
    if (entry.mediaType === 'movie') {
      movieSourceItems.push({ tmdbId: entry.tmdbId, sourcePosition })
      const movie = await fetchMovieByTmdbId(entry.tmdbId)
      if (movie) movies++
      continue
    }

    const isNewToLibrary = !hasAnySourceItem('show', entry.tmdbId)
    showSourceItems.push({ tmdbId: entry.tmdbId, sourcePosition })
    const show = await fetchShowByTmdbId(entry.tmdbId)
    if (show && isNewToLibrary && config.showAddDefaultMode === 'latest') {
      upsertManualShowSubscription(entry.tmdbId, 'latest', 0)
    }
    if (show) shows++
  }

  const removedMovies = replaceSourceItemsWithPositions(sourceKey, 'movie', movieSourceItems)
  const removedShows = replaceSourceItemsWithPositions(sourceKey, 'show', showSourceItems)
  const prunedMovies = pruneOrphanedMovies(removedMovies)
  const prunedShows = pruneOrphanedShows(removedShows)

  console.log(
    `mdblist: ${normalizedUrl} sync complete — ${movies} movies, ${shows} shows, ${prunedMovies} movies removed, ${prunedShows} shows removed`
  )

  return {
    listUrl: normalizedUrl,
    sourceKey,
    movies,
    shows,
    total: entries.length,
    prunedMovies,
    prunedShows,
  }
}
