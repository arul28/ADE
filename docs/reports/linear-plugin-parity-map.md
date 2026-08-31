# Linear as a plugin: a parity map

**Question.** Could the Linear integration that ADE ships today be rebuilt 100%
as the official `ade-linear` plugin, from plugin primitives, on all surfaces?
The desktop pane, the mobile panel, the settings, the webhooks, the OAuth, and
the lane and agent spawn flows are all in scope.

**Method.** Section 1 inventories every built-in Linear feature with a file and
line anchor. Section 2 maps each feature against the plugin primitives that
exist on branch `plugin-platform` at commit `18bd6bdeb`. Section 3 gives the
verdict.

**Classification used in section 2.**

- **A** — buildable today. The primitive exists on every surface the feature
  needs.
- **B** — a small addition. The platform needs one named change. Size is S, M,
  or L.
- **C** — real platform work. No primitive comes close, or the work crosses
  several layers.

---

## 1. Inventory of the built-in Linear integration

### 1.1 What the `ade-linear` plugin is today

The plugin is a gating shell. It runs no code.

| Part | File | What it holds |
| --- | --- | --- |
| Manifest | `plugins/ade-linear/plugin.json:1` | One `pane` surface with `"builtin": "linear"` and `"mobile": true`. No `entry`, no tools, no sockets, no settings, no collections. |
| Panel | `plugins/ade-linear/panels/main.json:1` | One `emptyState` node. It says "Linear lives on the attached computer". |
| Skill | `plugins/ade-linear/skills/ade-linear/SKILL.md:1` | The agent skill for the `ade linear` CLI verbs. |
| Icon | `plugins/ade-linear/icon.svg` | Static asset. |

The `builtin` field names a compiled surface. It does not draw one. See
`apps/desktop/src/shared/plugins/manifest.ts:119`.

The gate table gives the plugin three ADE action domains:

```
builtinId: "linear", ownerPluginId: "ade-linear", route: null,
actionDomains: ["linear_credentials", "linear_oauth", "linear_issue_tracker"]
```

Source: `apps/desktop/src/shared/plugins/builtinSurfaces.ts:105`. The presence
rule is `enables`, not `supersedes`
(`apps/desktop/src/shared/plugins/manifest.ts:178`). Uninstalling the plugin
hides the pane and refuses the three domains at dispatch.

**Everything else stays compiled into core.** The inventory below is the list of
what "everything else" means. Roughly 5,400 lines of desktop renderer code,
2,900 lines of iOS code, and 8,200 lines of main-process service code.

### 1.2 Desktop renderer

| # | Feature | File:line | Notes |
| --- | --- | --- | --- |
| D1 | Linear issue browser — the pane itself | `apps/desktop/src/renderer/components/app/LinearIssueBrowser.tsx:476` | 1,874 lines. Master/detail. Grouped issue list on the left, issue detail on the right. |
| D2 | State tabs: All / Active / Backlog | `LinearIssueBrowser.tsx:70` | Three presets over Linear state types. |
| D3 | Filters: project, assignee, priority, free text, sort | `LinearIssueBrowser.tsx:61`, `:92`, `:101`, `:110` | Five filter axes. Five sort orders. |
| D4 | Filter persistence per project root | `LinearIssueBrowser.tsx:78`, `:236` | `localStorage`, key `ade.linear.quickView.filters.v1:<root>`. |
| D5 | Multi-select persistence per project root | `LinearIssueBrowser.tsx:79`, `:288` | Up to 100 selected ids survive a reload. |
| D6 | Grouped list with collapsible state groups | `LinearIssueBrowser.tsx:380`, `:555` | Seven state groups in a fixed rank order. |
| D7 | Infinite scroll, 100 per page, 500 auto-load ceiling | `LinearIssueBrowser.tsx:86`, `:90` | Past 500 the reader opts in by button. |
| D8 | In-memory search cache with 90 s staleness | `LinearIssueBrowser.tsx:81`, `:211` | 16 cached searches per project. Promise coalescing. |
| D9 | Shift-click range selection | `LinearIssueBrowser.tsx:552` | `lastCheckedId` anchors the range. |
| D10 | Issue detail: markdown description | `LinearIssueBrowser.tsx:424`, `:466` | Full ADE chat markdown renderer. |
| D11 | Issue detail: labels, properties, sub-issues | `LinearIssueBrowser.tsx:1625`, `:1658`, `:1708` | |
| D12 | Issue detail: comment thread, loaded lazily | `LinearIssueBrowser.tsx:1735` | Calls `cto.getLinearIssueComments`. |
| D13 | Single-issue launch: lane + agent, or lane only | `LinearIssueBrowser.tsx:1465` | Two actions with descriptions and icons. |
| D14 | Batch launch: lanes + agents, or lanes only | `LinearIssueBrowser.tsx:1800`, `:1805` | Runs over the whole selection. |
| D15 | Lane-conflict badge on an already-attached issue | `LinearIssueBrowser.tsx:1411` | Warns before a second attach. |
| D16 | Batch progress toast | `apps/desktop/src/renderer/components/app/BatchLaunchStatusToast.tsx` | Live counts of total, completed, failed. |
| D17 | Batch launch orchestration | `apps/desktop/src/renderer/lib/linearBatchLaunch.ts:1` | 565 lines. Sequencing, retries, conflict resolution. |
| D18 | Top-bar Linear button, gated by plugin presence | `apps/desktop/src/renderer/components/app/LinearQuickViewButton.tsx:106`, `:124` | 814 lines. Also renders as a menu row. |
| D19 | Linear pane modal shell | `apps/desktop/src/renderer/components/app/LinearPaneModal.tsx:1` | 172 lines. |
| D20 | Issue select modal (picker) | `apps/desktop/src/renderer/components/app/LinearIssueSelectModal.tsx:1` | 164 lines. Used by lane creation. |
| D21 | Issue resolve modals | `apps/desktop/src/renderer/components/app/LinearIssueResolveModals.tsx:1` | Conflict and re-attach prompts. |
| D22 | Command palette `kind:linear` results | `apps/desktop/src/renderer/components/app/commandPaletteSearch.tsx:50`, `:62`, `:83` | Section heading "Issues". |
| D23 | Palette row opens the quick view | `apps/desktop/src/renderer/components/app/CommandPalette.tsx:1629` | Via `requestLinearIssueQuickView`. |
| D24 | Palette hides Linear rows when the plugin is absent | `CommandPalette.tsx:338`, `:345` | `useBuiltinSurfaceVisible("linear")`. |
| D25 | Quick-view navigation bus | `apps/desktop/src/renderer/lib/linearIssueQuickViewNavigation.ts:1` | Cross-component request channel. |
| D26 | Lane row Linear issue badge with hover card | `apps/desktop/src/renderer/components/lanes/LinearIssueBadge.tsx:49` | 278 lines. |
| D27 | Badge actions: start chat, copy link, open in Linear | `LinearIssueBadge.tsx:224`, `:244`, `:257` | |
| D28 | Linear brand mark and colour tokens | `apps/desktop/src/renderer/components/lanes/linearBrand.tsx:1` | 181 lines. Custom SVG. |
| D29 | Linear project icon renderer | `apps/desktop/src/renderer/components/lanes/linearProjectIcon.tsx:1` | 154 lines. Linear's own icon set. |
| D30 | Issue display helpers | `apps/desktop/src/renderer/components/lanes/linearIssueDisplay.ts:1` | |
| D31 | Create-lane dialog Linear picker | `apps/desktop/src/renderer/components/lanes/CreateLaneDialog.tsx` | Attaches an issue at lane creation. |
| D32 | Graph lane node Linear badge | `apps/desktop/src/renderer/components/graph/graphNodes/LaneNode.tsx` | |
| D33 | PR create modal: magic-word reference | `apps/desktop/src/renderer/components/prs/CreatePrModal.tsx` | Inserts `Fixes`/`Refs <ID>`. |
| D34 | PR rows, timeline and merge rail Linear links | `apps/desktop/src/renderer/components/prs/shared/*.tsx` | Seven files. |
| D35 | Chat composer issue chips and context | `apps/desktop/src/renderer/components/chat/UserMessageIssueContext.tsx`, `AgentChatComposer.tsx` | |
| D36 | Chat smart-link chips for Linear URLs | `apps/desktop/src/renderer/components/chat/smartLinkChipMark.ts` | |
| D37 | Settings: Linear section | `apps/desktop/src/renderer/components/settings/LinearSection.tsx:84` | 905 lines. |
| D38 | Settings: OAuth connect and disconnect | `LinearSection.tsx:488`, `:495`, `:620` | |
| D39 | Settings: API key entry and validation | `LinearSection.tsx:677`, `:701` | `lin_api_...` secure field. |
| D40 | Settings: workspace avatar and identity card | `LinearSection.tsx:22` | Org logo, name, viewer name. |
| D41 | Settings: GitHub autolink management | `LinearSection.tsx:748`, `:829` | Creates GitHub autolinks for issue keys. |
| D42 | Automations: five Linear trigger types | `apps/desktop/src/renderer/components/automations/triggerCatalog.ts:82` | created, updated, assigned, status changed, labeled. |
| D43 | Automations: Linear trigger filters UI | `apps/desktop/src/renderer/components/automations/LinearTriggerFilters.tsx:1` | Project, team, assignee, label, state. |
| D44 | Automations: ingress status strip | `apps/desktop/src/renderer/components/automations/settings/IngressStatusStrip.tsx` | Shows relay health. |
| D45 | Activity pane Linear entries | `apps/desktop/src/renderer/components/activity/ActivityPane.tsx` | |
| D46 | Web client route and adapter parity | `apps/desktop/src/renderer/webclient/shell/webRoutes.ts`, `adapter/misc.ts` | The hosted client draws the same components. |

