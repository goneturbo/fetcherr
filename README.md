# Fetcherr

Fetcherr is a Jellyfin-compatible streaming bridge for Infuse and VidHub that syncs watchlists into a library and resolves playback through Real-Debrid or TorBox streams returned by Stremio add-ons.

## Responsible Use

Fetcherr should only be used with media you own, have lawfully obtained, or are otherwise authorized to access.

## Requirements

- Docker
- TMDB API key
- Real-Debrid or TorBox API key
- Stremio add-on with playable streams (e.g. AIOStreams, Comet, Debridio)
- Optional: TVDB API key, Trakt client ID/secret, MDBList API key

## Quick Start

```yaml
services:
  fetcherr:
    image: ghcr.io/goneturbo/fetcherr:latest
    container_name: fetcherr
    restart: unless-stopped
    ports:
      - "9990:9990"
    environment:
      SERVER_URL: "http://YOUR_SERVER:9990"
    volumes:
      - ./data:/app/data
```

```bash
docker compose up -d
```

Open `http://YOUR_SERVER:9990/ui/setup-admin`, create an admin account, then enter your API keys and provider URLs in Settings.

## Setup

1. Deploy and start the container (see Quick Start above)
2. Open `http://YOUR_SERVER:9990/ui/setup-admin` — create admin account
3. Go to **Settings** and enter:
   - TMDB API key
   - Real-Debrid or TorBox API key, if using a supported debrid provider
   - One or more Stremio add-on manifest URLs (AIOStreams, Comet, Debridio, etc.)
4. Optionally add Trakt or MDBList credentials to sync watchlists
5. Connect your client (see below)

### Add-on Providers

Configure AIOStreams with your provider, then paste the manifest URL into Fetcherr Settings under **Add-on Provider URLs**. Recommended settings:

- **Only Cached:** On — Fetcherr streams cached content only; uncached will fail
- **Season/Episode Matching:** Off — breaks daily/late-night shows otherwise
- **Language filter:** Set to your preferred language for pre-filtered results
- In Fetcherr Settings, set **Stream Ranking** to **Provider Order** to preserve AIOStreams sort

Fetcherr also has mediated support for direct playable URLs returned by AIOStreams. For example, if your AIOStreams instance is configured with EasyNews and returns an EasyNews-backed stream URL, Fetcherr can unwrap and play that URL through the normal playback resolver. When AIOStreams returns mixed direct URL, TorBox, and Real-Debrid candidates, Fetcherr can try the direct URL first, then fall back to TorBox or Real-Debrid.

### Trakt connection limits

Trakt now limits free accounts to one connected third-party app at a time — connecting a second app (Kometa, a scrobbler, Fetcherr, etc.) revokes whichever app was connected first. This is a Trakt account policy, not a Fetcherr bug or bitrate/traffic issue; Fetcherr detects the resulting token revocation and prompts you to reconnect in **Settings**, but it can't avoid consuming a connection slot.

If you already use another Trakt-connected app and don't want Fetcherr to compete for that one free slot, use **MDBList** as your sync source instead — Fetcherr supports MDBList lists and watchlists with no Trakt connection required.

## Search Results

Fetcherr exposes Jellyfin-compatible search results from both the synced library and configured Stremio add-ons. This lets clients find playable movies and shows returned by providers such as AIOStreams, then open them through the same Fetcherr playback resolver used by library items.

For shows, Fetcherr hydrates search results into seasons and aired episodes so clients can drill into a result before playback. Future or unaired episodes are hidden from search drill-downs using the same visibility rules as the local library.

## Media Source Selection

Fetcherr can optionally expose multiple cached stream candidates as Jellyfin media sources. Infuse presents these as selectable versions before playback (long press on play button), which is useful when a provider returns multiple quality, codec, or source options for the same movie or episode.

Enable **Media source selection** in Settings to offer source choices. By default Fetcherr keeps automatic playback behavior and selects a stream itself. The Settings UI also lets you choose whether to offer 5, 10, or 20 sources.

## Connecting Infuse

Add Fetcherr as a Jellyfin server in Infuse with your server URL and a Fetcherr account. Enable **Library Mode** and **Auto Scan** for the normal library connection.

### Infuse Search

Fetcherr can also be added to Infuse a second time for broad search:

1. In Infuse, add a second Jellyfin server pointing to the same Fetcherr URL
2. Set the connection **Path** to `/search`
3. Do **not** enable Library Mode on this connection
4. Sign in with the same Fetcherr account

In Fetcherr Settings:
- Enable **Stremio Search** globally and ensure the user account has search enabled
- Enable **Media Source Selection** — required for search playback to work; without it Infuse will show "Unexpected Server Response" when attempting to play search results

Search results can always include synced Fetcherr library items. When Stremio search is enabled, results can also include Cinemeta, Trakt, or configured add-on catalogs such as AIOStreams. Fetcherr uses TMDB metadata for local catalog entries and search-result details.

> [!NOTE]
> The `/search` endpoint presents a separate Jellyfin server identity with no library folders or library items. Infuse can use that second connection for search results, while the normal connection remains available for Library Mode browsing and scanning.

### Experimental Infuse version discovery

This branch also preserves a separate Infuse workaround for version discovery. Some Infuse library views only request compact list items and do not request their detail records, so Fetcherr never gets the opportunity to resolve and expose the real Stremio-backed versions. When **Media source selection** is enabled, Fetcherr advertises two lightweight discovery markers on movie and episode list items; when Infuse follows up with the detail or playback request, those markers are replaced by the real filtered and renamed playable sources. Series folders remain non-playable, so discovery markers belong on their episode items rather than on the series itself. The markers are not separate transcodes or quality profiles, and the `A`/`B` names are discovery signals only. Library enumeration performs no provider probing; actual sources are resolved just in time when Infuse requests them. Provider responses are cached briefly and duplicate in-flight probes are coalesced. This is client-specific experimental behavior and should be evaluated independently before proposing it upstream.

## Connecting VidHub

Add Fetcherr as a Jellyfin server in VidHub. If prompted for an Emby endpoint, use `http://YOUR_SERVER:9990/emby`.

## Jellyfin playback probe

`scripts/integration/jellyfin-playback-probe.mjs` is a client-side integration probe. It exercises a Jellyfin-compatible endpoint (Fetcherr by default, or a real Jellyfin server) through authentication, search, playback-info/media-source discovery, redirect handling, and a small provider byte request. It does not provide a mock Jellyfin server.

Run it with `npm run probe:jellyfin`. Set `JELLYFIN_BASE_URL` to target another endpoint and use the `JELLYFIN_PROBE_*` variables shown by `npm run probe:jellyfin -- --help` to select media and playback checks.

To probe a specific episode, set the series, season, and episode explicitly:

```bash
JELLYFIN_PROBE_MEDIA=episode \
JELLYFIN_PROBE_SERIES="Series name" \
JELLYFIN_PROBE_SEASON=2 \
JELLYFIN_PROBE_EPISODE=13 \
npm run probe:jellyfin
```

## Environment

| Variable | Description |
|---|---|
| `SERVER_URL` | External base URL used for playback redirects (required) |
| `PLAYBACK_SIGNING_SECRET` | Optional secret used to sign short-lived playback URLs. If omitted, Fetcherr generates and stores a persistent random secret in SQLite. |
| `MDBLIST_MAX_ITEMS` | Max items per MDBList list (default: 1000) |

All other configuration is managed through the Settings UI and stored in the database.
