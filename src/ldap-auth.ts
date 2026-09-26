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
//
// Optionally, membership of one group can be required, so pointing Fetcherr at a
// directory with more than a handful of accounts does not hand an account to
// every entry in it:
//   LDAP_REQUIRED_GROUP group DN a user must belong to, e.g.
//                       cn=media-users,ou=groups,dc=ldap,dc=goauthentik,dc=io
//   LDAP_BIND_DN        optional service account DN for the membership read,
//                       for directories that refuse searches to ordinary users
//   LDAP_BIND_PASSWORD  that account's password
// Leave LDAP_REQUIRED_GROUP unset and logins behave exactly as before.

const LDAP_URL = process.env.LDAP_URL ?? ''
const LDAP_USER_DN = process.env.LDAP_USER_DN ?? ''
const LDAP_REQUIRED_GROUP = process.env.LDAP_REQUIRED_GROUP ?? ''
const LDAP_BIND_DN = process.env.LDAP_BIND_DN ?? ''
const LDAP_BIND_PASSWORD = process.env.LDAP_BIND_PASSWORD ?? ''
const LDAP_DEFAULT_ROLE: AppUserRole =
  process.env.LDAP_DEFAULT_ROLE === 'kids' ? 'kids' : 'user'

// Reaching the directory is a local network hop, but the bind itself runs the
// provider's whole password stage, which is a slow hash plus flow execution.
// Measured against an Authentik LDAP outpost on NAS hardware: 1.9s to reject a
// wrong password, 2.9s to reject an unknown user, and longer to accept a valid
// one. So connect impatiently and bind patiently: a directory that is not
// listening still fails in about a second, while a slow one is not mistaken for
// a wrong password. Both are overridable because this cost belongs to someone
// else's directory, not to Fetcherr.
function timeoutEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name])
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}

const LDAP_CONNECT_TIMEOUT_MS = timeoutEnv('LDAP_CONNECT_TIMEOUT_MS', 2000)
const LDAP_TIMEOUT_MS = timeoutEnv('LDAP_TIMEOUT_MS', 10000)

export function ldapEnabled(): boolean {
  return Boolean(LDAP_URL && LDAP_USER_DN.includes('{username}'))
}

export function ldapGroupRequired(): boolean {
  return Boolean(ldapEnabled() && LDAP_REQUIRED_GROUP)
}

// The group read is either done on the user's own connection, right after their
// bind, or by a service account when the directory refuses searches to ordinary
// users. Authentik is in the second camp unless the user is in a group holding
// search permission.
function groupReadUsesServiceAccount(): boolean {
  return Boolean(LDAP_BIND_DN && LDAP_BIND_PASSWORD)
}

