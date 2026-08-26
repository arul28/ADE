# Cursor Cloud → official Marketplace plugin: extraction spec

Branch: `plugin-platform`. Date: 2026-08-26. Read-only research pass; no product code changed.

Audience: the owner who funds the work, and the builders who split it. Every claim is anchored to
`file:line` against the working tree of `plugin-platform` on 2026-08-26.

Two files carried uncommitted edits from a parallel agent while I read them
(`cursorCloudFleetService.ts`, `aiIntegrationService.ts`, and a new
`apps/desktop/src/shared/cursorCloudApiLimits.ts`). Line numbers in those three files may move by a
few lines.

---

## 0. The verdict in one page

Cursor Cloud is not one feature. It is **four** features that share a name and an API key:

1. **A fleet panel.** A list of cloud agents with filters, rows, actions and a detail view. This is
   the part everybody pictures. It is the smallest part.
2. **A chat runtime.** A Cursor Cloud agent *becomes an ADE chat session*. ADE hydrates the cloud
   conversation into the transcript, dispatches follow-up turns to the cloud, streams the reply
   back, materializes artifacts into the lane and emits `ade_card`s. See
   `agentChatService.ts:38144-38449` (`runCursorCloudTurn`) and `:38915-39061`
   (`attachAndHydrateCursorCloudChat`).
3. **A webhook ingress.** Cursor posts status events to ADE's Cloudflare relay; the desktop drains
   them on a 45-second timer, dedupes them in sqlite, and fans them out to the chat service, the
   renderer and the automations engine. See `cursorCloudIngressService.ts:305-372` and
   `main.ts:4336-4362`.
4. **A launch path in the composer.** A "Cursor Cloud" machine row in the draft launch shelf, an
   Advanced menu, a secrets picker and per-lane secret memory. See `AgentChatPane.tsx:11682-11706`
   and `CursorCloudAdvancedMenu.tsx`.

Feature 1 nearly fits the plugin platform today, and closing its gaps is small-to-medium work.
Feature 3 needs one real new platform capability. Feature 4 needs two. **Feature 2 is the long
pole**: no seam exists anywhere in the plugin platform that lets a plugin own a conversation, and
building one is the single largest item in this spec.

If the owner wants the fleet panel as a plugin, that is a 3-week shape. If the owner wants Cursor
Cloud **fully** extracted, plan for the chat-runtime seam first, because everything else waits on
nothing and it waits on nobody.

**The C-class gaps** — capabilities the platform does not have at all:

| id | gap | size |
|---|---|---|
| PX-3 | Client-evaluated panel state. A plugin panel cannot hold a filter, a segmented control or a toggle whose change re-renders the panel without a round trip to the plugin child. | L |
| PX-7 | Declared, disclosed outbound network. The plugin child is a plain `spawn(process.execPath, …)` (`pluginChildSupervisor.ts:424`), so `fetch` works — but there is no manifest declaration, no install disclosure, no host allowlist and no audit. An official plugin that calls `api.cursor.com` with the user's key must declare it. | M |
| PX-8 | Host-brokered provider credentials. `sdk.secrets` is a per-plugin namespace in a separate encrypted file (`pluginSecretStore.ts:54`). The Cursor key lives in the keychain-backed API-key store as `ai.api_key.cursor.v1` (`apiKeyStore.ts:214-216`). Without a broker, users paste the same key twice. | M |
| PX-9 | Webhook ingress routed to a plugin. A plugin can *emit* an automation trigger (`sdk.ts:583`). Nothing can *receive* a relay webhook on a plugin's behalf. | L |
| PX-10 | A plugin as a conversation source. `AgentChatProvider` is an open string union (`chat.ts:17`), but every turn path is a hard switch in `agentChatService.ts`. A plugin can create a session (`registry.ts:603`) and emit cards (`:607`); it cannot own the turns. | XL |

Everything else is A (fits today) or B (a small, named platform addition).

**One product answer the code already gives.** There is no way to install a plugin by default, and
that is deliberate: "Nothing is seeded now… a machine with no plugins has no Graph tab, and that is
the correct product, not a degraded one" (`builtinTabs.ts:12-23`). So the extraction cannot be made
invisible to existing users. Section 5.4 proposes the honest alternative — a one-time migration
prompt on machines that have Cursor Cloud state, and nothing on machines that do not.

---

# PART 1 — INVENTORY

## 1.1 Desktop main process

| file | what it does | core seams it touches |
|---|---|---|
| `main/services/chat/cursorCloudFleetService.ts` | Builds the fleet list: lists agents, enriches each with its latest run, matches it to a lane by git remote, resolves or creates a lane, pulls a finished branch into a lane, stops a run. | Lane service, git, origin-remote cache (TTL 60s, `:59`), enrich concurrency 4 (`:55`), budget 100/max 200 (`:57-58`) |
| `main/services/chat/cursorCloudConversation.ts` | Pure helpers: flatten a cloud conversation, unwrap a turn, fingerprint turns for dedupe, decide whether a run is still live, step the poll backoff `[3s, 8s, 20s, 45s]` (`:247`). | None. Pure module. |
| `main/services/chat/cursorCloudMirrorWatch.ts` | A ref-counted timer registry keyed by `sessionId`. Polls the cloud API only while a client watches that chat (`:17-93`). | Timer registry only. |
| `main/services/chat/cursorCloudCreateOptions.ts` | Webhook secret key `cursor.cloudWebhookSecret.v1` (`:24`), HMAC signing (`:134-137`), per-lane secret-name memory `cursor.cloud.laneSecretNames.v1:<laneId>` (`:29`), refusal of `CURSOR_`-prefixed secret names (`:94-98`). | `EncryptedFileCredentialStore` at `<secretsDir>/cursor-cloud.v1.enc` (`:194-203`) |
| `main/services/automations/cursorCloudIngressService.ts` | Registers a webhook secret with the relay, then polls `GET {relay}/cursor/events` every 45s (`:20`, `:388-393`), 500 per page, 20 pages max, persists each event, dispatches, advances the cursor. | `cursor_cloud_ingress_events` table, kv cursor `automations.ingress.cursor.cursor-relay` |
| `main/services/automations/cursorCloudRelayConfig.ts` | Relay base URL resolution and the five kv keys. | kv: `automations.cursorCloudRelay.{apiBaseUrl,secretRef,lastEventAt,lastError,configured}` (`:5-9`) |
| `main/services/automations/cursorCloudAutomationDispatch.ts` | Maps a status event to an automation trigger. Only `FINISHED` and `ERROR` dispatch (`:25-42`). | Trigger types `cursor.cloud_finished`, `cursor.cloud_error` (`types/config.ts:552-553`) |
| `main/services/chat/agentChatService.ts` | The chat runtime. `runCursorCloudTurn` (`:38144-38449`), `openCursorCloudChat` (`:39108-39192`), `attachAndHydrateCursorCloudChat` (`:38915-39061`), `handleCursorCloudStatusChange` (`:38525-38727`), `materializeCloudArtifacts` (`:37934-38060`), `refreshWatchedCursorCloudMirror` (`:39073-39100`). | Session store, transcript, `ade_card`, lane worktree git, exported at `:48920-48924` |
| `main/services/chat/cursorSdkWorker.ts` | Fourteen `cloud.*` RPCs against `@cursor/sdk` (`:930-1095`). Receives the API key in `init.apiKey`. | Worker pool; `cursorSdkPool.ts:106` strips `CURSOR_API_KEY` from the inherited env |
| `main/services/ai/aiIntegrationService.ts` | The non-chat half of the API: repositories, agents, runs, create, archive, delete, usage, artifacts (`:1154-1380`). | `requireCursorCloudApiKey()` (`:1154-1160`) |
| `main/services/ipc/registerIpc.ts` | 21 invoke handlers (`:5446-5645`). | 22 IPC channels, `ctx.cursorCloudFleetService`, `ctx.cursorCloudIngressService` (`:1119-1120`) |
| `main/services/adeActions/registry.ts` | 20 action ids in the `ai` domain (`:708-727`), implementations `:3067-3157`. | Action domain `ai` |
| `main/services/state/kvDb.ts` | `cursor_cloud_ingress_events` DDL (`:3483-3498`). Not a CRR table. Exempt from pruning (`:908-909`). | sqlite |
| `main/services/sessions/chatSessionProjection.ts` | Projects `cursorCloudAgentId` onto the Work row (`:96`). | `types/sessions.ts:309` |
| `main/services/externalSessions/liveChatProviderRefs.ts` | Pushes `cursorCloudAgentId` under provider `cursor` for external-session dedupe (`:68`). | |
| `main/services/localRuntime/localRuntimeTimeoutPolicy.ts` | 120s budgets for `ai.openCursorCloudChat` and `ai.createCursorCloudRun` (`:131-132`). | |
| `main/main.ts` | Constructs the credential store (`:4333`), the ingress fan-out (`:4336-4362`), the fleet event emit (`:4344-4352`), the ingress start/stop (`:4865-4875`, `:5706`). | |
| `shared/cursorCloudFleetStatus.ts`, `shared/cursorCloudRepoMatch.ts`, `shared/cursorCloudApiLimits.ts` | Status folding, repo-match keys, the 100 page ceiling. | |
| `shared/ipc.ts:663-684` | The 22 channel constants. | |
| `shared/types/{chat,sessions,sync,automations,config}.ts` | `cursorCloudAgentId`, `cursorRuntime`, the six sync action names (`sync.ts:2109-2114`), the ingress source `cursor-relay` (`automations.ts:164`), the two trigger types (`config.ts:552-553`). | |
| `shared/syncMobileCompatibility.ts:41-52` | All six Cursor Cloud sync actions are optional descriptors. An older host omits them without marking the phone limited. | |

**Credentials.** Two, in two different stores.

- The **Cursor API key** is `ai.api_key.cursor.v1` in the keychain-backed API-key store
  (`apiKeyStore.ts:214-216`; macOS service `com.ade.desktop.api-keys.v1`, `:57`), with an encrypted
  file fallback at `<ade>/secrets/api-keys.v1.bin` (`:498-499`) and an env fallback `CURSOR_API_KEY`
  (`:52`). Read sites: `agentChatService.ts:7424-7434`, `aiIntegrationService.ts:496-502` and
  `:1154-1160`. The same key powers **local** Cursor chat, which is not part of this extraction.
- The **webhook HMAC secret** is `cursor.cloudWebhookSecret.v1` in a separate
  `EncryptedFileCredentialStore` at `<secretsDir>/cursor-cloud.v1.enc`
  (`cursorCloudCreateOptions.ts:194-203`), minimum 32 bytes (`:25`), generated as
  `randomBytes(32).toString("hex")` (`:205-211`).

**Outbound network.** The Cursor API is reached only through `@cursor/sdk`, never through a
hand-built URL. The one hard-coded Cursor host in the tree is unrelated:
`cursorModelsDiscovery.ts:64`. The relay endpoints ADE calls itself are
`POST {relay}/cursor/register` (`cursorCloudIngressService.ts:223-231`) and
`GET {relay}/cursor/events?limit=500` (`:330-339`), with a 30s abort. The relay default is
`https://ade-github-webhook-relay.arulsharma1028.workers.dev` (`githubRelayConfig.ts:22`).

