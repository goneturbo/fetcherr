import { config } from './config.js'
import {
  hasPreferredAudioMarker,
  nonPreferredAudioPenalty,
} from './streamLanguage.js'
import { streamMetadataText } from './streamUtils.js'

export interface Stream {
  name:          string
  title:         string
  description?:  string
  url?:          string
  infoHash?:     string
  fileIdx?:      number | string
  sources?:      string[]
  behaviorHints?: Record<string, unknown>
  providerOrder?: number
  providerLabel?: string
}

export type StremioMediaType = 'movie' | 'series'

export interface StremioMeta {
  id: string
  type?: StremioMediaType | string
  name?: string
  title?: string
  poster?: string
  background?: string
  logo?: string
  description?: string
  overview?: string
  genres?: string[]
  genre?: string[]
  releaseInfo?: string | number
  year?: string | number
  imdb_id?: string
  imdbId?: string
  runtime?: string
  released?: string
  videos?: StremioMeta[]
  season?: number
  episode?: number
  number?: number
}

interface StremioCatalog {
  id: string
  type: string
  name?: string
  extra?: Array<{ name?: string; isRequired?: boolean }>
}

interface StremioManifest {
  catalogs?: StremioCatalog[]
}

interface StremioCatalogResponse {
  metas?: StremioMeta[]
}

interface StremioMetaResponse {
  meta?: StremioMeta
}

export interface ProviderFetchMetric {
  time: string
  provider: string
  path: string
  ok: boolean
  durationMs: number
  streams: number
  hashBacked: number
  directUrls: number
  status?: number
  error?: string
}

interface StreamRankContext {
  expectedYear?: number
  alternateYear?: number
  preferredLanguage?: string
  mediaLanguage?: string
  playbackClient?: string
  mediaType?: 'movie' | 'episode'
}

interface RankedStreamScore {
  stream: Stream
  cached: number
  preferredLanguage: number
  mediaLanguage: number
  languagePenalty: number
  unprobeableAudioPenalty: number
  regionalPenalty: number
  junkPenalty: number
  yearScore: number
  years: number[]
  episodeSpecificity: number
  resolution: number
  source: number
  size: number
  sizeQuality: number
  codec: number
  container: number
  clientCompatibilityPenalty: number
}

const PROVIDER_METRICS_MAX = 250
const providerFetchMetrics: ProviderFetchMetric[] = []

function recordProviderFetchMetric(metric: ProviderFetchMetric): void {
  providerFetchMetrics.push(metric)
  if (providerFetchMetrics.length > PROVIDER_METRICS_MAX) providerFetchMetrics.shift()
}

export function getProviderFetchMetrics(): ProviderFetchMetric[] {
  return [...providerFetchMetrics].reverse()
}

function streamText(s: Stream): string {
  return `${s.name ?? ''} ${s.title ?? ''} ${s.description ?? ''} ${s.url ?? ''} ${(s.sources ?? []).join(' ')}`.toLowerCase()
}

function hasUsableUrl(s: Stream): boolean {
  return (typeof s.url === 'string' && s.url.length > 0) || extractHashFromStream(s) !== null
}

function isNotWebReadyDirectStream(s: Stream): boolean {
  return s.behaviorHints?.notWebReady === true
    && typeof s.url === 'string'
    && s.url.length > 0
    && extractHashFromStream(s) === null
}

function cachedScore(s: Stream): number {
  const text = streamText(s)
  if (/\btorbox\s*\(\s*instant\s*\)|\btorbox\s*\(\s*cached\s*\)|\binstant\s*\(\s*tb\s*\)|\[rd\+\]|\[rd ⚡\]|\[rd⚡\]|\brd\+\b|\[tb\+\]|\[tb ⚡\]|\[tb⚡\]|\btb\+\b|\bready\s*\(\s*tb\s*\)|⚡|cached/.test(text)) return 2
  if (/\[rd\]|\[tb\]|\btorbox\b/.test(text)) return 1
  return 0
}

function hasPreferredSignal(s: Stream, preferredLanguage: string): boolean {
  const text = streamMetadataText(s)
  return hasPreferredAudioMarker(text, preferredLanguage)
}

function languagePenalty(s: Stream, preferredLanguage: string): number {
  const text = streamMetadataText(s)
  return nonPreferredAudioPenalty(text, preferredLanguage)
}

function isLikelyUnprobeableRemoteFile(s: Stream): boolean {
  const text = `${streamMetadataText(s)} ${s.url ?? ''}`
  return /\.(mp4|m4v)(?:\b|$)/.test(text)
}

