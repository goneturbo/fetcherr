#!/usr/bin/env node

const baseUrl = (process.env.FETCHERR_URL || 'http://127.0.0.1:9990').replace(/\/$/, '')
const mediaKind = (process.env.JELLYFIN_MOCK_MEDIA || 'movie').toLowerCase()
const movieSearchTerm = process.env.JELLYFIN_MOCK_MOVIE || 'Killers of the Flower Moon'
const seriesSearchTerm = process.env.JELLYFIN_MOCK_SERIES || 'Game of Thrones'
const requestedSourceIndex = Number.parseInt(process.env.JELLYFIN_MOCK_SOURCE_INDEX || '0', 10)
const rangeHeader = process.env.JELLYFIN_MOCK_RANGE || 'bytes=0-1023'
const minMediaSources = Number.parseInt(process.env.JELLYFIN_MOCK_MIN_SOURCES || '2', 10)
const maxMediaSources = Number.parseInt(process.env.JELLYFIN_MOCK_MAX_SOURCES || '10', 10)

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`Usage: npm run mock:jellyfin

Environment:
  FETCHERR_URL                  Fetcherr base URL, default http://127.0.0.1:9990
  JELLYFIN_TOKEN                Existing Jellyfin access token
  JELLYFIN_USERNAME/PASSWORD    Credentials used when no token is supplied
  JELLYFIN_MOCK_MEDIA           movie, episode, or all; default movie
  JELLYFIN_MOCK_MOVIE           Movie search term; default Killers of the Flower Moon
  JELLYFIN_MOCK_SERIES          Series search term; default Game of Thrones
  JELLYFIN_MOCK_SOURCE_INDEX    MediaSource index to play; default 0
  JELLYFIN_MOCK_MAX_SOURCES     Maximum expected MediaSources; default 10
`)
  process.exit(0)
}

if (!['movie', 'episode', 'all'].includes(mediaKind)) {
  fail('JELLYFIN_MOCK_MEDIA must be movie, episode, or all')
}

function fail(message) {
  console.error(`mock-jellyfin: ${message}`)
  process.exit(1)
}

async function request(path, options = {}) {
  const url = path.startsWith('http') ? path : `${baseUrl}${path}`
  const res = await fetch(url, options)
  const text = await res.text()
  if (!res.ok) {
    throw new Error(`${options.method || 'GET'} ${url} returned ${res.status}: ${text.slice(0, 500)}`)
  }
  return text ? JSON.parse(text) : {}
}

async function authenticate() {
  if (process.env.JELLYFIN_TOKEN) return process.env.JELLYFIN_TOKEN

  const username = process.env.JELLYFIN_USERNAME
  const password = process.env.JELLYFIN_PASSWORD
  if (!username || !password) {
    fail('set JELLYFIN_TOKEN, or set JELLYFIN_USERNAME and JELLYFIN_PASSWORD')
  }

  const auth = await request('/Users/AuthenticateByName', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-emby-authorization': 'MediaBrowser Client="Fetcherr Mock", Device="CLI", DeviceId="fetcherr-mock", Version="1.0"',
    },
    body: JSON.stringify({ Username: username, Pw: password }),
  })

  if (!auth.AccessToken) fail('authentication response did not include AccessToken')
  return auth.AccessToken
}

async function jellyfin(token, path) {
  return request(path, {
    headers: {
      'x-emby-token': token,
      'x-emby-client': 'Fetcherr Mock',
      'x-emby-device-name': 'CLI',
      'x-emby-device-id': 'fetcherr-mock',
    },
  })
}

async function getUserId(token) {
  if (process.env.JELLYFIN_USER_ID) return process.env.JELLYFIN_USER_ID
  const user = await jellyfin(token, '/Users/Me')
  if (!user.Id) fail('/Users/Me did not return a user Id')
  return user.Id
}

function assertMediaSources(itemName, sources) {
  if (!Array.isArray(sources) || sources.length === 0) {
    fail(`${itemName} did not return any MediaSources`)
  }
  if (Number.isFinite(minMediaSources) && sources.length < minMediaSources) {
    fail(`${itemName} returned ${sources.length} MediaSources; expected at least ${minMediaSources}`)
  }
  if (Number.isFinite(maxMediaSources) && sources.length > maxMediaSources) {
    fail(`${itemName} returned ${sources.length} MediaSources; expected at most ${maxMediaSources}`)
  }
  for (const source of sources) {
    if (!source.Path) fail(`${itemName} returned a MediaSource without Path`)
    if (!source.Id) fail(`${itemName} returned a MediaSource without Id`)
  }
}