**Three timers.** The 45s relay poll (`cursorCloudIngressService.ts:20`), the presence-gated mirror
backoff ladder (`cursorCloudConversation.ts:247`), and an 8-attempt / 2s hydrate retry (`:9-10`).

**Database.** One table, `cursor_cloud_ingress_events` (`kvDb.ts:3483-3498`). It is **not** CRR and
is deliberately exempt from pruning (`:908-909`), because it is the replay guard. Chat-side cloud
state (`cursorCloudAgentId`, `cursorRuntime`, `cursorPromotedTurnId`) is written to the per-session
JSON metadata file, not sqlite (`agentChatService.ts:13397-13402`).

**Automations.** The ingress dispatch fan-out at `main.ts:4336-4362` has exactly three consumers, in
order: `handleCursorCloudStatusChange`, the `IPC.aiCursorCloudFleetEvent` project event, and
`automationService.dispatchIngressTrigger`.

**Relay (Cloudflare).** `apps/webhook-relay/src/relay.ts` routes `/cursor/register`,
`/cursor/webhook`, `/cursor/events` (`:2706-2708`), with HMAC verification (`:2360-2374`), a replay
window (`:2511-2514`), event dedupe (`:2524-2529`), and two D1 tables `cursor_webhook_secrets` and
`cursor_events`.

## 1.2 Desktop renderer

| file | what it does | seams |
|---|---|---|
| `renderer/components/app/CursorCloudFleetModal.tsx` | The fleet modal. Portal, scrim, 880×760 dialog. Header, two `<select>` filters, refresh, close. Relay banner. Loading / error / empty / list. Grouped sections. Footer. Toast. | `window.ade.ai.cursorCloudFleet`, `onCursorCloudFleetEvent`, `useAppStore(s => s.refreshLanes)` (`:71`) |
| `renderer/components/app/CursorCloudFleetRow.tsx` | One row: status dot, name, status pill, age, cost chip, mono second line, ownership chip, PR link, Open / Stop / overflow menu, inline expand with usage. | 6 preload calls |
| `renderer/components/app/CursorCloudQuickViewButton.tsx` | Top-bar button with an unread-finished badge. Visibility delayed 4s (`:14`), gated on `ai.getStatus()` (`:52-55`) and on `typeof window.ade.ai.cursorCloudFleet === "function"` (`:49`). | `TopBar.tsx:2222` and `:2236` |
| `renderer/components/chat/CursorCloudAdvancedMenu.tsx` | The live composer menu: Attach-to-PR block or an "Open a PR" checkbox, plus the secrets list. Mounted at `AgentChatPane.tsx:14184-14193`. | `computeLanePopoverPlacement` |
| `renderer/components/chat/CursorCloudSecretsPicker.tsx` | `CursorCloudSecretsList` and `isInjectableCloudSecretName`. Names only; values never leave the host. | `window.ade.projectSecrets.list()` |
| `renderer/components/chat/useCursorCloudDraftState.ts` | Tri-state repo probe, secrets, remembered lane secrets, existing PR, matched repo URL, and the four "unavailable" sentences (`:161-172`). | 4 preload calls |
| `renderer/lib/cursorCloudUtils.ts` | Tone map (`:8-17`), age format (`:19-34`), `cursorCloudAgentWebUrl` (`:74-78`). The file states plainly that the in-app `#/cloud` route is **not** shipped (`:73`). | |
| `renderer/components/chat/ChatCursorCloudPanel.tsx` | **Dead code.** Fully written, mounted nowhere. Disabled at `AgentChatPane.tsx:185-186` and `:12341-12361`. | |
| `renderer/components/chat/CursorCloudInlineLaunch.tsx` | **Dead code.** Superseded by composer-native cloud mode (`AgentChatPane.tsx:187-189`). | |
| `renderer/components/terminals/SessionCard.tsx:915-928` | A violet cloud button on a session card that opens the agent on cursor.com. | |
| `renderer/components/automations/{triggerCatalog,automationCopy,variableCatalog}.ts` | The "Cursor Cloud" trigger source, its two events, and the `{{trigger.summary}}` / `{{trigger.branch}}` variables (`variableCatalog.ts:47-50`). | |

**There is no renderer store slice.** `rg -c "cursorCloud" appStore.ts` returns 0. Every piece of
Cursor Cloud state is component-local. The only store touchpoints are `refreshLanes`, `project` and
`projectBinding`.

**The web client is stubbed.** `webclient/adapter/misc.ts:553-556` implements exactly two of the 22
methods — `cursorCloudOpenChat` and `cursorCloudWatchMirror`. `cursorCloudFleet` is undefined there,
so the quick-view button's probe fails and **the fleet never appears in the web client at all**.

## 1.3 iOS

| file | what it does |
|---|---|
| `Views/CursorCloud/CursorCloudPaneSheet.swift` | Full-screen sheet, `NavigationStack`, route to the detail screen (`:21-26`). The toolbar entry button (`:36-54`) is gated on `supportsRemoteAction("ai.cursorCloudFleet")`. `CursorCloudMark` is a locally drawn shape because the desktop's icon library is not on the iOS target (`:56-86`). |
| `Views/CursorCloud/CursorCloudAgentListScreen.swift` | `List(.plain)`, `.refreshable`, a `safeAreaInset(.top)` chip bar with All/Active/Finished/Failed + lane chips + Archived (`:263-309`), five content modes, group headers, rows, status chips. |
| `Views/CursorCloud/CursorCloudAgentDetailScreen.swift` | Header, facts card, summary card, and a bottom action bar with Open in ADE / Stop / Pull into lane / open on cursor.com (`:120-162`). |
| `Views/CursorCloud/CursorCloudPaneStore.swift` | `reload()` is the only fetch. No timer, no push (`:85-104`). Soft refresh keeps `.loaded` on a failure with existing rows. Grouping mirrors desktop (`:125-173`). |
| `Views/CursorCloud/CursorCloudModels.swift` | Every field optional-tolerant "so an older host cannot crash the pane" (`:3-5`). A custom timestamp decoder accepts epoch seconds, epoch milliseconds or ISO-8601 (`:17-54`). |

**Entry point:** `WorkRootScreen.swift:693`, in the Work tab top bar, immediately after
`PluginEntryMenuButton`. Sheet presented at `ContentView.swift:176-179`.

**Data source:** sync remote commands only. No Cursor credential is on the device and there is no
CRR table. `SyncService.swift:9636-9674` sends `ai.cursorCloudFleet`, `ai.cursorCloudResolveLane`,
`ai.cursorCloudPullIntoLane`, `ai.cursorCloudStopRun`, `ai.openCursorCloudChat`; `:11738-11751`
sends `ai.watchCursorCloudMirror`. Registered at `syncRemoteCommandService.ts:5616-5661`; the two
mutating ones (`resolveLane`, `pullIntoLane`) are `viewerAllowed: false`.

**One live defect worth noting:** iOS calls `ai.cursorCloudFleet` with **no arguments**
(`SyncService.swift:9636-9638`), so it gets the host default, while desktop passes
`{includeArchived: true, limit: 200}`. The two clients therefore show different sets.

## 1.4 TUI and CLI

- **TUI:** one read-only surface. `/cloud` (`tuiClient/commands.ts:124`) → `app.tsx:11345-11370` →
  `getCursorCloudFleet(conn)` (`adeApi.ts:789-793`) → `formatCursorCloudFleetRows`
  (`rightPaneFormatters.ts:566-606`). The footnote says "Read-only here — manage agents on desktop
  or iOS." (`:569`). Presence gating at `app.tsx:4581-4587`.
- **`ade cursor cloud` CLI:** 699 lines in `apps/ade-cli/src/cursorCloud.ts`, talking to
  `@cursor/sdk` **directly**, with no ADE socket and no headless runtime. Six command groups. It
  reads `--api-key` or `CURSOR_API_KEY` and **never** reads ADE's encrypted store (`:201-207`). It
  refuses win32-arm64 (`:50-75`).

## 1.5 What does not exist today

- **No notifications.** The fan-out at `main.ts:4336-4362` is exhaustive and contains no push. The
  only arrival signal is the top-bar badge.
- **No deeplinks.** `cursorCloudUtils.ts:73` states it: the in-app `#/cloud` route is not shipped.
- **No search-index entries.** Nothing under `main/services/search/`.
- **No settings page.** One sentence in `ProvidersSection.tsx:1222`.
- **No docs page.** Mentions only, in `docs/features/chat/README.md`, `composer-and-ui.md`,
  `sync-and-multi-device/ios-companion.md`, `ARCHITECTURE.md` and `changelog/v1.1.9.mdx`.

---

# PART 2 — CAPABILITY MAP

Legend: **A** fits today. **B** fits with a small, named platform addition. **C** needs a real new
platform capability.

## 2.1 The fleet panel

