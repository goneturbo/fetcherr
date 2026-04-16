# Fetcherr

Jellyfin-compatible bridge for Infuse with Trakt library sync and Real-Debrid-backed stream resolution.

## What It Does

- Syncs movies and shows from Trakt watchlists and selected Trakt lists
- Exposes a Jellyfin-style library for Infuse
- Resolves playback through direct providers such as Torrentio and Debridio
- Verifies ambiguous audio with `ffprobe` when needed

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

<div style="border-left:4px solid #22c55e; padding:10px 14px; margin:12px 0; background:rgba(34,197,94,.08); border-radius:8px;">
  <strong>Tip</strong><br>
  Provider order matters. Earlier providers are tried first.
</div>

<div style="border-left:4px solid #a855f7; padding:10px 14px; margin:12px 0; background:rgba(168,85,247,.08); border-radius:8px;">
  <strong>Audio</strong><br>
  <code>ENGLISH_STREAM_MODE=require</code> is the strictest option for English audio.
</div>

<div style="border-left:4px solid #60a5fa; padding:10px 14px; margin:12px 0; background:rgba(96,165,250,.08); border-radius:8px;">
  <strong>Compatibility</strong><br>
  Full manifest URLs are accepted and normalized automatically. <code>SOOTIO_URL</code> is still supported as a backward-compatible alias for <code>AIOSTREAM_URL</code>.
</div>

<div style="border-left:4px solid #f59e0b; padding:10px 14px; margin:12px 0; background:rgba(245,158,11,.08); border-radius:8px;">
  <strong>Real-Debrid</strong><br>
  Real-Debrid multi-location and IP restrictions still apply.
</div>

## Current Limitations

- Anime has not been validated thoroughly yet
- Some metadata may still be enriched by Infuse itself
- `Logo` image behavior may vary by client
