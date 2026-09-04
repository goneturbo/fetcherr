import { randomBytes } from 'crypto'
import { Client, InvalidCredentialsError } from 'ldapts'
import {
  createUser,
  getUserByUsername,
  verifyUserCredentials,
  type AppUser,
  type AppUserRole,
} from './db.js'

// Optional LDAP bind authentication (e.g. against an Authentik LDAP outpost).
// When LDAP_URL and LDAP_USER_DN are set, logins try an LDAP bind first and
// fall back to local accounts, so a local admin always keeps working.
//   LDAP_URL          ldap://host:389 or ldaps://host:636
//   LDAP_USER_DN      DN template, e.g. cn={username},ou=users,dc=ldap,dc=goauthentik,dc=io
//   LDAP_DEFAULT_ROLE role for auto-provisioned users: user (default) or kids

const LDAP_URL = process.env.LDAP_URL ?? ''
const LDAP_USER_DN = process.env.LDAP_USER_DN ?? ''
const LDAP_DEFAULT_ROLE: AppUserRole =
  process.env.LDAP_DEFAULT_ROLE === 'kids' ? 'kids' : 'user'

export function ldapEnabled(): boolean {
  return Boolean(LDAP_URL && LDAP_USER_DN.includes('{username}'))
}

// Escape RFC 4514 special characters plus NUL in a DN attribute value.
// Leading/trailing spaces need no handling here: authenticateUser trims the
// username before it reaches the DN template.
function escapeDnValue(value: string): string {
  return value
    .replace(/([\\,+"<>;=#])/g, '\\$1')
    .replace(/\0/g, '\\00')
}

async function ldapBind(username: string, password: string): Promise<boolean> {
  if (!password) return false // empty password = unauthenticated bind, always refuse
  const client = new Client({ url: LDAP_URL, timeout: 5000, connectTimeout: 5000 })
  try {
    // Replacer function so `$` sequences in usernames are inserted literally
    // instead of being expanded as replacement patterns.
    await client.bind(LDAP_USER_DN.replace('{username}', () => escapeDnValue(username)), password)
    return true
  } catch (err) {
    if (err instanceof InvalidCredentialsError) {
      console.debug(`ldap: bind rejected for "${username}" (invalid credentials)`)
    } else {
      console.warn(`ldap: bind failed for "${username}": ${err instanceof Error ? err.message : String(err)}`)
    }
    return false
  } finally {
    try { await client.unbind() } catch { /* ignore */ }
  }
}

export async function authenticateUser(username: string, password: string): Promise<AppUser | null> {
  const name = username.trim()
  if (!name) return null
  if (ldapEnabled() && await ldapBind(name, password)) {
    const existing = getUserByUsername(name)
    if (existing) return existing
    // Auto-provision with a random local password; LDAP is checked first on
    // every login, so the local hash is never a usable credential.
    return createUser(name, randomBytes(24).toString('hex'), LDAP_DEFAULT_ROLE, '', undefined, 'ldap')
  }
  return verifyUserCredentials(name, password)
}