| capability | class | how |
|---|---|---|
| A tab or pane the user opens | **A** | A `tab` surface with a `panelId` (`manifest.ts:172-205`). Reaches desktop, web, iOS and the TUI. **Declare `tab`, not `pane`** — desktop drops non-builtin `pane` surfaces (`preload/pluginBridge.ts:102-116`), while the TUI opens either (`adeApi.ts:1673-1676`). |
| Grouped sections with headers and counts | **A** | `divider{label}` plus `text{variant:"subtitle"}`. Counts are pre-formatted strings; rule 3 forbids interpolation (`vocabulary.ts:35-39`). One `divider` + one `list` per group. |
| Loading / error / empty states | **A** | `emptyState` node plus panel `fallback` (required, `vocabulary.ts:79`). |
| Live updates when an agent finishes | **A** | The plugin writes rows to `plugin_collections`; the CRR table replicates to iOS (`types/sync.ts:170-175`); desktop and web refetch on the `changed` stream; the TUI polls every 10s (`app.tsx:10514-10522`). |
| A row's title, subtitle and a meta string | **A** | `VocabListItem` = `{title, subtitle?, meta?, tone?, icon?, onPress?}` (`vocabularyNodes.ts:182-189`). |
| A row with a **status badge**, a **mono** second line and **three** actions | **C→B** (PX-1) | A list item carries one `onPress`, no badge and no monospace. Building it by hand costs 7 nodes per row against `maxNodes: 200` (`vocabularyNodes.ts:33`), which caps the fleet at **~27 rows**. |
| A **pressable row driven by a collection** | **B** (PX-2) | `coerceBoundListItem` deliberately strips `onPress` (`vocabularyNodes.ts:447-468`). iOS does the opposite (`PluginPaneStore.swift:200` → `PluginVocabularyNodeParsing.swift:108-121`). A bound list is therefore tappable on the phone and dead on the other three. Pick one answer. |
| A **row overflow menu** (Pull into lane / Archive / Delete) | **C→B** (PX-1) | `menu` exists only on socket manifest entries (`manifest.ts:236`), never on a panel node. |
| A **destructive action with confirmation** | **B** (PX-2) | `VocabAction.confirm` exists (`vocabularyNodes.ts:143`) and is honoured by `button` on all four clients, but a **list row press skips it on desktop and web** (`vocabularyComponents.tsx:321` versus `:173`). |
| The **status filter** (All/Active/Finished/Failed), the lane filter and the Archived toggle | **C** (PX-3) | There is no filter, segmented, chip-row or tab node, and no way for any control to change what renders without a round trip. The only expressible form is `form{select, select, toggle} + submit` → plugin action → `panels.update()` → refetch. Three taps and a full round trip per filter change. The `filter-chip` socket kind cannot help: sockets attach only to ADE's own eight surfaces (`sockets.ts:80-89`), and there is no `plugin` surface. |
| **Refresh** | **B** (PX-6) | A `button` node works everywhere. But there is no header slot on any client (desktop `PluginTabPage.tsx:388-430`; iOS `PluginPaneSheet.swift:33-40`; the TUI's `r` key is hard-coded at `app.tsx:17012`), and **iOS has no pull-to-refresh on a plugin pane** while the built-in Cursor Cloud screen does (`CursorCloudAgentListScreen.swift:47`). |
| The footer **"All agents on cursor.com" link** | **C→B** (PX-4) | No node opens a URL. `text` renders as plain text with no linkification (desktop `vocabularyComponents.tsx:90-106`; iOS `PluginVocabularyView.swift:166-176`). The only plugin-authored link in the system is `fallback.deeplink`, which renders **only on the failure card**. |
| The footer **count** | **A** | `text{variant:"caption"}` with the number baked in. |
| The **agent detail drill-down** | **B** (needs PX-1 or PX-2) | `{navigate:{panelId, context}}` (`sdk.ts:654-674`) plus `$context` (`vocabulary.ts:134-142`) already work on all four clients. The detail action bar is a horizontal `stack` of buttons. The blocker is only getting *into* it from a bound row. |
| A **result message** after an action | **B** (PX-5) | iOS renders the envelope's `message` as an inline banner (`PluginPaneStore.swift:334-337`, `PluginPaneSheet.swift:202-222`). The TUI adds a notice (`app.tsx:10825`). **Desktop and web discard it** (`PluginPanelHost.tsx:192-212`). |
| The **top-bar quick-view button with a badge** | **B** (PX-11, optional) | iOS already has `PluginEntryMenuButton` in the same top bar (`WorkRootScreen.swift:693`). Desktop's plugin tabs live in the rail, not the top bar. An unread count on a rail item has no contribution kind today. Acceptable to drop; see the no-regression checklist. |

## 2.2 The chat runtime — the long pole

| capability | class | how |
|---|---|---|
| Create an ADE chat session | **A** | `chat.createSession` is an `ai`-adjacent action a plugin may invoke at agent role (`registry.ts:603`). Not CTO-only. |
| Put a card in a transcript | **A** | `chat.emitAdeCard` (`registry.ts:607`), and `sdk`-side `ade cards` are a first-class plugin capability. |
| **Own a session's turns** — the user types, and the plugin dispatches to Cursor Cloud | **C** (PX-10) | `runCursorCloudTurn` is reached from a hard switch in the send path (`agentChatService.ts:39678`). Nothing lets a plugin register a runtime. |
| **Write assistant text into a transcript** as streamed turns | **C** (PX-10) | `chat.sendMessage` sends *to* an agent. There is no plugin-facing append-assistant-turn API. |
| **Hydrate a foreign conversation** into a transcript with fingerprint dedupe | **C** (PX-10) | `attachAndHydrateCursorCloudChat` (`:38915-39061`) has no plugin-side equivalent. |
| **Presence-gated polling** ("poll only while somebody is looking at this chat") | **C** (PX-10) | The `watchMirror` IPC and its ref-counted registry are core. A plugin's `schedules` API has a **60s minimum interval** (`sdk.ts:1273`) and is not presence-aware, so it cannot express a 3-second ladder that stops when the user leaves. |
| Materialize artifacts into a lane and emit a proof card | **A/B** | A plugin can write files through `actions.invoke("files", …)` and emit an `ade_card`. The 10 MiB cap and path sanitizer would be re-implemented in the plugin. |
| `git fetch origin <branch>` into the lane worktree on FINISHED | **A** | `git.fetch` and `git.pull` are agent-role actions (`registry.ts:436`, `:453`). |
| Adopt a cloud agent as an ADE session ("Open in ADE") | **C** (PX-10) | Same as "own the turns". Creating the session is A; making it a *live cloud mirror* is C. |

## 2.3 The webhook ingress

| capability | class | how |
|---|---|---|
| Fire an automation trigger | **A** | `sdk.automations.emitTrigger` (`sdk.ts:583`), with the trigger declared in the manifest (`manifest.ts:352-359`). This replaces `cursorCloudAutomationDispatch.ts` exactly. |
| Offer the two triggers in the rule builder | **A** | `automationTriggers[]` in the manifest. Replaces `triggerCatalog.ts:95-105` and `automationCopy.ts:66-67`. |
| **Receive** a relay webhook | **C** (PX-9) | Nothing exists. The relay's `/cursor/*` routes, the registered secret, the 45s drain, the paged cursor and the sqlite replay guard are all core code with no plugin equivalent. |
| A durable replay guard | **B** | `sdk.collections` is durable and budgeted (4000 rows, 2 MiB per plugin — `sdk.ts:61-64`). Enough for a delivery-id ledger with `ifFull: "evictOldest"`. |
| Poll on a timer | **B** | `sdk.schedules.create` (`sdk.ts:569`), 8 schedules max, **60s minimum interval** (`sdk.ts:1261-1273`). The current poll is 45s, so a plugin must slow to 60s or PX-9 must push instead of poll. |

## 2.4 The composer launch path

| capability | class | how |
|---|---|---|
| A button in the composer | **A** | `composer-action` socket (`sockets.ts:52`), `desktop/web/ios: true`, `tui: false` (`:299`), with a 15-minute budget (`sockets.ts:376`). `ade-voice` already ships one. |
| A "Cursor Cloud" row in the **machine picker** | **C** | The machine picker is core (`AgentChatPane.tsx:11682-11689`, synthetic id `__ade_cursor_cloud__` at `:338`). There is no socket kind for a machine-picker row, and adding one is an 18th kind — "a platform change with a parity cost on four clients" (`sockets.ts:9`). **Recommendation: do not rebuild this.** Replace it with a `composer-action` button, which is the platform's own answer to the same gesture. |
| The **Advanced menu** (Attach-to-PR / Open a PR) | **B** | A `composer-action` can return `{navigate}` to a small plugin panel with a `form`, or the plugin can read the PR state itself via `git.getOpenPrForBranch` (`registry.ts:443`) and pick without asking. |
| The **secrets picker** | **A** | `projectSecrets.list()` has an action-domain equivalent; the plugin reads names, never values, exactly as today. Per-lane memory goes in `sdk.collections`. |
| The four "unavailable" sentences | **A** | Plain panel text or a disabled button. |

## 2.5 Credentials, network and identity

| capability | class | how |
|---|---|---|
| Store the webhook HMAC secret | **A** | `sdk.secrets.set("WEBHOOK_SECRET", …)` (`sdk.ts:466-470`), namespaced `plugin:ade-cursor-cloud:WEBHOOK_SECRET` (`pluginSecretStore.ts`). |
| Read the **Cursor API key** | **C** (PX-8) | Today it is `ai.api_key.cursor.v1` in the keychain-backed store, shared with local Cursor chat which stays in core. `sdk.secrets` is a *different* store (`EncryptedFileCredentialStore`, `pluginSecretStore.ts:54`), so without a broker the user pastes the key twice and the two copies drift. |
| Call `api.cursor.com` from the plugin child | **A for function, C for policy** (PX-7) | The child is `spawn(process.execPath, [bootstrapPath])` with a sanitized env (`pluginChildSupervisor.ts:413-424`). `fetch` works. Nothing declares it, discloses it at install, allowlists it or audits it. The webview tier already has a CSP with `connect-src https:` (`webviewBridge.ts:114`); the child tier has nothing equivalent. |
| Vendor `@cursor/sdk` | **A** | The child uses `createRequire` against `<pluginRoot>` (`pluginChildBootstrap.ts:17`). The plugin ships its dependency. Note the win32-arm64 blocker (`cursorCloud.ts:50-75`) travels with it. |
| Deeplink to a cloud agent | **A** | `ade://plugin/<plugin-id>/<panel-id>?ctx=` already parses (`deeplinks.ts:14`, `:684`, `:774-788`), with a 2 KiB `ctx` cap. This is **more** than Cursor Cloud has today. |
| A push notification when an agent finishes | **A/B** | `sdk.notifications.post` reaches desktop and mobile (`sdk.ts:1034-1103`), 5/min and 60/day. It has **no deeplink field** — PX-12, optional, and not a regression because Cursor Cloud posts none today. |

---

# PART 3 — PLATFORM BUILD UNITS

Each unit is self-contained. Size is S (≤2 days), M (≤1 week), L (1–2 weeks), XL (3+ weeks).

## PX-1 — Rich list rows · **M**

**Problem.** A fleet row needs a title, a status badge with a tone, a monospace second line and up to
three actions plus an overflow menu. Today a list item gives one action, no badge and no monospace,
and the hand-built alternative caps the panel at ~27 rows.

**Contract change.** Widen `VocabListItem` in
`apps/desktop/src/shared/plugins/vocabularyNodes.ts:182-189`:

```ts
export type VocabListItem = {
  title: string;
  subtitle?: string;
  meta?: string;
  tone?: VocabTone;
  icon?: string;
  onPress?: VocabAction;
  /** New. A chip beside the title. Same tone set as `badge`. */
  badge?: { text: string; tone?: VocabTone; icon?: string };
  /** New. Rendered monospace, under `subtitle`. */
  mono?: string;
  /** New. Up to 3 trailing buttons. */
  actions?: VocabAction[];      // each { action, args?, confirm?, label, kind?, icon? }
  /** New. Behind a chevron. Up to 6. */
  overflow?: VocabAction[];
};
```

Add ceilings to `VOCAB_LIMITS`: `maxListItemActions: 3`, `maxListItemOverflow: 6`. Keep
`maxListItems: 100`. A list item is not a node, so the 200-node ceiling is unaffected — this is the
whole point of the change.

**Files.**
- `apps/desktop/src/shared/plugins/vocabularyNodes.ts` — type, `parseListItem`, `coerceBoundListItem`, limits.
- `apps/desktop/src/renderer/components/plugins/vocabularyComponents.tsx` — the list renderer (~`:223-330`).
- `apps/ios/ADE/Models/PluginVocabularyNodeParsing.swift` + `apps/ios/ADE/Views/Plugins/PluginVocabularyView.swift` (~`:267-303`).
- `apps/ade-cli/src/tuiClient/pluginPane.ts` (~`:429`) — the TUI draws the badge as a glyph and the actions as numbered keys.

**Cross-client parity.** All four render it. The TUI degrades `overflow` into the same numbered-key
list as `actions`; that is honest, not half-drawn.

**Security.** `actions[]` entries are `VocabAction`s, so they are already flat-scalar args only
(`vocabularyNodes.ts:139-144`) and already pass through `confirm`. No new trust boundary.

**Acceptance.** A panel of 60 fleet rows, each with a badge, a mono line and three buttons, renders
identically on desktop, web and iOS and legibly in the TUI, and stays under 64 KiB.

## PX-2 — Bound rows may act, and confirmation is honoured everywhere · **S**

**Problem.** Two defects that together make "a fleet driven by a collection" impossible.

1. `coerceBoundListItem` strips `onPress` (`vocabularyNodes.ts:447-468`) with a stated reason: "a
   collection row that could mint one would let stored data introduce a button the panel never
   showed the reader." iOS does not strip it (`PluginPaneStore.swift:200`). Desktop, web and the TUI
   are inert; the phone is live.
2. A list row's `onPress.confirm` is **not** honoured on desktop or web
   (`vocabularyComponents.tsx:321` versus `VocabButton` at `:173`). iOS
   (`PluginPaneStore.swift:299-304`) and the TUI (`app.tsx:10797-10802`) both gate it.

**Decision to make, and my recommendation.** Keep the stated security intent but make it
expressible: let a bound row carry `onPress`, **but only when its `action` id appears in an
allowlist the panel schema itself declares**. Add to the binding:

```ts
type VocabBinding = { collection: string; keyPrefix?: string; limit?: number;
  /** New. Action ids a row from this collection may name. */
  allowActions?: string[]; };
```

A row naming an id outside the list is coerced to `onPress: undefined`, exactly as today. The panel
author still chose every action a reader can press, which is the invariant the comment defends, and
the data now decides only *which* of them a given row offers.

**Files.** `vocabularyNodes.ts` (binding type, `coerceBoundListItem`, `parseBinding`);
`vocabularyComponents.tsx:321` (route row presses through the same confirm gate as `VocabButton`);
`PluginPaneStore.swift:200` (apply the allowlist so iOS stops diverging); `pluginPane.ts:429`.

**Acceptance.** A bound row is pressable on all four clients, an undeclared action id is refused on
all four, and a `confirm` prompt appears on all four.

## PX-3 — Client-evaluated panel state · **L** · the real C

**Problem.** A fleet panel needs a status filter, a lane filter and an Archived toggle whose changes
re-render the list **without** a round trip. Today the only expressible filter is a `form` plus a
submit button plus `panels.update()` plus a refetch. That is three taps and a full round trip per
filter change, and the selected values do not survive the re-render unless the plugin bakes them
back into `field.value`.

**Why this cannot be faked.** Rule 3 of the vocabulary — "data, never code" (`vocabulary.ts:35-39`)
— forbids expressions and conditionals. Any solution has to add a *primitive*, not a language.

**The design.** Two additions, both data.

1. **A `segmented` node** — a closed set of options with one selected, writing to a named
   panel-local key.

```ts
export type VocabSegmentedNode = {
  component: "segmented";
  /** Panel-local state key. Pattern: same as a collection name. */
  stateKey: string;
  options: { value: string; label: string; badge?: string }[];  // max 8
  default?: string;
  /** Optional: also dispatch this action on change, for a plugin that wants to know. */
  onChange?: VocabAction;
};
```

   A `toggle` variant is the same node with two options, so no second component is needed.

2. **A `where` clause on a binding**, evaluated by the client against panel-local state.

```ts
type VocabBinding = { collection: string; keyPrefix?: string; limit?: number;
  allowActions?: string[];
  /** New. Keep a row when `row[field]` equals the current value of `state`. */
  where?: { field: string; equals: { state: string } | { value: string } }[];  // max 3
};
```

   Equality against a string only. No operators, no negation, no expressions. A `where` naming a
   state key no `segmented` declared is dropped with a warning, exactly as an unknown component is.

The plugin writes each fleet row into `plugin_collections` with `status`, `laneId` and `archived`
fields already computed on its own machine — Mosaic's law, kept — and the client does nothing but
compare strings.

**Files.**
- `vocabularyNodes.ts` — the node, its parser, the binding field, the limits, and a `VocabPanelState` type.
- `vocabulary.ts` — a `$state` reserved collection alongside `$context`, so a `text` node can render "Showing: Active" without interpolation.
- `apps/desktop/src/renderer/components/plugins/vocabularyComponents.tsx` + `PluginPanelHost.tsx` — hold state, apply `where` at render.
- `apps/ios/ADE/Views/Plugins/PluginVocabularyView.swift` + `PluginPaneStore.swift`.
- `apps/ade-cli/src/tuiClient/pluginPane.ts` + `app.tsx` — ←/→ already cycle non-text fields (`app.tsx:16996-17012`), so a segmented control fits the existing key model.

**Cross-client parity.** Full. This is why it is a node and not a webview.

**Security.** No new capability. State never leaves the client unless `onChange` is declared, and
then it travels as an ordinary flat-scalar action arg.

**Acceptance.** Changing the status filter re-renders the fleet with zero IPC and zero sync traffic
on all four clients, and the selection survives a data refresh.

## PX-4 — An `{openUrl}` action-result verb · **S**

**Problem.** No node and no verb opens an external URL. The fleet footer's "All agents on
cursor.com", the per-row "Open PR" and the detail view's "Open on cursor.com" are all unbuildable.
Today the only plugin-authored link renders on the failure card (`vocabulary.ts:82`).

**Contract change.** A fifth action-result verb beside `navigate`, `composer`, `dialog` and
`openWebview` in `apps/desktop/src/shared/plugins/sdk.ts`:

```ts
export type PluginActionOpenUrl = { url: string };
export function readPluginActionOpenUrl(result: unknown): PluginActionOpenUrl | null;
export const PLUGIN_OPEN_URL_MAX_CHARS = 2_048;
```

**Scheme allowlist: `https:` only.** No `http:`, no `file:`, no `ade:` (that is what `navigate` and
`fallback.deeplink` are for), no `javascript:`, no `data:`. Reuse the judgement already in
`PluginDeeplinkURL.resolve` (`PluginVocabularyMediaViews.swift:105-131`), which allows `https` out
of the app and a fixed set of `ade://` hosts.

**Files.** `sdk.ts` (type, reader, cap); `PluginPanelHost.tsx:206-212` → `openExternalUrl`
(`renderer/lib/openExternal.ts`); `PluginPaneStore.swift:334-340` → `openURL`; `app.tsx:10823-10835`
→ print the URL as a notice, because a TUI cannot open a browser for the user.

**Security.** The URL comes from the plugin child, which is code the user installed. The `https:`
restriction stops the two real abuses: a local-file read and a scheme handler. Log every open at
`info` with the plugin id.

**Acceptance.** A footer button opens `https://cursor.com/agents` in the system browser on desktop,
in a new tab on web, in Safari on iOS, and prints the URL in the TUI.

## PX-5 — Desktop and web action-result banner · **S**

**Problem.** iOS shows the plugin's result message as a coloured banner
(`PluginPaneSheet.swift:202-222`) and the TUI adds a notice (`app.tsx:10825`). Desktop and web throw
the message away (`PluginPanelHost.tsx:192-212`), so a successful action is invisible there.

**Change.** Read the same `{ok, message?, result}` envelope the sync path already synthesizes
(`syncRemoteCommandService.ts:6051-6056`) and render an inline banner under the panel, matching iOS.
Use the existing tone set. Auto-dismiss after 6 seconds, or on the next dispatch.

**Files.** `PluginPanelHost.tsx`, `VocabularyRenderer.tsx`, and the local-IPC invoke path so the
desktop envelope carries `message` the way the sync envelope does.

**Acceptance.** "Created lane 'x' and merged y." appears on desktop, web, iOS and the TUI after a
pull-into-lane, with one implementation of the copy in the plugin.

## PX-6 — A panel refresh contract · **S/M**

**Problem.** Three separate holes. iOS has **no pull-to-refresh** on a plugin pane
(`PluginPaneSheet.swift:66-83`) while the built-in Cursor Cloud list has one
(`CursorCloudAgentListScreen.swift:47`). No client has a header slot a plugin can put a refresh
button in (`PluginTabPage.tsx:388-430`, `PluginPaneSheet.swift:33-40`). And a plugin has no way to
say "this panel's data is fetched live, so a refresh gesture means something".

**Change.** Add one optional field to a manifest panel (`manifest.ts:206-212`):

```ts
export type PluginManifestPanel = { id: string; schemaFile?: string; title?: string; icon?: string;
  /** New. The plugin action a client's refresh gesture dispatches. */
  refreshAction?: string; };
```

When a panel declares it:
- iOS adds `.refreshable` to the pane scroll view and dispatches that action.
- Desktop and web put a refresh icon in `PluginPageShell`'s header, beside the version chip.
- The TUI's existing `r` key dispatches it before it refetches (`app.tsx:17012`).

When it is absent, nothing changes anywhere.

**Files.** `manifest.ts` (field + parser); `pluginTableWriters.ts` (carry it in `schema_json`, since
the SQL shape of `plugin_panels` is frozen — `kvDb.ts:829-831`); `PluginRecords.swift` (read it);
`PluginPaneSheet.swift`; `PluginTabPage.tsx`; `app.tsx`.

**Acceptance.** Pull-to-refresh on the iOS fleet pane re-fetches from the Cursor API through the
desktop and updates the rows.

## PX-7 — Declared and disclosed outbound network · **M** · security

**Problem.** The plugin child is a plain Node process (`pluginChildSupervisor.ts:424`), so it can
reach any host on the internet. There is no manifest declaration, no install-time disclosure, no
allowlist and no audit trail. The webview tier is stricter than the child tier: a webview gets a CSP
with `connect-src https:` and one origin per plugin (`webviewBridge.ts:114`), while the child that
holds the plugin's secrets gets nothing.

Shipping an **official, bundled** plugin that sends the user's Cursor API key to `api.cursor.com`
without ever telling them so at install is the wrong precedent to set for a Marketplace.

**Change, in three parts.**

1. **Declare it.** A manifest field:

```ts
/** Hosts this plugin's child process contacts. `["api.cursor.com"]`. */
network?: { hosts: string[] };   // max 8, lowercase, no scheme, no wildcard leading dot beyond one level
```

2. **Disclose it.** Add a line to `installDisclosure.ts` beside the existing "From the internet:"
   line (`:191`): "Contacts: api.cursor.com". Show it in the Marketplace card and in the in-chat
   install approval, which already describes an install before it runs
   (`pluginInstallService.ts:382-388`).

3. **Enforce it.** In `pluginChildBootstrap.ts`, before the plugin module is required, replace the
   global `fetch` and hook `node:http`/`node:https` with a wrapper that refuses a host outside the
   declared list, and log every refusal at `warn` with the plugin id and the host. This is a
   guard-rail against a buggy or updated plugin, not a sandbox — the file already says it "assumes
   the plugin is buggy, not malicious-proof" (`pluginChildBootstrap.ts:9-12`). Do not claim more
   than that in the copy.

**Files.** `shared/plugins/manifest.ts`, `shared/plugins/installDisclosure.ts`,
`main/services/plugins/childRuntime/pluginChildBootstrap.ts`, the Marketplace card renderer, and
`pluginInstallApproval.ts`.

**Acceptance.** Installing `ade-cursor-cloud` shows "Contacts: api.cursor.com" before the user
agrees. A plugin calling an undeclared host gets a rejected promise and a logged warning.

## PX-8 — Host-brokered provider credentials · **M**

**Problem.** The Cursor API key lives in the keychain-backed API-key store as `ai.api_key.cursor.v1`
(`apiKeyStore.ts:214-216`) and powers **both** cloud agents and local Cursor chat. Local Cursor chat
stays in core. `sdk.secrets` writes to a different store entirely
(`EncryptedFileCredentialStore`, `pluginSecretStore.ts:54`). Without a broker, the user pastes the
same key in two places, and rotating one silently breaks the other.

**Change.** A manifest declaration plus one SDK method.

```ts
/** Provider keys from ADE's own store this plugin asks to read. */
providerKeys?: string[];   // values from the api-key store's provider ids: "cursor", "openai", …
```

```ts
sdk.secrets.getProviderKey(provider: string): Promise<string | null>;
```

Rules:
- The provider must be in the manifest's `providerKeys`, or the call rejects with `invalid_args`.
- The **user grants it at install**, as a disclosure line: "Uses your Cursor API key." Store the
  grant on the install record so an update that widens `providerKeys` re-prompts.
- The host reads the key. **The key never passes through the manifest, the collections, the panel
  schema or the sync layer** — only through the SDK call's return value, into the child that already
  holds the plugin's own secrets.
- Revoking the plugin revokes the read. Deleting the key in Settings breaks the plugin honestly,
  with the same "Add a Cursor API key before using Cursor Cloud agents." sentence
  (`aiIntegrationService.ts:1154-1160`) which moves into the plugin.

**Files.** `manifest.ts`, `installDisclosure.ts`, `sdk.ts` (method + type),
`pluginSdkServer.ts` (the host arm), `pluginSecretStore.ts` (route the provider read to
`apiKeyStore`), `pluginInstallApproval.ts`.

**Security note.** This is a genuine widening: a plugin can now read a credential the user gave to
ADE, not to the plugin. It is justified for `official: true` plugins and disclosed for all of them.
Consider gating `providerKeys` to `official` manifests in round one and revisiting for third
parties. That is a product decision, not a technical one.

**Acceptance.** A user who already connected Cursor installs the plugin and the fleet loads with no
second key prompt.

## PX-9 — Webhook ingress routed to a plugin · **L**

**Problem.** Cursor posts status events to ADE's Cloudflare relay. Today `/cursor/register`,
`/cursor/webhook` and `/cursor/events` are hard-coded routes (`relay.ts:2706-2708`) with two D1
tables, and the desktop drains them on a 45-second timer into a sqlite replay guard. A plugin can
*emit* an automation trigger; nothing lets it *receive* a webhook.

**Change, in three parts.**

1. **Relay: a per-plugin namespace.** Generalize the three Cursor routes into
   `POST /plugin/:pluginId/register`, `POST /plugin/:pluginId/webhook`,
   `GET /plugin/:pluginId/events`, backed by generalized `plugin_webhook_secrets` and
   `plugin_events` D1 tables. Keep the existing HMAC verification, replay window and event dedupe
   exactly as `handleCursorWebhook` has them (`relay.ts:2481-2550`) — that logic is correct and
   should be lifted, not rewritten. Keep the `/cursor/*` routes alive during the migration window;
   see Part 5.

2. **Manifest: declare the ingress.**

```ts
/** This plugin receives webhooks at the relay. */
webhookIngress?: { id: string; label: string };
```

3. **Host: one drain for every plugin that declares one.** A single service replaces
   `cursorCloudIngressService.ts`, generalized: it ensures a ≥32-byte secret per plugin in the
   plugin secret store, registers it, polls `GET /plugin/:id/events` with the same paged
   `seq:N` cursor, keeps the replay ledger in the plugin's own `sdk.collections` (durable, budgeted,
   `ifFull: "evictOldest"`), and delivers each event to the child as a new SDK event:

```ts
// joins PLUGIN_RUNTIME_HOOK_EVENTS / PluginChangeEventName
"webhook.received": { deliveryId: string; receivedAt: number; payload: unknown }
```

   Deliver **only to a child that subscribed**, following the rule already stated for hooks: "a hook
   kind nobody registered for is never delivered to this child at all" (`sdk.ts:522-529`).

   The webhook URL the plugin must give to the third party is available through
   `sdk.config.get()` or a new `sdk.webhooks.url()`.

**Files.** `apps/webhook-relay/src/relay.ts` (+ D1 migration), `shared/plugins/manifest.ts`,
`shared/plugins/sdk.ts` (event name + payload), a new
`main/services/plugins/pluginWebhookIngressService.ts`, `pluginSdkServer.ts`,
`childRuntime/pluginChildBootstrap.ts`, plus the CLI twin in `apps/ade-cli/src/bootstrap.ts`.

**Cross-client parity.** Host-side only. Nothing to draw.

**Security.** The secret stays in the plugin secret store and is never rendered. The relay's replay
window and event dedupe stay where they are. Rate-limit deliveries per plugin, matching the
automation-trigger burst limits (`sdk.ts:1310-1311`).

**Acceptance.** A Cursor Cloud run that finishes reaches the plugin child within one poll interval,
exactly once, across an app restart.

