# Music

Apple Music and Spotify are two apps on the home page. Each opens the one
Music tab (`/music`) with DAEX's own UI: search, library, recently played, an
Up Next queue and a player. The tab shows the service its button opened (the
last one is remembered on this computer); opening the other one pauses the
first. **Customize home page → Apps** hides either button (`hiddenApps` in the
home layout). The tab is machine-level like Chats and Browser, exists only
while music is on, and is itself the mini player. The home page's Now Playing
widget reads the same renderer store.

Music is desktop-local on macOS and Windows. The hosted web client, iPhone and
CLI have no Music surface, and choosing a remote project never moves music to
that machine. Other platforms show "Music isn't available here".

## Source file map

| Path | Role |
|---|---|
| `apps/desktop/src/shared/types/music.ts` | IPC channels, `MusicState`, items, commands, the bridge type, `musicArtworkUrl`, `musicPositionNow`, `MUSIC_MAX_COLLECTION_TRACKS` (2,000). |
| `apps/desktop/src/main/services/music/musicService.ts` | Apple Music state, on-demand host start, idle unload and resume, Connect/Disconnect, browse calls (60 s cache). |
| `apps/desktop/src/main/services/music/musicHostProcess.ts` | Spawns the host, request/reply over stdio, quit-then-kill-tree stop. |
| `apps/desktop/src/main/services/music/appleMusicApi.ts` | Apple Music API client and item normalization. |
| `apps/desktop/src/main/services/music/musicDeveloperToken.ts` | Dev-only local minting and the account-server fetch. |
| `apps/desktop/src/main/services/music/musicTokenStore.ts` | The encrypted Music-User-Token file. |
| `apps/desktop/src/main/services/music/spotifyAuth.ts`, `spotifyApi.ts`, `spotifyService.ts`, `spotifyLocalPlayer.ts` | Spotify PKCE sign-in, Web API client, state/playback/devices, and DAEX's own Spotify player in the host. |
| `apps/desktop/src/main/services/music/musicProviderRouter.ts`, `musicVolume.ts` | Selected provider routing and persistence; each provider's remembered volume. |
| `apps/desktop/src/main/services/music/musicNowPlayingBridge.ts` | Puts DAEX's player in the home Now Playing list while it has a track loaded. |
| `apps/desktop/src/main/services/music/registerMusicIpc.ts` | IPC handlers (DAEX renderer only) and wiring. |
| `apps/desktop/src/renderer/components/music/` | `MusicPage` (rail, alert, player card or bar), one file per view (`MusicSearchView`, `MusicLibraryView`, `MusicDetailView`, `MusicQueueView`), `musicViewParts`, `musicQueue`, `MusicPlayer`, `MusicNowPlayingBar`, `MusicTabContent` (the tab as player), `MusicWelcome`, `MusicAccount`, `MusicProviderControls` (Spotify setup and Playing on), `musicApps.tsx` (home-page apps), `musicProvider.tsx`, `musicParts`, `musicStore`, `musicTab` (`shell.music.open`, Mod+Shift+M), `music*.css`, `assets/`. |
| `apps/desktop/native/ADEMusicHostWin/` | Windows player host (`src/AdeMusicHost.cs`) and the pages both hosts run (`page/` Apple, `page-spotify/` Spotify). |
| `apps/desktop/native/ADEMusicHostMac/` | macOS player host (Swift, WKWebView). |
| `apps/desktop/scripts/build-music-host-win.mjs`, `build-music-host-mac.mjs` | Host builds. |
| `apps/account-directory/src/musicDeveloperToken.ts` | The account-server route that mints developer tokens. |
| `scripts/perf/ui/music-host.sh`, `music.mjs`, `music-library.mjs` | Host CPU and memory, time to first play, state pushes, playlist timings. |

## Gotchas / fragile areas

- **Never pass `--disable-component-update` to WebView2.** It removes the
  Widevine CDM and only previews play.