### 1.3 iOS

The mobile panel is a full navigation stack, not a card.

| # | Screen or feature | File:line | Notes |
| --- | --- | --- | --- |
| M1 | Pane sheet with its own `LinearRoute` stack | `apps/ios/ADE/Views/Linear/LinearPaneSheet.swift:6`, `:42` | Routes: list, issue, launch, connection. |
| M2 | Pane store | `apps/ios/ADE/Views/Linear/LinearPaneStore.swift:61` | 308 lines. Query, filters, paging, attached-issue set. |
| M3 | Issue list, grouped by state | `apps/ios/ADE/Views/Linear/LinearIssueListScreen.swift:17`, `:44` | Native `List` with sections. |
| M4 | Native search bar | `LinearIssueListScreen.swift:61` | `.searchable` in the nav bar drawer. |
| M5 | Pull to refresh | `LinearIssueListScreen.swift:62` | `.refreshable`. |
| M6 | Filter chips bar, horizontally scrolling | `LinearIssueListScreen.swift:254`, `:283` | Toggle chips. |
| M7 | Filters menu: project and priority submenus | `LinearIssueListScreen.swift:309`, `:314`, `:328` | Nested `Menu`. Six priority options. |
| M8 | Collapsible group headers | `LinearIssueListScreen.swift:225`, `LinearPaneStore.swift:306` | Per-group override state. |
| M9 | Infinite scroll paging | `LinearPaneStore.swift:180`, `:219` | `loadMore` plus `loadAllPages`. |
| M10 | Debounced reload on filter change | `LinearPaneStore.swift:148` | `scheduleReload`. |
| M11 | Fallback search by identifier | `LinearPaneStore.swift:199` | For a deeplink to an issue outside the filter. |
| M12 | Issue detail screen | `apps/ios/ADE/Views/Linear/LinearIssueDetailScreen.swift:5` | 324 lines. Scroll view, six sections. |
| M13 | Markdown description with text selection | `LinearIssueDetailScreen.swift:20` | `markdownAttributedString`, `.textSelection(.enabled)`. |
| M14 | Status chip and priority icon in the header | `LinearIssueDetailScreen.swift:63`, `:236` | Custom drawn. |
| M15 | "Has lane" indicator | `LinearIssueDetailScreen.swift:69` | |
| M16 | Label capsules, horizontally scrolling | `LinearIssueDetailScreen.swift:80` | |
| M17 | Properties card: assignee, project, team, due, branch, blockers | `LinearIssueDetailScreen.swift:100` | Branch name is monospaced and selectable. |
| M18 | Sub-issues list with state icons | `LinearIssueDetailScreen.swift:128` | |
| M19 | Comments, loaded on appear, with skeletons | `LinearIssueDetailScreen.swift:155`, `:224` | `LinearCommentRow` renders markdown. |
| M20 | Toolbar "Open in Linear" | `LinearIssueDetailScreen.swift:37` | `openURL`. |
| M21 | Pinned bottom launch bar, two actions | `LinearIssueDetailScreen.swift:186` | `.safeAreaInset(edge: .bottom)` over `.ultraThinMaterial`. |
| M22 | Launch configuration screen | `apps/ios/ADE/Views/Linear/LinearLaunchScreen.swift:7` | 372 lines. |
| M23 | Session type picker: chat or CLI | `LinearLaunchScreen.swift:139` | |
| M24 | Model picker sheet | `LinearLaunchScreen.swift:101` | Reuses `WorkModelPickerSheet`. |
| M25 | Reasoning effort and Codex fast mode | `apps/ios/ADE/Views/Linear/LinearLaunchModel.swift:36` | Full launch config struct. |
| M26 | Kickoff prompt derived from the issue | `LinearLaunchModel.swift:223` | `linearDefaultKickoff`. |
| M27 | Lane name and branch name derived from the issue | `LinearLaunchModel.swift:143`, `:150` | Ports `shared/linearIssueBranch.ts`. |
| M28 | Launch orchestration with rollback | `LinearLaunchModel.swift:104`, `:59` | Deletes the lane if the agent fails to start. |
| M29 | Connection screen | `apps/ios/ADE/Views/Linear/LinearConnectionScreen.swift:8` | 506 lines. |
| M30 | Worker-bounce OAuth from the phone | `apps/ios/ADE/Views/Linear/LinearOAuthRunner.swift:29` | `ASWebAuthenticationSession`, scheme `ade`. |
| M31 | API key fallback entry | `LinearConnectionScreen.swift:346` | `SecureField`. |
| M32 | Disconnect with confirmation | `LinearConnectionScreen.swift:82`, `:143` | Destructive role. |
| M33 | Organisation avatar | `LinearConnectionScreen.swift:432` | Remote logo with initials fallback. |
| M34 | Token expiry copy | `LinearConnectionScreen.swift:482` | |
| M35 | Toolbar button in the pane | `apps/ios/ADE/Views/Linear/LinearPaneToolbarButton.swift:1` | |
| M36 | Brand colours and SVG mark | `LinearBrand.swift:1`, `LinearSVGPath.swift:1` | 418 lines together. Hand-ported vector paths. |
| M37 | `ade://linear-issue/<ID>` deeplink handling | `apps/ios/ADE/App/DeepLinkRouter.swift:125`, `:640` | |
| M38 | Deeplink waits for the plugin presence gate | `DeepLinkRouter.swift:660` | `pluginPresenceGate.awaitOwner(of: .linear)`. |
| M39 | "Send to Mac" fallback for an unopenable link | `DeepLinkRouter.swift:653`, `:731` | |
| M40 | Lane cards and lane detail Linear badges | `apps/ios/ADE/Views/Lanes/LaneComponents.swift`, `LaneDetailScreen.swift` | |
| M41 | PR screens Linear references | `apps/ios/ADE/Views/PRs/*.swift` | Ten files. |
| M42 | Work chat issue context | `apps/ios/ADE/Views/Work/WorkChatSessionView.swift` and siblings | |
| M43 | CTO settings screen Linear rows | `apps/ios/ADE/Views/Cto/CtoSettingsScreen.swift` | |

