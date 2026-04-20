import { randomBytes } from 'crypto'
import { config } from '../config.js'
import { authEnabled, getUserById, verifyUserCredentials, type AppUser } from '../db.js'

type SessionRecord = { userId: string; expiresAt: number }

// In-memory session store: token → { userId, expiry }
const sessions = new Map<string, SessionRecord>()

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 days

export function createSession(userId: string): string {
  const token = randomBytes(32).toString('hex')
  sessions.set(token, { userId, expiresAt: Date.now() + SESSION_TTL_MS })
  return token
}

export function isValidSession(token: string): boolean {
  const session = sessions.get(token)
  if (!session) return false
  if (Date.now() > session.expiresAt) {
    sessions.delete(token)
    return false
  }
  return true
}

export function getSessionUser(token: string): AppUser | null {
  const session = sessions.get(token)
  if (!session) return null
  if (Date.now() > session.expiresAt) {
    sessions.delete(token)
    return null
  }
  return getUserById(session.userId)
}

export function deleteSession(token: string): void {
  sessions.delete(token)
}

export function checkCredentials(username: string, password: string): AppUser | null {
  if (!authEnabled()) return null
  return verifyUserCredentials(username, password)
}

function shouldUseSecureCookie(headers: Record<string, string | undefined>): boolean {
  const forwardedProto = headers['x-forwarded-proto']?.split(',')[0]?.trim().toLowerCase()
  if (forwardedProto === 'https') return true

  const forwarded = headers.forwarded?.toLowerCase() ?? ''
  if (/\bproto=https\b/.test(forwarded)) return true

  const cfVisitor = headers['cf-visitor']?.toLowerCase() ?? ''
  if (cfVisitor.includes('"scheme":"https"')) return true

  return false
}

export function getSessionCookie(token: string, headers: Record<string, string | undefined>): string {
  const maxAge = Math.floor(SESSION_TTL_MS / 1000)
  const secure = shouldUseSecureCookie(headers) ? '; Secure' : ''
  return `infuse_session=${token}; HttpOnly${secure}; SameSite=Strict; Path=/; Max-Age=${maxAge}`
}

export function clearSessionCookie(headers: Record<string, string | undefined>): string {
  const secure = shouldUseSecureCookie(headers) ? '; Secure' : ''
  return `infuse_session=; HttpOnly${secure}; SameSite=Strict; Path=/; Max-Age=0`
}

export function getTokenFromCookie(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null
  const match = cookieHeader.match(/(?:^|;\s*)infuse_session=([^;]+)/)
  return match ? match[1] : null
}

export function isUiAuthConfigured(): boolean {
  return authEnabled() || !!config.uiPassword
}
