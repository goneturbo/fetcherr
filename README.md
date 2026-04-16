
# fetcherr
Jellyfin-compatible bridge for Infuse with Trakt library sync and Real-Debrid-backed stream resolution.
=======
# Fetcherr

Fetcherr exposes a Jellyfin-like API for Infuse and resolves playback through Real-Debrid-backed providers.

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

## Notes

- `UI_PASSWORD` enables login protection for the web UI
- `STREAM_PROVIDER_URLS` accepts one provider URL per line
- full manifest URLs are accepted and normalized automatically
- `SOOTIO_URL` is optional and kept only as a legacy fallback

## Current Limitations

- Anime has not been validated thoroughly yet
- Some metadata may still be enriched by Infuse itself
- `Logo` image behavior may vary by client

