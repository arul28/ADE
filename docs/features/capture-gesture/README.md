# Capture gesture

Press **both ⌘ keys** on macOS, or **both Ctrl keys** on Windows, anywhere on the OS — in ADE, in a browser, in Xcode, over a video call — and the window in front is captured and handed to the CTO. If a voice call is on air the shot goes into the conversation; otherwise it is staged on the CTO composer and ADE comes forward with it already attached.

The whole feature is one sentence of user intent — *ask the CTO about what I am looking at* — and everything below is what that sentence costs to implement without asking the user for a permission they would refuse.

## Source file map

### Shared

- `apps/desktop/src/shared/types/captureGesture.ts` — the wire types three processes read. `CaptureGestureShot` carries the PNG **inline as base64** rather than as a path, because the renderer hands it straight to `agentChat.saveTempAttachment`, which stages attachments into the chat's own directory — and, for a remote-bound chat, onto the other machine. A path would only be meaningful on the capturing machine. It also carries `appName`, `windowTitle`, `bounds` (for the fly-in), `source` (`chord` or `command`), and `isAdeWindow`. Also `CaptureGestureSettings`, `CaptureGestureHealth` + `CaptureGestureHealthState`, and `CaptureGestureFailure`.
- `apps/desktop/src/shared/captureGesturePlatformSupport.ts` — the single availability predicate: `isCaptureGestureSupported(platform, arch)` (true on `darwin` and `win32`), `captureGestureUnavailableReason`, `CAPTURE_GESTURE_UNSUPPORTED_BLOCKER`, and `captureGestureChordLabel` ("both ⌘ keys" / "both Ctrl keys"). It is deliberately **not** a `process.platform === "darwin"` check copied into main, preload, and the renderer: there was no "macOS and Windows but not Linux" predicate in the codebase before this, and three hand-rolled copies would drift the moment a fourth target appears. `arch` is accepted and ignored — both helpers cover their platform's packaging target today — but it stays in the signature so a future arch-specific gap cannot change the function's shape out from under its callers.

### Main process (`apps/desktop/src/main/services/capture/`)

- `captureGestureState.ts` — everything about the gesture that is a decision rather than an effect, split out for the same reason `attentionNotchRouter` is split out of `attentionNotchHelper`. Owns `captureHelperExecutableName` and `resolveCaptureHelperExecutablePath` (packaged: `<resourcesPath>/native/…`; dev: `<appPath>/resources/native/…`), the chord admission rule `evaluateCaptureChord`, the protocol decoder `parseCaptureHelperOutput`, the user-facing `captureFailureFor` and `captureGestureHealth`, and `captureAttachmentFilename`. None of it needs a process to test.
- `captureHelper.ts` — the supervisor. Deliberately the same shape as `AttentionNotchHelper` — line cap (`MAX_HELPER_LINE_BYTES`, 64 KB), restart budget (`MAX_RESTART_ATTEMPTS`, 3), graceful-shutdown window, `windowsHide` — because the failure modes of a supervised NDJSON child are identical and a second, subtly different supervision policy in the same app is how one of them rots. It also owns `captureNow()`, the capture timeout (`CAPTURE_TIMEOUT_MS`, 8 s), the read-back cap (`MAX_CAPTURE_BYTES`, 48 MB), and the `isAdeWindow` determination. One boolean, `captureInFlight`, is the whole request latch — there is no generation counter — and `settleCapture()` is the single place it is cleared: it returns whether anything was actually in flight, so a `captured` line that arrives after its own timeout already reported a failure is dropped rather than delivered as a shot the user has been told did not happen, and its orphaned PNG is deleted rather than left for the dispose-time purge. Failures do not go through that gate at all: the Windows helper emits `permission-denied` at startup, before any capture was asked for, and that is the one signal saying why the gesture will never fire.

### Native helpers

- `apps/desktop/native/ADECaptureHelper/` — the macOS helper (SwiftPM). `Sources/ADECaptureHelperCore/ChordDetector.swift` is the pure rising-edge detector, `Protocol.swift` the NDJSON codec, `Sources/ADECaptureHelper/main.swift` the run loop and window capture. Built by `npm run build:capture-helper`.
- `apps/desktop/native/ADECaptureHelperWin/src/main.cpp` — the Windows helper, same NDJSON contract. Built by `npm run build:capture-helper:win`.