## PX-10 — A plugin as a conversation source · **XL** · the long pole

**Problem.** The largest half of Cursor Cloud is that a cloud agent *is* an ADE chat. The transcript
is hydrated from the cloud API, follow-up turns are dispatched to the cloud, replies stream back,
artifacts materialize into the lane, and a status webhook can wake a sleeping session
(`agentChatService.ts:38525-38727`). No seam in the plugin platform lets a plugin do any of it.
`AgentChatProvider` is `(string & {})` (`chat.ts:17`), but every runtime path is a hard switch.

**This is the unit that decides whether "fully extracted" is real.** Everything else in this spec
can be built by two people in parallel in three weeks. This one cannot.

**The design.** Three additions.

1. **A declared chat runtime.**

```ts
/** Conversation runtimes this plugin serves. */
chatRuntimes?: {
  id: string;              // "cloud" → sessions carry runtime "plugin:ade-cursor-cloud/cloud"
  label: string;           // "Cursor Cloud"
  /** The plugin action a turn dispatches to. Receives { sessionId, text, attachments }. */
  turnAction: string;
  /** Optional. Called when a client starts/stops watching this session. */
  presenceAction?: string;
  /** Optional. Called once when a session is adopted, to backfill history. */
  hydrateAction?: string;
}[];
```

   A session gains `runtimeRef: { pluginId, runtimeId, externalId }`, which replaces the
   Cursor-specific `cursorCloudAgentId` (`chat.ts:1636`) and `cursorRuntime` fields with a generic
   pair. `chatSessionProjection.ts:96` projects `runtimeRef` instead.

2. **A transcript-write API for the plugin child.**

```ts
sdk.chat: {
  /** Append an assistant turn. Chunked calls coalesce into one streaming turn. */
  appendAssistant(sessionId: string, chunk: { text?: string; thinking?: string; done?: boolean }): Promise<void>;
  /** Append a user turn ADE did not originate — history backfill. */
  appendUser(sessionId: string, text: string, options?: { fingerprint?: string }): Promise<void>;
  /** Emit a status event: "run cancelled", "PR opened". */
  emitStatus(sessionId: string, status: { text: string; tone?: VocabTone; url?: string }): Promise<void>;
  /** Already exists as an action; surfaced here for symmetry. */
  emitCard(sessionId: string, card: unknown): Promise<void>;
}
```

   `fingerprint` is the hook for the dedupe `cursorCloudConversation.ts:80-122` already implements;
   the host does the suffix-tolerant match so every plugin gets it for free.

3. **Presence, not a schedule.** `sdk.schedules` has a 60-second floor (`sdk.ts:1273`) and no
   presence awareness, so it cannot express the `[3s, 8s, 20s, 45s]` ladder that stops when the user
   navigates away (`cursorCloudConversation.ts:247`). The `presenceAction` above is called with
   `{ sessionId, watching: boolean }` whenever a client mounts or unmounts that chat — which is
   exactly what `watchCursorCloudMirror` does today (`AgentChatPane.tsx:9765`,
   `WorkSessionDestinationView.swift:1589-1608`, `app.tsx:4581-4587`). The plugin owns its own
   timer inside the child; the host only tells it when anybody is looking.

**Files.** `shared/types/chat.ts` and `sessions.ts` (the `runtimeRef` pair);
`main/services/chat/agentChatService.ts` (the dispatch switch at `:39678`, the send path, the
transcript writer, the presence registry — reuse `cursorCloudMirrorWatch.ts`'s ref-counted registry
by generalizing it); `shared/plugins/manifest.ts`; `shared/plugins/sdk.ts`;
`main/services/plugins/pluginSdkServer.ts`; `apps/ios/ADE/Views/Work/WorkSessionDestinationView.swift`
and `apps/ade-cli/src/tuiClient/app.tsx` (send the presence signal for a plugin runtime, as they
already do for `cursorCloudAgentId`).

**Cross-client parity.** The transcript is already cross-client. What each client must learn is: a
session whose `runtimeRef` names a plugin renders the plugin's label in the header, and the presence
signal is sent for it. Both are small once the host side exists.

**Security.** A plugin can write into a transcript. That is a real widening, and it is the reason
this unit is XL rather than L. Two limits: a plugin may write **only** to a session whose
`runtimeRef.pluginId` is itself, enforced host-side on every call; and the per-session card burst
limit (`sdk.ts:1352-1353`) extends to transcript writes.

**Acceptance.** "Open in ADE" on a fleet row produces a chat whose history is the cloud
conversation, where typing a follow-up reaches Cursor Cloud and the reply streams into the
transcript — with **no Cursor-specific code in `agentChatService.ts`**.

## PX-11 — A rail badge for a plugin tab · **S** · optional

**Problem.** The quick-view button carries an unread-finished count
(`CursorCloudQuickViewButton.tsx:136-144`). A plugin tab in the rail has no count.

**Change.** Let a plugin publish a `row-badge` contribution against the reserved entity
`{kind: "surface", id: "<pluginId>/<surfaceId>"}` — the `surface` entity kind already exists
(`sockets.ts:92`) — and have `TabNav.tsx` draw it on the rail item. Cap it at one badge.

**Verdict.** Optional. Judge it against the no-regression checklist in Part 5; the owner may accept
losing the badge in exchange for a rail entry that is always visible, which the quick-view button is
not (it hides for 4 seconds at startup and never appears in the web client at all).

## PX-12 — A deeplink on a plugin notification · **S** · optional

`PluginNotificationInput` is `{title, body?, target?}` (`sdk.ts:1096`) with no deeplink. Adding one
lets "Agent finished" open the fleet panel. Cursor Cloud posts no notifications today, so this is a
gain, not a regression. Reuse the `ade://plugin/<id>/<panel>?ctx=` form that already parses
(`deeplinks.ts:684`).

---

# PART 4 — THE PLUGIN

## 4.1 Proposed manifest