// Escape RFC 4514 special characters plus NUL in a DN attribute value.
// Leading/trailing spaces need no handling here: authenticateUser trims the
// username before it reaches the DN template.
function escapeDnValue(value: string): string {
  return value
    .replace(/([\\,+"<>;=#])/g, '\\$1')
    .replace(/\0/g, '\\00')
}

function userDnFor(username: string): string {
  // Replacer function so `$` sequences in usernames are inserted literally
  // instead of being expanded as replacement patterns.
  return LDAP_USER_DN.replace('{username}', () => escapeDnValue(username))
}

// Compare two DNs the way a directory does for equality: attribute names and
// values case-folded, and the incidental whitespace around separators ignored.
// This is deliberately not a full RFC 4518 comparison; it covers the difference
// between what an admin types into a variable and what the directory returns.
export function sameDn(a: string, b: string): boolean {
  const normalize = (dn: string) => String(dn ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s*([,=])\s*/g, '$1')
  return normalize(a) === normalize(b) && normalize(a).length > 0
}

function asStringArray(value: unknown): string[] {
  const values = Array.isArray(value) ? value : value == null ? [] : [value]
  return values.map(item => (Buffer.isBuffer(item) ? item.toString('utf8') : String(item)))
}

// 'unknown' is not 'not a member'. The caller treats the two differently,
// because a directory that cannot be read must not lock out accounts that
// already exist.
export type GroupMembership = 'member' | 'not-member' | 'unknown'

// Two ways to establish membership, because directories disagree about which
// side of the relationship they publish. Authentik and any OpenLDAP with the
// memberof overlay put memberOf on the user entry; without the overlay only the
// group entry's member list exists. Ask the user entry first, since that is one
// read of an entry we already know the DN of, and fall back to reading the group.
export function membershipFromAttributes(
  input: { userDn: string; groupDn: string; memberOf?: unknown; groupMembers?: unknown },
): GroupMembership {
  const memberOf = asStringArray(input.memberOf)
  if (memberOf.length) {
    return memberOf.some(dn => sameDn(dn, input.groupDn)) ? 'member' : 'not-member'
  }
  const groupMembers = asStringArray(input.groupMembers)
  if (groupMembers.length) {
    return groupMembers.some(dn => sameDn(dn, input.userDn)) ? 'member' : 'not-member'
  }
  // Neither side said anything. A group with no members at all is
  // indistinguishable from an attribute this directory does not publish, or a
  // group DN with a typo in it, so it is not evidence of non-membership.
  return 'unknown'
}

async function ldapBindAndCheckGroup(
  username: string,
  password: string,
): Promise<{ bound: false } | { bound: true; membership: GroupMembership }> {
  if (!password) return { bound: false } // empty password = unauthenticated bind, always refuse
  const userDn = userDnFor(username)
  const client = new Client({ url: LDAP_URL, timeout: LDAP_TIMEOUT_MS, connectTimeout: LDAP_CONNECT_TIMEOUT_MS })
  try {
    try {
      await client.bind(userDn, password)
    } catch (err) {
      if (err instanceof InvalidCredentialsError) {
        console.log(`ldap: bind rejected for "${username}" (invalid credentials)`)
      } else {
        console.warn(`ldap: bind failed for "${username}": ${err instanceof Error ? err.message : String(err)}`)
      }
      return { bound: false }
    }
    if (!ldapGroupRequired()) return { bound: true, membership: 'member' }
    // Reuse the connection the bind just authenticated. Without a service
    // account this keeps a gated login at one password stage, which matters
    // because a bind runs the provider's whole flow and is measured in seconds.
    return { bound: true, membership: await readMembership(client, userDn, username) }
  } finally {
    try { await client.unbind() } catch { /* ignore */ }
  }
}

function pickAttribute(entry: Record<string, unknown> | null, name: string): unknown {
  if (!entry) return undefined
  const key = Object.keys(entry).find(candidate => candidate.toLowerCase() === name.toLowerCase())
  return key ? entry[key] : undefined
}

async function readEntry(client: Client, dn: string, attributes: string[]): Promise<Record<string, unknown> | null> {
  const { searchEntries } = await client.search(dn, { scope: 'base', filter: '(objectClass=*)', attributes })
  return (searchEntries[0] as Record<string, unknown> | undefined) ?? null
}

async function readMembership(userClient: Client, userDn: string, username: string): Promise<GroupMembership> {
  let serviceClient: Client | null = null
  try {
    let reader = userClient
    if (groupReadUsesServiceAccount()) {
      serviceClient = new Client({ url: LDAP_URL, timeout: LDAP_TIMEOUT_MS, connectTimeout: LDAP_CONNECT_TIMEOUT_MS })
      await serviceClient.bind(LDAP_BIND_DN, LDAP_BIND_PASSWORD)
      reader = serviceClient
    }

    const userEntry = await readEntry(reader, userDn, ['memberOf'])
    const fromUser = membershipFromAttributes({
      userDn,
      groupDn: LDAP_REQUIRED_GROUP,
      memberOf: pickAttribute(userEntry, 'memberOf'),
    })
    if (fromUser !== 'unknown') return fromUser

    const groupEntry = await readEntry(reader, LDAP_REQUIRED_GROUP, ['member', 'uniqueMember'])
    return membershipFromAttributes({
      userDn,
      groupDn: LDAP_REQUIRED_GROUP,
      groupMembers: pickAttribute(groupEntry, 'member') ?? pickAttribute(groupEntry, 'uniqueMember'),
    })
  } catch (err) {
    // Says which half failed, because the two have different fixes: a search the
    // directory refuses needs LDAP_BIND_DN, a wrong group DN needs correcting.
    console.warn(`ldap: could not read group membership for "${username}": ${err instanceof Error ? err.message : String(err)}`)
    return 'unknown'
  } finally {
    if (serviceClient) {
      try { await serviceClient.unbind() } catch { /* ignore */ }
    }
  }
}

export async function authenticateUser(username: string, password: string): Promise<AppUser | null> {
  const name = username.trim()
  if (!name) return null
  if (!ldapEnabled()) return verifyUserCredentials(name, password)

  // A username that already belongs to a local account is a local credential and
  // nothing else. Falling through to a bind here would let any directory entry
  // that happens to share the string sign in as that account and inherit its
  // role, so a local admin could be taken over by whoever controls a directory
  // entry of the same name. Two identities that share a string stay separate;
  // tying one to the directory has to be a deliberate admin act.
  const existing = getUserByUsername(name)
  if (existing?.authSource === 'local') {
    const local = verifyUserCredentials(name, password)
    // Says why in the one case an admin will ask about: a directory user whose
    // name collides with a local account, wondering why their password fails.
    if (!local) console.log(`ldap: "${name}" is a local account, so the directory was not consulted`)
    return local
  }

  const outcome = await ldapBindAndCheckGroup(name, password)
  if (outcome.bound) {
    if (outcome.membership === 'not-member') {
      // Also covers someone removed from the group: their next login is refused,
      // though anything already issued to them stays valid until it expires.
      console.log(`ldap: "${name}" is not a member of ${LDAP_REQUIRED_GROUP}, so the login was refused`)
      return null
    }
    if (outcome.membership === 'unknown') {
      // An unreadable directory must not lock out the household, but it must not
      // hand out new accounts either: refusing provisioning costs a stranger
      // nothing and keeps the restriction meaningful, while an account that
      // already exists was admitted by a check that did work at the time.
      if (!existing) {
        console.warn(`ldap: refusing to create an account for "${name}", since membership of ${LDAP_REQUIRED_GROUP} could not be established`)
        return null
      }
      console.warn(`ldap: letting existing account "${name}" in without a group check, since the directory could not be read`)
    }
    if (existing) return existing
    // Auto-provision with a random local password; these accounts authenticate
    // through the directory only, so the local hash is never a usable credential.
    return createUser(name, randomBytes(24).toString('hex'), LDAP_DEFAULT_ROLE, '', undefined, 'ldap')
  }
  // Nothing is left to try: a local username returned above, an LDAP-provisioned
  // account has no password of its own, and an unknown username has nothing to
  // check against.
  return null
}