### 1.4 Main process and daemon

| # | Service | File:line | Notes |
| --- | --- | --- | --- |
| S1 | Linear GraphQL client | `apps/desktop/src/main/services/cto/linearClient.ts:1` | 1,505 lines. Retries, rate limits, normalisation. |
| S2 | Issue tracker interface | `apps/desktop/src/main/services/cto/issueTracker.ts:69` | 25 verbs. Read and write. |
| S3 | Issue tracker implementation | `apps/desktop/src/main/services/cto/linearIssueTracker.ts:1` | |
| S4 | Credential service | `apps/desktop/src/main/services/cto/linearCredentialService.ts:1` | 712 lines. API key and OAuth token, keychain-backed. |
| S5 | OAuth service, loopback flow | `apps/desktop/src/main/services/cto/linearOAuthService.ts:367`, `:489` | Local HTTP server on `127.0.0.1:19836`. PKCE. |
| S6 | OAuth service, worker-bounce flow for mobile | `linearOAuthService.ts:21`, `:587` | Redirect URI is a Cloudflare Worker. |
| S7 | Token refresh and refresh lock | `linearTokenRefresh.ts:1`, `linearOAuthRefreshLock.ts:1` | Cross-process lock. |
| S8 | Lane card service | `apps/desktop/src/main/services/cto/linearLaneCardService.ts:1` | 514 lines. Posts an ADE attachment onto the issue. |
| S9 | Live status round-trip, env-gated | `apps/desktop/src/main/services/cto/linearLiveStatusService.ts:28` | Moves state, assigns, comments on launch, PR and merge. |
| S10 | GraphQL input sanitiser | `linearGraphQLInput.ts:1` | |
| S11 | Webhook ingress service | `apps/desktop/src/main/services/automations/linearIngressService.ts:1` | 536 lines. Registers a Linear webhook, polls the relay. |
| S12 | Relay configuration and secret storage | `apps/desktop/src/main/services/automations/linearRelayConfig.ts:1` | |
| S13 | Automation dispatch from relay events | `apps/desktop/src/main/services/automations/linearAutomationDispatch.ts:11` | One event can fire two triggers. |
| S14 | Agent tools for Linear | `apps/desktop/src/main/services/ai/tools/linearTools.ts:1` | 262 lines. Nine tools. |
| S15 | Three ADE action domains | `apps/desktop/src/main/services/adeActions/registry.ts:805` | 6 + 2 + 18 verbs. |
| S16 | Search provider for `kind:linear` | `apps/desktop/src/main/services/search/searchService.ts:1356` | Live Linear search, never on the default path. |
| S17 | Lane service Linear attach and detach | `apps/desktop/src/main/services/lanes/laneService.ts` | Session-level issue links. |
| S18 | Session environment injection | `plugins/ade-linear/skills/ade-linear/SKILL.md:26` | `ADE_LINEAR_ISSUE_IDS`, `ADE_LINEAR_CONTEXT_FILE`. |
| S19 | PR service magic-word handling | `apps/desktop/src/main/services/prs/prService.ts`, `shared/linearMagicWords.ts:1` | `Fixes` and `Refs`. |
| S20 | Smart link preview for Linear URLs | `apps/desktop/src/main/services/chat/smartLinkPreviewService.ts` | |
| S21 | CTO state service Linear sync | `apps/desktop/src/main/services/cto/ctoStateService.ts` | |
| S22 | Headless Linear services for the CLI | `apps/ade-cli/src/headlessLinearServices.ts:1` | The daemon runs the same services. |
| S23 | `ade linear` CLI verbs | `apps/ade-cli/src/cli.ts:2689` | attach, issues, issue, comment, set-state, assign, label, graphql, detach. |
| S24 | CTO-role CLI verbs | `apps/ade-cli/src/cli.ts:2706` | quick-view, picker-data, search-issues, issue-comments. |
| S25 | `ade linear install` | `apps/ade-cli/src/cli.ts:752` | Registers ADE as Linear's "Open in coding tool" target. |
| S26 | `ade lanes create-from-linear` and the batch form | `apps/ade-cli/src/cli.ts:1857`, `:1860` | |
| S27 | TUI Linear commands | `apps/ade-cli/src/tuiClient/linearCommands.ts:1` | 353 lines. Plus `issueCommands.ts`. |
| S28 | Sync layer Linear models | `apps/ios/ADE/Models/RemoteModels.swift`, `apps/desktop/src/shared/types/linearSync.ts` | The phone reads Linear over sync. |

### 1.5 Shared types and helpers

| # | Item | File |
| --- | --- | --- |
| T1 | `NormalizedLinearIssue`, `LaneLinearIssue`, catalogs | `apps/desktop/src/shared/types/cto.ts`, `types/lanes.ts` |
| T2 | Lane issue link roles | `apps/desktop/src/shared/laneLinearIssue.ts` |
| T3 | Branch name derivation | `apps/desktop/src/shared/linearIssueBranch.ts` |
| T4 | PR magic words | `apps/desktop/src/shared/linearMagicWords.ts` |
| T5 | Deeplink kind `linear-issue` | `apps/desktop/src/shared/deeplinks.ts:142`, `:481`, `:665` |
| T6 | Deeplink envelope field `linear` | `apps/desktop/src/shared/deeplinks.ts:287`, `:370` |
| T7 | Ingress event records | `apps/desktop/src/shared/types/linearSync.ts` |
| T8 | Smart link parsing | `apps/desktop/src/shared/smartLinks.ts` |

---

## 2. The map: each feature against today's primitives

### 2.0 The primitives I mapped against

Read this first. Section 2 uses these names without re-explaining them.

**Panels.** Vocabulary v1, `apps/desktop/src/shared/plugins/vocabularyNodes.ts:118`.
Fourteen components: `stack`, `text`, `badge`, `button`, `list`, `table`,
`form`, `chart`, `video`, `image`, `divider`, `keyValue`, `emptyState`,
`segmented`. Hard ceilings at `vocabularyNodes.ts:54`: 200 nodes, depth 8, 64 KB
of schema, 100 list items, 3 trailing actions per row, 6 overflow actions per
row, 60 `keyValue` rows, 24 form fields, 100 table rows.

**Panel state.** `segmented` owns client state. Four state keys per panel. Eight
options per control. See `vocabularyState.ts:83`. State is per-viewer and
session-scoped. It never persists (`vocabularyState.ts:109`).

**Binding filters.** A binding takes a `where` predicate. It compares row fields
to literals or to state keys. It also resolves `{"$rel": "-24h"}` against the
client clock. See `vocabularyState.ts:149`.

**Forms.** `submit` draws a button. `applyOnChange` dispatches on every committed
field change with no button. See `vocabularyNodes.ts:377`.

**Panel navigation.** An action returns `{navigate: {panelId, context}}`. The
context reaches the destination as `$context`. Ceiling 2 KB. See `sdk.ts:1375`.

**Refresh.** A panel declaring `refreshAction` gets a desktop refresh control,
iOS pull to refresh, and the TUI `r` key. See `manifest.ts:270`.

