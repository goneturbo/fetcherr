import test from 'node:test'
import assert from 'node:assert/strict'
import { buildManifest, parseStremioStreamId } from '../src/stremio-addon.js'

test('the manifest declares a stream-only addon', () => {
  const m = buildManifest() as Record<string, unknown>
  assert.deepEqual(m.resources, ['stream'])
  assert.deepEqual(m.types, ['movie', 'series'])
  assert.deepEqual(m.idPrefixes, ['tt'])
  assert.deepEqual(m.catalogs, [])
  assert.equal(typeof m.id, 'string')
  assert.equal(typeof m.version, 'string')
})

test('parses a movie id and strips the .json suffix', () => {
  assert.deepEqual(parseStremioStreamId('movie', 'tt0111161.json'), {
    mediaType: 'movie', imdbId: 'tt0111161', externalId: 'tt0111161',
  })
})

test('parses a series id with season and episode', () => {
  assert.deepEqual(parseStremioStreamId('series', 'tt0903747:1:2.json'), {
    mediaType: 'series', imdbId: 'tt0903747', externalId: 'tt0903747:1:2',
  })
})

test('accepts a percent-encoded series id', () => {
  assert.deepEqual(parseStremioStreamId('series', 'tt0903747%3A1%3A2.json'), {
    mediaType: 'series', imdbId: 'tt0903747', externalId: 'tt0903747:1:2',
  })
})

test('rejects ids and types we do not serve', () => {
  assert.equal(parseStremioStreamId('movie', 'kitsu:12345.json'), null)
  assert.equal(parseStremioStreamId('channel', 'tt0111161.json'), null)
  assert.equal(parseStremioStreamId('series', 'tt0903747.json'), null)
  assert.equal(parseStremioStreamId('movie', 'tt0111161'), null)
  assert.equal(parseStremioStreamId('movie', '../../etc/passwd.json'), null)
  assert.equal(parseStremioStreamId('movie', 'tt0111161/../x.json'), null)
  assert.equal(parseStremioStreamId('series', 'tt0903747:1:2:3.json'), null)
})

// One title must have exactly one spelling. externalId keys provider stream
// caches, failed-play caches and per-title accounting, so every padded variant
// would buy its own cache miss and its own billed provider round-trip.

test('canonicalizes a zero-padded season and episode', () => {
  assert.equal(parseStremioStreamId('series', 'tt0903747:01:002.json')?.externalId, 'tt0903747:1:2')
})

test('canonicalizes the widest padding to the same id', () => {
  assert.equal(parseStremioStreamId('series', 'tt0903747:0001:0002.json')?.externalId, 'tt0903747:1:2')
})

test('accepts season 0, because specials really are season 0', () => {
  assert.deepEqual(parseStremioStreamId('series', 'tt0903747:0:1.json'), {
    mediaType: 'series', imdbId: 'tt0903747', externalId: 'tt0903747:0:1',
  })
})

test('rejects a padded IMDB id, which IMDB never issued', () => {
  assert.equal(parseStremioStreamId('movie', 'tt00111161.json'), null)
  assert.equal(parseStremioStreamId('movie', 'tt000111161.json'), null)
  assert.equal(parseStremioStreamId('movie', 'tt0000111161.json'), null)
  assert.equal(parseStremioStreamId('series', 'tt00903747:1:2.json'), null)
})

test('accepts an 8-digit IMDB id with no leading zero', () => {
  assert.deepEqual(parseStremioStreamId('movie', 'tt10872600.json'), {
    mediaType: 'movie', imdbId: 'tt10872600', externalId: 'tt10872600',
  })
})

test('returns null on non-string input instead of throwing', () => {
  assert.equal(parseStremioStreamId('movie', undefined as never), null)
  assert.equal(parseStremioStreamId('movie', null as never), null)
  assert.equal(parseStremioStreamId('movie', 123 as never), null)
  assert.equal(parseStremioStreamId('movie', {} as never), null)
})
