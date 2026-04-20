import type { FastifyInstance } from 'fastify'
import { resolveStream, NotCachedError } from '../rd.js'
import { saveCastItem, getCastItem, listCastItems, deleteCastItem } from './db.js'
import { getTokenFromCookie, getSessionUser } from '../ui/auth.js'
import { resolveJellyfinUser } from '../jellyfin/index.js'

// ── Helper ─────────────────────────────────────────────────────────────────────

function requireToken(token: unknown, reply: { code: (n: number) => { send: (v: unknown) => unknown } }) {
  if (!token || typeof token !== 'string') {
    reply.code(400).send({ error: 'token is required' })
    return false
  }
  return true
}

function cookieHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

function requireAuthenticatedUser(
  headers: Record<string, string | string[] | undefined>,
  reply: { code: (n: number) => { send: (v: unknown) => unknown } },
) {
  const sessionToken = getTokenFromCookie(cookieHeaderValue(headers.cookie))
  if (sessionToken) {
    const user = getSessionUser(sessionToken)
    if (user) return user
  }
  const jellyfinUser = resolveJellyfinUser(headers)
  if (jellyfinUser) return jellyfinUser
  reply.code(401).send({ error: 'Unauthorized' })
  return null
}

// ── Routes ─────────────────────────────────────────────────────────────────────

export async function castRoutes(app: FastifyInstance) {

  /**
   * POST /api/cast/movie/:imdbId?token=X
   * Body: { hash, fileUrl?, sizeMb? }
   *
   * DMM-compatible: save a cast selection for a title.
   * Returns the saved item.
   */
  app.post('/api/cast/movie/:imdbId', async (req, reply) => {
    const { imdbId } = req.params as { imdbId: string }
    const { token }  = req.query  as { token?: string }
    const body       = req.body   as { hash?: string; fileUrl?: string; sizeMb?: number; url?: string }

    if (!requireAuthenticatedUser(req.headers, reply as never)) return
    if (!requireToken(token, reply as never)) return
    if (!body?.hash) return reply.code(400).send({ error: 'hash is required' })

    const item = {
      token:   token as string,
      imdbId,
      hash:    body.hash.toLowerCase(),
      fileUrl: body.fileUrl ?? body.url ?? '',
      sizeMb:  body.sizeMb ?? 0,
    }
    saveCastItem(item)
    app.log.info(`cast: saved ${imdbId} hash=${item.hash} for token=${token}`)
    return { ...item, updatedAt: new Date().toISOString() }
  })

  /**
   * GET /api/cast/links?token=X
   *
   * Return all saved cast items for a token (matches DMM /api/stremio/links).
   */
  app.get('/api/cast/links', async (req, reply) => {
    const { token } = req.query as { token?: string }
    if (!requireAuthenticatedUser(req.headers, reply as never)) return
    if (!requireToken(token, reply as never)) return
    return listCastItems(token as string)
  })

  /**
   * GET /api/cast/play?token=X&imdbId=Y
   *
   * Resolve a saved cast item to a direct playable URL via Real-Debrid.
   * Adds the torrent to RD, selects the file, unrestricts, then deletes the
   * torrent so it never accumulates in the RD library.
   */
  app.get('/api/cast/play', async (req, reply) => {
    const { token, imdbId } = req.query as { token?: string; imdbId?: string }
    if (!requireAuthenticatedUser(req.headers, reply as never)) return
    if (!requireToken(token, reply as never)) return
    if (!imdbId) return reply.code(400).send({ error: 'imdbId is required' })

    const item = getCastItem(token as string, imdbId)
    if (!item) return reply.code(404).send({ error: 'No cast item found for this title' })

    app.log.info(`cast: resolving ${imdbId} hash=${item.hash}`)
    try {
      const stream = await resolveStream(item.hash, item.fileUrl || undefined)
      app.log.info(`cast: resolved ${imdbId} → ${stream.url.slice(0, 80)}...`)
      return { url: stream.url, filename: stream.filename, bytes: stream.bytes }
    } catch (err) {
      if (err instanceof NotCachedError) {
        app.log.warn(`cast: ${imdbId} hash=${item.hash} not cached on RD`)
        return reply.code(422).send({ error: 'not_cached', message: 'This torrent is not cached on Real-Debrid. Select a cached source.' })
      }
      app.log.error(`cast: resolve failed for ${imdbId}: ${err}`)
      return reply.code(503).send({ error: String(err) })
    }
  })

  /**
   * POST /api/cast/unrestrict
   * Body: { hash, fileUrl? }
   *
   * One-shot unrestrict — resolve a hash to a direct URL without saving.
   * Useful for ad-hoc playback or testing.
   */
  app.post('/api/cast/unrestrict', async (req, reply) => {
    const body = req.body as { hash?: string; magnet?: string; fileUrl?: string }
    const hash = body?.hash ?? body?.magnet
    if (!requireAuthenticatedUser(req.headers, reply as never)) return
    if (!hash) return reply.code(400).send({ error: 'hash or magnet is required' })

    app.log.info(`cast: one-shot unrestrict hash=${hash.slice(0, 12)}...`)
    try {
      const stream = await resolveStream(
        hash.startsWith('magnet:') ? extractHash(hash) : hash,
        body.fileUrl,
      )
      return { url: stream.url, filename: stream.filename, bytes: stream.bytes }
    } catch (err) {
      if (err instanceof NotCachedError) {
        return reply.code(422).send({ error: 'not_cached', message: 'This torrent is not cached on Real-Debrid.' })
      }
      app.log.error(`cast: unrestrict failed: ${err}`)
      return reply.code(503).send({ error: String(err) })
    }
  })

  /**
   * DELETE /api/cast/movie/:imdbId?token=X
   *
   * Remove a saved cast item.
   */
  app.delete('/api/cast/movie/:imdbId', async (req, reply) => {
    const { imdbId } = req.params as { imdbId: string }
    const { token }  = req.query  as { token?: string }
    if (!requireAuthenticatedUser(req.headers, reply as never)) return
    if (!requireToken(token, reply as never)) return
    deleteCastItem(token as string, imdbId)
    return reply.code(204).send()
  })
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function extractHash(magnet: string): string {
  const m = magnet.match(/urn:btih:([0-9a-f]{40})/i)
  if (m) return m[1].toLowerCase()
  throw new Error('Cannot extract hash from magnet URI')
}
