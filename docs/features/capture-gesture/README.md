# Capture gesture

Press **both ⌘ keys** on macOS, or **both Ctrl keys** on Windows, anywhere on the OS. The window in front is captured, DAEX comes forward on `/cto`, and the shot is staged on the CTO composer. The command palette entry **"Ask the CTO about this screen"** does the same without the chord (`source: "command"`).

Desktop GUI only: there is no `daex` CLI or iPhone equivalent. Linux ships nothing (X11 and Wayland need different grabs, and Wayland refuses foreign-window capture without a portal), so the gesture is hidden there.

## Source file map

Shared
- `apps/desktop/src/shared/types/captureGesture.ts`: wire types. `CaptureGestureShot` carries the PNG inline as base64 (not a path) because the renderer stages it with `agentChat.saveTempAttachment`, which can land on another machine for a remote-bound chat. Also `appName`, `windowTitle`, `bounds`, `source` (`chord` / `command`), `isAdeWindow`, plus settings, health and failure types.
- `apps/desktop/src/shared/captureGesturePlatformSupport.ts`: the one availability predicate `isCaptureGestureSupported(platform, arch)` (true on `darwin` and `win32`), `captureGestureUnavailableReason`, `captureGestureChordLabel`. Main, preload and renderer all use it; do not hand-roll a platform check.

