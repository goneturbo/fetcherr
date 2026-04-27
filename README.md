# Fetcherr

Fetcherr gives Infuse and VidHub a Stremio-like streaming experience using your Trakt or MDBList library sources and Real-Debrid, without needing a traditional media server or local mount.

It acts as a lightweight bridge between list sources, Real-Debrid, provider addons, and Jellyfin-compatible clients like Infuse and VidHub. Fetcherr builds a client-ready library from your optional Trakt watchlists, selected Trakt lists, and MDBList list URLs, watches for new episodes and movies as they become available, and exposes them through a Jellyfin-compatible interface.

The goal is simple: open Infuse, browse your library, and press play. Fetcherr handles stream discovery, prefers cached Real-Debrid results, and automatically picks the best match instead of making you choose from a stream list every time.

## What It Does

- Syncs movies and shows from optional Trakt watchlists, selected Trakt lists, and MDBList list URLs
- Exposes a Jellyfin-style library for Infuse and VidHub
- Resolves playback through direct providers such as Torrentio and Debridio
- Verifies ambiguous audio with `ffprobe` when needed

## How It Differs

- Unlike Stremio and Stremio-style addons, Fetcherr is built around Jellyfin-compatible clients such as Infuse and VidHub.
- Unlike WebDAV, `rclone`, or mounted-library workflows, it does not rely on local mounts or Infuse scraping metadata on its own.
- Unlike traditional media servers, it does not require you to maintain a local media collection.
- To keep your Real-Debrid library cleaner, Fetcherr resolves cached links for playback and removes the associated torrent hash afterward.

## Requirements

- Docker
- A TMDB API key
- A Real-Debrid API key
- Optional: TVDB API key for episode-image fallback
- Optional: Trakt client ID and secret

## Container Image

GitHub Actions builds and publishes a container image to GitHub Container Registry on pushes to `main`, version tags, and manual runs.

Use:

```text
ghcr.io/goneturbo/fetcherr:latest
```

## Docker Compose

1. Create a `docker-compose.yml`:

```yaml
services:
  fetcherr:
    image: ghcr.io/goneturbo/fetcherr:latest
    container_name: fetcherr
    restart: unless-stopped
    ports:
      - "9990:9990"
    environment:
      PORT: "9990"
      DATABASE_PATH: /app/data/fetcherr.db
      SERVER_NAME: "${SERVER_NAME:-Fetcherr}"
      SERVER_ID: "${SERVER_ID:-fetcherr-001}"
      SERVER_URL: "${SERVER_URL:-http://localhost:9990}"
    volumes:
      - ./data:/app/data
```

2. Start the container:

```bash
docker compose up -d
```

3. Open:

```text
http://YOUR_SERVER:9990/ui/setup-admin
```

4. Create the first admin account.
5. Open Settings and enter your API keys, provider URLs, and any Trakt settings you want to use.

## Kubernetes

1. Open [`deploy/kubernetes/fetcherr.yaml`](deploy/kubernetes/fetcherr.yaml).
2. Set `SERVER_URL`.
3. Apply the manifest:

```bash
kubectl apply -f deploy/kubernetes/fetcherr.yaml
```

## Usage

- Complete first-run setup in `/ui/setup-admin`
- Configure providers and preferences in `/ui/settings`
- Add Fetcherr to Infuse or VidHub as a Jellyfin server
- Browse and play from your client of choice
- Use `/ui/logs` when sync or playback fails

## Environment

| Variable | Required | Description |
| --- | --- | --- |
| `SERVER_URL` | Yes | External base URL used for playback redirects |
| `MDBLIST_LISTS` | No | Optional comma- or newline-separated public MDBList URLs. Can also be configured in Settings. |

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
- VidHub support has been validated against the Jellyfin-compatible `/emby` API surface, but some client-specific edge cases may still surface
- Trakt Smart Lists are not currently supported because Trakt's public lists API does not expose them

## FAQ

### Does Fetcherr follow my Stremio add-on settings, or does it choose streams on its own?

Both.

Your add-on settings still matter because they control which streams each provider returns. Fetcherr then ranks those returned streams using its own playback criteria, such as Real-Debrid cache availability, language preference, match quality, and format compatibility.

If you configure multiple provider URLs, Fetcherr also respects their order. Earlier providers are tried first, and Fetcherr then picks the best candidate within that provider's results before moving on to the next one.
