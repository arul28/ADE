# Windows Desktop

Each lane can own a Windows screen, the way it owns a private macOS screen. The
service, lease, window ownership, proof, streaming and Work-tools pane are
shared with [Mac Desktop](../mac-desktop/README.md); only the seat backend
differs. Read that page first. This page covers what Windows adds or changes.

Commands are `daex screen …` (`ade` still works; `windows-desktop` and
`mac-desktop` are aliases), with the Mac verbs plus `focus`, `minimize`,
`close`.

## Source file map

Windows-specific files only; the shared files are in the
[Mac Desktop map](../mac-desktop/README.md#source-file-map).

| Path | Role |
|---|---|
| `apps/desktop/native/ADEDesktopDriverWin/src/` | The native driver `ade-desktop-driver.exe` (C++). Same NDJSON wire, ops and error codes as the Mac driver. |
| `…/modes.h`, `main.cpp` | One binary, three modes: `host` (the brain's child in the console session), `child` (the engine inside the private screen, serving the host over named pipes), `setup-elevated` (the one-time admin step). |
| `…/host.cpp`, `hostwindow.cpp/.h` | Console-side lifecycle and NDJSON bridge on an STA thread; the host window that frames the Remote Desktop control (kept shown outside every monitor). The hard-deadline retire lives here. |
| `…/rdp.cpp/.h` | The Remote Desktop ActiveX control that opens the private child session. |
| `…/childtask.cpp/.h`, `child.cpp` | Starts the engine in the child session through a one-use logon task (startup entry and `child-launch.json` as fallback); the child-mode engine. |
| `…/ownedchild.cpp/.h` | `owned-child.json`: the child session this driver started, so a replacement signs out exactly that one. |
| `…/parkedwindows.cpp/.h` | `parked-windows.json`: the shared seat's parked windows, restored at the hard deadline and at every host start. |
| `…/engine.cpp/.h`, `engineLane.h`, `engineInput.cpp`, `engineLaunch.cpp`, `engineMedia.cpp` | Per-lane op table for one session (private or shared): lifecycle, input, app launch (including hand-off to a running instance), capture and recording. |
| `…/desk.cpp/.h` | Top-level windows, processes, app launch and `SendInput` for the process's session. |
| `…/uia.cpp/.h` | UI Automation: the cached element walk behind `observe`, element actions. |
| `…/background.cpp/.h` | Shared-seat background input: which frameworks drop posted input (`backgroundDrop`), posted click/drag/scroll/key/text, the focused-control walk, and the foreground shield. Follows trycua/cua's cua-driver (MIT). |
| `…/capture.cpp/.h`, `video.cpp/.h` | GDI `BitBlt` (private) and `PrintWindow` (shared) frames; Media Foundation H.264 for live view and MP4. |
| `…/credentials.cpp/.h`, `setup.cpp` | The saved Windows password in Credential Manager (never on the wire); the bounded admin prompt that starts `setup-elevated`. |
| `…/common.cpp/.h`, `json.cpp/.h` | Error codes, logging, line writer, JSON value. |
| `apps/desktop/scripts/build-windows-desktop-driver.mjs` | Builds the `.exe` into `resources/native`. |
| `apps/desktop/src/main/services/native/nativeHelperPaths.ts` | `resolveWindowsDesktopDriverBinary`. |
| `apps/desktop/src/main/services/windowsDesktop/windowsDesktopSeatProvider.ts` | The Windows `DesktopSeatProvider`: Mac ops plus `windows.status` / `windows.setup` and `seatMode` + consent on `display.create`. |
| `apps/desktop/src/main/services/windowsDesktop/windowsDesktopDriverClient.ts` | NDJSON client; reuses `macDesktopDriverClient.ts` for protocol, backoff, health, and the retire (exit 75) restart that replays queued requests. |
| `apps/desktop/src/main/services/windowsDesktop/windowsDesktopOperations.ts` | Setup / save-password / start operation record (`windowsDesktop.operation`, `phase`, `lastOperation`), the shared seat's per-host lease, the window-verb gate. |
| `apps/desktop/src/main/services/macDesktop/macDesktopBackgroundInput.ts` | What the service does with a background row: real-input retry for keys and text, `forceBackground` for the rest, the rate-limited report. |
| `apps/desktop/src/main/services/macDesktop/macDesktopLeaseFlow.ts` | `askChatAllowDeny`: the buttons-only Allow / Don't allow card for the Mac input lease and the shared-seat request (170 s wait). |
| `apps/desktop/src/shared/desktopSeat.ts` | `desktopSeatKind`, `describeDesktopSeat` (the status JSON's `seat`), `WINDOWS_DESKTOP_NEXT_STEP`. Re-exported from `shared/types/macDesktop.ts`, which holds `isUserOnlyConsentCard`, `MAC_DESKTOP_USER_CLI_HOLDER_ID` and `WINDOWS_DESKTOP_MAX_TYPED_CHARS`. |
| `apps/desktop/src/main/services/demoVideo/demoMp4Source.ts` | Reads the driver's MP4 for the desktop app's Chromium demo engine. |
| `apps/ade-cli/src/cliMacDesktop.ts`, `cliMacDesktopFormat.ts` | The `daex screen` plan builder (`start --shared`, window verbs, `setup`, `takeover`) and host-aware formatters and error hints (`macDesktopErrorHint`). |
| `apps/desktop/src/renderer/components/chat/WindowsDesktopStateCard.tsx` | The pane's no-picture states: setup, password, sign-in progress, failed step, held, locked, unavailable, ready. |
| `apps/desktop/src/renderer/components/terminals/LaneMacDesktopMarker.tsx` | The lane mark (Windows logo on a Windows host, seat in the tooltip). |
| `apps/desktop/src/renderer/components/app/AppShell.tsx` | The elevated-app warning banner (`ade.app.getElevatedDesktop` / `elevatedDesktopChanged`). |

## Gotchas / fragile areas

- **The RDP control must stay shown.** It sits outside every monitor and off
  the taskbar. Hidden, Windows treats the session as minimized and drops every
  injected click and key.
- **One private session per PC.** One lane holds it at a time. Shared seats are
  independent and can run in other lanes.
- **Elevated windows.** The private seat is a real sign-in of the same account,
  so logon tasks and startup apps run there, and an elevated admin window can
  take its foreground. Windows blocks the un-elevated driver from controlling
  it (`WINDOWS_DESKTOP_ELEVATED_WINDOW`; `[admin]` in status and window lists).
  DAEX never closes it; the user does.
- **Elevated DAEX app.** A desktop app started as administrator cannot be
  reached by the medium-integrity brain (pipe access is refused), so agents get
  no built-in browser, App Control recording or demo videos. `AppShell` docks a
  banner while it runs.
- **Retire is not a crash.** The driver exits 75 when its UI thread is wedged
  after a teardown or an operation passes its hard deadline. The brain restarts
  it at once without backoff, replays queued requests, and reports only lanes
  whose screen was lost.
- **Parked windows never strand.** Each parked window (handle, pid, process
  start, origin) is recorded atomically in
  `<ADE home>\windows-desktop\parked-windows.json`. At the hard deadline the
  host restores them if the record is free (never waiting on the stuck op),
  then retires. Every host start restores any record that still matches a live
  window exactly, then clears it. A window disabled by `ForegroundShield` is
  marked there too, so it is re-enabled after a crash.
- **Owned child session.** `owned-child.json` (session id, account, logon and
  connect time) lets a new driver sign out exactly the session the old one
  started. A child session DAEX did not start (Power Automate, a Windows agent
  workspace) reads as `WINDOWS_DESKTOP_HELD` and is never signed out.
- **Typing is slow on purpose.** Keystroke text is one character per
  `SendInput` with a pause (WinUI editors like Windows 11 Notepad drop batched
  characters). The brain allows 20 s + 25 ms per character, max 4,000
  characters per `type`. Accessibility typing on the shared seat sets the value
  or posts text at once.
- **Posted input succeeds even when ignored.** `backgroundDrop` comes from
  cua's measurements, not this PC's, so each affected delivery logs
  `windows_desktop.background_unavailable` and a rate-limited Sentry Log
  (`forwardSignalToSentry`) with exe, window class, fallback and whether the
  screen changed.
- **A UIA timeout stops the action** (`WINDOWS_DESKTOP_WINDOW_ACTION_FAILED`)
  instead of falling through to a second delivery that could repeat it.

## The two seats

| Seat | When | What the agent gets | Effect on the user |
|---|---|---|---|
| **Private** (default) | A set-up host in the console session with a free holder | A second Windows desktop of the user's own account (a Remote Desktop child session) with its own pointer, keyboard and foreground | None while the PC is unlocked |
| **Shared** | The user consents and the private seat is out or unwanted | The user's windows parked off-screen, driven by UI Automation and posted input first, real input under the lease when needed | Real keys and typing take the foreground for a moment |

The private seat shows the user's wallpaper and taskbar (same account), so
every surface states the seat in words. On a private screen the pane has no
**Release**, **Add app** or **Bring to my screen**: a window cannot move
between sessions.

### Real input and the lease

- **Private:** real input needs no lease (own pointer). A person who took
  control, or another chat holding the lease, still wins.
- **Shared:** the user's shared-seat consent covers real input; the acting
  chat takes the lane's lease on its first real action. The user's own trusted
  CLI (`daex --role cto screen …`) gets the stable holder `ade-cli-user`; the
  RPC scope strips `holderId` from agent callers. Any other chat-less caller
  is refused with `MAC_DESKTOP_INPUT_LEASE_REQUIRED`. Two shared lanes share
  one pointer, so every shared-seat action (UIA, posted, real, open, close)
  takes the lease; another lane gets `MAC_DESKTOP_LEASE_HELD_BY_OTHER` while
  it is live (about a minute after its last action). Focus and minimize do not
  activate, so they need no lease.
- A private holder and a shared lane run at once: different sessions.

### Asking for the shared seat

`daex screen start --shared --reason "<why>"` (action
`mac_desktop.requestSharedDesktop`) is agent-callable. It puts an Allow /
Don't allow card in the calling chat; the answer is the consent.

- Buttons only. Only the exact **Allow** option starts the seat; anything else
  is a no.
- Only a trusted user client (desktop, phone, web) can answer it. Agent callers
  (session-bound, an unbound shell, the CTO's approve tool) are refused by
  `chat.respondToInput` and `chat.approveToolUse` (`policyDenied`,
  `isUserOnlyConsentCard`); `personalChats.call` never answers one either.
- The card is withdrawn after about 170 s, before the caller's 180 s wait ends,
  so a late Allow cannot start an orphan seat
  (`WINDOWS_DESKTOP_CONSENT_REQUIRED`). Same code if a private screen started
  meanwhile, or the caller has no chat.
- An allowed chat is not asked again for that lane until it closes.

### Background input on the shared seat

- **Element actions** go through UI Automation. UWP, WinUI and
  Chromium/Electron apps activate themselves during one, so the driver disables
  the window's root for the call (`ForegroundShield`). Hung windows are not
  shielded.
- **Point clicks, scrolls and drags** (and elements with no pattern) are
  posted (`WM_*BUTTON*`, `WM_MOUSEWHEEL`).
- **Keys** are posted to the focused control (found across every UI thread, so
  WebView2 editors work); **text** no Value pattern takes is posted as
  characters.
- `backgroundDrop` rows: everything for Chromium and Electron; clicks, drags and
  (when not in front) keys for WPF; clicks and drags for WinUI 3; keys and text
  for UWP/XAML hosts (Windows 11 Notepad); clicks, keys and text for Tk; clicks
  for GTK; keys for LibreOffice; wheel and drags for WebView2 in a native frame.
- The service (`macDesktopBackgroundInput.ts`): keys and text with no mode
  named are refused by the driver (`WINDOWS_DESKTOP_BACKGROUND_UNAVAILABLE`)
  and resent as real input. Everything else carries `forceBackground`, and the
  reply names the row (`backgroundRow`); if nothing changes, the next step says
  the app usually ignores that input. A key chord or Shift key cannot be
  posted at all.

## Setup (once per PC, by the user)

Setup needs the user's admin prompt and Windows sign-in; an agent cannot do it.
The pane's first card is the wizard; an agent asks with an ask card.

1. **Turn on private screens.** One admin prompt (bounded to two minutes)
   enables child sessions and Remote Desktop.
2. **Save your password** (optional). A native Windows dialog asks for the
   account and password (not the PIN; `MicrosoftAccount\email` for a Microsoft
   account). DAEX verifies a private sign-in (30 s bound), signs it out, and
   saves the credential in Credential Manager. Nothing goes through the
   renderer, RPC, logs or sync. A rejected saved password is forgotten. CLI:
   `daex screen setup --allow-prompt --save-password` /
   `--forget-password`; password text is never an argument.
3. **Keep the PC unlocked.** A locked PC pauses the agent
   (`WINDOWS_DESKTOP_LOCKED`).

The private screen starts the user's own startup apps; use a blank test
document for proof (restored tabs can hold private files). The service tracks
setup, save and start progress (`windowsDesktop.operation`), so the pane shows
the same progress after leaving and returning.

## Errors

Windows-only codes, mirrored in `shared/types/macDesktop.ts`:

- `WINDOWS_DESKTOP_SETUP_REQUIRED`: setup not run.
- `WINDOWS_DESKTOP_HELD`: another lane holds the private screen (take over, or
  use the shared desktop), or a child session DAEX did not start exists (sign
  it out in Task Manager › Users).
- `WINDOWS_DESKTOP_LOCKED`: PC locked; unlock resumes.
- `WINDOWS_DESKTOP_NOT_CONSOLE_SESSION`: the brain is not in the console
  session (started over RDP or SSH), so no private seat.
- `WINDOWS_DESKTOP_SIGN_IN_FAILED` / `_WRONG_PASSWORD` / `_CANCELLED`: the
  sign-in step.
- `WINDOWS_DESKTOP_CONSENT_REQUIRED`: shared seat without consent, or a no.
  Enforced in the service.
- `WINDOWS_DESKTOP_ELEVATED_WINDOW`: an admin window holds focus or is the
  target.
- `WINDOWS_DESKTOP_WINDOW_ACTION_FAILED`: focus/minimize failed, or a UIA
  action timed out (it may still have landed; observe first).
- `WINDOWS_DESKTOP_BACKGROUND_UNAVAILABLE`: the app would ignore posted input.
  Callers see it only for a chord or Shift key with an explicit accessibility
  mode.

## Policy

Enforced at the service and action boundaries, never in prompts:

- `mac_desktop.setupWindows`, `mac_desktop.takeoverWindows` and
  `mac_desktop.useSharedDesktop` are CTO-only. A session-bound agent cannot
  self-authorize with `allowPrompt: true` or `sharedDesktopConsent: true`.
- `mac_desktop.start` refuses `seatMode: "shared"`; only `useSharedDesktop`
  and `requestSharedDesktop` carry consent.
- Window verbs (`focusWindow`, `minimizeWindow`, `closeWindow`; driver ops
  `window.*`) and `requestSharedDesktop` are agent-callable, scoped to the
  caller's own lane. A Mac host refuses window verbs and `--win` with
  `MAC_DESKTOP_UNSUPPORTED_PLATFORM`.

## Behavior notes

- One Windows driver per DAEX home, shared by every open project; a lane's
  events reach only its project.
- Modifiers: `--ctrl`, `--alt`, `--shift`, `--win`; `--cmd` is sent as Ctrl,
  `--opt` as Alt.
- `daex screen open` prints the windows that appeared, the resolved exe and
  the lane browser profile, or why no window appeared (`handedOff`: an
  existing instance took the request).
- The Work tools pane shows **Windows Desktop** on a Windows host and **Mac
  Desktop** on a Mac; a host that cannot run its tool keeps a disabled card
  with the reason. The command palette reads the same answer
  (`desktopToolContext`).
- While a shared seat is live the pane shows "Using your main Windows desktop"
  with **Stop** (asks first; it quits the lane's apps).
- Watch-only clients (phone, view-only browser) get **Stop** on either seat
  through the viewer-allowed `macDesktop.stopSeat` remote command. A Mac
  display is refused (that stays controller-only `macDesktop.stop`).
  `macDesktop.stopPrivate` stays for older phones.
- Recording: the driver writes H.264 MP4; the desktop app's Chromium demo
  engine makes the demo at stop ([proof](../proof.md#how-it-works)). With no
  desktop app attached it is filed as recorded. An empty, unfinished or
  malformed MP4 is not filed and `record stop` exits non-zero.
- The `daex` command returns the CLI's exit code on Windows.
