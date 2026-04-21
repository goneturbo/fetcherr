import { createHmac, timingSafeEqual } from 'crypto'
import { config } from './config.js'

const PLAY_TOKEN_TTL_SECS = 5 * 60

function playTokenSecret(): string {
  return [
    config.rdApiKey,
    config.traktClientSecret,
    config.tmdbApiKey,
  ].filter(Boolean).join('|') || config.serverId
}

function signPlayPath(path: string, expires: number): string {
  return createHmac('sha256', playTokenSecret())
    .update(`${path}\n${expires}`)
    .digest('hex')
}

export function buildPlaybackOrigin(headers: Record<string, string | undefined>): string {
  const host = headers.host || 'localhost:9990'
  const forwardedProto = headers['x-forwarded-proto']?.split(',')[0]?.trim().toLowerCase()
  if (forwardedProto === 'https' || forwardedProto === 'http') {
    return `${forwardedProto}://${host}`
  }

  const forwarded = headers.forwarded?.toLowerCase() ?? ''
  if (/\bproto=https\b/.test(forwarded)) return `https://${host}`
  if (/\bproto=http\b/.test(forwarded)) return `http://${host}`

  const cfVisitor = headers['cf-visitor']?.toLowerCase() ?? ''
  if (cfVisitor.includes('"scheme":"https"')) return `https://${host}`
  if (cfVisitor.includes('"scheme":"http"')) return `http://${host}`

  return `http://${host}`
}

export function createSignedPlaybackUrl(origin: string, path: string): string {
  const expires = Math.floor(Date.now() / 1000) + PLAY_TOKEN_TTL_SECS
  const token = signPlayPath(path, expires)
  const url = new URL(path, origin)
  url.searchParams.set('expires', String(expires))
  url.searchParams.set('token', token)
  return url.toString()
}

export function verifySignedPlaybackPath(path: string, token?: string, expiresRaw?: string): boolean {
  if (!token || !expiresRaw) return false
  const expires = Number.parseInt(expiresRaw, 10)
  if (!Number.isFinite(expires) || expires < Math.floor(Date.now() / 1000)) return false

  const expected = signPlayPath(path, expires)
  const tokenBuf = Buffer.from(token)
  const expectedBuf = Buffer.from(expected)
  if (tokenBuf.length !== expectedBuf.length) return false
  return timingSafeEqual(tokenBuf, expectedBuf)
}