**Sockets.** Seventeen kinds (`sockets.ts:41`). iOS draws eleven of them
(`sockets.ts:266`). iOS draws none of `slash-command`,
`command-palette-action`, `settings-section`, `work-rail-pane`, `drawer-tab`, or
`dialog-section`.

**SDK.** `sdk.ts:996`. Actions at agent role, collections, secrets, provider
keys, contributions, events, `panels.update`, `config.set`, audio,
notifications, schedules, automation triggers, webhooks, chat runtime
ownership, clipboard, a file picker, memory, and logging.

**Manifest engine registrations.** `manifest.ts:634`. Surfaces, panels, sockets,
collections, settings, CLI words, skills, agent tools, automation triggers,
automation steps, search providers, keybindings, chat runtimes, webhook ingress
channels, network hosts, provider keys, project secrets, and a theme.

**Action results.** `navigate`, composer edit, dialog edit, webview pointer,
message, `openUrl`, and `prompt`. See `sdk.ts:1375` through `sdk.ts:1908`.

Two facts constrain everything below.

1. **`providerKeys` has no `linear` entry.** See `manifest.ts:489`. A plugin
   cannot read ADE's stored Linear credential. It must hold its own.
2. **A plugin authenticates at `agent` role.** See `sdk.ts:1001`. Every verb in
   `ADE_ACTION_CTO_ONLY` is refused. That includes
   `linear_credentials.setToken`, `linear_oauth.startSession`, and
   `automations.linearIngressSetup`. See `registry.ts:180`, `:216`.

Two facts open more than they close.

3. **`lane.create`, `lane.attachLinearIssueToSession`, `chat.createSession`,
   `chat.launchCli` and `chat.sendMessage` are NOT CTO-only.** A plugin can
   create a lane and start an agent on it today. See `registry.ts:368`, `:619`.
4. **The plugin child is a plain Node process.** `network.ts:13` says so
   explicitly: it is a declaration and a guard-rail, not a sandbox.

### 2.1 Desktop

| # | Feature | Class | Primitive, or what is missing |
| --- | --- | --- | --- |
| D1 | Master/detail pane | **B (S)** | Two panels plus `navigate` is the vocabulary-native shape. A side-by-side split is a `stack` with `direction: "horizontal"`, but the two halves cannot scroll independently. Missing: a two-pane layout hint. |
| D2 | State tabs All/Active/Backlog | **A** | One `segmented` with three options. A binding `where` clause filters on `stateType`. |
| D3 | Filters: assignee, priority, text, sort | **A** | Four more controls. Priority has six options, under the cap of eight. |
| D3b | Filter: project | **B (S)** | `maxStateOptions` is 8 (`vocabularyState.ts:87`). A real workspace has more projects. Missing: a state control whose options bind to a collection. |
| D4 | Filter persistence per project | **A** | The plugin persists to its own collection on `onChange` and re-materializes the panel. Panel state itself never persists. |
| D5 | Multi-select persistence | **C** | Depends on D9. |
| D6 | Collapsible state groups | **B (S)** | Seven groups need seven booleans. `maxStateKeys` is 4. Missing: a raised cap, or a disclosure component. A `segmented` "show group" filter is the reduced substitute. |
| D7 | Infinite scroll to 500 issues | **B (M)** | `maxListItems` is 100. A "Load more" `button` that republishes is expressible. Scroll-triggered paging is not. Missing: a paging affordance on `list`. |
| D8 | Search cache, 90 s staleness | **A** | Plugin-side. Collections plus `refreshAction`. |
| D9 | Shift-click range selection | **C** | The vocabulary has no selection primitive at all. No checkbox, no selected set, no range anchor. This is real platform work. |
| D10 | Markdown issue description | **B (L)** | `text` has five variants and none render markdown. Missing: a `markdown` node or variant, plus a safe renderer on desktop, web, iOS and the TUI. |
| D11 | Labels, properties, sub-issues | **A** | `stack` of `badge`, `keyValue` (60 rows), and a nested `list`. |
| D12 | Comment thread | **A** | A `list` bound to a comments collection. Markdown bodies fall to D10. |
| D13 | Single-issue launch: lane + agent | **A** | Two `button` nodes. The handler invokes `lane.create`, then `lane.attachLinearIssueToSession`, then `chat.createSession` or `chat.launchCli`. |
| D14 | Batch launch over a selection | **C** | Blocked by D9. The orchestration itself is plugin code and would be fine. |
| D15 | Lane-conflict badge | **A** | A `badge` on the row, materialized by the plugin from `lane.list`. |
| D16 | Batch progress toast | **B (S)** | `notifications.post` is an OS notification, not an in-app live toast. A republished panel row is the reduced substitute. Missing: an in-app progress affordance. |
| D17 | Batch orchestration and retries | **A** | Plugin code. |
| D18 | Top-bar Linear button | **B (S)** | A `pane` surface gets a rail or entry-menu place, not a top-bar slot. `toolbar-action` mounts on the six list-shaped surfaces, not on the window chrome. Missing: an `app`-surface toolbar slot. |
| D19 | Pane modal shell | **A** | The pane surface is the shell. |
| D20 | Issue picker inside the create-lane dialog | **A on desktop** | `dialog-section` on `create-lane`, with a panel. See `sockets.ts:186`. |
| D21 | Conflict and re-attach modals | **B (S)** | `confirm` on an action gives one sentence. `prompt` gives a title, a placeholder and one text field (`sdk.ts:1820`). A rich modal is not expressible. |
| D22 | Palette `kind:linear` results | **A** | `searchProviders` in the manifest (`manifest.ts:459`). |
| D23 | Palette row opens the quick view | **A** | The provider's result carries a plugin deeplink; `navigate` opens the panel. |
| D24 | Palette hides rows when absent | **A** | Already how plugin search providers work. |
| D25 | Quick-view navigation bus | **A** | Replaced by `navigate`. |
| D26 | Lane row Linear badge | **A** | `row-badge` on the `lanes` surface, published per lane. |
| D27 | Badge hover card with three actions | **B (S)** | `row-menu-item` gives the three verbs in the row menu. A hover card is not a socket. Reduced polish, not lost function. |
| D28 | Linear brand mark, custom SVG | **B (S)** | The manifest carries `icon.svg` and `accent` for the plugin. Node-level `icon` fields take icon NAMES only. Missing: a per-node custom glyph. |
| D29 | Linear project icon set | **B (S)** | Same gap. `image` with a `data:` URI is the workaround, at 8 KB per source. |
| D30 | Issue display helpers | **A** | Plugin code. |
| D31 | Create-lane dialog picker wiring | **A on desktop** | Same as D20. |
| D32 | Graph lane node badge | **C** | The Graph is a compiled canvas owned by `ade-graph`. No socket surface reaches a graph node. |
| D33 | PR magic words `Fixes`/`Refs` | **C** | `shared/linearMagicWords.ts` is core, and `prService` reads `lane.linearIssue`. See section 2.5. |
| D34 | PR rows, timeline, merge rail links | **C** | Same root cause. |
| D35 | Chat composer issue chips | **B (M)** | `composer-action` (iOS true) can attach context. The chip rendering inside the transcript is core. |
| D36 | Chat smart-link chips for Linear URLs | **C** | `shared/smartLinks.ts` parses URLs in core. No plugin registers a URL matcher. |
| D37 | Settings section | **A on desktop** | `settings-section` socket plus a panel. |
| D38 | OAuth connect and disconnect | **C** | See section 2.4. |
| D39 | API key entry and validation | **A** | A `form` with a `secret` field and a submit action. The handler writes `ade.secrets`. |
| D40 | Workspace avatar and identity card | **A** | `image` with an `https` source, plus `keyValue`. |
| D41 | GitHub autolink management | **A** | `github` autolink verbs are not CTO-only. A `list` plus a `button` per candidate. |
| D42 | Five Linear automation triggers | **A** | `automationTriggers` in the manifest, fired with `automations.emitTrigger` (`sdk.ts:2322`). |
| D43 | Rich Linear trigger filters | **B (M)** | A plugin trigger gets the generic rule builder. The five-axis filter card is compiled. Missing: a trigger-scoped filter schema in the manifest. |
| D44 | Ingress status strip | **A** | A `settings-section` panel with `keyValue` and a `button`. |
| D45 | Activity pane entries | **A** | `activity-entry` socket. Drawn on iOS too. |
| D46 | Web client parity | **A** | Web tracks desktop for every socket kind (`sockets.ts:267`). |

