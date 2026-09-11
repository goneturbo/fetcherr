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

## Stremio Add-on

Fetcherr can also work in the other direction and act as a Stremio add-on, so friends can watch from any Stremio client instead of only from Infuse or VidHub. The manifest declares one resource, `stream`, and nothing else: catalogs, artwork and metadata come from Cinemeta, and Stremio only asks Fetcherr for streams. That keeps the add-on small and means it never has to mirror a library.

Access is off for every account until an admin turns it on. In **Settings**, the Users table has a **Stremio Access** column with a checkbox and three buttons. **Create URL** issues an install URL for that account, **Copy install URL** puts it on the clipboard, and **Rotate** replaces it. The checkbox is `stremio_enabled`, the kill switch: unticking it stops that account streaming immediately while keeping its URL, so you can turn access off for an evening without reissuing anything. **Revoke** does both, clearing the URL and the flag.

The install URL is the credential. It looks like `https://your.server/stremio/<43 characters>/manifest.json`, and anyone holding it can stream on whatever Real-Debrid or TorBox account the server is configured with. Treat it like a password:

- Send it to one person, not to a group chat.
- Expect it to appear in the access log of any reverse proxy in front of Fetcherr, since it sits in the URL path. Fetcherr redacts it in its own logs, but it cannot redact anyone else's.
- Rotating breaks whatever that person already installed. They need the new URL before they can watch again.

Each account has a daily play cap, 30 titles by default and 200 for admins. A slot is a distinct title per day rather than a request, so seeking, reconnecting or rewatching the same file costs nothing extra, and a second film costs one more. The cap exists because every stream is billed to one debrid account, so it is the only thing bounding an install URL that leaks. Per-account caps live in `stremio_play_cap` and are set through `POST /api/users/<id>/stremio` with a `cap` value between 0 and 1000; the Settings UI shows the current value next to the buttons.

A rating-limited account is checked against the same parental limit the library uses, on browsing and on playback, using the certification Fetcherr resolves for the title. Two things are worth knowing before someone reports a fault:

- Those checks need Cinemeta. While Cinemeta is unreachable the rating cannot be established, and Fetcherr refuses rather than guessing, so a rating-limited account sees "Not available for this account." on everything. Unrestricted accounts are unaffected. The reason appears in the Fetcherr log.
- A `HEAD` request to a play URL returns 404 rather than a redirect. A player that probes with `HEAD` before fetching may decide the stream is missing. That is deliberate: a `HEAD` served by the full handler would spend a play slot and a debrid resolution for nothing.

## Connecting VidHub

Add Fetcherr as a Jellyfin server in VidHub. If prompted for an Emby endpoint, use `http://YOUR_SERVER:9990/emby`.

## Environment

| Variable | Description |
|---|---|
| `SERVER_URL` | External base URL used for playback redirects (required) |
| `PLAYBACK_SIGNING_SECRET` | Optional secret used to sign short-lived playback URLs. If omitted, Fetcherr generates and stores a persistent random secret in SQLite. |
| `MDBLIST_MAX_ITEMS` | Max items per MDBList list (default: 1000) |

All other configuration is managed through the Settings UI and stored in the database.
