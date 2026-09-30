import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { shouldWarmTorBoxLink, warmTorBoxLink, type WarmTorBoxLinkOptions } from '../src/torbox-link.js'

// Each test uses its own requestdl URL (a fresh token per test) so the module's
// module-level cache and in-flight map never leak a result from one test into
// another.
const requestdl = () => `https://api.torbox.app/v1/api/torrents/requestdl?token=${randomUUID()}&torrent_id=1&file_id=0`
const cdn = () => `https://store-021.weur.tb-cdn.st/${randomUUID()}?token=${randomUUID()}`

const noSleep = async () => {}

type Answer = { status: number; location?: string } | 'network-error'

// A fetch stub scripted per URL: each URL gets an ordered list of answers,
// the last one repeating once the list runs out.
function scriptedFetch(script: Record<string, Answer[]>) {
  const calls: string[] = []
  const counts = new Map<string, number>()
  const fetchImpl = (async (input: string | URL) => {
    const url = input.toString()
    calls.push(url)
    const n = counts.get(url) ?? 0
    counts.set(url, n + 1)
    const answers = script[url]
    if (!answers) throw new Error(`unscripted fetch: ${url}`)
    const answer = answers[Math.min(n, answers.length - 1)]
    if (answer === 'network-error') throw new Error('fake network error')
    return new Response(null, { status: answer.status, headers: answer.location ? { location: answer.location } : undefined })
  }) as unknown as typeof fetch
  return { fetchImpl, calls, countOf: (url: string) => counts.get(url) ?? 0 }
}

type SlowAnswer = { status: number; location?: string; delayMs?: number }

// Like scriptedFetch, but takes real time per answer and honours the abort
// signal fetch is given — needed to prove the overall deadline caps a slow,
// not-yet-erroring TorBox, not just a hard network failure.
function slowFetch(script: Record<string, SlowAnswer[]>) {
  const counts = new Map<string, number>()
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = input.toString()
    const n = counts.get(url) ?? 0
    counts.set(url, n + 1)
    const answers = script[url]
    if (!answers) throw new Error(`unscripted fetch: ${url}`)
    const answer = answers[Math.min(n, answers.length - 1)]
    const signal = init?.signal
    await new Promise<void>((resolve, reject) => {
      if (signal?.aborted) { reject(signal.reason ?? new Error('aborted')); return }
      const timer = setTimeout(resolve, answer.delayMs ?? 0)
      signal?.addEventListener('abort', () => {
        clearTimeout(timer)
        reject(signal.reason ?? new Error('aborted'))
      })
    })
    return new Response(null, { status: answer.status, headers: answer.location ? { location: answer.location } : undefined })
  }) as unknown as typeof fetch
  return { fetchImpl, countOf: (url: string) => counts.get(url) ?? 0 }
}

// prewarmPlayback decides whether to start a warm from this alone (no route,
// no fastify app), so it is the seam that stands in for the /play route test
// the brief asks for when one exists cheaply.
test('shouldWarmTorBoxLink is true for a TorBox requestdl URL', () => {
  assert.equal(shouldWarmTorBoxLink(requestdl()), true)
})

test('shouldWarmTorBoxLink is false for a non-TorBox URL', () => {
  assert.equal(shouldWarmTorBoxLink('https://example.com/stream.mkv'), false)
})

test('a 400 twice then 206 warms the link and returns the CDN URL after three probes', async () => {
  const requestdlUrl = requestdl()
  const cdnUrl = cdn()
  const { fetchImpl } = scriptedFetch({
    [requestdlUrl]: [{ status: 302, location: cdnUrl }],
    [cdnUrl]: [{ status: 400 }, { status: 400 }, { status: 206 }],
  })
  const result = await warmTorBoxLink(requestdlUrl, { fetch: fetchImpl, sleep: noSleep })
  assert.equal(result, cdnUrl)
})

