import { config } from './config.js'
import { deleteTorBoxCleanupJob, getSetting, listTorBoxCleanupJobs, upsertTorBoxCleanupJob } from './db.js'
import { NotCachedError, ProviderUnavailableError } from './rd.js'
import type { ResolvedStream } from './rd.js'
import { similarity } from './streamUtils.js'

export { NotCachedError, ProviderUnavailableError }

const BASE = 'https://api.torbox.app/v1/api'

function torBoxApiKey(): string {
  return config.torBoxApiKey || ''
}

function torBoxCleanupEnabled(): boolean {
  return getSetting('torBoxCleanupMode') !== 'keep'
}

// ── Typed shapes ──────────────────────────────────────────────────────────────

interface TbResponse<T> {
  success:  boolean
  error?:   string | null
  detail?:  string
  data?:    T
}

class TorBoxApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly code: string | null,
    readonly detail: string | null,
    readonly body: string,
  ) {
    super(message)
    this.name = 'TorBoxApiError'
  }
}

interface TbCreateResult {
  torrent_id: number
  name?:      string
  hash:       string
  auth_id?:   string
}

interface TbTorrentFile {
  id:             number
  name:           string
  size:           number
  absolute_path?: string
}

interface TbTorrentInfo {
  id:             number
  hash:           string
  name:           string
  download_state: string
  files:          TbTorrentFile[]
}

// ── Low-level fetch ───────────────────────────────────────────────────────────

function formatFetchError(err: unknown): string {
  if (!(err instanceof Error)) return String(err)
  const cause = err.cause
  if (cause instanceof Error && cause.message) {
    const causeWithCode = cause as Error & { code?: unknown }
    const code = typeof causeWithCode.code === 'string' ? ` ${causeWithCode.code}` : ''
    return `${err.name}: ${err.message}; cause${code}: ${cause.message}`
  }
  return `${err.name}: ${err.message}`
}

