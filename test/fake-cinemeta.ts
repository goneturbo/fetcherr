import type { StremioMeta } from '../src/sootio.js'

// A stand-in for Cinemeta at the fetch level. CINEMETA_BASE is a constant in
// src/sootio.ts, so there is no URL to point at a server instead. Anything not
// for Cinemeta goes to the real fetch, which is how the fake TMDB is reached.
//
// Not a test file itself: `npm test` globs test/*.test.ts.

const CINEMETA = 'https://v3-cinemeta.strem.io'

export interface FakeCinemetaOptions {
  // Search answers, matched on name without case like Cinemeta does.
  movies?: StremioMeta[]
  series?: StremioMeta[]
  // Full metas with their videos, by id, for series hydration.
  metas?: Record<string, StremioMeta>
}

export interface FakeCinemeta {
  // Every Cinemeta path asked for, in order, except /manifest.json.
  requests: string[]
  // Every other URL, handed to the real fetch.
  passedThrough: string[]
  // Searches of these types answer HTTP 500. Metas still answer.
  setFailing: (types: Array<'movie' | 'series'>) => void
  restore: () => void
}

const MANIFEST = {
  id: 'com.linvo.cinemeta', version: '3.0.0', name: 'Cinemeta', resources: ['catalog', 'meta'], types: ['movie', 'series'],
  catalogs: [
    { type: 'movie', id: 'top', extra: [{ name: 'search' }] },
    { type: 'series', id: 'top', extra: [{ name: 'search' }] },
  ],
}

export function installFakeCinemeta(options: FakeCinemetaOptions = {}): FakeCinemeta {
  const realFetch = globalThis.fetch
  const requests: string[] = []
  const passedThrough: string[] = []
  let failing = new Set<string>()
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (!url.startsWith(`${CINEMETA}/`)) {
      passedThrough.push(url)
      return realFetch(input, init)
    }
    const path = url.slice(CINEMETA.length)
    // Always answered: sootio caches a failed manifest for five minutes, which
    // would leak from one test into the next.
    if (path === '/manifest.json') return json(200, MANIFEST)
    requests.push(path)
    const search = path.match(/^\/catalog\/(movie|series)\/top\/search=(.+)\.json$/)
    if (search) {
      if (failing.has(search[1])) return json(500, { err: 'boom' })
      const term = decodeURIComponent(search[2]).toLowerCase()
      const list = (search[1] === 'movie' ? options.movies : options.series) ?? []
      return json(200, { metas: list.filter(meta => String(meta.name ?? '').toLowerCase().includes(term)) })
    }
    const meta = path.match(/^\/meta\/(movie|series)\/(.+)\.json$/)
    const found = meta ? options.metas?.[decodeURIComponent(meta[2])] : undefined
    return found ? json(200, { meta: found }) : json(404, { err: 'not found' })
  }) as typeof globalThis.fetch

  return {
    requests,
    passedThrough,
    setFailing: types => { failing = new Set(types) },
    restore: () => { globalThis.fetch = realFetch },
  }
}
