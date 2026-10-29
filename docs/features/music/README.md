# Music

Apple Music and Spotify are two apps on the home page, each with its own
button, and both open the one Music tab with ADE's own UI: search, library,
recently played, an Up Next queue and a player. The tab shows the service its
button opened (the last one is remembered on this computer); there is no
switch inside the tab. Opening the other one pauses the first. **Customize
home page → Apps** removes either button and adds it back (`hiddenApps` in the
home layout, per saved layout; both show by default). The tab exists only
while music is on, and the tab itself is the mini player. The home page's Now
Playing widget reads the same renderer store.

## Spotify

Spotify plays **inside ADE** on macOS and Windows, like Apple Music. Spotify's
Web Playback SDK runs on its own page (`native/ADEMusicHostWin/page-spotify`)
in the same player host as Apple Music, with a profile of its own
(`<userData>/music-player-spotify`): WebView2 plays Spotify's Widevine streams
on Windows and WebKit its FairPlay streams on macOS. The player shows up in
Spotify as a Connect device named **ADE**. **This computer (ADE) is the
default every time the tab opens**; the **Playing on** menu can send playback
to the Spotify app, a phone or a speaker instead, and back. Pause, resume,
seek and volume go straight to ADE's player when it is the one playing; the
rest goes through the Web API. Spotify Premium is required. This is
desktop-local, like Apple Music: hosted web, iOS and CLI have no Music
account/control surface, and choosing a remote project never moves music to
that machine.

Like Apple Music's host, ADE's Spotify player starts when the tab opens or a
play needs it, stops after five minutes without playing
(`SPOTIFY_LOCAL_IDLE_MS`), and closing the tab pauses it and stops it. Music
playing on another device keeps playing when the tab closes.

### Connect and disconnect

1. Press the Spotify button on the home page. A first visit shows **Set up
   Spotify** (and **I already have a Client ID**); the guide's steps, with
   pictures of Spotify's own pages, appear only after that.
