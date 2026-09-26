import { createServer, type Server, type Socket } from 'node:net'

// A stand-in LDAP server for tests that need the directory to answer, not just
// to accept a bind. It speaks enough BER for a bind and a base-scope search with
// attributes, so ldapts really connects, really encodes a request and really
// parses the response. Behaviour is supplied per test through the callbacks.
//
// Not a test file itself: `npm test` globs test/*.test.ts.

export const RESULT_SUCCESS = 0x00
export const RESULT_INVALID_CREDENTIALS = 0x31
export const RESULT_INSUFFICIENT_ACCESS = 0x32

const OP_BIND = 0x60
const OP_SEARCH = 0x63

function berLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length])
  if (length < 0x100) return Buffer.from([0x81, length])
  return Buffer.from([0x82, length >> 8, length & 0xff])
}

const tlv = (tag: number, payload: Buffer) => Buffer.concat([Buffer.from([tag]), berLength(payload.length), payload])
const octet = (value: string) => tlv(0x04, Buffer.from(value, 'utf8'))
const integer = (value: number) => tlv(0x02, Buffer.from([value]))
const enumerated = (value: number) => tlv(0x0a, Buffer.from([value]))
const sequence = (...parts: Buffer[]) => tlv(0x30, Buffer.concat(parts))
const set = (...parts: Buffer[]) => tlv(0x31, Buffer.concat(parts))

const bindResponse = (messageId: number, code: number) =>
  sequence(integer(messageId), tlv(0x61, Buffer.concat([enumerated(code), octet(''), octet('')])))

const searchEntry = (messageId: number, dn: string, attributes: Record<string, string[]>) =>
  sequence(integer(messageId), tlv(0x64, Buffer.concat([
    octet(dn),
    sequence(...Object.entries(attributes).map(([type, values]) => sequence(octet(type), set(...values.map(octet))))),
  ])))

const searchDone = (messageId: number, code: number) =>
  sequence(integer(messageId), tlv(0x65, Buffer.concat([enumerated(code), octet(''), octet('')])))

type ParsedRequest = { messageId: number; op: number; dn: string }

// One request per data event, which is all ldapts produces here: it binds, waits
// for the response, then searches.
function parseRequest(data: Buffer): ParsedRequest | null {
  if (data[0] !== 0x30) return null
  let at = 1
  const outerLen = data[at]
  at += outerLen < 0x80 ? 1 : 1 + (outerLen & 0x7f)
  if (data[at] !== 0x02) return null
  const idLen = data[at + 1]
  let messageId = 0
  for (let i = 0; i < idLen; i++) messageId = (messageId << 8) | data[at + 2 + i]
  at += 2 + idLen
  const op = data[at]
  at += 1
  const opLen = data[at]
  at += opLen < 0x80 ? 1 : 1 + (opLen & 0x7f)
  // A BindRequest opens with the protocol version, a SearchRequest with its base
  // object, so skip the version to reach the DN in the bind case.
  if (op === OP_BIND) at += 3
  if (data[at] !== 0x04) return { messageId, op, dn: '' }
  const dnLen = data[at + 1]
  return { messageId, op, dn: data.slice(at + 2, at + 2 + dnLen).toString('utf8') }
}

export type SearchAnswer =
  | 'silent'
  | { entry?: Record<string, string[]>; code?: number }

export type FakeDirectoryOptions = {
  // Result code for a bind of this DN. Default: success for everything, which is
  // what "the caller holds valid credentials for that entry" looks like.
  onBind?: (dn: string) => number
  // What a base-scope search of baseDn returns. boundAs is the DN that
  // authenticated the connection asking, so a test can model a directory that
  // only lets a service account search.
  onSearch?: (baseDn: string, boundAs: string) => SearchAnswer
}

export type FakeDirectory = {
  port: number
  url: string
  // Every DN that has bound, in order, which is how a test proves that a service
  // account was used rather than the user's own connection.
  boundDns: string[]
  // Base DNs searched, paired with the identity that asked.
  searches: Array<{ baseDn: string; boundAs: string }>
  close: () => void
}

export async function startFakeDirectory(options: FakeDirectoryOptions = {}): Promise<FakeDirectory> {
  const boundDns: string[] = []
  const searches: Array<{ baseDn: string; boundAs: string }> = []

  const server: Server = createServer((socket: Socket) => {
    // Per connection, because who bound this socket is the whole question when a
    // directory refuses searches to ordinary users.
    let boundAs = ''
    socket.on('error', () => { /* the client hangs up when an operation times out */ })
    socket.on('data', data => {
      const request = parseRequest(data)
      if (!request) return

      if (request.op === OP_BIND) {
        const code = options.onBind ? options.onBind(request.dn) : RESULT_SUCCESS
        if (code === RESULT_SUCCESS) {
          boundAs = request.dn
          boundDns.push(request.dn)
        }
        socket.write(bindResponse(request.messageId, code))
        return
      }

      if (request.op !== OP_SEARCH) return
      searches.push({ baseDn: request.dn, boundAs })
      const answer = options.onSearch ? options.onSearch(request.dn, boundAs) : {}
      if (answer === 'silent') return
      if (answer.code && answer.code !== RESULT_SUCCESS) {
        socket.write(searchDone(request.messageId, answer.code))
        return
      }
      if (answer.entry && Object.keys(answer.entry).length) {
        socket.write(searchEntry(request.messageId, request.dn, answer.entry))
      }
      socket.write(searchDone(request.messageId, RESULT_SUCCESS))
    })
  })

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  return { port, url: `ldap://127.0.0.1:${port}`, boundDns, searches, close: () => server.close() }
}