### 2.2 iOS — the ruthless pass

The question for each row is not "can something be drawn". It is whether
vocabulary expresses it at **current polish**, at **reduced-but-native polish**,
or **not at all**.

Two structural facts govern this whole table.

- **Panel navigation on iOS replaces the panel in place.** It is not a
  `NavigationStack` push. See `apps/ios/ADE/Views/Plugins/PluginPaneStore.swift:508`.
  There is no back gesture and no back button. The comment is explicit: "In
  place, not as a second sheet".
- **Navigating clears panel state.** `clearPanelState()` runs on every
  navigation (`PluginPaneStore.swift:521`). Filters do not survive a trip into a
  detail panel and back.

| # | iOS feature | Fidelity | Verdict |
| --- | --- | --- | --- |
| M1 | Pane sheet with a four-route stack | Reduced | **B (M)**. Panels are the routes and `navigate` moves between them. Missing: a panel back stack with the native swipe gesture, and state preserved across a return. |
| M2 | Pane store: query, filters, paging | Current | **A**. Plugin-side. |
| M3 | Issue list grouped by state | Reduced | **B (S)**. A `list` has no section headers. Seven `divider` plus `list` pairs is the substitute — 14 nodes, well within budget, visually flatter. |
| M4 | Native `.searchable` nav-bar search | Not at all | **B (M)**. A `form` text field sits in the body, not the nav bar, and applies on commit rather than as you type. Missing: a panel-level search declaration clients draw natively. |
| M5 | Pull to refresh | Current | **A**. `refreshAction` gives exactly this. |
| M6 | Horizontal filter chips bar | Reduced | **A**. `segmented` with `style: "toggle"` is close. |
| M7 | Nested filters menu, project submenu | Reduced | **B (S)**. Priority fits in eight options. Project does not. Same gap as D3b. |
| M8 | Collapsible group headers | Not at all | **B (S)**. Same four-state-key ceiling as D6. |
| M9 | Infinite scroll paging | Reduced | **B (M)**. Same 100-item cap and missing paging affordance as D7. |
| M10 | Debounced reload on filter change | Current | **A**. `onChange` plus plugin-side debounce. |
| M11 | Fallback search by identifier | Current | **A**. |
| M12 | Issue detail screen | Reduced | **A** structurally, as a second panel. It arrives by replacement, not by push — see M1. |
| M13 | Markdown description, text-selectable | Not at all | **B (L)**. No markdown anywhere in the vocabulary. Text selection is host chrome and would follow the renderer. |
| M14 | Status chip and custom priority icon | Reduced | **A** for the chip (`badge` with tone and icon). The hand-drawn Linear priority bars become an icon name. |
| M15 | "Has lane" indicator | Current | **A**. A `badge`. |
| M16 | Scrolling label capsules | Reduced | **A**. A `stack` with `wrap: true` of `badge` nodes. It wraps rather than scrolling. |
| M17 | Properties card, six rows | Reduced | **A**. `keyValue` holds 60 rows. The monospaced branch value loses its monospace: `keyValue` rows carry no variant. |
| M18 | Sub-issues with state icons | Current | **A**. A nested `list` with per-item `icon`. |
| M19 | Comments with loading skeletons | Reduced | **A** for the list. Skeletons are host chrome. Markdown bodies fall to M13. |
| M20 | Toolbar "Open in Linear" | Current | **A**. A `button` returning `openUrl`. Confirmed reachable on iOS (`PluginPaneStore.swift:980`). |
| M21 | Pinned bottom launch bar over material | Reduced | **B (S)**. Two `button` nodes at the end of the body scroll with the content. Missing: a sticky footer region. |
| M22 | Launch configuration screen | Current | **A**. A `form` with select fields. |
| M23 | Session type picker, chat or CLI | Current | **A**. A two-option `select` field or a `segmented`. |
| M24 | Native model picker sheet | Reduced | **B (S)**. The plugin materializes the model list into a `select`. It loses `WorkModelPickerSheet` — search, grouping, provider logos. |
| M25 | Reasoning effort and Codex fast mode | Current | **A**. A `select` and a `toggle`. |
| M26 | Kickoff prompt from the issue | Current | **A**. A `text` field pre-filled by the plugin. |
| M27 | Lane and branch name derivation | Current | **A**. Plugin code. |
| M28 | Launch with rollback on failure | Current | **A**. `lane.create`, `chat.createSession`, `lane.delete` on failure. |
| M29 | Connection screen | Partial | The screen is reachable from the pane, so it does NOT need `settings-section` (which iOS does not draw). A second PANEL of the pane serves it. **A** for the frame. |
| M30 | Worker-bounce OAuth from the phone | Not at all | **C**. See 2.4. |
| M31 | API key `SecureField` | Current | **A**. A `form` `secret` field. |
| M32 | Disconnect with a destructive confirm | Current | **A**. A `button` with `confirm`. Note: the vocabulary has no red tone; destructive reads amber (`vocabularyNodes.ts:140`). |
| M33 | Organisation avatar with initials fallback | Current | **A**. `image` accepts `https` and `data` on iOS (`PluginVocabularyMediaViews.swift:89`). |
| M34 | Token expiry copy | Current | **A**. A `text` node. |
| M35 | Pane toolbar button | Current | **A**. |
| M36 | Hand-ported Linear SVG paths | Not at all | **B (S)**. Same per-node glyph gap as D28. Plugin icon and accent survive. |
| M37 | `ade://linear-issue/<ID>` deeplink | Reduced | **B (M)**. `ade://plugin/<id>/<panel>?ctx=` exists (`deeplinks.ts:684`). The `linear-issue` host is a CORE kind. Missing: plugin-owned deeplink aliases. |
| M38 | Deeplink waits for the presence gate | Current | **A**. Already plugin-aware (`PluginPresenceGate.swift:26`). |
| M39 | "Send to Mac" fallback | Current | **A**. Core behaviour, kind-agnostic. |
| M40 | Lane card and lane detail badges | Current | **A**. `row-badge` on `lanes`, drawn on iOS. |
| M41 | PR screen Linear references | Reduced | **C**. Same core-lane-field root cause as D33. |
| M42 | Work chat issue context | Reduced | **B (M)**. Same as D35. |
| M43 | CTO settings Linear rows | Not at all | **B (M)**. iOS draws no `settings-section`. |

**Interaction classes the owner asked about, answered directly.**

- **Rich text and comment composition.** Not at all. There is no markdown
  renderer and no multi-line composer node. `form` gives a single-line `text`
  field. Posting a comment is expressible; writing a formatted one is not.
- **Inline editing.** Reduced. `form` with `applyOnChange` edits fields in place
  and needs no Apply button. It cannot edit a row inside a `list`.
- **Attachment and image viewing.** Reduced. `image` renders `https` and `data`
  sources with a `maxHeight`. There is no lightbox, no pinch to zoom, no gallery.