async function selectMovie(token, userId) {
  const search = await jellyfin(
    token,
    `/Users/${encodeURIComponent(userId)}/Items?SearchTerm=${encodeURIComponent(movieSearchTerm)}&IncludeItemTypes=Movie&Recursive=true&Limit=10`,
  )
  const item = search.Items?.find(candidate => candidate.Type === 'Movie' && candidate.IsPlayable) ?? search.Items?.[0]
  if (!item) fail(`movie search returned no results for "${movieSearchTerm}"`)
  return item
}

async function selectEpisode(token, userId) {
  const search = await jellyfin(
    token,
    `/Users/${encodeURIComponent(userId)}/Items?SearchTerm=${encodeURIComponent(seriesSearchTerm)}&IncludeItemTypes=Series&Recursive=true&Limit=10`,
  )
  const series = search.Items?.find(candidate => candidate.Type === 'Series') ?? search.Items?.[0]
  if (!series) fail(`series search returned no results for "${seriesSearchTerm}"`)

  const seasons = await jellyfin(
    token,
    `/Users/${encodeURIComponent(userId)}/Items?ParentId=${encodeURIComponent(series.Id)}&IncludeItemTypes=Season&Limit=100`,
  )
  const season = seasons.Items?.find(candidate => candidate.IndexNumber === 1) ?? seasons.Items?.[0]
  if (!season) fail(`series "${series.Name}" returned no seasons`)

  const episodes = await jellyfin(
    token,
    `/Users/${encodeURIComponent(userId)}/Items?ParentId=${encodeURIComponent(season.Id)}&IncludeItemTypes=Episode&Limit=100`,
  )
  const episode = episodes.Items?.find(candidate => candidate.ParentIndexNumber === 1 && candidate.IndexNumber === 1) ?? episodes.Items?.[0]
  if (!episode) fail(`season "${season.Name}" returned no episodes`)
  return episode
}

async function verifyPlayback(token, item, label) {
  const info = await jellyfin(token, `/Items/${encodeURIComponent(item.Id)}/PlaybackInfo`)
  assertMediaSources(item.Name, info.MediaSources)

  const sourceIndex = Number.isFinite(requestedSourceIndex)
    ? Math.max(0, Math.min(requestedSourceIndex, info.MediaSources.length - 1))
    : 0
  const source = info.MediaSources[sourceIndex]

  const redirect = await fetch(source.Path, {
    redirect: 'manual',
    headers: { range: rangeHeader },
  })
  if (redirect.status !== 302) {
    const text = await redirect.text()
    fail(`${label} source "${source.Name}" did not redirect to provider; status=${redirect.status} body=${text.slice(0, 300)}`)
  }
  const location = redirect.headers.get('location')
  if (!location) fail(`${label} source "${source.Name}" returned 302 without Location`)

  const media = await fetch(location, {
    redirect: 'follow',
    headers: { range: rangeHeader },
    signal: AbortSignal.timeout(60_000),
  })
  const bytes = Buffer.from(await media.arrayBuffer()).length
  if (![200, 206].includes(media.status)) {
    fail(`${label} provider URL returned ${media.status}`)
  }
  if (bytes <= 0) fail(`${label} provider URL returned no bytes`)

  console.log(JSON.stringify({
    ok: true,
    label,
    item: {
      id: item.Id,
      name: item.Name,
      type: item.Type,
    },
    mediaSources: info.MediaSources.map(candidate => ({
      id: candidate.Id,
      name: candidate.Name,
      path: new URL(candidate.Path).pathname,
      container: candidate.Container,
    })),
    selected: {
      index: sourceIndex,
      id: source.Id,
      name: source.Name,
      redirectHost: new URL(location).host,
      status: media.status,
      contentType: media.headers.get('content-type'),
      contentRange: media.headers.get('content-range'),
      bytes,
    },
  }, null, 2))
}

const token = await authenticate()
const userId = await getUserId(token)

if (mediaKind === 'movie' || mediaKind === 'all') {
  const movie = await selectMovie(token, userId)
  await verifyPlayback(token, movie, 'movie')
}

if (mediaKind === 'episode' || mediaKind === 'all') {
  const episode = await selectEpisode(token, userId)
  await verifyPlayback(token, episode, 'episode')
}