function unprobeableAudioPenalty(s: Stream, preferredLanguage: string): number {
  if (config.englishStreamMode === 'off') return 0
  if (!isLikelyUnprobeableRemoteFile(s)) return 0
  return hasPreferredSignal(s, preferredLanguage) ? 0 : 2
}

function regionalAudioPenalty(s: Stream, preferredLanguage: string): number {
  const text = streamMetadataText(s)
  let penalty = 0
  // Softly demote obvious multi-region audio releases so cleaner preferred-language
  // candidates win first, without filtering these streams out entirely.
  if (/\bnordic\b/.test(text) && !hasPreferredSignal(s, preferredLanguage)) penalty += 2
  return penalty
}

function explicitYearsInStream(s: Stream): number[] {
  const text = streamMetadataText(s)
  const matches = [...text.matchAll(/\b(19\d{2}|20\d{2})\b/g)]
  return [...new Set(matches.map(m => Number.parseInt(m[1], 10)).filter(n => Number.isFinite(n)))]
}

function validYears(ctx: StreamRankContext): number[] {
  return [...new Set([ctx.expectedYear, ctx.alternateYear].filter((year): year is number => typeof year === 'number' && Number.isFinite(year)))]
}

function hasExplicitYearMismatch(s: Stream, ctx: StreamRankContext): boolean {
  const valid = validYears(ctx)
  if (!valid.length) return false
  const years = explicitYearsInStream(s)
  if (!years.length) return false
  return !years.some(year => valid.includes(year))
}

function explicitYearScore(s: Stream, ctx: StreamRankContext): number {
  const years = explicitYearsInStream(s)
  if (!years.length) return 0
  if (ctx.expectedYear && years.includes(ctx.expectedYear)) return 2
  if (ctx.alternateYear && years.includes(ctx.alternateYear)) return 1
  return 0
}

function junkPenalty(s: Stream, ctx: StreamRankContext = {}): number {
  const text = streamMetadataText(s)
  let penalty = 0
  if (/\bcam(?:rip)?\b/.test(text)) penalty += 10
  if (/\btelecine\b|\btc\b/.test(text)) penalty += 8
  if (/\bline[ ._-]*audio\b|\blineaudio\b/.test(text)) penalty += 6

  const hasAiUpscaleMarkers = /\bai[ ._-]*upscale(?:d)?\b|\bupscale(?:d)?\b|\btopaz\b|\brealesrgan\b|\benhance(?:d)?\b/.test(text)
  if (hasAiUpscaleMarkers) {
    penalty += 6
    if (/\bs\d{2}e\d{2}\b/.test(text)) penalty += 6
  }

  if (ctx.mediaType === 'movie') {
    const size = sizeBytes(s)
    const gb = size / 1e9
    const is1080p = resolutionScore(s) === 3
    if (/\byify\b|\byts\b/.test(text)) penalty += 3
    if (is1080p && gb > 0 && gb < 2) penalty += 2
  }

  return penalty
}

function episodeSpecificityScore(s: Stream): number {
  const text = streamMetadataText(s)
  const filename = typeof s.behaviorHints?.filename === 'string'
    ? s.behaviorHints.filename.toLowerCase()
    : ''
  const filenameHasEpisode = /\bs\d{2}e\d{2}\b/.test(filename)
  let score = 0
  if (/\bs\d{2}e\d{2}\b/.test(text)) score += 4
  if (/\bs\d{2}e\d{2}[a-z]\b/.test(text)) score -= 2
  if (/\bs\d{2}e\d{2}\s*-\s*(?:e)?\d{2}\b|\be\d{2}\s*-\s*e\d{2}\b/.test(text)) score -= 4
  if (/\bextended[ ._-]*cinematic[ ._-]*format\b|\bcinematic[ ._-]*format\b|\bfan[ ._-]*edit\b/.test(text)) score -= 2
  if (!filenameHasEpisode && /\[s\d{2}-s\d{2}\]|\bseasons?\b|\bcomplete\b|\bcollection\b/.test(text)) score -= 4
  if (/\bs\d{2}\b/.test(text) && !/\bs\d{2}e\d{2}\b/.test(text)) score -= 1
  return score
}