- **The Windows sign-in window needs an explicit `SW_SHOW`.** DAEX spawns the
  host with `windowsHide`, so the first plain `Form.Show()` stays hidden while
  reporting Visible. `Present()` uses `SW_SHOW` and attaches to the foreground
  thread's input (flashing the taskbar if refused).
- **Never inline the macOS icon link as a data URL.** MusicKit copies the
  icon link into the authorize URL; a 41 KB URL left Apple's sign-in blank. So
  Apple's Allow screen shows no icon on macOS.
- **MusicKit drops a seek before the song loads.** A restored queue loads with
  `play:false`; `player.js` keeps `awaitingFirstPlay` / `pendingSeek` and
  seeks after the next play.
- **Under WebKit, MusicKit stops at a song's end** instead of advancing;
  `player.js` plays the next song itself (honouring repeat).
- **Position pushes are sparse.** The host ticks once a second; the main
  process re-anchors only on a >1.25 s disagreement, a play-state or duration
  change, or a seek reply. Only `MusicSeek` and the tab's progress line
  re-render on the tick. The progress line steps without a CSS transition (a
  restarted 1 s transition kept the compositor busy all song).
- **A host keeps the developer token it was configured with** (MusicKit cannot
  swap it). Tokens always arrive with 24 h+ left; a host that never unloaded
  for longer would hit an expired token until the next restart.
- **Resume after unload** restores the queue with shuffle off (re-enabling it
  would reshuffle) and repeat restored.
- **Branding.** Apple allows only official, unmodified artwork. The Music tab
  and welcome card use `AppleMusicAppIcon` in `musicParts.tsx`, a hand-drawn
  SVG; swap it for the official icon from Apple Music Marketing Tools before a
  public release. Attribution uses Apple's unmodified "Listen on Apple Music"
  badge (`music/assets/listen-on-apple-music-badge.svg`). Spotify's official
  logo marks the service once per surface, not per row.
- **Apple's Allow screen** takes the app name from the page
  (`apple-music-app-name` = DAEX) and the line under it from the Media ID's
  description in the Apple Developer portal (`media.com.ade.music`), not code.

## How it works

```
Renderer (Music tab, mini player, Now Playing widget)
   │  window.ade.music  (IPC, typed in shared/types/music.ts)
Main process: musicService / spotifyService
   ├─ browsing ──► api.music.apple.com / Spotify Web API
   └─ playback ──► player host, stdio JSON
                     Windows: ade-music-host.exe (WebView2, hidden window)
                     macOS:   ade-music-host (WKWebView, never shown)
                       └─ https://music.ade.local/index.html → MusicKit JS v3
                          (page-spotify → Spotify Web Playback SDK)
```

- **Browsing never needs the player.** Search, library, recently played, track
  lists and ratings are main-process `fetch` calls, cached 60 s.
- **Collections load by page.** `music.tracks` returns up to 100 songs; the
  view shows the first page, then reads four pages at a time and stops when
  you leave. Shuffle while a playlist loads waits for the last page.
