# Fetcherr

Fetcherr gives Infuse a Stremio-like streaming experience using your Trakt library and Real-Debrid, without needing a traditional media server or local mount.

It acts as a lightweight bridge between Trakt, Real-Debrid, provider addons, and Infuse. Fetcherr builds an Infuse-ready library from your Trakt watchlists and selected lists, watches for new episodes and movies as they become available, and exposes them through a Jellyfin-compatible interface.

The goal is simple: open Infuse, browse your library, and press play. Fetcherr handles stream discovery, prefers cached Real-Debrid results, and automatically picks the best match instead of making you choose from a stream list every time.

## What It Does

- Syncs movies and shows from Trakt watchlists and selected Trakt lists
- Exposes a Jellyfin-style library for Infuse
- Resolves playback through direct providers such as Torrentio and Debridio
- Verifies ambiguous audio with `ffprobe` when needed

## How It Differs

- Unlike Stremio and Stremio-style addons, Fetcherr is built around Infuse as the primary client.
- Unlike WebDAV, `rclone`, or mounted-library workflows, it does not rely on local mounts or Infuse scraping metadata on its own.
- Unlike traditional media servers, it does not require you to maintain a local media collection.
- To keep your Real-Debrid library cleaner, Fetcherr resolves cached links for playback and removes the associated torrent hash afterward.

## Requirements

- TMDB API key
- Real-Debrid API key
- Trakt client ID and secret
- A Trakt account

## Setup

1. Copy `.env.example` to `.env`
2. Fill in your API keys and Trakt username
3. Optionally set:
   - `UI_USERNAME`
   - `UI_PASSWORD`
   - `STREAM_PROVIDER_URLS`
   - `ENGLISH_STREAM_MODE`
4. Start the app:

```bash
docker compose up -d --build
```

5. Open:

```text
http://YOUR_SERVER:9990/ui/setup
```

6. Connect Trakt
7. Open Settings and configure provider URLs if needed

## Usage

- Connect Trakt in `/ui/setup`
- Configure providers and preferences in `/ui/settings`
- Add Fetcherr to Infuse as a Jellyfin server
- Browse and play from Infuse
- Use `/ui/logs` when sync or playback fails

## Environment

| Variable | Required | Description |
| --- | --- | --- |
| `TMDB_API_KEY` | Yes | TMDB metadata and artwork |
| `RD_API_KEY` | Yes | Real-Debrid API access |
| `TRAKT_CLIENT_ID` | Yes | Trakt OAuth client ID |
| `TRAKT_CLIENT_SECRET` | Yes | Trakt OAuth client secret |
| `TRAKT_USERNAME` | Yes | Trakt username to sync from |
| `TRAKT_LISTS` | No | Comma-separated Trakt list slugs to sync in addition to watchlists |
| `SERVER_URL` | Yes | External base URL used for playback redirects |
| `UI_USERNAME` | No | Web UI login username |
| `UI_PASSWORD` | No | Web UI login password; leave blank to disable UI auth |
| `AIOSTREAM_URL` | No | Optional legacy AIOStreams manifest or base URL |
| `STREAM_PROVIDER_URLS` | No | Optional provider URLs, one per line |
| `ENGLISH_STREAM_MODE` | No | `off`, `prefer`, or `require` |

## Tips

> [!TIP]
> Provider order matters. Earlier providers are tried first.

> [!IMPORTANT]
> `ENGLISH_STREAM_MODE=require` is the strictest option for English audio.

> [!NOTE]
> Full manifest URLs are accepted and normalized automatically. `SOOTIO_URL` is still supported as a backward-compatible alias for `AIOSTREAM_URL`.

> [!WARNING]
> Real-Debrid multi-location and IP restrictions still apply.

## Current Limitations

- Anime has not been validated thoroughly yet
- Some metadata may still be enriched by Infuse itself
- `Logo` image behavior may vary by client
