import test from 'node:test'
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { startFakeDirectory, RESULT_SUCCESS, RESULT_INSUFFICIENT_ACCESS, RESULT_INVALID_CREDENTIALS } from './fake-ldap.js'

// Authentik, and anything else that gates searches behind a permission, refuses
// to answer when an ordinary user asks. That is the case LDAP_BIND_DN exists
// for, and it needs its own file because these variables are read once at load.

const GROUP_DN = 'cn=media-users,ou=groups,dc=example,dc=com'
const SERVICE_DN = 'cn=ldap-bind,ou=users,dc=example,dc=com'
const SERVICE_PASSWORD = 'service-account-secret'
const userDn = (username: string) => `cn=${username},ou=users,dc=example,dc=com`

let serviceBindWorks = true

const directory = await startFakeDirectory({
  onBind: dn => (dn === SERVICE_DN && !serviceBindWorks ? RESULT_INVALID_CREDENTIALS : RESULT_SUCCESS),
  // The whole point: only the service account may search. An ordinary user's
  // connection is refused, exactly as a locked-down directory refuses it.
  onSearch: (baseDn, boundAs) => {
    if (boundAs !== SERVICE_DN) return { code: RESULT_INSUFFICIENT_ACCESS }
    const attributes: Record<string, string[]> = baseDn.toLowerCase().startsWith('cn=media-users')
      ? {}
      : { memberOf: [GROUP_DN] }
    return { entry: attributes }
  },
})

const databasePath = join(tmpdir(), `fetcherr-ldap-group-svc-${randomUUID()}.db`)
process.env.DATABASE_PATH = databasePath
process.env.LDAP_URL = directory.url
process.env.LDAP_USER_DN = 'cn={username},ou=users,dc=example,dc=com'
process.env.LDAP_REQUIRED_GROUP = GROUP_DN
process.env.LDAP_BIND_DN = SERVICE_DN
process.env.LDAP_BIND_PASSWORD = SERVICE_PASSWORD
process.env.LDAP_CONNECT_TIMEOUT_MS = '800'
process.env.LDAP_TIMEOUT_MS = '900'

const db = await import('../src/db.js')
const { authenticateUser } = await import('../src/ldap-auth.js')

const existing = db.createUser('olduser', 'random-hash-nobody-knows', 'user', 'unrestricted', undefined, 'ldap')

test('a service account does the membership read, so the user needs no search rights', async () => {
  const user = await authenticateUser('newcomer', 'correct-horse')
  assert.equal(user?.username, 'newcomer')

  // Both identities bound: the user, to prove their password, and the service
  // account, to read the directory.
  assert.ok(directory.boundDns.includes(userDn('newcomer')), 'the user should have bound')
  assert.ok(directory.boundDns.includes(SERVICE_DN), 'the service account should have bound')

  // And every search went out on the service account's connection. If any had
  // ridden the user's, this deployment would break the moment the directory
  // enforced its search permission, which is the bug this path avoids.
  assert.ok(directory.searches.length > 0, 'a search should have happened')
  for (const search of directory.searches) {
    assert.equal(search.boundAs, SERVICE_DN, `search of ${search.baseDn} used the wrong identity`)
  }
})

test('a service account that cannot bind falls back to the safe answer', async () => {
  serviceBindWorks = false
  try {
    // Existing accounts keep working, because a broken service account is an
    // operator's problem and not a reason to lock out the household.
    const keptIn = await authenticateUser('olduser', 'correct-horse')
    assert.equal(keptIn?.username, 'olduser')
    assert.equal(db.getUserById(existing.id)?.username, 'olduser')

    // Nobody new gets in, because membership could not be established.
    const refused = await authenticateUser('stranger', 'correct-horse')
    assert.equal(refused, null)
    assert.equal(db.getUserByUsername('stranger'), null)
  } finally {
    serviceBindWorks = true
  }
})

test.after(() => {
  directory.close()
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${databasePath}${suffix}`, { force: true })
})
