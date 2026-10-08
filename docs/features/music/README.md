# Music

The Music top tab plays Apple Music inside ADE with ADE's own UI: search,
library, recently played, an Up Next queue and a now-playing bar. A mini
player sits in the top bar on every tab while a song is loaded. The home page's
Now Playing widget reads the same renderer store.

Status (2026-10-08): **Windows works up to sign-in; playback after sign-in is
not yet verified by a person.** macOS shows "Music on Mac is coming".

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
| Developer token (ES256 JWT, 24 h) | Production: `GET /music/developer-token` on the account directory, signed-in ADE users only. Dev (unpackaged builds): minted locally from the `.p8`. A packaged build never reads a local key. | Main-process memory; refreshed 2 h before expiry. Logged only as its first 6 characters. |
| Music-User-Token | MusicKit `authorize()` in the player host, after the user signs in with Apple | ADE's desktop credential store (`music.appleMusic.userToken`, the Electron safeStorage store the API keys use, not the file store the brain shares). Sent to the host over stdin on each start. |

Disconnect calls MusicKit `unauthorize()`, deletes the stored token and stops
the host. A 401 from Apple on a `/v1/me` call drops the token too (a 403 does
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
  ADE process it was given (`--parent-pid`) exits.
- `page/player.js`: the MusicKit control script. Commands: `configure`,
  `authorize`, `unauthorize`, `state`, `queue`, `playItems`, `playCollection`,
  `pause`, `resume`, `toggle`, `stop`, `next`, `prev`, `seek`, `volume`,
  `shuffle`, `repeat`, `playAt`, `playNext`, `playLater`, `snapshot`. Events:
  `loaded`, `state`, `time` (once a second while playing), `queueChanged`,
  `authorization`, `playbackError`, `loadFailed`; the host adds `hostReady`,
  `hostClosing`, `hostError`, `authWindow`.

Wire format, one JSON object per line: `{"rid":"r1","cmd":"seek","position":60}`
in, `{"reply":"r1","ok":true,"result":{…}}` or `{"event":"time",…}` out.

macOS implements the same protocol later (a WKWebView helper with FairPlay).
`resolveMusicHostExecutable` returns null off Windows today, which is what puts
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
useMusicState(selector)                      // the full MusicState
musicActions.toggle() / play() / pause() / next() / previous() / seek(s)
musicActions.setVolume(0..1) / setShuffle(bool) / setRepeat(0|1|2)
musicActions.playItems(ids, index?, shuffle?) / playCollection(kind, id, index?, shuffle?)
musicActions.playNext(ids) / playLater(ids) / playAt(index)
musicActions.connect() / disconnect() / warm() / open()  // open() shows the Music tab
formatMusicTime(seconds)
```

`musicArtworkUrl(artwork, px)` and `musicPositionNow(playback)` live in
`shared/types/music.ts`. Every hook shares one IPC subscription.

## Entry points

- Top bar: the music-note button (no song loaded) or the mini player.
- Shortcut: **Mod+Shift+M** (`shell.music.open`, rebindable).
- The Music top tab (`/music`) is machine-level like Chats and Browser; closing
  the tab does not stop the music.
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
| `apps/desktop/src/renderer/components/music/` | `MusicPage`, `MusicNowPlayingBar`, `MusicTopBarControl`, `musicParts`, `musicStore`, `musicTab`, `music.css`. |
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
- **Token expiry mid-session:** the developer token is refreshed before each
  host start; a host that has played for more than 22 hours straight without an
  unload could hit an expired token (not handled beyond the next restart).
- **Resume after unload** restores the queue in its current order with shuffle
  off (re-enabling shuffle in MusicKit would reshuffle) and repeat restored.
- **Apple rate limits** (429) show as a message; browse results are cached 60 s.
- **ADE crash:** the host exits on stdin EOF or when the parent pid exits.
