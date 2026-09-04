# iOS Sim Control page parity

What the plugin's page carries against ADE's compiled simulator pane, and what it
does not. **The gaps at the bottom drive the acceptance walk** — read them before
judging the page, because each one is a thing the owner will look for and either
find working or find deliberately absent.

Compiled sources this was measured against, all still in the binary:
`ChatIosSimulatorPanel.tsx` (**3,777**), `IosSimToolChips.tsx` (216),
`IosSimVideoOverlay.tsx` (215), `IosSimLaunchStepper.tsx` (146),
`IosSimOwnershipCard.tsx` (48), plus `iosSimContracts.ts` for the two helpers the
page needed (`formatAge`, the reveal/settings verbs).

## Placements

| Compiled placement | Page surface | Placement | State |
|---|---|---|---|
| Work-rail simulator pane | `sim` | `pane` | Carried |
| Command palette → open the simulator | `sim` | `pane` | Carried (same surface) |
| Vocabulary canvas mount (`canvas` / `simulator`) | — | — | **Removed** — the canvas mounted the compiled pane, and the page replaces it |
| Phone | — | `main` panel | **Deliberately none** — see below |

Both sockets name `webviewSurfaceId: "sim"`, which resolves to the one declared
surface, and the manifest parses with **no errors and no warnings** — checked
against `shared/plugins/manifest.ts` and `shared/plugins/sockets.ts` as shipped.
The rail label is `"iOS Sim Control"` (16 characters, under the 24-character
`work-rail-pane` cap); the palette entry, capped at 40, is the same name.

## The one structural change: the stream stayed in the host

`ChatIosSimulatorPanel.tsx` is 3,777 lines because it held two jobs at once. The
first is chrome. The second is a `Simulator.app` **window capture** —
`desktopCapturer` constraints, a `<video>` element, `requestVideoFrameCallback`,
frame-stall detection at 3s, window-parking retain/release, a luminance
heuristic that finds the device screen inside the captured window, and a
two-speed window-state poll.

None of that can cross into a sandboxed guest, and it should not: a plugin page
with `getUserMedia` over a desktop source is a capability escape wearing a
feature's clothes. So the second job stays in the host engine and the page
reserves a rect for it (`page/src/components/EngineStage.tsx`,
`page/src/host/engine.ts`). Everything a reader touches moved.

## Host calls

`ChatIosSimulatorPanel.tsx` makes **24 distinct `window.ade.iosSimulator.*`
calls**. Twenty have a page action; four are the engine's and are answered by
the placement contract instead:

| Compiled call | Page action |
|---|---|
| `getStatus` | `pageStatus` |
| `listDevices` | `pageDevices` |
| `listLaunchTargets` | `pageLaunchTargets` |
| `launch` | `pageLaunch` |
| `shutdown` | `pageShutdown` |
| `attachToChatSession` | `pageAttachChat` |
| `getScreenSnapshot` | `pageScreenSnapshot` |
| `selectPoint` | `pageSelectPoint` |
| `tap` | `pageTap` |
| `typeText` | `pageTypeText` |
| `drag` | `pageDrag` |
| `startStream` | `pageStartStream` |
| `stopStream` | `pageStopStream` |
| `getStreamStatus` | `pageStreamStatus` |
| `listPreviewTargets` | `pagePreviewTargets` |
| `resolvePreviewMatch` | `pageResolvePreviewMatch` |
| `ensurePreviewWorkspace` | `pageEnsurePreviewWorkspace` |
| `renderPreview` | `pageRenderPreview` |
| `renderCurrentPreview` | `pageRenderCurrentPreview` |
| `openPreviewWorkspace` | `pageOpenPreviewWorkspace` |
| `onEvent` | `events.on("changed")` — the child holds the subscription and republishes |
| `getSimulatorWindowState` | the host engine's |
| `retainWindowParking` | `hostEngine.place({ engineId: "simulator", rect })` |
| `releaseWindowParking` | `hostEngine.release()` |

Five more page actions exist because the chrome needs them and the compiled pane
reached them through a sibling module: `pageScreenshot`,
`pageInspectorSnapshot`, `pageInspectPoint`, `pagePreviewCapability`,
`pageSwipe`. **Twenty-five page actions in all**, and `test/pageActions.test.js`
walks every one.

The three non-simulator host calls moved too: `window.ade.app.openExternal`
became `openDeeplink` (the host decides browser or external),
`window.ade.app.writeClipboardText` became `clipboard.write`, and
`window.ade.agentChat.saveTempAttachment` is **gone** — see the gaps.

## Carried, surface by surface