function precomputeScore(s: Stream, ctx: StreamRankContext = {}): RankedStreamScore {
  const preferredLanguage = ctx.preferredLanguage ?? config.preferredAudioLanguage
  const mediaLanguage = ctx.mediaLanguage ?? ''
  return {
    stream: s,
    cached: cachedScore(s),
    preferredLanguage: hasPreferredSignal(s, preferredLanguage) ? 1 : 0,
    mediaLanguage: mediaLanguage && hasPreferredSignal(s, mediaLanguage) ? 1 : 0,
    languagePenalty: languagePenalty(s, preferredLanguage),
    unprobeableAudioPenalty: unprobeableAudioPenalty(s, preferredLanguage),
    regionalPenalty: regionalAudioPenalty(s, preferredLanguage),
    junkPenalty: junkPenalty(s, ctx),
    yearScore: explicitYearScore(s, ctx),
    years: explicitYearsInStream(s),
    episodeSpecificity: episodeSpecificityScore(s),
    resolution: resolutionScore(s),
    source: sourceScore(s),
    size: sizeBytes(s),
    sizeQuality: sizeQualityScore(s),
    codec: codecScore(s),
    container: containerScore(s),
    clientCompatibilityPenalty: clientCompatibilityPenalty(s, ctx.playbackClient),
  }
}

function scoreSummary(score: RankedStreamScore): string {
  const s = score.stream
  const filename = typeof s.behaviorHints?.filename === 'string' ? s.behaviorHints.filename : ''
  return [
    `cached=${score.cached}`,
    `preferredLanguage=${score.preferredLanguage}`,
    `mediaLanguage=${score.mediaLanguage}`,
    `languagePenalty=${score.languagePenalty}`,
    `unprobeableAudioPenalty=${score.unprobeableAudioPenalty}`,
    `regionalPenalty=${score.regionalPenalty}`,
    `junkPenalty=${score.junkPenalty}`,
    `yearScore=${score.yearScore}`,
    `years=${JSON.stringify(score.years)}`,
    `episodeSpecificity=${score.episodeSpecificity}`,
    `resolution=${score.resolution}`,
    `source=${score.source}`,
    `size=${score.size}`,
    `sizeQuality=${score.sizeQuality}`,
    `codec=${score.codec}`,
    `container=${score.container}`,
    `clientCompatibilityPenalty=${score.clientCompatibilityPenalty}`,
    `providerOrder=${s.providerOrder ?? 999}`,
    `provider=${JSON.stringify(s.providerLabel ?? '')}`,
    `name=${JSON.stringify(s.name ?? '')}`,
    `title=${JSON.stringify(s.title ?? '')}`,
    `filename=${JSON.stringify(filename)}`,
  ].join(' ')
}

function isLikelyBadStream(s: Stream): boolean {
  const text = streamText(s)
  return /\bsample\b|\btrailer\b|\bextras?\b|\bfeaturette\b|\bbehind[ .-]?the[ .-]?scenes\b/.test(text)
}

function sizeBytes(s: Stream): number {
  // AIOStreams provides exact byte count in behaviorHints.videoSize
  if (typeof s.behaviorHints?.videoSize === 'number') return s.behaviorHints.videoSize as number
  // Fallback: parse from description text
  const m = `${s.name} ${s.title}`.match(/(\d+(?:\.\d+)?)\s*(TB|GB|MB|KB)/i)
  if (!m) return 0
  const val = parseFloat(m[1])
  switch (m[2].toUpperCase()) {
    case 'TB': return val * 1e12
    case 'GB': return val * 1e9
    case 'MB': return val * 1e6
    case 'KB': return val * 1e3
    default:   return 0
  }
}

function sizeQualityScore(s: Stream): number {
  const size = sizeBytes(s)
  if (size <= 0) return 0

  const gb = size / 1e9
  const resolution = resolutionScore(s)
  const text = streamMetadataText(s)
  const episode = /\bs\d{2}e\d{2}\b/.test(text)

  if (episode) {
    if (resolution >= 4) {
      if (gb >= 4 && gb <= 14) return 5
      if (gb >= 2 && gb < 4) return 4
      if (gb > 14 && gb <= 24) return 4
      if (gb > 24) return 3
      return 2
    }
    if (resolution >= 3) {
      if (gb >= 1.5 && gb <= 8) return 5
      if (gb >= 0.8 && gb < 1.5) return 4
      if (gb > 8 && gb <= 16) return 4
      if (gb > 16) return 3
      return 2
    }
    if (resolution >= 2) {
      if (gb >= 0.5 && gb <= 3) return 5
      if (gb > 3 && gb <= 6) return 4
      if (gb > 6) return 3
      return 2
    }
    return gb >= 0.2 ? 3 : 1
  }

  if (resolution >= 4) {
    if (gb >= 18 && gb <= 60) return 5
    if (gb >= 10 && gb < 18) return 4
    if (gb > 60 && gb <= 90) return 4
    if (gb > 90) return 3
    return 2
  }
  if (resolution >= 3) {
    if (gb >= 6 && gb <= 25) return 5
    if (gb >= 3 && gb < 6) return 4
    if (gb > 25 && gb <= 45) return 4
    if (gb > 45) return 3
    return 2
  }
  if (resolution >= 2) {
    if (gb >= 1.5 && gb <= 8) return 5
    if (gb > 8 && gb <= 15) return 4
    if (gb > 15) return 3
    return 2
  }
  return gb >= 0.7 ? 3 : 1
}

