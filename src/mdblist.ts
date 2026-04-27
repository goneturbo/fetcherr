import { config } from './config.js'
import {
  hasAnySourceItem,
  listSourceKeys,
  pruneOrphanedMovies,
  pruneOrphanedShows,
  removeSourceKey,
  replaceSourceItems,
  upsertManualShowSubscription,
  type MediaType,
} from './db.js'
import { fetchMovieByTmdbId, fetchShowByTmdbId } from './tmdb.js'

const MDBLIST_SOURCE_PREFIX = 'mdblist:list:'
const MDBLIST_WEB_ORIGIN = 'https://mdblist.com'

interface MdblistEntry {
  tmdbId: number
  mediaType: MediaType
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

  return `${MDBLIST_WEB_ORIGIN}/lists/${listPath}`
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

function listPathFromUrl(listUrl: string): string {
  const normalized = normalizeMdblistListUrl(listUrl)
  const parsed = new URL(normalized)
  return parsed.pathname.slice('/lists/'.length).replace(/\/+$/, '')
}

function mdblistListSource(listUrl: string): string {
  return `${MDBLIST_SOURCE_PREFIX}${listPathFromUrl(listUrl)}`
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

async function fetchMdblistEntries(listUrl: string): Promise<MdblistEntry[]> {
  const html = await fetchPublicListHtml(listUrl)
  const entries = extractPublicListEntries(html)
  if (!entries.length) {
    throw new Error('No TMDB links found on public MDBList page')
  }
  return entries
}

export async function syncMdblistList(listUrl: string): Promise<MdblistListSyncResult> {
  const normalizedUrl = normalizeMdblistListUrl(listUrl)
  const sourceKey = mdblistListSource(normalizedUrl)

  if (!config.tmdbApiKey) {
    console.log('mdblist: TMDB_API_KEY not configured, skipping')
    return { listUrl: normalizedUrl, sourceKey, movies: 0, shows: 0, total: 0, prunedMovies: 0, prunedShows: 0 }
  }

  console.log(`mdblist: syncing ${normalizedUrl}`)
  const allEntries = await fetchMdblistEntries(normalizedUrl)
  const maxItems = Math.max(1, config.mdblistMaxItems)
  const entries = allEntries.slice(0, maxItems)
  if (allEntries.length > entries.length) {
    console.warn(
      `mdblist: ${normalizedUrl} has ${allEntries.length} public TMDB links; importing first ${entries.length}. ` +
      'Set MDBLIST_MAX_ITEMS to adjust this cap.'
    )
  } else {
    console.log(`mdblist: ${normalizedUrl} has ${entries.length} public TMDB links`)
  }

  let movies = 0
  let shows = 0
  const movieTmdbIds: number[] = []
  const showTmdbIds: number[] = []

  for (const entry of entries) {
    if (entry.mediaType === 'movie') {
      movieTmdbIds.push(entry.tmdbId)
      const movie = await fetchMovieByTmdbId(entry.tmdbId)
      if (movie) movies++
      continue
    }

    const isNewToLibrary = !hasAnySourceItem('show', entry.tmdbId)
    showTmdbIds.push(entry.tmdbId)
    const show = await fetchShowByTmdbId(entry.tmdbId)
    if (show && isNewToLibrary && config.showAddDefaultMode === 'latest') {
      upsertManualShowSubscription(entry.tmdbId, 'latest', 0)
    }
    if (show) shows++
  }

  const removedMovies = replaceSourceItems(sourceKey, 'movie', movieTmdbIds)
  const removedShows = replaceSourceItems(sourceKey, 'show', showTmdbIds)
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
