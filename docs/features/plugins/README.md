# Plugins

The plugin platform lets anything outside ADE's six core surfaces — Work, Lanes,
Files, PRs, Automations, CTO — be added by a third party, and lets several
things currently inside ADE be extracted into plugins later.

A plugin is a git-repo folder with a `plugin.json` at its root. It installs to
`~/.ade/plugins/<id>/` on one machine at a time. Two rules shape everything
else:

- **Code runs only on the machine that owns the plugin**, in a supervised Node
  child process. There is no remote execution path and no webview tier.
- **UI is declarative data, never code.** A plugin ships a versioned JSON *panel
  schema*; desktop, web, iOS, and the `ade code` TUI each interpret that same
  JSON with their own native widgets. One plugin therefore works across four
  independent release trains (desktop auto-update, App Store review, npm, web)
  without shipping anything executable to three of them.

## Source file map

Shared contracts — imported by the daemon, the renderer, `apps/ade-cli`, and
transcribed into Swift. Pure types plus pure parsers; no React, Electron, or
Node built-ins:

| File | Responsibility |
|---|---|
| `apps/desktop/src/shared/plugins/manifest.ts` | `plugin.json` contract, strict-on-known/tolerant-of-unknown parser, id and relative-path validation, `minAdeVersion` gate |
| `apps/desktop/src/shared/plugins/vocabulary.ts` | Panel schema v1: component union, `VOCAB_LIMITS`, degradation ladder, `parsePluginPanel` |
| `apps/desktop/src/shared/plugins/sockets.ts` | Socket kinds, surface ids, entity kinds, per-kind payload validation, deterministic placement ordering, row-badge overflow split |
| `apps/desktop/src/shared/plugins/context.ts` | Read-only surface contexts (`pr`, `lane`, `session`, `file`, `surface`) and their contribution keys |
| `apps/desktop/src/shared/plugins/sdk.ts` | SDK v0 surface, budgets, error codes, NDJSON child frames, install-registry records, the `plugin` action domain |
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
| Desktop | Plugin tabs below the nav divider; Marketplace above Account; panels via the vocabulary renderer |
| Web | Same React renderer, view-scoped data over a roster-style `plugin_subscribe` stream; Marketplace and plugin tabs lazy-loaded and absent from the sign-in graph |
| iOS | Read and action-invoke only — no local CRR writes to `plugin_*`. Panes mount as a sheet from an overflow menu and the machine screen |
| TUI | `/plugin-view [plugin]` opens a panel in the right pane; forms go through the composer prompt line; `Ctrl+Y` copies the panel's fallback deeplink |
| CLI | `ade plugin …`, plus `ade <pluginId> <cmd>` for manifest-declared CLI words |
| Chat | The `plugin_install` `ade_card` variant, for agent-built install flows |

## Accepted v1 limitations

Stated plainly because each one is a deliberate scope decision, not an
oversight:

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
- **`official.json` sha256 slots are empty until release tagging.** Only real
  digests are ever recorded.
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
- [System overview](../../ARCHITECTURE.md) — IPC contract, action registry, data
  plane.
- [registry/README.md](../../../registry/README.md) — the plugin directory, its
  curation model, and extraction steps.
- Authoring reference for agents:
  `apps/desktop/resources/agent-skills/ade-plugins/SKILL.md`.