function resolutionScore(s: Stream): number {
  const text = streamMetadataText(s)
  if (/\b(2160p|4k|uhd)\b/.test(text)) return 4
  if (/\b1080p\b/.test(text)) return 3
  if (/\b720p\b/.test(text)) return 2
  if (/\b480p\b/.test(text)) return 1
  return 2
}

function sourceScore(s: Stream): number {
  const text = streamMetadataText(s)
  if (/\bremux\b/.test(text)) return 5
  if (/\bblu[ -]?ray\b|\bbdrip\b/.test(text)) return 4
  if (/\bweb[ ._-]?dl\b/.test(text)) return 3
  if (/\bweb[ ._-]?rip\b/.test(text)) return 2
  if (/\bhdtv\b/.test(text)) return 1
  return 2
}

// Codec quality score — higher is better. Playback compatibility is handled
// later by resolving and probing the selected candidate before returning it.
function codecScore(s: Stream): number {
  const text = streamText(s)
  if (/\bav1\b/.test(text))                      return 4
  if (/\bhevc\b|h\.?265\b|x265\b/.test(text))   return 3
  if (/\bh\.?264\b|x264\b|avc\b/.test(text))    return 2
  if (/\bxvid\b|\bdivx\b/.test(text))            return 0
  return 1
}

function containerScore(s: Stream): number {
  const text = streamText(s)
  if (/\.(mkv|mp4|m4v)(?:\b|$)/.test(text)) return 3
  if (/\.(avi|mov|wmv|webm)(?:\b|$)/.test(text)) return 2
  if (/\.(ts|m2ts)(?:\b|$)/.test(text)) return 0
  return 1
}

function clientCompatibilityPenalty(s: Stream, clientName = ''): number {
  const client = clientName.toLowerCase()
  if (!client.includes('swiftfin')) return 0

  const text = streamMetadataText(s).toLowerCase()
  let penalty = 0
  if (/\b(dolby vision|dv)\b/.test(text)) penalty += 6
  if (/\bhdr10\+\b|\bhdr\b/.test(text)) penalty += 4
  if (/\btruehd\b|\batmos\b|\bdts[- ]hd\b|\bdtsx\b/.test(text)) penalty += 5
  if (/\bremux\b/.test(text)) penalty += 3
  if (/\b2160p\b|\b4k\b|\bufhd\b/.test(text)) penalty += 3
  if (/\bhevc\b|h\.?265\b|x265\b/.test(text)) penalty += 2
  return penalty
}

function playableStreamsInProviderOrder(streams: Stream[], ctx: StreamRankContext = {}): Stream[] {
  const usable = streams.filter(hasUsableUrl).filter(s => !isNotWebReadyDirectStream(s))
  const preferred = usable.filter(s => !isLikelyBadStream(s))
  const basePool = preferred.length ? preferred : usable
  return validYears(ctx).length
    ? basePool.filter(s => !hasExplicitYearMismatch(s, ctx))
    : basePool
}

function rankStreamScores(streams: Stream[], ctx: StreamRankContext = {}): RankedStreamScore[] {
  const pool = playableStreamsInProviderOrder(streams, ctx)
  const scores = pool.map(stream => precomputeScore(stream, ctx))

  if (config.streamRankingMode === 'provider') {
    return scores
  }

  return scores.sort((a, b) =>
    b.cached - a.cached
    || a.languagePenalty - b.languagePenalty
    || a.unprobeableAudioPenalty - b.unprobeableAudioPenalty
    || a.regionalPenalty - b.regionalPenalty
    || a.junkPenalty - b.junkPenalty
    || b.yearScore - a.yearScore
    || b.episodeSpecificity - a.episodeSpecificity
    || b.resolution - a.resolution
    || b.source - a.source
    || b.sizeQuality - a.sizeQuality
    || b.codec - a.codec
    || a.clientCompatibilityPenalty - b.clientCompatibilityPenalty
    || (config.englishStreamMode === 'off' ? 0 : b.preferredLanguage - a.preferredLanguage)
    || b.mediaLanguage - a.mediaLanguage
    || b.container - a.container
    || b.size - a.size
    || ((a.stream.providerOrder ?? 999) - (b.stream.providerOrder ?? 999))
  )
}