async function tbFetch<T>(
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  options?: {
    form?: Record<string, string>
    json?: Record<string, string | number | boolean>
    query?: Record<string, string>
  },
): Promise<T> {
  let res: Response
  const { form, json, query } = options ?? {}
  const url = new URL(`${BASE}${path}`)
  if (query) {
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v)
  }
  const formBody = form ? new URLSearchParams(form) : undefined
  const jsonBody = json ? JSON.stringify(json) : undefined

  try {
    res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${torBoxApiKey()}`,
        ...(formBody ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
        ...(jsonBody ? { 'Content-Type': 'application/json' } : {}),
      },
      body: formBody ?? jsonBody,
      signal: AbortSignal.timeout(15_000),
    })
  } catch (err) {
    throw new ProviderUnavailableError(`TB ${method} ${path} failed: ${formatFetchError(err)}`)
  }

  if (res.status === 204) return null as T
  const text = await res.text()
  let parsed: TbResponse<T> | null = null
  if (text) {
    try {
      parsed = JSON.parse(text) as TbResponse<T>
    } catch {
      parsed = null
    }
  }
  if (!res.ok) {
    const code = parsed?.error ?? null
    const detail = parsed?.detail ?? null
    const suffix = code || detail ? `${code ?? 'error'}${detail ? `: ${detail}` : ''}` : text
    const message = `TB ${method} ${path} → ${res.status}: ${suffix}`
    if (res.status === 401 || res.status === 403 || res.status === 429 || res.status >= 500) {
      throw new ProviderUnavailableError(message, res.status)
    }
    throw new TorBoxApiError(message, res.status, code, detail, text)
  }
  if (!text) return null as T
  if (!parsed) throw new Error(`TB ${method} ${path} returned invalid JSON`)
  if (!parsed.success) {
    const code = parsed.error ?? null
    const detail = parsed.detail ?? null
    throw new TorBoxApiError(
      `TB ${method} ${path} error: ${code ?? detail ?? 'unknown'}`,
      res.status,
      code,
      detail,
      text,
    )
  }
  return parsed.data as T
}

// ── API operations ────────────────────────────────────────────────────────────

async function createTorrent(magnet: string): Promise<TbCreateResult> {
  return tbFetch<TbCreateResult>('POST', '/torrents/createtorrent', {
    form: { magnet, add_only_if_cached: 'true' },
  })
}

function isCreateTorrentCacheMiss(err: unknown): boolean {
  if (err instanceof TorBoxApiError && err.code === 'DOWNLOAD_NOT_CACHED') return true
  if (!(err instanceof Error)) return false
  return /\btorrent not found in cache\b/i.test(err.message)
}

async function getTorrentInfo(torrentId: number): Promise<TbTorrentInfo> {
  return tbFetch<TbTorrentInfo>('GET', '/torrents/mylist', {
    query: { id: String(torrentId), bypass_cache: 'true' },
  })
}

function requestDownloadUrl(torrentId: number, fileId: number, redirect: boolean): string {
  const query: Record<string, string> = {
    token:       config.torBoxApiKey,
    torrent_id:  String(torrentId),
    file_id:     String(fileId),
    zip_link:    'false',
    redirect:    redirect ? 'true' : 'false',
    append_name: 'true',
  }
  if (config.torBoxUserIp) query.user_ip = config.torBoxUserIp
  const url = new URL(`${BASE}/torrents/requestdl`)
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
  return url.toString()
}

async function deleteTorrent(torrentId: number): Promise<void> {
  await tbFetch('POST', '/torrents/controltorrent', {
    json: { torrent_id: torrentId, operation: 'delete' },
  })
}

// ── Poll until ready ──────────────────────────────────────────────────────────

const DOWNLOADING_STATES = new Set(['downloading', 'uploading', 'stalled (no seeds)', 'forced_start', 'paused'])
const READY_STATES       = new Set(['cached', 'completed'])

async function waitReady(
  torrentId: number,
  opts: { pollMs?: number; timeoutMs?: number } = {},
): Promise<TbTorrentInfo> {
  const { pollMs = 500, timeoutMs = 8_000 } = opts
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const info = await getTorrentInfo(torrentId)
    if (READY_STATES.has(info.download_state)) return info
    if (['error', 'torrent_error'].includes(info.download_state)) {
      throw new Error(`TorBox torrent ${torrentId} entered state: ${info.download_state}`)
    }
    if (DOWNLOADING_STATES.has(info.download_state)) {
      throw new NotCachedError(`Torrent ${torrentId} is not cached on TorBox (state: ${info.download_state})`)
    }
    await new Promise(r => setTimeout(r, pollMs))
  }
  throw new Error(`TorBox torrent ${torrentId} did not become ready within ${timeoutMs}ms`)
}

// ── File selection ────────────────────────────────────────────────────────────

const SELECTABLE_VIDEO_EXTS = new Set(['mkv', 'mp4', 'avi', 'mov', 'm4v', 'ts', 'm2ts', 'wmv', 'flv', 'webm'])

function fileExt(name: string): string {
  return name.split('?')[0]?.split('.').pop()?.toLowerCase() ?? ''
}

function isLikelyPlayableFile(f: TbTorrentFile): boolean {
  const lower = f.name.toLowerCase()
  if (/\bsample\b|\btrailer\b|\bextras?\b|\bfeaturette\b/.test(lower)) return false
  return SELECTABLE_VIDEO_EXTS.has(fileExt(lower))
}

function torrentFilePath(file: TbTorrentFile): string {
  return file.absolute_path || file.name
}

function basename(value: string): string {
  return value.split(/[\\/]/).filter(Boolean).pop() || value
}

function withoutExtension(value: string): string {
  return value.replace(/\.[a-z0-9]{2,5}$/i, '')
}

function normalizedFilename(value: string): string {
  return withoutExtension(basename(value))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function filenameTokens(value: string): Set<string> {
  return new Set(
    normalizedFilename(value)
      .split(/\s+/)
      .filter(token => token.length > 1),
  )
}

const TECHNICAL_FILENAME_TOKENS = new Set([
  '2160p', '1080p', '720p', '480p', '4k', 'uhd',
  'remux', 'bluray', 'blu-ray', 'web', 'webrip', 'webdl', 'web-dl', 'hdtv',
  'hdr', 'hdr10', 'dv', 'dolby', 'vision', 'hevc', 'h265', 'x265', 'avc', 'h264', 'x264',
  'truehd', 'atmos', 'dts', 'aac', 'ddp', 'dd', 'flac',
  'proper', 'repack', 'extended', 'internal',
])

function identityTokens(value: string): Set<string> {
  const tokens = [...filenameTokens(value)].filter(token =>
    !TECHNICAL_FILENAME_TOKENS.has(token)
    && !/^\d+$/.test(token)
    && !/^(?:19|20)\d{2}$/.test(token)
    && !/^tt\d+$/.test(token)
    && token !== 'imdb',
  )
  return new Set(tokens)
}

function imdbIds(value: string): Set<string> {
  const ids = normalizedFilename(value).match(/\btt\d{5,}\b/g) ?? []
  return new Set(ids)
}

function yearTokens(value: string): Set<string> {
  const years = normalizedFilename(value).match(/\b(?:19|20)\d{2}\b/g) ?? []
  return new Set(years)
}

function filenameHintScore(file: TbTorrentFile, hint: string): number {
  const filePath = torrentFilePath(file)
  const fileBase = normalizedFilename(filePath)
  const hintBase = normalizedFilename(hint)
  if (!fileBase || !hintBase) return 0
  if (fileBase === hintBase) return 100
  if (fileBase.includes(hintBase) || hintBase.includes(fileBase)) {
    return 80 * Math.min(fileBase.length, hintBase.length) / Math.max(fileBase.length, hintBase.length)
  }

  const fileImdbIds = imdbIds(fileBase)
  const hintImdbIds = imdbIds(hintBase)
  if (hintImdbIds.size && fileImdbIds.size) {
    let hasMatchingImdbId = false
    for (const imdbId of hintImdbIds) if (fileImdbIds.has(imdbId)) hasMatchingImdbId = true
    if (!hasMatchingImdbId) return 0
  }

  const fileYears = yearTokens(fileBase)
  const hintYears = yearTokens(hintBase)
  if (hintYears.size && fileYears.size) {
    let hasMatchingYear = false
    for (const year of hintYears) if (fileYears.has(year)) hasMatchingYear = true
    if (!hasMatchingYear) return 0
  }

  const fileIdentityTokens = identityTokens(fileBase)
  const hintIdentityTokens = identityTokens(hintBase)
  if (hintIdentityTokens.size) {
    let hasMatchingIdentityToken = false
    for (const token of hintIdentityTokens) if (fileIdentityTokens.has(token)) hasMatchingIdentityToken = true
    if (!hasMatchingIdentityToken) return 0
  }

  const fileTokenSet = filenameTokens(fileBase)
  const hintTokenSet = filenameTokens(hintBase)
  if (!hintTokenSet.size || !fileTokenSet.size) return 0
  let common = 0
  for (const token of hintTokenSet) if (fileTokenSet.has(token)) common++
  const coverage = common / hintTokenSet.size
  const balance = common / Math.max(fileTokenSet.size, hintTokenSet.size)
  return (coverage * 70) + (balance * 30)
}

function episodeMarker(value: string): string | null {
  const match = value.toLowerCase().match(/\bs(\d{1,2})\s*e(\d{1,2})\b/)
  if (!match) return null
  return `s${match[1].padStart(2, '0')}e${match[2].padStart(2, '0')}`
}

function pickBestFile(files: TbTorrentFile[], filePathHint?: string): TbTorrentFile {
  const candidates = files.filter(f => f.size > 0 && isLikelyPlayableFile(f))
  const pool = candidates.length ? candidates : files.filter(f => f.size > 0)
  if (!pool.length) throw new Error('TorBox torrent has no selectable files')

  if (filePathHint && pool.length > 1) {
    const hint = filePathHint.toLowerCase()
    const hintEpisode = episodeMarker(hint)
    if (hintEpisode) {
      const episodeMatches = pool.filter(f => episodeMarker(torrentFilePath(f)) === hintEpisode)
      if (episodeMatches.length === 1) return episodeMatches[0]
      if (episodeMatches.length > 1) {
        return [...episodeMatches].sort(
          (a, b) => similarity(torrentFilePath(b).toLowerCase(), hint) - similarity(torrentFilePath(a).toLowerCase(), hint),
        )[0]
      }
    }
    const scored = pool
      .map(file => ({ file, score: filenameHintScore(file, hint) }))
      .sort((a, b) => b.score - a.score || b.file.size - a.file.size)
    const best = scored[0]
    if (best && best.score >= 45) return best.file
    throw new Error(`TorBox torrent did not contain hinted file: ${basename(filePathHint)}`)
  }

  return pool.reduce((best, f) => (f.size > best.size ? f : best))
}

// ── Resolved-stream cache ─────────────────────────────────────────────────────

interface ResolvedCacheEntry extends ResolvedStream {
  expiresAt: number
}

const RESOLVED_CACHE_TTL_MS = 3 * 60 * 1000
const resolvedStreamCache   = new Map<string, ResolvedCacheEntry>()
const CLEANUP_IDLE_DELAY_MS = 15 * 60 * 1000
const CLEANUP_RETRY_DELAY_MS = 5 * 60 * 1000
const CLEANUP_RESCHEDULE_GRANULARITY_MS = 60 * 1000

interface CleanupEntry {
  torrentId:       number
  activeRequests: number
  deleteAt:        number
  retryCount:      number
  lastError?:      string
  timer?:          NodeJS.Timeout
}

const cleanupByDownloadUrl = new Map<string, CleanupEntry>()
const CLEANUP_MAX_RETRIES = 8

function cleanupRetryDelayMs(retryCount: number): number {
  const exponent = Math.max(0, retryCount - 1)
  return Math.min(CLEANUP_RETRY_DELAY_MS * (2 ** exponent), 6 * 60 * 60 * 1000)
}

function isDeleteAlreadyGoneError(err: unknown): boolean {
  if (err instanceof TorBoxApiError) {
    if (err.status === 404) return true
    const detail = [err.code ?? '', err.detail ?? '', err.message].join(' ').toLowerCase()
    return /\b(not found|does not exist|invalid torrent|unknown torrent)\b/.test(detail)
  }
  if (!(err instanceof Error)) return false
  return /\b(not found|does not exist|invalid torrent|unknown torrent)\b/i.test(err.message)
}

function resolveCacheKey(hash: string, filePathHint?: string): string {
  return `tb:${hash}|${(filePathHint ?? '').toLowerCase()}`
}

function getCachedResolvedStream(hash: string, filePathHint?: string): ResolvedStream | null {
  const key   = resolveCacheKey(hash, filePathHint)
  const entry = resolvedStreamCache.get(key)
  if (!entry) return null
  if (Date.now() > entry.expiresAt) { resolvedStreamCache.delete(key); return null }
  return { url: entry.url, filename: entry.filename, bytes: entry.bytes }
}

function setCachedResolvedStream(hash: string, filePathHint: string | undefined, value: ResolvedStream): void {
  resolvedStreamCache.set(resolveCacheKey(hash, filePathHint), {
    ...value,
    expiresAt: Date.now() + RESOLVED_CACHE_TTL_MS,
  })
}

function unscheduleCleanup(downloadUrl: string): void {
  deleteTorBoxCleanupJob(downloadUrl)
  cleanupByDownloadUrl.delete(downloadUrl)
}

function scheduleDeleteTorrent(downloadUrl: string, entry: CleanupEntry, deleteAt = Date.now() + CLEANUP_IDLE_DELAY_MS): void {
  if (!torBoxCleanupEnabled()) {
    if (entry.timer) clearTimeout(entry.timer)
    unscheduleCleanup(downloadUrl)
    return
  }
  if (entry.timer) clearTimeout(entry.timer)
  const shouldPersist = entry.deleteAt !== deleteAt
  entry.deleteAt = deleteAt
  if (shouldPersist) upsertTorBoxCleanupJob(downloadUrl, entry.torrentId, deleteAt)
  const timer = setTimeout(() => {
    if (entry.activeRequests > 0) return
    if (!torBoxCleanupEnabled()) {
      unscheduleCleanup(downloadUrl)
      return
    }
    void deleteTorrent(entry.torrentId)
      .then(() => {
        entry.retryCount = 0
        entry.lastError = undefined
        unscheduleCleanup(downloadUrl)
        console.log(`torbox: deleted torrent ${entry.torrentId} after playback idle timeout`)
      })
      .catch((err: unknown) => {
        if (isDeleteAlreadyGoneError(err)) {
          entry.retryCount = 0
          entry.lastError = undefined
          unscheduleCleanup(downloadUrl)
          console.log(`torbox: cleared cleanup job for already-missing torrent ${entry.torrentId}`)
          return
        }
        entry.retryCount++
        const message = String(err)
        const repeated = entry.lastError === message
        entry.lastError = message
        if (entry.retryCount > CLEANUP_MAX_RETRIES) {
          console.warn(`torbox: giving up deleting torrent ${entry.torrentId} after ${entry.retryCount} attempts: ${message}`)
          unscheduleCleanup(downloadUrl)
          return
        }
        const retryDelayMs = cleanupRetryDelayMs(entry.retryCount)
        if (!repeated || entry.retryCount <= 2) {
          console.warn(`torbox: failed to delete torrent ${entry.torrentId} (attempt ${entry.retryCount}/${CLEANUP_MAX_RETRIES}): ${message}`)
        }
        if (entry.activeRequests > 0) return
        scheduleDeleteTorrent(downloadUrl, entry, Date.now() + retryDelayMs)
      })
  }, Math.max(0, deleteAt - Date.now()))
  timer.unref()
  entry.timer = timer
}

function trackDownloadUrl(downloadUrl: string, torrentId: number): void {
  if (!torBoxCleanupEnabled()) return
  const existing = cleanupByDownloadUrl.get(downloadUrl)
  if (existing) {
    existing.torrentId = torrentId
    scheduleDeleteTorrent(downloadUrl, existing)
    return
  }
  const entry: CleanupEntry = { torrentId, activeRequests: 0, deleteAt: Date.now() + CLEANUP_IDLE_DELAY_MS, retryCount: 0 }
  cleanupByDownloadUrl.set(downloadUrl, entry)
  scheduleDeleteTorrent(downloadUrl, entry)
}

export function markPlaybackStarted(downloadUrl: string): () => void {
  const entry = cleanupByDownloadUrl.get(downloadUrl)
  if (!entry) return () => {}
  entry.activeRequests++
  if (entry.timer) {
    clearTimeout(entry.timer)
    entry.timer = undefined
  }
  let finished = false
  return () => {
    if (finished) return
    finished = true
    entry.activeRequests = Math.max(0, entry.activeRequests - 1)
    entry.retryCount = 0
    entry.lastError = undefined
    if (entry.activeRequests === 0) scheduleDeleteTorrent(downloadUrl, entry)
  }
}

export function torBoxRequestdlTorrentId(url: string): number | null {
  try {
    const parsed = new URL(url)
    if (parsed.hostname !== 'api.torbox.app') return null
    if (!parsed.pathname.includes('/torrents/requestdl')) return null
    const torrentId = Number.parseInt(parsed.searchParams.get('torrent_id') ?? '', 10)
    return Number.isFinite(torrentId) && torrentId > 0 ? torrentId : null
  } catch {
    return null
  }
}

export function trackDirectTorBoxUrl(url: string): void {
  if (!torBoxCleanupEnabled()) return
  const torrentId = torBoxRequestdlTorrentId(url)
  if (torrentId != null) trackDownloadUrl(url, torrentId)
}

export function touchDownloadUrl(downloadUrl: string): void {
  const entry = cleanupByDownloadUrl.get(downloadUrl)
  if (!entry || entry.activeRequests > 0) return
  const deleteAt = Date.now() + CLEANUP_IDLE_DELAY_MS
  if (deleteAt - entry.deleteAt < CLEANUP_RESCHEDULE_GRANULARITY_MS) return
  scheduleDeleteTorrent(downloadUrl, entry, deleteAt)
}

// A Stremio client follows the addon's 302 once and then streams the CDN URL
// directly, so no progress ever comes back and touchDownloadUrl will never be
// called again. Six hours has to outlast the longest plausible single viewing,
// because unlike the Jellyfin path nothing is going to extend it.
export const ADDON_PLAYBACK_RETENTION_MS = 6 * 60 * 60 * 1000

// Pushes a tracked entry's deletion deadline out by an explicit duration. Never
// pulls one in, and does nothing for a URL that is not tracked.
export function retainDownloadUrl(downloadUrl: string, retainForMs: number): void {
  const entry = cleanupByDownloadUrl.get(downloadUrl)
  if (!entry) return
  const deleteAt = Date.now() + retainForMs
  if (deleteAt <= entry.deleteAt) return
  scheduleDeleteTorrent(downloadUrl, entry, deleteAt)
}

// Called from the addon's resolvePlayback wrapper in src/index.ts. A retention
// failure must never fail a play, so everything here is best-effort: a
// non-TorBox resolution is ignored, an untracked URL is ignored, and a throw is
// swallowed. torBoxCleanupMode stays the admin's to set: when they have turned
// cleanup off there is no tracked entry to extend in the first place.
export function retainAddonPlayback(resolved: { url?: string; provider?: string } | null | undefined): void {
  // url first: a nullish resolution must not turn a controlled 404 into a
  // TypeError on the way out.
  if (!resolved?.url) return
  if (resolved?.provider !== 'TorBox') return
  try {
    retainDownloadUrl(resolved.url, ADDON_PLAYBACK_RETENTION_MS)
  } catch (err) {
    console.warn(`torbox: could not extend addon playback retention: ${err}`)
  }
}

export function rehydrateTorBoxCleanupJobs(): void {
  if (!torBoxApiKey()) return
  if (!torBoxCleanupEnabled()) {
    for (const job of listTorBoxCleanupJobs()) deleteTorBoxCleanupJob(job.downloadUrl)
    return
  }
  const now = Date.now()
  for (const job of listTorBoxCleanupJobs()) {
    const existing = cleanupByDownloadUrl.get(job.downloadUrl)
    const entry: CleanupEntry = existing ?? {
      torrentId: job.torrentId,
      activeRequests: 0,
      deleteAt: job.deleteAt,
      retryCount: 0,
    }
    entry.torrentId = job.torrentId
    entry.deleteAt = job.deleteAt
    entry.retryCount = entry.retryCount ?? 0
    cleanupByDownloadUrl.set(job.downloadUrl, entry)
    if (job.deleteAt <= now) {
      void deleteTorrent(job.torrentId)
        .then(() => {
          unscheduleCleanup(job.downloadUrl)
          console.log(`torbox: deleted torrent ${job.torrentId} after restart recovery`)
        })
        .catch((err: unknown) => {
          if (isDeleteAlreadyGoneError(err)) {
            unscheduleCleanup(job.downloadUrl)
            console.log(`torbox: cleared restart recovery job for already-missing torrent ${job.torrentId}`)
            return
          }
          console.warn(`torbox: failed to delete torrent ${job.torrentId} during restart recovery: ${String(err)}`)
        })
      continue
    }
    scheduleDeleteTorrent(job.downloadUrl, entry, job.deleteAt)
  }
}

function normalizeHashInput(hash: string): { cacheHash: string; magnet: string; cacheKeyHash: string } {
  const trimmed = hash.trim()
  const magnetHash = trimmed.startsWith('magnet:')
    ? trimmed.match(/btih:([^&]+)/i)?.[1] ?? ''
    : ''
  const cacheHash = (magnetHash || trimmed).toLowerCase()
  if (!/^[a-f0-9]{40}$/i.test(cacheHash) && !/^[a-z2-7]{32}$/i.test(cacheHash)) {
    throw new Error(`Invalid TorBox torrent hash: ${trimmed.slice(0, 16)}`)
  }
  return {
    cacheHash,
    magnet: trimmed.startsWith('magnet:') ? trimmed : `magnet:?xt=urn:btih:${cacheHash}`,
    cacheKeyHash: cacheHash,
  }
}

function assertDownloadUrl(value: string): string {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error('TorBox returned an invalid download URL')
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`TorBox returned a non-HTTPS download URL: ${parsed.protocol}`)
  }
  return parsed.toString()
}

// ── Public resolver ───────────────────────────────────────────────────────────

/**
 * Given a torrent hash, verify TorBox has it cached, add it, request a
 * direct-download link, and return the resolved stream. Torrent is deleted
 * after a delay so the CDN URL remains valid during playback.
 */
export async function resolveStream(
  hash: string,
  filePathHint?: string,
): Promise<ResolvedStream> {
  if (!torBoxApiKey()) throw new Error('TORBOX_API_KEY not configured')
  const { cacheHash, magnet, cacheKeyHash } = normalizeHashInput(hash)

  const cached = getCachedResolvedStream(cacheKeyHash, filePathHint)
  if (cached) {
    console.log(`torbox: cache hit for ${cacheHash.slice(0, 8)}… → ${cached.filename}`)
    return cached
  }

  console.log(`torbox: adding magnet ${cacheHash.slice(0, 8)}… to TorBox`)
  let created: TbCreateResult
  try {
    created = await createTorrent(magnet)
  } catch (err) {
    if (isCreateTorrentCacheMiss(err)) {
      throw new NotCachedError(`Torrent ${cacheHash.slice(0, 8)} is not cached on TorBox`)
    }
    throw err
  }
  console.log(`torbox: added magnet ${cacheHash.slice(0, 8)}… as torrent ${created.torrent_id}`)

  try {
    const info = await waitReady(created.torrent_id)
    const file = pickBestFile(info.files, filePathHint)
    const url = assertDownloadUrl(requestDownloadUrl(created.torrent_id, file.id, true))
    console.log(`torbox: resolved torrent ${created.torrent_id} → ${file.name}`)
    trackDownloadUrl(url, created.torrent_id)
    const resolved: ResolvedStream = { url, filename: file.name, bytes: file.size }
    setCachedResolvedStream(cacheKeyHash, filePathHint, resolved)
    return resolved
  } catch (err) {
    void deleteTorrent(created.torrent_id)
      .then(() => console.log(`torbox: deleted failed torrent ${created.torrent_id}`))
      .catch((deleteErr: unknown) => console.warn(`torbox: failed to delete failed torrent ${created.torrent_id}: ${String(deleteErr)}`))
    throw err
  }
}
