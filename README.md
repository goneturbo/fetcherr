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
| `LDAP_URL` | Optional LDAP server for login, e.g. `ldap://authentik-ldap:3389` or `ldaps://ldap.example.com:636`. Requires `LDAP_USER_DN`. |
| `LDAP_USER_DN` | DN template for LDAP binds, with `{username}` as placeholder, e.g. `cn={username},ou=users,dc=ldap,dc=goauthentik,dc=io` |
| `LDAP_DEFAULT_ROLE` | Role for users auto-created after a successful LDAP login: `user` (default) or `kids` |
| `LDAP_CONNECT_TIMEOUT_MS` | How long to wait for the LDAP connection itself (default: 2000) |
| `LDAP_TIMEOUT_MS` | How long to wait for the bind to be answered (default: 10000). Raise it if valid logins are refused on slow directory hardware |
| `LDAP_REQUIRED_GROUP` | Optional group DN a user must belong to in order to log in, e.g. `cn=media-users,ou=groups,dc=ldap,dc=goauthentik,dc=io`. Unset means every directory user may log in |
| `LDAP_BIND_DN` | Optional service account DN used to read group membership, for directories that refuse searches to ordinary users (Authentik does). Only used with `LDAP_REQUIRED_GROUP` |
| `LDAP_BIND_PASSWORD` | Password for `LDAP_BIND_DN` |

All other configuration is managed through the Settings UI and stored in the database.

When `LDAP_URL` and `LDAP_USER_DN` are both set, a username that already has a local account is authenticated locally and only locally: the directory is never asked about it. Every other username goes straight to an LDAP bind, and a directory user who has never signed in before is created automatically with `LDAP_DEFAULT_ROLE`.

Connecting is capped at 2 seconds and the bind itself at 10 seconds, both configurable. The split matters: a directory that is not listening fails in about a second, while a directory that is merely slow still gets to answer. Against an Authentik LDAP outpost on NAS hardware a bind takes around 2 to 3 seconds, because it runs the provider's whole password stage, so a short cap on the bind refuses valid logins. Only logins that need the directory wait at all, never a local account.

Local usernames stay local deliberately. A directory entry with the same name belongs to whoever controls that entry, who is not necessarily the same person, so admitting it would hand over the local account along with whatever role it has. There is no way yet to attach an existing local account to a directory identity, so a local user who wants to sign in with directory credentials keeps using their local password until there is.

Accounts created by an LDAP login have no password of their own, so they sign in through the directory or not at all. Local accounts are unaffected and keep working if the directory is down.

**Restricting who may log in.** Without `LDAP_REQUIRED_GROUP`, every account in the directory can sign in and gets an account on first login, so pointing `LDAP_URL` at a directory with many users admits all of them. Set `LDAP_REQUIRED_GROUP` to a group DN and only its members get in.

Membership is read right after the bind, on the connection the user just authenticated. Directories that refuse searches to ordinary users need a service account instead, which is what `LDAP_BIND_DN` and `LDAP_BIND_PASSWORD` are for; Authentik is in that camp unless the user belongs to a group carrying search permission. Fetcherr asks the user entry for `memberOf` first and falls back to reading the group's `member` list, so it works with or without the OpenLDAP memberof overlay.

When the directory cannot answer the membership question at all, through a refused search, a timeout, a broken service account or a group DN with a typo in it, Fetcherr splits the difference: accounts that already exist keep working, and no new account is created. An unreadable directory should not lock out the household, and it should not hand out accounts either. A user removed from the group is refused at their next login, though anything already issued to them stays valid until it expires.

The Users section of the Settings UI shows whether LDAP is configured and which server URL is in use. Accounts created through an LDAP login carry an LDAP badge, and their password cannot be changed from Fetcherr; manage those credentials in the directory instead.

If a username changes in the directory, rename the Fetcherr account to match through the Users API (`POST /ui/users` with the account id and the new username). That relink keeps the watch history, which a new auto-provisioned account would not.
