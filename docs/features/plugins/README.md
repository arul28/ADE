# Plugins

The plugin platform lets anything outside ADE's six core surfaces — Work, Lanes,
Files, PRs, Automations, CTO — be added by a third party, and lets several
things currently inside ADE be extracted into plugins later.

A plugin is a git-repo folder with a `plugin.json` at its root. It installs to
`~/.ade/plugins/<id>/` on one machine at a time. Two rules shape everything
else:

- **Code runs only on the machine that owns the plugin**, in a supervised Node
  child process. There is no remote execution path.
- **UI is declarative data, never code.** A plugin ships a versioned JSON *panel
  schema*; desktop, web, iOS, and the `ade code` TUI each interpret that same
  JSON with their own native widgets. One plugin therefore works across four
  independent release trains (desktop auto-update, App Store review, npm, web)
  without shipping anything executable to three of them.

There is one deliberate exception to the second rule: a **`webview` surface**
renders the plugin's own HTML page in a sandboxed guest, on the desktop only. It
still declares a panel, and that panel is what every other client shows in its
place — so the escape hatch costs a platform, never a blank space. See
[The webview tier](#the-webview-tier).

## Source file map

Shared contracts — imported by the daemon, the renderer, `apps/ade-cli`, and
transcribed into Swift. Pure types plus pure parsers; no React, Electron, or
Node built-ins:

| File | Responsibility |
|---|---|
| `apps/desktop/src/shared/plugins/manifest.ts` | `plugin.json` contract, strict-on-known/tolerant-of-unknown parser, id and relative-path validation, `minAdeVersion` gate, the `tab`/`pane`/`webview` surface kinds and the `entryHtml` rule |
| `apps/desktop/src/shared/plugins/vocabulary.ts` | Panel schema v1: component union, `VOCAB_LIMITS`, degradation ladder, `parsePluginPanel`, the reserved `$context` binding (`VOCAB_CONTEXT_COLLECTION`, `vocabContextRows`) |
| `apps/desktop/src/shared/plugins/webviewBridge.ts` | The `window.adePlugin` contract: bridge version, the `ade-plugin://` origin and per-plugin partition, `PLUGIN_WEBVIEW_CSP`, the closed method list |
| `apps/desktop/src/shared/plugins/sockets.ts` | Socket kinds, surface ids, entity kinds, per-kind payload validation, deterministic placement ordering, row-badge overflow split |
| `apps/desktop/src/shared/plugins/context.ts` | Read-only surface contexts (`pr`, `lane`, `session`, `file`, `surface`) and their contribution keys |
| `apps/desktop/src/shared/plugins/sdk.ts` | SDK v0 surface, budgets, error codes, NDJSON child frames, install-registry records, the `plugin` action domain, action-response navigation (`readPluginActionNavigation`, `PLUGIN_NAVIGATE_CONTEXT_MAX_BYTES`) |
| `apps/desktop/src/shared/deeplinks.ts` | The `plugin` deeplink target (`ade://plugin/<plugin-id>/<panel-id>[?ctx=…]`) and its lenient `ctx` reader |
| `apps/desktop/src/shared/plugins/registryIndex.ts` | Marketplace index contract and checksum verification |
| `apps/desktop/src/shared/adeCliGuidance.ts` | Registers the bundled `ade-plugins` authoring skill |

Host (daemon / main process):

| File | Responsibility |
|---|---|
| `apps/desktop/src/main/services/plugins/pluginHostService.ts` | Machine-scoped shared singleton: load, enable/disable, config, panel and collection reads, the `plugin` domain implementation |
| `apps/desktop/src/main/services/plugins/pluginChildSupervisor.ts` | Child spawn, env denylist, NDJSON framing, ready/invoke timeouts, stderr ring, exponential restart backoff, crash containment, two-stage kill |
| `apps/desktop/src/main/services/plugins/pluginSdkServer.ts` | Serves the child's `sdk` frames — the host half of every SDK method |
| `apps/desktop/src/main/services/plugins/childRuntime/pluginChildBootstrap.ts` | The child process: loads the entry module, installs the `ade` global, dispatches `invoke` |
| `apps/desktop/src/main/services/plugins/pluginInstallService.ts` | Install from local path or git URL, `state.json` registry, plugin skill roots |
| `apps/desktop/src/main/services/plugins/pluginDataStore.ts` | Collections/contributions/panels reads and writes; delegates budget enforcement |
| `apps/desktop/src/main/services/plugins/pluginSecretStore.ts` | `plugin:<id>:<NAME>` namespace in the machine credential store |
| `apps/desktop/src/main/services/plugins/pluginEvents.ts` | Debounced `lane/pr/session/install.changed` fan-out to children |
| `apps/desktop/src/main/services/plugins/pluginWebviewProtocol.ts` | Serves `ade-plugin://<pluginId>/…` from the install directory: containment, directory rule, closed MIME map, CSP + `nosniff` on every response including refusals |
| `apps/desktop/src/main/services/plugins/pluginWebviewBridgeServer.ts` | The host half of `window.adePlugin`: sender-pinned plugin id, the declared-collection rule, the write path that bypasses the action domain |
| `apps/desktop/src/main/services/plugins/pluginWebviewGuests.ts` | Which attached guests are plugin pages, and whose |
| `apps/desktop/src/preload/pluginWebviewPreload.ts` | The guest-side preload that publishes `window.adePlugin` and nothing else |
| `apps/desktop/src/main/services/state/dbMaintenanceApi.ts` | Budget constants and the prune/reject pass |
| `apps/desktop/src/main/services/storage/storageLedger.ts` | `.ade/plugins/` and `plugin_collections` storage accounting |

Sync and CLI:

| File | Responsibility |
|---|---|
| `apps/ade-cli/src/services/plugins/pluginTableWriters.ts` | The single budget-enforcing writer for every `plugin_*` table |
| `apps/ade-cli/src/services/plugins/pluginPresenceService.ts` | Per-machine presence fan-out and cache |
| `apps/ade-cli/src/services/plugins/pluginRegistryService.ts` | Registry index fetch with etag cache; `DEFAULT_PLUGIN_REGISTRY_INDEX_URL` |
| `apps/ade-cli/src/services/plugins/pluginInstallPing.ts` | Install count ping to the push relay |
| `apps/ade-cli/src/services/plugins/pluginSyncMeter.ts` | Per-plugin wire byte counters |
| `apps/ade-cli/src/services/plugins/pluginPanelBuilder.ts` | Materializes `plugin_panels` rows from manifest schema files |
| `apps/ade-cli/src/commands/plugin.ts` | `ade plugin list/create/install/remove/enable/disable/reload/logs/dev`, `ade <pluginId> <cmd>` routing |

Renderer (desktop and web share this code):

| File | Responsibility |
|---|---|
| `apps/desktop/src/renderer/components/plugins/VocabularyRenderer.tsx` | Panel schema → React, including the fallback card and node markers |
| `apps/desktop/src/renderer/components/plugins/vocabularyComponents.tsx` | The v1 component implementations |
| `apps/desktop/src/renderer/components/plugins/PluginPanelHost.tsx`, `PluginTabPage.tsx` | Panel data loading and plugin tabs |
| `apps/desktop/src/renderer/components/plugins/sockets/` | Socket rendering on the core surfaces (badges, toolbar actions, menu entries, detail sections, chips, empty states) |
| `apps/desktop/src/renderer/components/plugins/MarketplacePage.tsx`, `MarketplaceDetailPage.tsx` | Gallery, facets, detail page, machine coverage matrix |
| `apps/desktop/src/renderer/components/plugins/PluginInstallDialog.tsx`, `PluginConfigForm.tsx`, `PluginThemePreview.tsx` | Install, settings, theme preview/apply |
| `apps/desktop/src/renderer/components/plugins/marketplaceLocalIndex.ts` | Bundled offline index so the Marketplace works before a live registry exists |
| `apps/desktop/src/renderer/lib/pluginRuntimeBridge.ts` | `window.ade.plugins` bridge |
| `apps/desktop/src/renderer/components/app/pluginDeeplinkRoute.ts` | Where an `ade://plugin/…` link goes: the same hide-everything gate the compiled surfaces use, or a plain refusal |
| `apps/desktop/src/renderer/components/chat/PluginInstallChatCard.tsx` | The `plugin_install` `ade_card` variant for agent-built install flows |

iOS and TUI:

| File | Responsibility |
|---|---|
| `apps/ios/ADE/Models/PluginVocabularyParsing.swift`, `PluginRecords.swift` | Swift transcription of the panel and socket contracts |
| `apps/ios/ADE/Views/Plugins/PluginPaneStore.swift` | `PluginRenderSupport.renderableComponents` — the iOS renderable set |
| `apps/ios/ADE/Views/Plugins/PluginVocabularyView.swift`, `PluginVocabFormView.swift`, `PluginVocabularyMediaViews.swift`, `PluginSocketViews.swift`, `PluginPaneSheet.swift`, `PluginEntryMenu.swift` | Native rendering and entry points |
| `apps/ade-cli/src/tuiClient/pluginPane.ts` | Panel schema → rows, Ink-free |
| `apps/ade-cli/src/tuiClient/components/PluginPanelPane.tsx` | Right-pane rendering of those rows |
| `apps/ade-cli/src/tuiClient/commands.ts` | The `/plugin-view` slash command |

Registry (extraction-ready, nothing here runs in this repository):

| File | Responsibility |
|---|---|
| `registry/` | `index.json`, curated `featured.json`/`official.json`, JSON Schema, crawler, scheduled workflow — see [registry/README.md](../../../registry/README.md) |

Fixture:

| File | Responsibility |
|---|---|
| `apps/desktop/test/fixtures/hello-plugin/` | The end-to-end fixture plugin: manifest, entry module, panel, contributed skill |

## Architecture

### One action domain

Everything a client asks of a plugin goes through a single `plugin` action
domain carrying `{pluginId, action, args}`. Per-plugin domains are impossible by
construction: the action envelope's domain enum is closed at the RPC schema and
again at iOS's compile-time allowlist. Permission denials always surface as
`policyDenied`, never as a missing method — a denial that reads as
`methodNotFound` makes clients silently take an old-host fallback path.

The remote-machine command surface is `plugins.install|uninstall|enable|disable|list`,
registered in the sync remote-command service and requiring approval for a
non-owner. None of it is on the mobile-required list.

`plugin.invoke` is classified MUTATING (a plugin handler may write anything);
`list`, `get`, `getPanel`, `getCollection`, `getReadme`, `inspectSource`,
`marketplaceIndex`, `presence`, and `usageSummary` are read-only.

### The host and its children

The plugin host is a machine-scoped shared singleton threaded into each
per-project runtime and disposed with the app. Each plugin with an `entry` gets
one supervised child process:

- Spawned with `spawn` rather than `fork` — the whole protocol is NDJSON on
  stdio, so stdin has exactly one purpose and the child never reads user input.
- Environment is denylist-sanitized; the child inherits no ADE runtime handles.
- `ready` must arrive within **20s**; one `invoke` round-trip is capped at
  **60s**; a shutdown gets **3s** of grace before the process tree is killed.
- On exit the child restarts with backoff `min(30s, 1s × 2^(n-1))`. A child that
  stayed up **60s** is considered healthy and its restart counter resets, so a
  plugin that crashes once a day never inherits yesterday's 30-second delay.
- Crashes are **contained**: after **5 consecutive fast failures** (each child
  dying before the 60s healthy threshold) the host stops reviving the plugin.
  The status stays `crashed` instead of moving on to `restarting`, and that
  difference is the contract the surfaces read — `restarting` means the host is
  still trying, `crashed` means it has given up and the user has to act. A
  contained plugin refuses `invoke` with `plugin_crashed` rather than silently
  resuming the loop; `plugin.reload` (the Restart button, `ade plugin reload`)
  or an enable/disable cycle replaces the supervisor and revives it with a
  clean counter. The last stderr tail lands in the log ring (500 lines) that
  `ade plugin logs` reads.
- Errors cross the boundary as structural objects with a `code`, never as
  stringified stacks.

### Storage: four tables, frozen shapes

All plugin state lives in four synced tables with composite primary keys and no
secondary unique indexes (a CRR requirement). The SQL shapes are **frozen**: a
plugin never gets its own table and never gets a column on an ADE entity row.

| Table | Key | Holds |
|---|---|---|
| `plugin_presence` | `(machine_key, plugin_id)` | Which machines have which plugin. Fan-out-plus-cache: the directory is identity, the CRR row is a local cache |
| `plugin_panels` | `(plugin_id, panel_id)` | Materialized panel schemas as opaque versioned JSON |
| `plugin_collections` | `(plugin_id, collection, key)` | The only plugin data table |
| `plugin_contributions` | `(entity_kind, entity_id, plugin_id, socket)` | Dynamic per-entity socket outputs, joined at read time |

Contributions are a **side table joined at read**, never columns on entity rows:
last-writer-wins on a shared row would let one plugin's write clobber another's.

**The wedge guard.** An unknown table arriving inbound throws and poisons a
peer's sync cursor permanently, so outbound sync of every `plugin_*` table is
capability-gated: the host includes plugin rows in a changeset only for peers
whose hello advertises `pluginTables:1`. Old desktops therefore never receive a
plugin row at all. iOS ships the matching `DatabaseBootstrap.sql` DDL in the
same release.

### Budgets

Enforced by the writer, inside its transaction, with a single error code
`plugin_budget_exceeded` carrying `{budget, limit, actual}`. Constants live in
`sdk.ts` (so the SDK path never depends on the maintenance module's load order)
and are asserted equal to `dbMaintenanceApi.ts` by test.

| Budget | Limit |
|---|---|
| Collection bytes per plugin per machine | 2 MiB |
| Collection rows per plugin | 4,000 |
| One collection value | 64 KiB |
| Contribution rows per plugin | 2,000 |
| One contribution payload | 4 KiB |
| Panels per plugin | 32 |
| One panel schema | 64 KiB |

### The vocabulary contract

`VOCAB_VERSION` is 1. The component-name union is deliberately **open**
(`| (string & {})`, the `AdeCardVariant` idiom) so adding a component later is
not a breaking change for a client compiled today; an unrecognized name renders
a small "not supported here" marker. Every panel must declare a `fallback` with
a `title` and `text` — that is the floor that makes one wire contract safe
across four release trains.

Damage degrades in a ladder: panel-fatal problems (bad JSON, unsupported `v`,
missing `fallback`, over a ceiling) render the fallback card; a malformed known
component becomes one inline marker and the rest of the panel renders. Nothing
blanks and nothing crashes.

Bindings name a collection the plugin already wrote render-ready rows into;
actions name a plugin action id. There are no expressions, no conditionals, and
no host callbacks — anything a plugin wants computed, it computes on its own
machine and stores as data.

### Context and navigation

A panel can arrive carrying a small object — its *render context*. It reaches
the panel two ways, and they are the same value by different routes: the `?ctx=`
of a `plugin` deeplink, or the `{navigate: {panelId, context}}` an action
returned. `readPluginActionNavigation` reads the second shape out of whatever an
action returned, tolerantly: an unrecognizable value is `null`, never an error,
because most actions carry no navigation at all. `panelId` must be a panel of
the same plugin, so the worst a wrong value can do is show the wrong page of the
plugin the user just pressed a button in.

The context is bindable. `$context` is a reserved collection name — the leading
`$` is illegal in a real collection name, so nothing can shadow it — and binding
to it yields one row per top-level key, in declaration order. That is what lets
a schema with no expressions in it say "Issue: ISS-14". The same object also
rides on every action the panel dispatches, the way a socket's surface context
does.

`PLUGIN_NAVIGATE_CONTEXT_MAX_BYTES` is **2 KiB** and caps both routes. It is a
pointer, not a payload: the destination panel reads the plugin's collections for
everything else, and a context large enough to carry a page would be a second,
unversioned data channel no budget accounts for. Over the cap, the navigation
still happens and the context is dropped — the user pressed a button and should
still land where it sent them.

### The webview tier

A `webview` surface is the one place a plugin ships UI code. It renders the
plugin's own HTML in a sandboxed guest on the desktop, and every other client
renders the surface's `panelId` panel instead — `panelId` is required on a
webview surface precisely because the fallback is what keeps the cross-surface
promise honest. `builtin` and `webview` cannot be combined: a gate draws
nothing and a page draws everything, and honouring both would ask the client
which of the two it is looking at.

**One origin per plugin.** Pages are served over `ade-plugin://<pluginId>/…`,
which resolves to that plugin's install directory and nothing above it. A custom
scheme rather than `file:` for exactly one reason: with `file:` every plugin
would share one origin, `'self'` in the CSP would mean "the whole filesystem",
and storage would be shared. Requests are refused unless their real path
(symlinks followed) is still inside the install directory; a directory URL
resolves to `index.html` and a directory itself is a 404, never a listing. Only
an installed *and enabled* plugin has an origin at all, so disabling a plugin
closes its pages. Content types come from a closed map, and every response —
refusals included — carries the CSP and `nosniff`.

**The policy** is `PLUGIN_WEBVIEW_CSP`: `script-src 'self'` (no CDN, no inline
script — a plugin that wants a library vendors it), `style-src 'self'
'unsafe-inline'`, `img-src`/`media-src` reaching `https:`, `connect-src https:`
so a page can call its own service, and `form-action`, `frame-ancestors`,
`base-uri`, `object-src` all closed. The guest runs sandboxed and
context-isolated, in a **non-persistent per-plugin session partition**: cookies,
storage, and caches die with the window, so plugin state belongs in collections
where it is budgeted and visible in the usage meter. Links leave for
the user's real browser; navigation away from the plugin's own origin is
refused; new windows are denied.

**The bridge** is `window.adePlugin`, published by a preload that exposes
nothing else — no `window.ade`, no `require`, no raw IPC.
`PLUGIN_WEBVIEW_BRIDGE_VERSION` is **1** and moves the way `PLUGIN_SDK_VERSION`
does: additive, never re-shaped. The closed method list is `collections.get`,
`collections.put`, `collections.list`, `invoke`, `config.get`, and
`openDeeplink`; `collections.list` returns at most 500 rows, and every
collection named must be declared in the manifest. Absent on purpose, and not
stubbed: `secrets` (a page is the last place credentials should be readable),
`contributions.publish` and `panels.update` (a page draws itself; publishing
into other surfaces is the child's job), and `collections.delete`.

**The plugin id is never on the wire.** Every call is answered against the id
the host derives from the guest's own frame URL, cross-checked against the entry
the window layer wrote when it approved the attach. A `pluginId` field in a
payload would be a claim, and honouring a claim is how one plugin reads
another's collections — so there is no such field to ignore.

Reads and `invoke` go through the ordinary `plugin` action domain, and fall
through to the project runtime the guest's window is bound to when the Electron
main process holds no host. Writing does not: `PLUGIN_DOMAIN_ACTIONS` is a
closed list mirrored by the RPC schema and iOS's compile-time allowlist, and a
write action on it would let any client write any plugin's rows. The bridge
reaches the host service's own writer instead — which is why a page's write
needs an in-process host (see *Accepted v1 limitations*).

### Sockets

Seven kinds (`toolbar-action`, `row-badge`, `row-menu-item`, `detail-section`,
`empty-state`, `filter-chip`, `file-viewer`) across six surfaces (`work`,
`lanes`, `files`, `prs`, `automations`, `cto`). The taxonomy is closed and small
so an author learns it once and iOS can implement it exhaustively at compile
time; a seventh kind is a platform change with a parity cost on four clients.

Placement is host-controlled and always **after** core content — `order` sorts
plugins against each other and nothing more. Row badges cap at 2 visible with a
"+N" overflow; one plugin may place at most 8 contributions in one slot. A
payload that fails its per-kind validation renders nothing rather than a
half-built row.

Static contributions come from the manifest; dynamic per-entity values come from
`plugin_contributions` rows computed by the machine that owns the data. Actions
receive a typed read-only context object — a projection with the handful of
fields a plugin's UI needs, never a handle to the lane's worktree, the PR's
token, or the session's transcript.

The lane row's Linear issue badge (`LinearIssueBadge`) is not a `row-badge`
socket contribution — which Linear issue a lane implements is core lane
metadata (`lane.linearIssue`), not something a plugin adds — but it follows
`ade-linear` anyway, because it is a visible Linear entry point and a machine
without the plugin should have none. It gates itself, on the same
`isBuiltinSurfaceVisible("linear")` predicate as the pane and the `linear-issue`
deeplink, rather than at each of the four lane surfaces that render it. iOS does
the same in `LaneLinearIssueBadge` via `PluginPresenceGate`. The lane metadata
underneath is untouched: uninstalling `ade-linear` hides the badge, it does not
unlink the issue, and reinstalling brings the badge back with the issue still
attached.

### Themes

Theme plugins omit `entry` entirely and run no code. The engine injects a single
`<style id="ade-plugin-theme">` element with `[data-theme]`-scoped overrides
rather than calling `setProperty` inline, which would shadow the cascade.
Only design-token namespaces are settable: `--color-*`, `--shell-*`, `--chat-*`,
`--work-*`, `--pane-*`, `--pr-*`, `--gradient-*`. Preview applies without
persisting and Esc reverts; Apply persists the chosen theme in root prefs.

### Discovery

The registry is a public GitHub repository whose own scheduled Action crawls the
`ade-plugin` GitHub topic and writes a static `index.json`; ADE fetches it from
`raw.githubusercontent.com` with an etag cache. Featured and Official sets are
curated files in that repository, and `official` is set from `official.json`
alone — a manifest's own `"official": true` is ignored, because being official
is a statement ADE makes about a plugin, never one the plugin makes about
itself. Official entries additionally carry per-version sha256 digests the
installer verifies; a version with no published digest installs as *unverified*,
not as failed.

Install counts come from a single ping to the push relay carrying
`{pluginId, version}` and nothing else, signed with the machine identity the
relay already holds, one row per (plugin, machine), expiring after 180 days, and
disabled entirely by `ADE_PLUGIN_INSTALL_PINGS=0`. Full data-minimisation notes
are in [registry/README.md](../../../registry/README.md).

Until the registry repository exists, the Marketplace ships a bundled index of
official plugins and layers a live index on top when one becomes reachable.

### Client entry points

| Client | Entry |
|---|---|
| Desktop | Plugin tabs below the nav divider; Marketplace above Account; panels via the vocabulary renderer. A `webview` surface joins the same rail and draws the plugin's own page instead of a panel |
| Web | Same React renderer, view-scoped data over a roster-style `plugin_subscribe` stream; Marketplace and plugin tabs lazy-loaded and absent from the sign-in graph. A `plugin` deeplink has no hosted route — `targetToWebPath` answers null and each caller degrades where the user can see it |
| iOS | Read and action-invoke only — no local CRR writes to `plugin_*`. Panes mount as a sheet from an overflow menu and the machine screen |
| TUI | `/plugin-view [plugin]` opens a panel in the right pane; forms go through the composer prompt line; `Ctrl+Y` copies an `ade://plugin/<id>/<panel>` link to the open panel (and still copies a lane or PR link when one of those rows is focused) |
| CLI | `ade plugin …`, `ade <pluginId> <cmd>` for manifest-declared CLI words, and `ade link plugin <plugin-id> <panel-id> [--ctx '<json>']` to mint a panel link |
| Chat | The `plugin_install` `ade_card` variant, for agent-built install flows |

A plugin panel is addressable: `ade://plugin/<plugin-id>/<panel-id>[?ctx=<json>]`,
with the `https://ade-app.dev/open?type=plugin&plugin=…&panel=…` form alongside
it. It is the one target kind whose destination may genuinely not exist on the
receiving machine — plugins are installed per machine — so clients say so
plainly rather than redirecting to the Marketplace. Full grammar and routing
ladder in [Deeplinks](../deeplinks/README.md).

## Accepted v1 limitations

Stated plainly because each one is a deliberate scope decision, not an
oversight:

- **A `webview` surface is desktop-only.** iOS, the web client, and the TUI
  render the surface's declared panel instead. That is the trade the tier
  exists to make, not a gap to close: a page buys unlimited UI by giving up
  three of the four clients.
- **A page cannot write collections unless the plugin host is in-process.**
  `collections.put` reaches the host service's own writer, and nothing assigns a
  plugin host in the Electron main process — the host is a machine-scoped
  singleton in the daemon — so a page's write is refused with
  `plugins_unavailable` ("This page can't save data on this computer.") while
  reads and `invoke` fall through to the project runtime and work. A page that
  needs to persist calls its own action and lets the child write. Routing the
  write instead would mean a write action on the closed `plugin` domain, which
  every client can call for every plugin.
- **The hosted web client has no route for a plugin panel.** `/plugin/:id` is
  deliberately absent from the shell's route roots because the tab is gated on a
  host capability the shell cannot probe before its adapter is up, so
  `targetToWebPath` answers null for a `plugin` target rather than landing the
  reader on a plausible-looking empty shell.
- **iOS draws two of the seven socket kinds.** `row-badge` and `row-menu-item`
  render; `toolbar-action`, `detail-section`, `empty-state`, `filter-chip`, and
  `file-viewer` decode as `.unsupported` and draw nothing. A later iOS build
  adds the rendering arm with no wire change. PR rows are badges-only (no
  four-section menu exists there yet) and lane child rows are unwired.
- **iOS renders 12 of the 13 v1 components.** `chart` shows a named marker.
- **The TUI renders 10 of 13 and no sockets.** `video`, `image`, and `chart`
  show named placeholders; `/plugin-view` is the only plugin surface there.
- **iOS themes are accent-only.**
- **Theme coverage is token-backed surfaces (~52%).** Raw hex and Tailwind
  colors elsewhere are unaffected; that cleanup is deferred.
- **Presence fan-out nudges are desktop-originated.** The brain has no outbound
  machine-command client, so presence converges by pull-on-demand when only the
  brain is running.
- **Electron-side resource attribution of plugin children falls through to the
  ade-runtime walk** — there is no plugin host on the Electron main process by
  design.
- **The elevated-role `methodNotFound` fix is applied to the `plugin` domain
  only.** A repo-wide fix would break an existing account-usage test assertion;
  it is a deliberate follow-up.
- **The registry is not yet a standalone repository.** Extraction is a manual
  step documented in [registry/README.md](../../../registry/README.md), and the
  crawler workflow is deliberately not under `.github/workflows/`.
- **`official.json` sha256 slots fill in only when a version is tagged**, and
  the in-repo copy is synced by hand from the published registry rather than
  regenerated — only real digests are ever recorded, but nothing keeps this
  file current automatically.
- **No `plugins.recommended` in per-project `ade.yaml`.** Installs are
  per-machine in v1.

## Cross-links

- [Sync and multi-device](../sync-and-multi-device/README.md) — CRR tables, the
  hello capability handshake, remote commands.
- [Files and editor](../files-and-editor/README.md) — the viewer registry the
  `file-viewer` socket extends.
- [Pull requests](../pull-requests/README.md) and [Lanes](../lanes/README.md) —
  the surfaces row badges and menu items attach to.
- [ADE Code](../ade-code/README.md) — `/plugin-view` and the right-pane
  interpreter.
- [Deeplinks](../deeplinks/README.md) — the `plugin` target, its `ctx`
  parameter, and the per-client routing ladder.
- [System overview](../../ARCHITECTURE.md) — IPC contract, action registry, data
  plane.
- [registry/README.md](../../../registry/README.md) — the plugin directory, its
  curation model, and extraction steps.
- Authoring reference for agents:
  `apps/desktop/resources/agent-skills/ade-plugins/SKILL.md`.