test('a 206 on the first probe returns the CDN URL after one probe, no log line', async t => {
  const log = t.mock.method(console, 'log', () => {})
  const requestdlUrl = requestdl()
  const cdnUrl = cdn()
  const { fetchImpl, countOf } = scriptedFetch({
    [requestdlUrl]: [{ status: 302, location: cdnUrl }],
    [cdnUrl]: [{ status: 206 }],
  })
  const result = await warmTorBoxLink(requestdlUrl, { fetch: fetchImpl, sleep: noSleep })
  assert.equal(result, cdnUrl)
  assert.equal(countOf(cdnUrl), 1)
  assert.equal(log.mock.calls.length, 0, 'a single probe needs no "ready after N probes" line')
})

test('a 400 past the probe budget falls back to the requestdl URL, and does not cache it', async t => {
  t.mock.method(console, 'warn', () => {})
  const requestdlUrl = requestdl()
  const cdnUrl = cdn()
  const options: WarmTorBoxLinkOptions = { probeIntervalMs: 5, probeBudgetMs: 20, requestTimeoutMs: 1_000 }
  const script = { [requestdlUrl]: [{ status: 302, location: cdnUrl }], [cdnUrl]: [{ status: 400 }] }

  const first = scriptedFetch(script)
  const startedAt = Date.now()
  const result = await warmTorBoxLink(requestdlUrl, { ...options, fetch: first.fetchImpl })
  const elapsedMs = Date.now() - startedAt
  assert.equal(result, requestdlUrl)
  assert.ok(first.countOf(cdnUrl) >= 2, `expected more than one probe, got ${first.countOf(cdnUrl)}`)
  assert.ok(elapsedMs >= options.probeBudgetMs!, `expected at least the ${options.probeBudgetMs}ms budget to elapse, took ${elapsedMs}ms`)

  // Not cached: a second warm asks the network again instead of reusing a fallback.
  const second = scriptedFetch(script)
  const again = await warmTorBoxLink(requestdlUrl, { ...options, fetch: second.fetchImpl })
  assert.equal(again, requestdlUrl)
  assert.equal(second.countOf(requestdlUrl), 1, 'the fallback path must ask requestdl again, not reuse a cached fallback')
})

test('requestdl answering 200 with no Location returns the requestdl URL unchanged', async t => {
  t.mock.method(console, 'warn', () => {})
  const requestdlUrl = requestdl()
  const { fetchImpl } = scriptedFetch({ [requestdlUrl]: [{ status: 200 }] })
  assert.equal(await warmTorBoxLink(requestdlUrl, { fetch: fetchImpl }), requestdlUrl)
})

test('requestdl answering 500 with no Location returns the requestdl URL unchanged', async t => {
  t.mock.method(console, 'warn', () => {})
  const requestdlUrl = requestdl()
  const { fetchImpl } = scriptedFetch({ [requestdlUrl]: [{ status: 500 }] })
  assert.equal(await warmTorBoxLink(requestdlUrl, { fetch: fetchImpl }), requestdlUrl)
})

test('a 404 on the CDN falls back to the requestdl URL', async t => {
  t.mock.method(console, 'warn', () => {})
  const requestdlUrl = requestdl()
  const cdnUrl = cdn()
  const { fetchImpl } = scriptedFetch({
    [requestdlUrl]: [{ status: 302, location: cdnUrl }],
    [cdnUrl]: [{ status: 404 }],
  })
  assert.equal(await warmTorBoxLink(requestdlUrl, { fetch: fetchImpl, sleep: noSleep }), requestdlUrl)
})

test('a network error probing the CDN falls back to the requestdl URL', async t => {
  t.mock.method(console, 'warn', () => {})
  const requestdlUrl = requestdl()
  const cdnUrl = cdn()
  const { fetchImpl } = scriptedFetch({
    [requestdlUrl]: [{ status: 302, location: cdnUrl }],
    [cdnUrl]: ['network-error'],
  })
  assert.equal(await warmTorBoxLink(requestdlUrl, { fetch: fetchImpl, sleep: noSleep }), requestdlUrl)
})

