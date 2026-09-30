import { trimCacheMap } from './cache-utils.js'
import { torBoxRequestdlTorrentId } from './torbox.js'

// TorBox's requestdl endpoint redirects to a CDN URL whose presigned token the
// CDN node needs about a second to learn. A player that hits the CDN URL in
// that window gets a 400 ("Invalid Presigned Token") and, for Infuse, gives up
// on the first failure. So fetcherr follows the redirect itself, waits for the
// CDN to answer, and only then sends the player a URL that already works.
//
// The whole warm — the requestdl redirect and every probe — is bounded by one
// overall deadline, so a slow-but-not-hanging TorBox still can't hold a play
// open much past it: every request's own timeout shrinks to whatever is left.

const CACHE_TTL_MS = 10 * 60 * 1000
const CACHE_MAX_ENTRIES = 500
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000
const DEFAULT_PROBE_INTERVAL_MS = 150
const DEFAULT_PROBE_BUDGET_MS = 4_000
const DEFAULT_OVERALL_DEADLINE_MS = 8_000

// requestdl itself failing (no redirect, or a network error) isn't keyed by
// URL like the cache is, so a stuck TorBox would otherwise warn on every
// single play. One line a minute, process-wide, is enough of a trail.
const REQUESTDL_WARN_THROTTLE_MS = 60_000

export interface WarmTorBoxLinkOptions {
  fetch?:             typeof fetch
  now?:               () => number
  sleep?:             (ms: number) => Promise<void>
  requestTimeoutMs?:  number
  probeIntervalMs?:   number
  probeBudgetMs?:     number
  overallDeadlineMs?: number
}

interface CacheEntry {
  url:       string
  expiresAt: number
}

// Keyed by the requestdl URL, which is not unique per play: it is built from
// the account key, torrent id and file id, so every device playing that file
// shares this one warmed link on purpose, which is what lets a seek reuse it
// instead of warming again. TorBox's guidance is one device and at most a few
// connections per link, so that sharing is by design, not a bug to fix here.
const cache = new Map<string, CacheEntry>()
const inflight = new Map<string, Promise<string>>()

// Process-wide, not per-URL: every requestdl-side failure shares this clock.
let lastRequestdlWarnAt = -Infinity

const defaultSleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

// Query strings carry TorBox's API key (requestdl) or a presigned token (the
// CDN URL). Logging only host and path keeps both out of the logs.
function hostAndPath(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.host}${parsed.pathname}`
  } catch {
    return 'invalid url'
  }
}

async function cancelBody(res: Response): Promise<void> {
  await res.body?.cancel().catch(() => {})
}

// requestdl not answering with a usable redirect: fall back to the URL
// unchanged, as before this change, but leave a trail — throttled, since a
// down requestdl would otherwise warn on every single play.
function warnRequestdlFailure(requestdlUrl: string, now: () => number): void {
  const at = now()
  if (at - lastRequestdlWarnAt < REQUESTDL_WARN_THROTTLE_MS) return
  lastRequestdlWarnAt = at
  console.warn(`play: TorBox requestdl did not redirect, playing without a warm link (${hostAndPath(requestdlUrl)})`)
}

// The only plays worth warming: a TorBox requestdl URL fetcherr will hand to
// the player unmodified.
export function shouldWarmTorBoxLink(url: string): boolean {
  return torBoxRequestdlTorrentId(url) !== null
}

export async function warmTorBoxLink(requestdlUrl: string, options: WarmTorBoxLinkOptions = {}): Promise<string> {
  const now = options.now ?? Date.now
  const cached = cache.get(requestdlUrl)
  if (cached && cached.expiresAt > now()) return cached.url

  const running = inflight.get(requestdlUrl)
  if (running) return running

  const promise = warmUncached(requestdlUrl, options).finally(() => inflight.delete(requestdlUrl))
  inflight.set(requestdlUrl, promise)
  return promise
}

async function warmUncached(requestdlUrl: string, options: WarmTorBoxLinkOptions): Promise<string> {
  const fetchImpl = options.fetch ?? fetch
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? defaultSleep
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  const probeIntervalMs = options.probeIntervalMs ?? DEFAULT_PROBE_INTERVAL_MS
  const probeBudgetMs = options.probeBudgetMs ?? DEFAULT_PROBE_BUDGET_MS
  const overallDeadlineMs = options.overallDeadlineMs ?? DEFAULT_OVERALL_DEADLINE_MS

  // One deadline for the whole warm, requestdl redirect included: every
  // request below gets the smaller of its own limit and whatever is left of
  // this, so a slow TorBox never holds a play open much past overallDeadlineMs.
  const deadlineAt = now() + overallDeadlineMs
  const timeoutFor = (ownLimitMs: number): number => Math.max(0, Math.min(ownLimitMs, deadlineAt - now()))

  let cdnUrl: string
  try {
    const res = await fetchImpl(requestdlUrl, { redirect: 'manual', signal: AbortSignal.timeout(timeoutFor(requestTimeoutMs)) })
    await cancelBody(res)
    const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null
    if (!location) {
      warnRequestdlFailure(requestdlUrl, now)
      return requestdlUrl
    }
    cdnUrl = new URL(location, requestdlUrl).href
  } catch {
    // No usable redirect: today's behaviour is to hand the player the
    // requestdl URL, so a broken follow-up is no worse than before this change.
    warnRequestdlFailure(requestdlUrl, now)
    return requestdlUrl
  }

  const start = now()
  let probes = 0
  while (true) {
    probes++
    let res: Response
    try {
      res = await fetchImpl(cdnUrl, {
        method: 'GET',
        headers: { Range: 'bytes=0-0' },
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutFor(requestTimeoutMs)),
      })
    } catch {
      return fallback(requestdlUrl, cdnUrl)
    }
    await cancelBody(res)

    if (res.status >= 200 && res.status < 300) return ready()
    if (res.status >= 300 && res.status < 400) return ready()
    const withinProbeBudget = now() - start < probeBudgetMs
    const withinOverallDeadline = now() < deadlineAt
    if (res.status === 400 && withinProbeBudget && withinOverallDeadline) {
      await sleep(Math.max(0, Math.min(probeIntervalMs, deadlineAt - now())))
      continue
    }
    return fallback(requestdlUrl, cdnUrl)
  }

  function ready(): string {
    if (probes > 1) console.log(`play: TorBox link ready after ${probes} probes (${now() - start} ms)`)
    cache.set(requestdlUrl, { url: cdnUrl, expiresAt: now() + CACHE_TTL_MS })
    trimCacheMap(cache, CACHE_MAX_ENTRIES)
    return cdnUrl
  }
}

function fallback(requestdlUrl: string, cdnUrl: string): string {
  console.warn(`play: TorBox link still not answering, falling back to requestdl (${hostAndPath(cdnUrl)})`)
  return requestdlUrl
}