### Renderer (`apps/desktop/src/renderer/components/capture/`)

- `GlobalCaptureGestureHost.tsx` — mounted once in `AppShell.tsx`, inside the router and above every tab. It subscribes to `captureGesture.onShot` / `onFailure`, resolves the delivery target, stages attachments, navigates to `/cto`, and renders the fly-in and the failure notice.
- `captureGestureDelivery.ts` — the routing decision as pure functions: `isCallJoinable`, `planCaptureAttachments`, `describeShot`. (Base64 lives in `renderer/lib/base64.ts`, shared with chat attachments and voice audio.)
- `currentViewState.ts` — `CurrentViewState`, `composeCurrentViewState`, and `formatCurrentViewState`: "what is ADE showing right now", as a thing you can attach to a message.
- `captureGestureLocalSettings.ts` — the machine-local on/off switch (`ade:capture-gesture:enabled`, default on) and `captureGestureBridgeAvailable()`.
- `CaptureFlyIn.tsx` — the captured thumbnail flying into the composer. Two frames and a CSS transition, no animation library; `pointer-events: none` throughout, because a 420 ms overlay that eats a click is worse than no animation.
- `apps/desktop/src/renderer/components/settings/CaptureGestureSection.tsx` — the settings card. See [Onboarding and settings › Capturing a window with a key gesture](../onboarding-and-settings/README.md#capturing-a-window-with-a-key-gesture).
- `apps/desktop/src/renderer/lib/platform.ts` — `supportsCaptureGesturePlatform()`, `captureGestureBlocker()`, `captureGestureChord()`, the renderer wrappers over the shared predicate.

## Why a modifier-only chord

Any global shortcut with a letter in it is a key-event tap, and on macOS a key-event tap is gated behind Accessibility — a permission dialog that takes the user out of ADE, into System Settings, and that a fair number of people will simply decline. A gesture nobody grants permission for is a gesture nobody has.

Both modifier keys held at once avoids that entirely, and it is also a chord that no application binds, needs no chooser UI, and is the same physical motion on both platforms. The cost is that it is not configurable; that is the trade the feature is built on.

### The macOS consequence: poll, do not monitor

`main.swift` detects the chord by **polling `NSEvent.modifierFlags`** on a timer rather than installing a global `.flagsChanged` monitor or a `CGEventTap`. That is not a style choice and must not be "cleaned up":

> `NSEvent.addGlobalMonitorForEvents` and `CGEventTap` are key-event taps, and macOS gates both behind Accessibility. `NSEvent.modifierFlags` is a **static read of current hardware state** — not an event delivery — and is not gated at all.

Swapping the poll for a monitor would read exactly the same keys and immediately reintroduce the permission prompt the chord exists to avoid.

Telling the two ⌘ keys apart takes one more step. `NSEvent.ModifierFlags.command` only reports "a Command key is down". The device-dependent masks from `IOKit/hidsystem/IOLLEvent.h` ride along in the same raw value and do distinguish them, so `ModifierMask` names the two bits ADE reads:

| Mask | Value |
|---|---|
| `NX_DEVICELCMDKEYMASK` (`ModifierMask.leftCommand`) | `0x0000_0008` |
| `NX_DEVICERCMDKEYMASK` (`ModifierMask.rightCommand`) | `0x0000_0010` |

`ChordDetector.consume(rawFlags:)` is a pure rising-edge detector over those two bits, and **latching is the whole job**: modifier keys are held, so a poll sees the same both-down sample a dozen times for one deliberate press. It fires once on the transition into both-down and cannot fire again until at least one key has been released. `reset()` drops the latch without reporting a chord, so switching the gesture off while the keys happen to be down does not fire the moment it is switched back on.

The pixels come from `/usr/sbin/screencapture -l<windowID>`, not `CGWindowListCreateImage`: the CG call was deprecated in macOS 14 in favour of ScreenCaptureKit, whose window capture is async and pulls in a much larger surface, while `screencapture` is a supported, stable tool that does exactly one window. It does require the **Screen Recording** grant, which is why the app declares `NSScreenCaptureUsageDescription`. That grant is the one permission this feature asks for, and it is asked for by the capture rather than by the keyboard.

### The Windows consequence: a low-level hook, read per-key

`main.cpp` installs `WH_KEYBOARD_LL` and reads `VK_LCONTROL` and `VK_RCONTROL` **separately out of the hook struct's `vkCode`**. `GetAsyncKeyState` cannot do this job at all: it collapses both keys into `VK_CONTROL`, so "both Ctrl keys" is not expressible there.

The hook comes with a hard constraint that shapes the whole process: `WH_KEYBOARD_LL` calls back on the thread that installed it, and Windows *silently removes* a hook whose thread stops pumping messages (`LowLevelHooksTimeout`, 300 ms by default). So the callback does nothing but flip two atomics and `PostMessage` — no capture, no file I/O, no allocation. The same latch as the macOS `ChordDetector` (`g_chord_engaged`) lives beside them, for the same reason.

Pixels come from `PrintWindow` with `PW_RENDERFULLCONTENT`, which is defined locally if the SDK is older, because it is the only capture path that works for Chromium and DirectComposition windows.

The same constraint puts the capture itself on a **worker thread**. `PrintWindow` on a large window is tens of milliseconds and the message loop is the hook's own thread, so running it inline would stall the pump and get the hook silently uninstalled. The loop therefore posts `kMsgCapture` to itself and spawns a detached `std::thread`; `g_capture_in_flight` keeps it to one at a time, and joining would be the very stall this avoids. Shutdown has to wait for that worker anyway — a detached thread still holding GDI+ objects when `GdiplusShutdown` runs crashes on the way out, which the supervisor reads as a helper that died — so the loop drains for up to `kShutdownDrainMs` (500 ms) before tearing GDI+ down. That bound is the supervisor's own `GRACEFUL_SHUTDOWN_MS`: waiting longer buys nothing, because the supervisor kills the process at that mark regardless.

### Shutdown is a message, not a signal

**Windows has no deliverable SIGTERM.** Node's `child.kill("SIGTERM")` becomes `TerminateProcess`, which gives a process mid-BitBlt no chance to release its DCs and bitmaps. So shutdown is the in-band `{"type":"quit"}` line on stdin: the supervisor writes it, the helper posts `WM_QUIT` to its own message loop, and the forced kill only fires as a backstop when the child has not exited inside `GRACEFUL_SHUTDOWN_MS` (500 ms). The Windows loop **also** exits when stdin closes, so an orphaned helper cannot survive its parent.

The macOS helper speaks the same protocol, so one supervisor covers both.

## The protocol

NDJSON both ways, one message per line.

| Direction | Messages |
|---|---|
| ADE → helper | `{"type":"capture"}`, `{"type":"settings","enabled":bool}`, `{"type":"quit"}` |
| helper → ADE | `{"type":"ready"}`, `{"type":"chord"}`, `{"type":"captured", path, appName, windowTitle, ownerPid, bounds}`, `{"type":"permission-denied"}`, `{"type":"no-window"}`, `{"type":"capture-failed", message}` |

Both sides drop what they cannot interpret rather than failing. `HelperCommand.parse` returns nil for an unknown command so a newer ADE can add one without wedging an older helper; `parseCaptureHelperOutput` returns null for both malformed JSON and a well-formed message this build has never heard of — the caller logs them differently, because only the first is a protocol violation worth showing in health.

### Chord admission

`evaluateCaptureChord` refuses a chord for three reasons that are **not** interchangeable:

- `disabled` — the setting is off. The helper should not be running, but a chord already in flight when the user flipped the switch must not land.
- `in-flight` — a capture is already running. `screencapture` takes 100–300 ms and the chord is *modifier keys*, which people hold; without this one deliberate press produces a burst of identical attachments.
- `cooldown` — a shot landed inside `DEFAULT_CHORD_COOLDOWN_MS` (1,200 ms). Releasing and re-pressing one of two held ⌘ keys re-fires the chord, so the in-flight guard alone does not cover a natural press-and-wiggle.

### The PNG is a millisecond-long handoff

The helper writes the capture to a file under the OS temp root and names the path in its `captured` message. The supervisor stats it (non-empty, under `MAX_CAPTURE_BYTES`), reads it to base64, and **deletes it in a `finally`**, with a dispose-time purge of the whole directory as the backstop and `windows-uninstall-cleanup.ps1` sweeping it for the case where ADE was killed in between. Nothing durable is written; the file exists only because two processes cannot pass a bitmap any other way. The directory is `<temp>/ade-capture-<channel>`, one per release channel, so Stable, Beta, Alpha and dev never share one. An unpackaged build uses `ade-capture-dev`.

## The target is always the CTO

There is no "capture to clipboard" and no destination chooser. There are two destinations and no payload either way, so the decision is a boolean, not a tagged union:

- **A call is live** → `deliverToCall`. The shot is spoken about, not filed: the host only dispatches the `ade:cto-voice:attach-capture` DOM event. `useCtoVoiceCall` listens for it and calls the optional `ctoVoice.attachImage` bridge, which forwards the shot into the conversation with a note. The host does not call the bridge itself; doing both sent one capture to the live model two or three times. Pointing at something while you talk about it is why the gesture and the call were designed together, so the call consumes the shot rather than making the user go find a composer they are not looking at. See [CTO › Voice calls](../cto/README.md#voice-calls).
- **No call** → `deliverToComposer`. `cto.ensureSession()` resolves the thread, ADE navigates to `/cto` **before** the chips appear — so an attachment is never staged onto a composer nobody is looking at — and each file is staged through `agentChat.saveTempAttachment` and announced with the `ade:agent-chat:add-attachment` event, the same one `WorkSidebar` dispatches.

`isCallJoinable` decides, and it asks two things. The phase must be live — `isVoiceCallLive` in `shared/types/ctoVoice.ts` excludes `idle`, `ended` and `failed` **by name**, so a phase added later defaults to live rather than silently dropping captures. The phase list is not repeated here; a second copy of it was the drift that helper was written to end. On top of it, the call must have an id: one the main process cannot address is not one a shot can reach.

### Over ADE's own window, the image travels with view state

A screenshot of ADE tells the CTO what the pixels look like and nothing about what they mean. It cannot read the lane id behind a truncated chip, the PR number behind a scrolled header, or which of four editor tabs is focused. So when `isAdeWindow` is true — `ownerPid` equals ADE's own pid — `planCaptureAttachments` stages a second attachment: `<name>-context.md`, built by `formatCurrentViewState` from a `CurrentViewState` (tab, full route, project, lane name and id, the Work tab's open session, the PR number/repo/detail tab, and the focused editor file).

No single accessor answered that question before. The pieces already existed and were scattered across `selectActiveProjectStateKey` and `selectWorkViewState` in `appStore`, `readStoredProjectRoute`, `parsePrsRouteState`, and `editorGroupsStore`; `currentViewState.ts` is the one place that assembles them, as a pure function over an injected snapshot rather than a hook, so the formatting is testable without mounting the app.

Over another application's window ADE knows nothing worth attaching, and the note is omitted rather than guessed at. The image still carries provenance through `describeShot` — "Screenshot of Safari — …" rather than the single least useful thing you can hand an agent, an unlabelled screenshot.

## Focus, feedback, and failure

- **A shot steals focus; a failure does not.** `main.ts` brings ADE forward *before* sending the shot event, because the fly-in animation is pointless behind another app's window and the gesture means "take me to the CTO with this". A failure is sent without activating: the user pressed a chord over someone else's window, and yanking them into ADE to read "there was no window in front" is worse than the failure itself.
- **The shot goes to the window the user was last in.** The gesture's whole point is firing over ANOTHER app's window, so `BrowserWindow.getFocusedWindow()` is null exactly when a capture happens, and `getAllWindows()[0]` is creation order — an arbitrary project, usually not the one the user was working in. `captureGestureWindow()` therefore falls back to `lastFocusedAdeWindowId` before it falls back to the first live window, and both the shot and the failure notice go to the same place. With no live window at all nothing is sent: a gesture that can fire while ADE is in the background must not conjure a window the user did not ask for.
- The fly-in is skipped entirely under `prefers-reduced-motion`, which `GlobalCaptureGestureHost` decides so `CaptureFlyIn` is free to assume motion is wanted.
- Failures render as a bottom-centre `role="status"` notice that clears after 6 s. `captureFailureFor` writes the words, including the Screen Recording instruction, so no caller restates a permission path and gets it subtly wrong.

## Without the chord

The command palette carries **"Ask the CTO about this screen"**, which calls `captureGesture.captureNow()` and produces a shot with `source: "command"`. `captureNow()` returns `false` rather than leaving the user waiting when the request is refused — unsupported platform, gesture switched off, helper not up yet, capture already in flight — and each refusal has its own sentence.

The entry is present only where a helper exists (`supportsCaptureGesturePlatform() && !isWebClientMode()`). The palette must not offer a command that resolves to "not available here"; the settings card is where that sentence belongs.

## Packaging

The helpers stage like `whisper-cli`, not like `ade-attention-notch`.

`ade-attention-notch` is macOS-only, so it sits in the **`mac.extraResources`** block. The capture helpers ship through the **top-level `build.extraResources`** entry, copying `resources/native` filtered to exactly `ade-capture-helper` and `ade-capture-helper.exe`. One entry covers both platforms, and because each build script only produces its own platform's binary, the Mac package contains only the Mach-O and the Windows package only the `.exe` — with no per-platform configuration to keep in sync.

Neither helper can be cross-compiled, so each build script **skips cleanly off its platform** (the same guard `build-attention-notch.mjs` uses) and each is wired into its own platform's dist script: `build:capture-helper` into `dist:mac*`, `build:capture-helper:win` into `dist:win*`. The Windows script accepts MSVC `cl.exe` first and falls back to `clang++`/`g++` targeting mingw-w64.

The generated binaries are gitignored; `apps/desktop/resources/native/README.md` documents both commands.

## Limits

- **A big display's shot is downscaled, not dropped.** The helper accepts up to `MAX_CAPTURE_BYTES` (48 MB), but `saveTempAttachment` moves bytes as base64 in a command payload and rejects anything over `LEGACY_MAX_CHAT_ATTACHMENT_BYTES` (10 MB). `fitCaptureShotToAttachmentLimit` in `main.ts` halves the PNG (via `nativeImage.resize`, width only, so the aspect ratio is kept) until it fits, and only fails — with "That screen is too large to attach, even scaled down." — if four halvings are not enough. Before this the oversized capture reached the composer and then failed to stage, so the gesture silently did nothing.
- **Desktop GUI only, deliberately.** The gesture is an OS-level key hook plus a native window grab, so there is no `ade` CLI, `ade code` TUI, or ADE Mobile equivalent — nothing to mirror, and the shot has to reach a composer on the machine that took it.
- **Linux ships nothing.** X11 and Wayland need different grabs, Wayland refuses foreign-window pixel capture outright without a portal handshake, and ADE has no Linux packaging target. The gesture is hidden there rather than shipped as a permanently dead switch.
- **Both helper binaries are built, not committed.** `resources/native` is gitignored, so a checkout carries the helper sources only. `npm run build:capture-helper` produces the macOS binary locally, and each platform builds its own helper at package time.
- **Voice delivery goes through the same store the HUD reads.** `GlobalCaptureGestureHost` subscribes via `subscribeVoiceState` rather than opening its own `onState` listener — a second subscription delivered every push twice — and decides with `isCallJoinable(state)`, which needs a live phase *and* a call id. With no bridge at all (the hosted web client, the browser preview) the store never leaves `idle`, so the shot goes to the composer. The delivery event is dispatched in whichever window is in front and reaches the one service in the main process, so a capture taken from a window that does not hold the microphone still lands in the call.

## Cross-links

- [CTO](../cto/README.md) — the thread every capture lands on, and the voice call a capture joins when one is live.
- [Onboarding and settings](../onboarding-and-settings/README.md#capturing-a-window-with-a-key-gesture) — the switch, the health card, and where the preference is stored.
- [Chat](../chat/README.md) — `saveTempAttachment` and the composer attachment path a staged capture uses.
