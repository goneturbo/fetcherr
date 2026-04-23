import { randomBytes } from 'crypto'
import {
  authEnabled,
  createUiSession,
  deleteUiSession,
  getUiSession,
  getUserById,
  purgeExpiredUiSessions,
  verifyUserCredentials,
  type AppUser,
} from '../db.js'

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 days

export function createSession(userId: string): string {
  const token = randomBytes(32).toString('hex')
  createUiSession(token, userId, Date.now() + SESSION_TTL_MS)
  return token
}

export function isValidSession(token: string): boolean {
  return !!getUiSession(token)
}

export function getSessionUser(token: string): AppUser | null {
  const session = getUiSession(token)
  if (!session) return null
  return getUserById(session.userId)
}

export function deleteSession(token: string): void {
  deleteUiSession(token)
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
  purgeExpiredUiSessions()
  return authEnabled()
}