- **Playlist covers.** A playlist with no loadable artwork (no art, or an
  uploaded `*.blobstore.apple.com` cover the renderer's CSP blocks) shows a
  2x2 grid of its first songs' covers (`PlaylistCoverArt`, `coverArts`); the
  read happens once the tile is visible, at most four at a time, in a 300-entry
  ten-minute LRU.
- **The host starts on demand** (tab opens while connected, a play, Connect)
  and **unloads after 5 minutes** without playback, keeping a snapshot (queue
  ids, index, second); `host.status` is `"suspended"` meanwhile. Closing the
  tab pauses and unloads (no confirm; nothing is lost).
- **Volume** is remembered per provider in
  `<userData>/music-player/music-settings.json` (Apple starts at 100%,
  Spotify at 80% until set).
- **Errors** go through `friendlyMusicError` in `musicStore.ts`; the alert
  offers Try again.
- **Before Connect**, Apple Music catalog search, album and playlist pages and
  charts work with the developer token alone, and MusicKit plays 30-second
  previews.
- **Dev preview.** In a dev build, `window.__adeMusicPreview("<term>")` in
  DevTools loads the first catalog song without playing
  (`ade.music.devPreview` in localStorage; `null` turns it off). Packaged
  builds compile it out.

## Spotify

Spotify's Web Playback SDK runs on its own page (`page-spotify`) in the same
host, with its own profile (`<userData>/music-player-spotify`): WebView2 plays
Widevine on Windows, WebKit FairPlay on macOS. The player appears in Spotify as
a Connect device named **DAEX**, which is the default each time the tab opens;
**Playing on** can move playback to another device and back. Pause, resume,
seek and volume go straight to DAEX's player when it plays; the rest goes
through the Web API. Premium is required.

DAEX's Spotify player starts when the tab opens or a play needs it, stops after
five minutes without playing (`SPOTIFY_LOCAL_IDLE_MS`), and closing the tab
stops it. Music on another device keeps playing.

**Connect.** The person creates a Spotify app (Web API and Web Playback SDK
ticked) and enters its public Client ID. The redirect URI must be exactly
`http://127.0.0.1:43219/spotify/callback` (the dashboard rejects portless
loopback). Sign-in is Authorization Code with PKCE, random state, a listener
bound to `127.0.0.1`, a ten-minute expiry. No client secret. Development apps
allow five users, so the account must be on the app's allowed list. Sign-ins
from before local playback lack the `streaming` scope and reconnect once.
Changing the Client ID signs out; **Disconnect Spotify** clears DAEX's stored
access.

**Tokens** are encrypted with Electron safeStorage in this build's user-data
folder, separate from Apple's. No Spotify credential reaches the renderer, a
project database, sync, agents, chat context or analytics. Refresh is shared
between concurrent callers.

**Differences the UI states:** no charts, signed-out catalog, previews or
library search; catalog search returns up to ten items per kind; someone
else's playlist may have metadata without songs; only **Add to queue** (no Play
Next or jump); the heart saves Liked Songs (no dislike).

**Polling.** DAEX's own player reports its changes, so while it plays the Web
API is read once a minute (`POLL_LOCAL_MS`). Another device is polled only
while Spotify is the active service and the tab is loaded; Retry-After is
respected.

## Tokens and secrets (Apple Music)

| Token | Source | Where it lives |
|---|---|---|
| MusicKit private key (`.p8`) | Apple Developer account (key `3NNQ5Y43RA`, team `VQ372F39G6`, media id `media.com.ade.music`) | Production: account-server secret `MUSICKIT_PRIVATE_KEY`. Dev only: `~/.ade/secrets/musickit/AuthKey_3NNQ5Y43RA.p8` or `ADE_MUSICKIT_KEY_PATH`. Never in the app, repo or logs. |
| Developer token (ES256 JWT, 30 days) | Production: `GET /music/developer-token` on the account server, signed-in users only. Dev builds mint locally; a packaged build never reads a local key. | Main-process memory; refreshed with 24 h left. Logged only as its first 6 characters. |
| Music-User-Token | MusicKit `authorize()` in the host | `<userData>/music-player/apple-music-user-token.enc` (safeStorage), sent to the host on each start. `player.js` deletes MusicKit's localStorage copy on load and after `configure` / `authorize` / `unauthorize`. |

Disconnect calls `unauthorize()` when the host runs, deletes the stored token
and stops the host without a snapshot. A 401 on a `/v1/me` call drops the token
(a 403 does not; it can mean no subscription).

## Player hosts

Wire format, one JSON object per line: `{"rid":"r1","cmd":"seek","position":60}`
in; `{"reply":"r1","ok":true,"result":{…}}` or `{"event":"time",…}` out.
`player.js` commands: `configure`, `authorize`, `unauthorize`, `queue`,
`playItems`, `playCollection`, `pause`, `resume`, `toggle`, `next`, `prev`,
`seek`, `volume`, `shuffle`, `repeat`, `playAt`, `playNext`, `playLater`,
`snapshot`. Events: `loaded`, `state`, `time`, `queueChanged`, `authorization`,
`playbackError`, `loadFailed`; the host adds `hostReady`, `hostClosing`,
`hostError`, `authWindow`. Host commands `showAuth` / `closeAuth` back "Show
sign-in window" and "Cancel".