- **Drag and reorder.** Not at all. No primitive.
- **Optimistic updates.** Not at all. Every action is a round trip to the
  desktop over sync (`SyncService.swift:9473`). The panel redraws when the
  plugin republishes. The built-in panel has the same round trip for DATA, so
  this is not a regression in latency — it is a regression in perceived
  responsiveness for writes.
- **Per-item navigation depth.** One level, destructively. See M1.

### 2.3 Main process, daemon and agent surfaces

| # | Feature | Class | Note |
| --- | --- | --- | --- |
| S1 | Linear GraphQL client | **A** | Plugin child with `network: {hosts: ["api.linear.app"]}`. |
| S2 | 25-verb issue tracker | **A** | Plugin code. |
| S4 | Credential storage | **A** for new users | `ade.secrets` is keychain-namespaced per plugin. |
| S4b | Migrating an existing user's stored Linear token | **C** | `providerKeys` has no `linear` id (`manifest.ts:489`). The plugin cannot read what core already holds. Every existing user reconnects. |
| S5 | Desktop loopback OAuth | **B (M)** | The child is a plain Node process and can bind `127.0.0.1`. Nothing brokers a port, discloses the listener at install, or opens the browser as an auth flow. |
| S6 | Mobile worker-bounce OAuth | **C** | See 2.4. |
| S7 | Token refresh and cross-process lock | **A** | Plugin code plus `ade.memory`. |
| S8 | Lane card attachment posted to Linear | **A** | Plugin code plus `lane.list`. |
| S9 | Live status round-trip | **A** | Plugin code driven by `lane.changed` and `pr.changed` events (`sdk.ts:406`). |
| S11 | Webhook ingress at the relay | **A** | `webhookIngress` channels, `webhooks.url()`, `webhook.received`, `webhooks.ack` (`sdk.ts:2119` area, `manifest.ts:546`). This is the best-served area in the whole map. |
| S12 | Relay secret storage | **A** | Host-managed, `PLUGIN_WEBHOOK_SECRET_NAME`. |
| S13 | Two triggers from one event | **A** | Two `automations.emitTrigger` calls. |
| S14 | Nine Linear agent tools | **A** | `tools` in the manifest, proxied to `plugin.invoke`. |
| S15 | Three ADE action domains | **N/A** | They disappear. The plugin exposes tools and CLI words instead. |
| S16 | `kind:linear` search | **A** | `searchProviders`. |
| S17 | Lane and session issue links | **C** | See 2.5. |
| S18 | `ADE_LINEAR_ISSUE_IDS` env injection | **C** | No plugin primitive injects environment into an agent session. |
| S19 | PR magic words | **C** | See 2.5. |
| S20 | Smart-link previews for Linear URLs | **C** | No plugin registers a URL matcher. |
| S22 | Headless services in the daemon | **A** | The plugin host runs in the daemon. |
| S23 | `ade linear <verb>` | **A** | `cli: ["linear"]` in the manifest (`manifest.ts:650`). |
| S25 | `ade linear install` | **A** | Plugin code. |
| S26 | `ade lanes create-from-linear` | **B (S)** | The verb lives on the core `lanes` word. It moves to `ade linear create-lane`. |
| S27 | TUI Linear commands | **Reduced** | The TUI draws panels and three socket kinds (`sockets.ts:287`). The 353-line command set becomes CLI words. |
| S28 | Linear types in the sync layer | **C** | See 2.5. |

### 2.4 OAuth, in full

This is the sharpest single gap, so it gets its own section.

**What exists today.** Two flows, both in
`apps/desktop/src/main/services/cto/linearOAuthService.ts`.

1. Desktop loopback. ADE binds `127.0.0.1:19836`, opens the browser, and
   catches the redirect (`:367`, `:489`). PKCE throughout.
2. Mobile worker bounce. The desktop mints the PKCE session. The phone opens
   `ASWebAuthenticationSession` with callback scheme `ade`. Linear redirects to
   a Cloudflare Worker (`:21`), which redirects to `ade://linear-oauth`. The
   phone captures it in-session and posts the code back to the desktop, which
   exchanges it. The verifier never leaves the desktop
   (`LinearOAuthRunner.swift:18`).

**What the platform offers a plugin.** Nothing shaped like this.

- No OAuth broker exists. `providerKeys` brokers a key the user already gave
  ADE, for eleven providers, and Linear is not one of them.
- `openUrl` opens the system browser. On iOS that is Safari, not an in-app auth
  session. There is no way back into the plugin.
- `webhookIngress` accepts POSTs at the relay. An OAuth redirect is a GET with
  query parameters. It does not fit.
- The `ade://plugin/...` deeplink could carry a code back, but nothing routes an
  arbitrary third-party redirect into it, and the 2 KB `ctx` ceiling plus the
  presence gate make it an awkward auth channel rather than a designed one.

**Class.** Desktop OAuth is **B (M)**: the child can bind loopback itself,
because it is not sandboxed, but the platform neither brokers the port nor
discloses the listener at install. Mobile OAuth is **C**: it needs a
host-brokered auth session — a primitive that opens the system auth view on the
phone, catches a declared callback, and hands the plugin the result.

### 2.5 The deepest C: Linear is in the core data model

Six items above share one root cause. Linear is not only a feature of ADE. It is
a field on ADE's own types.

- `LaneLinearIssue` and `laneLinearIssue.ts` are shared core types.
- Lanes and sessions store issue links (`laneService.ts`, `lane.linkLinearIssues`).
- `linearIssueBranch.ts` derives branch names in core.
- `linearMagicWords.ts` and `prService` write `Fixes`/`Refs` into PR bodies.
- `deeplinks.ts:54` has a `linearIssue` field on the portable envelope, and
  `linear-issue` is one of eight deeplink kinds.
- `types/linearSync.ts` puts Linear event records in the sync layer.
- The CTO system prompt and `ctoStateService` read Linear state.

A plugin can publish a `row-badge` on a lane and store its own lane-to-issue map
in a collection. What it cannot do is make core's PR body writer, branch namer,
deeplink envelope and sync schema read that map.

**Two ways to close it.**

1. **Generalise the field.** Core keeps one anonymous "issue link" on a lane and
   a session. Any plugin fills it. The PR writer, branch namer and deeplink
   envelope read the generic shape. Cost: a migration of a synced table, plus a
   pass over every reader. This is the honest, correct fix.
2. **Leave it.** Accept that lane-to-issue linking stays a core concept that the
   Linear plugin drives through `lane.linkLinearIssues`. The plugin is then 95%
   of Linear, and core keeps a thin, provider-agnostic-in-name-only seam.

Option 2 is what `ade-cursor-cloud` effectively did, and it works. Option 1 is
what "100% a plugin" actually requires.

**Update: option 1 was taken, without the migration.** The rest of this section
stands as the description of the problem; this is what changed.

`apps/desktop/src/shared/issueRef.ts` is the anonymous issue link the option
called for: `IssueRef` carries `{pluginId, provider, issueId, key, title, url,
state, container, branchName, assignee, priority, labels, description, extra}`,
where `provider` is the tracker vocabulary (`linear`, `github`, `jira`, …) and
`state.category` is Linear's `stateType` vocabulary reused as the neutral one.
`IssueLink` (`shared/types/lanes.ts`) is the lane- or session-scoped link around
it, and `LaneSummary` grows `primaryIssue` and `issueLinks` beside the existing
`linearIssue` / `linearIssueLinks`, which stay populated.

A plugin fills it through `ade.lanes.linkIssue` / `ade.lanes.unlinkIssue`
(`shared/plugins/sdk.ts`, served in `pluginSdkServer.ts`). The host stamps the
calling plugin's id onto the ref from the child connection that asked —
`PluginIssueRefInput` has no `pluginId` field — and `unlinkIssue` removes only
links that plugin created. `lane.linkLinearIssues` and `lane.unlinkLinearIssues`
are now **refused** for plugins reaching them through `ade.actions.invoke`
(`apps/ade-cli/src/bootstrap.ts:673`), because a link made through those verbs
records no owner. They stay open to the user through the lane UI, the CLI and
the TUI.

