import { config } from './config.js'

export interface Stream {
  name:          string
  title:         string
  description?:  string
  url?:          string
  behaviorHints?: Record<string, unknown>
  providerOrder?: number
}

interface StreamRankContext {
  expectedYear?: number
}

interface RankedStreamScore {
  stream: Stream
  cached: number
  english: number
  nonEnglishPenalty: number
  regionalPenalty: number
  junkPenalty: number
  yearScore: number
  years: number[]
  episodeSpecificity: number
  resolution: number
  source: number
  size: number
  codec: number
  container: number
}

function streamText(s: Stream): string {
  return `${s.name ?? ''} ${s.title ?? ''} ${s.url ?? ''}`.toLowerCase()
}

function streamMetadataText(s: Stream): string {
  const filename = typeof s.behaviorHints?.filename === 'string' ? s.behaviorHints.filename : ''
  return `${s.name ?? ''} ${s.title ?? ''} ${filename}`.toLowerCase()
}

function hasUsableUrl(s: Stream): boolean {
  return typeof s.url === 'string' && s.url.length > 0
}

function cachedScore(s: Stream): number {
  const text = streamText(s)
  if (/\[rd\+\]|\[rd ⚡\]|\[rd⚡\]|\brd\+\b|⚡|cached/.test(text)) return 2
  if (/\[rd\]/.test(text)) return 1
  return 0
}

function hasEnglishSignal(s: Stream): boolean {
  const text = streamMetadataText(s)
  return /\boriginal\s*\(?eng(?:lish)?\)?\b|\boriginal audio\b.*\beng(?:lish)?\b|\benglish\b|\baudio[: ._-]*eng(?:lish)?\b/.test(text)
}

function nonEnglishPenalty(s: Stream): number {
  const text = streamMetadataText(s)
  let penalty = 0
  if (/\bdubbing\s*pl\b|\bpolish\b|\bpolski\b|\blektor\b|🇵🇱/.test(text)) penalty += 4
  if (/\btruefrench\b|\bfrench\b|🇫🇷/.test(text)) penalty += 4
  if (/\brus\b|\brussian\b|🇷🇺/.test(text)) penalty += 2
  if (/\bukr\b|\bukrainian\b|🇺🇦/.test(text)) penalty += 2
  if (/\bita\b|\bitalian\b|🇮🇹/.test(text)) penalty += 2
  if (/\besp\b|\bspanish\b|🇪🇸/.test(text)) penalty += 2
  return penalty
}

function regionalAudioPenalty(s: Stream): number {
  const text = streamMetadataText(s)
  let penalty = 0
  // Softly demote obvious multi-region audio releases so cleaner English-first
  // candidates win first, without filtering these streams out entirely.
  if (/\bnordic\b/.test(text) && !hasEnglishSignal(s)) penalty += 2
  return penalty
}

function explicitYearsInStream(s: Stream): number[] {
  const text = streamMetadataText(s)
  const matches = [...text.matchAll(/\b(19\d{2}|20\d{2})\b/g)]
  return [...new Set(matches.map(m => Number.parseInt(m[1], 10)).filter(n => Number.isFinite(n)))]
}

function hasExplicitYearMismatch(s: Stream, expectedYear?: number): boolean {
  if (!expectedYear) return false
  const years = explicitYearsInStream(s)
  if (!years.length) return false
  return !years.includes(expectedYear)
}

function explicitYearScore(s: Stream, expectedYear?: number): number {
  if (!expectedYear) return 0
  const years = explicitYearsInStream(s)
  if (!years.length) return 0
  return years.includes(expectedYear) ? 2 : 0
}

function junkPenalty(s: Stream): number {
  const text = streamMetadataText(s)
  let penalty = 0
  if (/\bcam(?:rip)?\b/.test(text)) penalty += 10
  if (/\btelecine\b|\btc\b/.test(text)) penalty += 8
  if (/\bline[ ._-]*audio\b|\blineaudio\b/.test(text)) penalty += 6
  if (/\bai[ ._-]*upscale\b|\bupscale\b/.test(text)) penalty += 4
  return penalty
}

function episodeSpecificityScore(s: Stream): number {
  const text = streamMetadataText(s)
  let score = 0
  if (/\bs\d{2}e\d{2}\b/.test(text)) score += 4
  if (/\bs\d{2}e\d{2}[a-z]\b/.test(text)) score -= 2
  if (/\[s\d{2}-s\d{2}\]|\bseasons?\b|\bcomplete\b|\bcollection\b/.test(text)) score -= 4
  if (/\bs\d{2}\b/.test(text) && !/\bs\d{2}e\d{2}\b/.test(text)) score -= 1
  return score
}

function precomputeScore(s: Stream, ctx: StreamRankContext = {}): RankedStreamScore {
  return {
    stream: s,
    cached: cachedScore(s),
    english: hasEnglishSignal(s) ? 1 : 0,
    nonEnglishPenalty: nonEnglishPenalty(s),
    regionalPenalty: regionalAudioPenalty(s),
    junkPenalty: junkPenalty(s),
    yearScore: explicitYearScore(s, ctx.expectedYear),
    years: explicitYearsInStream(s),
    episodeSpecificity: episodeSpecificityScore(s),
    resolution: resolutionScore(s),
    source: sourceScore(s),
    size: sizeBytes(s),
    codec: codecScore(s),
    container: containerScore(s),
  }
}

