# The Cursor Cloud page

The `ade-cursor-cloud` plugin's own HTML page — one build, three placements.

ADE's compiled Cursor Cloud moved here. Not rewritten: the fleet modal, the
fleet row, the composer's Advanced menu and the secrets picker are the same
components the app shipped, with four things changed and nothing else.

1. **Host calls.** Every `window.ade.ai.cursorCloud*`, `window.ade.git.*` and
   `window.ade.projectSecrets.*` became an `adePlugin.invoke` into one of the
   plugin's own page actions (`../pageActions.js`). The page holds no Cursor
   client, no API key and no secret VALUE; the child process holds all three.
2. **No arithmetic.** The compiled modal grouped its rows, sorted them by
   recency, summed cost cents and formatted an age against `Date.now()`. The
   child still does the assembly, the grouping (for the TUI panel), cost, and
   age. The HTML page draws a flat recency list from `entries`. `age`, `cost`
   and `footer` arrive finished, so a phone and a Mac reading the same fleet
   print the same words — and a page in another time zone cannot claim a run
   finished in the future.
3. **Persistence.** The status filter, the lane filter, the archived reveal and
   the selected row live in the plugin's `ui-state` collection. A guest's
   storage partition is non-persistent — it dies when the placement hides — so
   `localStorage` in a page is a value that is always empty by the time anybody
   reads it back.
4. **Imports.** The design primitives come from `@ade-dev/ui`, which is the same
   modules the desktop consumes through `file:../../packages/ui`. `cn` and the
   theme application come from there rather than from a copy here.

## Build

```sh
cd plugins/ade-cursor-cloud/page
npm install          # only here: page/node_modules is git-ignored
npm run build        # writes ../dist — the committed output the plugin ships
npm test             # the seam test
npm run typecheck
```

`npm run build` is the only thing that writes `plugins/ade-cursor-cloud/dist/`.
That directory **is committed**: an installed plugin is a copy of the tree, and
the installer runs no build step. Rebuild it in the same change as any edit
under `src/`, or the plugin ships the previous page.

`node_modules` is excluded from a plugin install
(`PLUGIN_COPY_EXCLUDED_DIRS`), so the dependencies here never reach a user's
machine.

## Layout

```
page/
  index.html            the one document; no inline script (script-src 'self')
  src/
    main.tsx            paints the theme, then mounts
    PageRouter.tsx      surfaceId → one of the three entries
    bridge.ts           window.adePlugin, typed. Nothing else touches the global
    types.ts            the Cursor Cloud shapes, copied down from the app's own
    host/
      actions.ts        THE HOST-CALL MAP — one function per plugin action id
      ui.ts             toasts, links, settings jumps, surface close, resize
      uiState.ts        filters and the selected row, in the ui-state collection
      pickers.ts        ADE's five pickers, each with its inline fallback
      refresh.ts        the phone's pull-down, subscribed defensively
      theme.ts          the host's palette, onto --ade-* and --color-* together
      useHostEntities.ts  the relay wake and the host's entity frames. No timer
    entries/            one per placement
    components/         the moved compiled components
    lib/                the moved compiled helpers, and the subject readers
    styles/
      palette.css       ADE's own index.css, verbatim
      page.css          Tailwind, the vendored fonts, the guest layout
  public/fonts/         Geist, Geist Mono, JetBrains Mono (font-src 'self')
  test/
    fakeBridge.ts       a scripted window.adePlugin
```

## The three surfaces

| surfaceId | placement                              | what it draws |
|-----------|----------------------------------------|---------------|
| `fleet`   | rail tab, Work-rail pane, the phone    | `CursorCloudFleetModal` as a full-height page, with the detail as a right pane |
| `agent`   | deeplink, chat-header press            | the same detail component, alone |
| `launch`  | the machine row's Advanced, as a popover | `CursorCloudAdvancedMenu` + the secrets picker + the fields the composer fed |

