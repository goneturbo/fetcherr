import { config } from './config.js'
import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'

const BASE = 'https://api.real-debrid.com/rest/1.0'
const execFile = promisify(execFileCb)

// ── Low-level fetch ────────────────────────────────────────────────────────────

async function rdFetch(
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: Record<string, string>,
): Promise<unknown> {
  let res: Response
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${config.rdApiKey}`,
        ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      },
      body: body ? new URLSearchParams(body).toString() : undefined,
      signal: AbortSignal.timeout(15_000),
    })
  } catch (err) {
    throw new ProviderUnavailableError(`RD ${method} ${path} failed: ${String(err)}`)
  }
  if (res.status === 204) return null
  const text = await res.text()
  if (!res.ok) {
    const message = `RD ${method} ${path} → ${res.status}: ${text}`
    if (res.status === 401 || res.status === 403 || res.status === 429 || res.status >= 500) {
      throw new ProviderUnavailableError(message)
    }
    throw new Error(message)
  }
  return text ? JSON.parse(text) : null
}

// ── Typed shapes ───────────────────────────────────────────────────────────────

interface RdAddMagnetResult {
  id:  string
  uri: string
}

interface RdTorrentFile {
  id:       number
  path:     string
  bytes:    number
  selected: number
}

interface RdTorrentInfo {
  id:       string
  status:   string
  files:    RdTorrentFile[]
  links:    string[]
}

interface RdUnrestrictResult {
  download:  string
  filename:  string
  filesize:  number
  mimeType?: string
}

// ── Public API ─────────────────────────────────────────────────────────────────

/** Build a magnet URI from a hex hash. */
export function hashToMagnet(hash: string): string {
  return `magnet:?xt=urn:btih:${hash}`
}

/** Add a magnet to RD and return its torrent ID. */
export async function addMagnet(magnetOrHash: string): Promise<string> {
  const magnet = magnetOrHash.startsWith('magnet:')
    ? magnetOrHash
    : hashToMagnet(magnetOrHash)
  const r = await rdFetch('POST', '/torrents/addMagnet', { magnet }) as RdAddMagnetResult
  return r.id
}

/** Select files in a torrent. Pass file IDs or 'all'. */
export async function selectFiles(id: string, files: string | number[] = 'all'): Promise<void> {
  const filesStr = Array.isArray(files) ? files.join(',') : files
  await rdFetch('POST', `/torrents/selectFiles/${id}`, { files: filesStr })
}

/** Get torrent info including files and links. */
export async function getTorrentInfo(id: string): Promise<RdTorrentInfo> {
  return rdFetch('GET', `/torrents/info/${id}`) as Promise<RdTorrentInfo>
}

/** Delete a torrent from the RD library. */
export async function deleteTorrent(id: string): Promise<void> {
  await rdFetch('DELETE', `/torrents/delete/${id}`)
}

/** Unrestrict a hoster link to a direct download URL. */
export async function unrestrictLink(link: string): Promise<RdUnrestrictResult> {
  return rdFetch('POST', '/unrestrict/link', { link }) as Promise<RdUnrestrictResult>
}

/**
 * Poll torrent info until status is 'downloaded' (or error).
 * For RD-cached torrents this is typically instant.
 */
// Statuses that mean RD is actively downloading (i.e. not cached)
const NOT_CACHED_STATUSES = new Set(['queued', 'downloading', 'compressing', 'uploading'])

export async function waitDownloaded(
  id: string,
  opts: { pollMs?: number; timeoutMs?: number } = {},
): Promise<RdTorrentInfo> {
  const { pollMs = 500, timeoutMs = 8_000 } = opts
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const info = await getTorrentInfo(id)
    if (info.status === 'downloaded') return info
    if (['error', 'virus', 'dead', 'magnet_error'].includes(info.status)) {
      throw new Error(`RD torrent ${id} entered status: ${info.status}`)
    }
    // Not cached — RD would need to download it from peers, which can take
    // minutes to hours. Fail immediately so we can clean up and tell the user.
    if (NOT_CACHED_STATUSES.has(info.status)) {
      throw new NotCachedError(`Torrent ${id} is not cached on RD (status: ${info.status})`)
    }
    await new Promise(r => setTimeout(r, pollMs))
  }
  throw new Error(`RD torrent ${id} did not finish within ${timeoutMs}ms`)
}

export class NotCachedError extends Error {
  readonly code = 'NOT_CACHED'
  constructor(msg: string) { super(msg) }
}

export class ProviderUnavailableError extends Error {
  readonly code = 'PROVIDER_UNAVAILABLE'
  constructor(msg: string) { super(msg) }
}

// ── High-level helpers ─────────────────────────────────────────────────────────

export interface ResolvedStream {
  url:      string
  filename: string
  bytes:    number
}

interface ResolvedCacheEntry extends ResolvedStream {
  expiresAt: number
}

interface FfprobeJson {
  streams?: Array<{
    codec_type?: string
    tags?: {
      language?: string
      title?: string
    }
  }>
}

const RESOLVED_CACHE_TTL_MS = 3 * 60 * 1000
const resolvedStreamCache = new Map<string, ResolvedCacheEntry>()

function resolveCacheKey(hash: string, filePathHint?: string): string {
  return `${hash}|${(filePathHint || '').toLowerCase()}`
}

function getCachedResolvedStream(hash: string, filePathHint?: string): ResolvedStream | null {
  const key = resolveCacheKey(hash, filePathHint)
  const entry = resolvedStreamCache.get(key)
  if (!entry) return null
  if (Date.now() > entry.expiresAt) {
    resolvedStreamCache.delete(key)
    return null
  }
  return { url: entry.url, filename: entry.filename, bytes: entry.bytes }
}

function cacheResolvedStream(hash: string, filePathHint: string | undefined, value: ResolvedStream): void {
  resolvedStreamCache.set(resolveCacheKey(hash, filePathHint), {
    ...value,
    expiresAt: Date.now() + RESOLVED_CACHE_TTL_MS,
  })
}

/**
 * Given a torrent hash and optional file-path hint, add to RD, unrestrict the
 * best matching file, delete the torrent, and return the direct-download URL.
 *
 * The torrent is deleted from RD after unrestricting so it never accumulates
 * in the user's library.
 */
export async function resolveStream(
  hash: string,
  filePathHint?: string,
): Promise<ResolvedStream> {
  if (!config.rdApiKey) throw new Error('RD_API_KEY not configured')

  const cached = getCachedResolvedStream(hash, filePathHint)
  if (cached) {
    console.log(`rd: cache hit for ${hash.slice(0, 8)}… → ${cached.filename}`)
    return cached
  }

  console.log(`rd: adding magnet ${hash.slice(0, 8)}… to RD library`)
  const torrentId = await addMagnet(hash)
  console.log(`rd: added magnet ${hash.slice(0, 8)}… as torrent ${torrentId}`)

  try {
    // Select all files so RD starts processing immediately; we'll pick later
    await selectFiles(torrentId, 'all')
    const info = await waitDownloaded(torrentId)

    // Choose the link whose file path best matches the hint, or pick largest
    let chosenLink: string
    if (filePathHint && info.files.length > 0) {
      const hint = filePathHint.toLowerCase()
      const selectedFiles = info.files.filter(f => f.selected)
      const scored = selectedFiles
        .map(f => ({ f, score: similarity(f.path.toLowerCase(), hint) }))
        .sort((a, b) => b.score - a.score)
      const bestIdx = scored[0] ? selectedFiles.indexOf(scored[0].f) : 0
      chosenLink = info.links[bestIdx] ?? info.links[0]
    } else {
      // No hint — pick link corresponding to largest file
      const selectedFiles = info.files.filter(f => f.selected)
      const largestIdx = selectedFiles.reduce(
        (bi, f, i) => (f.bytes > (selectedFiles[bi]?.bytes ?? 0) ? i : bi),
        0,
      )
      chosenLink = info.links[largestIdx] ?? info.links[0]
    }

    if (!chosenLink) throw new Error('No links returned by RD after download')

    const unrestricted = await unrestrictLink(chosenLink)
    console.log(`rd: unrestricted torrent ${torrentId} to ${unrestricted.filename}`)
    const resolved = { url: unrestricted.download, filename: unrestricted.filename, bytes: unrestricted.filesize }
    cacheResolvedStream(hash, filePathHint, resolved)
    return resolved
  } finally {
    // Always clean up — fire and forget, but log success/failure so we can
    // verify whether RD library entries are lingering because delete failed.
    void deleteTorrent(torrentId)
      .then(() => console.log(`rd: deleted torrent ${torrentId} from RD library`))
      .catch((err: unknown) => console.warn(`rd: failed to delete torrent ${torrentId}: ${String(err)}`))
  }
}

export async function probeAudioLanguages(url: string): Promise<string[]> {
  const { stdout } = await execFile('ffprobe', [
    '-v', 'error',
    '-probesize', '1048576',
    '-analyzeduration', '0',
    '-show_entries', 'stream=codec_type:stream_tags=language,title',
    '-of', 'json',
    url,
  ], {
    timeout: 4_000,
    maxBuffer: 1024 * 1024,
  })

  const parsed = JSON.parse(stdout || '{}') as FfprobeJson
  const langs = new Set<string>()
  for (const stream of parsed.streams ?? []) {
    if (stream.codec_type !== 'audio') continue
    const language = (stream.tags?.language ?? '').trim().toLowerCase()
    const title = (stream.tags?.title ?? '').trim().toLowerCase()
    if (language) langs.add(language)
    if (title) langs.add(title)
  }
  return [...langs]
}

/** Simple overlap-based similarity for path matching (0–1). */
function similarity(a: string, b: string): number {
  const shorter = a.length < b.length ? a : b
  const longer  = a.length < b.length ? b : a
  if (longer.length === 0) return 1
  if (longer.includes(shorter)) return shorter.length / longer.length
  // Count common tokens
  const tokA = new Set(a.split(/\W+/).filter(Boolean))
  const tokB = new Set(b.split(/\W+/).filter(Boolean))
  let common = 0
  for (const t of tokA) if (tokB.has(t)) common++
  return common / Math.max(tokA.size, tokB.size, 1)
}
