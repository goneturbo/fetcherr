import test from 'node:test'
import assert from 'node:assert/strict'
import { MAX_STREAMS, noticeStreams, orderByPinnedHash, playUrlFor, toStremioStreams } from '../src/stremio-addon.js'

const ctx = { origin: 'https://streaming.example.net', token: 'TOK', mediaType: 'movie' as const, externalId: 'tt0111161' }
const hashA = 'a'.repeat(40)
const hashB = 'b'.repeat(40)

test('a play URL stays under the addon prefix and carries the hash', () => {
  assert.equal(
    playUrlFor(ctx, hashA),
    `https://streaming.example.net/stremio/TOK/play/movie/tt0111161/${hashA}`,
  )
})

test('a series play URL percent-encodes the colons', () => {
  const series = { ...ctx, mediaType: 'series' as const, externalId: 'tt0903747:1:2' }
  assert.equal(
    playUrlFor(series, hashA),
    `https://streaming.example.net/stremio/TOK/play/series/tt0903747%3A1%3A2/${hashA}`,
  )
})

test('maps streams, keeps upstream labels, and points at the play route', () => {
  const mapped = toStremioStreams([
    { name: '1080P Remux', title: 'Shawshank.1080p', infoHash: hashA, behaviorHints: { filename: 'a.mkv', videoSize: 42 } },
    { name: '2K Bluray', title: 'Shawshank.2160p', infoHash: hashB },
  ] as never, ctx)
  assert.equal(mapped.length, 2)
  assert.equal(mapped[0].name, '1080P Remux')
  assert.equal(mapped[0].description, 'Shawshank.1080p')
  assert.equal(mapped[0].url, playUrlFor(ctx, hashA))
  assert.deepEqual(mapped[0].behaviorHints, { bingeGroup: `fetcherr-${hashA}`, filename: 'a.mkv', videoSize: 42 })
  assert.equal(mapped[1].url, playUrlFor(ctx, hashB))
})

test('drops streams with no infohash, because they cannot be pinned', () => {
  const mapped = toStremioStreams([
    { name: 'direct', url: 'https://cdn.example/video.mkv' },
    { name: 'ok', infoHash: hashA },
  ] as never, ctx)
  assert.equal(mapped.length, 1)
  assert.equal(mapped[0].name, 'ok')
})

test('caps the list at MAX_STREAMS', () => {
  const many = Array.from({ length: 25 }, (_, i) => ({ name: `s${i}`, infoHash: i.toString(16).padStart(40, '0') }))
  assert.equal(toStremioStreams(many as never, ctx).length, MAX_STREAMS)
})

test('a notice is a single non-playable entry', () => {
  const [notice] = noticeStreams('No streams available right now.', ctx.origin)
  assert.equal(notice.name, 'Fetcherr')
  assert.equal(notice.description, 'No streams available right now.')
  assert.equal(notice.url, undefined)
  assert.equal(notice.externalUrl, ctx.origin)
})

test('pinning moves the requested hash first and keeps the rest as fallbacks', () => {
  const streams = [{ infoHash: hashA }, { infoHash: hashB }] as never
  const ordered = orderByPinnedHash(streams, hashB)
  assert.equal(ordered.length, 2)
  assert.equal((ordered[0] as { infoHash: string }).infoHash, hashB)
  assert.equal((ordered[1] as { infoHash: string }).infoHash, hashA)
})

test('an unknown pin keeps the ranked order rather than failing', () => {
  const streams = [{ infoHash: hashA }, { infoHash: hashB }] as never
  const ordered = orderByPinnedHash(streams, 'c'.repeat(40))
  assert.equal((ordered[0] as { infoHash: string }).infoHash, hashA)
})

// Hex infohashes are case-insensitive by definition, and extractHashFromStream
// lowercases everything it returns, so a pin that differs only in case must
// still match. Comparing raw would silently serve a different release.

test('an uppercase pin still puts the requested stream first', () => {
  const streams = [{ infoHash: hashA }, { infoHash: hashB }] as never
  const ordered = orderByPinnedHash(streams, hashB.toUpperCase())
  assert.equal(ordered.length, 2)
  assert.equal((ordered[0] as { infoHash: string }).infoHash, hashB)
  assert.equal((ordered[1] as { infoHash: string }).infoHash, hashA)
})

test('a mixed-case pin still puts the requested stream first', () => {
  const mixed = `${'B'.repeat(20)}${'b'.repeat(20)}`
  const streams = [{ infoHash: hashA }, { infoHash: hashB }] as never
  const ordered = orderByPinnedHash(streams, mixed)
  assert.equal((ordered[0] as { infoHash: string }).infoHash, hashB)
})

test('an empty upstream bingeGroup falls back to the per-hash group', () => {
  const mapped = toStremioStreams([
    { name: 'n', infoHash: hashA, behaviorHints: { bingeGroup: '' } },
  ] as never, ctx)
  assert.deepEqual(mapped[0].behaviorHints, { bingeGroup: `fetcherr-${hashA}` })
})

test('an empty filename and a zero videoSize are omitted, not emitted', () => {
  const mapped = toStremioStreams([
    { name: 'n', infoHash: hashA, behaviorHints: { filename: '', videoSize: 0 } },
  ] as never, ctx)
  assert.deepEqual(mapped[0].behaviorHints, { bingeGroup: `fetcherr-${hashA}` })
})

test('a token or hash needing encoding comes out encoded', () => {
  const hostile = { ...ctx, token: 'to/ken?a=b' }
  assert.equal(
    playUrlFor(hostile, 'ab/cd'),
    'https://streaming.example.net/stremio/to%2Fken%3Fa%3Db/play/movie/tt0111161/ab%2Fcd',
  )
})
