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
| `apps/desktop/src/main/services/plugins/pluginInstallApproval.ts` | Turns an agent's `plugin.install`, `uninstall`, `enable` and `disable` into a card in that agent's own chat. Install approvals are remembered per `(pluginId, resolved source, disclosed grant)`; removals never are |

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
or auditing it — the webview tier was strictly stricter than the child tier that
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
- The remembered install approval is keyed on the declared hosts and provider
  keys as well as the source, so a later save that widens either raises the card
  again instead of riding an approval given for something narrower.

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
  declared channel only. The Marketplace detail page shows the same URLs with a
  Copy button, and `ade plugin doctor` grows a **Webhooks** rung, because the
  person setting the integration up is usually looking at a plugin that is
  installed and not running.

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
| `setArtifacts(sessionId, artifacts)` | Lane-relative files, drawn as a proof-artifact card. |
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
(100) the ceiling that actually applies. The caps on `actions` and `overflow`
count what survived parsing rather than what was offered, so a refused entry does
not spend a slot a valid one needed — and every client counts the same way.
Desktop, web and iOS draw the overflow behind a menu; the TUI draws `actions` and
`overflow` as one numbered key list, because a terminal has no menu and showing
what a row can do beats hiding half of it.

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
  because in-app destinations belong to `navigate` and `fallback.deeplink`,
  which pass an installed-and-enabled gate this would bypass. Every open is
  logged with the plugin id.
- **`message`** (`readPluginActionMessage`) is one sentence about how it went.
  Two shapes reach the renderer and both are normal: over sync the host wraps a
  handler's return as `{ok, message?, result}`, while the desktop's local IPC
  hands the return back untouched. Reading both is what stopped "Created lane
  'x'." from appearing in the web client and vanishing on desktop, from one line
  of plugin code. iOS and the TUI have shown it since the verb existed; desktop
  and web draw the same banner, auto-dismissing after six seconds or on the next
  dispatch.

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

### Agent skills

A plugin owns its agent skills the same way it owns its UI. `skills` in the
manifest lists directories **containing** skill directories — `"skills": ["skills"]`
resolves to `<plugin>/skills/<skill-name>/SKILL.md` — and
`listPluginAgentSkillRoots()` answers with the roots of installed, enabled
plugins only. Those roots are appended to `ADE_AGENT_SKILLS_DIRS` for every
runtime, passed to Codex as `skills/extraRoots`, handed to Claude as
`--plugin-dir` (which is why a plugin skills root ships a `.claude-plugin/plugin.json`
marker, since Claude reads plugin roots and never the env var), and listed by
`ade skill list`. So the install gate is the only mechanism: `ade-linear`,
`ade-ios-simulator` and `ade-app-control` live in
`plugins/<id>/skills/` rather than in ADE's shared bundled root, and a machine
without the plugin never loads them. The capability underneath is not fenced
off — `xcrun simctl`, the Linear API and AppleScript are still there; what the
plugin carries is ADE's premium layer over them.

### Agent tooling

A plugin's ADE action domains leave with it. `BUILTIN_SURFACE_OWNERS` in
`shared/plugins/builtinSurfaces.ts` carries an `actionDomains` list per surface
— `ade-linear` owns `linear_credentials`, `linear_oauth` and
`linear_issue_tracker`; `ade-ios-sim` owns `ios_simulator`; `ade-app-control`
owns `app_control` — and `resolveDisabledActionDomains()` turns that plus the
install registry into the set to refuse. Graph, Review and History list nothing:
they are views over state other domains already own, so there is nothing of
theirs to refuse.

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

### Client entry points

| Client | Entry |
|---|---|
| Desktop | Plugin tabs below the nav divider; Marketplace above Account; panels via the vocabulary renderer. A `webview` surface joins the same rail and draws the plugin's own page instead of a panel |
| Web | Same React renderer, view-scoped data over a roster-style `plugin_subscribe` stream; Marketplace and plugin tabs lazy-loaded and absent from the sign-in graph. A `plugin` deeplink has no hosted route — `targetToWebPath` answers null and each caller degrades where the user can see it |
| iOS | Read and action-invoke only — no local CRR writes to `plugin_*`. Panes mount as a sheet from an overflow menu and the machine screen |
| TUI | `/plugin-view [plugin]` opens a panel in the right pane; forms go through the composer prompt line; `Ctrl+Y` copies an `ade://plugin/<id>/<panel>` link to the open panel (and still copies a lane or PR link when one of those rows is focused) |
| CLI | `ade plugin …`, `ade <pluginId> <cmd>` for manifest-declared CLI words, and `ade link plugin <plugin-id> <panel-id> [--ctx '<json>']` to mint a panel link |
| Chat | The `plugin_install` `ade_card` variant, for agent-built install flows. The whole lifecycle is reachable this way: `install` asks once per source, and `uninstall`/`enable`/`disable` ask every time |

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