```json
{
  "name": "ade-cursor-cloud",
  "version": "1.0.0",
  "displayName": "Cursor Cloud",
  "description": "Launch, watch and adopt Cursor Cloud agents from ADE.",
  "icon": "cloud-arrow-up",
  "accent": "#A78BFA",
  "vocabVersion": 1,
  "entry": "index.js",
  "official": true,

  "network": { "hosts": ["api.cursor.com"] },
  "providerKeys": ["cursor"],
  "webhookIngress": { "id": "cursor", "label": "Cursor Cloud status events" },

  "surfaces": [
    { "kind": "tab", "id": "fleet", "title": "Cursor Cloud", "icon": "cloud-arrow-up",
      "panelId": "fleet", "order": 60, "mobile": true }
  ],

  "panels": [
    { "id": "fleet",  "schemaFile": "panels/fleet.json",  "title": "Cursor Cloud",
      "refreshAction": "refreshFleet" },
    { "id": "agent",  "schemaFile": "panels/agent.json",  "title": "Agent",
      "refreshAction": "refreshAgent" },
    { "id": "launch", "schemaFile": "panels/launch.json", "title": "Send to Cursor Cloud" }
  ],

  "sockets": [
    { "socket": "composer-action", "surface": "work", "id": "send-to-cloud",
      "label": "Send to Cursor Cloud", "icon": "cloud-arrow-up", "actionId": "openLaunch",
      "color": "#A78BFA" },
    { "socket": "chat-header-action", "surface": "work", "id": "open-on-cursor",
      "label": "Open on cursor.com", "icon": "arrow-square-out", "actionId": "openAgentWeb" },
    { "socket": "row-badge", "surface": "lanes", "id": "cloud-status" },
    { "socket": "command-palette-action", "surface": "app", "id": "palette-fleet",
      "label": "Cursor Cloud fleet", "actionId": "openFleet" }
  ],

  "collections": {
    "fleet":      { "sync": true  },
    "agents":     { "sync": true  },
    "deliveries": { "sync": false },
    "lane-secrets": { "sync": false }
  },

  "settings": [
    { "key": "includeArchived", "kind": "toggle", "label": "Show archived agents", "default": false },
    { "key": "autoOpenPr", "kind": "toggle", "label": "Open a PR when a run finishes", "default": false }
  ],

  "chatRuntimes": [
    { "id": "cloud", "label": "Cursor Cloud", "turnAction": "runTurn",
      "presenceAction": "setWatching", "hydrateAction": "hydrate" }
  ],

  "automationTriggers": [
    { "id": "cloud_finished", "label": "A Cursor Cloud agent finishes" },
    { "id": "cloud_error",    "label": "A Cursor Cloud agent errors" }
  ],

  "automationSteps": [
    { "id": "stop_agent",     "label": "Stop a Cursor Cloud agent", "action": "stopRun" },
    { "id": "pull_into_lane", "label": "Pull the agent's branch into its lane", "action": "pullIntoLane" }
  ],

  "searchProviders": [
    { "id": "agents", "label": "Cursor Cloud", "action": "searchAgents" }
  ],

  "keybindings": [
    { "action": "openFleet", "binding": "Mod+Shift+C", "label": "Open the Cursor Cloud fleet" }
  ],

  "tools": [
    { "name": "list_agents", "description": "List this project's Cursor Cloud agents.",
      "action": "listAgents",
      "input": { "type": "object", "properties": {
        "includeArchived": { "type": "boolean", "description": "Include archived agents." } },
        "required": [] } },
    { "name": "launch_agent", "description": "Start a Cursor Cloud agent on this lane's branch.",
      "action": "createRun",
      "input": { "type": "object", "properties": {
        "prompt": { "type": "string", "description": "What the agent should do." },
        "openPr": { "type": "boolean", "description": "Open a PR when the run finishes." } },
        "required": ["prompt"] } },
    { "name": "stop_agent", "description": "Stop a running Cursor Cloud agent.",
      "action": "stopRun",
      "input": { "type": "object", "properties": {
        "agentId": { "type": "string", "description": "The agent id." } },
        "required": ["agentId"] } }
  ],

  "cli": ["agents", "runs", "artifacts", "repos", "me"],
  "skills": ["skills"]
}
```

**Notes on the manifest.**

- `surfaces` declares a **`tab`**, not a `pane`. Desktop drops non-builtin panes
  (`preload/pluginBridge.ts:102-116`); the TUI opens either (`adeApi.ts:1673-1676`). A tab is the
  only kind that reaches all four.
- No `builtin` field. Cursor Cloud has no compiled-in tab to gate, which is exactly what makes this
  a *full* extraction and `ade-linear` (`plugins/ade-linear/plugin.json`) only a gate.
- `cli` moves `ade cursor cloud …` to `ade ade-cursor-cloud agents …`. That is a user-visible rename;
  see the checklist.
- `sockets` deliberately omits a machine-picker row. See §2.4 — that kind does not exist and should
  not be invented; the `composer-action` is the platform's answer to the same gesture.

## 4.2 What runs where

**In the plugin child** (`index.js`, vendoring `@cursor/sdk`):

- Every call to the Cursor API. All fourteen `cloud.*` RPCs from `cursorSdkWorker.ts:930-1095` move
  here verbatim, plus the nine `Agent.*`/`Cursor.*` calls from `aiIntegrationService.ts:1165-1380`.
- Fleet assembly: list agents, enrich with the latest run, match to a lane, group, and write
  render-ready rows into the `fleet` collection with `status`, `laneId`, `archived` and a
  pre-formatted age already computed. Mosaic's law.
- The webhook drain's plugin half: subscribe to `webhook.received`, dedupe against the `deliveries`
  collection, fan out to `automations.emitTrigger` and to the chat runtime.
- Turn dispatch, hydration and the presence-gated poll ladder.
- Per-lane secret-name memory, in the `lane-secrets` collection.
- The webhook HMAC secret, in `sdk.secrets`.

**Host-side, unchanged, reached through `sdk.actions.invoke` at agent role:**

- `git.getOriginRemote`, `git.getOpenPrForBranch`, `git.listBranches`, `git.fetch`, `git.pull`
  (`registry.ts:436-453`).
- `lane.importBranch` (`registry.ts:380`, domain `lane`) for resolve-lane.
- `chat.createSession`, `chat.updateSession`, `chat.emitAdeCard` (`registry.ts:603-607`).
- `ai.getStatus` for the "Connect Cursor first" state (`registry.ts` `ai` domain).
- `projectSecrets.list` for the secrets picker — **names only**, exactly as today
  (`CursorCloudSecretsPicker.tsx:7-9`).

**Host-side, new platform code (not plugin code):** everything in Part 3.

## 4.3 The fleet panel schema, sketched

```jsonc
{
  "v": 1,
  "title": "Cursor Cloud",
  "fallback": {
    "title": "Cursor Cloud",
    "text": "Open ADE on your Mac to see your cloud agents.",
    "deeplink": "ade://plugin/ade-cursor-cloud/fleet"
  },
  "body": [
    { "component": "segmented", "stateKey": "status", "default": "all",
      "options": [ { "value": "all", "label": "All" }, { "value": "active", "label": "Active" },
                   { "value": "finished", "label": "Finished" }, { "value": "failed", "label": "Failed" } ] },
    { "component": "segmented", "stateKey": "lane", "default": "all", "options": [ /* written by the plugin */ ] },
    { "component": "segmented", "stateKey": "archived", "default": "hide",
      "options": [ { "value": "hide", "label": "Hide archived" }, { "value": "show", "label": "Show archived" } ] },

    { "component": "divider", "label": "Active runs" },
    { "component": "list",
      "bind": { "collection": "fleet", "keyPrefix": "active:", "limit": 100,
                "allowActions": ["openInAde", "stopRun", "openAgent"],
                "where": [ { "field": "archivedFlag", "equals": { "state": "archived" } } ] },
      "emptyText": "No active runs." },

    { "component": "divider", "label": "By lane" },
    { "component": "list",
      "bind": { "collection": "fleet", "keyPrefix": "lane:", "limit": 100,
                "allowActions": ["openInAde", "stopRun", "pullIntoLane", "archive", "delete", "openAgent"],
                "where": [ { "field": "status", "equals": { "state": "status" } },
                           { "field": "laneId", "equals": { "state": "lane" } } ] },
      "emptyText": "No agents linked to a lane." },

    { "component": "divider", "label": "Unlinked" },
    { "component": "list", "bind": { "collection": "fleet", "keyPrefix": "unlinked:", "limit": 100,
                "allowActions": ["openInAde", "stopRun", "openAgent"] },
      "emptyText": "Nothing unlinked." },

    { "component": "divider" },
    { "component": "stack", "direction": "horizontal", "align": "center", "gap": "md",
      "children": [
        { "component": "text", "variant": "caption", "text": "12 agents · $1.84 shown · updated 2m" },
        { "component": "button", "label": "All agents on cursor.com", "kind": "quiet",
          "icon": "arrow-square-out", "onPress": { "action": "openAllAgents" } }
      ] }
  ]
}
```

Each `fleet` row, written by the plugin, is:

```jsonc
{ "title": "Fix the flaky sync test",
  "badge": { "text": "RUNNING", "tone": "info" },
  "subtitle": "ade/fix-flaky-sync · composer-2",
  "mono": "agent bc_9f2a…  ·  4m",
  "tone": "info",
  "onPress": { "action": "openAgentDetail", "args": { "agentId": "bc_9f2a…" } },
  "actions": [ { "action": "openInAde", "label": "Open", "args": { "agentId": "…" } },
               { "action": "stopRun",   "label": "Stop", "kind": "quiet", "args": { "agentId": "…" } } ],
  "overflow": [ { "action": "pullIntoLane", "label": "Pull into lane…", "args": { "agentId": "…" } },
                { "action": "archive",      "label": "Archive agent",   "args": { "agentId": "…" } },
                { "action": "delete",       "label": "Delete agent…",   "confirm": "Delete this agent forever?",
                  "args": { "agentId": "…" } } ],
  // filter fields, evaluated client-side by `where`
  "status": "active", "laneId": "lane_7", "archivedFlag": "hide" }
```

The detail panel is a `keyValue` facts block, an optional summary `text`, and a horizontal `stack`
of buttons — Open in ADE, Stop, Pull into lane, Open on cursor.com — reading `$context` for the
agent id. It works on all four clients today, once PX-1, PX-2 and PX-4 exist.

## 4.4 Per-client outcome

| client | fleet panel | launch | chat runtime |
|---|---|---|---|
| desktop | Full. A rail tab instead of a top-bar modal. | `composer-action` button → launch panel. | Full, after PX-10. |
| web | **Full — a gain.** The web client renders plugin panels today; the built-in fleet never appeared there at all (`webclient/adapter/misc.ts:553-556`). | Full. | Full, after PX-10. |
| iOS | Full, through `PluginEntryMenuButton`, already in the same Work top bar (`WorkRootScreen.swift:693`). Needs PX-6 for pull-to-refresh. | `composer-action` is `ios: true` (`sockets.ts:299`). | Full, after PX-10. |
| TUI | **Better than today.** `/plugin-view ade-cursor-cloud` renders the real panel with selectable rows and actions (`app.tsx:10453`, `pluginPane.ts:15-20`), replacing a read-only formatted list. | Not reachable — `composer-action` is `tui: false`. Same as today. | Presence signal only, as today. |

---

# PART 5 — MIGRATION AND REMOVAL

## 5.1 Core code deleted

**Delete outright** (18 files, ~4,500 lines):

