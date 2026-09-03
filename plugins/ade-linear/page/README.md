# The Linear page

The `ade-linear` plugin's own HTML page — one build, six placements.

ADE's compiled Linear moved here. Not rewritten: the issue browser, the quick
view, the settings section, the pickers and the badge card are the same
components the app shipped, with three things changed and nothing else.

1. **Host calls.** Every `window.ade.cto.*`, `window.ade.lanes.*` and
   `window.ade.agentChat.*` became an `adePlugin.invoke` into one of the
   plugin's own page actions (`../pageActions.js`). The page holds no Linear
   client and no credentials; the child process holds both.
2. **Persistence.** Filters and selection moved from `localStorage` to the
   plugin's `ui-state` collection. A guest's storage partition is
   non-persistent — it dies when the placement hides — so a preference written
   there is always gone before anybody reads it back.
3. **Imports.** The app's design primitives come from `@ade-dev/ui`, which is
   the same modules the desktop consumes through `file:../../packages/ui`.

## Build

```sh
cd plugins/ade-linear/page
npm install          # only here: page/node_modules is git-ignored
npm run build        # writes ../dist — the committed output the plugin ships
npm test             # the seam test
npm run typecheck
```

`npm run build` is the only thing that writes `plugins/ade-linear/dist/`. That
directory **is committed**: an installed plugin is a copy of the tree, and the
installer runs no build step. Rebuild it in the same change as any edit under
`src/`, or the plugin ships the previous page.

`node_modules` is excluded from a plugin install (`PLUGIN_COPY_EXCLUDED_DIRS`),
so the dependencies here never reach a user's machine.

## Layout

```
page/
  index.html            the one document; no inline script (script-src 'self')
  src/
    main.tsx            paints the theme, then mounts
    PageRouter.tsx      surfaceId → one of the six entries
    bridge.ts           window.adePlugin, typed. Nothing else touches the global
    types.ts            the Linear shapes, copied down from the app's own
    host/
      actions.ts        THE HOST-CALL MAP — one function per plugin action id
      ui.ts             toasts, prompts, confirms, clipboard, composer, links
      uiState.ts        filters and selection, in the ui-state collection
      theme.ts          the host's palette, onto --ade-* and --color-* together
      useHostEntities.ts  lanes, followed live over host.subscribe
    entries/            one per placement
    components/         the moved compiled components
    lib/                the moved compiled helpers
    styles/
      palette.css       ADE's own index.css, lines 1..509, verbatim
      page.css          Tailwind, the vendored fonts, the guest layout
  public/fonts/         Geist, Geist Mono, JetBrains Mono (font-src 'self')
  test/
    fakeBridge.ts       a scripted window.adePlugin
    seam.test.tsx       the walk both halves have to keep passing
```

## Why Tailwind runs here

The moved components carry the app's own utility class names, and there are
thousands of them. `palette.css` is ADE's `index.css` verbatim — the `@theme`
block, the dark palette, the light palette — so Tailwind at build time emits one
same-origin stylesheet in which every one of those classes resolves to the exact
colour the app draws with. The page's content policy allows `style-src 'self'`,
so a stylesheet is fine; it forbids the play-CDN script, so a runtime Tailwind
is not.

The kit's own components read `--ade-*` instead, and `host/theme.ts` writes the
host's published palette to both names at once. A host that publishes nothing
leaves ADE's built-in palette standing, which is why the page looks right before
the theme handshake ever answers.

## The seam test

The plugin is two programs now, joined by a list of action ids that no compiler
checks: the page is built separately from the plugin it ships inside, and no
type crosses the bridge. `test/seam.test.tsx` walks the product against a
scripted `window.adePlugin` and asserts the CALLS — an id the page invokes that
the fake does not script throws by name. It is owned by neither half. A change
to the page and a change to `pageActions.js` both have to keep it passing.

See `PARITY.md` for what the page carries and what it does not.