**There is no migration.** This is the part that differs from the option as
written. The ref is stored inside the EXISTING `issue_json` column of
`lane_linear_issues`, `lane_linear_issue_links`, `session_linear_issues` and
`session_github_issues`, under the reserved key `__issueRef`, beside a full
legacy Linear projection of itself (`issueRefToStoredLinearIssue`). No column,
no table, no backfill: a build that finds no `__issueRef` derives one from the
legacy fields. A peer on an older build parses the legacy projection and drops
the unknown key, so a Jira issue renders there with the right key, title, URL
and state name under a Linear-labelled badge — a mislabel, not a break. The one
lossy window is an older build re-linking an issue, which rewrites `issue_json`
without the key; the next link from a new build restores it. The pattern and
when to prefer it are now
[Rule 4 of the CRDT model](../features/sync-and-multi-device/crdt-model.md).

Of the four readers the option named:

- **PR writer — reads the generic shape; still renders only Linear.**
  `prService.collectLanePrIssueRefs` collects the lane's primary issue and every
  `includeInPr` link as `IssueRef`s (generic first, legacy rows as fallback and
  as stragglers so a PR can never emit fewer references than before), and
  `lanePrimaryIssueClosesOnMerge` reads the generic link. The magic word comes
  from `issueRefPrReference` in `shared/issueRefFormat.ts`, which emits a
  closing word only for `github` (`Closes`) and `linear` (`Fixes`) — the two
  trackers that actually perform the close — and **`Refs` for every other
  provider regardless of `closeOnMerge`**, because `Fixes ABC-12` in a GitHub PR
  body is inert text. But `collectLinearPrIssueReferences` then filters to
  `provider === "linear"` (`prService.ts:912`): a Jira ref is carried that far
  and dropped rather than rendered under a "Linked Linear issues" heading it
  does not belong to. So the reader is generic and the renderer is not; the
  renderer for a third-party tracker arrives with the plugin that produces it.
- **Deeplink envelope — done.** `DeeplinkEnvelope.issue` is `{provider, key}`,
  written as `?issueProvider=` + `?issueKey=`, which an older peer ignores. The
  existing `?linear=` field is kept and still written for Linear issues,
  because that is the param an older peer reads.
- **Branch namer — generalized, not yet wired.** `issueRefBranchName` /
  `issueRefLaneName` exist in `shared/issueRefFormat.ts` and
  `issueRefFormat.test.ts` proves byte-identical output to
  `linearIssueBranchName` over real identifiers, but every caller — lane
  creation in `laneService.ts:2055`, `CreateLaneDialog`, `laneLinearIssue.ts` —
  still calls the Linear one. A plugin cannot create a lane from an issue at all
  today: `ade.lanes` is `list`, `get`, `linkIssue`, `unlinkIssue`.
- **Sync schema — deliberately not touched.** See above.

There is also a new provider-neutral deeplink kind:
`ade://issue/<provider>/<issue-key>[?branch=&plugin=]`, with
`ade link issue <provider> <key>` and `ade open --issue-provider/--issue-key`
minting and opening it. `linear-issue` is an alias that stays forever — Linear
links keep being minted in that spelling so an older ADE can still open them —
and `linearIssueTargetToIssueTarget` bridges the two so resolvers handle one
kind.

**What is still Linear-specific.** The generalization is a seam, not a removal:

- The built-in Linear writers, the OAuth flow, the pane, the pickers, the
  browser and `linearLaneCardService` are all unchanged and still compiled in.
- `lane.linkLinearIssues` / `unlinkLinearIssues` still exist as the user's verbs,
  with the Linear-shaped payload.
- Linear-typed consumers on the **desktop renderer** still read the legacy
  fields directly, not the ref: the merge fan-out in `main.ts:3838`
  (`lane.linearIssue`, `link.issue.id` / `teamKey` / `stateId`),
  `linearLaneCardService`, and `LinearIssueBadge.tsx`, which is typed on
  `LaneLinearIssue` and reads `identifier`, `teamKey`, `projectName`.
  `CreatePrModal` still reads `selectedNormalLane.linearIssue`. **iOS's lane
  badge did migrate** — `RemoteModels.swift` gained a Swift `IssueRef` mirror
  and a `__issueRef` passthrough held as raw JSON so an unknown-shaped ref
  cannot fail the row and a phone round-tripping `linearIssue` back to a
  machine does not rewrite fields it does not know; `LaneComponents.swift`
  reads `issue.issueRef`, shows a non-Linear tracker's own key/title/state, and
  gates on the Linear plugin only when the ref IS Linear.
- `resolveIssueDeeplinkRouting` (`renderer/components/app/pluginDeeplinkRoute.ts`)
  can route an `issue` link to whichever plugin owns the provider, but nothing
  supplies its `owners` list yet and `App.tsx` still dispatches only the
  `plugin` target, so today a non-Linear `issue` link reaches a plugin by
  `deeplinkToNavigationTarget`'s fallback — the plugin whose id equals the
  provider, or the one the link names. **iOS does not parse the `issue` kind at
  all**: `DeepLinkRouter.swift` knows `linear-issue` and not `issue`, so an
  `ade://issue/jira/PROJ-9` link opens nothing on a phone.
- `types/linearSync.ts` is untouched, so S28's desktop half is not closed; the
  iOS half of S28 (`RemoteModels.swift`) now carries the neutral ref beside the
  Linear records rather than instead of them.

So of the six rows C2 was supposed to unblock: **S17 is closed** — a lane and a
session take a link from any tracker, attributed to whoever made it. **S19 is
half closed** — the collection and the magic word are provider-neutral, the
rendering is not. **D33, D34, M41 and S28 are not closed** — `CreatePrModal`
still reads `selectedNormalLane.linearIssue` and names its checkbox for Linear,
the desktop PR row/timeline/merge-rail components and the iOS PR screens
(`apps/ios/ADE/Views/PRs/`, unchanged) still read Linear fields, and
`types/linearSync.ts` is untouched. The C2 line in the table at §3.3 is amended
in place rather than removed, because what is left of it is still real work.

---

## 3. Verdict

### 3.1 The straight answer

**No, not today. Yes with seven named pieces of platform work.**

You cannot say "Linear as it was could be built as a plugin from all surfaces
today". Two of the seven gaps are the ones a user meets in the first minute:
signing in from the phone, and a lane that knows which issue it is for. (The
second of those has since been built — see the C2 update in §2.5. The verdict
below is preserved as written, with the amendments marked.)

What you CAN say today, and it is a strong claim:

> Everything Linear does after you are connected — browsing, filtering, reading
> an issue, launching a lane and an agent on it, the webhooks, the automation
> triggers, the agent tools, the CLI, the search — is buildable from plugin
> primitives right now, on desktop, web, iOS and the terminal. What is not
> buildable is the sign-in, the markdown, the multi-select, and the fact that
> ADE's own lane type has a Linear field on it.

The last clause has since moved. A lane and a session now take a link from any
tracker through `ade.lanes.linkIssue`, so "a lane that knows which issue it is
for" is buildable; the Linear-typed readers around it (the PR body renderer, the
PR row components, the iOS PR screens, the sync models) are what is left. See
the C2 update in §2.5.

### 3.2 The numbers

113 classified features. Raw counts first, then weighted.

| | Raw | Weighted by user-visible importance |
| --- | --- | --- |
| **A** — buildable today | 68 (60%) | ~55% |
| **B** — small addition | 29 (26%) | ~25% |
| **C** — real platform work | 17 (15%) | ~20% |

