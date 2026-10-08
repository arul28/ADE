# Music

The Apple Music top tab plays Apple Music inside ADE with ADE's own UI: search,
library, recently played, an Up Next queue and a player. The tab exists only
while music is on, and the tab itself is the mini player. The home page's Now
Playing widget reads the same renderer store.

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
End keys. Only `MusicSeek` and the tab's progress line re-render on the position
tick (twice and once a second); the store keeps `nowPlaying` and `host` objects
stable across the main process's once-a-second pushes, so nothing else does.
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

Status (2026-10-08): **Windows plays full tracks after sign-in (verified by the
user).** macOS shows "Music on Mac is coming".

## How it works

```
Renderer (Music tab, mini player, Now Playing widget)
   │  window.ade.music  (IPC, typed in shared/types/music.ts)
Main process: musicService
   ├─ browsing ──► api.music.apple.com   (developer token + Music-User-Token)
   └─ playback ──► player host, stdio JSON
                     Windows: ade-music-host.exe (WebView2, hidden window)
                       └─ https://music.ade.local/index.html → MusicKit JS v3
```

- **Browsing never needs the player.** Search, library, recently played, track
  lists and ratings are `fetch` calls from the main process to the Apple Music
  API, cached for 60 s in memory.
- **The player host is started on demand** (the Music tab opens while
  connected, a play command arrives, or Connect is pressed) and **unloaded after
  5 minutes** without playback. Unloading keeps a snapshot (queue ids, index,
  second). The next play relaunches the host, restores the queue and continues
  at the same second. While unloaded the state says `host.status: "suspended"`
  and the mini player keeps showing the last song.
- **DRM.** WebView2's Widevine/PlayReady CDM plays full tracks (proved in the
  `tmp/spike-webview2-music` spike). Never pass `--disable-component-update` to
  WebView2: it removes the Widevine CDM and only previews play.

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
not: it can mean "no subscription").

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

macOS implements the same protocol later (a WKWebView helper with FairPlay).
`resolveMusicHostExecutable` (`services/native/nativeHelperPaths.ts`) returns null off Windows today, which is what puts
the tab in the "coming" state.

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
| `apps/desktop/native/ADEMusicHostWin/` | The Windows player host and its page. |
| `apps/desktop/scripts/build-music-host-win.mjs` | Reproducible host build. |
| `apps/account-directory/src/musicDeveloperToken.ts` | The Worker route that mints developer tokens. |

## Failure modes

- **No developer token:** signed out of ADE (production), the Worker has no key
  (503 `music_unavailable`), or no network. The tab shows "Music isn't
  available right now" with the reason and a Try again button.
- **Host binary missing:** dev builds say to run the build script; installs say
  to reinstall.
- **WebView2 runtime missing or broken:** `hostError` `webview2_missing` or
  `process_failed`; the next play starts a fresh host.
- **MusicKit CDN unreachable:** `loadFailed` after 20 s, shown in the tab.
- **Sign-in closed:** the window closing ends the wait after 2.5 s as
  "cancelled"; MusicKit's own promise can otherwise hang.
- **Token expiry mid-session:** a host keeps the developer token it was
  configured with (MusicKit has no way to swap it), so every token it gets has
  at least 24 h left and usually days; a host that played without a single
  idle unload for longer than that would hit an expired token (fixed by the
  next restart).
- **Resume after unload** restores the queue in its current order with shuffle
  off (re-enabling shuffle in MusicKit would reshuffle) and repeat restored.
- **Apple rate limits** (429) show as a message; browse results are cached 60 s.
- **ADE crash:** the host exits on stdin EOF or when the parent pid exits.