function providerBases(): string[] {
  const urls = [...config.streamProviderUrls]
  if (config.sootioUrl) urls.push(config.sootioUrl)
  return [...new Set(urls)]
}

function searchProviderBases(): string[] {
  const urls = [...config.stremioSearchProviderUrls]
  if (!urls.length) urls.push(...providerBases())
  return [...new Set(urls)]
}

function isSensitivePathSegment(segment: string): boolean {
  return segment.length >= 16
    || /^[0-9a-f]{12,}$/i.test(segment)
    || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment)
}

function providerLabel(base: string, idx: number): string {
  try {
    const parsed = new URL(base)
    const path = parsed.pathname
      .split('/')
      .filter(Boolean)
      .filter(segment => segment.toLowerCase() !== 'manifest.json')
      .map(segment => isSensitivePathSegment(segment) ? ':redacted' : segment)
      .join('/')
    return `provider#${idx + 1} ${parsed.hostname}${path ? `/${path}` : ''}`.slice(0, 180)
  } catch {
    return `provider#${idx + 1} ${base.replace(/[A-Za-z0-9_-]{16,}/g, ':redacted').slice(0, 160)}`
  }
}

async function fetchStreams(url: string): Promise<{ streams: Stream[]; status: number }> {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) })
  if (!res.ok) throw new Error(`Stremio add-on returned ${res.status}`)
  const json = await res.json() as { streams?: Stream[] }
  return { streams: json.streams ?? [], status: res.status }
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) })
  if (!res.ok) throw new Error(`Stremio add-on returned ${res.status}`)
  return await res.json() as T
}

const manifestCache = new Map<string, { expiresAt: number; value: StremioManifest | null }>()
const MANIFEST_CACHE_TTL_MS = 5 * 60 * 1000

async function fetchManifest(base: string): Promise<StremioManifest | null> {
  const cached = manifestCache.get(base)
  if (cached && cached.expiresAt > Date.now()) return cached.value

  try {
    const value = await fetchJson<StremioManifest>(`${base}/manifest.json`)
    manifestCache.set(base, { value, expiresAt: Date.now() + MANIFEST_CACHE_TTL_MS })
    return value
  } catch {
    manifestCache.set(base, { value: null, expiresAt: Date.now() + MANIFEST_CACHE_TTL_MS })
    return null
  }
}

function searchCatalog(manifest: StremioManifest | null, type: StremioMediaType): StremioCatalog | null {
  const catalogs = manifest?.catalogs ?? []
  return catalogs
    .filter(catalog => catalog.type?.toLowerCase() === type)
    .filter(catalog => catalog.extra?.some(extra => extra.name?.toLowerCase() === 'search'))
    .sort((a, b) => Number(a.id.toLowerCase().includes('people')) - Number(b.id.toLowerCase().includes('people')))
    [0] ?? null
}

async function fetchSearchMetasFromProvider(base: string, type: StremioMediaType, query: string): Promise<StremioMeta[]> {
  const manifest = await fetchManifest(base)
  const catalog = searchCatalog(manifest, type)
  if (!catalog) return []

  const url = `${base}/catalog/${type}/${encodeURIComponent(catalog.id)}/search=${encodeURIComponent(query)}.json`
  const json = await fetchJson<StremioCatalogResponse>(url)
  return (json.metas ?? []).map(meta => ({ ...meta, type: meta.type ?? type }))
}

async function fetchMetaFromProvider(base: string, type: StremioMediaType, id: string): Promise<StremioMeta | null> {
  const url = `${base}/meta/${type}/${encodeURIComponent(id)}.json`
  const json = await fetchJson<StremioMetaResponse>(url)
  return json.meta ? { ...json.meta, type: json.meta.type ?? type } : null
}

