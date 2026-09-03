# The iOS Sim Control page

The `ade-ios-sim` plugin's own HTML page — one build, one placement, and a
rectangle it does not draw in.

ADE's compiled simulator pane moved here. Not rewritten: the device picker, the
launch-target picker, Launch / Apply / Stop, the Control and Inspect toolbar, the
zoom rail, the four setup chips, the ownership card and Preview Lab are the same
markup `ChatIosSimulatorPanel.tsx` (3,777 lines) shipped, with three things
changed and nothing else.

1. **Host calls.** Every `window.ade.iosSimulator.*` became an
   `adePlugin.invoke` into one of the plugin's own page actions
   (`../pageActions.js`). The page holds no `ios_simulator` handle and no
   project root; the child process holds both. `src/host/actions.ts` carries the
   full compiled-call → page-action table.
2. **The stream.** It did not move, and could not. See below.
3. **Persistence.** The chosen device, target, mode and zoom moved from React
   state and `localStorage` into the plugin's `ui-state` collection. A guest's
   storage partition is non-persistent — it dies when the placement hides — so a
   preference written there is always gone before anybody reads it back.

## The engine placement contract

The live simulator screen is a `Simulator.app` **window capture**: a
`MediaStream` from Electron's `desktopCapturer`, painted into a `<video>` at
60fps, with a window-parking claim keeping the captured window on screen. A
sandboxed plugin guest has none of that and must not — `getUserMedia` over a
desktop source inside web content would be a capability escape.

So the stream stays in the host and the page tells it where to draw:

```
page                                            host
────                                            ────
reserve <div data-sim-pane="stage">
measure it (ResizeObserver + scroll + resize)
hostEngine.place({ engineId: "simulator",  ──▶  paint the capture into that rect
                   rect })
…placement hides, mode changes, unmount…
hostEngine.release()                       ──▶  stop painting
```

Four rules make that safe, and `src/host/engine.ts` keeps all four:

- **CSS pixels, guest-relative.** `getBoundingClientRect()` already answers in
  the guest viewport's coordinates, which is what the host needs — it owns the
  frame and knows where the frame sits on the display.
- **Coalesced.** A `ResizeObserver` fires per layout tick and a zoom step is
  dozens of ticks. A rect equal to the one already placed is dropped, and a
  burst settles into one call.
- **Always released.** On unmount, on leaving the Simulator surface, and
  whenever the reserved element loses its box. A host that was never told to
  stop keeps painting over chrome that has moved.
- **Never a throw.** A host with no `hostEngine` draws a sentence naming what is
  missing, and the rest of the pane still works.

Zoom is the reserved rect getting **bigger inside a scrolling frame**, not a
picture the page scales — the page holds no picture.

`hostEngine.place`, `hostEngine.release` and `ui.openPathInEditor` are declared
as OPTIONAL members on `AdePluginBridge` (`src/bridge.ts`) and reached only
through guards, because the host half is landing in parallel with this page.

## Build

```sh
cd plugins/ade-ios-sim/page
npm install          # only here: page/node_modules is git-ignored
npm run build        # writes ../dist — the committed output the plugin ships
npm test             # the seam test
npm run typecheck
```

`npm run build` is the only thing that writes `plugins/ade-ios-sim/dist/`. That
directory **is committed**: an installed plugin is a copy of the tree, and the
installer runs no build step. Rebuild it in the same change as any edit under
`src/`, or the plugin ships the previous page.

`node_modules` is excluded from a plugin install (`PLUGIN_COPY_EXCLUDED_DIRS`),
so the dependencies here never reach a user's machine.

## Layout

```
page/
  index.html            the one document; no inline script (script-src 'self')
  public/fonts/         vendored woff2 — font-src 'self' forbids a CDN font
  src/
    main.tsx            paints the theme, then mounts
    PageRouter.tsx      surfaceId → the pane
    bridge.ts           window.adePlugin, typed. Nothing else touches the global
    types.ts            the iOS simulator shapes, copied down from the app's own
    host/
      actions.ts        THE HOST-CALL MAP — one function per plugin action id
      engine.ts         the placement contract: measure, coalesce, release
      ui.ts             toasts, confirms, clipboard, links, open-in-editor
      uiState.ts        device/target/mode/zoom, in the ui-state collection
      theme.ts          the host's palette, onto --ade-* and --color-* together
    entries/SimEntry.tsx   the pane
    components/         the moved compiled chrome
  test/
    fakeBridge.ts       a scripted window.adePlugin that throws on an unknown id
    seam.test.tsx       the walk, asserting calls rather than pixels
```

## What is NOT here

No phone page. Every `webview` surface declares `mobile: false` — the parser
forbids `true` there anyway — and the phone draws the `main` panel instead,
which says driving a simulator needs a Mac. `../PARITY.md` says why.