The fleet and the agent surface share `AgentDetail`. It is written once and
takes an `agentId` prop rather than reading the page context, which is exactly
what lets the fleet embed it and the deeplink mount it.

## One bundle, three widths

The same build serves a 1,400px tab, a 380px Work-rail pane and a phone. Nothing
branches on a user agent, and nothing measures the window in JavaScript: two
container widths do all of it, through Tailwind's arbitrary media variants.

- **560px** — below it the row's `Open` and `Stop` buttons are hidden and the
  same two actions appear at the top of the row menu, and the filter selects
  stack and go full width. Two 140px selects and three 28px targets on one line
  is a horizontal scroll on a phone.
- **860px** — at and above it the agent detail is a right pane beside the list,
  and the selected row also draws the compiled inline expansion. Below it the
  same element is fixed over the whole viewport and the inline expansion is
  suppressed, because a 380px pane next to a 320px list is two unreadable
  columns rather than one readable one.

## Freshness: no timer, ever

The compiled modal was explicit: *"There is deliberately no timer here —
freshness comes from the relay or from the user's hand."* That rule is kept with
the four channels a guest has:

- `events.on("changed")` scoped to the `fleet` collection — the relay wake,
  arriving through the bridge instead of a renderer event bus
- `host.subscribe({kinds: ["lane","session"]})` — an ADE lane or chat moved, so
  an ownership chip or a lane section changed
- `events.on("refresh")` — the reader pulled the page down on a phone
- `visibilitychange` — catch up on whatever arrived while the placement was
  hidden

The first two are skipped while the placement is hidden and the last one is why
that costs no freshness. The reader's own pull-down is never skipped.

## Pickers, and why the fallback is not dead code

The launch form opens ADE's own lane, model and reasoning-effort pickers when
the host answers those verbs. It has to: ADE's model picker knows the fast tier
and the reasoning ladder of every model in the catalog, and a second list this
plugin kept in step by hand would disagree with it the first time either moved.

Every picker is optional on the bridge. A v1 host answers none of them, and the
form then draws a real `<select>` built from `CloudLaunchContext` — which is why
that context carries `lanes`, `models` and `reasoningOptions` at all. A host
that claims a verb and then cannot open it flips that one control to the select
for the rest of the form's life, rather than leaving the reader pressing a chip
that does nothing.

The request and answer shapes are ADE's (`ui.pickModel({ value,
availableModelIds })` → `{ modelId, fastMode }`; `ui.pickLane({ value })` →
`{ laneId, name }`; `ui.pickReasoningEffort({ model, value })` → `{ modelId,
effort }`). A page that flattened those to `{ id, label }` would drop the fast
tier off a model choice and treat a successful pick as a dismissal.

## Secrets

Names only. A secret VALUE never reaches this page, never appears in a request
it makes and is never logged. The form sends `secretNames`, the child resolves
them against the encrypted project store, and Cursor gets the values without the
guest ever holding one. `CURSOR_*` names are filtered out on both sides — the
run already authenticated with that key, and injecting a second copy of it is
how a reader's personal token reaches an environment they did not choose.

## The seam test

The plugin is two programs now, joined by a list of action ids that no compiler
checks: the page is built separately from the plugin it ships inside, and no
type crosses the bridge. `test/fakeBridge.ts` is that list written out, and the
seam test walks the product against it — an id the page invokes that the fake
does not script throws by name. It is owned by neither half. A change to the
page and a change to `pageActions.js` both have to keep it passing.

The fourteen ids the child answers:

```
pageFleet   pageAgent        pageLaunchContext  pageLaunch
pageOpenInAde  pageStopRun   pageFollowUp       pagePullIntoLane
pageArchiveAgent  pageUnarchiveAgent  pageDeleteAgent  pageAckBadge
pageConnection  pageCopyWebhookUrl
```

The page invokes the first twelve. `pageConnection` and `pageCopyWebhookUrl` are
handlers a host can ask; the fleet's key state rides on `pageFleet` instead of
a second round trip, and the webhook URL is the Automations tile's.