test('a 3xx from the CDN itself is returned and cached as-is', async () => {
  const requestdlUrl = requestdl()
  const cdnUrl = cdn()
  const cdnRedirect = cdn()
  const { fetchImpl, countOf } = scriptedFetch({
    [requestdlUrl]: [{ status: 302, location: cdnUrl }],
    [cdnUrl]: [{ status: 302, location: cdnRedirect }],
  })
  const result = await warmTorBoxLink(requestdlUrl, { fetch: fetchImpl, sleep: noSleep })
  assert.equal(result, cdnUrl)
  const again = await warmTorBoxLink(requestdlUrl, { fetch: fetchImpl, sleep: noSleep })
  assert.equal(again, cdnUrl)
  assert.equal(countOf(requestdlUrl), 1, 'the cached result must skip a second requestdl fetch')
})

test('two warms within ten minutes make one requestdl request; a warm ten minutes later asks again', async () => {
  const requestdlUrl = requestdl()
  const cdnUrl = cdn()
  const { fetchImpl, countOf } = scriptedFetch({
    [requestdlUrl]: [{ status: 302, location: cdnUrl }],
    [cdnUrl]: [{ status: 206 }],
  })
  let clock = 1_700_000_000_000
  const now = () => clock

  const first = await warmTorBoxLink(requestdlUrl, { fetch: fetchImpl, now, sleep: noSleep })
  clock += 9 * 60 * 1000
  const second = await warmTorBoxLink(requestdlUrl, { fetch: fetchImpl, now, sleep: noSleep })
  assert.equal(first, cdnUrl)
  assert.equal(second, cdnUrl)
  assert.equal(countOf(requestdlUrl), 1, 'still within the ten minute cache window')

  clock += 10 * 60 * 1000 + 1
  const third = await warmTorBoxLink(requestdlUrl, { fetch: fetchImpl, now, sleep: noSleep })
  assert.equal(third, cdnUrl)
  assert.equal(countOf(requestdlUrl), 2, 'past the ten minute window, the cache must not answer')
})

test('two concurrent warms for the same URL share one in-flight request', async () => {
  const requestdlUrl = requestdl()
  const cdnUrl = cdn()
  let releaseRedirect: (() => void) | undefined
  const redirectGate = new Promise<void>(resolve => { releaseRedirect = resolve })
  let redirectCalls = 0
  const fetchImpl = (async (input: string | URL) => {
    const url = input.toString()
    if (url === requestdlUrl) {
      redirectCalls++
      await redirectGate
      return new Response(null, { status: 302, headers: { location: cdnUrl } })
    }
    return new Response(null, { status: 206 })
  }) as unknown as typeof fetch

  const first = warmTorBoxLink(requestdlUrl, { fetch: fetchImpl, sleep: noSleep })
  const second = warmTorBoxLink(requestdlUrl, { fetch: fetchImpl, sleep: noSleep })
  releaseRedirect?.()
  const [firstResult, secondResult] = await Promise.all([first, second])

  assert.equal(firstResult, cdnUrl)
  assert.equal(secondResult, cdnUrl)
  assert.equal(redirectCalls, 1, 'only one caller should have reached requestdl')
})

test('no log line ever names a query string', async t => {
  const log = t.mock.method(console, 'log', () => {})
  const warn = t.mock.method(console, 'warn', () => {})

  // One warm that needs three probes (logs the "ready after N probes" info line)...
  const readyRequestdlUrl = requestdl()
  const readyCdnUrl = cdn()
  const readyFetch = scriptedFetch({
    [readyRequestdlUrl]: [{ status: 302, location: readyCdnUrl }],
    [readyCdnUrl]: [{ status: 400 }, { status: 206 }],
  })
  await warmTorBoxLink(readyRequestdlUrl, { fetch: readyFetch.fetchImpl, sleep: noSleep })

  // ...and one that exhausts its budget and falls back (logs the warn line).
  const fallbackRequestdlUrl = requestdl()
  const fallbackCdnUrl = cdn()
  const fallbackFetch = scriptedFetch({
    [fallbackRequestdlUrl]: [{ status: 302, location: fallbackCdnUrl }],
    [fallbackCdnUrl]: [{ status: 400 }],
  })
  await warmTorBoxLink(fallbackRequestdlUrl, { fetch: fallbackFetch.fetchImpl, probeIntervalMs: 1, probeBudgetMs: 5 })

  const allLines = [...log.mock.calls, ...warn.mock.calls].map(call => String(call.arguments[0]))
  assert.ok(allLines.length > 0, 'expected at least the ready and fallback lines to have logged')
  for (const line of allLines) assert.ok(!line.includes('token='), line)
})

