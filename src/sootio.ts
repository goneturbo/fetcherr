import { config } from './config.js'

export interface Stream {
  name:          string
  title:         string
  url?:          string
  behaviorHints?: Record<string, unknown>
  providerOrder?: number
}

interface StreamRankContext {
  expectedYear?: number
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
  return years.includes(expectedYear) ? 2 : -10
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

function scoreSummary(s: Stream, ctx: StreamRankContext = {}): string {
  const filename = typeof s.behaviorHints?.filename === 'string' ? s.behaviorHints.filename : ''
  return [
    `cached=${cachedScore(s)}`,
    `english=${hasEnglishSignal(s) ? 1 : 0}`,
    `nonEnglishPenalty=${nonEnglishPenalty(s)}`,
    `regionalPenalty=${regionalAudioPenalty(s)}`,
    `yearScore=${explicitYearScore(s, ctx.expectedYear)}`,
    `years=${JSON.stringify(explicitYearsInStream(s))}`,
    `episodeSpecificity=${episodeSpecificityScore(s)}`,
    `codec=${codecScore(s)}`,
    `container=${containerScore(s)}`,
    `size=${sizeBytes(s)}`,
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

// Codec compatibility score for Infuse — higher is better.
// H.264 is universally supported; AV1 and some HEVC profiles are not.
function codecScore(s: Stream): number {
  const text = streamText(s)
  if (/\bav1\b/.test(text))                      return 0
  if (/\bhevc\b|h\.?265\b|x265\b/.test(text))   return 1
  if (/\bh\.?264\b|x264\b|avc\b/.test(text))    return 3
  return 2 // unknown — prefer over AV1/HEVC but below explicit H.264
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
  const withoutExplicitYearMismatch = ctx.expectedYear
    ? basePool.filter(s => !hasExplicitYearMismatch(s, ctx.expectedYear))
    : basePool
  const pool = ctx.expectedYear ? withoutExplicitYearMismatch : basePool

  return [...pool].sort((a, b) =>
    cachedScore(b) - cachedScore(a)
    || nonEnglishPenalty(a) - nonEnglishPenalty(b)
    || regionalAudioPenalty(a) - regionalAudioPenalty(b)
    || explicitYearScore(b, ctx.expectedYear) - explicitYearScore(a, ctx.expectedYear)
    || episodeSpecificityScore(b) - episodeSpecificityScore(a)
    || (config.englishStreamMode === 'off' ? 0 : Number(hasEnglishSignal(b)) - Number(hasEnglishSignal(a)))
    || codecScore(b) - codecScore(a)
    || containerScore(b) - containerScore(a)
    || sizeBytes(b) - sizeBytes(a)
    || (a.providerOrder ?? 999) - (b.providerOrder ?? 999)
  )
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
        title: s.title || '',
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
 * Fetch all streams for a movie, sorted by size descending (largest first).
 * No provider-specific filtering — all indexers connected to AIOStreams are
 * considered equally; the caller picks the best candidate.
 */
export async function fetchRankedStreams(imdbId: string): Promise<Stream[]> {
  const streams = await fetchStreamsFromProviders(`/stream/movie/${imdbId}.json`)
  if (!streams.length) throw new Error(`No streams found for ${imdbId}`)
  const ranked = rankStreams(streams)
  console.log(`streams: top candidates for ${imdbId}`)
  for (const s of ranked.slice(0, 5)) {
    console.log(`streams: ${scoreSummary(s)} :: ${s.title || s.name}`)
  }
  return ranked
}

/**
 * Fetch all streams for a TV episode, sorted by size descending.
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
  if (!ranked.length) throw new Error(`No year-matched streams found for ${imdbId} S${season}E${episode}`)
  console.log(`streams: top candidates for ${imdbId} S${season}E${episode}`)
  for (const s of ranked.slice(0, 5)) {
    console.log(`streams: ${scoreSummary(s, { expectedYear })} :: ${s.title || s.name}`)
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