Main (`apps/desktop/src/main/services/capture/`)
- `captureGestureState.ts`: pure decisions. Helper path (`<resourcesPath>/native/…` packaged, `<appPath>/resources/native/…` dev), chord admission `evaluateCaptureChord`, protocol decoder `parseCaptureHelperOutput`, user copy `captureFailureFor` / `captureGestureHealth`, and the macOS remedy sentences shared by the refusal and the Settings health card.
- `captureShotFit.ts`: `fitCaptureShotToAttachmentLimit`, up to four width halvings to fit the attachment limit.
- `captureGestureTarget.ts`: `pickCaptureGestureWindow` (focused → last-focused DAEX window → any live window).
- `captureHelper.ts`: the NDJSON child supervisor. Line cap 64 KB, 3 restarts, 500 ms graceful shutdown, `captureNow()`, 8 s capture timeout, 48 MB read-back cap, `isAdeWindow` (helper `ownerPid` equals DAEX's pid). One boolean `captureInFlight` is the request latch; `settleCapture()` is the only place it is cleared.
- `apps/desktop/src/main/services/analytics/captureGestureProductAnalytics.ts`: `reportCaptureGesture` (`delivered` / `failed` / `too_large`), deduped per outcome per minute. See [logging.md](../../logging.md#the-capture-gesture).
- `apps/desktop/src/main/main.ts`: wires the helper, picks the window, focuses DAEX for a shot (not for a failure), and owns the temp dir.

Native helpers
- `apps/desktop/native/ADECaptureHelper/` (SwiftPM). `ADECaptureHelperCore` holds the pure pieces (`CommandKeyChordDetector.swift`, `ChordDetector.swift`, `Protocol.swift`) tested by `Tests/ADECaptureHelperCoreTests/ChordDetectorTests.swift` (`npm run test:capture-helper`). `Sources/ADECaptureHelper/main.swift` has the run loop, event tap and capture. Built by `npm run build:capture-helper` (part of `build:mac-native`).
- `apps/desktop/native/ADECaptureHelperWin/src/main.cpp`: Windows helper, same protocol. Built by `npm run build:capture-helper:win` (part of `dist:win*`; MSVC `cl.exe`, else `clang++`/`g++` for mingw-w64).

Renderer
- `apps/desktop/src/renderer/components/capture/GlobalCaptureGestureHost.tsx`: mounted once in `AppShell.tsx`. Subscribes to `captureGesture.onShot` / `onFailure`, calls `cto.ensureSession()`, navigates to `/cto` before staging, stages via `saveTempAttachment`, and dispatches `ade:agent-chat:add-attachment` (the same event `WorkSidebar` uses). Renders the fly-in and the failure notice (bottom-centre `role="status"`, clears after 6 s).
- `captureGestureDelivery.ts`: `planCaptureAttachments`, what to stage for one shot.
- `currentViewState.ts`: `composeCurrentViewState` / `formatCurrentViewState`. Over a DAEX window the shot gets a second attachment `<name>-context.md` (tab, route, project, lane name and id, open Work session, PR, focused editor file). Over another app's window nothing extra is attached.
- `captureGestureLocalSettings.ts`: machine-local switch, localStorage `ade:capture-gesture:enabled` (default on).
- `CaptureFlyIn.tsx`: thumbnail animation, `pointer-events: none`, skipped under `prefers-reduced-motion`.
- `apps/desktop/src/renderer/components/settings/CaptureGestureSection.tsx`: the settings card ([Onboarding and settings](../onboarding-and-settings/README.md#capturing-a-window-with-a-key-gesture)).
- `apps/desktop/src/renderer/lib/platform.ts`: renderer wrappers `supportsCaptureGesturePlatform()`, `captureGestureBlocker()`, `captureGestureChord()`.
- `apps/desktop/src/renderer/components/app/CommandPalette.tsx`: the palette entry, shown only when `supportsCaptureGesturePlatform() && !isWebClientMode()`.

## Gotchas / fragile areas

- **macOS 27 changed chord detection.** The static `NSEvent.modifierFlags` poll no longer carries the left/right Command device bits (`NX_DEVICELCMDKEYMASK` 0x8, `NX_DEVICERCMDKEYMASK` 0x10). The helper now uses a listen-only `CGEventTap` for `.flagsChanged` and reads key codes (55 left, 54 right) through `CommandKeyChordDetector`. That tap needs **Input Monitoring**. `CGPreflightListenEventAccess()` runs first; without the grant the helper sends `input-monitoring-required`, and if the tap still fails it sends `chord-unavailable`. It never sends `chord-ready` without a working monitor. `retry` re-attempts in place, and the Settings card polls health while its button is busy. macOS 26 and earlier keep the permission-free poll (`ChordDetector`).
- **Screen Recording** is needed for pixels on every macOS version. The helper shells out to `/usr/sbin/screencapture -l<windowID>` (the CG window-image call is deprecated).
- **Windows hook thread must keep pumping.** `WH_KEYBOARD_LL` is removed silently if its thread stalls (~300 ms). The callback only flips atomics and posts a message; `PrintWindow` (`PW_RENDERFULLCONTENT`) runs on a detached worker, one at a time. Left/right Ctrl come from the hook's `vkCode`; `GetAsyncKeyState` collapses them.
- **Windows key seeding.** Both Ctrl flags are re-seeded from `GetAsyncKeyState` at startup and on every `settings` command (re-seed, never clear), or a held key sticks up or down.
- **Windows GDI flush.** The bitmap is unselected from the memory DC before GDI+ encodes it, or the PNG can be torn or blank. Shutdown drains the worker for up to 500 ms before `GdiplusShutdown`, or the helper crashes on exit.
- **Shutdown is a message.** The supervisor writes `{"type":"quit"}` and closes stdin; both helpers also exit on stdin EOF, so an orphan cannot outlive DAEX. The kill backstop uses `terminateChildProcessTree` (the macOS helper has `screencapture` children); on POSIX the child is spawned `detached` so the group kill works.
- **Late shots are dropped.** A `captured` line after its own timeout is discarded and its PNG deleted, because the user was already told it failed.
- **Chord admission** refuses for `disabled`, `in-flight` (people hold modifiers, so one press would burst), and `cooldown` (1,200 ms; re-pressing one of two held keys re-fires).
- **Temp PNG.** The helper writes to `<temp>/ade-capture-<channel>` (one dir per release channel, `ade-capture-dev` unpackaged). The supervisor reads it to base64 and deletes it in a `finally`; dispose and `windows-uninstall-cleanup.ps1` sweep the dir.
- **Size limit.** `saveTempAttachment` rejects over `LEGACY_MAX_CHAT_ATTACHMENT_BYTES` (10 MB), so large shots are halved; after four halvings it fails with "That screen is too large to attach, even scaled down."
- **Packaging.** The binaries are gitignored and built per platform. They ship through the top-level `build.extraResources` filtered to `ade-capture-helper` and `ade-capture-helper.exe` (not `mac.extraResources`).

## Protocol

NDJSON both ways. Unknown messages are dropped on both sides so versions can drift.

| Direction | Messages |
|---|---|
| DAEX → helper | `capture`, `settings {enabled}`, `retry`, `quit` |
| helper → DAEX | `ready`, `chord-ready`, `input-monitoring-required`, `chord-unavailable`, `chord`, `captured {path, appName, windowTitle, ownerPid, bounds}`, `permission-denied`, `no-window`, `capture-failed {message}` |

The Windows command parser matches `"type":` then the value; a bare substring search once read a `"quit"` in another field as quit.

## Cross-links

- [CTO](../cto/README.md): where every capture lands.
- [Chat](../chat/README.md): `saveTempAttachment` and composer attachments.
