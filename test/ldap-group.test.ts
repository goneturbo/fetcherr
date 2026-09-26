import test from 'node:test'
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { startFakeDirectory, RESULT_INSUFFICIENT_ACCESS } from './fake-ldap.js'

const GROUP_DN = 'cn=media-users,ou=groups,dc=example,dc=com'
const OTHER_GROUP_DN = 'cn=staff,ou=groups,dc=example,dc=com'
const userDn = (username: string) => `cn=${username},ou=users,dc=example,dc=com`

type SearchMode =
  | 'memberOf-has-group'
  | 'memberOf-other-group'
  | 'group-lists-user'
  | 'group-omits-user'
  | 'loose-dn-spelling'
  | 'refuse'
  | 'silent'

let searchMode: SearchMode = 'memberOf-has-group'

const isGroupEntry = (baseDn: string) => baseDn.toLowerCase().startsWith('cn=media-users')

const directory = await startFakeDirectory({
  onSearch: baseDn => {
    if (searchMode === 'silent') return 'silent'
    if (searchMode === 'refuse') return { code: RESULT_INSUFFICIENT_ACCESS }
    const forGroup = isGroupEntry(baseDn)
    let attributes: Record<string, string[]> = {}
    switch (searchMode) {
      case 'memberOf-has-group':
        if (!forGroup) attributes = { memberOf: [OTHER_GROUP_DN, GROUP_DN] }
        break
      case 'memberOf-other-group':
        if (!forGroup) attributes = { memberOf: [OTHER_GROUP_DN] }
        break
      case 'loose-dn-spelling':
        if (!forGroup) attributes = { memberOf: ['CN=Media-Users, OU=groups, DC=example, DC=com'] }
        break
      case 'group-lists-user':
        if (forGroup) attributes = { member: [userDn('newcomer'), userDn('someoneelse'), userDn('olduser')] }
        break
      case 'group-omits-user':
        if (forGroup) attributes = { member: [userDn('someoneelse')] }
        break
    }
    return { entry: attributes }
  },
})

const databasePath = join(tmpdir(), `fetcherr-ldap-group-${randomUUID()}.db`)
process.env.DATABASE_PATH = databasePath
process.env.LDAP_URL = directory.url
process.env.LDAP_USER_DN = 'cn={username},ou=users,dc=example,dc=com'
process.env.LDAP_REQUIRED_GROUP = GROUP_DN
// No LDAP_BIND_DN here, so the membership read rides the user's own connection.
// The service-account path has its own file, since both are read once at load.
process.env.LDAP_CONNECT_TIMEOUT_MS = '800'
process.env.LDAP_TIMEOUT_MS = '900'

const db = await import('../src/db.js')
const { authenticateUser, ldapGroupRequired, membershipFromAttributes, sameDn } = await import('../src/ldap-auth.js')

const existingLdapUser = db.createUser('olduser', 'random-hash-nobody-knows', 'user', 'unrestricted', undefined, 'ldap')

test('the fixture really requires a group, or nothing below tests the gate', () => {
  assert.equal(ldapGroupRequired(), true)
})

test('a member of the group is admitted and provisioned', async () => {
  searchMode = 'memberOf-has-group'
  const user = await authenticateUser('newcomer', 'correct-horse')
  assert.equal(user?.username, 'newcomer')
  assert.equal(user?.authSource, 'ldap')
})

test('a valid directory user outside the group gets no account at all', async () => {
  searchMode = 'memberOf-other-group'
  // The bind succeeds: these are real credentials for a real entry. Membership is
  // the only thing between them and an account, which is the point of the gate.
  const user = await authenticateUser('stranger', 'correct-horse')
  assert.equal(user, null)
  assert.equal(db.getUserByUsername('stranger'), null)
})