export async function searchStremioMetas(query: string, types: StremioMediaType[]): Promise<StremioMeta[]> {
  const providers = searchProviderBases()
  if (!providers.length || !query.trim()) return []

  const settled = await Promise.allSettled(
    providers.flatMap((base, providerIdx) =>
      types.map(async type => {
        const metas = await fetchSearchMetasFromProvider(base, type, query)
        return metas.map(meta => ({ meta, providerIdx }))
      }),
    ),
  )

  const deduped = new Map<string, StremioMeta>()
  for (const result of settled) {
    if (result.status !== 'fulfilled') continue
    for (const { meta, providerIdx } of result.value) {
      const key = `${String(meta.type ?? '').toLowerCase()}|${meta.id || meta.imdb_id || meta.imdbId}|${meta.name || meta.title}|${providerIdx}`
      if (!deduped.has(key)) deduped.set(key, meta)
    }
  }
  return [...deduped.values()]
}

export async function fetchStremioMeta(type: StremioMediaType, id: string): Promise<StremioMeta | null> {
  const providers = searchProviderBases()
  if (!providers.length || !id.trim()) return null

  const settled = await Promise.allSettled(
    providers.map(base => fetchMetaFromProvider(base, type, id)),
  )

  for (const result of settled) {
    if (result.status === 'fulfilled' && result.value) return result.value
  }
  return null
}

export function summarizeStreamForLog(s: Stream): string {
  const hash = extractHashFromStream(s)
  const urlKind = s.url
    ? s.url.startsWith('magnet:')
      ? 'magnet'
      : (() => {
          try {
            const parsed = new URL(s.url)
            return `${parsed.protocol.replace(':', '')}:${parsed.hostname}`
          } catch {
            return 'url'
          }
        })()
    : 'none'
  const filename = typeof s.behaviorHints?.filename === 'string' ? s.behaviorHints.filename : ''
  const behaviorKeys = s.behaviorHints ? Object.keys(s.behaviorHints).sort() : []
  return [
    `provider=${JSON.stringify(s.providerLabel ?? '')}`,
    `hash=${hash ? `${hash.slice(0, 8)}…` : 'none'}`,
    `url=${urlKind}`,
    `infoHash=${typeof s.infoHash === 'string' ? 'yes' : 'no'}`,
    `sources=${s.sources?.length ?? 0}`,
    `fileIdx=${JSON.stringify(s.fileIdx ?? '')}`,
    `name=${JSON.stringify(s.name ?? '')}`,
    `title=${JSON.stringify(s.title ?? '')}`,
    `filename=${JSON.stringify(filename)}`,
    `behaviorHints=${JSON.stringify(behaviorKeys)}`,
  ].join(' ')
}

async function fetchStreamsFromProviders(path: string): Promise<Stream[]> {
  const providers = providerBases()
  if (!providers.length) throw new Error('No stream provider URL configured')

  const settled = await Promise.allSettled(
    providers.map(async (base, idx) => {
      const url = `${base}${path}`
      const label = providerLabel(base, idx)
      const startedAt = Date.now()
      const { streams, status } = await fetchStreams(url)
      const durationMs = Date.now() - startedAt
      const hashBacked = streams.filter(s => extractHashFromStream(s)).length
      const directUrls = streams.filter(s => !extractHashFromStream(s) && typeof s.url === 'string' && s.url.length > 0).length
      recordProviderFetchMetric({
        time: new Date().toISOString(),
        provider: label,
        path,
        ok: true,
        durationMs,
        streams: streams.length,
        hashBacked,
        directUrls,
        status,
      })
      console.log(
        `streams: ${label} returned ${streams.length} stream${streams.length === 1 ? '' : 's'} ` +
        `for ${path} in ${durationMs}ms (${hashBacked} hash-backed, ${directUrls} direct-url, ${streams.length - hashBacked - directUrls} metadata-only)`
      )
      for (const stream of streams.slice(0, 3)) {
        console.log(`streams: ${label} sample ${summarizeStreamForLog({ ...stream, providerOrder: idx, providerLabel: label })}`)
      }
      return streams.map(s => ({
        ...s,
        title: s.title || s.description || '',
        name: s.name || '',
        providerOrder: idx,
        providerLabel: label,
      }))
    }),
  )

  const merged: Stream[] = []
  const errors: string[] = []
  for (const [idx, result] of settled.entries()) {
    if (result.status === 'fulfilled') {
      merged.push(...result.value)
    } else {
      const label = providerLabel(providers[idx], idx)
      const error = result.reason instanceof Error ? result.reason.message : String(result.reason)
      recordProviderFetchMetric({
        time: new Date().toISOString(),
        provider: label,
        path,
        ok: false,
        durationMs: 0,
        streams: 0,
        hashBacked: 0,
        directUrls: 0,
        error,
      })
      errors.push(`${providers[idx]}: ${String(result.reason)}`)
    }
  }

  const deduped = new Map<string, Stream>()
  for (const stream of merged) {
    const filename = typeof stream.behaviorHints?.filename === 'string' ? stream.behaviorHints.filename : ''
    const key = `${extractHashFromStream(stream) ?? stream.url ?? ''}|${stream.fileIdx ?? ''}|${stream.name}|${stream.title}|${filename}`
    if (!deduped.has(key)) deduped.set(key, stream)
  }

  if (!deduped.size) {
    throw new Error(errors.length ? errors.join(' | ') : 'No streams found')
  }

  return [...deduped.values()]
}

