import test from 'node:test'
import assert from 'node:assert/strict'
import { extractHashFromStream } from '../src/sootio.js'

const HASH = 'a'.repeat(40)

test('extracts an infohash from an AIOStreams playback URL', () => {
  const blob = Buffer.from(JSON.stringify({ hash: HASH })).toString('base64')
  const url = `http://192.168.87.33:3002/api/v1/debrid/playback/auth/${blob}/f.mkv`
  assert.equal(extractHashFromStream({ url }), HASH)
})

test('falls back to the infoHash field', () => {
  assert.equal(extractHashFromStream({ infoHash: HASH.toUpperCase() }), HASH)
})

test('returns null when nothing carries a hash', () => {
  assert.equal(extractHashFromStream({ url: 'https://example.test/video.mkv' }), null)
})