Weighting moves C up and A down for one reason. The C items are few but they sit
at the front door. Connecting an account is one row in a table and the whole
product to a new user.

Per surface, raw:

| Surface | A | B | C |
| --- | --- | --- | --- |
| Desktop and web (47) | 26 | 13 | 8 |
| iOS (43) | 28 | 13 | 2 |
| Main, daemon, CLI (24) | 14 | 3 | 7 |

The iOS column is the surprise. The mobile panel is the LEAST blocked surface by
row count. Only two rows are C: OAuth and the PR references. The mobile problem
is not "can it be drawn" — it is that thirteen rows land at reduced polish, and
the reductions concentrate in the things a phone user touches most: search,
scrolling, going back, and reading formatted text.

### 3.3 The exact C list

Seven items. Nothing else in the map is C.

| C | What | Rows it unblocks | Why it is C |
| --- | --- | --- | --- |
| **C1** | A host-brokered mobile auth session. Opens the system auth view on the phone, catches a declared callback, hands the plugin the result. | M30, D38 (mobile half), S6 | No plugin OAuth broker exists. `openUrl` leaves the app with no way back. `webhookIngress` is POST-only. |
| **C2** | ~~Generalise the lane and session issue link so any plugin fills it, and make the PR writer, branch namer, deeplink envelope and sync schema read the generic shape.~~ **Partly done** — `IssueRef` + `ade.lanes.linkIssue`/`unlinkIssue` ship, stored inside the existing `issue_json` column with no migration; PR collection, the deeplink envelope and a provider-neutral `issue` deeplink kind read it. **Remaining:** the PR body renderer still filters to `provider === "linear"`, the branch namer is generalized but unwired, and the PR/iOS Linear-typed consumers and `types/linearSync.ts` are untouched. | Closed: S17. Half: S19. Open: S28, D33, D34, M41 | Was "a migration of a replicated cr-sqlite table plus a pass over every reader". The migration was avoided by versioning inside the JSON column; the pass over every reader is the part still outstanding. See §2.5. |
| **C3** | A selection primitive in the panel vocabulary: a selected set, a range anchor, and a bulk action bar. | D9, D5, D14 | The vocabulary has no concept of selection at all. |
| **C4** | Hand ADE's existing Linear credential to the plugin once, or add `linear` to `providerKeys`. | S4b | Without it, every existing user reconnects on the day you release it. |
| **C5** | Let a plugin inject environment variables and a context file into an agent session it launched. | S18 | `ADE_LINEAR_ISSUE_IDS` and `ADE_LINEAR_CONTEXT_FILE` are written by core session launch. No primitive is close. |
| **C6** | Let a plugin register a URL matcher for smart-link chips and previews. | D36, S20 | `shared/smartLinks.ts` parses URLs in core. |
| **C7** | A contribution socket that reaches a Graph canvas node. | D32 | The Graph is a compiled canvas with no entity socket surface. |

C1, C2 and C4 are the release blockers. C3 costs the batch-launch flow. C5, C6
and C7 are each one visible feature.

C2 has since been partly built — the generic link and the plugin verbs exist,
without the migration this table assumed. What is left of it is a pass over the
remaining Linear-typed readers, not a schema change. See §2.5.

### 3.4 The B list, ordered by leverage

Leverage means rows unblocked per unit of work.

| # | B item | Size | Unblocks |
| --- | --- | --- | --- |
| 1 | A `markdown` node or `text` variant, with a safe renderer on all four clients. | L | D10, D12, M13, M19 — and every future plugin that shows prose. |
| 2 | A panel back stack on iOS, with panel state preserved across a return. | M | M1, M12, and every detail screen any plugin ever writes. |
| 3 | A paging affordance on `list`, plus a higher `maxListItems`. | M | D7, M9. |
| 4 | A state control whose options bind to a collection, for sets over eight. | S | D3b, M7. |
| 5 | Raise `maxStateKeys`, or add a disclosure-group component. | S | D6, M8. |
| 6 | A panel-level search declaration clients draw in native chrome. | M | M4. |
| 7 | Plugin-owned deeplink aliases, so `ade://linear-issue/<ID>` can belong to a plugin. **Partly built:** `ade://issue/<provider>/<key>[?plugin=]` exists and routes to a plugin panel; `linear-issue` itself stays a permanent core alias and Linear's "Open in coding tool" registration still writes `--linear-issue`. What is missing is the provider-owner registry — `resolveIssueDeeplinkRouting` takes an `owners` list nothing populates yet. | M | M37, and Linear's "Open in coding tool" registration. |
| 8 | Draw `settings-section` on iOS. | M | M43, plus every plugin's mobile settings. |
| 9 | Broker a loopback port for desktop OAuth, and disclose the listener at install. | M | D38 (desktop half), S5. |
| 10 | A per-node custom glyph, beyond icon names. | S | D28, D29, M36. |
| 11 | An `app`-surface toolbar slot for a pane's own button. | S | D18. |
| 12 | A sticky footer region in a panel. | S | M21. |
| 13 | A trigger-scoped filter schema in the manifest. | M | D43. |
| 14 | A richer dialog than `confirm` plus one-field `prompt`. | S | D21. |
| 15 | An in-app progress affordance separate from OS notifications. | S | D16. |
| 16 | A two-pane layout hint, with independently scrolling halves. | S | D1. |
| 17 | A handoff to ADE's own model picker from a plugin form. | S | M24. |

Items 1 through 5 carry most of the value. They cost roughly one L and three S
plus one M, and they move the mobile panel from "reduced" to "native but
simpler" on the four interactions that matter.

### 3.5 Three honest framings

**(i) Full fidelity. Do the C work.**

Linear becomes the proof that the plugin platform can carry anything. Cost: the
seven C items plus the top five B items. C2 was written up as a synced-table
migration and read as the schedule risk; it turned out not to need one — the
generic link versions inside the existing `issue_json` column — so what is left
of C2 is reader work, not a migration. What you get is real: after it, no ADE
feature has a
structural reason to stay compiled in, and the claim "an official plugin is
indistinguishable from a built-in" is true rather than aspirational.

**(ii) Desktop full, mobile native but simpler. Do A plus B.**

Skip the rest of C2 by having the plugin link through `ade.lanes.linkIssue` and
leaving the remaining Linear-typed readers where they are. (This framing
originally said "let the plugin drive `lane.linkLinearIssues`" — that verb is
now refused for plugins, because a link made through it records no owner.) Skip
C3 by dropping batch launch to one-at-a-time. Do C1 and
C4, because sign-in is not optional. Desktop reaches parity a user would not
notice. Mobile reaches a panel that looks like ADE, works offline the same way
the current one does, and loses: markdown bodies, the nav-bar search, the swipe
back, scroll paging, and the pinned launch bar. This is the honest middle, and
it is achievable without a migration.

**(iii) Keep the gating shell.**

`ade-linear` stays four files and gates three action domains. Linear stays
compiled. Nothing breaks and nothing is learned. The cost is that the platform's
success bar stays untested: the hardest integration in ADE is the one the
platform never had to carry, and every future "should this be a plugin?" gets
answered by precedent rather than by capability.

### 3.6 What I would tell the owner in one sentence

The plugin platform already carries the whole working life of the Linear
integration on every surface; it does not yet carry the front door — signing in
from a phone — or the fact that a lane has a Linear field, and those two, plus a
markdown node, are what stand between the shell you have and the plugin you
want.

Amended: the lane's field is now provider-neutral and a plugin fills it
(§2.5), so the remaining sentence is the front door, the markdown node, and the
handful of PR and sync readers still typed on Linear.