test('an account already provisioned is refused once it leaves the group', async () => {
  searchMode = 'memberOf-other-group'
  const user = await authenticateUser('olduser', 'correct-horse')
  assert.equal(user, null)
  // The row stays: this gate decides logins, not account lifecycle.
  assert.equal(db.getUserById(existingLdapUser.id)?.username, 'olduser')
})

test('membership can come from the group entry when the user entry has no memberOf', async () => {
  searchMode = 'group-lists-user'
  const admitted = await authenticateUser('olduser', 'correct-horse')
  assert.equal(admitted?.username, 'olduser')

  searchMode = 'group-omits-user'
  const refused = await authenticateUser('olduser', 'correct-horse')
  assert.equal(refused, null)
})

test('DN comparison survives the spelling an admin or a directory chooses', async () => {
  searchMode = 'loose-dn-spelling'
  const user = await authenticateUser('olduser', 'correct-horse')
  assert.equal(user?.username, 'olduser')
})

// The two branches that matter when the directory cannot answer. Refusing every
// login would turn a directory hiccup into a household outage; admitting every
// login would make the gate decorative.
test('a directory that refuses the search keeps existing accounts working', async () => {
  searchMode = 'refuse'
  const user = await authenticateUser('olduser', 'correct-horse')
  assert.equal(user?.username, 'olduser')
})

test('a directory that refuses the search still creates nobody', async () => {
  searchMode = 'refuse'
  const user = await authenticateUser('unknown-to-fetcherr', 'correct-horse')
  assert.equal(user, null)
  assert.equal(db.getUserByUsername('unknown-to-fetcherr'), null)
})

test('a silent directory behaves like one that refuses, after the timeout', async () => {
  searchMode = 'silent'
  const started = Date.now()
  const existing = await authenticateUser('olduser', 'correct-horse')
  const elapsed = Date.now() - started
  assert.equal(existing?.username, 'olduser')
  // Proof it waited on the configured timeout rather than failing early for some
  // other reason, and that the wait stays bounded.
  assert.ok(elapsed >= 900, `expected to wait out the timeout, waited ${elapsed}ms`)
  assert.ok(elapsed < 5000, `expected a bounded wait, waited ${elapsed}ms`)

  const newcomer = await authenticateUser('also-unknown', 'correct-horse')
  assert.equal(newcomer, null)
})

test('an empty answer is not evidence of non-membership', () => {
  // A group with no members, an attribute this directory does not publish and a
  // typo in the group DN all look identical from here, so none of them may be
  // read as "not a member".
  assert.equal(membershipFromAttributes({ userDn: userDn('a'), groupDn: GROUP_DN }), 'unknown')
  assert.equal(membershipFromAttributes({ userDn: userDn('a'), groupDn: GROUP_DN, memberOf: [] }), 'unknown')
  assert.equal(membershipFromAttributes({ userDn: userDn('a'), groupDn: GROUP_DN, groupMembers: [] }), 'unknown')
})

test('memberOf is believed over the group entry when both are present', () => {
  // The user entry is the authority when it answers: a stale member list on the
  // group should not override what the directory says about the user.
  assert.equal(
    membershipFromAttributes({
      userDn: userDn('a'),
      groupDn: GROUP_DN,
      memberOf: [OTHER_GROUP_DN],
      groupMembers: [userDn('a')],
    }),
    'not-member',
  )
})

test('attribute values survive being handed over as buffers', () => {
  // ldapts returns Buffers for values it will not decode as text.
  assert.equal(
    membershipFromAttributes({ userDn: userDn('a'), groupDn: GROUP_DN, memberOf: Buffer.from(GROUP_DN) }),
    'member',
  )
})

test('sameDn compares like a directory, not like a string', () => {
  assert.equal(sameDn('cn=A,dc=x', 'CN=a, DC=x'), true)
  assert.equal(sameDn('cn=a,dc=x', 'cn=b,dc=x'), false)
  assert.equal(sameDn('', ''), false)
})

test.after(() => {
  directory.close()
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${databasePath}${suffix}`, { force: true })
})
