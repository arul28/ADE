# Electron Control page parity

What the plugin's page carries against ADE's compiled Electron Control pane, and
what it does not. **The gaps at the bottom drive the acceptance walk** — read
them before judging the page, because each one is a thing the owner will look for
and not find.

Compiled source this was measured against, still in the binary:
`apps/desktop/src/renderer/components/chat/ChatAppControlPanel.tsx` (1,540
lines). It is mounted two ways today and both are the same component: the Work
rail's Electron Control pane, and `vocabularyCanvas.tsx:HostEngineCanvas`, which
draws it for the `canvas` / `electron-control` vocabulary node.

## Placements

| Compiled placement | Page surface | Placement | State |
|---|---|---|---|
| Work-rail Electron Control pane | `control` | `pane` | Carried |
| Command palette → Electron Control | `control` | `pane` | Carried |
| `canvas` / `electron-control` vocabulary mount | — | — | Host engine, unchanged |
| Phone | — | — | **No page.** The `main` panel's status row |
| Terminal | — | — | The `main` panel's status row |

Both sockets — `work-rail-pane` `control-pane` and `command-palette-action`
`palette-control` — name `webviewSurfaceId: "control"` and keep their `panelId`.
`panelId` stays required and stays the contract: a host that can draw the page
draws the page, a host that cannot draws the panel, and neither has to ask the
plugin which it should do. The manifest parses with no errors and no warnings —
checked against `shared/plugins/manifest.ts` and `shared/plugins/sockets.ts` as
shipped, and by `apps/desktop/src/shared/plugins/pilotPackages.test.ts`.

## No phone page

Every `webview` surface declares `"mobile": false`, and that is not a
limitation being papered over — it is the honest answer twice.

`parseSurfaces` forbids `true` on a webview outright (the `mobileCeiling` is
`false` for the kind) and pushes a warning when a manifest asks, and a warning is
a gate failure for an official package. But the product reason stands on its own:
Electron Control drives an app over the Chrome DevTools Protocol on the computer
that app is running on. No phone is that computer. A page there would be a
launch button that could not launch and a live view of nothing.

So the phone draws the `main` panel: the bound status row — attached, idle or
unavailable, with the window title when there is one — plus one line saying that
driving an Electron app needs the desktop it is running on. Saying so is better
than a blank canvas the reader waits on.

## The one structural change: where the picture lives

The compiled pane drew the screencast itself. `appControl.onEvent` pushed a
`frame` event per CDP frame, a `requestAnimationFrame` loop wrote the freshest
base64 data URL onto an `<img>` ref, and every input verb was a coordinate mapped
off a click on that image.

The page does neither, for two reasons that are not preference:

1. Thirty base64 PNGs a second across the bridge is a structured clone per frame
   for an image the guest would decode again.
2. The host paints a native view over the guest, and a native view takes the
   pointer events with it. A transparent overlay in the page would not receive
   the click.

So the live view stays a HOST engine — `electron-control`, the one the `canvas`
node already mounts — and the page reserves a rect for it and reports it with
`hostEngine.place({ engineId, rect })`.

The input verbs the image used to carry went with it. Where the host can paint,
a click on the picture is a click and a wheel is a scroll, because the engine is
host code holding the pointer. Where it cannot, the page draws them as explicit
controls beside the empty rect: a viewport coordinate, Click, Scroll with its
amount, Inspect and Attach. The coordinate space the child is sent is the same
one the compiled pane sent — `viewport` — either way, so nothing changed on the
host side, only where the numbers come from.

## Host calls

Sixteen host reaches in the compiled pane: fifteen `window.ade.appControl.*`
verbs and one `window.ade.agentChat.*`. Every one has a counterpart.

| compiled call | page action |
|---|---|
| `appControl.getStatus` | `pageStatus` |
| `appControl.listTargets` | `pageTargets` |
| `appControl.attachToTarget` | `pageAttachTarget` |
| `appControl.launchInTerminal` | `pageLaunch` |
| `appControl.connect` | `pageConnect` |
| `appControl.stop` | `pageStop` |
| `appControl.focusWindow` | `pageFocusWindow` |
| `appControl.minimizeWindow` | `pageMinimizeWindow` |
| `appControl.getSnapshot` | `pageSnapshot` |
| `appControl.click` | `pageClick` |
| `appControl.scroll` | `pageScroll` |
| `appControl.typeText` | `pageTypeText` |
| `appControl.selectPoint` | `pageSelectPoint` |
| `appControl.inspectPoint` | `pageInspectPoint` |
| `appControl.onEvent` (session) | `events.on("changed")` + a `pageStatus` re-read |
| `appControl.onEvent` (`frame`) | the host engine — no bridge crossing at all |
| `agentChat.saveTempAttachment` | `pageAttachContext` |
| the `controlDisabledReason` prop | `pageStatus().disabledReason` |
| `window.sessionStorage` panel state | the `ui-state` collection |

Every mutation answers `{ok, message}` and never throws for a host refusal.
`pageStatus` and `pageTargets` degrade; `pageSnapshot`, `pageInspectPoint` and
`pageSelectPoint` reject, because an empty element list is indistinguishable from
"the app is showing nothing" and a lie the page cannot detect is worse than a
rejection it can retry.

## Carried