2. Create a Spotify app and enter its public **Client ID**, from
   [Spotify's developer dashboard](https://developer.spotify.com/dashboard).
   The app needs **Web API** and **Web Playback SDK** ticked.
   Register exactly `http://127.0.0.1:43219/spotify/callback` as a redirect
   URI. Spotify's docs allow a portless loopback URI, but its dashboard
   rejects one as "not secure", so ADE's sign-in always listens on port 43219.
   No client secret is used or stored.
3. Press **Connect Spotify** and finish consent in the default browser. ADE
   uses Authorization Code with PKCE, a random state value and a listener bound
   only to `127.0.0.1`. Cancel ends the listener; sign-in also expires after ten
   minutes. **Open sign-in page** reopens the consent page while it waits.
4. Play. Sign-ins from before ADE played Spotify itself lack the `streaming`
   scope and are asked to connect again once.

Spotify's [development access rules](https://developer.spotify.com/blog/2026-02-06-update-on-developer-access-and-platform-security)
limit development applications to five allowed users and require Premium.
Add the connecting account to the app's allowed users. ADE does not ship an
application ID that implies unrestricted public Spotify access. The ID can be
changed or removed in **Spotify app settings** before connecting; changing it
signs Spotify out. The account menu offers **Disconnect Spotify**, which clears
ADE's stored access. Spotify's account Apps page can revoke consent entirely.

Tokens are encrypted with Electron safeStorage in this build's own user-data
folder, separate from Apple's token. No Spotify credential enters the renderer,
a project database, sync, agent actions, chat context or analytics. OAuth
refresh is shared between concurrent callers; rotated refresh tokens are kept.
Reconnect when Spotify revokes or expires the refresh token.

### Browse and play

After connecting, catalog search, playlists, saved albums, Liked Songs, recently
played, album and playlist pages, transport, seek, shuffle, repeat, saving songs
and Add to queue use the same Music views as Apple Music. The home Now Playing
widget and tab mini player follow the selected provider. Spotify artwork uses
its supplied image sizes without blur or playback overlays. The official,
unmodified logo from the
[Spotify design kit](https://developer.spotify.com/documentation/design) marks
the service once per surface (the rail, the player card, an album or playlist
page's **Open in Spotify**), not on every song row or tile.

Spotify capabilities differ in ways the UI makes explicit:

- There are no charts, signed-out catalog, previews or library search. Catalog
  search returns up to ten items of each kind under current development rules.
- Playlists belonging to someone else may expose metadata without songs.
  **Play** still starts the playlist on the selected device; **Open in Spotify**
  opens it there. Missing track listings are not presented as a failed request.
- Spotify has **Add to queue**, with no separate Play Next operation or jumping
  within Up Next. Queued songs are listed without a jump/play action, preserving the existing queue.
- The heart saves/removes Liked Songs; there is no dislike operation.
- Closing Music pauses and stops ADE's own Spotify player, like Apple Music.
  Music sent to another device keeps playing there. Switching services pauses
  the old service first.

Browse reads use a bounded 60-second cache. ADE's own player reports every
change itself, so while it plays the Web API is read only once a minute
(`POLL_LOCAL_MS`). Another device is polled only while the
Spotify service is active, with position interpolation in the renderer and
unchanged broadcasts suppressed; it stops when the tab unloads, on disconnect,
on provider switch or when ADE quits. Rate limits respect Spotify's Retry-After
rather than retrying in a loop. Failed reads say they could not load and offer
retry. Missing devices and Premium failures have their own messages.

### Spotify source files

| Path | Role |
| --- | --- |
| `apps/desktop/src/main/services/music/spotifyAuth.ts` | PKCE, loopback sign-in and token exchange/refresh. |
| `apps/desktop/src/main/services/music/spotifyApi.ts` | Spotify Web API, pagination, normalization and error handling. |
| `apps/desktop/src/main/services/music/spotifyService.ts` | Spotify state, playback, devices and lifecycle. |
| `apps/desktop/src/main/services/music/spotifyLocalPlayer.ts` | ADE's own Spotify player in the music host. |
| `apps/desktop/native/ADEMusicHostWin/page-spotify/` | The Web Playback SDK page the host runs. |
| `apps/desktop/src/renderer/components/music/musicApps.tsx` | The Apple Music and Spotify home-page apps. |
| `apps/desktop/src/main/services/music/musicProviderRouter.ts` | Selected provider routing and persistence (the settings file, and each provider's remembered volume). |
| `apps/desktop/src/main/services/music/musicVolume.ts` | A provider's remembered volume: the 0–1 clamp, the session copy, and the dedupe both services share. |
| `apps/desktop/src/renderer/components/music/MusicProviderControls.tsx` | Spotify setup guide and the Playing on menu. |
| `apps/desktop/src/renderer/components/music/musicProvider.tsx` | Selected provider labels and attribution. |

## The player

One visual language in three sizes (`MusicPlayer.tsx`):

- **Now Playing card** on the right of the Music tab: big artwork (it settles
  back while paused), the song's artwork blurred as a tint behind the card,
  title, artist and album, Love, the scrubber with times, the transport pill
  (shuffle, back, play/pause, forward, repeat), volume and Up Next. Shown when
  the page is at least 1080px wide; the caret folds it into the bar, and the
  choice is remembered (`localStorage` `ade.music.playerCard`).
- **Bottom bar** when the card is folded or the window is narrow: the same
  parts in one row. Only one of the two is mounted at a time.
- **The Apple Music tab** in the tab strip (`MusicTabContent.tsx`): the whole
  cover (never cropped), the title, play/pause, and a 2px progress line along
  the tab's bottom edge. There is no other top-bar music control.
- **Home Now Playing widget** (`home/widgets/NowPlayingWidget.tsx`): a frosted
  card after `tmp/refs/audio-player.reference.tsx`, built from the same
  `MusicSlider` and `PlayerIconButton`. ADE's player is one of its sources
  (real seek, shuffle, repeat; the cover opens the tab), first while it
  plays; the others are built-in browser tabs and other apps. See "Now
  Playing" in `docs/plans/ade-dev-home.md`.

The scrubber and volume are `MusicSlider`: click or drag anywhere (the pointer
is captured, so a drag may leave the track), or use the arrow, Page, Home and
End keys. The slider's position is remembered per provider, so the next launch
starts where it was left instead of at full volume: it lives in
`<userData>/music-player/music-settings.json` under `volume`, keyed by
provider, and ADE's own player gets it when it starts. Before it has ever been
set, Apple Music starts at full volume and Spotify at 80%. Only `MusicSeek` and
the tab's progress line re-render on the position
tick (twice and once a second), from the renderer's own interpolation: the main
process pushes state only when it changes (a steady song pushes nothing; see
"Position pushes" below), and the store keeps `nowPlaying` and `host` objects
stable across pushes, so nothing else re-renders. The progress line steps once
a second with no transition: a 1 s linear transition restarted every tick kept
the compositor drawing the whole window at display rate for the whole song.
Buttons grow on hover and press and the fill springs on a real jump; all of
that is off under the OS or ADE's Reduce motion.

**Dev preview.** Playback needs a signed-in Apple Music account. In a dev build
(`import.meta.env.DEV`), run `window.__adeMusicPreview("<search term>")` in the
renderer's DevTools to load the first catalog song for that term into the
player without playing anything; transport, seek, volume and Love then act on
the preview locally. It is remembered in `localStorage`
(`ade.music.devPreview`); `window.__adeMusicPreview(null)` turns it off. A
packaged build compiles the hook out.

**Before Connect** the tab is not dead: catalog search, album and playlist
pages and the charts (`/v1/catalog/{sf}/charts`, developer token only) work,
and MusicKit plays catalog songs as 30-second previews. The signed-out page is
a hero over a mosaic of chart album art with Connect, what you get and a
privacy line, then popular songs and albums.

**Errors** never reach the UI raw: `friendlyMusicError` in `musicStore.ts` maps
known causes (a credential that can't be decrypted, cancelled sign-in, no
subscription, rate limits, no network) to a sentence, and the alert offers Try
again.

**Branding.** Apple's identity guidelines allow only official, unmodified
Apple Music artwork. ADE uses Apple's "Listen on Apple Music" badge
(`music/assets/listen-on-apple-music-badge.svg`, downloaded unmodified from
`toolbox.marketingtools.apple.com/api/badges/listen-on-apple-music/badge/en-us`)
for attribution and as the Apple Music buttons (home header, Now Playing
widget). Everything else uses ADE's own neutral glyph, except one: the Music
tab and the welcome page's Music card use `AppleMusicAppIcon` in
`musicParts.tsx`, a hand-drawn SVG of the Apple Music app icon. **Swap it for
the official app icon from Apple Music Marketing Tools
(tools.applemediaservices.com) before a public release**; a redrawn icon does
not meet the guidelines.

Status (2026-10-13): **Windows plays full tracks after sign-in (verified by the
user).** macOS has its own host (`native/ADEMusicHostMac`): catalog, charts,
previews, transport, idle unload and resume verified in a dev build; FairPlay
(`com.apple.fps`) is available to it. Other platforms show "Music isn't
available here".

## How it works

```
Renderer (Music tab, mini player, Now Playing widget)
   │  window.ade.music  (IPC, typed in shared/types/music.ts)
Main process: musicService
   ├─ browsing ──► api.music.apple.com   (developer token + Music-User-Token)
   └─ playback ──► player host, stdio JSON
                     Windows: ade-music-host.exe (WebView2, hidden window)
                     macOS:   ade-music-host (WKWebView, no window on screen)
                       └─ https://music.ade.local/index.html → MusicKit JS v3
```

- **Browsing never needs the player.** Search, library, recently played, track
  lists and ratings are `fetch` calls from the main process to the Apple Music
  API, cached for 60 s in memory.
- **Collections load by page.** `music.tracks` returns one page (up to 100
  songs, `nextOffset`, `total`). The album or playlist view shows the first
  page at once, then reads the rest four pages at a time when Apple sends the
  total (one after another when it does not) and appends them in order; it
  stops reading when you leave. A collection is read up to
  `MUSIC_MAX_COLLECTION_TRACKS` (2,000) songs.
- **Covers for playlists without artwork.** A library playlist Apple sends
  without artwork, or with an uploaded cover the renderer cannot load
  (`loadableArtwork` in `musicParts.tsx`), shows its first songs' covers, like
  the Music app: four
  distinct covers as a 2x2 CSS grid, the first cover alone when there are one
  to three, the note glyph when none. The songs come from one `tracks` read
  with limit 4, made only once the tile is on screen and the window is
  visible, at most four at a time, kept in a 300-entry LRU for ten minutes
  (`PlaylistCoverArt` in `musicParts.tsx`). A failed read is tried once more
  the next time the tile is seen. The playlist's own page builds the same
  cover from the songs it has already read.
  Each cell asks Apple for its own pixel size. A playlist's own uploaded cover
  (`*.blobstore.apple.com`, a signed 1200x1200 URL) is blocked by the
  renderer's CSP, so such a playlist gets the four-song cover too; songs whose
  art is on blobstore are skipped (`coverArts`). The playlist page's header
  uses the same cover, built from the songs it has already read
  (`MusicCoverArt`).
- **The player host is started on demand** (the Music tab opens while
  connected, a play command arrives, or Connect is pressed) and **unloaded after
  5 minutes** without playback. Unloading keeps a snapshot (queue ids, index,
  second). The next play relaunches the host, restores the queue and continues
  at the same second. While unloaded the state says `host.status: "suspended"`
  and the mini player keeps showing the last song.
- **DRM.** WebView2's Widevine/PlayReady CDM plays full tracks (proved in the
  `tmp/spike-webview2-music` spike). Never pass `--disable-component-update` to
  WebView2: it removes the Widevine CDM and only previews play. On macOS,
  WebKit's FairPlay CDM (`com.apple.fps`, no Widevine) is available to the
  unsigned dev host as well as the signed one.
- **Position pushes.** The host ticks the position once a second while
  playing. Renderers interpolate from `position` + `positionAt`, so the main
  process re-anchors (and pushes) only when a tick or state event disagrees by
  more than 1.25 s (MusicKit reports whole seconds), or the play state or
  duration changed (a new song arrives as one of those); a seek's reply always
  re-anchors. A broadcast equal to the last one is not sent.
- **Resume second.** A restored queue is loaded with `play:false`; MusicKit
  drops a seek made before the song has loaded, so `player.js` marks the
  queue `awaitingFirstPlay`, keeps the second as `pendingSeek`, reports it as
  the current time, and seeks right after the next play. A seek before that
  play moves `pendingSeek` instead, and Previous more than 3 s in restarts the
  song from 0. Opening the tab while connected (`warm()`) restores the queue
  paused, so the card shows the song at its second before anything plays; a
  command sent while that restore is in flight waits for it.
- **End of a song.** Under WebKit, MusicKit stops where a song ended instead
  of moving on. `player.js` then plays the next song itself: the same song
  under repeat one, the first under repeat all at the end of the queue. A
  pause pressed while that next song loads is kept.
- **Shuffle while a playlist loads** waits for the last page, so it draws from
  the whole playlist. A page that fails shows a banner with Try again.

## Tokens and secrets

| Token | Where it comes from | Where it lives |
|---|---|---|
| MusicKit private key (`.p8`) | Apple Developer account, key `3NNQ5Y43RA`, team `VQ372F39G6`, media id `media.com.ade.music` | Production: the account-directory Worker secret `MUSICKIT_PRIVATE_KEY`. Dev only: `%USERPROFILE%\.ade\secrets\musickit\AuthKey_3NNQ5Y43RA.p8` or `ADE_MUSICKIT_KEY_PATH`. Never in the app, the repo or a log. |
| Developer token (ES256 JWT, 30 days) | Production: `GET /music/developer-token` on the account directory, signed-in ADE users only; the Worker reissues once its cached token has under 7 days left. Dev (unpackaged builds): minted locally from the `.p8`. A packaged build never reads a local key. | Main-process memory; refreshed with 24 h left (or half the life a short token arrived with). Logged only as its first 6 characters. |
| Music-User-Token | MusicKit `authorize()` in the player host, after the user signs in with Apple | `musicTokenStore.ts`: one file, `<userData>/music-player/apple-music-user-token.enc`, encrypted with this app's Electron safeStorage key (not the shared machine credential files). Sent to the host over stdin on each start. MusicKit also saves it in the WebView2 profile's localStorage (`music.<team id>.media-user-token`); `player.js` deletes that copy when the page loads (before MusicKit) and again after `configure`, `authorize` and `unauthorize`, the calls that write it, so the profile does not keep it past those calls. |

Disconnect calls MusicKit `unauthorize()` when the host runs, deletes the
stored token and stops the host without keeping a queue snapshot. When the host
is not running there is nothing else to clear: the profile holds no token (a
token an older build left there is deleted before MusicKit loads on the next
start). A 401 from Apple on a `/v1/me` call drops the token too (a 403 does
not: it can mean "no subscription"). On macOS the same page runs, so the same
deletion applies to the WebKit data store's localStorage.

## The player host (Windows)

`apps/desktop/native/ADEMusicHostWin/`:

- `src/AdeMusicHost.cs`: a C# 5 WinForms program around WebView2. Hidden,
  off-screen window; serves `page/` on `https://music.ade.local` through
  `SetVirtualHostNameToFolderMapping`; persistent WebView2 profile in
  `<userData>/music-player`. Apple's sign-in opens through `NewWindowRequested`
  as a real popup that shares the environment (so `window.opener` works), and
  the profile prefers the light colour scheme because Apple's dark sign-in has
  near-invisible buttons. Exits on stdin EOF, `{"cmd":"quit"}`, or when the
  ADE process it was given (`--parent-pid`) exits. Both pipes are UTF-8
  whatever the ANSI code page is. Only the player page's origin may post to
  ADE, and the player and sign-in webviews navigate only to that page and
  `https://*.apple.com` / `*.icloud.com`; `page/index.html` carries a CSP that
  loads scripts only from the page and `https://*.apple.com`.
- **The sign-in window must be shown with an explicit `SW_SHOW`.** ADE spawns
  the host with `windowsHide`, so its STARTUPINFO says `SW_HIDE`, and Windows
  applies that to the process's first plain `Form.Show()`: the form reports
  Visible while Win32 keeps it hidden. `Present()` shows it with `SW_SHOW` and
  brings it in front by attaching to the foreground thread's input (a
  background process may not take the foreground otherwise), flashing the
  taskbar button if Windows still refuses. Host commands `{"cmd":"showAuth"}`
  and `{"cmd":"closeAuth"}` back the tab's "Show sign-in window" and "Cancel".
- **Apple's Allow access screen** takes the app name from `app.name` and the
  icon from `<link rel="apple-music-app-icon">` on the page; the page sets
  "ADE" and serves `page/ade-icon.png` from its own https origin. The line
  under the name on that screen comes from the Media ID's description in the
  Apple Developer portal (Certificates, Identifiers & Profiles → Identifiers →
  Media IDs → `media.com.ade.music`), not from code.
- **Memory.** WebView2 runs with `--disable-gpu --renderer-process-limit=1
  --disable-extensions` and a few Edge features off: 248 MB → 141 MB private
  across the process tree while a song plays (measured 2026-10-08).
  `ADE_MUSIC_HOST_GPU=1` keeps the GPU process; `ADE_MUSIC_HOST_MUTED=1` mutes
  the host (test instances and automation).
- `page/player.js`: the MusicKit control script. Commands: `configure`,
  `authorize`, `unauthorize`, `queue`, `playItems`, `playCollection`,
  `pause`, `resume`, `toggle`, `next`, `prev`, `seek`, `volume`,
  `shuffle`, `repeat`, `playAt`, `playNext`, `playLater`, `snapshot`. Events:
  `loaded`, `state`, `time` (once a second while playing), `queueChanged`,
  `authorization`, `playbackError`, `loadFailed`; the host adds `hostReady`,
  `hostClosing`, `hostError`, `authWindow`.

Wire format, one JSON object per line: `{"rid":"r1","cmd":"seek","position":60}`
in, `{"reply":"r1","ok":true,"result":{…}}` or `{"event":"time",…}` out.

### Building and shipping it

`npm --prefix apps/desktop run build:music-host:win` (also part of `dist:win`
and `dist:win:signed`):

- compiles with the in-box `%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe`
  (no SDK, present on every Windows 10/11 machine and the release runner);
- downloads `Microsoft.Web.WebView2` **1.0.4258.31** from nuget.org and checks it
  against NuGet's published SHA-512 before use (cached in
  `apps/desktop/.ade-native-build/nuget/`);
- writes `resources/native/ade-music-host/` (exe, the two managed WebView2
  DLLs, x64 `WebView2Loader.dll`, `page/`), which a dedicated
  `build.extraResources` entry ships to `resources/native/ade-music-host/`.

The WebView2 runtime itself is not bundled: Windows 11 ships it. Without it the
host reports `webview2_missing`. `ADE_MUSIC_HOST_PATH` overrides the exe for
development; `ADE_MUSIC_HOST_SHOW=1` shows the player window (with DevTools).

## The player host (macOS)

`apps/desktop/native/ADEMusicHostMac/` (Swift package, product
`ade-music-host`): an `NSApplication` (accessory, no Dock icon)
with one WKWebView in a window that is never shown, so WebKit throttles it like
a background tab. Same protocol, same arguments (`--gpu` is accepted and
ignored) and the same `page/` as Windows:

- **The page.** WKWebView cannot map a folder to an https origin, so the host
  reads `page/index.html` and loads it with `loadSimulatedRequest` as
  `https://music.ade.local/index.html` (a secure context, which EME needs).
  `player.js` is injected as a document-start user script behind a shim that
  gives it the `window.chrome.webview` bridge it was written for
  (`postMessage` out through a `WKScriptMessageHandler`, commands in through
  `callAsyncJavaScript`). Both scripts run only on that origin, and only the
  page's main frame may post to ADE. The page's own `player.js` script tag is
  removed (it would ask the network for `music.ade.local`). The icon link
  stays `https://music.ade.local/ade-icon.png`, which WKWebView cannot serve,
  so Apple's Allow screen shows no ADE icon on macOS. **Never inline it as a
  data URL:** MusicKit copies that link's `href` into the authorize URL as a
  GET query, and the 41 KB URL left Apple's sign-in window blank.
- **macOS 14 or later.** The binary targets macOS 12 (ADE itself needs 13), so
  it launches everywhere ADE does; below 14 it writes
  `{"event":"hostError","code":"unsupported_os","error":"Apple Music in ADE needs macOS 14 or later."}`
  and exits 6, because there is no per-profile WebKit store to keep builds'
  sign-ins apart.
- **Profile.** A persistent `WKWebsiteDataStore(forIdentifier:)` whose UUID is
  derived from `--udf`, so dev, installed and test builds never share Apple's
  sign-in. `--udf` only names the profile; the host writes nothing there.
  MusicKit's saved user token is deleted by `player.js` exactly as on Windows.
- **Sign-in.** MusicKit's `window.open` becomes a real WKWebView created from
  WebKit's configuration (so `window.opener` works) with an empty content
  controller (nothing of ADE's runs in Apple's page), in a light-appearance
  window that floats above other apps until it closes. A background helper may
  not be allowed to take focus, so floating is what keeps it visible; one
  click makes it key. A minimal Edit menu makes Cmd-V work in Apple's fields.
  `showAuth` / `closeAuth` work as on Windows.
- **Navigation.** Top-level navigations go only to the page,
  `https://*.apple.com` and `https://*.icloud.com`.
- **Exit.** stdin EOF, `{"cmd":"quit"}`, or `--parent-pid` exiting (a
  dispatch process source). If WebKit's WebContent process dies, the host
  reports `hostError process_failed` and exits, so the next play starts a
  fresh host. WebKit's WebContent, Networking and GPU processes are XPC
  services and exit with the host. Writes to stdout and stderr ignore a closed
  pipe, so a host whose ADE was killed exits 0 instead of aborting with a crash
  report.
- **Memory.** 73-81 MB physical footprint across the host and its three
  WebKit processes, playing or paused (see `docs/perf/macos-baseline.md`).

`npm --prefix apps/desktop run build:music-host:mac` (also part of
`build:mac-native`, so every `dist:mac*`) builds both architectures with
SwiftPM, folds them with `lipo` and writes `resources/native/ade-music-host/`
(`ade-music-host` plus `page/` copied from `ADEMusicHostWin/page`), which a mac
`extraResources` entry ships. electron-builder signs it with the app
(hardened runtime, the inherited entitlements) and the app is notarized
whole. The release caches and attests the binary with the other Swift helpers
(`.github/actions/release-cache-keys`), and `validate-mac-artifacts.mjs`
checks it is universal and the page is present. The build shares
`buildUniversalSwiftProduct` (`scripts/native-helper-cache.mjs`) with the
other Swift helpers. `ADE_MUSIC_HOST_PATH`
overrides it in development and `ADE_MUSIC_HOST_SHOW=1` shows the player
window (Web Inspector enabled).

## Renderer API (for widgets)

`apps/desktop/src/renderer/components/music/musicStore.ts`:

```ts
useMusicNowPlaying(): {
  available: boolean;            // this window has Music (desktop, not unsupported)
  nowPlaying: MusicNowPlaying | null; // id, title, artist, album, artwork, durationMs, library, catalogId
  isPlaying: boolean;
  busy: boolean;                 // loading or buffering
  duration: number;              // seconds
  artworkUrl(cssPx: number): string | null; // 2x applied
}
useMusicPosition(intervalMs = 500): number  // seconds, ticks while playing
useMusicState(selector)                      // the full MusicState; select fields, not the whole object
useMusicLike(): { liked, canLike, toggle }   // Love for the playing song, shared by every button
friendlyMusicError(raw): string | null       // plain words for any Music failure
musicActions.toggle() / play() / pause() / next() / previous() / seek(s)
musicActions.setVolume(0..1) / setShuffle(bool) / setRepeat(0|1|2)
musicActions.playItems(ids, index?, shuffle?) / playCollection(kind, id, index?, shuffle?)
musicActions.playNext(ids) / playLater(ids) / playAt(index)
musicActions.connect() / disconnect() / warm() / open()  // open() shows the Music tab
musicActions.showSignIn() / cancelSignIn() / unload()
formatMusicTime(seconds)
```

`musicArtworkUrl(artwork, px)` and `musicPositionNow(playback)` live in
`shared/types/music.ts`. Every hook shares one IPC subscription.

## Entry points

- Home page: the Apple Music badge button beside Browser, and the Now Playing
  widget (its Apple Music badge, or its cover while ADE's player is loaded).
- Shortcut: **Mod+Shift+M** (`shell.music.open`, rebindable).
- The Apple Music tab (`/music`) is machine-level like Chats and Browser. The
  tab open is music on: **closing it pauses and unloads the player** (no
  confirm: closing is the stop gesture, and nothing is lost), keeping the queue
  and second, so reopening shows the last song paused where it stopped.
- Space toggles play/pause while the Music tab is in front and no field has focus.

## Source file map

| Path | Role |
|---|---|
| `apps/desktop/src/shared/types/music.ts` | IPC channels, `MusicState`, items, commands, the bridge type, artwork/position helpers. |
| `apps/desktop/src/main/services/music/musicService.ts` | State, on-demand host start, idle unload and resume, Connect/Disconnect, browse calls. |
| `apps/desktop/src/main/services/music/musicHostProcess.ts` | Spawns the host, request/reply over stdio, quit-then-kill-tree stop. |
| `apps/desktop/src/main/services/music/appleMusicApi.ts` | Apple Music API client and item normalization. |
| `apps/desktop/src/main/services/music/musicDeveloperToken.ts` | Dev-only local minting and the Worker fetch. |
| `apps/desktop/src/main/services/music/registerMusicIpc.ts` | IPC handlers (ADE renderer only) and app wiring. |
| `apps/desktop/src/renderer/components/music/` | `MusicPage` (the shell: rail, alert, player card or bar), one file per view (`MusicSearchView`, `MusicLibraryView` with Recently played, `MusicDetailView`, `MusicQueueView`) and their shared `musicViewParts`, `musicQueue` (every song play: catalog ids, queue windows, Play Next / Later), `MusicPlayer` (card, slider, transport, volume, Love, artwork backdrop), `MusicNowPlayingBar`, `MusicTabContent` (the tab as player), `MusicWelcome` (signed-out page, Connect, sign-in controls), `MusicAccount` (rail account menu), `musicParts`, `musicStore`, `musicTab`, `music.css` (imports `music-*.css` in cascade order), `assets/`. |
| `apps/desktop/native/ADEMusicHostWin/` | The Windows player host and the player page both hosts run. |
| `apps/desktop/native/ADEMusicHostMac/` | The macOS player host (Swift, WKWebView). |
| `apps/desktop/scripts/build-music-host-win.mjs`, `build-music-host-mac.mjs` | Reproducible host builds. |
| `scripts/perf/ui/music-host.sh`, `music.mjs`, `music-library.mjs` | Host CPU and memory; time to first play and state pushes; playlist and Playlists-grid timings. |
| `apps/account-directory/src/musicDeveloperToken.ts` | The Worker route that mints developer tokens. |

## Failure modes

- **No developer token:** signed out of ADE (production), the Worker has no key
  (503 `music_unavailable`), or no network. The tab shows "Music isn't
  available right now" with the reason and a Try again button.
- **Host binary missing:** dev builds say to run the build script
  (`build:music-host:win` or `build:music-host:mac`); installs say to
  reinstall.
- **WebView2 runtime missing or broken:** `hostError` `webview2_missing` or
  `process_failed`; the next play starts a fresh host.
- **MusicKit CDN unreachable:** `loadFailed` after 20 s, shown in the tab.
- **Sign-in closed:** the window closing ends the wait after 2.5 s as
  "cancelled"; MusicKit's own promise can otherwise hang. A sign-in that ends
  any other way without a token (the 10-minute timeout, an error) closes
  Apple's window.
- **Token expiry mid-session:** a host keeps the developer token it was
  configured with (MusicKit has no way to swap it), so every token it gets has
  at least 24 h left and usually days; a host that played without a single
  idle unload for longer than that would hit an expired token (fixed by the
  next restart).
- **Resume after unload** restores the queue in its current order with shuffle
  off (re-enabling shuffle in MusicKit would reshuffle) and repeat restored.
- **Apple rate limits** (429) show as a message; browse results are cached 60 s.
- **ADE crash:** the host exits on stdin EOF or when the parent pid exits
  (on macOS with code 0 and no crash report, even though its pipes are gone).
- **macOS 12 or 13:** the host reports `unsupported_os` and exits.