| Compiled | Page | Note |
|---|---|---|
| Simulator / Preview surface switch | Carried | Same two-button rail |
| Device picker + refresh | Carried | Choice persists in `ui-state` |
| Stop, with a confirm | Carried | `ui.confirm`, not `window.confirm` — a modal inside a guest blocks the host's own loop |
| Launch-target picker, collapsing to a read-only line at ≤1 target | Carried | |
| Launch / Apply | Carried | Apply is the same verb; it only draws while a session is live |
| Control / Inspect toolbar | Carried | Overlaid on the stage, outside the reserved rect so it cannot be tapped through |
| Tap, drag, type | Carried | Mapped through the reserved rect rather than a `<video>`'s object-contain box — the same number, because the rect *is* the painted box |
| Inspect → element, with its source file and line | Carried | |
| Zoom rail (expand, −, %, +) | Carried | Zoom grows the reserved rect inside a scrolling frame |
| Four setup chips + copyable install hints | Carried | `clipboard.write` replaces the renderer copy |
| Unsupported card | Carried | |
| Ownership card (Attach / Take over) | Carried | `pageAttachChat` answers a refusal, never throws |
| "prebuilt — changes not included" | Carried, as a **message** | The child says it in `pageLaunch`'s `message` rather than as a chip |
| Preview Lab: target picker, match line, Render, View in simulator, Refresh, Open Xcode, Setup docs | Carried | Open Xcode draws only when the host has `ui.openPathInEditor` |
| Rendered preview PNG | Carried | Drawn by the page — a render is a data URL, not a live capture |

## No phone page

Every `webview` surface declares `"mobile": false`. That is not a narrowing of
something that could have worked: `parseSurfaces` sets the mobile ceiling for a
`webview` to `false` unconditionally and warns on a `true`, and an official
package must ship no warnings.

The phone draws the `main` panel instead, and that panel says one honest thing.
Driving a simulator is `simctl`, `xcodebuild` and `idb` against a booted device,
all on a Mac. There is no phone-shaped version of it, and a tap control on a
phone would be a button that cannot work. So the panel is the status row —
whether the Mac has a simulator running, and which device — plus the line
*"Driving a simulator needs a Mac. Open iOS Sim Control on the attached Mac."*
The terminal draws the same two nodes.

## The rename

"iOS Sim Control" is ADE's pane. "iOS Simulator" is Apple's product. The two are
deliberately different words now, and the second is kept wherever it names
Apple's: the skill's own instructions about booting a runtime, the `xcrun
simctl` prose, and the `ade ios-sim` CLI verbs an agent uses. The plugin id, the
directory, the skill directory, the collection names, the panel id, the socket
ids and the `ios_simulator` action domain are all unchanged — renaming any of
them would orphan a deeplink, a stored row or a dispatch.

## Gaps

1. **No chat attachment.** The compiled pane called
   `window.ade.agentChat.saveTempAttachment` five times — a screenshot, a
   cropped region, an inspected element and a preview render could all be
   dragged into the composer as context. The webview bridge exposes no
   `composer.attachFile`, so the page has none of it. The four page actions that
   produce the artifacts (`pageScreenshot`, `pageScreenSnapshot`,
   `pageInspectPoint`, `pageRenderPreview`) all exist and answer; only the
   handoff into the chat is missing.
2. **No launch stepper.** `IosSimLaunchStepper.tsx` drew the build's phases
   (resolve → build → install → launch) from `launch-progress` events on
   `onEvent`. The child cannot forward a progress stream through
   `invoke`, so the page shows one "Building and launching…" line and then the
   result. The information is not lost; the granularity is.
3. **No preview capture mode.** Preview Lab's second mode let a reader drag a
   crop out of a rendered preview and send that region as context. It is gap 1
   in a different costume — the crop has nowhere to go — so the mode is absent
   rather than half-drawn.
4. **No agent-help prompt drafting.** The compiled Preview Lab had a four-option
   "ask the agent to fix this preview" menu that composed a prompt and wrote it
   to the clipboard. `clipboard.write` exists; the menu does not, pending the
   composer verbs in gap 1.
5. **No blocker cards for a denied macOS grant.** `IosSimVideoOverlay.tsx`
   turned a refused Screen Recording or Automation permission into a card with
   an "Open Settings" button. Those settings panes are opened by
   `iosSimulator.openSystemSettings` and `revealSimulator`, neither of which is
   on the `ios_simulator` action domain's allow-list — so the page shows the
   host's own blocker sentence from `pageStartStream`'s `message` and no button.
6. **The engine contract is stubbed.** `hostEngine.place` / `hostEngine.release`
   and `ui.openPathInEditor` are declared optional and guarded. Until the host
   half lands, a real ADE draws the "cannot paint the live simulator screen"
   line and Open Xcode does not appear. Everything else on the page works
   against the real child today.