function scoreSummary(score: RankedStreamScore): string {
  const s = score.stream
  const filename = typeof s.behaviorHints?.filename === 'string' ? s.behaviorHints.filename : ''
  return [
    `cached=${score.cached}`,
    `english=${score.english}`,
    `nonEnglishPenalty=${score.nonEnglishPenalty}`,
    `regionalPenalty=${score.regionalPenalty}`,
    `junkPenalty=${score.junkPenalty}`,
    `yearScore=${score.yearScore}`,
    `years=${JSON.stringify(score.years)}`,
    `episodeSpecificity=${score.episodeSpecificity}`,
    `resolution=${score.resolution}`,
    `source=${score.source}`,
    `size=${score.size}`,
    `codec=${score.codec}`,
    `container=${score.container}`,
    `providerOrder=${s.providerOrder ?? 999}`,
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

// Codec compatibility score for Infuse — higher is better.
// H.264 remains safest, but Infuse handles HEVC well enough that codec
// should be a late tiebreaker rather than a primary quality signal.
function codecScore(s: Stream): number {
  const text = streamText(s)
  if (/\bav1\b/.test(text))                      return 0
  if (/\bhevc\b|h\.?265\b|x265\b/.test(text))   return 2
  if (/\bh\.?264\b|x264\b|avc\b/.test(text))    return 3
  return 1 // unknown — below identified codecs, above AV1
}

function containerScore(s: Stream): number {
  const text = streamText(s)
  if (/\.(mkv|mp4|m4v)(?:\b|$)/.test(text)) return 3
  if (/\.(avi|mov|wmv|webm)(?:\b|$)/.test(text)) return 2
  if (/\.(ts|m2ts)(?:\b|$)/.test(text)) return 0
  return 1
}

function rankStreams(streams: Stream[], ctx: StreamRankContext = {}): Stream[] {
  const usable = streams.filter(hasUsableUrl)
  const preferred = usable.filter(s => !isLikelyBadStream(s))
  const basePool = preferred.length ? preferred : usable
  const pool = ctx.expectedYear
    ? basePool.filter(s => !hasExplicitYearMismatch(s, ctx.expectedYear))
    : basePool

  return pool
    .map(stream => precomputeScore(stream, ctx))
    .sort((a, b) =>
      b.cached - a.cached
      || a.nonEnglishPenalty - b.nonEnglishPenalty
      || a.regionalPenalty - b.regionalPenalty
      || a.junkPenalty - b.junkPenalty
      || b.yearScore - a.yearScore
      || b.episodeSpecificity - a.episodeSpecificity
      || (config.englishStreamMode === 'off' ? 0 : b.english - a.english)
      || b.resolution - a.resolution
      || b.source - a.source
      || b.size - a.size
      || b.codec - a.codec
      || b.container - a.container
      || ((a.stream.providerOrder ?? 999) - (b.stream.providerOrder ?? 999))
    )
    .map(score => score.stream)
}

function providerBases(): string[] {
  const urls = [...config.streamProviderUrls]
  if (config.sootioUrl) urls.push(config.sootioUrl)
  return [...new Set(urls)]
}

async function fetchStreams(url: string): Promise<Stream[]> {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) })
  if (!res.ok) throw new Error(`AIOStreams returned ${res.status}`)
  const json = await res.json() as { streams?: Stream[] }
  return json.streams ?? []
}

async function fetchStreamsFromProviders(path: string): Promise<Stream[]> {
  const providers = providerBases()
  if (!providers.length) throw new Error('No stream provider URL configured')

  const settled = await Promise.allSettled(
    providers.map(async (base, idx) => {
      const url = `${base}${path}`
      const streams = await fetchStreams(url)
      return streams.map(s => ({
        ...s,
        title: s.title || s.description || '',
        name: s.name || '',
        providerOrder: idx,
      }))
    }),
  )

  const merged: Stream[] = []
  const errors: string[] = []
  for (const [idx, result] of settled.entries()) {
    if (result.status === 'fulfilled') {
      merged.push(...result.value)
    } else {
      errors.push(`${providers[idx]}: ${String(result.reason)}`)
    }
  }

  const deduped = new Map<string, Stream>()
  for (const stream of merged) {
    const key = `${stream.url ?? ''}|${stream.name}|${stream.title}`
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
export async function fetchRankedStreams(imdbId: string): Promise<Stream[]> {
  const streams = await fetchStreamsFromProviders(`/stream/movie/${imdbId}.json`)
  if (!streams.length) throw new Error(`No streams found for ${imdbId}`)
  const ranked = rankStreams(streams)
  const summaries = ranked.map(stream => precomputeScore(stream))
  console.log(`streams: top candidates for ${imdbId}`)
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
): Promise<Stream[]> {
  const streams = await fetchStreamsFromProviders(`/stream/series/${imdbId}:${season}:${episode}.json`)
  if (!streams.length) throw new Error(`No streams found for ${imdbId} S${season}E${episode}`)
  const ranked = rankStreams(streams, { expectedYear })
  const summaries = ranked.map(stream => precomputeScore(stream, { expectedYear }))
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
  const m = url.match(/\/([0-9a-f]{40})(?:\/|$)/i)
  return m ? m[1].toLowerCase() : null
}
