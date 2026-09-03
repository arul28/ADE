# The Electron Control page

The `ade-app-control` plugin's own HTML page — one build, one placement.

ADE's compiled Electron Control pane moved here. Not rewritten: the launch row,
the CDP attach row, the status pill, the window picker, the waiting-for-CDP
card, the message banner, the mode toggle, the selection details and the
type-text field are the same markup and the same words the app shipped, with
three things changed and nothing else.

1. **Host calls.** Every `window.ade.appControl.*` and the one
   `window.ade.agentChat.*` became an `adePlugin.invoke` into one of the
   plugin's own page actions (`../pageActions.js`). The page holds no CDP
   session and no runtime pin; the child process holds both. The table is
   documented in `src/host/actions.ts`'s header.
2. **The picture.** The compiled pane drew the screencast itself, off
   `appControl.onEvent`'s `frame` events. The page does not: it reserves a rect
   and the HOST paints `electron-control` into it. See below.
3. **Persistence.** The launch command, the working directory, the CDP port and
   the mode moved from `window.sessionStorage` to the plugin's `ui-state`
   collection. A guest's storage partition is non-persistent — it dies when the
   placement hides — so a preference written there is always gone before anybody
   reads it back.

## Build

```sh
cd plugins/ade-app-control/page
npm install          # only here: page/node_modules is git-ignored
npm run build        # writes ../dist — the committed output the plugin ships
npm test             # the seam test
npm run typecheck
```

`npm run build` is the only thing that writes `plugins/ade-app-control/dist/`.
That directory **is committed**: an installed plugin is a copy of the tree, and
the installer runs no build step. Rebuild it in the same change as any edit
under `src/`, or the plugin ships the previous page.

`node_modules` is excluded from a plugin install (`PLUGIN_COPY_EXCLUDED_DIRS`),
so the dependencies here never reach a user's machine.

## The engine placement contract

The live view is not this page's. It is a host builtin — `electron-control`, the
same engine the `canvas` vocabulary component already mounts — and it stays in
the host for one measurable reason: a CDP screencast is thirty base64 PNGs a
second, and relaying those through the bridge is a structured clone per frame
for an image the guest would then decode again.

So the page reserves a box and tells the host where it is:

```ts
hostEngine.place({ engineId: "electron-control", rect: { x, y, width, height } })
hostEngine.release()
```

Four rules, all held in `src/host/engine.ts`:

- **The rect is in CSS pixels, relative to the GUEST's own viewport.** The page
  cannot know where the host put the frame, and a page that guessed would move
  the picture every time the reader dragged a pane divider. The host adds its
  own frame origin — the arithmetic it already does to position a `<webview>`.
- **Repeats are coalesced.** A `ResizeObserver` fires several times per layout
  tick and once per frame during a drag, and every one of those is an IPC round
  trip. A rect identical to the last one reported is dropped outright, and the
  rest are batched onto an animation frame. Rounding to whole pixels is what
  makes that test mean anything: sub-pixel jitter from a flex layout would
  otherwise report a new rect on every tick while the picture never moved.
- **A host with no engine degrades.** `hostEngine` is optional on the bridge and
  reached only through a guard. A host that lacks it draws a sentence in the
  reserved element and never throws — launch, connect, click, scroll, type and
  inspect all still work, which is most of the product.
- **Release is unconditional.** On unmount, and on `visibilitychange` to hidden.
  The host keeps painting until it is told to stop, so a placement that forgot
  would leave a live app view over whatever the reader opened next.

`ui.openPathInEditor` is declared and guarded the same way, for the inspect
list's `file:line`. Both it and `hostEngine` are platform contracts landing in
parallel with this page; the fake bridge scripts them so the argument shapes are
checked before a host answers one.

## Layout

```
page/
  index.html            the one document; no inline script (script-src 'self')
  src/
    main.tsx            paints the theme, then mounts
    PageRouter.tsx      surfaceId → the control entry
    bridge.ts           window.adePlugin, typed. Nothing else touches the global
    types.ts            the Electron Control shapes, copied down from the app's
    host/
      actions.ts        THE HOST-CALL MAP — one function per plugin action id
      engine.ts         the reserved rect, and the host engine placed into it
      ui.ts             toasts, confirms, clipboard, links, the changed feed
      uiState.ts        the launch form, in the ui-state collection
      theme.ts          the host's palette, onto --ade-* and --color-* together
    entries/            one per surface
    components/         the moved compiled chrome
    styles/
      palette.css       ADE's own index.css, verbatim
      page.css          Tailwind, the vendored fonts, the guest layout
  public/fonts/         Geist, Geist Mono, JetBrains Mono (font-src 'self')
  test/
    fakeBridge.ts       a scripted window.adePlugin
    seam.test.tsx       the walk both halves have to keep passing
```

## Why Tailwind runs here

The moved chrome carries the app's own utility class names. `palette.css` is
ADE's `index.css` verbatim — the `@theme` block, the dark palette, the light
palette — so Tailwind at build time emits one same-origin stylesheet in which
every one of those classes resolves to the exact colour the app draws with. The
page's content policy allows `style-src 'self'`, so a stylesheet is fine; it
forbids the play-CDN script, so a runtime Tailwind is not. The three fonts are
vendored for the same reason: `font-src 'self'` has no CDN in it.

## The seam test

The plugin is two programs now, joined by a list of action ids that no compiler
checks: the page is built separately from the plugin it ships inside, and no
type crosses the bridge. `test/seam.test.tsx` walks the product against a
scripted `window.adePlugin` and asserts the CALLS — an id the page invokes that
the fake does not script throws by name. It is owned by neither half. A change
to the page and a change to `pageActions.js` both have to keep it passing, and
`../test/pageActions.test.js` walks the same contract from the child's side.

See `../PARITY.md` for what the page carries and what it does not.
