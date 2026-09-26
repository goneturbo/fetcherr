import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

process.env.DATABASE_PATH = join(tmpdir(), `fetcherr-unaired-seasons-${randomUUID()}.db`)
// Without a TMDB key ensureShowSeasonsCached leaves the seeded rows alone.
process.env.TMDB_API_KEY = ''
process.env.TVDB_API_KEY = ''

const db = await import('../src/db.js')
const { jellyfinRoutes, resolveJellyfinUser } = await import('../src/jellyfin/index.js')

const showId = (tmdbId: number) => `00000000-0000-4000-8001-${tmdbId.toString(16).padStart(12, '0')}`

const admin = db.createUser('admin', 'pw', 'admin', 'unrestricted')
resolveJellyfinUser({ 'x-emby-token': 'no-such-token' })
const token = randomUUID()
db.getDb()
  .prepare(`INSERT INTO jellyfin_tokens (token, user_id, expires_at) VALUES (?, ?, ?)`)
  .run(token, admin.id, Date.now() + 3_600_000)

function seedShow(tmdbId: number, seasons: Record<number, string[]>) {
  db.upsertShow({
    tmdbId, imdbId: `tt${tmdbId}`, tvdbId: 0, mediaLanguage: 'en', title: `Show ${tmdbId}`, year: 2020,
    overview: '', posterPath: '', backdropPath: '', logoPath: '', genres: '[]', status: 'Ended',
    numSeasons: Object.keys(seasons).length, popularity: 0, officialRating: '', communityRating: 0,
    studiosJson: '[]', tagsJson: '[]', castJson: '[]', syncedAt: new Date().toISOString(),
  })
  for (const [seasonNumber, airDates] of Object.entries(seasons)) {
    db.upsertSeason({
      showTmdbId: tmdbId, seasonNumber: Number(seasonNumber), name: `Season ${seasonNumber}`, overview: '',
      posterPath: '', episodeCount: airDates.length, airDate: airDates[0], syncedAt: new Date().toISOString(),
    })
    airDates.forEach((airDate, i) => db.upsertEpisode({
      showTmdbId: tmdbId, seasonNumber: Number(seasonNumber), episodeNumber: i + 1, name: '', overview: '',
      stillPath: '', runtimeMins: 0, communityRating: 0, airDate, syncedAt: new Date().toISOString(),
    }))
  }
}

// Aired season 1, announced season 2.
seedShow(1001, { 1: ['2020-01-01', '2020-01-08'], 2: ['2999-01-01'] })
// Announced but not yet premiered.
seedShow(1002, { 1: ['2999-12-25'] })

async function get(url: string) {
  const app = Fastify()
  await app.register(jellyfinRoutes, {} as never)
  const res = await app.inject({ method: 'GET', url, headers: { 'x-emby-token': token } })
  await app.close()
  assert.equal(res.statusCode, 200, url)
  return res.json()
}

test('seasons with no aired episodes are not listed', async () => {
  const seasons = await get(`/Shows/${showId(1001)}/Seasons?userId=${admin.id}`)
  assert.deepEqual(seasons.Items.map((s: { IndexNumber: number }) => s.IndexNumber), [1])

  const unpremiered = await get(`/Shows/${showId(1002)}/Seasons?userId=${admin.id}`)
  assert.equal(unpremiered.TotalRecordCount, 0)
})

test('a show with no aired episodes reports no children', async () => {
  assert.equal((await get(`/Items/${showId(1002)}?userId=${admin.id}`)).ChildCount, 0)
  assert.equal((await get(`/Items/${showId(1001)}?userId=${admin.id}`)).ChildCount, 2)
})