/**
 * Fetch all streams for a movie, ranked by cacheability, language safety,
 * quality signals, and compatibility. The caller picks the best candidate.
 */
export async function fetchRankedStreams(
  imdbId: string,
  preferredLanguage = config.preferredAudioLanguage,
  mediaLanguage = '',
  playbackClient = '',
  preserveProviderOrder = false,
): Promise<Stream[]> {
  const streams = await fetchStreamsFromProviders(`/stream/movie/${imdbId}.json`)
  if (!streams.length) throw new Error(`No streams found for ${imdbId}`)
  const notWebReadyDirectStreams = streams.filter(isNotWebReadyDirectStream).length
  if (notWebReadyDirectStreams) {
    console.log(`streams: ignored ${notWebReadyDirectStreams} notWebReady direct stream${notWebReadyDirectStreams === 1 ? '' : 's'} for ${imdbId}`)
  }
  const ctx = { preferredLanguage, mediaLanguage, playbackClient, mediaType: 'movie' as const }
  const summaries = preserveProviderOrder
    ? playableStreamsInProviderOrder(streams, ctx).map(stream => precomputeScore(stream, ctx))
    : rankStreamScores(streams, ctx)
  const ranked = summaries.map(score => score.stream)
  console.log(`streams: top candidates for ${imdbId}`)
  for (const score of summaries.slice(0, 5)) {
    console.log(`streams: ${scoreSummary(score)} :: ${score.stream.title || score.stream.name}`)
  }
  return ranked
}

export async function fetchRankedStremioStreams(
  mediaType: StremioMediaType,
  externalId: string,
  expectedYear?: number,
  preferredLanguage = config.preferredAudioLanguage,
  mediaLanguage = '',
  playbackClient = '',
  preserveProviderOrder = false,
): Promise<Stream[]> {
  const streams = await fetchStreamsFromProviders(`/stream/${mediaType}/${encodeURIComponent(externalId)}.json`)
  if (!streams.length) throw new Error(`No streams found for ${mediaType} ${externalId}`)
  const notWebReadyDirectStreams = streams.filter(isNotWebReadyDirectStream).length
  if (notWebReadyDirectStreams) {
    console.log(`streams: ignored ${notWebReadyDirectStreams} notWebReady direct stream${notWebReadyDirectStreams === 1 ? '' : 's'} for ${mediaType} ${externalId}`)
  }
  const ctx = { expectedYear, preferredLanguage, mediaLanguage, playbackClient, mediaType: mediaType === 'series' ? 'episode' as const : 'movie' as const }
  const summaries = preserveProviderOrder
    ? playableStreamsInProviderOrder(streams, ctx).map(stream => precomputeScore(stream, ctx))
    : rankStreamScores(streams, ctx)
  const ranked = summaries.map(score => score.stream)
  if (!ranked.length) throw new Error(`No ranked streams found for ${mediaType} ${externalId}`)
  console.log(`streams: top Stremio candidates for ${mediaType} ${externalId}`)
  for (const score of summaries.slice(0, 5)) {
    console.log(`streams: ${scoreSummary(score)} :: ${score.stream.title || score.stream.name}`)
  }
  return ranked
}

/**
 * Fetch all streams for a TV episode, ranked by cacheability, language safety,
 * year matching, quality signals, and compatibility.
 * AIOStreams series endpoint: /stream/series/{imdbId}:{season}:{episode}.json
 */
