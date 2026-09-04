# Plugins

The plugin platform lets anything outside ADE's six core surfaces — Work, Lanes,
Files, PRs, Automations, CTO — be added by a third party, and lets several
things currently inside ADE be extracted into plugins later.

A plugin is a git-repo folder with a `plugin.json` at its root. It installs to
`~/.ade/plugins/<id>/` on one machine at a time. Two rules shape everything
else:

- **Code runs only on the machine that owns the plugin**, in a supervised Node
  child process. There is no remote execution path.
- **A plugin's UI has two tiers, and the page is the primary one.** A `webview`
  surface ships the plugin's own HTML, and desktop, the hosted web client and
  iOS each draw it in an isolated guest. Under it sits the *vocabulary*: a
  versioned JSON panel schema that every client interprets with its own native
  widgets, across four independent release trains (desktop auto-update, App
  Store review, npm, web).

The second rule used to read “UI is declarative data, never code”, with a page
as a desktop-only escape hatch. The owner inverted it on 2026-09-03, after the
Linear acceptance walk on the Alpha build: the vocabulary cannot reach the
quality of the compiled pages it was meant to replace, so the page is the tier a
plugin designs for. The decision and its acceptance test are
`docs/reports/plugin-page-tier-spec.md`.

The exception inverted with it. The vocabulary is FROZEN, not deleted, and it is
now what a client draws when it cannot draw the page. A `webview` surface still
declares a `panelId`, and that panel is what the `ade code` TUI draws, what a
phone holding no cached page draws, and what a client older than the page host
draws — so a plugin that ships a page still works everywhere it worked before.
The terminal draws a frozen SUBSET of the vocabulary, the *terminal profile*.
See [The page tier](#the-page-tier) and
[The vocabulary contract](#the-vocabulary-contract).

## Source file map

Shared contracts — imported by the daemon, the renderer, `apps/ade-cli`, and
transcribed into Swift. Pure types plus pure parsers; no React, Electron, or
Node built-ins:

| File | Responsibility |
|---|---|
| `apps/desktop/src/shared/plugins/manifest.ts` | `plugin.json` contract, strict-on-known/tolerant-of-unknown parser, id and relative-path validation, `minAdeVersion` gate, the `tab`/`pane`/`webview` surface kinds and the `entryHtml` rule |
| `apps/desktop/src/shared/plugins/vocabulary.ts` | Panel schema v1: component union, `VOCAB_LIMITS`, degradation ladder, `parsePluginPanel`, panel `chrome` (search, nav actions, sticky footer), the reserved bindings (`vocabReservedRows` over `$context` and `$state`), `collectVocabStateDeclarations` |
| `apps/desktop/src/shared/plugins/vocabularyNodes.ts` | The 18 v1 components and their parsers, `VOCAB_LIMITS`, the `group` node and `vocabGroupKey`, the row-action allowlist (`boundRowAction`), the `canvas` engines (`git-dag`, `swimlane`, `graph`, `workspace`, `electron-control`, `simulator`) |
| `apps/desktop/src/shared/plugins/vocabularyState.ts` | Client-evaluated panel state: the `segmented` control's declarations, `chrome.search`, the `where` grammar (`contains` included) and its three-valued evaluator, the `$state` binding (`VOCAB_STATE_COLLECTION`), the row selection a `list.selectable` owns, the signature/normalize/reset lifecycle, `readPluginActionResetState` |
| `apps/desktop/src/shared/plugins/vocabularyMarkdown.ts` | The `markdown` node's subset: a bounded block/span AST, `VOCAB_MARKDOWN_LIMITS`, `https:`-only links, GFM pipe tables, https images, and no HTML path at all |
| `apps/desktop/src/shared/plugins/vocabularyBrandIcons.ts` | Plugin-shipped `brand:*` glyphs: the reserved `ade.brandIcons` collection, the fail-closed SVG sanitizer, and the portable `{ viewBox, paths }` shape |
| `apps/desktop/src/shared/plugins/vocabularyPaging.ts` | One `list`'s page: `vocabListPage`, `vocabListNextPage`, the three-state `vocabListPageLabel`, and `VOCAB_LIST_SHOW_MORE_LABEL` |
| `apps/desktop/src/shared/plugins/urlMatchers.ts` | The no-regex `pathPattern` grammar, the chip label template, the core-host refusal and the ownership relaxation (`coreSmartLinkBuiltinsOwnedBy`) |
| `apps/desktop/src/shared/plugins/smartLinkMatchers.ts` | Compiling installed plugins' matchers and running them against a pasted URL; the chip and its deeplink |
| `apps/desktop/src/shared/plugins/sessionSetup.ts` | `sessionSetup`: the static `ADE_PLUGIN_` key prefix, the reserved host names, the caps, and `parsePluginSessionSetup` |
| `apps/desktop/src/shared/plugins/builtinSurfaces.ts` | `BUILTIN_SURFACE_OWNERS`: which plugin owns which compiled surface, its `presence`, its `actionDomains` and its `actionNames` |
| `apps/desktop/src/shared/plugins/installDisclosure.ts` | `describeManifestAdds`: the one place every "Adds:" sentence is written, sign-in flows and credential handoffs included |
| `apps/desktop/src/shared/plugins/webviewBridge.ts` | The `window.adePlugin` contract: `PLUGIN_WEBVIEW_BRIDGE_VERSION` (2), the `ade-plugin://` origin and per-plugin partition, `PLUGIN_WEBVIEW_CSP`, the closed method list, `PLUGIN_WEBVIEW_PLACEMENTS`, the three event names, the theme snapshot and its sanitizer, the host-event kinds and their coalescing, the toast/confirm/composer payloads, the UI verbs and their timeouts, the resize channel and its clamp |
| `apps/desktop/src/shared/plugins/sockets.ts` | Socket kinds, surface ids, entity kinds, per-kind payload validation, deterministic placement ordering, row-badge overflow split |
| `apps/desktop/src/shared/plugins/context.ts` | Read-only surface contexts (`pr`, `lane`, `session`, `file`, `surface`) and their contribution keys |
| `apps/desktop/src/shared/plugins/sdk.ts` | SDK v0 surface, budgets, error codes, NDJSON child frames, install-registry records, the `plugin` action domain, action-response navigation (`readPluginActionNavigation`, `PLUGIN_NAVIGATE_CONTEXT_MAX_BYTES`) |
| `apps/desktop/src/shared/deeplinks.ts` | The `plugin` deeplink target (`ade://plugin/<plugin-id>/<panel-id>[?ctx=…]`) and its lenient `ctx` reader; the provider-neutral `issue` target (`ade://issue/<provider>/<issue-key>`), of which `linear-issue` is a permanent alias |
| `apps/desktop/src/shared/issueRef.ts` | `IssueRef`: the provider-neutral issue a plugin links to a lane or a session, the `__issueRef` storage key, the legacy Linear projection, and the ownership check `unlinkIssue` runs |
| `apps/desktop/src/shared/issueRefFormat.ts` | Lane name, branch name and PR magic word derived from an `IssueRef`. `Fixes`/`Closes` only for `linear`/`github`; every other provider gets `Refs` |
| `apps/desktop/src/shared/plugins/registryIndex.ts` | Marketplace index contract and checksum verification |
| `apps/desktop/src/shared/plugins/network.ts` | Declared-host rules: what a manifest may name, how a live host is matched against it, the refusal sentence |
| `apps/desktop/src/shared/adeCliGuidance.ts` | Registers the bundled `ade-plugins` authoring skill |

Host (daemon / main process):

| File | Responsibility |
|---|---|
| `apps/desktop/src/main/services/plugins/pluginHostService.ts` | Machine-scoped shared singleton: load, enable/disable, config, panel and collection reads, the `plugin` domain implementation |
| `apps/desktop/src/main/services/plugins/pluginChildSupervisor.ts` | Child spawn, env denylist, NDJSON framing, ready/invoke timeouts, stderr ring, exponential restart backoff, crash containment, two-stage kill |
| `apps/desktop/src/main/services/plugins/pluginSdkServer.ts` | Serves the child's `sdk` frames — the host half of every SDK method |
| `apps/desktop/src/main/services/plugins/childRuntime/pluginChildBootstrap.ts` | The child process: loads the entry module, installs the `ade` global, dispatches `invoke` |
| `apps/desktop/src/main/services/plugins/childRuntime/pluginChildNetworkGuard.ts` | Patches `fetch`, `WebSocket`, `http`/`https` and `net`/`tls` in the child, before the entry loads, so an undeclared host is refused and audited |
| `apps/desktop/src/main/services/plugins/pluginInstallService.ts` | Install from local path or git URL, `state.json` registry, plugin skill roots |
| `apps/desktop/src/main/services/plugins/pluginDataStore.ts` | Collections/contributions/panels reads and writes; delegates budget enforcement |
| `apps/desktop/src/main/services/plugins/pluginSecretStore.ts` | `plugin:<id>:<NAME>` namespace in the machine credential store |
| `apps/desktop/src/main/services/plugins/pluginEvents.ts` | Debounced `lane/pr/session/install.changed` fan-out to children |
| `apps/desktop/src/main/services/plugins/pluginEntityChanges.ts` | The module-level bus the daemon's lane, PR and session producers emit on, plus `prTransitionsFromChanges` |
| `apps/desktop/src/main/services/plugins/pluginAuthSessionService.ts` | The host half of `ade.auth.beginSession`: the authorize URL, the minted `state`, the loopback listener, the relay bounce, the TTL and the `auth.completed` settle |
| `apps/desktop/src/main/services/plugins/pluginCredentialHandoff.ts` | The descriptor table, the consent card's copy, the recorded answer, and the copy into the plugin secret store |
| `apps/desktop/src/main/services/plugins/pluginOfficialClients.ts` | `ade.auth.officialClient`: ADE's own public PKCE client id, lent to the owner of the surface it belongs to. `assertNoClientSecret` |
| `apps/desktop/src/main/services/plugins/pluginSessionSetupStore.ts` | Writes the session's sidecar and context file, and builds the env the launched agent receives |
| `apps/desktop/src/main/services/chat/pluginSessionSetupProvenance.ts` | The module-private symbol that carries the owning plugin id past `JSON.parse`, so `ADE_PLUGIN_SOURCE_ID` cannot be forged |
| `apps/desktop/src/main/services/plugins/pluginWebhookIngressService.ts` | One relay drain for every plugin that declares `webhookIngress`: secret registration, the 45s poll, the pruned `plugin_ingress_events` ledger, signature verification, delivery and ack |
| `apps/desktop/src/main/services/plugins/pluginWebviewProtocol.ts` | Serves `ade-plugin://<pluginId>/…` from the install directory: containment, directory rule, closed MIME map, CSP + `nosniff` on every response including refusals |
| `apps/desktop/src/main/services/plugins/pluginWebviewBridgeServer.ts` | The host half of `window.adePlugin`: sender-pinned plugin id, the declared-collection rule, the write path that bypasses the action domain |
| `apps/desktop/src/main/services/plugins/pluginWebviewGuests.ts` | Which attached guests are plugin pages, and whose |
| `apps/desktop/src/preload/pluginWebviewPreload.ts` | The guest-side preload that publishes `window.adePlugin` and nothing else |
| `apps/desktop/src/main/services/state/dbMaintenanceApi.ts` | Budget constants and the prune/reject pass |
| `apps/desktop/src/main/services/storage/storageLedger.ts` | `.ade/plugins/` and `plugin_collections` storage accounting |

Sync and CLI:

| File | Responsibility |
|---|---|
| `apps/ade-cli/src/services/plugins/pluginTableWriters.ts` | The single budget-enforcing writer for every `plugin_*` table, and the `seeded` stamp on a panel materialized from the manifest |
| `apps/ade-cli/src/services/sync/pluginPageAssets.ts` | The host half of the page asset channel: the hashed manifest walk, the per-file read, the containment guard, `PLUGIN_PAGE_ASSET_MAX_BYTES` and the served directory |
| `apps/ade-cli/src/services/plugins/pluginPageHostRef.ts` | The late-bound ref through which the sync command service reaches the machine's plugin host writers |
| `apps/ade-cli/src/services/sync/syncRemoteCommandService.ts` | Among the plugin commands, `plugins.putCollection`, `plugins.getConfig` and `plugins.setConfig` — the page tier's writes from the phone and the web |
| `apps/ade-cli/src/services/plugins/pluginPresenceService.ts` | Per-machine presence fan-out and cache |
| `apps/ade-cli/src/services/plugins/pluginRegistryService.ts` | Registry index fetch with etag cache; `DEFAULT_PLUGIN_REGISTRY_INDEX_URL` |
| `apps/ade-cli/src/services/plugins/pluginInstallPing.ts` | Install count ping to the push relay |
| `apps/ade-cli/src/services/plugins/pluginSyncMeter.ts` | Per-plugin wire byte counters |
| `apps/ade-cli/src/services/plugins/pluginPanelBuilder.ts` | Materializes `plugin_panels` rows from manifest schema files |
| `apps/ade-cli/src/commands/plugin.ts` | `ade plugin list/create/install/remove/enable/disable/reload/logs/dev`, `ade <pluginId> <cmd>` routing |
| `apps/ade-cli/src/bootstrap.ts` | The daemon. Every `lane/pr/session.changed` producer, the `pr.changed` transition producer, and the plugin action gate (`pluginActionRefusalMessage`, `withPluginCallerProvenance`) |
| `apps/webhook-relay/src/relay.ts` | `GET /plugin/auth/callback`, the per-plugin ingress routes, and `PLUGIN_WEBHOOK_STORED_HEADERS` |

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
| `apps/desktop/src/renderer/components/plugins/PluginWebviewHost.tsx` | One guest, in whichever placement asked for it; the shared resize clamp, and the lazy load of the web page host |
| `apps/desktop/src/renderer/components/plugins/sockets/pluginWebviewRelay.ts` | The renderer half of the page relay: every UI verb, the action-result appliers, and the rule that every request is answered exactly once |
| `apps/desktop/src/renderer/components/plugins/sockets/PluginWebviewPopoverHost.tsx`, `pluginWebviewPopoverStore.ts` | The anchored popover placement, its one-at-a-time rule and its default 520×640 |
| `apps/desktop/src/renderer/components/plugins/sockets/pluginWebviewTheme.ts` | The `--ade-*` snapshot the window publishes to its guests |
| `apps/desktop/src/renderer/components/plugins/sockets/pluginWebviewGuestRegistry.ts`, `pluginWebviewReloadStore.ts`, `pluginWebviewConfirmStore.ts`, `pluginWebviewOverlayStore.ts` | Which guests are live, the `version:revision` reload key, and the two host-drawn cards a page can raise |
| `apps/desktop/src/renderer/webclient/plugins/` | The hosted web page host: `WebPluginPageHost.tsx`, `pageAssets.ts`, `pageDocument.ts`, `pageProtocol.ts`, `pageBridgeHost.ts`, `pageBridgeGuest.ts`, `pageActionResult.ts`, `pageTheme.ts`, `pageServiceWorkerClient.ts` and `pluginPageServiceWorker.js` |
| `apps/desktop/src/renderer/webclient/adapter/plugins.ts` | The web client's plugin calls, including the asset reads and the collection and config writes |
| `apps/desktop/src/renderer/webclient/public/_headers` | `frame-src`/`worker-src` on the client, and the `sandbox; default-src 'none'` policy on `/assets/plugin-pages/*` |
| `packages/ui` | `@ade-dev/ui`: the tokens, the theme and its injected stylesheet string, the primitives, the icon subpath and the markdown subpath — consumed by the desktop app through `file:../../packages/ui` |
| `apps/desktop/src/renderer/lib/pluginRuntimeBridge.ts` | `window.ade.plugins` bridge |
| `apps/desktop/src/renderer/components/app/pluginDeeplinkRoute.ts` | Where an `ade://plugin/…` link goes: the same hide-everything gate the compiled surfaces use, or a plain refusal |
| `apps/desktop/src/renderer/components/chat/PluginInstallChatCard.tsx` | The `plugin_install` `ade_card` variant for agent-built install flows |
| `apps/desktop/src/main/services/plugins/pluginInstallApproval.ts` | Turns an agent's `plugin.install`, `uninstall`, `enable` and `disable` into a card in that agent's own chat. Install approvals are remembered per `(pluginId, resolved source, disclosed grant)`; removals never are |

iOS and TUI:

A phone fetches a plugin's page over the sync file channel and caches it by
content hash, so an official plugin's page also ships INSIDE the app as a
pre-seeded cache entry — that is what makes a fresh install draw a real page
before it has ever reached a machine. Those bundled entries are generated:
`scripts/sync-bundled-plugin-pages.mjs` (`npm run sync:plugin-pages`) copies the
`dist/` of every plugin declaring a `webview` surface into
`apps/ios/ADE/Resources/BundledPluginPages/<pluginId>/`, writes the
`manifest.json` the store reads, and deletes what a plugin stopped shipping. Run
it and commit the result whenever a bundled plugin's page is rebuilt, and always
before an iOS archive — these are app resources, so a stale copy ships silently.
The Xcode project references the directory as a folder, so new files need no
per-file registration.

| File | Responsibility |
|---|---|
| `apps/ios/ADE/Models/PluginVocabularyParsing.swift`, `PluginVocabularyState.swift`, `PluginRecords.swift` | Swift transcription of the panel, panel-state and socket contracts |
| `apps/ios/ADE/Views/Plugins/PluginPaneStore.swift` | `PluginRenderSupport.renderableComponents` — the iOS renderable set — plus the panel back stack (`PluginPanelStackEntry`) and the pane's auth, prompt and selection state |
| `apps/ios/ADE/Views/Plugins/PluginPageSurface.swift`, `PluginPageHostView.swift` | Where a page is drawn on the phone, how a requested placement is narrowed to what the device can draw, and the vocabulary panel it falls back to |
| `apps/ios/ADE/Views/Plugins/PluginPageBridgeHost.swift`, `apps/ios/ADE/Models/PluginPageBridge.swift` | Bridge v2 on the phone: reads from the replicated mirror, `invoke` and writes over RPC, the same control-flow answers a socket press honours |
| `apps/ios/ADE/Services/PluginPageAssetStore.swift`, `PluginPageSchemeHandler.swift` | The content-addressed cache keyed on plugin, version and revision, the bundled pre-seeded entries, and the `ade-plugin://` scheme handler with the closed MIME map and the desktop policy |
| `apps/ios/ADE/Resources/BundledPluginPages/` | Pre-seeded page entries for official plugins, laid out by path rather than by hash |
| `apps/ios/ADE/Views/Plugins/PluginPresenceGate.swift` | Is the owner installed and enabled on the ATTACHED machine, and does that draw or hide the compiled surface (`drawsBuiltin`) |
| `apps/ios/ADE/Views/Plugins/PluginAuthSessionRunner.swift` | The phone's `ASWebAuthenticationSession` runner for a plugin sign-in, and the callback parameters it posts back |
| `apps/ios/ADE/Views/Plugins/PluginVocabularyView.swift`, `PluginVocabFormView.swift`, `PluginVocabularyMediaViews.swift`, `PluginVocabularyMarkdownViews.swift`, `PluginSocketViews.swift`, `PluginPaneSheet.swift`, `PluginEntryMenu.swift` | Native rendering and entry points |
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
- **A reload of a `local` install re-copies the source folder first**, staged
  and renamed exactly as an install is, and only then restarts the child. Before
  that, `reload` re-read whatever already sat in the install directory, so an
  edit at the source and a reload silently ran the previous bytes until someone
  installed the same path again — the round-2 alpha report's finding #8, which
  cost five identical reload cycles. A resync the host has to refuse (the folder
  moved away, its `plugin.json` stopped parsing, it renamed itself to another
  plugin id) comes back as a **warning on the reload result** and leaves the
  previous copy running. `git` and bundled installs re-read the installed copy
  as before; nothing fetches on a reload.
- **The host records the last invoke attempt per plugin, per action**, in
  memory, capped at 32 actions per plugin and dropped on uninstall. Every route
  funnels through the one `plugin.invoke`, and a refusal counts as an attempt
  and carries its code. It rides `plugin.get` as `lastInvokes` and is what
  `ade plugin doctor`'s **Last run** rung reads — the rung that separates "the
  action never fired" from "it fired and published nothing", which the ladder
  could not do before.

### Outbound network is declared, disclosed and enforced

The child is an ordinary Node process, so before this it could reach any host on
the internet with nothing declaring it, disclosing it at install, allowlisting it
or auditing it — the page tier was strictly stricter than the child tier that
holds the plugin's secrets.

- A manifest declares `network: { hosts: [...] }`. **Absent means no outbound
  network at all.** Max 8, lowercase hostnames; no scheme, port, path or IP; one
  leading `*.` wildcard, which matches any subdomain depth but never the apex.
  The rules and the match live in `shared/plugins/network.ts`, shared by the
  parser, the disclosure and the child so the three cannot disagree.
- The install disclosure prints "Talks to api.cursor.com" in the same "Adds:"
  list as everything else — the Marketplace modal, the Marketplace detail page
  and the in-chat approval card all read `describeManifestAdds`, so there is one
  copy of the sentence.
- `pluginChildNetworkGuard.ts` patches `fetch`, `WebSocket`, `http`/`https`
  `request`/`get` and `net`/`tls` `connect` **before the plugin entry is
  required**, because a dependency that dials at import time is exactly what a
  later guard would miss. An undeclared host throws (or rejects)
  `network_host_not_declared` and writes one `warn` line with `{ code, host,
  via }` to the plugin's log ring.
- `ade plugin doctor` grows a **Network** rung: the declared hosts, and a count
  of refusals read back off that log.

**This is a guard-rail, not a sandbox.** `pluginChildBootstrap.ts` already
assumes the plugin is buggy rather than malicious-proof, and `child_process`
walks around every door above. What the declaration buys is that an official
plugin sending the user's key somewhere has to say so first, and that a
dependency which quietly gains a telemetry call fails loudly. Do not write copy
that claims more.

`ade-voice` is the one bundled plugin that needs it: it declares
`huggingface.co`, `*.huggingface.co` and `*.hf.co`, because the model download
answers 302 to a four-label CDN host.

### Provider keys are brokered, never copied

`sdk.secrets` is a per-plugin namespace in a separate encrypted file. ADE's own
API keys live in the keychain-backed store as `ai.api_key.<provider>.v1`, and
they also power core features — local Cursor chat, for one. Without a broker a
user pastes the same key twice and rotating one silently breaks the other.

- A manifest declares `providerKeys: ["cursor"]`, validated against
  `PLUGIN_PROVIDER_KEY_IDS`, which a test pins to the key store's own
  `ENV_KEY_PROVIDERS`.
- The install card says "Uses your Cursor API key", beside the network line.
- `ade.secrets.getProviderKey(provider)` returns the key for a **declared**
  provider only. Undeclared is `not_permitted` — the same refusal an undeclared
  collection gets; a provider ADE stores no key for is `invalid_args`; declared
  with nothing connected is `null`, which is a state to draw rather than an
  error to report. `hasProviderKey` answers the same question without the value.
- The key goes from `apiKeyStore` to the SDK reply frame and nowhere else. It is
  never written to the plugin secret store, never put in a collection, a panel
  schema or the sync layer, and never logged. `plugin.get` carries **presence
  only**, as `providerKeys: [{ provider, present }]`, which is what the doctor's
  **Provider keys** rung reads.
- The remembered install approval is keyed on the declared hosts, provider keys,
  project secrets, sign-in flows and built-in credential handoffs as well as the
  source, so a later save that widens any of the five raises the card again
  instead of riding an approval given for something narrower. A sign-in flow is
  keyed by its provider and its loopback port, not by its id: a version that
  keeps the id and repoints it at a different provider has changed the sentence
  the reader agreed to.

### Project secrets are declared by name, and read one at a time

The project's own secrets — what the user imported from a `.env` — are the most
sensitive read on the machine, and they were reachable by any installed plugin
through `ade.actions.invoke("project_secret", "get")` with nothing on the
install card saying so. They now follow the same declare → disclose → enforce
path as the two above.

- A manifest declares `projectSecrets: ["STRIPE_API_KEY"]`, max 6, validated
  against `PROJECT_SECRET_NAME_PATTERN` — the secret store's own name rule, so a
  manifest cannot declare a name the store could never hold.
- Names rather than a boolean, because the action is already called by name and
  because "reads your STRIPE_API_KEY" is a disclosure a person can act on.
- The install card says "Reads this project's secrets (.env): STRIPE_API_KEY",
  last of the three capability lines. The same sentence reaches the Marketplace
  detail modal and the in-chat approval card, all three through
  `describeManifestAdds`.
- **`get` is the only verb a plugin may reach**, and only for a declared name.
  `list`, `set`, `delete`, `previewEnvImport` and `importEnv` are refused to
  every plugin declared or not — `list` included, because it reads back the
  names of the secrets the plugin did **not** declare. `exportEnv` was already
  CTO-only. A plugin keeps its own secrets in `ade.secrets.*`.
- The gate is `pluginProjectSecretRefusal` in `bootstrap.ts`, applied in the
  plugin binding's `invokeAdeAction` — the door every plugin-originated action
  invoke passes through. The declared list arrives on `caller`, resolved by the
  host from the parsed manifest and never from the call's arguments. Callers
  that are not a plugin child — the user's own agent, the CLI, the desktop
  renderer — are untouched.
- `ade plugin doctor` grows a **Project secrets** rung: which names, or that the
  plugin reads none. Declaration only; it never reports whether a secret is set.

### Signing in: the host runs the flow, the plugin holds the token

A plugin cannot do OAuth by itself, and it must not be able to. The child is a
plain Node process with no window, and on a phone there is no child at all. So
the host owns every part of the dance that touches the user or the redirect, and
the plugin owns the exchange. `pluginAuthSessionService.ts` is the host half.

- A manifest declares `authSessions: [{ id, provider, authorizeUrl, clientId?,
  callbacks, loopback? }]` — at most 2 per plugin
  (`manifest.ts:1608`). `authorizeUrl` is `https:` only and must carry no query
  and no fragment, because the host appends the query and two spellings would
  fight (`manifest.ts:1639-1645`). `provider` is a display name, not a hostname:
  the install card says "Signs you in to Linear", never "opens
  linear.app/oauth/authorize" (`installDisclosure.ts:249-257`).
- `authorizeUrl` is DECLARED rather than passed at call time. A plugin that could
  choose its own authorize URL at runtime could send the user's browser anywhere
  and call it a sign-in (`manifest.ts:560-564`).
- `clientId` is optional and is the plugin's own PUBLIC client id. It is
  validated as non-empty, whitespace-free and at most
  `PLUGIN_AUTH_CLIENT_ID_MAX` (256) characters, and a present-but-bad value drops
  the whole flow rather than being clipped — a clipped client id is one the
  provider refuses, and the author would debug a rejected authorization instead
  of reading a warning (`manifest.ts:1663-1678`).
- `ade.auth.beginSession({sessionId, params?, transport?})` starts one flow. The
  host mints `state` (32 random bytes) and `attempt` (a UUID), builds the URL,
  and answers `{sessionId, attempt, transport, redirectUri, expiresAt}` — never
  the URL. The action handler returns `{authSession: {sessionId}}`, and the host
  stamps the live URL on the way to whichever client the user is on.
- **`redirect_uri` and `state` are refused by name**
  (`PLUGIN_AUTH_RESERVED_PARAMS`), not overwritten, so an author finds out which
  half of the safety property the platform is holding
  (`pluginAuthSessionService.ts:419-429`). `params` caps at
  `PLUGIN_AUTH_PARAMS_MAX` (12) and each value at
  `PLUGIN_AUTH_PARAM_VALUE_MAX` (512).
- **The plugin never sees `state`**, outbound or inbound. The host mints it,
  holds it and compares it; the `auth.completed` payload carries the provider's
  own parameters MINUS `state`. A second copy in the child would invite a second,
  weaker check that disagrees with the host's (`sdk.ts:879-886`).
- **PKCE is the plugin's**, because only the plugin performs the exchange and so
  only the plugin can hold the verifier. The host brokers the AUTHORIZATION and
  never holds a token: a host that held one would have to refresh it, and
  refreshing a grant it cannot use is a responsibility with no matching
  capability (`sdk.ts:1396-1410`).

**Two callback transports.** `loopback` binds `127.0.0.1:<port><path>` in the
host process and catches the GET itself; nothing leaves the machine. `app` sends
the provider to ADE's relay, which is stateless and does one thing — 302 the
query string to `ade://plugin-auth`. The port is DECLARED rather than allocated,
because every OAuth provider worth integrating matches `redirect_uri` exactly, so
an ephemeral port is a redirect no provider accepts; declaring it also puts the
collision on the install card instead of at the moment the user presses Connect
(`manifest.ts:622-631`). A `loopback` callback with no declared port drops the
whole flow at parse rather than downgrading it to `app`.

The asking client picks the transport, among what the flow declares: a phone gets
`app`, a desktop gets `loopback`, and an explicit `transport` argument is honoured
or refused but never quietly redirected (`pluginAuthSessionService.ts:379-408`).

**The relay route names no integration.** `GET /plugin/auth/callback` in
`apps/webhook-relay/src/relay.ts:2740-2789` re-emits `code` (or `error` plus
`error_description`), always emits `state` even when it is absent — an unroutable
callback must reach the app looking unroutable rather than looking like another
flow's — passes the remaining provider parameters through first-value-wins under
`PLUGIN_AUTH_CALLBACK_MAX_PARAMS`, refuses rather than truncates past the query
budget, and encodes spaces as `%20` so the provider's error text stays readable on
the phone. One route serves every plugin's every flow, so a new plugin needs no
relay deploy and the relay learns nothing about which plugin is signing in.

**On the phone.** `PluginAuthSessionRunner.swift` opens an
`ASWebAuthenticationSession` with the callback scheme the host sent on the invoke
result, captures `ade://plugin-auth?…` in-session, and posts the parameters back
with the `plugins.completeAuthSession` remote command. It carries every query
item, unfiltered and capped at 24, because the phone serves every plugin's every
provider and a field it has not heard of is a field it must still carry. It names
no plugin and no session: the machine routes by the `state` it minted and never
gave out, so a phone can only ever finish a flow that machine started. A
`loopback` flow is refused before the browser opens, with a sentence saying where
the sign-in does finish (`PluginPaneStore.swift:1436-1450`) — the machine's
listener is on the machine's own `127.0.0.1`, and a redirect there from a phone
lands on the phone.

**How a flow ends.** `PLUGIN_AUTH_SESSION_TTL_MS` is 10 minutes, armed as a real
timer rather than checked lazily, because nothing polls this service: without it a
plugin whose user closed the tab would wait forever on an `auth.completed` that
never came. `PluginAuthFailureReason` is `canceled | expired | denied |
state_mismatch` — named outcomes, because a plugin acts differently on each. A
second `begin` of a live flow is `auth_session_busy` rather than a supersede: the
previous attempt is a browser window the user is looking at right now.

Desktop and the web client open the stamped `url` in the browser through the
same opener `{openUrl}` uses. A `{message}` beside the `authSession` still
shows. The phone opens its own web-authentication session.

### Inheriting a connection ADE already holds

`credentialHandoff` is the release-day seam. `ade-linear` replaces ADE's compiled
Linear integration, and every existing user already has a working Linear token in
ADE's own machine credential store. Without this the day the plugin ships is the
day all of them reconnect.

- A manifest declares `credentialHandoff: ["linear"]` — at most 2, and it should
  almost always be 1. It is honoured for OFFICIAL packages only, for the same
  reason `surfaces[].builtin` is: this names a credential ADE already holds, and
  a community package that could name one would be asking the user to approve a
  card about a connection it had nothing to do with (`manifest.ts:1733-1755`).
- WHICH official plugin may name a given surface is not decided at parse.
  `parseCredentialHandoff` is pure and cannot import the owner table, so the HOST
  checks ownership against `BUILTIN_SURFACE_OWNERS` and refuses a non-owner
  (`pluginCredentialHandoff.ts:433-445`). `ade-graph` cannot ask for the Linear
  token by declaring it.
- **It is a COPY, not a move.** The card says so: "these are copied once and ADE
  keeps its own copy — nothing is taken away from ADE"
  (`pluginCredentialHandoff.ts:236-238`). Disabling the plugin leaves ADE's own
  connection exactly as it was.
- **The OAuth client SECRET is withheld, and the card names the withholding.**
  ADE's Linear credential is five flat keys, and four move: the access token
  (the anchor), the refresh token, the expiry, the auth mode, and the public
  client id pulled out of the stored `linear.oauthClient.v1` blob. The
  `clientSecret` sibling sits in that same blob and is never read out of it — it
  is ADE's identity to Linear rather than the user's credential, and a plugin
  holding it could mint tokens in ADE's name on every machine it is installed on.
  It is not gated and not optional; it is absent from `fields` entirely
  (`pluginCredentialHandoff.ts:88-163`). The card prints "Does not copy: ADE's own
  OAuth client secret, which is ADE's identity to Linear rather than yours."
- The client ID does move, because a refresh token is only ever redeemable by the
  client it was issued to. Without it the plugin would inherit a connection it
  could not renew — the reconnect the whole module exists to avoid.
- **Asked once.** An answer, yes or no, is recorded per `(pluginId, builtin)` in a
  plain JSON file beside the install registry, and a second `requestHandoff`
  returns it without raising a second card: a plugin that could re-prompt on
  every start would turn a consent card into a nag, and a nag is answered yes to
  make it stop. The one exception is a recorded ACCEPT whose copy is gone — the
  plugin deleted its own secrets — which re-asks, because a record saying
  "already answered" beside an empty secret store is a dead end.
- A `declined` is an ANSWER and never throws. The plugin is simply unconnected,
  and its ordinary sign-in flow is still there. A machine with nobody to ask —
  a headless brain with no desktop attached and no phone paired — answers
  `auth_unavailable` rather than hanging or copying quietly.
- Every word of the card is derived from the descriptor table and from the
  manifest the host parsed. Nothing the plugin passes at call time reaches it,
  because a plugin that could write the sentence could write a different one from
  the transfer it is actually asking for.
- The install card warns that the card is coming, in the same "Adds:" list as
  everything else: "Asks to use the Linear connection you already set up in ADE"
  — *asks to use*, never *uses*, because the install is not the consent
  (`installDisclosure.ts:259-268`).
- Uninstall calls `forget(pluginId)`, so a reinstall does not inherit an answer
  given to a package that is no longer on the machine. See
  [Connections leave with the plugin](#connections-leave-with-the-plugin) for the
  other half: the stored token goes with the package too.

A host wired without the handoff seam refuses with `unsupported_method`,
"This copy of ADE cannot hand a connection to a plugin.", not
`auth_unavailable`. The remedy is the plugin's own sign-in. No official plugin
uses the handoff today; `ade-linear` signs in through the official-client
broker like any other plugin.

### Borrowing ADE's own OAuth client

The handoff moves a connection that already EXISTS. It does nothing for a fresh
machine and nothing for a user who declined, and both were left with a Connect
button that could not build an authorize URL — `client_id` identifies ADE to the
provider and no verb handed a plugin ADE's. The only reachable path was a pasted
API key, which is a real capability regression against the compiled integration
the plugin replaces.

`ade.auth.officialClient(provider)` answers `{provider, clientId, authorizeUrl?,
scopes?}` and nothing else.

- **Lending the id is safe because the id is already public.** ADE's bundled
  Linear app is a public PKCE client: the id ships in the binary, no secret ships
  at all, and the id is a query parameter of every authorize URL ADE has ever
  opened. A plugin that wanted it could read it off one sign-in
  (`pluginOfficialClients.ts:16-23`).
- **A secret is a different object and cannot leak here by construction.** Every
  entry resolves its id from a compile-time public constant and never touches the
  credential store; `PluginOfficialOAuthClient` has no field to put a secret in;
  and `assertNoClientSecret` re-checks the answer on the way out, refusing any key
  whose name contains `secret`, `password` or `token`. Three independent reasons,
  because "we simply never put one there" is the kind of invariant a later edit
  breaks quietly (`pluginOfficialClients.ts:111-121`).
- **Ownership, not a permission.** The caller must be the honoured owner of the
  built-in surface ADE bundles the client for, read from `BUILTIN_SURFACE_OWNERS`
  and never from anything the plugin says about itself. A plugin cannot become the
  Linear plugin by declaring that it is.
- A non-owner and a provider ADE bundles nothing for get the SAME `not_permitted`
  code. They are different facts about the host but the same fact about the
  plugin, and a plugin able to tell them apart could enumerate which providers ADE
  has apps for by asking for each in turn (`pluginOfficialClients.ts:123-139`). A
  build with the constant stripped answers `auth_unavailable` instead, because
  that plugin IS permitted and there is simply nothing to lend.
- The answer carries the scopes ADE's own integration asks for, when the
  registration depends on them. Linear's list is `read, write, admin`, and `admin`
  is not ambition: Linear only delivers data-change webhooks for a workspace whose
  authorization carries it, so a connection made without it has an ingress channel
  that silently never fires. A plugin borrowing the client id is borrowing that
  registration, so it is told which grant the registration expects rather than
  left to guess.
- `resolveClientId` is a function rather than a string, so `ADE_LINEAR_CLIENT_ID`
  is read at call time and a developer can point a build at a test app.
- **A community plugin never calls this.** It registers its own app with the
  provider and declares that app's public id in `authSessions[].clientId`, which
  is why that field exists.

There is nothing here to consent to — the value is already public — so unlike the
credential handoff this raises no card and asks nobody.

### Webhooks arrive through the relay, and only to a plugin that asked

A plugin could always *emit* an automation trigger. Nothing could *receive* a
webhook: the relay's routes, the registered secret, the paged drain and the
replay guard were all spelled "cursor". They are now spelled per plugin.

- A manifest declares `webhookIngress: [{ id, label, description?, verify? }]`
  — max 4 channels, ids lowercase-hyphen because the id is a path segment at the
  relay. `[]` is the value for the overwhelming majority, never `undefined`.
- The relay answers `POST /plugin/:pluginId/register`,
  `POST /plugin/:pluginId/webhook[/:channelId]` and
  `GET /plugin/:pluginId/events` (`apps/webhook-relay/src/relay.ts`, migration
  `0008_plugin_ingress.sql`). Every read and every post is scoped by
  `plugin_id`, so one plugin's secret can never authenticate another's traffic.
  The Cursor Cloud routes stay exactly as they are until Cursor Cloud itself
  moves out to a plugin.
- The host generates a 32-byte secret per plugin, stores it in that plugin's own
  secret namespace under the reserved name `ADE_WEBHOOK_RELAY_SECRET`, and
  registers it. A plugin can neither read, write nor delete that name, and no
  SDK verb, action or status row returns it.
- One drain polls every declared plugin every 45 seconds and elects a single
  owner per plugin across open projects, because the relay stream is per plugin
  while the ledger is per project.
- `verify: { kind: "hmac-sha256", secretRef, header?, prefix? }` checks a THIRD
  party's own signature over the raw body, constant-time, host-side, before
  anything crosses into the child. A channel whose declared secret is missing on
  this machine fails closed and says which secret by name.
- Delivery is at-least-once with an id: the child gets
  `ade.events.on("webhook.received", …)` and calls `ade.webhooks.ack(id)`.
  Unacked deliveries are redelivered on later ticks and abandoned after five,
  because a poison body must not wake a plugin forever. A child that is not
  running is not charged an attempt.
- Only an allowlisted slice of the headers reaches the child, and a body past
  64 KiB arrives clamped with `truncated: true`.
- The ledger **is pruned** — 14 days and 5,000 rows per plugin. The two older
  ingress tables are exempt from retention, and the 2026-07 daemon wedge is what
  an unpruned one costs. Pruning cannot resurrect a delivery here because the
  relay's own retention is shorter than the ledger's.
- `ade.webhooks.url(channelId?)` answers the URL to hand the third party, for a
  declared channel only. `ade.webhooks.status()` is this plugin's row on the
  host's delivery ledger — last received, pending, last drain error — so a
  settings panel can print what actually arrived rather than guessing. The
  Marketplace detail page shows the same URLs with a Copy button, and
  `ade plugin doctor` grows a **Webhooks** rung, because the person setting
  the integration up is usually looking at a plugin that is installed and not
  running.

### A plugin can own a conversation

The largest thing a plugin can be is not a panel — it is the agent on the other
end of a chat. A plugin declares a **chat runtime** in its manifest, binds ADE
chat sessions to it, and from then on the user's turns are delivered to the
plugin and its answers stream back into the transcript. Cursor Cloud is the
plugin this seam was built for: a cloud agent *is* an ADE chat.

```jsonc
"chatRuntimes": [{
  "id": "cloud",                    // sessions store this; renaming orphans them
  "displayName": "Cursor Cloud",    // the name the chat header shows
  "icon": "Cloud",                  // Phosphor name, optional
  "capabilities": {                 // all four are required, no defaults
    "followUp": true,               // the user may send a second turn
    "interrupt": true,              // the user may stop a running turn
    "hydrate": true,                // history from outside ADE can be backfilled
    "artifacts": true               // files land in the lane
  }
}]
```

At most two per plugin. All four capability flags are required, and a missing
one drops the runtime rather than defaulting: defaulting true promises the user
something the plugin never wrote, and defaulting false silently disables what
the author believed they had shipped.

**The session side.** A bound session carries `provider: "plugin"` — one value
for every plugin, never one per plugin — and a `runtimeRef` naming
`{pluginId, runtimeId, externalId}`. `externalId` is the plugin's own name for
the conversation: a cloud agent id, a thread id, a ticket. ADE stores it and
never interprets it. The host also writes a `runtimeLabel` (`displayName`,
`icon`, `pluginDisplayName`) onto the session, because every client needs a name
for the chat and none of them can read another machine's manifests; a session
whose plugin was uninstalled keeps the last label rather than reading as an
unnamed provider.

**Events into the plugin.**

| event | delivery | payload |
| --- | --- | --- |
| `chat.turn` | reliable (`invoke`) — starts a stopped child, rejects visibly | `{sessionId, projectId, runtimeId, externalId, turnId, message, attachments, followUp}` |
| `chat.interrupt` | reliable | `{sessionId, …, turnId}` |
| `chat.opened` / `chat.closed` | droppable queue, subscription-gated | `{sessionId, …, watching}` |

The split matters. `chat.turn` **is** the user's message, and a message the host
quietly dropped is a chat that silently stops answering — so it rides the
request/response frame with a request id, a timeout and a rejection the chat
service turns into a visibly failed turn. Presence is a hint by nature: missing
one costs a poll interval, never a message.

**Presence, not a schedule.** `ade.schedules` is floored at 60 seconds and knows
nothing about who is looking, so it cannot express a poll ladder that runs fast
while the user is reading and stops when they navigate away. `chat.opened` /
`chat.closed` say exactly that, ref-counted across clients: a desktop pane and a
phone on the same conversation produce one signal between them. The plugin owns
its own timer inside the child; the host only says when it matters.

**Writing back.** `ade.chat` on the child:

| method | what it does |
| --- | --- |
| `createSession(input)` | Bind a session. Idempotent on `{runtimeId, externalId}`, or adopts an unowned `sessionId`. |
| `appendAssistant(sessionId, chunk)` | Stream a piece of the reply. Chunks coalesce into one turn; `done: true` closes it. |
| `appendUser(sessionId, input)` | Append a user turn ADE did not originate. Deduped by `fingerprint`, suffix-tolerantly. |
| `emitStatus(sessionId, status)` | `running` \| `idle` \| `failed` \| `finished`. This is what settles the session. |
| `setArtifacts(sessionId, artifacts)` | Proof-artifact card. Pass `contents` (base64) or `sourceUrl` (`https:`) and the host writes the file into `.ade/cache/plugin-artifacts/…`; a path alone still draws the card. See **Fetching an artifact's bytes** below. |
| `attachBranch(sessionId, {branch, remote?})` | Fetch the branch into the lane so the ordinary branch and PR affordances light up. |
| `hydrate(sessionId, transcript, options?)` | Backfill history, oldest first. See **Paging a backfill** below. |

`emitStatus` is not decoration. A plugin that never reports leaves a chat
spinning forever; `idle` and `finished` settle it, and settling is what feeds
ADE's attention ladder and the "waiting on you" treatment. The host closes an
open turn on the child's crash rather than trusting it to.

**Ownership is host-injected, and it is the whole security story.** A plugin can
write words the user will read as an agent's, so the only question that matters
is *which conversation* — and the plugin does not get to answer it. It never
states its own `pluginId`: the host reads it off the child connection that
asked, compares it to the session's `runtimeRef.pluginId`, and refuses on a
mismatch. One function
(`requirePluginChatWriteTarget` in `main/services/chat/pluginChatRuntime.ts`),
one door, every verb but `createSession` through it. The refusal is worded
identically for "no such session", "unowned session", "somebody else's session"
and "no project open", because a caller that could tell them apart could
enumerate the machine's conversations and their owners by probing.

**Fetching an artifact's bytes.** A `sourceUrl` is capped BEFORE it is buffered:
the declared `Content-Length` is refused first, and the body is then read in
chunks against the same cap, because a chunked response declares nothing. The
FINAL hop is re-validated against the rule that admitted the URL, so an allowed
host that redirects to `localhost` is refused rather than fetched. An HTML
content type is refused too — a sign-in page answered with 200 would otherwise
land in the lane as a proof artifact the reader is invited to open. The
destination path is refused when Windows cannot hold it (a device name such as
`nul`, a reserved character, a trailing dot or space), on every platform, because
a lane cache syncs and is read back on another machine.

**Paging a backfill.** `hydrate` takes at most `PLUGIN_CHAT_HYDRATE_MAX_ENTRIES`
(500) per call, and a real cloud conversation can be longer. A plugin sends pages
oldest first — the first with no options, every later one with `{append: true}` —
and each page appends after the last. The host does not re-sort: only the plugin
knows the true order of a conversation it read from somebody else's API.

Each call answers `{accepted, skipped, sweepTotal}`. `accepted === 0 &&
skipped > 0` is the normal result of a re-read after a reconnect and is the
signal to stop paging. `append` is what carries `sweepTotal` forward, which is
what makes `PLUGIN_CHAT_HYDRATE_SWEEP_MAX_ENTRIES` (10,000) a real ceiling
rather than one a plugin escapes by calling again; a call without it starts a
fresh sweep. The sweep ledger is in memory only — a process that restarted
mid-sweep has a plugin that restarted with it and will begin again at its first
page.

**Budgets.** 128 KiB per write (frame size, not a cap on how much a plugin may
ultimately say — stream it), 900 writes per session per minute, 64 parts per
chunk, 50 artifacts per call, 500 hydrate entries per call and 10,000 per sweep.
Every one is charged AFTER the call's arguments validate, so a refused malformed
write costs an error rather than one of the writes the plugin is allowed.

**The `ade:` action namespace is reserved.** `chat.turn` and `chat.interrupt`
reach the child as `invoke` frames named `ade:chat.turn` / `ade:chat.interrupt`,
so the action NAME is the only thing separating the host's delivery from a
plugin's own handlers. Two doors enforce the reservation
(`PLUGIN_RESERVED_ACTION_PREFIX` in `sdk.ts`):

- The **manifest parser** drops any action id, socket `actionId`, CLI word or
  tool name that claims the prefix, with a warning. `manifest.ts` cannot import
  `sdk.ts` (real runtime cycle) so it mirrors the constant, and `manifest.test.ts`
  pins the two together.
- The **host's invoke door** (`domainService.invoke`) refuses a reserved action
  from every caller. This is the one that matters: a published vocabulary node's
  `action` string is runtime data no manifest parser ever sees, so without it a
  node, a schedule or a remote command could hand a child a forged `chat.turn`
  naming any session it chose. The host's own delivery does not pass through
  this door — it calls `supervisor.invoke` directly — so closing it costs
  nothing.

The whole prefix is reserved rather than the two names in use today, so a later
reserved verb cannot be squatted before it ships.

**Limits today.** A plugin-owned chat can be handed *off* — the transcript
replays into an ADE runtime like any other source — but nothing can be handed
*into* one: binding a session to a plugin runtime is the plugin's own act,
because only the plugin knows the external conversation the new session would
point at. Native (thread-copying) fork is not available for one; a fork is
always the ADE-side transcript replay.

### A plugin can link an issue to a lane

ADE's lane and session issue links used to be Linear-shaped fields on ADE's own
types, which meant a tracker plugin could keep its own lane-to-issue map in a
collection but could not make the PR body writer, the branch namer or the
deeplink envelope read it. `apps/desktop/src/shared/issueRef.ts` is the
provider-neutral shape those readers take instead.

An `IssueRef` is `{pluginId, provider, issueId, key, title, url, state?,
container?, branchName?, assignee?, priority?, labels?, description?,
createdAt?, updatedAt?, extra?}`. `provider` is the tracker vocabulary
(`linear`, `github`, `jira`, …), `key` is that tracker's human key (`ADE-123`,
`owner/repo#42`), `container` is the group it belongs to (a Linear team, a
GitHub repo, a Jira project), and `state.category` is one of `triage |
backlog | unstarted | started | completed | canceled` — Linear's `stateType`
vocabulary, reused because it is the widest of the trackers ADE reads. `extra`
is tracker-specific residue that core stores and never interprets.

`ade.lanes` on the child:

| method | what it does |
| --- | --- |
| `list()` | Every non-archived lane in the project this plugin is bound to, as `PluginLaneSummary` |
| `get(laneId)` | One of them, or null |
| `listSessionIssues(laneId)` | The issues linked to the SESSIONS inside one lane, grouped by session |
| `linkIssue(input)` | Link an issue to a lane or a session. Answers the created `IssueLink` |
| `unlinkIssue(input)` | Remove a link **this plugin created**. `false` when there was none |

`listSessionIssues` is the half of the picture a lane summary cannot carry. A
summary's `primaryIssue` and `issueLinks` are both LANE-scoped, and an issue a
person attached to a single chat inside the lane lives in a different table and
appears in neither — so a plugin reproducing ADE's "the merged PR moves its issues
to Done" rule off a lane summary alone silently skips exactly those issues. Core
does not skip them: it unions the lane's links with
`listLinearIssuesForLaneSessions`, and this verb is that second half, made
generic. It answers `{sessionId, issueLinks}` per session and returns the LINKS
rather than bare refs, because `closeOnMerge` is the flag core filters session
links on and it lives on the link (`sdk.ts:1229-1255`). Union it with the lane's
own two fields, deduped by `provider:issueId`, to see what ADE's own rule sees. A
lane with no session links and a lane this project does not have both answer an
empty array: a plugin acting on a merged PR should not have to tell them apart.

`PluginLaneSummary` is a fixed allowlist (`PLUGIN_LANE_SUMMARY_FIELDS` in
`sdk.ts`), not `LaneSummary` with fields deleted: `worktreePath`,
`attachedRootPath` and `devicesOpen` are an absolute path into the user's
filesystem and a roster of the machines they have the lane open on, and a
plugin that asked which lanes exist has no business learning either. The
allowlist is what stays correct when a field is added to `LaneSummary` later. It
does carry `primaryIssue: IssueRef | null` and `issueLinks: IssueLink[]`.

**Ownership is host-stamped, the same way chat ownership is.**
`PluginIssueRefInput` is `Omit<IssueRef, "pluginId">` — there is no field for a
plugin to fill — and the host writes the id of the child connection that asked
(`readPluginIssueRef`, an overwrite rather than a default). `source` is set by
the host to `plugin_link` and is likewise unspellable, so a link a plugin made
cannot claim the user made it. `unlinkIssue` then checks that stamp: another
plugin's link is `not_permitted` with a sentence naming the owner, and a link
ADE made itself carries the `core` owner and refuses every plugin. The user can
still unlink anything from the lane UI, the CLI or the TUI — the restriction is
on plugins undoing each other, not on the person.

For the same reason, `lane.linkLinearIssues` and `lane.unlinkLinearIssues` are
**refused** for a plugin reaching them through `ade.actions.invoke`
(`apps/ade-cli/src/bootstrap.ts:673`): those verbs write the lane's issue rows
with no record of who asked, so a link a plugin made would be indistinguishable
from one the user made, uninstalling the plugin would leave it behind, and any
plugin could unlink any other's. The refusal names the replacement. Both verbs
stay open to the user.

Rules on the call itself: exactly one of `laneId` and `sessionId` (both, or
neither, is `invalid_args`); `role` defaults to `referenced` and must be one of
`primary | worked | referenced | inferred`; `includeInPr` and `closeOnMerge`
are optional and an absent flag reaches the store as absent so the store's
default applies. A ref missing a non-empty `provider`, `issueId`, `key` or
`title` is refused whole rather than repaired — nothing downstream could
display or reference it. A host with no project bound answers
`unsupported_method`, not an empty list.

**Where it is stored, and why it is not a column.** `issueRef.ts:42` states the
rule as a warning to whoever reads it next:

> DO NOT "FIX" THIS INTO A COLUMN OR A TABLE. It looks like schema hiding in a
> TEXT column, and it is, deliberately.

The reason is the sync layer, and all three options were weighed. A NEW TABLE is
the worst of them: a peer on an older build has no such table, `applyChanges` in
`kvDb.ts` throws `unknown_sync_table`, and it rolls the WHOLE batch back inside
one `BEGIN IMMEDIATE` — that peer's replication then stops permanently, for every
table at once. The plugin tables were only shippable because they added a
hello-capability gate to go with them, and there is no such gate here. A NEW
COLUMN is supported, but no peer exchanges a schema version and nothing filters an
unknown column out of an inbound changeset, so it would work only if every peer
upgraded first — which is not a property this system has. An unknown JSON KEY is
inert on every build that does not know it. So:

The `IssueRef` rides inside
the EXISTING `issue_json` column of `lane_linear_issues`,
`lane_linear_issue_links`, `session_linear_issues` and
`session_github_issues`, under the reserved key `__issueRef`, beside a full
legacy Linear projection of itself. No new column, no new table, no migration
and no backfill. This is the same rule the plugin tables state for themselves
in [Storage](#storage-four-tables-frozen-shapes) — version inside the JSON,
never in SQL — applied to tables that already existed, and it is written up as
[Rule 4 of the CRDT model](../sync-and-multi-device/crdt-model.md). A peer on an
older build parses the legacy projection and drops the unknown key, so a Jira
issue renders there with the right key, title, URL and state name under a
Linear-labelled badge: a mislabel, not a break. The one lossy window is an
older build re-linking an issue, which rewrites the column without the key; the
next link from a new build restores it. The `issue_id` COLUMN is namespaced as
`<provider>:<issueId>` for every tracker except `linear`, which keeps the bare
id so existing rows and older peers are untouched.

**What reads it today.** `laneService.listIssueLinks / linkIssueRef /
unlinkIssueRef` are the store; `LaneSummary.primaryIssue` and
`LaneSummary.issueLinks` are derived on every `list`/`get` and are never
emptier than the legacy fields, which stay populated beside them.
`prService.collectLanePrIssueRefs` collects the PR's issues through the generic
shape, and `shared/issueRefFormat.ts` derives the lane name, the branch name and
the PR magic word from a ref. A deeplink can name an issue on any tracker:
`ade://issue/<provider>/<issue-key>[?branch=&plugin=]`, with
`ade link issue <provider> <key>` minting it and the portable envelope carrying
`?issueProvider=` + `?issueKey=` beside the existing `?linear=`.

Two limits worth knowing before you build on it, both listed under
[Accepted v1 limitations](#accepted-v1-limitations): the PR body still renders
Linear references only, and `issueRefPrReference` emits a closing magic word
only for `github` and `linear`.

### A change event says what a pull request did

`ade.events.on("lane.changed" | "pr.changed" | "session.changed", …)` was typed,
validated, accepted by the host and emitted by nothing: only `install.changed`
had a producer. A plugin that copied the skill's own "row badges from CI" recipe
registered a listener, got no error, and never heard anything
(`pluginEntityChanges.ts:4-12`). The three producers now live in the daemon
(`apps/ade-cli/src/bootstrap.ts:1178`, `:1195`, `:1803-1824`, `:2108`, `:2205`)
and publish on a module-level bus, so a lane write path carries no plugin
dependency and a process with no host attached pays one set-size read.

The bus's invariants are **identity and lifecycle position, never content** —
entity ids, the checkout, and where an id moved from and to. No titles, no branch
names, no diff, no message text. Emission is fire-and-forget, returns void,
swallows every listener failure and does no I/O, because every call site is inside
a write a user is waiting on.

`pr.changed` carries the one narrowing: an optional `transitions` array of
`PluginPrTransition` (`sdk.ts:669-675`).

```jsonc
{ "id": "<pr id>",
  "from": { "state": "open",   "merged": false },
  "to":   { "state": "merged", "merged": true } }
```

Two fields rather than one, because `state` is the provider's vocabulary and
`merged` is the question every consumer actually asks — a plugin that only wants
"did this just merge" compares `from.merged` with `to.merged` and never learns
which spelling of `closed` a merge leaves behind.

- **Only the daemon's PR poller produces it**, because `previousState` exists in
  that one handler and nowhere else, and it is the same value ADE's own merge
  handling compares against (`bootstrap.ts:2187-2211`). Re-deriving it by reading
  each PR back is racy in both directions: a PR merged and reverted inside one
  coalesce window reads as never-merged, and a plugin that lost its memory to a
  restart treats every open PR as newly transitioned.
- **A change with no known `previousState` is DROPPED**, never reported with its
  current state as the `from`. The first tick after a restart and the tick that
  discovers a PR both have no history, and a transition reading `merged → merged`
  would say "it did not move" and suppress exactly the merge a plugin is waiting
  for (`pluginEntityChanges.ts:117-121`).
- **It is never present alongside `overflow`.** An overflowed delivery already
  means "re-read the family"; a transition list covering only the ids that fitted
  would be the one shape a reader could mistake for complete
  (`pluginHostService.ts:2441-2449`).
- Coalescing keeps the FIRST-seen `from` and the latest `to`, so a PR that moved
  twice inside one window reports the whole journey rather than only its last
  step.
- The field is optional and additive: a plugin compiled against the older payload
  keeps working, and a plugin written for this one still has to handle its
  absence. Absence always means the same thing — read the entities named in
  `ids`.

### A plugin can set up the session it launches

ADE's compiled Linear integration injects `ADE_LINEAR_ISSUE_IDS` and
`ADE_LINEAR_CONTEXT_FILE` into any agent session launched from an issue, plus a
per-session context file the agent reads with no Linear credentials. That reach is
what makes the built-in feel native. `sessionSetup` is the same reach, generalized:
`chat.createSession` and `chat.launchCli` both take
`{env?, contextFile?}`, and the host validates, writes and injects them.

```jsonc
"sessionSetup": {
  "env": { "ADE_PLUGIN_JIRA_ISSUE_KEYS": "PROJ-9,PROJ-14" },
  "contextFile": { "name": "issue.md", "content": "…" }
}
```

**One fixed `ADE_PLUGIN_` prefix, not a per-plugin namespace.** A namespace
derived from an id the CALLER supplies is a suggestion rather than a namespace:
the seam a plugin reaches this through (`actions.invoke`) is a deliberate
pass-through that carries no plugin identity into the action layer, so plugin A
would be free to claim `ADE_PLUGIN_JIRA_*`. The prefix is also what makes
shadowing impossible rather than merely unlikely — no variable the host sets on a
launched agent (`PATH`, `HOME`, `ADE_LANE_ID`, `ADE_CHAT_SESSION_ID`,
`ANTHROPIC_*`, `OPENAI_*`) begins with it. A plugin that wants its own name in the
variable puts it in the SUFFIX, which is documentation and not enforcement
(`sessionSetup.ts:12-32`).

Three more classes are refused: `RESERVED_PLUGIN_SESSION_ENV_KEYS`, the
`ADE_PLUGIN_*` names the host itself owns, listed statically so a plugin cannot
win a race by claiming one on a machine where the host happens not to set it; any
key already present in the host env the caller passes in, so a host variable added
later is covered without editing that list; and any value carrying a NUL byte.
Keys are compared upper-cased, because a Windows environment block is
case-insensitive and a validator matching only the exact spelling would leave a
shadowing hole on one platform.

Caps: `MAX_PLUGIN_SESSION_ENV_KEYS` 16, `MAX_PLUGIN_SESSION_ENV_VALUE_BYTES` 4
KiB, `MAX_PLUGIN_SESSION_CONTEXT_FILE_BYTES` 256 KiB. The context file is ONE
file with a single-segment name (no separators, no dot-files), written inside the
session's own directory, resolved and re-checked for containment even though the
name is already validated. Its path reaches the agent as
`ADE_PLUGIN_CONTEXT_FILE`. A request that breaks a key policy or a cap THROWS and
the launch is refused, rather than starting an agent with half of what the plugin
asked for.

**`ADE_PLUGIN_SOURCE_ID` is unforgeable.** It names the plugin whose setup
produced the environment, and inside a launched agent it is exactly the kind of
label a reader trusts. Three untrusted callers reach these two verbs — an agent
through `run_ade_action`, an automation step, and a plugin child through
`sdk.actions.invoke` — and all three hand the host plain JSON. So the owning
plugin id does not travel in that JSON. It rides on a module-private Symbol
stamped by the one bridge that knows which plugin is calling: the daemon's
`invokeAdeAction`, whose `pluginId` comes from the supervisor that owns the child
socket. A Symbol survives an in-process call and cannot survive `JSON.parse`,
which is the boundary the untrusted callers sit on
(`pluginSessionSetupProvenance.ts:1-24`, stamped at `bootstrap.ts:575-594`). A
call with no stamp is not refused — an agent may legitimately set `ADE_PLUGIN_*`
variables of its own — it simply gets no `ADE_PLUGIN_SOURCE_ID`, because the host
has nobody to name.

The sidecar is re-validated on every read, so a session resumed after someone
edited the file on disk cannot introduce a key the live policy would refuse
(`pluginSessionSetupStore.ts:138-150`).

### A plugin's own links become chips

A tracker plugin's URLs should read like ADE's own. `urlMatchers` is what a
manifest declares so they do, and it is DATA: matching involves no callback into
the plugin, no child process and no network. A matcher produces exactly three
things — a chip label rendered from a bounded template over its own captures, a
deeplink into a panel the plugin already publishes, and, when it declares one, an
issue reference whose provider is fixed by the declaration
(`urlMatchers.ts:17-26`).

```jsonc
{ "id": "issue",
  "hosts": ["linear.app"],
  "pathPattern": "/{workspace}/issue/{key}/**",
  "chip": { "label": "{key}", "icon": "L" },
  "panelId": "issue",
  "entity": { "kind": "issue", "provider": "linear", "keyFrom": "key" } }
```

**`pathPattern` is not a regular expression**, and that is the whole point: a
plugin that could ship a regex could ship a catastrophically backtracking one, and
it would run on the main thread on every keystroke in the composer. The grammar
has no alternation, no quantifiers and no character classes — a literal segment, a
`{name}` capture of exactly one non-empty segment, a `*` that matches one segment
and captures nothing, and a trailing `**` that matches the rest and may only be
last, which is what makes a tracker's slug optional. Literals are escaped
character by character on the way into the compiled regex, so `.` and `+` are a
dot and a plus. Capture names are never written into the regex source: groups are
numbered, so a name cannot be `constructor`, cannot collide with another matcher's
group, and cannot smuggle regex syntax.

**A chip icon may be a monogram or a `brand:<id>` token the plugin ships.** The
token is validated with the `ade.brandIcons` id rule, so a token a manifest may
declare is exactly a token that collection can hold, and it resolves to the
host-sanitized glyph the plugin shipped. It never renders as text: a token with
no shipped artwork falls back to the provider's own mark rather than printing
`brand:linear` in the chip.

Ceilings, all in `urlMatchers.ts`: 8 matchers per plugin, 4 hosts per matcher, a
200-character pattern, 12 segments, 6 captures, a 64-character label template, 48
characters per substituted capture, an 80-character rendered label, and a
2-code-point glyph. Every invisible and bidi code point is stripped from a
rendered value, written as numeric ranges rather than as literal characters
because a source file that spells them literally cannot be reviewed, diffed or
grepped — a right-to-left override inside a captured value does not corrupt the
chip, it reorders the sentence around it.

**Core's hosts are refused by name.** `github.com` and `linear.app` are in
`CORE_SMART_LINK_HOSTS`, because a plugin claiming one would draw its own chip
over ADE's links on machines where the user never installed a tracker plugin at
all — a chip is drawn from the URL alone. The refusal names the owner, so an
author reads who has it rather than shipping a matcher that silently never wins.

**The one relaxation is keyed on OWNERSHIP.** `ade-linear` gates the compiled
Linear pane, holds the Linear credential through the handoff, and is the package
the tracker moves into; refusing it `linear.app` would mean the plugin can never
carry the chip core draws today, so the extraction could never finish. Three
things keep the relaxation narrow: only an EXACT host is relaxed (a wildcard stays
refused for everyone, including the owner, because `*.linear.app` claims names
core never parsed); only an official package can reach it at all; and WHICH
package owns a surface is answered by `coreSmartLinkBuiltinsOwnedBy`, a
hand-mirror of `BUILTIN_SURFACE_OWNERS` pinned by `builtinSurfaces.test.ts`.

That last point is a repair, not a design flourish. The relaxation used to key on
the honoured `surfaces[].builtin` field, and that stopped working the day `linear`
became a SUPERSEDED surface: a plugin that supersedes may not name the surface
with `builtin` at all, so `ade-linear` claimed nothing and lost its own domain.
Ownership is the fact the relaxation always meant, and ownership survives both
polarities (`urlMatchers.ts:136-156`). `github.com` is deliberately absent from
the relaxation table: there is no gateable `github` built-in surface, so no plugin
can ever claim it. `CORE_ISSUE_PROVIDERS` (`linear`, `github`, `core`) is likewise
closed to a matcher's `entity.provider`.

**Ownership of a tracker is derived from the same declarations.** A plugin that
can recognise a tracker's URLs is a plugin that can draw that tracker's issues, so
`issueProviderOwnersFromMatchers` reads `ade://issue/<provider>/<key>` routing off
`urlMatchers` rather than asking for a second declaration the two answers could
disagree on (`usePluginRegistry.ts:268-280`).

Within the plugin tier the FIRST match wins, over matchers sorted by plugin id and
then by declaration order — sorted rather than left in registry order, because
registry order is install order and a chip that reads differently on a laptop than
on a desktop is a bug nobody can reproduce. Core's tier runs ahead of the plugin
tier. A matcher that no longer compiles is dropped silently inside the render
rather than throwing: the manifest parser already refused it with a reason `ade
plugin doctor` prints, and refusing it twice would turn a bad manifest into a
blank composer.

**iOS draws no plugin chip.** The phone's smart-link detector is a hardcoded
four-provider host test (`WorkComposerTypedTriggers.swift:26-31`, `:106-116`), so
a plugin-declared URL renders as a plain web link with no chip and no attribution.
The root cause is the data path rather than the taxonomy: manifests never
replicate to a phone, and no `plugins.*` command hands one over, so a phone sees a
contribution exactly when the plugin PUBLISHED it and a manifest-only declaration
is invisible there by construction (`PluginRecords.swift:297-303`). It is listed
under [Accepted v1 limitations](#accepted-v1-limitations).

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

**A full collection must never stall a plugin.** `collections.put` takes an
opt-in fourth argument — `put(collection, key, value, {ifFull: "evictOldest"})` —
that turns a budget refusal into a self-healing write: the writer deletes the
oldest rows (`updated_at` ascending, then `key`) of the **same** collection
until the value fits, then writes it, all inside the one transaction, so a crash
cannot leave a plugin having paid the deletes without gaining the write. It
never crosses into another collection or another plugin, never evicts the key
being written, and stops after
`PLUGIN_COLLECTION_MAX_EVICTIONS_PER_PUT` (200) rows — past that, or when the
bytes in the way belong to another collection, the original
`plugin_budget_exceeded` is thrown and the evictions roll back with it. The
per-value 64 KiB cap is checked first and eviction can never rescue it.

Omitting the option, or passing `{ifFull: "fail"}`, is the historical behavior
exactly, down to the wire bytes: the child sends no `options` key at all, so an
older host sees the frame it has always seen. An `ifFull` the host does not
recognize is refused with `invalid_args` rather than read as the default — a
plugin with a typo would otherwise look correct until the day its collection
filled. Which mode a collection wants is the plugin's call: a cache of rendered
rows should evict, a collection of the user's own saved items should refuse,
because dropping the oldest one would be data loss nobody asked for.

### The vocabulary contract

**The vocabulary is FROZEN at v1**, by the owner decision recorded in
`docs/reports/plugin-page-tier-spec.md`. What changed on 2026-09-03 is its
standing, not its shape: it is no longer the tier a plugin designs for, it is
what a client draws when it cannot draw the page — see
[The page tier](#the-page-tier). Frozen is not deleted. Every component below
still parses identically on every client, every panel a plugin already published
still renders, and the terminal draws the subset named in
[the terminal profile](#client-entry-points). Deletion waits until no official
plugin needs the vocabulary at all.

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

A `list` item is deliberately richer than the nodes it would take to build one.
Beside `title`, `subtitle`, `meta`, `tone`, `icon` and `onPress`, a row carries a
`badge` chip, a `mono` line for a value meant to be compared against the row
above it, up to three trailing `actions` and up to six more in `overflow`. Each
action is a `VocabAction` plus a required `label`, `kind` and `icon`. The reason
is the node budget: a row hand-assembled out of `stack`, `badge`, `text` and
`button` nodes cost about seven nodes, so `maxNodes: 200` capped a panel near 27
rows. A list is one node however rich its rows are, which makes `maxListItems`
(1000, for bound rows) the ceiling that actually applies — of which a client draws
`listPageSize` (100) at a time. The caps on `actions` and `overflow`
count what survived parsing rather than what was offered, so a refused entry does
not spend a slot a valid one needed — and every client counts the same way.
Desktop, web and iOS draw the overflow behind a menu; the TUI draws `actions` and
`overflow` as one numbered key list, because a terminal has no menu and showing
what a row can do beats hiding half of it.

A row may also declare `preview: { title?, text? }`. Desktop and web show it as a
hover card; iOS shows it as a context-menu preview; the TUI has no hover and
omits it. It is row data, not a body node, so a bound collection can ship it
the same way it ships `subtitle`.

A bound row acts only through the binding's `allowActions`, an explicit list of
the action ids a row from that collection may name. The rule it protects is that
a panel author chose every action a reader can press: stored data that could mint
an action freely would put a button in front of the reader the panel never
declared. With the allowlist the author still chooses the set, and the data
chooses only which member of it a given row offers. A row naming an id outside
the list renders and is not pressable, and a binding with no allowlist yields no
row actions at all. `boundRowAction` in `vocabularyNodes.ts` is the one
implementation; iOS mirrors it in `PluginPanelParser.boundRowAction`, because the
phone once accepted every action a row named while the other three clients
accepted none. The gate applies to `onPress`, `actions` and `overflow` alike: a
collection that could reach an undeclared action through a trailing button would
have made `onPress` the only door anybody guarded.

A `confirm` on an action is honoured on every client and by every control. On
desktop and web that is structural: `useVocabActionRunner` in
`vocabularyComponents.tsx` is the only path from a control to `dispatch`, so a
list row cannot skip the prompt a button asks. iOS holds the same shape in
`PluginPaneStore.perform`.

**A `canvas` is a named host engine, not a drawing surface.** `{ component:
"canvas", engine: "git-dag" | "swimlane" | "graph" | "workspace" |
"electron-control" | "simulator", bind }` is
data: the plugin writes render-ready rows (and, for `graph`, an `edges`
binding) and the host picks an engine ADE already owns. There is no script
payload and no SVG the plugin authored. Desktop draws the git commit DAG, a
lane swimlane, a small node-link graph, or one of the compiled ADE panes —
the workspace Graph page (`workspace`), Electron Control (`electron-control`)
and the iOS Simulator (`simulator`); iOS and the terminal draw the same bound
rows as a list. A canvas `onSelect` fires when a node has no row `onPress`,
with `id` taken from the row's key. Bound row actions still go through
`allowActions`.

**The last three engines are owned.** `workspace`, `electron-control` and
`simulator` mount a compiled ADE pane that reads the HOST's own state — the
workspace topology, a Chrome DevTools session, a booted simulator — and none of
that is the plugin's data. So desktop draws one only for the plugin registered
in `PLUGIN_BUILTIN_SURFACE_OWNER_IDS`, the same table that decides which plugin
supersedes which compiled surface; every other plugin gets the bound rows as a
list, which is what the phone and the terminal draw anyway. The check lives at
the mount (`canMountHostCanvasEngine` in `vocabularyCanvas.tsx`) rather than in
the parser: the parser is shared with clients that have no compiled pane to
protect and is handed a schema with no plugin id, so a check there would read a
field a plugin can write.

**A canvas row presses through `useVocabActionRunner`**, the same path a list
row and a button use, so `confirm` is asked and a refused dispatch draws a line
under the canvas. A canvas used to call `dispatch` itself, which skipped the
prompt a button asks and turned a refusal into an unhandled rejection.

**A canvas pages** through `vocabularyPaging.ts` on the list's contract, keyed
on the binding, so a reader who paged a canvas does not go back to page one in
the list it falls back to. Desktop and the TUI both page. Graph edges are not
paged with the nodes: only edges whose ends are both drawn are painted, and
dropping edges by page would draw a graph with lines missing.

**A host-engine canvas does not mount while its panel is hidden** (`context.active`),
because both panes stream. It binds the project's runtime pin, so a remote
checkout does not report this machine's state; with no project open it draws a
reason instead of guessing a machine.

**Paging a list, and saying so.** A plugin list used to stop dead at 100 rows
while the built-in it replaced paged to 500, and it stopped SILENTLY — the reader
saw a complete-looking list that was not one. `vocabularyPaging.ts` fixes both
halves, in one place, so four clients cannot disagree: a list draws
`listPageSize` (100) rows and adds another page each time the reader scrolls
(desktop, web, iOS) or presses **Show more** (every client, including the TUI),
up to `maxListItems` (1000). The TUI never auto-loads: including the last row
in the pane window would dump every page. Bound rows live in
`plugin_collections` and never touch `maxSchemaBytes`; an inline list of 1000
plain rows would be ~82 KiB and the writer refuses the panel.

The sentence above the control follows what is actually KNOWABLE, and there are
three readings (`vocabularyPaging.ts:109-126`):

| what the client holds | the label |
|---|---|
| 143 rows, drawing 100 | `Showing 100 of 143` |
| 1000 rows — as many as it may — drawing 100 | `Showing 100` |
| 1000 rows, all drawn | `Showing the first 1000` |
| fewer than it may, all drawn | nothing to say |

The middle reading is the honest one: there is no count read in the host's data
store — `listCollection` returns rows and nothing else — so a total there would be
a guess dressed as a fact. The last reading is what stopped a truncated list from
looking complete.

The page count is CLIENT-LOCAL. It never enters panel state, never reaches a
`where`, never signs, and never rides on an action payload: how far down a list a
reader has walked is a statement about their screen, not about which rows the
panel is showing. A list is identified by what it READS (`vocabListKey`) — its
binding, else its selection key, else its first row — never by its position, so a
plugin republishing its panel with one more node above the list has not put the
reader back on page one. **Filter first, page second**: a binding's `where` has
already run by the time paging is called, so pressing Show more on a filtered list
cannot hand the reader rows the filter rejected.

`VOCAB_PANEL_READ_LIMIT` equals `maxListItems` on purpose. A client that drew up
to the ceiling but fetched fewer would page into rows it did not have and stop
early with no way to say why.

A `segmented` strip of pills scrolls horizontally on desktop, web, and iOS
instead of wrapping. Past the strip ceiling it is still a menu. The TUI keeps
numbered pills on one line.

### Folding a section: the `group` node

A `group` is a `stack` with a disclosure triangle, and deliberately nothing more.
It exists because the shape every issue browser has — seven state groups in a
fixed rank order — used to cost seven `segmented` controls whose only job was to
hide one section each: seven state keys against a ceiling of eight, and a filter
strip nobody would want to look at.

**Open or closed is client-local and is not panel state.** It never enters a state
declaration, never signs, never reaches a `where`, and never rides on an action.
Collapsing a section is a statement about the reader's screen, not about which
rows the panel is showing, and a `where` that could read it would make the two
indistinguishable. That is also what keeps a group FREE: a panel may hold as many
as its node budget allows without spending a state key on any of them
(`vocabularyNodes.ts:287-301`).

Its identity across a re-publish is the declared `groupKey`, falling back to the
title, and never the node's position — a plugin republishing its rows every few
seconds must not re-open a section the reader just closed, which is exactly what a
key of `body[2]` would do (`vocabularyNodes.ts:761-771`). `defaultOpen` is
optional and absent means open: a section nobody has touched shows its contents.
A group may also name an `icon` token — the same catalogue a badge or a button
uses — drawn beside the title on every client.

### Panel chrome: search, nav actions, sticky footer

Panel chrome is **not a body node**. `chrome.search`, `chrome.navActions` and
`chrome.footer` sit outside the scrolling body: a nav-bar search field, up to
four trailing nav verbs, and up to four sticky footer nodes. Desktop and web pin
them above and below the scroll; iOS uses `.searchable`, trailing toolbar items,
and a bottom `safeAreaInset`; the TUI pins the search and nav rows at the top of
the pane and reserves the last rows for the footer.

`chrome.search` owns a `stateKey` whose value is free text, not a closed option
list. The signature signs the control (key + placeholder), never the typed
query, so typing does not reset the field on a republish. A `where` `contains`
clause reading that key re-filters locally on every change; an optional
`onChange` action fires on commit (Enter or blur), not per keystroke. Empty
query is inactive, the same three-valued reading an "All" option already has.
Malformed chrome pieces warn and drop; a footer that blows the node or depth
ceiling is still panel-fatal.

### Prose: the `markdown` node

A plugin that shows an issue body or a comment thread needs prose with structure,
and `text` cannot carry it — `text` is one string with one variant and it renders
literally on every client. The `markdown` node is the smallest thing that fixes
that without handing a plugin a document format.

**It is an AST, not sanitized source.** The obvious shape was "strip the dangerous
parts and hand the string to each client's markdown renderer". That defines the
subset three times, in three grammars, and the subset is then whatever those three
happen to agree on — and they do not: `remark-gfm` autolinks bare URLs and draws
tables, Apple's parser does neither, and a terminal has no concept of either. One
schema would have rendered a table on desktop and a row of pipes on a phone. So
the subset is defined once, in `vocabularyMarkdown.ts`, as a bounded tree of
blocks and inline runs. Every TypeScript client calls the same
`parseVocabMarkdown`; iOS mirrors it arm for arm in
`PluginVocabularyMarkdown.swift`.

Blocks are `heading`, `paragraph`, fenced `code`, `quote`, `list` (ordered or not,
with inert task checkboxes), `rule`, and GFM pipe `table`. Inline runs carry
flat boolean flags — `bold`, `italic`, `strike`, `code`, `href`, `src` — rather
than nesting, so a phone builds one `AttributedString` (and `AsyncImage` for a
run with `src`), a terminal sets Ink's props and desktop nests `<strong><em>`,
all three reading the same list.

**There is no HTML path to disable.** The parser never produces markup: it
produces text runs with boolean flags, so `<script>alert(1)</script>` in a source
document is a `text` run whose content is that string, and React, SwiftUI's `Text`
and Ink all escape it. There is no raw-HTML pass-through, no sanitizer schema to
keep in step with a renderer, and no client that can opt out. That is deliberately
stronger than an allowlist: an allowlist is a list someone has to maintain, and
this is a shape that cannot express the attack
(`vocabularyMarkdown.ts:27-41`). Links and markdown images are the two reaches
outside the document and pass the same `https:`-only gate the `openUrl` action
verb passes; a `javascript:` or `data:` destination loses the link (or the
picture) and keeps its text. A markdown image a client's policy refuses — the
desktop renderer's `img-src` is a scoped allowlist with no blanket `https:` —
degrades to the alt text as a link that opens the picture outside ADE. The same
code runs on both clients, so neither draws a broken frame and neither drops the
picture silently.

Deliberately out of the subset: raw HTML, bare-URL autolinking (three clients,
three URL-detection regexes, three answers about where a URL ends — write
`[text](url)`), `data:` images (those still belong on the `image` node, which
has a source ceiling), and setext headings and indented code, both of which
people produce by accident.

A list row may carry a `markdown` field, parsed with the same subset, clamped to
`maxListItemMarkdownChars` (4,000). It is row data, not a body node, so a
comment thread of rows does not spend `maxNodes` per comment.

`VOCAB_MARKDOWN_LIMITS`: 16,000 source characters (four Linear-sized issue
bodies, a quarter of the 65,536-byte panel; `text` stays at 4,000 because it is
still a paragraph), 100 blocks, container depth 3, 200 runs per block, a link
or image destination capped at `PLUGIN_URL_MAX_CHARS`, a 32-character fence
info string, 8 table columns and 40 table body rows. Over the character cap the
source is cut at the last complete line in the window and **still formatted as
markdown**, on every client, with a line saying the rest is not shown. A
document stopped by the block budget reports `truncated` the same way.

### Client-evaluated panel state

One control and one clause let a panel filter its own rows without asking the
plugin anything. A **`segmented`** node owns a named piece of client state — a
closed option list, a default, and a `stateKey` other nodes name — and a
binding's **`where`** keeps the rows whose fields match it, read either against a
literal or against the current value of that key. Changing the control
re-renders from rows already in memory: no IPC, no fetch, no round trip.

It exists because the alternative was a `form`, a submit button, a
`panels.update()` from the plugin child and a refetch — three taps and a round
trip per filter change, with the selection surviving the re-render only if the
plugin baked it back into `field.value`. A fleet list is unusable that way.

The reverse pressure produced `form`'s **`applyOnChange`**. `submit` used to be
required, so a settings section that had to take effect with no Apply button was
not expressible as a form at all, and the only way to build one was out of
`segmented` controls — which cost the field labels, the help text and the
validation a form carries, and spelled a boolean as `"on"`/`"off"`.
`applyOnChange` is an action beside `submit`, dispatched on every committed edit
with the same full values map a submit sends; a form declaring it needs no
`submit` and draws no button when it has none. "Committed" means the change
itself for a `toggle` or `select`, and blur or Enter for a typed field, so a
plugin is not invoked once per keystroke. A form declaring neither is refused at
parse and degrades to a marker, on all four clients.

Rule 3 ("data, never code") is intact. A predicate is a fixed grammar of five
comparisons (`equals`, `notEquals`, `in`, `notIn`, `contains`) over three composers (`and`,
`or`, `not`), with no functions, no regular expressions, no arithmetic, no
field-to-field comparison and no reach beyond the row it was handed and the state
the panel declared. `contains` is a case-insensitive substring; an empty needle
is inactive. The plugin still computes on its own machine — it
materializes `statusGroup`, `laneId` and `archived` onto each row — and the
client still only compares strings.

**Three-valued evaluation is the load-bearing rule.** A comparison whose state
key is unset — the "All" option, written as an option with an empty `value` — or
whose key no control declares, is *inactive* rather than false. An inactive
clause is removed from its enclosing `and`/`or`, a `not` of one is itself
inactive, and a `where` with nothing active keeps every row. That is what lets a
closed option list express "turn this filter off" without a second primitive, and
it is why a typo'd state key shows everything instead of hiding everything.
Rejection is node-local for the same reason: a clause the parser cannot read
disappears with a warning and the binding keeps the rest, because a reader can
see that a filter did nothing but cannot see rows a broken filter removed.

**Filter before cap, everywhere.** `boundRowValues` filters and then applies the
binding's `limit`, and `distinctBindings` drops the *fetch* limit for a
collection any node filters. A binding's `limit` caps what a node draws; a fleet
of 300 fetched at `limit: 100` and then filtered would report "4 failed" when
there are eleven. iOS applies the same order in `PluginPaneStore.entries`, which
also strips `limit` from the fetch when the binding carries a `where`.

**`$state` is the second reserved collection**, beside `$context` and for the
same reason: the leading `$` is illegal in a real collection name, so nothing can
shadow it. Binding to it yields one row per declared key. For a `segmented`
control the value is the *selected option's label* rather than its raw value —
"Showing: Active", not "Showing: FINISHED_WITH_ERROR". For a `chrome.search`
field the value is the typed string. It is the only way a schema with no interpolation
in it can name the reader's own choice. `vocabReservedRows` resolves both
reserved collections in one place so a client cannot support one and quietly not
support the other; `$state` is filled at render rather than at fetch, because
tying it to a read would put the round trip back into the gesture.

**The lifecycle is per-panel, per-viewer and session-only.** It never reaches
sqlite and never syncs. `vocabStateSignature` is the identity of the CONTROLS,
not of the data: a plugin refreshing its rows republishes the whole panel every
few seconds, and a filter that reset on each of those would be unusable, so an
unchanged signature carries the selection through. When the controls do change,
`vocabNormalizePanelState` does the fine reconciliation — a key the new schema
does not declare is dropped, a value the control no longer offers falls back to
that control's default. Both halves are needed: the signature catches a control
that vanished, the normalize catches a value inside one that did not. Moving to
another panel clears the state outright.

**The plugin is told, when it needs to be.** Every action invoked from a panel
carries the selections under `state` beside `context` (`vocabStatePayload`), so a
declared `refreshAction` can fetch the filtered set rather than everything and a
plugin paging an API can page what the reader is looking at. A control may also
declare `onChange`, dispatched *after* the local write and never instead of it —
the filter works whether or not the handler answers. An action may answer with
`{resetState: true}` or `{resetState: ["statusFilter"]}`
(`readPluginActionResetState`) to put the reader back on the defaults, which is
what a plugin that just archived everything the current filter was showing should
do.

**Two operators that are not string comparisons.** `since` and `before` read a
row field as a TIME — an ISO-8601 string with an explicit zone (or a bare
`YYYY-MM-DD`, read as UTC midnight), or epoch milliseconds — and compare it to an
instant given as a literal, as `{"$rel": "-24h"}` against the client clock, or as
`{"$state": "range"}` so a control can offer "All / Today / This week" as three
option values. `since` is at-or-after and `before` is strictly earlier, so the
pair partitions the timeline at one instant. `vocabTimeValue` is the single
reader for both the operand and the row field, and it is deliberately narrower
than `Date.parse`: a zoneless date-time is a different instant on every client,
so it is not a time at all here. A row whose field is missing or unreadable
FAILS the clause — the same thing a row with no `statusGroup` already does
against an `equals`; INACTIVE stays what it always was, a statement about the
operand.

The clock is a parameter, not a `Date.now()` inside the loop: `filterVocabRows`
and `boundRowValues` sample it once per pass and hand the same instant to every
row, so a boundary cannot fall between two rows of one render and a test can pin
it. A `$rel` therefore re-resolves on RE-RENDER, which happens on data change and
not on a timer — a panel left open across midnight shows yesterday's answer until
something changes or the reader pulls its `refreshAction`. A timer would wake
every open panel on every surface forever to catch a boundary almost nobody is
watching. This is the fix for the ledger's B3, and it is what lets a journal stop
materializing a `today` field that is false by morning.

Four clients, one evaluator where possible. Desktop, the web client and the TUI
all call `filterVocabRows` / `boundRowValues` from `shared/plugins`, so a filter
cannot keep a row on one surface and drop it on another; the TUI draws the
options as numbered pills with ←→ to cycle, and holds the state in the pane
input beside its form values. iOS mirrors the module in
`apps/ios/ADE/Models/PluginVocabularyState.swift` against the same cases, with
`PluginVocabPanelStateTests` pinning the equality, membership, state-driven,
inactive, composed and depth-refusal readings the TypeScript tests pin.

**A control's options may come from a collection.** A literal list of eight is
right for "All / Active / Failed" and useless for "project", because a real
workspace has thirty of those and the plugin cannot know their names when it
writes the schema. It already materializes them — it is writing them into a
collection for the list beside the control — so `optionsFrom` points the control
at that collection instead of asking the author to inline a list they do not have.

```jsonc
"optionsFrom": { "collection": "projects", "keyPrefix": "p:",
                 "valueField": "id", "labelField": "name" }
```

It is a binding minus the parts that would make it a second query language: no
`limit` (the ceiling is the ceiling), no `where` (a filter over a filter's own
options is a puzzle), and no `allowActions` (an option presses nothing). Which
rows are options is decided by which rows the plugin writes. Resolved options cap
at `maxBoundStateOptions` (50) rather than at the literal 8, because the two are
different objects: a literal list is read at a glance and drawn as a strip of
pills, where a bound one is a workspace's projects and is drawn as a menu. Fifty
is where a flat menu stops being findable and the honest answer becomes a search
field the vocabulary does not have yet — and it sits under `maxKeyValueRows` (60),
so no client draws a longer list than one it already draws. A control past
`maxStateOptions` (8) is drawn as a menu naming the current value rather than as a
strip (`vocabStateControlStyle`).

Two rules keep a bound control usable. A literal control still needs two options —
one option is not a choice, and a control the reader cannot change is a filter
permanently stuck wherever the author left it — but a BOUND control is exempt,
because its second option is a row that has not arrived yet and failing it at
parse would make "the collection is empty right now" a broken node
(`vocabularyNodes.ts:1588-1594`). And a bound control **signs its BINDING, not its
resolved options** (`vocabStateSignature`, `vocabularyState.ts:924-960`). Its
options are DATA: a project created in another window, or the second page of a
fetch landing, would otherwise change the signature and drop the reader's filter —
an unusable control, for a change they did not make and cannot see. The binding is
what the author declared, so it moves only when the schema does. The fine
reconciliation still applies: a value that is no longer an option falls back
through `vocabNormalizePanelState`.

**Ticking rows: `list.selectable` and the bulk bar.** A `list` may declare
`selectable: {stateKey, max?, actions}`, which puts a tick box on every row and a
bar across the panel carrying the count, a Clear, and up to `maxBulkActions` (4)
declared verbs. The selection is a SECOND map beside the panel state rather than a
value inside it, because the two hold different shapes — one string against a
closed option list, versus an open set of row keys — and folding a set into a
delimited string would put a parser between the reader's tick and the panel's
redraw, and would leak a hundred issue ids into `$state` and into the `state`
payload. Everything else about the two is identical: same per-panel, per-viewer,
session-only lifetime, same signature/normalize pair, same `{resetState}` verb.

Four rules carry it:

- **Refuse, never evict.** At `max` a new tick is REFUSED rather than dropping the
  oldest. A silent eviction would take a row out of a batch the reader believes
  they assembled, and the count on the bar is the only thing that could have told
  them: untick is a gesture they have, a row vanishing from under them is not.
  Unticking always works, cap or no cap (`vocabularyState.ts:1088-1110`). A
  shift-click range unions rather than replacing, and fills to the cap and stops,
  for the same reason.
- **A batch is the visible intersection.** `vocabSelectedRowKeys` intersects the
  stored set with the rows that actually rendered, in draw order, and that is what
  the bar counts and what a bulk action is handed. A reader ticks four rows, moves
  a filter that hides two, and presses a verb: the two they can see are the batch,
  because acting on a row nobody can see is the one outcome a selection must never
  produce. Moving the filter back brings the other two and their ticks with it,
  which a prune at filter time would not (`vocabularyState.ts:1174-1191`).
- **The signature is the LISTS, not their rows.** Row keys are deliberately absent
  from it: a plugin republishing every few seconds changes which rows exist
  constantly, and a selection that emptied on each of those would make a batch
  impossible to assemble. What resets a selection is the CONTROL changing — a
  different state key, a different cap, or a different set of bulk actions — all
  of which mean the panel is offering something other than what the reader ticked
  rows for.
- **`maxSelectionKeys` is 2, not 8.** A selection owns a bar across the panel and
  one word — "3 selected" — and two *different* lists both claiming that bar is
  already a panel that needs splitting. Two covers the one shape that is not a
  mistake: a detail panel offering a batch over its issues and a batch over its
  pull requests. Lists that share a `stateKey` (seven Linear state groups, one
  batch) union their on-screen ticks into that one bar. When two different
  selection keys both have visible ticks, the first non-empty report in tree
  order wins. The bar sits in panel chrome above `chrome.footer`, not under each
  list.

Ceilings, in `VOCAB_STATE_LIMITS` and spread into `VOCAB_LIMITS`: **8** state keys
per panel, 2–8 literal options per control and 50 resolved, 4 top-level `where`
clauses, depth 3, 24 clauses in total, 20 literals per list, 2 selectable lists per
panel, 100 selected rows per list, 4 bulk actions per bar, 4 chrome nav actions,
4 chrome footer nodes, 200 characters in a search field. The predicate numbers
are small on purpose — a predicate language with a generous budget is a query
language, and a query language is what rule 3 exists to keep out of a panel
schema. The key count is 8 rather than 4 because 4 was one filter axis short of
the panels people actually write: an issue browser wants state, project, assignee,
priority, sort and a text search. The `group` node deliberately spends no key, so
a panel with seven collapsible sections still has its whole filter budget, and 8
still fits in one `$state` `keyValue` node without scrolling
(`vocabularyState.ts:94-106`).

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

### The other things an action may answer with

`navigate` is one of several verbs a client reads out of an action's return
value, each with a tolerant reader in `sdk.ts` and each honoured identically on
all four clients:

- **`openUrl`** (`readPluginActionOpenUrl`) sends the reader to the open web —
  the footer link a panel cannot express, because `text` is plain text on every
  client and never linkified, and `fallback.deeplink` draws only on the failure
  card. **`https:` only**, capped at `PLUGIN_OPEN_URL_MAX_CHARS`. The scheme
  rule is not a defence against the plugin, which is code the user installed; it
  closes the two abuses that do not need one — `file:` would make a link a local
  read, `javascript:` and `data:` would make it script — and refuses `ade:`
  because in-app destinations belong to `navigate`, `fallback.deeplink`, and
  `{openSettings}`. Every open is logged with the plugin id.
- **`openSettings`** (`readPluginActionOpenSettings`) opens one closed host
  settings page. The list is `agents.provider.cursor` (the Cursor API key page
  the Cursor Cloud empty state needs) and `secrets.secrets` (the host Secrets
  tab a launch form uses instead of putting values on a panel). Desktop and
  the web client navigate there. The phone and the TUI have no such page
  (keys and secrets live on the Mac) and say so. An unknown id opens nothing,
  and desktop and web refuse it out loud: a toast names the plugin, the id it
  asked for, and the page ids that exist.
- **`prompt`** (`readPluginActionPrompt`) asks one question and re-invokes the
  same action with `args.prompt = {id, text, context?}`. With `options` it is a
  picker: desktop and web draw a list, iOS a sheet, the TUI draws the choices
  numbered and matches typed text against a value, a label or a drawn number
  (and refuses a miss). A closed question that drew only its title asked the
  reader to type a name from a list they were never shown. Without `options` it is still
  one line of text. It is the ledger's B1, and the gap was ordinary enough to
  be worth naming: "a Log it button that saves a one-line note of what I'm
  doing" had no shape at all, so the plugin that wanted it logged the chat's
  auto-generated title instead. Three rules carry the design. **Cancel invokes
  nothing** — not a call with an empty answer, nothing at all — which is what
  makes the verb safe behind any button. **One hop**: a prompt returned by the
  re-invocation is dropped by every client, so this cannot become a wizard and
  cannot trap a reader in a loop the plugin keeps re-opening; a second field is
  a panel `form`. And the answer is **refused, never truncated**, past
  `PLUGIN_PROMPT_TEXT_MAX_BYTES` (4 KiB) — half a note saved is worse than one
  the reader was asked to shorten. `buildPluginActionPromptAnswer` is the
  single builder of the re-invocation frame, so the desktop popover, the
  phone's sheet and the terminal's inline field cannot hand a handler three
  different shapes. Desktop and web anchor the card at the pressed control by
  sampling `document.activeElement` at INVOKE time (`readPluginPromptAnchor`)
  rather than when the answer comes back, by which point the menu the button
  lived in may have closed.
- **`message`** (`readPluginActionMessage`) is one sentence about how it went.
  Two shapes reach the renderer and both are normal: over sync the host wraps a
  handler's return as `{ok, message?, result}`, while the desktop's local IPC
  hands the return back untouched. Reading both is what stopped "Created lane
  'x'." from appearing in the web client and vanishing on desktop, from one line
  of plugin code. iOS and the TUI have shown it since the verb existed; desktop
  and web draw the same banner, auto-dismissing after six seconds or on the next
  dispatch. `{message}` draws on every client. A socket press has no inline
  place for it, so desktop and the hosted web client show it as a toast, toned
  as an error when `ok` is false; a panel still draws it inline.

Three rules that arrived with the Linear acceptance walk:

- `navigate.target` takes a third value, `popover`. Desktop and the web client
  draw the panel in a card anchored under the control that was pressed, with
  full panel behaviour inside; Escape or a click away closes it, one draws at a
  time, and a second press of the same button closes it. It is never derived: a
  press with no `target` still opens the tab. iOS opens its plugin sheet and the
  TUI its plugin pane, which are those clients' one place for a panel.
- `{openSettings: {socketId}}` names the caller's own published
  `settings-section`. Desktop and the web client open the Settings page that
  hosts it and scroll to the section; another plugin's socket, or one not yet
  published, is refused out loud. The phone and the terminal name the page.
- A result carrying both `openSettings` and `navigate` names one destination
  twice. Desktop and the web client open the settings page and leave the panel
  where it was; the phone and the terminal, which have no plugin Settings page,
  take the navigation and say nothing about the page they did not open. A
  refused settings request falls through to the navigation.

### The panel refresh contract

A panel bound to the plugin's own `plugin_collections` is already live: the host
publishes a change and every client refetches. A panel whose rows come from
somewhere else — an API the plugin polls — has no such signal, so a manifest
panel may declare `refreshAction` (`PluginManifestPanel.refreshAction`), and each
client then offers the refresh gesture it actually has: a button on desktop and
web, pull-to-refresh on an iOS pane, and the TUI's existing `r`. The action is
dispatched *before* the refetch, so the gesture means "go and get new data"; a
refresh that fails still refetches and reports why. Absent, nothing changes on
any client.

**A panel materialized from the manifest runs its refresh once, for the reader.**
The host stamps `seeded: true` into a panel it built from the manifest's schema
file, and the plugin's own `panels.update` clears it; `readPluginPanelSeeded` is
the one reader. A seeded panel is a placeholder — a "Loading…" card — so every
plugin tab drew it and then sat on it, and Graph and Review both opened on
"Loading…" until somebody found the Refresh control. Desktop, the terminal and
the phone now each dispatch the declared `refreshAction` once when a seeded
panel is first drawn. It is silent, on the host's own bookkeeping path: no
spinner on the reader's Refresh button, no success report, and a failure
swallowed, because a first refresh that could not reach its API must leave the
seeded card and the working control exactly where they were. It refetches either
way. The priming is remembered per PLUGIN and PANEL rather than per mount, so
leaving the tab and coming back is not a second reason to spend the plugin's
rate limit, and the memory is dropped the moment a non-seeded row for that panel
is seen — which is what lets a reinstall that seeds the row again earn its one
refresh, and why a row that stays seeded stays primed and cannot re-fire in a
loop.

It reaches the clients inside `schema_json` rather than in a column, because
`plugin_panels` is a CRR table with a frozen SQL shape — the same reason the
resolved `mobile` flag lives there, and the reason a client that predates the key
renders the panel exactly as before. The writer re-stamps it from the manifest on
every update and strips whatever a republished schema carried under that name, so
a plugin cannot mint a refresh gesture for an action it never declared.

A notification may carry a deeplink for the same reason a panel may declare a
refresh: the default landing is the plugin's front door, and "the agent that
finished is bc-1" has a better one. `readPluginNotificationDeeplink` accepts only
`ade://plugin/<the-posting-plugin>/<panel>[?ctx=…]` — a notification is the one
thing a plugin puts in front of the user outside ADE's window, and the link in it
is the one thing they tap without reading, so naming another plugin's panel is
refused. A refused link costs the destination and never the notification. It
rides to the phone; the desktop notification bridge has no destination field.

### The page tier

A `webview` surface is where a plugin ships its own UI code, and since the
2026-09-03 pivot it is the tier a plugin designs for. Three clients host a page:
the desktop app, the hosted web client and iOS. Every client that cannot host
one renders the surface's `panelId` panel instead — `panelId` is required on a
webview surface precisely because the fallback is what keeps the cross-surface
promise honest. `builtin` and `webview` cannot be combined: a gate draws nothing
and a page draws everything, and honouring both would ask the client which of
the two it is looking at.

**One origin per plugin.** On desktop and on iOS pages are served over
`ade-plugin://<pluginId>/…`, which resolves to that plugin's own files and
nothing above them. A custom scheme rather than `file:` for exactly one reason:
with `file:` every plugin would share one origin, `'self'` in the CSP would mean
"the whole filesystem", and storage would be shared. Requests are refused unless
their real path (symlinks followed) is still inside the install directory; a
directory URL resolves to `index.html` and a directory itself is a 404, never a
listing. Only an installed *and enabled* plugin has an origin at all, so
disabling a plugin closes its pages. Content types come from a closed map, and
every response — refusals included — carries the CSP and `nosniff`. One served
file is capped at `PLUGIN_WEBVIEW_FILE_MAX_BYTES` (16 MiB), inside the install
cap that already bounds the whole tree at 5,000 files and 64 MiB.

**The policy** is `PLUGIN_WEBVIEW_CSP`: `script-src 'self'` (no CDN, no inline
script — a plugin that wants a library vendors it), `style-src 'self'
'unsafe-inline'`, `img-src`/`media-src` reaching `https:`, `font-src 'self'
data:`, `connect-src https:` so a page can call its own service, and
`form-action`, `frame-ancestors`, `base-uri`, `object-src` all closed. The
desktop guest runs sandboxed and context-isolated, in a **non-persistent
per-plugin session partition**: cookies, storage, and caches die with the
window, so plugin state belongs in collections where it is budgeted and visible
in the usage meter. Links leave for the user's real browser; navigation away
from the plugin's own origin is refused; new windows are denied.

#### Bridge version 2

**The bridge** is `window.adePlugin`, published by a preload that exposes
nothing else — no `window.ade`, no `require`, no raw IPC.
`PLUGIN_WEBVIEW_BRIDGE_VERSION` is **2** and moves the way `PLUGIN_SDK_VERSION`
does: additive, never re-shaped. `PLUGIN_WEBVIEW_METHODS` is the closed list,
and the list IS the permission model — a page cannot widen it:

| group | methods |
|---|---|
| Data | `collections.get`, `collections.put`, `collections.list`, `config.get`, `config.set` |
| The plugin's own code | `invoke` |
| Destinations | `openDeeplink`, `openSettings` |
| The surface it lives in | `surface.close` |
| The dialog it was drawn in | `dialog.submit` |
| The composer | `composer.attach`, `composer.insert` |
| ADE's own UI | `ui.toast`, `ui.dismissToast`, `ui.prompt`, `ui.confirm`, `ui.pickModel`, `ui.pickLane`, `ui.pickPermissionMode`, `ui.pickReasoningEffort`, `ui.pickProvider`, `ui.openPathInEditor` |
| Other plugins | `sockets.list`, `sockets.invoke` |
| Host engines | `hostEngine.place`, `hostEngine.release` |
| The page itself | `page.error` |
| The machine around it | `clipboard.read`, `clipboard.write` |
| Theme and live data | `theme.get`, `host.subscribe`, `host.unsubscribe` |

The five `ui.pick*` verbs open ADE's own pickers over the page — the same
model list, lane combobox, permission modes, reasoning ladder and provider
rail the rest of the app uses — and return the choice. Dismissing the picker
returns null. A missing provider or model is refused before the picker mounts,
and a known permission family with no modes is refused rather than answered as
a walk-away. Unknown models still open the reasoning control; a catalogued
model with an empty ladder answers null without drawing. Mirrored on hosted
web and iOS.

`collections.list` returns at most 500 rows, and every collection named must be
declared in the manifest. Absent on purpose, and not stubbed: `secrets` (a page
is the one place a plugin's credentials should never be readable),
`contributions.publish` and `panels.update` (a page draws itself; publishing into
other surfaces is the child process's job), and `collections.delete`.
`config.set` IS present, because a plugin's settings page is a page and a form
that cannot save what it renders is the reason the verb was added; the host
refuses a `secret`-kind setting on this path the same way it does on the child's.

**`dialog.submit` answers the dialog a page was drawn in.** A `dialog-picker`
guest hands its chosen issue to the ADE dialog around it — the Create-lane and
Create-PR forms — and the host checks the PLACEMENT it drew that guest at before
it reads the payload. A page in any other placement is refused, because a tab
that could name the issue for a dialog nobody opened would be writing into a
form the reader is not looking at. The answer lands in a store keyed per GUEST
rather than per dialog kind: main derives the guest key from the `webContents`
that called, so no page can forge another's, and a settings section and a dialog
picker that are open at once cannot receive each other's answer. The page hears
one of three outcomes, never a silent success: the dialog took it, the dialog's
own validation turned it down, or no dialog is listening on that guest any more.

Three events reach a page, on one channel with the name in the frame:
`changed` (the plugin's own collections moved), `theme` (the host republished
its scheme and its `--ade-*` tokens), and `host` (a lane, a session, a pull
request or a chat turn moved). A fourth, `refresh`, is the reader's pull-down:
iOS sends it from the WKWebView refresh control, and the page re-reads whatever
that surface reads. `PLUGIN_WEBVIEW_EVENTS` is the closed allowlist every guest
uses — `changed`, `theme`, `host`, `refresh` — so a page that subscribes to
`refresh` on desktop or hosted web is not thrown for an unknown name. Desktop
and hosted web do not currently emit `refresh` (there is no pull-to-refresh
gesture there); they still allowlist it so the same page binary can listen.
A `host` frame carries identity and nothing else
— the kind, the ids, and an `overflow` flag when more moved than
`PLUGIN_WEBVIEW_HOST_IDS_MAX` (200) — and the host coalesces for
`PLUGIN_WEBVIEW_HOST_COALESCE_MS` (120 ms) first, because a rebase moves a dozen
lanes in a few milliseconds and the page redraws once either way. A page follows
a family by calling `host.subscribe`.

`PLUGIN_WEBVIEW_HOST_KINDS` is `lane`, `session`, `pr` and `chat`. The fourth is
not an entity family: it reports where a chat session's TURN is, so a page that
launched an agent learns that the first turn died. Without it a launched issue
sits on "Ready", which is the one state it is certainly not in. A `chat` frame
is the single narrowing of the identity-only rule, and it is narrow on purpose.
Alongside the session ids in `ids` it carries `turns`, and one turn carries a
`sessionId`, a `state` of `started`, `completed` or `failed`, the host's own
`turnId` when the producer knows it, and — on `failed` only — the `message` ADE
would have shown the reader, capped at
`PLUGIN_WEBVIEW_CHAT_MESSAGE_MAX_CHARS` (400). No prompt, no reply, no tool
name, no token count. Three states rather than the five the app tracks
internally: `interrupted` maps onto `failed`, so a page has one error path
rather than two. One frame carries at most
`PLUGIN_WEBVIEW_CHAT_TURNS_MAX` (100) turns, lower than the id ceiling because a
turn is a record and an id is a string; past it the frame says `overflow` and
the page refetches the sessions it is watching.

**The plugin id is never on the wire.** Every call is answered against the id
the host derives from the guest's own frame URL, cross-checked against the entry
the window layer wrote when it approved the attach. A `pluginId` field in a
payload would be a claim, and honouring a claim is how one plugin reads
another's collections — so there is no such field to ignore.

**An `invoke` honours the same control-flow answers a socket press honours.**
The page calls its own handler and the HOST reads the return value, so a plugin
that answers `{navigate}` from a button and from a page gets the same behaviour
from both. Main handles `openUrl`, `authSession` and `prompt` before the result
reaches the window. The window then applies `{message}`, a composer edit, a
dialog field, `{openSettings}` and `{navigate}`, under the same
one-destination rule the socket path applies: `openSettings` and `navigate` in
one result are one destination written twice, so the settings page wins and the
navigation is dropped. A navigation out of an anchored page closes the card it
was drawn in.

**The relay is the renderer's half.** Main owns every question of permission —
who asked, whether that guest's surface is on screen, how long the page may wait
(`PLUGIN_WEBVIEW_UI_TIMEOUT_MS`, 10 s; ten minutes for a question). What is left
over is the part only the window can do: move a piece of ADE's own UI.
`pluginWebviewRelay.ts` is that part, and it is a router over the appliers the
SOCKET path already uses rather than a second implementation of any of them, so
a page's `composer.attach` reaches the same composer a `composer-action`'s
`{composer}` answer reaches. Its one non-negotiable rule is that EVERY request is
answered exactly once: an unknown verb, a guest that has already gone and an
applier that threw all become `{ ok: false, message }`, because on the other end
of every request is a page holding a promise.

#### Placements

Eight, in `PLUGIN_WEBVIEW_PLACEMENTS`: `tab`, `pane`, `drawer`, `overlay`,
`popover`, `settings-section`, `composer-picker`, `dialog-picker`. It is a
closed list because it is half of the relay's addressing — `surface.close` means
"close the popover", "close the picker" or "do nothing" depending on this value
alone, and `dialog.submit` is refused anywhere but `dialog-picker` on this value
alone as well.

- **Tab, pane and drawer** come from the manifest: the plugin declared the
  surface there, and the page fills a frame the host already owns.
- **Overlay** is what an `openWebview` answer opens by default.
- **Popover** is anchored under the control that was pressed. **Composer
  picker** is the same card over the composer, and the two share one store,
  because they are one object wearing different anchors: what separates them is
  where the card points and what finishes it — a popover is read and dismissed,
  a picker ends when the page attaches something to the composer. One anchored
  page at a time, and the cap is not negotiable here: a guest is a whole
  renderer process, so a second open REPLACES the first rather than stacking.
  Escape, a click outside and `surface.close` all dismiss it, and a second press
  of the same control closes it rather than opening a second copy.
- **Settings section**: a `settings-section` socket may name a webview surface,
  and the section body is then the guest, sized from the page's own resize
  message and capped at `PLUGIN_WEBVIEW_MAX_HEIGHT_PX` (2,000).
- **Dialog picker**: a `dialog-section` socket's page, drawn inside an ADE
  dialog — the Create-lane and Create-PR forms. It sizes to its content the way
  a settings section does, because it is the other placement that sits inside a
  taller ADE surface rather than filling a frame the host already sized, and it
  is the only placement `dialog.submit` is honoured from.

**Every placement destroys its guest when it is hidden.** Not "keeps it alive
and stops painting": one live guest per placement, and state lives in the
plugin's collections rather than in the guest, whose partition is
non-persistent anyway.

A page in an anchored placement may ask for a size. `popover: { width, height }`
on the manifest surface is a HINT, not a size the plugin sets — the host clamps
it to the window and falls back to 520×640 when it is absent. A tab, a pane and
the overlay all fill a frame the host owns, so only the two anchored placements
have a size to ask about.

Two fields connect the declarative sockets to the page tier, and both are
additions rather than replacements:

- **`webviewSurfaceId` on a socket payload** names a webview surface of the same
  plugin that this contribution draws INSTEAD of its `panelId`, on a client that
  can host a page. It is read on the kinds with somewhere to put one: the four
  action buttons, the row badge and the settings section. `panelId` stays
  required and stays the contract. An unresolvable id costs nothing — the
  drawing client looks the surface up in the plugin's OWN declarations and falls
  back to the panel, which is where it was going anyway. The parser proves only
  the shape (64 characters), because it also runs on the phone and in the
  daemon, where there is no registry to resolve an id against.

  **A press on a control that declared a page opens the page and does NOT
  invoke the action.** The declaration replaces the invoke rather than joining
  it, for three reasons. A plugin whose action still answers `{openWebview}` for
  the same surface — which every plugin written before the declaration existed
  does — would open the page twice, and the second open would CLOSE the card the
  press just opened, because the anchored store toggles. Opening a page is the
  one press that needs nothing from the plugin's process, so spawning a child to
  be told what the manifest already said is a cold start the reader waits
  through for no answer. And a page reads the plugin's collections and calls
  `invoke` itself, so the action it replaced existed to return `{openWebview}`
  and nothing else. A contribution that declares no surface — or one whose id
  resolves to nothing, because the plugin is uninstalled, disabled or renamed,
  or because this client hosts no pages — invokes exactly as it always did.
  Where the page opens is a property of the SOCKET, in the closed
  `PLUGIN_SOCKET_WEBVIEW_PLACEMENT` table: a toolbar, chat-header or row-badge
  press draws a popover, a composer button draws a composer picker, a palette
  command draws an overlay, and a settings or dialog section draws in the frame
  it already owns.
- **`openWebview.placement`** on an action's answer asks for `overlay`,
  `popover` or `picker`. `PLUGIN_ACTION_WEBVIEW_PLACEMENTS` is deliberately
  shorter than the host's own list: an action may ask only for the three hosts a
  press can summon, and a button that could move itself into the Work rail would
  be a plugin rearranging ADE's furniture from a click handler. Absent means
  `overlay`, which is what every `openWebview` meant before, and an unknown
  value is dropped rather than refusing the open.

#### Two reads a page rebuilding an ADE form needs

`ade.chat.capabilities()` answers what a launch form may offer: a list of
providers carrying the permission vocabulary each one takes, and a list of
models carrying `fastMode` and that model's OWN reasoning ladder, with
`provider` on a model as the join between the two. Two lists rather than a
nesting, because permission is a provider fact and the ladder is a per-model
one, and a page picking a model needs both without a second call. An empty
`reasoningEfforts` is a real answer and not a missing one — the page draws no
picker rather than falling back to none/low/medium/high. This is the one READ in
the `chat` namespace and it owns nothing: the answer does not depend on the
project, the lane or the plugin, so it needs no gate beyond the one every SDK
call has, and a page may read it once at mount rather than per launch. It exists
because all three facts are REGISTRY facts that a page rebuilding ADE's launch
form had no way to reach, so the ported Linear modal offered one free-text
permission mode, no fast mode, and a hard-coded ladder. A chosen permission
value goes in the provider's own launch field, not in the unified
`permissionMode`. `chatCapabilities.test.ts` pins these lists against the
renderer's own, so a mode added to the app's pill and not to the shared module
fails a test rather than leaving plugin pages a version behind.

`lanes.list()` answers `path`, the lane's worktree on this machine. It is the
one field argued back onto `PluginLaneSummary`, whose projection is a fixed
allowlist rather than a delete-list. The argument against it was that a plugin
with the filesystem already knows where it put its own files, which is true and
beside the point: a plugin does not know where ADE put the LANE, so a page that
wants to show which checkout a lane lives in, or hand the path to a terminal,
could not learn it and could not derive it. `attachedRootPath` and `devicesOpen`
stay off — a second path no surface has asked for, and a roster of the user's
machines. The value is null rather than absent when the host has no path, so a
page can tell "no local checkout" from "an older host did not report one"; the
Linear page's `PageLane.path` reads it through either name the host answers and
hides the row when it is null rather than drawing an empty one.

**Hot reload.** A guest is recreated — not reloaded — when the bytes under it
change, keyed on `version:revision`. `reload()` would re-run whatever the guest
already fetched; a fresh key gives it a fresh load of the new files, and
`revision` is in the key because `ade plugin dev` re-copies a source tree over
the installed one without moving the version.

**Scaffolding one.** `ade plugin create <name> --webview` writes a plugin whose
surface is its own page: a `webview` surface with an `entryHtml`, a `panelId`
that still names a panel, and a framework-free `page/` with an external
stylesheet and a deferred external script. Framework-free on purpose — an inline
`<script>` and a CDN are both refused by the CSP the host serves, so the
starter has the shape a real build has to produce as well.

#### The hosted web client

The web client has no custom scheme to give a plugin, so it builds the same
isolation out of what a browser hands it. A page draws in an `<iframe>` at a
same-origin path under `/assets/plugin-pages/`, and a **service worker** answers
every request in that space out of Cache Storage. The stored response — not the
client's own policy — is what makes the guest opaque: it carries
`Content-Security-Policy: sandbox allow-scripts`, so the frame is the app's own
origin while the document inside it has none.

The worker is a pass-through over Cache Storage and nothing more: which media
types exist, what the guest's policy says and which bytes a plugin may ship are
all decided when the response is built and stored with it, so the worker cannot
hold a second opinion about any of them. It intercepts nothing outside its own
space, so installing it does not make the client offline-capable. A miss is a
404 rather than a pass to the network, where the origin's single-page fallback
would hand a plugin's frame the whole signed-in ADE client.

Two headers back that up. The client's own policy names `frame-src 'self'` and
`worker-src 'self'` — no third-party frame, and no `blob:` or `data:` frame
either, both of which would inherit the client's policy instead of taking the
worker's. And `/assets/plugin-pages/*` is served with
`Content-Security-Policy: sandbox; default-src 'none'`, with no
`allow-scripts`: if the worker is ever not controlling the path, whatever the
origin serves there loads with an opaque origin and cannot run a line of script.
The client also refuses to create the frame until the worker is active; the
header is the half that survives a change to the client.

The bytes come over the sync file channel, the same one the phone uses, and the
bridge is `postMessage` with the host as the only counterpart. A page's writes
go to the machine as remote commands.

#### iOS

The phone draws a page in a `WKWebView` inside a `UIViewRepresentable`. A
`WKURLSchemeHandler` serves the cached files at `ade-plugin://<id>/` with the
same closed MIME map and the desktop's content policy, delivered as a header
because that is where WebKit applies one. A `WKScriptMessageHandler` carries
bridge v2.

The cache is **content-addressed**: files are stored under their SHA-256 in a
`blobs/` directory, and an entry is keyed on plugin id plus version plus
revision. Official plugins can ship a **pre-seeded** entry inside the app —
`ADE/Resources/BundledPluginPages/<pluginId>/` holds a manifest and the files
laid out by path rather than by hash, because a build phase copies files and not
blobs, and the store knows which layout it is reading from the entry's `source`.
A bundled entry wins over a download at the same version and revision, and loses
to any newer version the phone fetches. The directory holds nothing but its
README today; a page is copied in once it is built.

Reads and writes split. A page **reads** its collections from the replicated
`plugin_*` mirror, which is what makes it work offline. `invoke`, collection
writes and config go to the machine **over RPC**. One live guest at a time. The
fallback is never an "open this on your Mac" card: a phone with no cached page
draws the plugin's vocabulary panel, which is the tier it has drawn since the
vocabulary shipped.

Placements on the phone are `tab`, `popover`, `settings-section` and
`composer-picker`, narrowed to what the device can draw: a `popover` is a
popover on a regular-width screen and a sheet on a compact one, and the settings
section and the picker are sheets, because neither has an anchor there.

#### The asset channel and the page's writes

Two actions on the sync file channel serve a plugin's built page, both gated on
the peer advertising `pluginTables`:

| action | args | answers |
|---|---|---|
| `plugin.pageAssets.manifest` | `{pluginId}` | `{pluginId, version, revision, entry, files: [{path, bytes, sha256}]}` |
| `plugin.pageAssets.read` | `{pluginId, path, sha256}` | `{path, bytes, sha256, contentBase64}` |

Two rather than one because the caller caches by content hash: it lists first,
downloads only the hashes it lacks, and a page that did not change costs one
round trip. The read must NAME the hash it expects, and a mismatch is a refusal
rather than a body — a file that changed between the manifest and the read would
be stored under the wrong key and served forever. Containment is the guard
`readArtifact` uses (`resolvePathWithinRoot`, symlinks followed), the per-file
ceiling is `PLUGIN_PAGE_ASSET_MAX_BYTES` (8 MiB) because one frame carries the
file base64-encoded, and the served directory is the surface's `entryHtml`
directory, else `dist`.

Three remote commands carry what a page cannot do locally:

```
plugins.putCollection  {pluginId, collection, key, value?}  -> {ok}
plugins.getConfig      {pluginId, key?}                     -> {value} | {config}
plugins.setConfig      {pluginId, key, value?}              -> {config}
```

They resolve the SAME host writers the desktop bridge calls, through a
late-bound ref (`pluginPageHostRef.ts`), so the declared-collection rule, the
store's budgets, the manifest validation and the refusal of `secret` settings
stay in one place. An absent `value` means `null` rather than "no change": a
page clearing a field sends no value, and reading that as "leave it alone" would
leave the old value standing while the page believed it was gone.
`plugins.getConfig` answers `{value}` for a named key and `{config}` for the
whole record when no key is named, because the phone's form binds to one setting
while the bridge contract hands a page its whole settings object.

#### The UI kit

`packages/ui` is published as **`@ade-dev/ui`** by the existing SDK workflow, and
the desktop app consumes the very same modules through `file:../../packages/ui`
plus re-export shims at the old component paths, so the kit and the app cannot
drift apart. React 18 or 19 is a peer dependency.

Five entry points, so a page pays only for what it draws:

| path | contents | pulls |
|---|---|---|
| `@ade-dev/ui/tokens` | `COLORS`, the spacing/size/radius scales, the style builders, `INPUT_CLS` | nothing, not even React |
| `@ade-dev/ui/theme` | `applyAdeTheme`, the palettes, `injectAdeStyles`, `<AdeStyles/>` | react |
| `@ade-dev/ui` | `Button`, `Chip`, `EmptyState`, `PaneHeader`, `cn`, the settings shell, the Linear brand and issue helpers, plus everything above | react, clsx, tailwind-merge |
| `@ade-dev/ui/icons` | `LaneIcon`, `BranchIcon` | `@phosphor-icons/react` |
| `@ade-dev/ui/markdown` | `Markdown`, `SAFE_PREVIEW_SCHEMA`, `markdownUrlTransform` | react-markdown, remark-gfm, rehype-raw, rehype-sanitize |

The icon set and the markdown stack are deliberately NOT re-exported from the
barrel. `@phosphor-icons/react` ships without a `sideEffects` declaration, so a
bundler that sees it through the barrel keeps the entire set: importing one
design token that way grew ADE's own web client entry graph from 301 KB to
5,496 KB.

The kit's CSS ships as a **string**, not a `.css` file, so a page needs no
Tailwind build, no CDN and no external stylesheet to look like the app;
`style-src 'unsafe-inline'` is what lets the injected `<style>` apply. Nothing
injects at import time — `injectAdeStyles()` and `<AdeStyles/>` are explicit and
idempotent. The desktop app never injects it: its components carry the original
Tailwind utilities alongside the `ade-*` class names, so inside the app Tailwind
draws them and the sheet is inert. That is what keeps one component from
drifting into two appearances. Components read `--ade-*` custom
properties, so handing `theme.get()`'s snapshot to `applyAdeTheme` re-themes the
whole page in one call, and doing it again on every `theme` event keeps the page
with the app. Unknown token names are dropped rather than written. With no
bridge answer the built-in `darkTheme`/`lightTheme` palettes apply and follow
`prefers-color-scheme`.

Fonts are vendored, never linked: `--ade-font-sans` asks for Geist and
`--ade-font-mono` for JetBrains Mono, `font-src 'self'` is the whole allowance,
so the `.woff2` files are copied into the plugin's own built directory and
declared there.

#### Build policy

A page plugin keeps its **source and its built output both in the repository**:
the page's own `src/` beside a committed `dist/`, built with Vite. Install
copies the tree as it stands, minus `.git` and `node_modules`, under the
existing 5,000-file and 64 MiB cap — so the committed
`dist/` is what a user installs and a build step is never run on their machine.
Every asset reference is relative, because the page's origin is
`ade-plugin://<id>` and nothing outside it loads, and there are no inline
scripts, because the CSP refuses them.

### Sockets

Twenty-three kinds across eight surfaces (`PLUGIN_SOCKET_KINDS` and
`PLUGIN_SURFACE_IDS` in `sockets.ts:41-93`), in six groups:

| group | kinds |
|---|---|
| Rows, lists and detail panes | `toolbar-action`, `row-badge`, `row-menu-item`, `detail-section`, `empty-state`, `filter-chip`, `file-viewer` |
| Chat and the agent | `composer-action`, `chat-header-action`, `chat-card`, `slash-command`, `composer-menu-item`, `chat-menu-item`, `machine-entry` |
| Ambient placement | `command-palette-action`, `settings-section`, `work-rail-pane`, `drawer-tab`, `activity-entry` |
| The canvas | `graph-node` |
| Dialogs | `dialog-section` |
| Automations | `automation-trigger-tile`, `automation-template` |

`composer-menu-item` is a row in the composer's three-dot menu — a verb used
once a session, not a permanent slot on the accessory row. `chat-menu-item`
joins a named submenu the host already owns (`issue-context` today).
`machine-entry` is a row in the composer's machine picker; selecting it is what
makes Enter launch through the plugin (`ownsSend` semantics), and Advanced
opens the named page from the row. The two Automations kinds answer different
questions: the tile is "what starts this rule", the template is "here is a
whole rule already written".

A `settings-section` payload may name the Settings page it belongs on through `section` (a tab id such as `integrations`, or a card anchor); anything unrecognised lands on General. The section header draws the plugin's manifest icon, brand glyph included.

The first six surfaces (`work`, `lanes`, `files`, `prs`, `automations`, `cto`)
are ADE's list-shaped tabs, each with an entity kind behind it, which is what
makes a per-entity contribution meaningful there. `app` and `settings` carry no
list entity of their own: the command palette and the activity pane belong to the
window rather than to a tab, and a settings section belongs to a page named in
its payload. A plugin's own rail tab is the exception on `app`: a `row-badge`
published against `{entityKind: "surface", entityId: "<pluginId>/<tabSurfaceId>"}`
is a notification pill on that tab. They are surfaces rather than a second
concept because everything downstream — the manifest field, the contribution
read, the per-slot cap, the ordering rule — is identical.

**A `composer-action` may claim Send** with `ownsSend: true`. A click then arms
the button instead of invoking; Enter/Send invokes that action with
`args.send === true` and the live composer context (draft, model, reasoning,
fast). The Advanced menu item still invokes immediately — that is the form.
Absent `ownsSend`, a click invokes as it always did.

An armed Send owner is cleared by the host on two triggers a plugin cannot see:
the composer's conversation changing, and the contribution leaving the row (an
uninstall, a disable, or a row that stopped declaring `ownsSend`). Either way
Send goes back to ADE rather than dispatching a plugin action behind a button
nobody can see. iOS now honours `ownsSend`, `{openSettings}` and `{openUrl}` on
the socket path the same way, so a toolbar button, a row menu item and a
composer action behave there as they do on the desktop.

The taxonomy is closed and small so an author learns it once and every client can
implement it exhaustively at compile time; a twenty-fourth kind is a platform change
with a parity cost on four clients. Which client draws which kind is a table
(`PLUGIN_SOCKET_CLIENT_SUPPORT`, `sockets.ts:276-339`), and the rule it encodes is that
**absent on a client is honest and readable, half-drawn is neither**.

Placement is host-controlled and always **after** core content — `order` sorts
plugins against each other and nothing more. Row badges cap at 2 visible with a
"+N" overflow; one plugin may place at most 8 contributions in one slot. A
payload that fails its per-kind validation renders nothing rather than a
half-built row.

**A DECLARED `row-badge` draws nothing** (the ledger's B4). It is the one kind
whose manifest entry is a reservation rather than a contribution: a badge is a
per-entity value and a declaration has no entity, so drawing its manifest label
put the same chip on every row of the surface forever — the journal plugin's
`"0"` on all six lanes, which its author had picked precisely because it read
acceptably as an empty state. `selectContributions` drops static `row-badge`
entries BEFORE the per-plugin cap, so a placeholder cannot eat the slot a real
published badge needs; the declaration is still built and still in
`staticContributions`, because it is what a published row is matched against for
override and ordering and what the install sheet describes. Every other kind is
unchanged — a declared `row-menu-item` is still on every row, because a menu
item is a verb rather than a value. iOS mirrors this by returning nil from the
`.rowBadge` arm of `PluginSocketDeclarations.payload(for:wire:)`, and the TUI
inherits it by sharing `selectContributions`.

**A `row-badge` on `app` is a notification on the plugin's own rail tab.** Declare
`{ socket: "row-badge", surface: "app", id: "tab-badge", label: "…" }` and publish
against `"<pluginId>/<tabSurfaceId>"` — exactly one slash, so the address cannot
collide with ADE's own surface ids. Cap 1; the pill is hidden while that tab is
active in this window. Durable clear is optional `viewAction` on the panel: the
host invokes `{ viewed: true }` when the panel is visible and `{ viewed: false }`
when it is hidden, silently. The viewed lifecycle fires for `webview` tabs too,
so a plugin whose only rail surface is a webview is told the reader opened it.
Cursor Cloud uses this for unread finished agents, and it persists the count in
its own unsynced collection so a plugin restart republishes the same number
rather than counting back up from zero.

**The pill draws at most 6 characters**, cut rather than ellipsized, on desktop
(`PLUGIN_TAB_BADGE_TEXT_MAX`) and on iOS. A `row-badge` payload allows 32, which
reads correctly on a lane row and covers the glyph it belongs to on a 20px rail
icon. The full text is not lost: a clamped pill puts it in the tooltip when the
plugin published no tooltip of its own, and the tab's accessible name reads the
tooltip, else the pill.

**`pluginRailTabSurface` (`manifest.ts`) is the one rule for which surface a rail
tab, its badge address and its default panel mean**: the first surface in
manifest order whose kind is `tab` or `webview`. Desktop, iOS and the TUI all
read it. A tab badge is addressed by `"<pluginId>/<surfaceId>"`, so two clients
picking different surfaces off one manifest read two different addresses for one
pill — which is what a plugin whose webview came first used to get.

**A `command-palette-action` receives `args.subject`** (the ledger's B5): the
focused chat, else the selected lane, else `{kind: "none"}`, built by
`pluginActionSubject`. It rides BESIDE the surface context rather than replacing
it — the palette's context is `{kind: "surface", surface: "app"}` and that is
what selects which entries the palette shows, so pointing it at a chat would
quietly change the list. `"none"` is a real answer: a plugin told so can say
"open a chat first" instead of writing against a guess, which is what tracking
the last `turn.start` amounted to.

**A `graph-node` is a shape on the Graph canvas.** It is its own group in the
taxonomy because it is the one placement that is not a row, a control or a panel.
It rides the `lanes` surface, and there is no `graph` surface id on purpose: the
canvas is a second VIEW of the same lanes the Lanes tab lists, so both read one
set, one rows store and one set of published rows. The socket KIND says the
placement, the surface says the data domain — the same split `dialog-section` uses
to put two dialogs on `lanes` (`WorkspaceGraphPage.tsx:1324-1336`).

The payload is `{label, detail?, tone, icon?, actionId?, edges?}`. `label` caps at
40 characters — the same 40 a button's label takes, because a node card is about
as wide as a toolbar button — and `detail` at 80, longer because it carries the
identifier a reader matches against something outside ADE. `actionId` is
deliberately not required: a node that only labels something is a legitimate node,
and demanding a press would make every purely informational one undeclarable. **A
plugin never positions anything**: the anchor is the published row's entity, so a
node published against a lane hangs beside that lane's card.

**Edges only ever have the plugin's own node at one end.** `to` names the FAR end
and nothing else, `to.kind` is `lane | pr`, and the near end always comes from the
anchor. What this shape cannot express is an edge between two of ADE's own nodes —
and that asymmetry is a safety property rather than a simplification. An edge
between two lane nodes reads as a git relationship, and a plugin that could draw
one would be asserting a topology it does not own, in a place where the user has
no way to tell it apart from ADE's own (`sockets.ts:864-873`,
`pluginGraphNodes.ts:16-20`). Edge kinds are `link | tracks | blocks`; an
unreadable edge drops alone and the node keeps its remaining lines, rather than
the contribution disappearing.

Three caps, and they refuse three different failures:

| constant | value | what it caps |
|---|---|---|
| `PLUGIN_GRAPH_NODE_EDGE_LIMIT` | 4 | extra edges on ONE node, beyond its anchor |
| `PLUGIN_GRAPH_NODES_PER_PLUGIN_LIMIT` | 24 | nodes ONE plugin may draw on the canvas |
| `PLUGIN_GRAPH_NODES_TOTAL_LIMIT` | 48 | nodes EVERY plugin combined may draw |

Four, because the node is a glance: a plugin whose node relates to more than four
lanes is describing a list, and a list belongs in a panel where it can be scrolled
and read. Two node caps rather than one, because the per-plugin cap stops ONE
plugin from burying the topology under its own annotations and the total stops
three well-behaved plugins from doing it collectively, which no per-plugin number
can prevent. Both are enforced AFTER the canvas has built every core node, so the
thing dropped is always a plugin's — a lane never loses its node to a plugin's.

The edge limit is enforced at WRITE time and the two node caps at DRAW time, which
makes them the one ceiling on this platform an author cannot see from their own
side: the rows store fine and the canvas withholds the surplus on a machine the
author may not be sitting at. So `ade plugin doctor` prints the count, and the
canvas draws a muted overflow line (`pluginDoctor.ts:388-403`).

A DECLARED `graph-node` draws nothing, exactly as a declared `row-badge` does —
one identical card beside every lane on the canvas is the same mistake with a
bigger footprint (`contributionModel.ts:427-430`). Desktop and the hosted web
client draw the kind, from the same compiled renderer at the same `/graph` route.
iOS and the TUI do not, and that absence is a fact about a whole TAB rather than a
missing renderer arm: the phone ships no Graph canvas at all and the terminal
draws no canvas, so neither can grow an arm for this kind without first growing
the tab.

**One hook resolves a plugin's own brand glyphs, in every socket.** ADE compiles
five vendor marks in, and a `brand:*` token outside that closed set can only be
resolved from the artwork the PACKAGE shipped — the host sanitizes it into
`ade.brandIcons` at install and hands it back on the installed record. A
renderer that does not pass those rows draws the puzzle piece for exactly the
plugins that took the trouble to ship a mark, which is what the top bar did:
`PluginToolbarActions` drew a puzzle piece for `brand:linear` while the tab rail
two pixels away drew Linear's own logo. So it is a hook rather than a prop
threaded from six places. `usePluginBrandIcons` is the one lookup every socket
renderer makes, memoized on the installed list's identity so a hundred rows
share one map, and a registry that has not loaded yet answers `undefined`
rather than taking a tab down with it.

**The top-bar cluster opts out of the drag region and wears the header's own
chrome.** The window header IS a drag region, and a child that does not opt out
of it is not clickable: pressing the plugin button moved the window instead of
invoking the action. The cluster carries the same `no-drag` opt-out every other
control in that bar carries, and draws with the header's compact chrome, so it
is the height and radius of the shell buttons it sits between rather than a
taller, double-edged box. Project tabs sit first in the flexible region and
win space; plugin `toolbar-action` buttons on `app` follow them, drag-reorder
(handle on hover), and persist per user. Overflow is a chevron at the region's
end, shown only when something is hidden, with the hidden buttons and a
Reorder entry. The pinned right cluster is feedback, help, zoom, then usage,
connections, bell.

**A failed manifest read at cold launch is never latched.** Every STATIC socket
— the top-bar button, the row menu entry, the palette command — is declared in a
manifest, so the socket layer caches one manifest read per plugin, keyed on the
install set. On a cold launch the plugin host lives in the daemon and has not
bound yet, so the first read refuses with a typed `plugins_unavailable`, and the
install set does not change when the host merely binds later: banking that
refusal as "this plugin declares nothing" drew an empty top bar until the next
relaunch. Three changes together close it. A refusal falls through to
`plugins.get`, whose detail record carries the same manifest. A failed read is
dropped from the cache the moment it answers, so the next reveal asks again. And
a load in which ANY manifest is unreadable is reported as a failed load, so the
store keeps what it had, stays stale, and retries on its existing schedule
rather than settling empty.

Static contributions come from the manifest; dynamic per-entity values come from
`plugin_contributions` rows computed by the machine that owns the data. Actions
receive a typed read-only context object — a projection with the handful of
fields a plugin's UI needs, never a handle to the lane's worktree, the PR's
token, or the session's transcript.

The lane row's Linear issue badge (`LinearIssueBadge`) is not a `row-badge`
socket contribution — which Linear issue a lane implements is core lane
metadata (`lane.linearIssue`), not something a plugin adds — but it follows
`ade-linear` anyway, because `ade-linear` contributes its own `row-badge` and two
Linear badges on one lane row is the duplicate the polarity exists to prevent. It
gates itself, on the same `isBuiltinSurfaceVisible("linear")` predicate as the
quick view and the `linear-issue` deeplink, rather than at each of the four lane
surfaces that render it. iOS does the same in `LaneLinearIssueBadge` via
`PluginPresenceGate`. The lane metadata underneath is untouched: installing
`ade-linear` hides ADE's badge in favour of the plugin's, it does not unlink the
issue, and uninstalling brings the compiled badge back with the issue still
attached.

### Agent skills

A plugin owns its agent skills the same way it owns its UI. `skills` in the
manifest lists directories **containing** skill directories — `"skills": ["skills"]`
resolves to `<plugin>/skills/<skill-name>/SKILL.md` — and
`listPluginAgentSkillRoots()` answers with the roots of installed, enabled
plugins only. Those roots are appended to `ADE_AGENT_SKILLS_DIRS` for every
runtime, passed to Codex as `skills/extraRoots`, handed to Claude as
`--plugin-dir` (which is why a plugin skills root ships a `.claude-plugin/plugin.json`
marker, since Claude reads plugin roots and never the env var), and listed by
`ade skill list`. Every official plugin skills root carries that marker, and a
test walks the `plugins/` directory to prove it: without the marker a skill
loads on every other runtime and silently never loads on Claude.

**A plugin's skills supersede ADE's own, they do not unlock them.** ADE still
bundles `ade-linear`, `ade-ios-simulator` and `ade-app-control`, and a machine
with no plugin installed reads exactly those copies. Plugin roots come FIRST in
the candidate order and the catalogue keeps the first sighting of a name, so
with the plugin installed `ade skill show` returns the plugin's copy and lists
the name once. The capability underneath is not fenced
off — `xcrun simctl`, the Linear API and AppleScript are still there; what the
plugin carries is ADE's premium layer over them.

### Two polarities: enabling and superseding

Every owner row carries a `presence`, from `PLUGIN_BUILTIN_SURFACE_PRESENCE` in
`shared/plugins/manifest.ts`, and it decides which way the plugin's install
moves the compiled surface.

| surface | owner | presence |
|---|---|---|
| `graph` | `ade-graph` | `supersedes` |
| `review` | `ade-review` | `supersedes` |
| `history` | `ade-history` | `supersedes` |
| `linear` | `ade-linear` | `supersedes` |
| `ios` | `ade-ios-sim` | `supersedes` |
| `app-control` | `ade-app-control` | `supersedes` |
| `cursor-cloud` | `ade-cursor-cloud` | `supersedes` |

`enables` is the original relationship: the plugin is the only reason the
surface exists, so ADE draws it only while the owner is installed and enabled,
and every unknown — an unresolved registry, a host with no plugin support —
hides it. There is no state in which a surface appears because ADE was unsure.
No registered surface uses it today; the field stays so a future vertical can
gate a compiled pane without inventing a second table.

`supersedes` is the mirror, and every registered surface uses it. ADE shipped a
compiled Graph tab, a compiled fleet surface, a compiled Linear integration, a
compiled Review tab, a compiled History tab and compiled Work panes for Control
and Simulator long before those plugins existed, and the owner plugins
**replace** them: their own header buttons, composer sockets, panels, row
badges, settings sections and Work-rail entries stand where the built-in ones
did. So ADE draws the compiled surface only while the owner is ABSENT, and
every unknown draws it — a machine without the plugin must behave exactly as
it did before the plugin existed, and hiding on an unresolved registry would
blink a shipped feature off on every launch. Only a positive "the owner is
here" takes it away, which is the same instant the plugin's own entry point
appears, so the user never sees both at once.

Linear was the one that had to CHANGE polarity first. Review, History, Graph,
Electron Control and iOS Simulator follow the same template: take an ADE
install that has no owner plugin, and it is the compiled product it has always
been; install the plugin, and every compiled surface for that product steps
aside for the plugin's own.

The polarity also decides what a compiled ACTION DOMAIN does. Under `supersedes`
a compiled domain keeps dispatching on a machine with no plugin installed, which
is the product ADE has always shipped. Once the plugin is installed the domain
stops being ADVERTISED in the agent's action catalog; it is not refused. The
refusal machinery — `policyDenied` with a `plugin_not_installed` reason, never
`methodNotFound` — stays for a future `enables` vertical.

The polarity also decides what a manifest may say. A `supersedes` surface is
never named by `surfaces[].builtin`: that field means "ADE draws its compiled
page in my place", and honouring it would suppress the plugin's OWN rail item in
favour of the page it exists to replace. The parser refuses the combination.

What is gated for Cursor Cloud: the top-bar quick-view button and its fleet
modal (`CursorCloudQuickViewButton`, which carries the gate itself so neither of
`TopBar`'s two call sites can forget it), the composer's cloud mode plus the
Advanced menu and secrets picker that descend from it (`cursorCloudAvailable` in
`AgentChatPane`), the compiled fleet side panel (`ChatCursorCloudPanel`, still
gated), the phone's Work top-bar button and `CursorCloudPaneSheet`, and the
TUI's `/cloud`. Main deleted `CursorCloudInlineLaunch`; compiled launch is
composer-native, not a strip. When `ade-cursor-cloud` is installed,
`ade cursor cloud <word>` is an alias for that plugin's declared CLI words
(`agents`, `runs`, `artifacts`, `repos`, `me`); `ade cursor cloud models` still
uses the compiled Cursor SDK path because the plugin does not declare `models`.
The alias reads the first STANDALONE positional word, skipping value-carrying
flags, so a flag whose value spells `agents` is not mistaken for the word.
Disable the plugin and the compiled `ade cursor cloud` path returns.

What is gated for Linear, on all four clients:

- Desktop and web — the top-bar quick view and its issue browser
  (`LinearQuickViewButton`, gated inside the component), the Integrations
  settings card (`LinearIntegrationSection`) and its `integrations.linear`
  entry in the settings manifest, in-page search and the palette, the lane badge
  (`LinearIssueBadge`, gated inside the component so all four lane surfaces
  inherit it), the "Copy Linear Issue Link" row in both lane context menus, the
  Create-lane issue row and picker, the composer's issue attach row and the
  transcript's issue detail pane, session-card `ENG-123` linkification, the
  Create-PR modal's issue card and close-on-merge checkbox, the automations
  Linear trigger source, its ingress row and its two Linear templates, the
  `ade://linear-issue/…` deeplink, and the palette's Linear search results.
- iOS — `PluginPresenceGate`'s `linear` case, the Work top-bar Linear button,
  the Linear pane sheet and its presentation flag, the lane issue badge, the
  copy-issue-link menu row and action, the chat header's attach-issue row, the
  Settings Linear connection card, and the `ade://linear-issue` deeplink.
- TUI — all seven `/linear` commands, through the `builtin` field on the command
  spec.

**The rule the list follows: gate entry points and connection UI; keep read-only
rendering of data the user already has.** A quick-view button, a settings
connection card, an attach row and a create-lane picker are doors into the
compiled integration and they close. A badge showing the issue a lane already
carries is data the user has, and it keeps rendering — it simply steps aside for
the plugin's own badge so two Linear chips never sit on one row.

`ade-linear` reaches its own connection through the two verbs the polarity makes
necessary: [`credentialHandoff`](#inheriting-a-connection-ade-already-holds) on a
machine that is already connected, and
[`auth.officialClient`](#borrowing-ades-own-oauth-client) on one that is not.

The compiled Linear code is NOT deleted by any of this. It is still there, still
compiled, and still what the product runs on a machine without the plugin.
Deletion is a later step — see [Program status](#program-status).

What is gated for Review: the compiled Review rail tab and `/review` (a
bookmark at `/review` redirects to `/plugin/ade-review` once the plugin is
installed), the PR-detail "ADE review" button, and `ade review` once the plugin
declares those CLI words. Submit review on a GitHub PR stays — that is GitHub's
own review, not ADE's. The engine (`review.*`) stays in core.

What is gated for Electron Control and iOS Simulator: the compiled Work-rail
tabs. Chat companion drawers stay compiled and host-gated (Mac / CDP) in both
polarities, because adding to chat and PTY insert are the same wiring either
way. Install the plugin and the Work rail mounts the same compiled pane through
a `work-rail-pane` (no attribution chrome, native rail colour). Disable it and
the compiled tab id comes back. Phone and terminal list a bound status row;
they never compiled those panes. `ade app-control` and `ade ios-sim` stay on
the host.

**The Work rail through the install window.** The gate hides the compiled tab
one tick before the plugin's pane arrives, so the compiled Control/Simulator tab
keeps its slot while both are visible and the reader never sees two identical
buttons. A persisted `ios` selection heals on a host where the pane can never
arrive — a non-Mac, or a remote checkout — rather than sitting under a Git pane
forever. A persisted plugin slot waits for the registry before it remaps, because
"not resolved yet" is not "the plugin is gone".

**A redirect to a plugin route keeps the query.** A deeplink or a stored route
naming a superseded compiled surface carries its search and hash across the hop,
so `#/graph?focusLane=…` reaches the plugin tab with a lane to focus.

### Agent tooling

An `enables` plugin's ADE action domains leave with it. `BUILTIN_SURFACE_OWNERS`
in `shared/plugins/builtinSurfaces.ts` carries an `actionDomains` list per
surface, and `resolveDisabledActionDomains()` turns that plus the install
registry into the set to refuse. Every registered surface supersedes today, so
that list is empty: Graph, History, Control and Simulator are views over host
engines, and Review/Linear withhold verbs by name rather than refusing a
domain.

A `supersedes` surface refuses NOTHING, and gets a second mechanism instead. The
owner row carries an `actionNames` list of `"<domain>.<action>"` strings, and
`resolveHiddenActionNames()` withholds them from the three places ADE lists
actions to an agent — the automations action picker, `list_ade_actions`, and the
automation ADE-action registry. It is a withholding, not a refusal: the verbs
still dispatch, so a chat already bound to a cloud agent or a Linear issue keeps
working. What stops is ADE advertising a surface the user can no longer see.

Three surfaces use it, for three different reasons:

- **Cursor Cloud** has no domain of its own: all twenty verbs live in `ai`, next
  to `getStatus`, every API-key verb and the Cursor CLI login, so refusing that
  domain would take the model picker with it. The `cursorAuth*` verbs are
  deliberately off the list — that is the Cursor API-key connection, which the
  Cursor chat provider and CLI still need.
- **Linear** has three domains of its own — `linear_credentials`, `linear_oauth`
  and `linear_issue_tracker` — and still may not refuse them, because it
  supersedes. Those verbs are ADE's compiled Linear integration, which every
  machine without the plugin still runs. Refusing
  `linear_issue_tracker.listIssues` because `ade-linear` is installed would fail
  the calls the plugin exists to take over. So all thirty names are on the
  `actionNames` list and `actionDomains` is empty.
- **Review** has a `review` domain of its own and still may not refuse it: the
  plugin's tools and panels call those verbs. They leave the catalog by name
  once `ade-review` is installed.

The sync command surface follows the same polarity: `buildSurfaceUnavailableDenial`
asks `builtinSurfaceDrawn`, not `builtinSurfaceInstalled`, so a paired phone
reaches ADE's compiled Linear commands on a machine with no plugin and is told to
use the plugin's own screen on a machine that has one. The two refusals read
opposite ways, which is why the function is named for the surface being
unavailable rather than missing: an `enables` surface would answer "this machine
doesn't have the plugin", and a `supersedes` one answers "the `ade-linear`
plugin provides Linear on this computer. Open it from the plugin's own
screen." Telling the user to install a plugin that has already arrived and
taken the surface over would be the opposite of the truth. A null answer means
only "ADE still draws this surface here" — a cold catalog never becomes a pass,
because a sync command has no generic fallback and failing open would leave every
paired phone reading and writing through a plugin the machine no longer has
(`gatedActionDomains.ts:296-330`).

### Recording audio: `ade.audio.captureClip`

Speech used to be compiled into ADE — a whisper binary and a 141 MB model. It is
gone: there is no speech model, no transcriber and no dictation setting left in
core, and no built-in surface for voice. What replaced it is a **generic
capability any plugin can use**, because the one thing a plugin child genuinely
cannot do is reach a microphone.

```
ade.audio.captureClip({ maxDurationMs? }) -> { audioPath, durationMs }
```

The clip is a plain WAV on the same machine, deliberately outside any sandbox,
read with ordinary `fs`. A path rather than the bytes: both processes are local
and a two-minute clip would otherwise be encoded and decoded twice through the
RPC envelope. ADE never interprets the audio — whether it becomes a transcript,
a memo or a classification is the plugin's business, and the host never learns
which.

The user is always in control and always told who is asking. A capture puts an
**attributed pill** in ADE's chrome carrying the plugin's *manifest* display
name — never a string the plugin passes in, because a requester that could name
itself could name someone else. The recording ends when the user stops it or
`maxDurationMs` elapses; dismissing the pill rejects with
`audio_capture_cancelled`. There is one microphone, so a capture requested while
another runs is refused with `audio_capture_busy` rather than queued: a plugin
that waited its turn would start recording at a moment the user has no reason to
associate with it. Clips are caller-owned once handed over, and ADE sweeps
whatever a crash left behind on its next start.

The refusal is **policy, never a missing method**. A client that reads
`methodNotFound` concludes the host is too old and silently takes a legacy path,
which is how a scope denial once turned into a wrong fallback here. A gated
domain exists and is spelled correctly, so it answers `policyDenied` with
`data.kind = "plugin_not_installed"`. Every dispatch path asks: `run_ade_action`
and `list_ade_actions` in `adeRpcServer.ts`, the plugin-to-plugin action bridge
and the automations registry in `bootstrap.ts` and `main.ts`, the Settings
action picker over IPC, and the nine `cto.*Linear*` sync commands phones and the
web client call (via `requiresBuiltinSurface` on the sync registrar). The set is
memoized and dropped on `plugin_changed`, so an install takes effect without a
daemon restart.

**The copy comes from the catalog, not from a table of plugin names.** The
shared table supplies only the join key — which plugin id owns the domain — and
the display name is read from the bundled package manifests, then the cached
registry index: *"This machine doesn't have Linear. It's provided by the
ade-linear plugin — available in the Marketplace."* When neither catalog knows
the plugin there is **no invented hint**: the caller keeps its ordinary
unavailable-domain error, because telling a user to install something ADE cannot
name is worse than a plain failure. Automations record the sentence verbatim on
the run row, so a rule that breaks on an uninstall says why.

None of this fences off the underlying capability. An agent still has `xcrun
simctl`, the Linear REST API and AppleScript; what a plugin carries is ADE's
premium layer over them — typed actions, proof capture, lane and chat context.

### Connections leave with the plugin

Uninstalling deletes the account link the plugin existed to hold.
`cleanupUninstalledPluginData` already freed the plugin's project rows and its
SDK secrets; it now also calls `disconnectAccountsForPlugin`, supplied late
through `PluginMachineContext` because the credential services are built long
after the host. The daemon wires it to `linearCredentialService.clearToken()`
for `ade-linear` — keyed off the shared owner table, not a literal id — so the
stored token, refresh token and expiry go with the package. The uninstall dialog
says "This disconnects Linear." before the user commits, and a reinstall starts
disconnected. The disconnect runs last and its failure is logged rather than
thrown, so it can never strand the data and secret cleanup ahead of it.

Two scope caveats worth knowing. The credential service reachable from the
daemon is bound to one project's `.ade/secrets`, so a machine-scoped uninstall
clears the Linear credentials of the project scopes currently running rather
than every scope on disk. And `clearOAuthClientCredentials()` is deliberately
NOT called: a custom OAuth app is the user's own configuration, not the
connection this plugin owned.

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

For an id in both indexes, the higher version wins, and a tie goes to the live
index. So an index generated before this build cannot replace a newer bundled
plugin with older code. A bundled winner keeps its in-app install source and
inherits the live entry's installs, stars and publish date. A live winner
inherits the bundled manifest only when the two versions are equal, because a
newer published manifest is unknown here.

### Client entry points

| Client | Entry |
|---|---|
| Desktop | Plugin tabs below the nav divider; Marketplace above Account. The Marketplace is a machine-level route whose plugin calls follow the project tab's runtime, so it shows and acts on the bound machine; a machine that cannot answer for its registry gets a named state line and read-only browsing, never a spinner; panels via the vocabulary renderer. A `webview` surface joins the same rail and draws the plugin's own page instead of a panel |
| Web | Same React renderer, view-scoped data over a roster-style `plugin_subscribe` stream; Marketplace and plugin tabs lazy-loaded and absent from the sign-in graph. `/plugin/:id` is a route root, so a reload or a shared link lands in the App and `PluginTabPage` gives the real answer — the panel, "Not installed here", or "Turned off" — rather than dropping the reader at the welcome surface. A page draws in a sandboxed same-origin iframe served by a service worker, and the page host itself is lazy-loaded |
| iOS | Read and action-invoke only — no local CRR writes to `plugin_*`; a page's writes and config go to the machine as remote commands. Panes mount as a sheet from an overflow menu and the machine screen, with a back stack over the plugin's panels. A plugin that ships a page draws it in a `WKWebView` when the phone holds the assets, and the panel when it does not |
| TUI | `/plugin-view [plugin]` opens a panel in the right pane; forms go through the composer prompt line; `Ctrl+Y` copies an `ade://plugin/<id>/<panel>` link to the open panel (and still copies a lane or PR link when one of those rows is focused) |
| CLI | `ade plugin …`, `ade <pluginId> <cmd>` for manifest-declared CLI words, and `ade link plugin <plugin-id> <panel-id> [--ctx '<json>']` to mint a panel link |
| Chat | The `plugin_install` `ade_card` variant, for agent-built install flows. The whole lifecycle is reachable this way: `install` asks once per source, and `uninstall`/`enable`/`disable` ask every time |

**The terminal profile.** The terminal draws a FROZEN subset of the vocabulary,
not all of it: `stack`, `group`, `text`, `badge`, `button`, `list`, `emptyState`
and `divider`. Owner decision, `docs/reports/plugin-page-tier-spec.md` section 1
— the webview is the primary page tier on desktop, hosted web and iPhone, so the
terminal keeps the six content nodes a 44-column pane draws well plus the two
structural ones it already drew for free. Every other component — `markdown`,
`table`, `keyValue`, `form`, `segmented`, `canvas`, `avatar`, `video`, `image`,
`chart` — degrades to the pane's existing marker. The marker's first line is the
honest sentence `table is not drawn in the terminal`, naming the component the
schema actually used; its second line carries the node's own title, if it has
one, ahead of the way to see it (`Ctrl+Y` when the panel declared a deeplink,
`ade open` when it did not). A `button` whose action answers with a `prompt`
still takes input, which is how the terminal asks a question now that `form` is
frozen, and a list row's badge, avatar and markdown still draw, because they
belong to `list`.

The one list is `PLUGIN_TERMINAL_PROFILE_NODES` in
`apps/desktop/src/shared/plugins/vocabularyNodes.ts`; the pane gates on it
through `isTerminalProfileNode` rather than repeating it, and a test walks the
constant to prove the two agree. The vocabulary is FROZEN, not deleted: every
component still parses identically on every client, the frozen render arms are
still in `pluginPane.ts` behind `TERMINAL_PROFILE_ONLY`, and the deletion later
is one flag and one sweep.

**What the terminal draws inside the profile.** An icon flows through the
`group`, `badge`, `button`, list-item and empty-state rows. A `brand:*` token
prints one mono mark, or the unknown mark when nobody shipped that artwork, and
never the raw token. A list row keeps its badge, its avatar, its `mono` line and
its markdown, because all four belong to `list` rather than to a frozen node.
That row markdown is the one place a table still reaches the pane: it sizes to
the width and truncates a cell rather than wrapping it, because a wrapped row
turns a grid into a paragraph, and a link inside a cell prints its destination
beside its words while an image prints its alt. A STANDALONE `markdown` or
`table` node draws the marker instead.

**The iOS back stack.** `navigate` used to REPLACE the pane in place and clear its
state, so a plugin sending a reader from a list into a detail screen gave them no
way back — and if they found one, handed back a panel with its filters reset, its
ticks gone, its sections re-opened and its scroll at the top. A detail screen a
reader cannot leave is not a detail screen. `PluginPanelStackEntry`
(`PluginPaneStore.swift:164-180`) pushes a SNAPSHOT: the panel id, its title, its
render context, the panel state, the row selection, the collapsed group
overrides, the per-list page counts, the scroll offset — and the state and
selection SIGNATURES beside the values. The signatures ride along because
restoring values alone would put them in front of `adoptStateControls` with an
empty signature, which reads as a fresh open and rebuilds them from the schema's
defaults: the restore would silently undo itself.

The schema is deliberately NOT snapshotted. `load()` re-derives the declarations
from the schema as it stands now, and the restored signatures are what decide
whether the restored values survive that. The stack is capped at 8 with the
oldest dropped, so a plugin navigating in a loop cannot grow it without bound.
The panel picker EMPTIES the stack rather than pushing onto it: it is a lateral
move between the plugin's top-level panels, not a drill-down.

**The desktop back stack.** Desktop plugin tabs have the same stack with the
same semantics, and it arrived for the same reason: a `navigate` replaced the
panel with nothing behind it, and the browser Back the URL implies is not
available inside the desktop app at all. A push writes the destination to the
URL, so it is the same address a `plugin` deeplink would have produced —
shareable, restorable and reachable by Back — while the entry beneath it holds
the address being left plus a SNAPSHOT of everything client-local: the panel
state, the row selection, the collapsed groups and the per-list page counts. The
snapshot is held in the component rather than written to the query, because it
is the reader's state and none of it belongs in a shareable address. A pop is a
Back control, Escape, or `Mod+[`. Escape yields to any layer above the panel —
a plugin's own prompt card, a `navigate:popover` panel, a row's overflow menu —
checked against the document rather than by listener order, because both
handlers live on `window` and which one React mounted first is not a contract.
The cap is eight with the oldest dropped, the number iOS uses.

A plugin panel is addressable: `ade://plugin/<plugin-id>/<panel-id>[?ctx=<json>]`,
with the `https://ade-app.dev/open?type=plugin&plugin=…&panel=…` form alongside
it. It is the one target kind whose destination may genuinely not exist on the
receiving machine — plugins are installed per machine — so clients say so
plainly rather than redirecting to the Marketplace. Full grammar and routing
ladder in [Deeplinks](../deeplinks/README.md).

### Program status

The platform exists to carry ADE's own compiled features out of the binary. This
is where that stands today, on this branch.

The page tier is built on all three hosts and no official plugin ships a page
yet. The `ade-linear` port to the page tier is IN PROGRESS. Every plugin below
therefore still draws vocabulary panels, and the table describes that.

| plugin | polarity | own code | state |
|---|---|---|---|
| `ade-linear` | `supersedes` | 8,795 lines (14,296 with its tests) | A real plugin. Panels, sockets, tools, CLI words, automation triggers and steps, a webhook channel, a sign-in flow, a credential handoff and a URL matcher |
| `ade-cursor-cloud` | `supersedes` | 3,439 lines (4,643 with tests) | A real plugin, with a chat runtime. Composer Send is claimed via `ownsSend` (Enter launches the cloud agent from the live draft; Advanced still opens the form). Fleet Automations strip reads `webhooks.status()`. `{openSettings}` opens the Cursor provider page or the host Secrets tab. The rail tab carries an unread-finished badge (`row-badge` on `app`, cleared by `viewAction`). Landed: `ade cursor cloud` aliases the plugin's CLI words when it is installed; plugin-owned cloud chats stamp `cursorCloudAgentId` so Cursor's rename lock applies; create sends REST `model: { id, params? }` and fails closed when the form named reasoning or speed the catalog cannot express; finished-run artifact files are host-fetched into the lane cache. |
| `ade-graph` | `supersedes` | real plugin | A real plugin. Desktop, web, and iOS draw the plugin's Graph page (React Flow inside the guest). Phone and TUI keep the vocabulary panels (`graph` list, `lane` detail); wave 2 does not ship a phone Graph page. The host workspace engine stays in core until the compiled tab is deleted after the walk. |
| `ade-review` | `supersedes` | real plugin | A real plugin. Desktop draws the Review page (runs, launch, findings, learnings, PR toolbar). Phone and TUI keep the vocabulary panels; compiled Review was desktop-only. The engine stays in core. |
| `ade-history` | `supersedes` | real plugin | A real plugin. Desktop draws the History page (commit DAG and activity timeline inside the guest). Phone and TUI keep the vocabulary panels; wave 2 does not ship a phone History page. The git and operation engines stay in core. |
| `ade-ios-sim` | `supersedes` | real plugin | A real plugin. Desktop mounts ADE's compiled Simulator pane (`canvas` / `simulator`); phone and terminal list a status row. simctl/idb stay in core. Compiled Simulator was Mac-only. |
| `ade-app-control` | `supersedes` | real plugin | A real plugin. Desktop mounts ADE's compiled Electron Control pane (`canvas` / `electron-control`); phone and terminal list a status row. CDP stays in core. |

`plugins/` also holds two plugins that are not part of the extraction — `ade-voice`
(1,659 lines) and `ade-log-viewer` (489) — plus three themes. They add capability
rather than replacing a compiled surface, so neither polarity applies to them.

Every extracted product is a real `supersedes` plugin. A **gating shell** — a
package that ships no code and only unlocks a compiled surface — is no longer
the shape of any official plugin. The `enables` polarity stays in the table so a
future vertical can gate a compiled pane without inventing a second table.

**The acceptance test.** One build, every plugin installable, and for each of
them:

1. Before install, ADE looks exactly as it always has — the compiled surface is
   there, on the Mac and on the phone.
2. Install the plugin.
3. Every compiled surface it supersedes is gone, on the Mac and on the phone.
4. Everything the compiled surface did works, from the plugin, on both.
5. Disable the plugin, and the compiled version returns unchanged.

Only when every plugin passes does the branch go to `main`. Deleting the compiled
code is the step AFTER that, never before it.

## Accepted v1 limitations

Stated plainly because each one is a deliberate scope decision, not an
oversight:

- **A `webview` surface is the page on desktop, hosted web, and iOS.** The
  phone draws it in a WKWebView from a content-addressed cache (official
  plugins ship a pre-seeded copy inside the app). `parseSurfaces` still forces
  `mobile: false` on the kind, so the phone never *lists* a webview as a tab of
  its own — it opens the page through a socket or a bundled host. The TUI has
  no guest and draws the surface's `panelId` panel instead, using the frozen
  terminal profile (`list`, `group`, `text`, `badge`, `button`, `emptyState`).
  A phone with no cached page, and a client older than the page host, do the
  same.
- **A page cannot write collections unless the plugin host is in-process.**
  `collections.put` reaches the host service's own writer, and nothing assigns a
  plugin host in the Electron main process — the host is a machine-scoped
  singleton in the daemon — so a page's write is refused with
  `plugins_unavailable` ("This page can't save data on this computer.") while
  reads and `invoke` fall through to the project runtime and work. A page that
  needs to persist calls its own action and lets the child write. Routing the
  write instead would mean a write action on the closed `plugin` domain, which
  every client can call for every plugin.
- **iOS draws 11 of the 23 socket kinds.** `slash-command`,
  `command-palette-action`, `settings-section`, `work-rail-pane`, `drawer-tab`,
  `dialog-section`, `graph-node`, `composer-menu-item`, `chat-menu-item`,
  `machine-entry`, `automation-trigger-tile` and `automation-template` decode
  as `.unsupported` and draw nothing, because the phone has no host for any of
  them. A later iOS build adds a rendering arm with no wire change.
  `graph-node` is the one whose absence is a fact about a whole TAB: the phone
  ships no Graph canvas, so the kind cannot be grown without first growing the
  tab. Wave 2's five new kinds follow the same rule: they ship on desktop and
  web first.
- **The TUI draws 3 of the 23 socket kinds** — `row-badge`, `row-menu-item` and
  `toolbar-action` — and only on the `lanes` and `work` surfaces, which are the
  surfaces it lists rows for.
- **iOS renders 17 of the 18 v1 components.** `chart` shows a named marker: a
  sparse line or bar chart is the least useful thing to squeeze onto a
  phone-width panel and the most expensive to draw well. `canvas` draws as a
  list of the same bound rows the desktop paints with a host engine.
- **The TUI renders 15 of 18.** `video`, `image` and `chart` show named
  placeholders. `canvas` draws as a list. An `avatar` draws as `[JD] Jane Doe` — initials, never a photo.
- **A plugin ships a brand glyph as a path-only SVG.** ADE still ships five
  vendor marks (`brand:claude`, `brand:codex`, `brand:cursor`, `brand:github`,
  `brand:openai`) because those logos already live on every client. Any other
  vendor is declared on the manifest as `brandIcons: { "linear": "icons/linear.svg" }`.
  The host sanitizes the file to a viewBox plus paths, writes it into the reserved
  `ade.brandIcons` collection, and every client draws `brand:linear` from that
  list. A suffix the plugin did not ship still puzzles, identically. Badges,
  list-item badges, and `emptyState` still skip brand tokens.
- **A `segmented` with `onChange` already writes locally first.** The control
  shows the new value on press, then dispatches. Collection-backed copy beside
  it (a `keyValue` status row, a bound list) still waits for the plugin to
  republish. There is no overlay of in-flight writes onto bound rows.
- **A `{prompt}` may carry `options`.** A one-hop question with a closed list is
  a picker — "link this to a lane" — rather than a text field. Desktop and web
  draw a scrollable list, iOS a sheet (an alert cannot host eighty lanes), and
  the TUI matches typed text against value or label and refuses a miss. Without
  `options` it is still one line of text. Either way, one hop: a re-invocation's
  own `{prompt}` is ignored. A form `select` holds 80 options, the same ceiling.
- **iOS renders a plugin's URLs as plain links.** The phone's smart-link detector
  is a hardcoded four-provider host test and reads no `urlMatchers`, because
  manifests never replicate to a phone — it sees a contribution only when the
  plugin published one. So a plugin-declared URL gets no chip and no attribution
  there, while desktop, the web client and the composer's tokenizer all draw it.
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
- **A PR body still renders Linear references only.** `collectLanePrIssueRefs`
  is provider-neutral, but `collectLinearPrIssueReferences` filters to
  `provider === "linear"` before writing the "Linked Linear issues" block
  (`prService.ts:912`), so a Jira link is carried that far and dropped rather
  than rendered under a heading it does not belong to. The renderer for a
  third-party tracker arrives with the plugin that produces it.
- **A closing magic word is only emitted for `github` and `linear`.** Those are
  the two trackers that actually perform the close on merge. Every other
  provider gets `Refs` regardless of `closeOnMerge`, because `Fixes ABC-12` in a
  GitHub PR body is inert text and emitting it would advertise a state
  transition that never happens.
- **Tracker ownership is derived, never declared.** `resolveIssueDeeplinkRouting`
  defaults its `owners` list to `issueProviderOwnersFromMatchers(input.plugins)`,
  so an `ade://issue/jira/…` link opens through whichever plugin declares a
  `urlMatchers` entity for `jira` on the receiving machine. There is no separate
  "I own this tracker" field, on purpose — two declarations could disagree — so a
  plugin that reads a tracker's issues but recognises none of its URLs owns
  nothing. With nobody claiming `linear`, the link goes to the compiled Linear
  surface, exactly where `ade://linear-issue/…` has always gone.
- **iOS does not parse the `issue` deeplink kind.** `DeepLinkRouter.swift`
  knows `linear-issue` and not `issue`, so `ade://issue/jira/PROJ-9` falls to
  its `default` arm and opens nothing on a phone. Desktop, the web client and
  the CLI all handle it. The iOS *lane badge* is migrated — it reads the ref
  and shows a non-Linear tracker's own key, title and state — so this is a
  routing gap, not a rendering one.
- **A plugin cannot set a lane's primary issue.** `linkIssueRef` writes
  `lane_linear_issue_links`; `LaneSummary.primaryIssue` is derived from the
  lane's own `lane_linear_issues` row, which only ADE's
  create-a-lane-from-an-issue path writes. `role: "primary"` on a plugin's link
  is recorded and read back, but the link lands in `issueLinks`.
- **A plugin cannot create a lane, only link to one.** `ade.lanes` is `list`,
  `get`, `listSessionIssues`, `linkIssue`, `unlinkIssue`. `issueRefBranchName` /
  `issueRefLaneName` exist and are proven byte-identical to the Linear
  derivation, but every lane creation path still calls `linearIssueBranchName`.
- **Only `pr.changed` carries transitions.** `lane.changed` and `session.changed`
  are ids and a project root; their producers hold no previous state to compare
  against. A plugin wanting a lane's lifecycle position re-reads the lane.

## Cross-links

- [Sync and multi-device](../sync-and-multi-device/README.md) — CRR tables, the
  hello capability handshake, remote commands. The
  [CRDT model](../sync-and-multi-device/crdt-model.md) carries Rule 4, the
  version-inside-the-JSON rule both the plugin tables and the issue link follow.
- [Files and editor](../files-and-editor/README.md) — the viewer registry the
  `file-viewer` socket extends.
- [Pull requests](../pull-requests/README.md) and [Lanes](../lanes/README.md) —
  the surfaces row badges and menu items attach to.
- [ADE Code](../ade-code/README.md) — `/plugin-view` and the right-pane
  interpreter.
- [Deeplinks](../deeplinks/README.md) — the `plugin` target, its `ctx`
  parameter, the provider-neutral `issue` target, and the per-client routing
  ladder.
- [System overview](../../ARCHITECTURE.md) — IPC contract, action registry, data
  plane.
- [registry/README.md](../../../registry/README.md) — the plugin directory, its
  curation model, and extraction steps.
- Authoring reference for agents:
  `apps/desktop/resources/agent-skills/ade-plugins/SKILL.md`.