test("the whole warm is bounded by the overall deadline, not the sum of each request's own timeout", async t => {
  t.mock.method(console, 'warn', () => {})
  const requestdlUrl = requestdl()
  const cdnUrl = cdn()
  const overallDeadlineMs = 150
  // Both requestdl and the CDN answer slowly, but the CDN never gets past a
  // 400 ("still not ready") — without the fix, a not-yet-timing-out TorBox
  // like this would keep the play open for close to requestTimeoutMs +
  // probeBudgetMs (seconds), not overallDeadlineMs (150ms here).
  const { fetchImpl, countOf } = slowFetch({
    [requestdlUrl]: [{ status: 302, location: cdnUrl, delayMs: 80 }],
    [cdnUrl]: [{ status: 400, delayMs: 80 }],
  })
  const startedAt = Date.now()
  const result = await warmTorBoxLink(requestdlUrl, {
    fetch: fetchImpl,
    overallDeadlineMs,
    requestTimeoutMs: 5_000, // each request's own limit, far bigger than the deadline
    probeIntervalMs: 10,
    probeBudgetMs: 5_000, // also far bigger than the deadline
  })
  const elapsedMs = Date.now() - startedAt
  assert.equal(result, requestdlUrl, 'falls back once the overall deadline runs out')
  assert.equal(countOf(cdnUrl), 1, 'the first probe itself should have been cut short by the deadline, not allowed to finish and retry')
  assert.ok(elapsedMs < overallDeadlineMs + 150, `expected to finish near the ${overallDeadlineMs}ms deadline, took ${elapsedMs}ms`)
})

test('a requestdl-side failure logs one warn, throttled to once a minute across calls, with no query string', async t => {
  const warn = t.mock.method(console, 'warn', () => {})
  // A synthetic clock offset well into the future relative to real time, so
  // this test's first warn is never suppressed by a warn any earlier test in
  // this file left behind at real Date.now() — the throttle is process-wide,
  // not per test and not per URL.
  let clock = Date.now() + 10 * 60 * 1000
  const now = () => clock

  const firstUrl = requestdl()
  const { fetchImpl: fetch1 } = scriptedFetch({ [firstUrl]: [{ status: 500 }] })
  assert.equal(await warmTorBoxLink(firstUrl, { fetch: fetch1, now }), firstUrl)
  assert.equal(warn.mock.calls.length, 1, 'the first requestdl-side failure warns')

  clock += 30_000 // still inside the one-minute throttle window
  const secondUrl = requestdl()
  const { fetchImpl: fetch2 } = scriptedFetch({ [secondUrl]: ['network-error'] })
  assert.equal(await warmTorBoxLink(secondUrl, { fetch: fetch2, now }), secondUrl)
  assert.equal(warn.mock.calls.length, 1, 'still inside the throttle window: no second warn, even for the other failure path')

  clock += 31_000 // now more than a minute after the first warn
  const thirdUrl = requestdl()
  const { fetchImpl: fetch3 } = scriptedFetch({ [thirdUrl]: [{ status: 500 }] })
  assert.equal(await warmTorBoxLink(thirdUrl, { fetch: fetch3, now }), thirdUrl)
  assert.equal(warn.mock.calls.length, 2, 'past the throttle window: warns again')

  for (const call of warn.mock.calls) assert.ok(!String(call.arguments[0]).includes('token='), call.arguments[0])
})