Both hosts exit on stdin EOF, `{"cmd":"quit"}`, or when `--parent-pid` exits.
Navigation is limited to the page, `https://*.apple.com` and
`https://*.icloud.com`; only the page's origin may post to DAEX.
`ADE_MUSIC_HOST_PATH` overrides the binary; `ADE_MUSIC_HOST_SHOW=1` shows the
player window with dev tools.

**Windows** (`ADEMusicHostWin`): a C# 5 WinForms program around WebView2,
hidden off-screen, serving `page/` on `https://music.ade.local`
(`SetVirtualHostNameToFolderMapping`), persistent profile in
`<userData>/music-player`. Apple's sign-in opens as a real popup sharing the
environment (`NewWindowRequested`), light colour scheme. Runs with
`--disable-gpu --renderer-process-limit=1 --disable-extensions`
(`ADE_MUSIC_HOST_GPU=1` keeps the GPU; `ADE_MUSIC_HOST_MUTED=1` mutes). Built by
`npm --prefix apps/desktop run build:music-host:win` (part of `dist:win*`) with
the in-box `csc.exe`, downloading `Microsoft.Web.WebView2` from nuget.org and
checking its SHA-512; output `resources/native/ade-music-host/`. The WebView2
runtime is not bundled; without it the host reports `webview2_missing`.

**macOS** (`ADEMusicHostMac`, product `ade-music-host`): an accessory
`NSApplication` with one never-shown WKWebView. The page is loaded with
`loadSimulatedRequest` as `https://music.ade.local/index.html` (EME needs a
secure context); `player.js` is injected behind a `window.chrome.webview` shim.
Needs macOS 14 (per-profile WebKit store); below that it emits `hostError
unsupported_os` and exits 6. The profile is `WKWebsiteDataStore(forIdentifier:)`
derived from `--udf`, so builds never share Apple's sign-in. Sign-in opens in a
floating light window with an Edit menu (Cmd-V). A dead WebContent process
reports `process_failed` and exits. Writes ignore closed pipes, so a host whose
DAEX was killed exits 0. Built by `build:music-host:mac` (part of
`build:mac-native`): universal via `lipo`, signed with the app, checked by
`validate-mac-artifacts.mjs`. Memory: see `docs/perf/macos-baseline.md`.

## Renderer API (for widgets)

`apps/desktop/src/renderer/components/music/musicStore.ts`: `useMusicNowPlaying()`
(`available`, `nowPlaying`, `isPlaying`, `busy`, `duration`,
`artworkUrl(cssPx)`), `useMusicPosition(intervalMs)`, `useMusicState(selector)`,
`useMusicLike()`, `friendlyMusicError(raw)`, `musicActions.*` (transport,
volume, shuffle, repeat, `playItems`, `playCollection`, `playNext`,
`playLater`, `playAt`, `connect`, `disconnect`, `warm`, `open`, `showSignIn`,
`cancelSignIn`, `unload`), `formatMusicTime`. Every hook shares one IPC
subscription. The home widget is `home/widgets/NowPlayingWidget.tsx` (see "Now
Playing" in `docs/plans/ade-dev-home.md`).

## Failure modes

- **No developer token:** signed out (production), the account server has no
  key (503 `music_unavailable`), or offline. The tab says "Music isn't
  available right now" with Try again.
- **Host binary missing:** dev builds name the build script; installs say to
  reinstall.
- **WebView2 missing or broken:** `webview2_missing` or `process_failed`; the
  next play starts a fresh host.
- **MusicKit CDN unreachable:** `loadFailed` after 20 s.
- **Sign-in window closed:** the wait ends after 2.5 s as cancelled (MusicKit's
  promise can hang). Any other tokenless end (10-minute timeout, error) closes
  Apple's window.
- **Apple rate limits** (429) show as a message.