```
apps/desktop/src/main/services/chat/cursorCloudFleetService.ts        (+ .test.ts)
apps/desktop/src/main/services/chat/cursorCloudConversation.ts        (+ .test.ts)
apps/desktop/src/main/services/chat/cursorCloudMirrorWatch.ts         (+ .test.ts)  → generalize into the presence registry PX-10 needs
apps/desktop/src/main/services/chat/cursorCloudCreateOptions.ts       (+ .test.ts)
apps/desktop/src/main/services/automations/cursorCloudIngressService.ts        (+ .test.ts)  → generalize into pluginWebhookIngressService
apps/desktop/src/main/services/automations/cursorCloudRelayConfig.ts
apps/desktop/src/main/services/automations/cursorCloudAutomationDispatch.ts    (+ .test.ts)
apps/desktop/src/shared/cursorCloudFleetStatus.ts
apps/desktop/src/shared/cursorCloudRepoMatch.ts
apps/desktop/src/shared/cursorCloudApiLimits.ts
apps/desktop/src/renderer/components/app/CursorCloudFleetModal.tsx    (+ .test.tsx)
apps/desktop/src/renderer/components/app/CursorCloudFleetRow.tsx
apps/desktop/src/renderer/components/app/CursorCloudQuickViewButton.tsx
apps/desktop/src/renderer/components/chat/ChatCursorCloudPanel.tsx            ← already dead
apps/desktop/src/renderer/components/chat/CursorCloudInlineLaunch.tsx (+ .test.tsx)  ← already dead
apps/desktop/src/renderer/components/chat/CursorCloudAdvancedMenu.tsx (+ .test.tsx)
apps/desktop/src/renderer/components/chat/CursorCloudSecretsPicker.tsx
apps/desktop/src/renderer/components/chat/useCursorCloudDraftState.ts
apps/desktop/src/renderer/lib/cursorCloudUtils.ts                     (+ .test.ts)
apps/ade-cli/src/cursorCloud.ts                                       (+ .test.ts)
apps/ios/ADE/Views/CursorCloud/*.swift                                (5 files)
apps/ios/ADETests/CursorCloudContractDecodingTests.swift
```

Two of those — `ChatCursorCloudPanel.tsx` and `CursorCloudInlineLaunch.tsx` — are **already dead
code** (`AgentChatPane.tsx:185-189`). Delete them in phase 0, before anything else; that is free.

**Edit down:**

| file | what leaves |
|---|---|
| `main/services/ai/aiIntegrationService.ts` | `:496-502`, `:1030`, `:1154-1380` — every Cursor Cloud method. The provider-readiness flag stays; local Cursor chat still needs it. |
| `main/services/chat/agentChatService.ts` | `:37898-38060` (artifacts), `:38144-38449` (turn), `:38525-38727` (status change), `:38875-39061` (hydrate), `:39073-39192` (mirror + open chat), `:45439-45466` (teardown), `:48920-48924` (exports). ~1,400 lines. |
| `main/services/chat/cursorSdkWorker.ts` | `:748-793`, `:930-1095` — the fourteen `cloud.*` RPCs. **Local** Cursor RPCs stay. |
| `main/services/ipc/registerIpc.ts` | `:5446-5645`, `:1119-1120`. |
| `main/services/adeActions/registry.ts` | `:708-727`, `:3067-3157`. |
| `main/main.ts` | `:4333`, `:4336-4362`, `:4399-4402`, `:4865-4875`, `:5706`. |
| `main/services/state/kvDb.ts` | `:3483-3498` (table), `:908-909` (the prune exemption). See 5.3. |
| `preload/preload.ts` / `global.d.ts` | `:4681-4856` / `:1139-1201`. |
| `shared/ipc.ts` | `:663-684`. |
| `shared/types/{chat,sessions}.ts` | `cursorCloudAgentId`, `cursorRuntime`, `cursorPromotedTurnId` → replaced by PX-10's `runtimeRef`. |
| `shared/types/config.ts` | `:552-553` — the two trigger types become plugin triggers. |
| `shared/types/automations.ts` | `:91-97`, `:164`, `:195` — the `cursor-relay` source. |
| `shared/types/sync.ts` | `:2109-2114` — the six action names. |
| `shared/syncMobileCompatibility.ts` | `:41-52`. |
| `apps/ade-cli/src/services/sync/syncRemoteCommandService.ts` | `:5616-5661` — the six commands. `plugins.invoke` already covers the plugin path (`:6037`, `viewerAllowed: true`). |
| `apps/ade-cli/src/tuiClient/*` | `commands.ts:124`, `app.tsx:11345-11370` and `:4581-4587`, `adeApi.ts:781-793`, `rightPaneFormatters.ts:566-606`. |
| `apps/ade-cli/src/{cli.ts,bootstrap.ts}` | The `cursor-cloud` plan kind (`cli.ts:459`, `:13339`, `:23220-23235`), the help blobs (`:2732`, `:3037-3040`, `:13334-13335`), the ingress start (`bootstrap.ts:1818-1846`). |
| `renderer/components/automations/{triggerCatalog,automationCopy,variableCatalog}.ts` | The static Cursor entries, replaced by the manifest declarations. |
| `renderer/components/terminals/SessionCard.tsx` | `:915-928`, `:1035`, `:1118`. |
| `renderer/components/chat/AgentChatPane.tsx` | `:185-189`, `:338`, `:963-969`, `:3637-3638`, `:3656-3658`, `:5634-5641`, `:9739-9765`, `:9844`, `:9921-9985`, `:11676-11706`, `:12341-12361`, `:12682-12697`, `:13523-13525`, `:13854-13900`, `:14171`, `:14184-14193`. |
| `renderer/lib/draftLaunchJobs.ts` | `:110` — `DraftLaunchTarget` loses `"cursor-cloud"`. |
| `apps/ios/ADE/**` | `ContentView.swift:176-179`, `WorkRootScreen.swift:693`, `SyncService.swift:9630-9674` and `:11738-11751`, `SyncService+MachineWake.swift:63-71`, `RemoteModels.swift:863-864`, `WorkSessionDestinationView.swift:1023-1028` and `:1589-1608`, plus four pbxproj entries per removed Swift file. |
| `apps/webhook-relay/src/relay.ts` | `/cursor/*` routes → the generalized `/plugin/:id/*` routes. Keep both during the migration window. |

## 5.2 Credential migration

The user must not have to paste the Cursor key again, and must not lose their webhook registration.

1. **The API key.** PX-8 makes the plugin read `ai.api_key.cursor.v1` through the broker. **Nothing
   moves.** The key stays where it is, keeps powering local Cursor chat, and rotating it in Settings
   keeps working. This is the whole reason PX-8 is worth its M.
2. **The webhook secret.** A one-shot migration on first activate: read
   `cursor.cloudWebhookSecret.v1` from `<secretsDir>/cursor-cloud.v1.enc`, write it to
   `sdk.secrets.set("WEBHOOK_SECRET", …)`, re-register it against the new
   `/plugin/ade-cursor-cloud/register` route, and delete the old entry. If the read fails, generate a
   fresh 32-byte secret and register that; the relay's `handleCursorRegister` already upserts
   (`relay.ts:2436-2456`), so a re-register is safe.
3. **Per-lane secret names.** Read every `cursor.cloud.laneSecretNames.v1:<laneId>` entry from the
   same store and write it into the `lane-secrets` collection. Names only; values were never stored.
4. **The ingress cursor.** Read `automations.ingress.cursor.cursor-relay` from kv and seed the
   plugin's `deliveries` ledger, so the first poll after the migration does not replay a backlog.
5. **Existing cloud chat sessions.** Every session with `cursorCloudAgentId` set gets
   `runtimeRef: { pluginId: "ade-cursor-cloud", runtimeId: "cloud", externalId: <agentId> }`. Read
   the per-session metadata files (`agentChatService.ts:13533-13535`) once, at migration time.
   **A session that is not migrated becomes a dead chat that cannot take a follow-up** — this is the
   single highest-risk step in the whole plan. Write the migration to be idempotent and to log every
   session it converts and every one it could not.
6. **Existing automation rules.** Rules store the trigger type
   (`manifest.ts:352-355` — "renaming one orphans every rule using it"). Map
   `cursor.cloud_finished` → `plugin:ade-cursor-cloud/cloud_finished` and `cursor.cloud_error`
   likewise, in the same migration, or the user's rules stop firing silently.

## 5.3 The ingress-events table

`cursor_cloud_ingress_events` is exempt from pruning (`kvDb.ts:908-909`) because it is the replay
guard. Do **not** drop it in the same release that installs the plugin. Keep it for one release,
then drop it in the next, after the plugin's own `deliveries` ledger has proven itself. A dropped
replay guard means duplicate automation fires, which the user experiences as a bot spamming them.

## 5.4 How the plugin ships

**Bundled, and installed by the user.** Put it at `plugins/ade-cursor-cloud/`, beside `ade-linear`
and `ade-voice`. It is then discoverable by bare id through `resolvePluginInstallSource`
(`pluginInstallService.ts:396-420`), recorded with `source: { kind: "builtin" }` (`:722-725`), and
it skips the digest gate (`:667-674`).

**There is no default-install mechanism, and that is deliberate.** I checked for one and found the
opposite. `builtinTabs.ts:12-23` states the rule plainly:

> Every answer here starts at "not visible" and is moved only by a positive fact… That is the
> reverse of how this file read in round 1, when the surfaces were seeded onto every machine and
> hiding one had to be earned. **Nothing is seeded now**, so there is no existing install to protect
> … a machine with no plugins has no Graph tab, and that is the correct product, not a degraded one.

`builtinSurfaceInstalled` returns `false` unless a matching install record exists and is enabled
(`builtinSurfaces.ts:111-120`). No boot path installs anything — nothing in `main.ts` calls
`pluginInstallService.install`. `builtinSurfaceInstalls.ts` only *reads* which owners are installed;
it does not seed them.

So adding an auto-install for `ade-cursor-cloud` would reverse a platform decision that was made on
purpose, one round ago. **Do not do it.**

**Do this instead — PX-14, a one-time migration prompt · S.** On the first launch after the
extraction, on a machine that has Cursor Cloud state — a `cursor` API key in the store, or any
session with `cursorCloudAgentId`, or a registered webhook secret — show one dismissible card:

> **Cursor Cloud is now a plugin.** Your agents and cloud chats are still here. Install the Cursor
> Cloud plugin to keep using them. — *[Install]* *[Not now]*

Install runs the ordinary bundled-id path, and the plugin's first activate runs the migration in
§5.2. A machine with no Cursor Cloud state sees nothing and gains nothing, which is the same answer
Graph and Linear already give.

**This is the one place where the extraction is user-visible whatever you do.** A user who dismisses
the card has cloud chats that cannot take a follow-up until they install. Make the transcript say
so, using the gated-domain pattern — `policyDenied` with a message that names the fix, never
`methodNotFound` (`gatedActionDomains.ts:10-18`).

**Uninstall must be honest.** Uninstalling takes the fleet, the composer button, the agent tools and
the chat runtime with it — and a session whose `runtimeRef` names an uninstalled plugin must say so
in the transcript rather than silently refusing a follow-up. The gated-domain refusal already models
the right answer: `policyDenied` with a message that names the fix, never `methodNotFound`
(`gatedActionDomains.ts:10-18`).

## 5.5 No-regression checklist

Every user-visible behaviour that exists today. Each line must be demonstrated on the client(s)
listed before core code is deleted.

**Fleet list**
1. Open the fleet and see this project's agents. (desktop, iOS, TUI — **and now web**)
2. Filter by All / Active / Finished / Failed. (desktop, iOS)
3. Filter by lane. (desktop, iOS)
4. Show and hide archived agents, with the count. (desktop, iOS)
5. Refresh manually. (desktop, iOS pull-to-refresh, TUI `r`)
6. See three groups in order: Active runs, then one per lane, then Unlinked-by-repo-and-branch. (desktop, iOS)
7. See a row's name, status chip with tone, age, cost chip, branch-or-repo, model id, ownership chip (Linear id and/or lane). (desktop, iOS)
8. See the relay banner when live updates are unconfigured or erroring, with the exact two sentences. (desktop, iOS footer)
9. See the empty state with its exact copy. (desktop, iOS)
10. See the "Connect Cursor first" state and reach the AI-connections settings page from it. (desktop, iOS shows the sentence)
11. Auto-refresh when an agent finishes, while the panel is visible. (desktop)
12. See the unread-finished badge on the entry button. (desktop — **at risk, PX-11**)