export async function fetchRankedEpisodeStreams(
  imdbId: string,
  season: number,
  episode: number,
  expectedYear?: number,
  alternateYear?: number,
  preferredLanguage = config.preferredAudioLanguage,
  mediaLanguage = '',
  playbackClient = '',
  preserveProviderOrder = false,
): Promise<Stream[]> {
  const streams = await fetchStreamsFromProviders(`/stream/series/${imdbId}:${season}:${episode}.json`)
  if (!streams.length) throw new Error(`No streams found for ${imdbId} S${season}E${episode}`)
  const notWebReadyDirectStreams = streams.filter(isNotWebReadyDirectStream).length
  if (notWebReadyDirectStreams) {
    console.log(`streams: ignored ${notWebReadyDirectStreams} notWebReady direct stream${notWebReadyDirectStreams === 1 ? '' : 's'} for ${imdbId} S${season}E${episode}`)
  }
  const ctx = { expectedYear, alternateYear, preferredLanguage, mediaLanguage, playbackClient, mediaType: 'episode' as const }
  const summaries = preserveProviderOrder
    ? playableStreamsInProviderOrder(streams, ctx).map(stream => precomputeScore(stream, ctx))
    : rankStreamScores(streams, ctx)
  const ranked = summaries.map(score => score.stream)
  if (!ranked.length) throw new Error(`No year-matched streams found for ${imdbId} S${season}E${episode}`)
  console.log(`streams: top candidates for ${imdbId} S${season}E${episode}`)
  for (const score of summaries.slice(0, 5)) {
    console.log(`streams: ${scoreSummary(score)} :: ${score.stream.title || score.stream.name}`)
  }
  return ranked
}

/**
 * Attempt to extract a torrent hash from a resolver URL.
 * Handles Torrentio-style: /resolve/realdebrid/{apiKey}/{hash}/{fileIdx}/...
 * Returns null if the URL doesn't match a known pattern.
 */
export function extractHashFromStreamUrl(url?: string): string | null {
  if (!url) return null
  if (url.startsWith('magnet:')) return normalizeInfoHash(url)
  try {
    const parsed = new URL(url)
    const segments = parsed.pathname.split('/').filter(Boolean)
    const resolveIndex = segments.findIndex(segment => segment.toLowerCase() === 'resolve')
    if (resolveIndex >= 0) {
      for (const segment of segments.slice(resolveIndex + 1)) {
        const hash = normalizeInfoHash(decodeURIComponent(segment))
        if (hash) return hash
      }
    }

    for (const keyword of ['playback', 'play']) {
      const kwIndex = segments.findIndex(segment => segment.toLowerCase() === keyword)
      if (kwIndex >= 0) {
        for (const segment of segments.slice(kwIndex + 1)) {
          const hash = normalizeInfoHash(decodeURIComponent(segment))
          if (hash) return hash
        }
      }
    }

    for (let i = 0; i < segments.length - 1; i += 1) {
      const provider = segments[i].toLowerCase()
      if (provider !== 'tb' && provider !== 'torbox' && provider !== 'rd' && provider !== 'realdebrid') continue
      const hash = normalizeInfoHash(decodeURIComponent(segments[i + 1]))
      if (hash) return hash
    }

    // AIOStreams proxy URLs embed the hash in a base64-encoded JSON segment:
    // /api/v1/debrid/playback/{auth}/{base64-json}/{64hex}/{filename}
    // where base64-json decodes to {"hash":"<40-hex-infohash>", ...}
    for (const segment of segments) {
      try {
        const decoded = JSON.parse(Buffer.from(decodeURIComponent(segment), 'base64').toString('utf-8')) as unknown
        if (decoded !== null && typeof decoded === 'object' && 'hash' in decoded) {
          const hash = normalizeInfoHash((decoded as Record<string, unknown>).hash)
          if (hash) return hash
        }
      } catch {
        // not base64-JSON, skip
      }
    }

    // Last resort: scan every segment for a bare 40-hex infohash.
    // Handles proxying addons (e.g. Debridio) that embed the hash as an unkeyed
    // path segment without a preceding keyword. Debrid API keys are rarely 40 hex
    // chars, so false positives are unlikely; failures fall through to the next stream.
    for (const segment of segments) {
      const hash = normalizeInfoHash(decodeURIComponent(segment))
      if (hash) return hash
    }
    return null
  } catch {
    return null
  }
}

function normalizeInfoHash(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const match = value.match(/(?:^|[^0-9a-f])([0-9a-f]{40})(?:[^0-9a-f]|$)/i)
  return match ? match[1].toLowerCase() : null
}

export function extractHashFromStream(stream: Pick<Stream, 'url' | 'infoHash' | 'sources' | 'behaviorHints'>): string | null {
  const bingeGroup = stream.behaviorHints?.bingeGroup
  return extractHashFromStreamUrl(stream.url)
    ?? normalizeInfoHash(stream.infoHash)
    ?? (typeof bingeGroup === 'string' ? normalizeInfoHash(bingeGroup) : null)
    ?? (stream.sources ?? []).reduce<string | null>(
      (hash, source) => hash ?? normalizeInfoHash(source),
      null,
    )
}
