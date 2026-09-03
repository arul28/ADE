# The Review page

The `ade-review` plugin's own HTML page — one build, two placements.

ADE's compiled Review moved here. Not rewritten: the runs browser, the finding
card, the learnings panel and the launch form are the same components the app
shipped, with four things changed and nothing else.

1. **Host calls.** Every `window.ade.review.*` became an `adePlugin.invoke` into
   one of the plugin's own page actions (`../pageActions.js`). The page holds no
   review engine and no credentials; the child process reaches the `review.*`
   action domain and the page reaches only the child.
2. **Navigation.** The compiled page kept the selected run in the renderer route
   (`useSearchParams`, `?runId=…`). A guest has no route, so the page owns its
   own navigation: the run comes from `context` when the host opened the page at
   one, and is otherwise remembered in the plugin's `ui-state` collection. The
   two "go somewhere else in ADE" verbs — open in files, open a transcript in
   Work — are deeplinks, which is the only way a guest moves the app.
3. **Persistence.** The sidebar width moved from `localStorage` to that same
   collection. A guest's storage partition is non-persistent — it dies when the
   placement hides — so a preference written there is always gone before anybody
   reads it back.
4. **Imports.** The app's design primitives come from `@ade-dev/ui`, which is
   the same modules the desktop consumes through `file:../../packages/ui`. The
   dialog shell with its border beam is `@ade-dev/ui/dialog` and the branch glyph
   is `@ade-dev/ui/icons`, because neither is Review's — a page that had copied
   them would be a second implementation of markup the app also draws.

## Build

```sh
cd plugins/ade-review/page
npm install          # only here: page/node_modules is git-ignored
npm run build        # writes ../dist — the committed output the plugin ships
npm test             # the seam test
npm run typecheck
```

`npm run build` is the only thing that writes `plugins/ade-review/dist/`. That
directory **is committed**: an installed plugin is a copy of the tree, and the
installer runs no build step. Rebuild it in the same change as any edit under
`src/`, or the plugin ships the previous page — and
`test/panels.test.js` fails if `dist/index.html` is missing entirely.

`node_modules` is excluded from a plugin install (`PLUGIN_COPY_EXCLUDED_DIRS`),
so the dependencies here never reach a user's machine.

## The host-call rules

`src/host/actions.ts` is the whole contract, and its header carries the
compiled-call → page-call → child-verb table. Two rules govern it:

- **A mutation never rejects.** `pageStartRun`, `pageRerun`, `pageCancelRun`,
  `pageRecordFeedback` and `pageDeleteSuppression` all answer `{ok, message}`.
  A page's `invoke` has no banner chrome around it, so a rejected promise would
  arrive as an exception beside a form the reader has already filled in.
- **A read degrades only where the failure has somewhere honest to live.**
  `pageLaunchContext` degrades to an empty context carrying `message`, which the
  form prints above the lane field; `pageQualityReport` degrades to `null`, which
  the learnings panel already draws as an em-dash. `pageRuns`, `pageRunDetail`
  and `pageSuppressions` **reject**, because an empty answer from each is
  indistinguishable from a sentence the product actually prints — "No review runs
  yet in this workspace", "The review passes found nothing actionable in this
  diff", "No suppressions yet".

Five bridge members are new in this wave and every one is called through a guard
in `src/host/ui.ts`, so a host that predates them draws the same page:
`ui.openPathInEditor`, `ui.pickModel`, `ui.pickLane`, `ui.pickReasoningEffort`,
and the `review` kind on `host.subscribe`. A host that refuses the last one
leaves the page on the child's poll (`src/host/liveRuns.ts`), and the seam test
walks both paths.

## Layout

```
page/
  index.html            the one document; no inline script (script-src 'self')
  src/
    main.tsx            paints the theme, then mounts
    PageRouter.tsx      surfaceId → runs or launch
    bridge.ts           window.adePlugin, typed. Nothing else touches the global
    types.ts            the Review shapes, copied down from the app's own
    host/
      actions.ts        THE HOST-CALL MAP — one function per plugin action id
      ui.ts             toasts, confirms, clipboard, links, and the new pickers
      uiState.ts        the selected run and the sidebar width, in ui-state
      theme.ts          the host's palette, onto --ade-* and --color-* together
      liveRuns.ts       host.subscribe kind "review", or the child's poll
    entries/            one per placement
    components/         the moved compiled components
    lib/                the moved compiled helpers
    styles/
      palette.css       ADE's own index.css, verbatim
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
is not. The three fonts are vendored under `public/fonts` for the same reason:
`font-src 'self'` refuses a CDN face.

`page.css` names each kit ENTRY POINT as a Tailwind source, one line apiece. The
kit is split so a page pays only for what it draws, so the barrel re-exports
neither the dialog shell nor the icon set — and Tailwind generates only the
classes it has seen. A scan of the barrel alone would leave both drawing as
unstyled boxes beside components that draw correctly.

The kit's own components read `--ade-*` instead, and `host/theme.ts` writes the
host's published palette to both names at once. A host that publishes nothing
leaves ADE's built-in palette standing, which is why the page looks right before
the theme handshake ever answers.

## The seam test

The plugin is two programs now, joined by a list of action ids that no compiler
checks: the page is built separately from the plugin it ships inside, and no
type crosses the bridge. `test/seam.test.tsx` walks the product against a
scripted `window.adePlugin` and asserts the CALLS — an id the page invokes that
the fake does not script throws by name. It is owned by neither half. A change to
the page and a change to `pageActions.js` both have to keep it passing, and
`../test/pageActions.test.js` is the child's half of the same seam.

See `../PARITY.md` for what the page carries and what it does not.