**Row actions**
13. Open an agent as an ADE cloud chat, creating a lane if it is unlinked. (desktop, iOS)
14. Stop a running agent, including one launched outside ADE. (desktop, iOS, and the phone's "queued" wording)
15. Pull a finished agent's branch into its lane, with the two exact toast sentences. (desktop, iOS)
16. Archive and unarchive an agent. (desktop)
17. Delete an agent, with the two-press confirmation. (desktop)
18. Open the agent's PR. (desktop, iOS detail)
19. Open the agent on cursor.com. (desktop row expand, desktop footer, iOS detail, session card, chat header pill)
20. Expand a row to see the summary, the agent id, the run id and the token counts. (desktop)

**Chat runtime**
21. Launch a cloud agent from the composer: pick Cursor Cloud, type, send. (desktop)
22. See the launch-status strip: "Sending to Cursor Cloud..." then "Connecting to Cursor Cloud...". (desktop)
23. Attach ADE project secrets as cloud env vars, by name, refusing `CURSOR_`-prefixed names. (desktop)
24. Remember the chosen secret names for that lane, and pre-select them next time. (desktop)
25. Attach to an existing PR when the branch has one, or choose "Open a PR" when it does not. (desktop)
26. See the four "unavailable" sentences when the repo is not connected, the lane has no remote, the probe is running, or the probe failed. (desktop)
27. See a cloud chat's history hydrate into the transcript, with the loading and failure states and their retry. (desktop, iOS)
28. Send a follow-up in a cloud chat and see the reply stream in. (desktop, iOS)
29. See the "Cursor Cloud" pill in the chat header. (desktop)
30. Have the host poll only while somebody is watching that chat. (desktop, iOS, TUI)
31. See cloud artifacts materialize into the lane and appear as a proof-artifact card. (desktop)
32. Have the lane's branch `git fetch`ed when a run finishes. (desktop)
33. Have a status change wake a session that is not currently loaded. (desktop)

**Automations**
34. Build a rule on "A Cursor Cloud agent finishes" and on "…errors". (desktop)
35. Use `{{trigger.summary}}` and `{{trigger.branch}}` in that rule. (desktop)
36. Have exactly one delivery per webhook event, across an app restart. (desktop)

**CLI**
37. Run the six `ade cursor cloud` command groups. (**renamed** to `ade ade-cursor-cloud …` — a
    deliberate, documented break. Consider keeping `ade cursor cloud` as an alias for one release.)

**Cross-cutting**
38. A machine with no Cursor API key shows no fleet entry point and no composer option, and says why. (all)
39. An older host, or a phone paired to one, degrades to "absent" rather than "broken". (iOS)
40. Nothing regresses for **local** Cursor chat, which is not part of this extraction. (desktop)

---

# PART 6 — BUILD ORDER

Dependency edges are `→`. Anything on the same line runs in parallel.

```
PHASE 0 — free wins, no dependencies (1 builder, ~2 days)
  P0a  Delete ChatCursorCloudPanel.tsx + CursorCloudInlineLaunch.tsx (already dead)
  P0b  Fix the iOS/desktop fleet-argument divergence (SyncService.swift:9636 passes no args)

PHASE 1 — small platform units, fully parallel (4 builders, ~1 week)
  PX-2  Bound rows may act + confirm parity            ─┐
  PX-4  {openUrl} action-result verb                    │
  PX-5  Desktop/web result banner                       ├─→ all four are independent
  PX-6  Panel refresh contract                          │
  PX-12 Notification deeplink (optional)               ─┘

PHASE 2 — medium platform units, parallel (3 builders, ~1.5 weeks)
  PX-1  Rich list rows            ← wants PX-2 merged first (same files)
  PX-7  Declared outbound network + disclosure          (independent)
  PX-8  Host-brokered provider credentials              (independent)

PHASE 3 — the two large units, parallel (2 builders, ~2 weeks)
  PX-3  Client-evaluated panel state   ← wants PX-1 merged first (same files)
  PX-9  Plugin webhook ingress + relay generalization   (independent)

PHASE 3' — the long pole, STARTED IN PARALLEL WITH PHASE 1 (1-2 builders, ~4 weeks)
  PX-10 Plugin as a conversation source
        Depends on nothing in phases 1-3. Start it on day one.
        Its only coupling is that the plugin (phase 4) cannot finish without it.

PHASE 4 — build the plugin (2 builders, ~2 weeks)
  P4a  Child: Cursor API client, fleet assembly, collections writer   ← PX-7, PX-8
  P4b  Panels: fleet + agent + launch                                 ← PX-1, PX-2, PX-3, PX-4, PX-5, PX-6
  P4c  Webhook half + automation triggers                             ← PX-9
  P4d  Chat runtime half                                              ← PX-10
  P4e  Agent tools, skills, CLI words, search provider, keybinding     (independent)
  P4f  The migration in §5.2                                          ← P4a, P4c, P4d

PHASE 5 — remove core code (1 builder, ~1 week)
  P5a  Prove every line of the §5.5 checklist against the plugin
  PX-14 One-time migration prompt (§5.4). S. Independent — build it any time in phases 1-4,
        but it must merge in the SAME release that deletes the core code.
  P5b  Delete the 18 files and edit down the 25 call sites
  P5c  Keep cursor_cloud_ingress_events and the relay /cursor/* routes for one release
  P5d  Docs: a plugin page, and the mentions in chat/README.md, composer-and-ui.md,
       ios-companion.md and ARCHITECTURE.md
```

**Critical path:** PX-10 → P4d → P4f → P5a. Roughly 8 weeks with the fan-out above. Everything else
finishes earlier and waits.

**Fan-out advice.** Phases 1 and 2 are seven independent units across shared files
(`vocabularyNodes.ts` and the four renderers). Sequence PX-2 before PX-1 before PX-3 in that one
file, and run PX-4, PX-5, PX-6, PX-7, PX-8, PX-9 fully in parallel against it. Start PX-10 on day
one with your strongest builder; it touches `agentChatService.ts`, which is the file everything else
in this repo is afraid of.

**The decision point.** After phase 3, stop and judge. If PX-10 is going badly, you can ship the
fleet panel, the launch path, the webhook ingress and the agent tools as a plugin, and leave the
chat runtime in core behind a `runtimeRef` shim. That is a partial extraction and it is an honest
place to stand: the user gets a Cursor Cloud tab that works on four clients including the web, and
core keeps one Cursor-shaped seam instead of twenty.

---

# PART 7 — `ade-session-import`, briefly

Requested only if the platform gaps overlap. **They overlap substantially, and one gap is worse.**

Session import (`apps/desktop/src/main/services/externalSessions/`, shipped in PR #712) reads
Claude, Codex, Cursor, Droid and OpenCode session files off the local disk and imports them as ADE
chats. Mapping it against the same units:

- **PX-1, PX-2, PX-3** — reused exactly. An import picker is a filterable list of rows, each with a
  badge (provider), a mono line (path and time) and an action (Import). Identical shape to the fleet.
- **PX-5, PX-6** — reused exactly.
- **PX-10** — reused, and *more* central. An imported session is a transcript a plugin wrote. Session
  import today does a full cross-provider replay into ADE's transcript, so the
  `sdk.chat.appendUser` / `appendAssistant` half of PX-10 is the whole feature. It does **not** need
  `turnAction` or `presenceAction`, so it consumes the easier half.
- **PX-4, PX-7, PX-8, PX-9** — not needed. Session import is entirely local: no network, no
  credentials, no webhooks.
- **One gap Cursor Cloud does not have:** session import needs **filesystem read outside the project
  root** — `~/.claude/projects/`, `~/.codex/sessions/`, `~/.cursor/`. The plugin child runs with
  `cwd: pluginRoot` (`pluginChildSupervisor.ts:425`) but is a plain Node process with no filesystem
  restriction, so it *can* read those paths today — and, exactly as with PX-7's network, nothing
  declares it, discloses it or allowlists it. A plugin that reads every AI transcript on the machine
  is a bigger disclosure question than one that calls one API host.

  Call that **PX-13 — declared filesystem reach**, M, and design it beside PX-7 as the same
  disclosure mechanism with a different noun. Do not build it for Cursor Cloud; do build it before
  session import ships as a plugin.

**Conclusion.** Extract Cursor Cloud first. It funds PX-1 through PX-10, which is most of what
session import needs. Then extract session import against PX-13 alone.

---

## Anchor index

The claims most likely to be challenged, with their proof.

| claim | proof |
|---|---|
| The plugin child has unrestricted network | `pluginChildSupervisor.ts:410-434` — `spawn(process.execPath, [bootstrapPath])`, sanitized env, no network guard |
| A bound list row is inert on 3 clients and live on the 4th | `vocabularyNodes.ts:447-468` versus `PluginPaneStore.swift:200` |
| A hand-built fleet caps at ~27 rows | `VOCAB_LIMITS.maxNodes = 200` (`vocabularyNodes.ts:33`), 7 nodes per row |
| No vocabulary node opens a URL | `vocabularyComponents.tsx:90-106`, `PluginVocabularyView.swift:166-176` |
| There are exactly 4 action-result verbs | `sdk.ts:674`, `:736`, `:811`, `:877` |
| Desktop discards a plugin's result message | `PluginPanelHost.tsx:192-212` versus `PluginPaneStore.swift:334-337` |
| The TUI renders full plugin panels | `app.tsx:10453`, `pluginPane.ts:15-20`, `commands.ts:115` |
| Desktop drops non-builtin `pane` surfaces | `preload/pluginBridge.ts:102-116`, `pluginInstallServiceAdapter.ts:60-69` |
| `plugins.invoke` is viewer-allowed from the phone | `syncRemoteCommandService.ts:6031-6037` |
| A plugin may create a chat session but not own its turns | `registry.ts:603` versus the switch at `agentChatService.ts:39678` |
| The Cursor key is shared with local Cursor chat | `agentChatService.ts:7424-7434` and `aiIntegrationService.ts:1154-1160` both read provider `"cursor"` |
| Cursor Cloud never appears in the web client | `webclient/adapter/misc.ts:553-556`, `CursorCloudQuickViewButton.tsx:49` |
| iOS and desktop request different fleet sets | `SyncService.swift:9636-9638` (no args) versus `CursorCloudFleetModal.tsx:79` (`{includeArchived: true, limit: 200}`) |
| Two Cursor Cloud renderer files are already dead | `AgentChatPane.tsx:185-189` |
| `ade cursor cloud` never reads ADE's key store | `apps/ade-cli/src/cursorCloud.ts:201-207` |
| The ingress table is the replay guard and is prune-exempt | `kvDb.ts:908-909`, `:3483-3498` |
| Plugin deeplinks already exist | `deeplinks.ts:14`, `:684`, `:774-788` |
| No plugin is installed by default, on purpose | `builtinTabs.ts:12-23` ("Nothing is seeded now"), `builtinSurfaces.ts:111-120`; no `install` call in `main.ts` |
| `importBranch` is in the `lane` domain, not `lanes` | `registry.ts:380` |
