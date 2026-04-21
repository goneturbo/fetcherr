# Fetcherr

Fetcherr gives Infuse a Stremio-like streaming experience using your Trakt library and Real-Debrid, without needing a traditional media server or local mount.

It acts as a lightweight bridge between Trakt, Real-Debrid, provider addons, and Infuse. Fetcherr builds an Infuse-ready library from your optional Trakt watchlists and selected lists, watches for new episodes and movies as they become available, and exposes them through a Jellyfin-compatible interface.

The goal is simple: open Infuse, browse your library, and press play. Fetcherr handles stream discovery, prefers cached Real-Debrid results, and automatically picks the best match instead of making you choose from a stream list every time.

## What It Does

- Syncs movies and shows from optional Trakt watchlists and selected Trakt lists
- Exposes a Jellyfin-style library for Infuse
- Resolves playback through direct providers such as Torrentio and Debridio
- Verifies ambiguous audio with `ffprobe` when needed

## How It Differs

- Unlike Stremio and Stremio-style addons, Fetcherr is built around Infuse as the primary client.
- Unlike WebDAV, `rclone`, or mounted-library workflows, it does not rely on local mounts or Infuse scraping metadata on its own.
- Unlike traditional media servers, it does not require you to maintain a local media collection.
- To keep your Real-Debrid library cleaner, Fetcherr resolves cached links for playback and removes the associated torrent hash afterward.

## Requirements

- Docker
- A TMDB API key
- A Real-Debrid API key
- Optional: TVDB API key for episode-image fallback
- Optional: Trakt client ID and secret

## Get the Code

`git clone` creates the `fetcherr` directory automatically, so you do not need to run `mkdir` first.

```bash
git clone https://github.com/goneturbo/fetcherr.git
cd fetcherr
```

## Setup

1. Copy `.env.example` to `.env`
2. Adjust `SERVER_URL` if needed
3. Start the app:

```bash
docker compose up -d --build
```

4. Open:

```text
http://YOUR_SERVER:9990/ui/setup-admin
```

5. Create the first admin account
6. Open Settings and enter your API keys, provider URLs, and any Trakt settings you want to use

## Usage

- Complete first-run setup in `/ui/setup-admin`
- Configure providers and preferences in `/ui/settings`
- Add Fetcherr to Infuse as a Jellyfin server
- Browse and play from Infuse
- Use `/ui/logs` when sync or playback fails

## Environment

| Variable | Required | Description |
| --- | --- | --- |
| `SERVER_URL` | Yes | External base URL used for playback redirects |

## Tips

> [!TIP]
> Provider order matters. Earlier providers are tried first.

> [!IMPORTANT]
> Stream addons must return stream URLs containing a usable torrent hash. Fetcherr extracts that hash and resolves playback through Real-Debrid. Proxy-only addon URLs that hide the hash are not compatible.

> [!IMPORTANT]
> `ENGLISH_STREAM_MODE=require` is the strictest option for English audio.

> [!NOTE]
> Most runtime configuration now lives in the web UI and is stored in Fetcherr's database. `.env` is intentionally minimal and mainly used to define the external server URL.

> [!WARNING]
> Real-Debrid multi-location and IP restrictions still apply.

## Current Limitations

- Anime has not been validated thoroughly yet
- Some metadata may still be enriched by Infuse itself
- `Logo` image behavior may vary by client
- Trakt Smart Lists are not currently supported because Trakt's public lists API does not expose them
