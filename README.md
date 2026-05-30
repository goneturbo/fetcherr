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

If you're switching to TorBox and want to support continued Fetcherr development, consider signing up with this referral link: https://torbox.app/subscription?referral=517608ee-35cb-458f-be00-850a2543a4f0

## Setup

1. Deploy and start the container (see Quick Start above)
2. Open `http://YOUR_SERVER:9990/ui/setup-admin` — create admin account
3. Go to **Settings** and enter:
   - TMDB API key
   - Real-Debrid or TorBox API key, if using a debrid provider
   - One or more Stremio add-on manifest URLs (AIOStreams, Comet, Debridio, etc.)
4. Optionally add Trakt or MDBList credentials to sync watchlists
5. Connect your client (see below)

### AIOStreams

Configure AIOStreams with your provider, then paste the manifest URL into Fetcherr Settings under **Add-on Provider URLs**. Recommended settings:

- **Only Cached:** On — Fetcherr streams cached content only; uncached will fail
- **Season/Episode Matching:** Off — breaks daily/late-night shows otherwise
- **Language filter:** Set to your preferred language for pre-filtered results
- In Fetcherr Settings, set **Stream Ranking** to **Provider Order** to preserve AIOStreams sort

Fetcherr also has mediated support for direct playable URLs returned by AIOStreams. For example, if your AIOStreams instance is configured with EasyNews and returns an EasyNews-backed stream URL, Fetcherr can unwrap and play that URL through the normal playback resolver. When AIOStreams returns mixed direct URL, TorBox, and Real-Debrid candidates, Fetcherr can try the direct URL first, then fall back to TorBox or Real-Debrid.

## Search Results

Fetcherr exposes Jellyfin-compatible search results from both the synced library and configured Stremio add-ons. This lets clients find playable movies and shows returned by providers such as AIOStreams, then open them through the same Fetcherr playback resolver used by library items.

For shows, Fetcherr hydrates search results into seasons and aired episodes so clients can drill into a result before playback. Future or unaired episodes are hidden from search drill-downs using the same visibility rules as the local library.

## Media Source Selection

Fetcherr can optionally expose multiple cached stream candidates as Jellyfin media sources. Infuse presents these as selectable versions before playback (long press on play button), which is useful when a provider returns multiple quality, codec, or source options for the same movie or episode.

Enable **Media source selection** in Settings to offer source choices. By default Fetcherr keeps automatic playback behavior and selects a stream itself. The Settings UI also lets you choose whether to offer 5 or 10 sources.

## Connecting Infuse

Add Fetcherr as a Jellyfin server in Infuse with your server URL and a Fetcherr account. Enable **Library Mode**, **Auto Scan**, and **Install InfuseSync Plugin**.

## Connecting VidHub

Add Fetcherr as a Jellyfin server in VidHub. If prompted for an Emby endpoint, use `http://YOUR_SERVER:9990/emby`.

## Environment

| Variable | Description |
|---|---|
| `SERVER_URL` | External base URL used for playback redirects (required) |
| `PLAYBACK_SIGNING_SECRET` | Optional secret used to sign short-lived playback URLs. If omitted, Fetcherr generates and stores a persistent random secret in SQLite. |
| `MDBLIST_MAX_ITEMS` | Max items per MDBList list (default: 1000) |

All other configuration is managed through the Settings UI and stored in the database.
