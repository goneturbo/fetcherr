import test from 'node:test'
import assert from 'node:assert/strict'
import { episodeSpecificityScore, type Stream } from '../src/sootio.js'

const score = (filename: string) => episodeSpecificityScore({ name: '', title: filename, behaviorHints: { filename } } as Stream)

test('a single episode scores the same however the release writes it', () => {
  // Real filenames from Torrentio and Comet that used to score as "not an episode".
  for (const filename of [
    'Dark.Matter.S01E01.2160p.WEB.mkv',
    'DARK Matter - S01 E01 - Pilot, Part 1 of 2 (720p Web-DL).mp4',
    'Game.of.Thrones.S01.Ep01.1080p.BluRay.DTS.x264-ESiR.mkv',
    'House of the Dragon (2022) S01EP01.mkv',
    'Arcane - S01.E01 - Welcome to the Playground 2160p UHD BDRip.mkv',
    'Game.of.Thrones.S1E01.Winter.Is.Coming.1080p.BrRip.x264.mkv',
    'Bleach.2004.S01E001.1080p.Hami.WEB-DL.H264.AAC-LelveTV.mp4',
    "One Piece - S01E0001 - I'm Luffy!.mkv",
  ]) assert.equal(score(filename), 4, filename)
})

test('an absolute number or a numeric title after the episode is not a range', () => {
  assert.equal(score('Bleach (2004) - S01E01 - 001 - The Day I Became a Shinigami [BD].mkv'), 4)
  assert.equal(score('The Pitt - S01E01 - 700 2160p.DV.HDR.x265-Amen.mkv'), 4)
  assert.equal(score('Game.Of.Thrones.S01.E01.2011.720p.BluRay.mkv'), 4)
})

test('episode ranges and season packs still rank below a single episode', () => {
  assert.ok(score('Show.S01E01-E03.1080p.mkv') < 4)
  assert.ok(score('Show S01 E01 - 03 1080p.mkv') < 4)
  assert.ok(score('Show.S01.1080p.WEB') < 0)
  assert.ok(score('Show Season 1 Complete 1080p') < 0)
})