- **The launch row.** The command field with its Enter-to-run, the Run button
  and its spinner, and `force: true` on the launch — the compiled call's own
  choice, because a reader pressing Run with a session showing means to replace
  it.
- **The CDP attach row.** The port field, the Connect press, the "Enter a valid
  CDP port" refusal, and the full waiting-for-CDP sentence with its
  `ADE_APP_CONTROL_DEBUG_FLAGS` advice.
- **The status pill.** `statusInfo` verbatim, all eight session states, both tone
  tables, and the subtle one: a `running` session that once connected and now has
  no CDP endpoint reads **Disconnected**, not Running, because the app quit while
  the launch terminal stayed up.
- **Show and Minimize**, gated on a connected session, with their spinners.
- **Stop**, gated on an active session that is not already gone.
- **The window picker.** The select, the optimistic `pendingTargetId` that clears
  when the child confirms it or when the target disappears, the re-scan count
  button, and `targetLabel` — deliberately not numbered positionally, because
  `/json/list` order is not stable across polls. The 2,500 ms re-scan is kept,
  with a `visibilityState` guard the compiled pane did not need.
- **The blockers card.** The disabled reason, a failed status read, and the
  waiting-for-CDP warning, in one place.
- **The message banner**, both tones, its `alert`/`status` roles and its dismiss.
- **The mode toggle**, Control and Inspect, disabled without a session — drawn
  by the engine over the picture where the host can paint, and by the page where
  it cannot. One toggle either way, owned by whoever owns the click.
- **The Snapshot press** and the page title/URL chip.
- **The selection details.** `elementLabel`, `elementSubLabel`, the selector, the
  pixel frame, the `testId`, and the "Attached" acknowledgement with its 4-second
  life.
- **The type-text field**, its Enter binding, its `canType` gate, the
  post-type snapshot refresh and the "Snapshot refresh failed" wording.
- **The launch form's memory**, moved from `sessionStorage` to a collection.

## Gaps

**G1 — G5 are closed.** They were all one gap wearing five hats: the page had no
pixels and no pointer, so the click pulse, the hover outline, the element
overlays, hover-to-inspect, click-on-the-picture, wheel-to-scroll and the
blank-frame detector had nowhere to live. All seven are back, in the host, in
`apps/desktop/src/renderer/components/plugins/hostEngine/AppControlEngineView.tsx`
— see the section below.

**G6 — the "Help wire CDP" draft button is gone.** It called `onInsertDraft`, a
prop the chat passed down, to put a two-line request into the composer. The
bridge has `composer.insert`, so this is closeable — it is left out because the
compiled button only appeared when the pane was mounted inside a chat, and a page
opened from the command palette has no composer to insert into. It should come
back guarded on the placement.

**G7 — the "Terminal" button is gone.** It called `onShowTerminal`, another chat
prop, to reveal the launch PTY. There is no bridge verb for "show me this
terminal session", so this is genuinely blocked until one exists. The session's
terminal id is still reported in the status detail line, which is how a reader
finds it today.

**G8 — the screenshot crop is the engine's now.** The compiled pane cropped the
element out of the screenshot on a canvas, base64'd it through
`agentChat.saveTempAttachment` and called two chat props. The engine does the
crop and the attach, on the side that holds the frame, when a reader clicks an
element in Inspect mode. `pageAttachContext` remains the page's path for a typed
coordinate on a host with no engine. Worth checking that the attached crop still
arrives in the chat.

**G9 — `ui.openPathInEditor` is still optional.** Declared optional on the
bridge and called through a guard; a host without it draws the inspect list's
`file:line` as an inert row.

## What the engine actually is

`hostEngine` is no longer stubbed. The Work rail registers `electron-control`
for a page to place, and what it registers is the important part.

It used to register the whole compiled `ChatAppControlPanel`. A page that
reserved a rect therefore got a complete second panel painted over it — a second
launch row, a second status pill, a second window picker — and a native view
that swallowed every click the page's own chrome was waiting for. Two panels,
one of them unreachable.

The engine is now the picture and nothing else: the live `<img>`, the frame pump
that writes onto it at thirty frames a second without a React render per frame,
and the input that lands on it — click, wheel-to-scroll with its per-frame
coalescing, hover-to-inspect on the compiled 60 ms debounce, the click pulse,
the hover and selection outlines, the coordinate marker, and `imageLooksBlank`.

**Mode moved with the click.** Control and Inspect select which host verb a
click on the picture becomes, so the toggle belongs to whoever owns the click.
The engine draws it over the picture, where the compiled pane drew it. The page
draws its own toggle only when the host cannot paint, because then the page IS
the only place a click can be expressed.

**The typed coordinate row is the no-engine half.** Where the host paints, the
`Point` x/y fields with Click, Scroll, Inspect and Attach are not drawn: offering
a typed coordinate beside a live, clickable app would be a worse copy of what is
already under the reader's pointer. Where it cannot paint, that row is the only
way to drive the app, which is why the page still holds every one of those verbs
and every one still answers. `plugins/ade-app-control/page/test/seam.test.tsx`
walks both halves.

Two helpers are a **copy**, not a move — `ChatAppControlPanel.tsx` is still
mounted in the chat drawer and still owns the originals, so `cropFrameDataUrl`
with its `clampFrame`, and `imageLooksBlank`, now exist twice. The two copies
must move together until the compiled panel is retired, and the engine view says
so above that block.
