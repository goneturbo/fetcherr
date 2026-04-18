import { randomBytes } from 'crypto'
import { config } from '../config.js'

// In-memory session store: token → expiry timestamp (ms)
const sessions = new Map<string, number>()

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 days

export function createSession(): string {
  const token = randomBytes(32).toString('hex')
  sessions.set(token, Date.now() + SESSION_TTL_MS)
  return token
}

export function isValidSession(token: string): boolean {
  const expiry = sessions.get(token)
  if (!expiry) return false
  if (Date.now() > expiry) {
    sessions.delete(token)
    return false
  }
  return true
}

export function deleteSession(token: string): void {
  sessions.delete(token)
}

export function checkCredentials(username: string, password: string): boolean {
  if (!config.uiPassword) return false
  return username === config.uiUsername && password === config.uiPassword
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
