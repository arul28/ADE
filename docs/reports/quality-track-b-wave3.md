# Quality Track B (maintainability) — wave-3 range c35bc0b88^..54df53935

Status at handoff: fixes dispatched to three agents (plugin, desktop, iOS). Items that landed appear as commits after 3e6e3be99 on plugin-platform. Anything not in a commit is STILL OPEN. Gated (product decision): H2 state order (STATE_RANKS live order vs STATE_GROUP_ORDER). Deferred by design: L2 (TRIGGER_ID_REMAP read by the core-removal change), L3 (third module-level bus), the iOS ownerPluginId cross-language check.

# Track B — Maintainability review

Repo `/Users/admin/Projects/ADE`, branch `plugin-platform`, HEAD `54df53935`.
Scope: `git diff $(git rev-parse c35bc0b88^)` — the wave-3 Linear plugin extraction (~110 files).
Standards: `.claude/skills/quality/references/thermo-nuclear-review.md`, the 7 structural standards.

**Counts: 3 Blocker, 6 High, 12 Medium, 9 Low. 30 findings.**

Settled design not re-litigated: the two-halves split, `panels/main.json`, the `resolveClient`/`begin`
double guard, version-inside-JSON `__issueRef`.

---

## Headline

The seam between the plugin's two halves is broken. `index.js` builds a **view**; `panels.js` reads a
**model**. Both test suites feed the model shape straight to the builders, so no test drives the real
path. Three defects hide behind that one gap.

---

## Blockers

### B1. `panels.js` re-shapes a view that `index.js` already shaped, and the shapes disagree

`plugins/ade-linear/index.js:180` calls `panels.build(panelId, view, context)` with the flat view from
`viewFor()`. `plugins/ade-linear/panels.js:151` `buildIssuesPanel(model)` ignores that view and
re-derives from `model.connection`, `model.filters`, `model.loading`.

Reproduced by running the real code with the exact view `viewFor("issues")` returns for a connected
workspace:

```
{"v":1,"title":"Linear","body":[{"component":"emptyState","title":"Connect Linear",
 "description":"Sign in to browse and launch Linear issues from ADE…"}]}
```

`connectionOf(view)` returns `{}` → `isConnected` false → state is always `disconnected`.
`buildIssuePanel` (`panels.js:199`) fails the same way. `buildSettingsPanel` and `buildLaunchPanel`
survive by coincidence; `launch` is the only one whose test uses the view shape
(`test/panels.test.js:779`).

- Standard 4 (design over acceptance), 7 (two layers own one mapping).
- Judo: delete the second mapping. `panels.js` becomes the dispatcher it documents itself as at line
  316 — each case passes its input straight to the body builder, as `PANEL_LAUNCH` already does.
  `viewFor()` stays the one mapper. `filtersOf`, `connectionOf`, `isConnected`, `errorOf`,
  `filtersActive` all delete.
- Behavior-preserving: **no** — it repairs the panel.
- Test gap: nothing drives `index.__internals.publish` against a fake sdk and asserts the published
  schema. Both suites hand-write the builder input. That one test fails all three blockers loudly.

### B2. The adopt-handoff button can never draw

`index.js:347` computes `handoffStatus: handoffLabel(status)` → `"offered"` | `"taken"` |
`"declined"` | null. `panels.js:241` discards it and passes `connection.handoffStatus ?? null`, which
is the SDK vocabulary (`"accepted"` | `"declined"` | null) written by `data.js:719`.
`panels/settings.js:173` branches on `=== "offered"`, so the branch is unreachable.

- Standard 6 (two vocabularies, one field name).
- Judo: part of B1. Once `panels.js` stops re-deriving, `view.handoffStatus` reaches the builder.
  Rename the stored field to `handoffAnswer` in `data.js` so the two words cannot collide again.
- Behavior-preserving: **no** — it restores the button.

### B3. Label chips never render on the issue detail panel

`issueFormat.js:181` stores `labels: [{id, name, color}]`. `panels/issue.js:211` filters
`typeof name === "string"`, so every object fails and `labelChips` returns `[]`. Both fixtures use
strings: `test/panels.test.js:109`, `linearPluginPanels.test.tsx:172`.

`panels/issue.js:177-185` also reads `issue.cycleName`, `issue.startedAt`, `issue.canceledAt`,
`issue.blockerCount` — `normalizeIssue` produces none of them, so those rows never draw either.

- Standard 6.
- Judo: pass `labels: issue.labels.map((l) => l.name)` in `viewFor`. Prefer that over teaching
  `labelChips` both shapes — the panel half must not learn the storage shape. Delete the four
  unproduced property rows, or add them to `normalizeIssue`.
- Behavior-preserving: **no**.

---

## High

### H1. Two panel handlers are dead; one live path reaches a dead one

`index.js:774` — `Object.assign(exports.actions, panelHandlers, ownActions)`. `ownActions` wins.
Computed overlap: `openIssue`, `openInLinear`. So `panelActions.js:260` and `panelActions.js:568` are
unreachable.

`panelActions.js:270` `openSubIssue` calls `handlers.openIssue` — the dead one — so a sub-issue press
skips the identifier-to-id resolution at `index.js:1011` that a row press gets.

`index.js:1160-1166` claims `ownActions` re-claims `setIssueState`, `commentOnIssue`, `assignIssue`.
`ownActions` defines none of the three (it has `stepSetIssueState`, `stepCommentOnIssue`,
`stepAssignIssue`). The comment is wrong.

- Standard 1, 3.
- Judo: delete both handlers from `panelActions.js`; make `openSubIssue` return
  `{navigate: {panelId: PANEL_ISSUE, context: {issueId}}}` and let the host dispatch. Fix the comment.
- Behavior-preserving: yes for `openInLinear`; `openSubIssue` gains the resolution — a repair.

### H2. Three constants exist twice across the two halves; one pair disagrees

| Fact | Data half | Panel half |
|---|---|---|
| State tone | `issueFormat.js:55` `STATE_TONES` | `panels/common.js:131` `STATE_TONES` |
| Priority label | `issueFormat.js:69` `priorityLabel` | `panels/common.js:209` `priorityLabel` |
| State order | `issueFormat.js:27` `STATE_RANKS` | `panels/common.js:171` `STATE_GROUP_ORDER` |

First two pairs identical. The third **disagrees**: `STATE_RANKS` orders triage, backlog, unstarted,
started; `STATE_GROUP_ORDER` orders started, unstarted, backlog, triage. `data.js:507` sorts by
`row.stateRank`, so `STATE_RANKS` is live and `stateGroupRank` (`common.js:181`) is dead. The live
order therefore contradicts the parity claim at `common.js:168`.

**Resolved 2026-09-01 (owner's call):** `STATE_RANKS` now carries the built-in's order — started,
unstarted, backlog, triage, completed, canceled — and the `common.js` comment names that sequence.
The dead `stateGroupRank` table is gone.

- Standard 5 (one word, one meaning), 4.
- Judo: move all three into `panels/contract.js`, which both halves already import. Delete
  `stateGroupRank` and `STATE_GROUP_ORDER`.
- Behavior-preserving: yes for tones and label. Fixing the order is a product decision.

### H3. The guarded helper is dead; the unguarded copy is live

`flows.js:437` `sessionIssues(laneId)` guards `typeof sdk.lanes?.listSessionIssues !== "function"` and
has no caller. `flows.js:391` inlines the same read inside `closeIssueOnMerge` without that guard.

- Standard 1.
- Judo: call `sessionIssues(laneId)` at line 391; delete the inline try/catch.
- Behavior-preserving: yes.

### H4. Three comments describe a manifest two commits old

`plugin.json` now declares `webhookIngress[0].verify` (hmac-sha256, header `linear-signature`) **and**
a `launch` panel. These say otherwise:

- `index.js:1076-1084` — "The manifest does NOT declare `verify` today, so this secret is not yet checked."
- `panels/contract.js:151-160` — "The launch panel is NOT declared in `plugin.json` today."
- `panels.js:277-284` — "Inert until the manifest declares a `launch` panel… nothing navigates to it."

`index.js:1076` misleads a reader into thinking deliveries are unverified. They verify and fail closed,
which `panels/settings.js:465` states correctly.

- Standard 5.
- Judo: delete the three paragraphs; state the current fact once.
- Behavior-preserving: yes.

### H5. `TriggerCard` hard-codes two vendor names in a shared picker

`apps/desktop/src/renderer/components/automations/builder/TriggerCard.tsx:324-329`:

```ts
if (candidate.value === "cursor") return cursorCloudSurfaceVisible;
if (candidate.value === "linear") return linearSurfaceVisible;
```

The same commit added the generic field twice — `templateData.ts:28` `builtin?`,
`settingsManifest.ts:113` `builtinSurface?` — and did not use it here. A Jira author must edit this
file. No comment marks it as scaffolding; the comment at `:310-323` argues *for* the shape.

- Standard 3, 7.
- Judo: add `builtin?: PluginBuiltinSurfaceId` to `TriggerSourceDef` (`triggerCatalog.ts:42`), set it
  on the `linear` (`:82`) and `cursor` (`:96`) entries, reduce the filter to
  `(c) => c.value === source || gate(c.builtin)`. Both hook calls at `:303-304` delete.
- Behavior-preserving: yes.

### H6. The bundled marketplace listing no longer mirrors `plugin.json`

`apps/desktop/src/renderer/components/plugins/marketplaceLocalIndex.ts:118-173`. The header (`:19-22`)
and the block comment (`:89-94`) claim a field-for-field mirror. The Linear entry omits `authSessions`,
`urlMatchers`, `collections`, `settings`, 5 automation triggers, 4 steps, `searchProviders`,
`keybindings`, 9 tools, `cli`, `skills`. The doc at `:126-128` describes a `urlMatchers` field absent
from the object below it.

`describeManifestAdds` (`shared/plugins/installDisclosure.ts:165-275`) reads every omitted field, and
`mergeMarketplaceCatalogue` uses the bundled listing whenever the directory has no entry — offline,
pre-publish, first paint. Directory entries carry `manifest: null`, so this is the only manifest that
can produce a derived Adds list. The Linear install card silently drops the OAuth/loopback line, the
`linear.app` chip line, the sync line, the terminal-commands line and the agent-skill line. No parity
test exists.

- Standard 4, 5.
- Judo: generate the bundled index from the `plugins/` tree at build time. Interim: a test that
  deep-equals each bundled manifest against `plugins/<id>/plugin.json`.
- Behavior-preserving: the test is. Completing the mirror changes the disclosure, which is the point.

---

## Medium

### M1. `CORE_SMART_LINK_BUILTIN_OWNERS` — the question you asked

**The pinning test is enough today.** `builtinSurfaces.test.ts:215` and `:221` check both directions,
so a drift fails the build.

**The import graph can still be fixed, and the fix deletes both the mirror and its test.** The cycle
exists only because `PLUGIN_BUILTIN_SURFACE_IDS` (`manifest.ts:152`) and
`PLUGIN_BUILTIN_SURFACE_PRESENCE` (`manifest.ts:198`) live inside the 2,466-line `manifest.ts`, which
imports `urlMatchers.ts` at line 47.

- Judo: extract those two constants plus the `builtinId → ownerPluginId` map into a leaf module
  `shared/plugins/builtinSurfaceRegistry.ts` that imports nothing. Then `manifest.ts`,
  `urlMatchers.ts` and `builtinSurfaces.ts` all import from it. `CORE_SMART_LINK_BUILTIN_OWNERS`
  (`urlMatchers.ts:154`) and its two test cases delete; ~60 lines leave `manifest.ts`.
- Behavior-preserving: yes.

### M2. The dotted-path capability layer serves exactly one host

`panelActions.js:118` `capability(host, path)` walks a string path. `HOST_CAPABILITIES` (`:78`) lists
20 paths. There is one host — `index.js:547` `buildPanelHost` — which writes out all 20.

- Standard 5 (no string-based dispatch when a map literal works).
- Judo: replace each `invoke(host, "data.loadIssue", …)` with a direct optional call.
  `HOST_CAPABILITIES` and its pinning test delete; every call becomes greppable.
- Behavior-preserving: yes if each call keeps `?.` and its fallback message. Larger edit than the
  rest — take it only if you want the concept gone.

### M3. Dead and duplicated code in `data.js`

- `data.js:407` `writeIssueRow` — no caller; `refreshIssues` (`:446`) and `refreshIssue` (`:578`)
  both inline the same three-key-space write.
- `data.js:452-456` re-implements `replacePrefix` (`:288`) with a different limit instead of calling it.
- `data.js:831` — two conditional spreads for one fallback.
- `data.js:846` exports `currentModel` and `model` as the same function.

- Standard 1, 5.
- Judo: delete `writeIssueRow`; give `replacePrefix` a `limit` option and call it; replace the spread
  with `model.filters ?? { ...defaultFilters(), hasProjects: false, hasPeople: false }`; drop the alias.
- Behavior-preserving: yes.

### M4. Dead exports in `panels/contract.js`

`CORE_OWNED_ACTIONS` (`:280`), `PROMPT_API_KEY` (`:335`), `COMMENT_ROW_ACTIONS` (`:324`) — no readers
outside their own doc comments. `CORE_OWNED_ACTIONS` is documentation written as a frozen array and is
already wrong: it lists `openIssues`, `openSessionIssue`, `commentProgress`, which no panel dispatches.

- Standard 1. Judo: delete all three; move the ownership note to the module header. Preserving: yes.

### M5. Dead verbs and a no-op catch in `linearApi.js`

`fetchIssuesByIds` (`:509`), `listProjects` (`:558`), `listUsers` (`:567`), `rateLimitStatus` (`:699`)
— no callers; `data.js:524` derives the facets from the issues and says why. `:401-406` —
`try { await refreshOnce(credential); continue; } catch (e) { throw e; }` only rethrows.

- Standard 1. Judo: delete the four verbs and the try/catch wrapper. Preserving: yes.

### M6. `pr.changed` is emitted twice per poll

`apps/ade-cli/src/bootstrap.ts:2108` emits the id-only change inside `emitPrEvent`. The new block at
`:2184` emits a second with the same ids plus transitions. The "host merges them" claim is a
cross-module invariant with no test at this seam.

- Standard 1. Judo: compute the transitions before `emitPrEvent` runs and thread them through, so one
  window produces one emission. Preserving: yes if host coalescing is correct — which is the argument
  for a single emission.

### M7. `buildMissingSurfaceDenial` returns a denial for a surface that is present

`apps/desktop/src/main/services/plugins/gatedActionDomains.ts:296` — for a superseded surface it
returns "The ade-linear plugin provides Linear on this computer." Nothing is missing; the name states
the opposite of one of its two outcomes. The doc at `:283-285` also has a stray line break.

- Standard 6, 1. Judo: rename to `buildSurfaceUnavailableDenial`, or split into
  `buildMissingSurfaceDenial` + `buildSupersededSurfaceDenial` behind one dispatcher. Preserving: yes.

### M8. `connect.js` writes a secret it never clears

`connect.js:401` writes `SECRET_CLIENT_ID`. `connect.js:446` `disconnect()` clears the other four and
leaves it, under a comment saying "Every secret". After a disconnect `resolveClient()` still finds the
stored id and reports `source: "custom"` when it does not match ADE's. `connect.js:196` `clientId()`
has no caller.

- Standard 6. Judo: decide whether the id survives a disconnect, then make code and comment agree.
  Delete `clientId()`. Preserving: comment fix yes; secret change no.

### M9. Two readers of the git origin remote

`index.js:845` `readGithubRepo` and `flows.js:564` `githubRepo` both invoke `git.getOriginRemote` and
parse. Field lists differ — `flows` also reads `result?.originRemote`.

- Standard 1. Judo: export `githubRepo` from `createFlows`; call it from `index.js`. Preserving: yes.

### M10. A pinning test named in a comment does not exist

`panels/common.js:49` says `LIMITS` is "pinned by `panels.limits.test.js` against the real
`VOCAB_LIMITS`". No such file exists. `linearPluginPanels.test.tsx` pins 7 of the 15 values
(`maxNodes`, `maxSchemaBytes`, `maxStateKeys`, `maxStateOptions`, `maxBulkActions`, `maxSelectedRows`,
`maxFormFields`) for the fixtures it draws. The other 8 are unpinned.

- Standard 5. Judo: add the named test, or correct the comment and list what it does not cover.
  Preserving: yes.

### M11. iOS

The gate itself is sound: one predicate, `PluginPresenceGate.drawsBuiltin(_:)`
(`apps/ios/ADE/Views/Plugins/PluginPresenceGate.swift:207-214`), and `awaitDrawsBuiltin` (`:239-246`)
delegates rather than copying the switch. A grep of all `apps/ios` for `owns(`, `isInstalled(`,
`!owns` and `"ade-linear"` found no call site that reimplements the test. 17 call sites, all asking
the gate. It is generic over surface; the closed list is labelled as extraction scaffolding at
`:15-25` and `:50-66`. No `!`, `try!`, `as!` or IUO anywhere in the touched Swift, tests included.

| # | Site | Standard | Judo | Preserving |
|---|---|---|---|---|
| 1 | `ContentView.swift:144-165` + `:198-231` | 1, 3 | The superseded-sheet host is copy-pasted, comment included (`:153-160` vs `:219-226` word-for-word). One `View` extension for filter + clear + inject; ~50 lines go, and the rationale lives once | yes |
| 2 | `WorkRootScreen.swift:675-677` | 4, 5 | Comment states the **inverted** rule ("Gated on the attached machine having the Linear plugin") — the button now hides when the plugin is present. Delete it; `LinearPaneToolbarButton.swift:3-28` says it correctly | yes |
| 3 | `LaneComponents.swift:93` + `WorkRootScreen+Actions.swift:831` | 3, 7 | `!ref.isLinear \|\| drawsBuiltin(.linear)` derived in two files → `gate.drawsBuiltinAffordance(for: ref)`; also makes it unit-testable | yes |
| 4 | `PluginPresenceGateTests.swift:209-314` + `:384-475` | 1 | ~90 lines assert the same six states twice, once per superseded surface, when `:584` already pins the polarity. Drive one helper off `PluginBuiltinSurface.allCases where presence == .supersedes` — stronger, since a new surface is covered the day it is added | yes |
| 5 | `ContentView.swift:151` + `:217` | 1, 5 | Two `.environmentObject(pluginGate)` injections nothing under them reads (`LinearPaneSheet.swift:7`, `CursorCloudPaneSheet.swift:6`). Delete | yes |
| 6 | `PluginPresenceGate.swift:26-75` | 3, 1 | Three parallel switches over seven cases (`rawValue`, `ownerPluginId`, `presence`). Collapse the latter two into one `spec` switch so both facts sit adjacent | yes |
| 7 | six sites | 1 | The polarity paragraph appears verbatim at `ContentView:357-360`, `LinearPaneToolbarButton:18-21`, `CursorCloudPaneSheet:45-47`, `CtoSettingsScreen:273-277`, `LaneComponents:78-81`, `WorkRootScreen:1017-1019`. #2 is that drift already happening at a seventh. One sentence + a pointer each | yes |
| 8 | `CtoSettingsScreen.swift:83-86` | 1, 3 | The onChange guard is a second copy of half of `loadLinearStatus`'s own guard (`:392-397`); delete it, which additionally clears stale credential-adjacent `@State` on the false transition | yes |

Human judgment, not fixed here: `PluginPresenceGateTests.swift:560` asserts `ownerPluginId` against a
hand-written literal array, and unlike `rawValue` there is **no** desktop mirror for the surface→owner
map. That half of the test compares the switch to a copy of the switch. The checkable source of truth
is the `plugins/*/` directory names (all seven verified to match). The real fix is a cross-language
check, out of scope for this branch; at minimum soften the comment so a future reader does not trust a
guarantee that is not there.

Low-priority perf, behavior-preserving: `SyncService.swift:9794` rebuilds
`Set(gate.installedPlugins.map(\.pluginId))` on every contribution-index build. Cache
`installedPluginIds: Set<String>` in `apply()` (`PluginPresenceGate.swift:315-323`).

### M12. Renderer

The predicate is also computed once — `isBuiltinSurfaceVisible(builtinId, input)`
(`components/plugins/builtinTabs.ts:104`) over one memoized `useBuiltinGateInput()`. Nothing
reimplements the polarity rule. What is uneven is the **delivery**: three shapes across 16 sites — a
hook read in the component (18 sites), a threaded arg (`laneContextMenuItems.tsx:68`), and a
module-global resolver installed during render (`settingsManifest.ts:851-885`).

`useOfferedTemplates.ts` **is** applied everywhere it should be: `FLAGSHIP_TEMPLATES` and
`TEMPLATE_GROUPS` have exactly two consumers (`AutomationsEmptyState.tsx:23`, `TemplateGallery.tsx:17`)
and both filter. Filter-before-slice at `AutomationsEmptyState.tsx:23` is correct and load-bearing.

| # | Site | Standard | Judo | Preserving |
|---|---|---|---|---|
| 1 | `SettingsPage.tsx:337-349` + `CommandPalette.tsx:376-388` | 1, 4 | 13 lines identical character-for-character, sitting beside a second identical pair for `setWebMachineBindingResolver` (`SettingsPage.tsx:321-331`, `CommandPalette.tsx:359-370`) — four copies of one lifecycle. Extract one `useSettingsManifestResolvers()` holding both installs | yes |
| 2 | `laneContextMenuItems.tsx:60-68` | 3, 7 | `linearSurfaceVisible: boolean` is a vendor-named required field on a shared args type; a Jira row costs a second field plus edits in both callers. → `surfaceVisible: (id) => boolean`, still required, so the forget-to-ask protection survives | yes |
| 3 | `settingsManifest.ts` (983 lines, +53) | 2 | 17 lines from the threshold, and `:823-885` is now a renderer-state bridge holding two mutable globals installed from two other files. Extract `settings/settingsAvailability.ts`; fixes #1 in the same move | yes |
| 4 | `automationPlannerService.ts:368-371` | 7 | The AI planner hands the model `linear.*` unconditionally, so "make a rule when an issue is created" still produces a rule bound to a source `TriggerCard` refuses to show. `builtinSurfaceDrawn` is pure and reachable from main. (Also lists 4 of 5 triggers — `linear.issue_labeled` missing, pre-existing) | **no** — missing behavior |
| 5 | `SettingsPage.tsx:340`/`:347`, `CommandPalette.tsx:379`/`:386` | 6 | `useRef<Fn>()` with no initial value forces `surfaceResolverRef.current!`. Lazy-init the ref; the `if` block and the `!` both delete. Subsumed by #1 | yes |
| 6 | `SettingsPage.tsx:354`, `:471` | 5 | `useMemo` deps shadow an invisible module-global edge that `setBuiltinSurfaceResolver` set earlier in the same render. Pass the gate: `availableSettingsTabs(gate)` | yes |
| 7 | `IngressStatusStrip.tsx:101-122` | 3 | 3-deep nested ternary; pre-existing, but this diff put a fourth condition in front of it at `:81-84`. A `linearRow(linear)` helper returning one of four elements | yes |

One consolidation covers M12.1–.3 and the delivery unevenness: a `useBuiltinSurfaceGate()` hook in
`useBuiltinTabs.ts` returning `(id) => boolean`. It collapses two of the three delivery shapes,
reduces `useOfferedTemplates.ts` to a one-line filter, and takes `LaneMenuArgs` generic.

---

## Low

### L1. Files past the 1,000-line threshold

| File | Lines |
|---|---|
| `apps/desktop/src/shared/plugins/sdk.ts` | 4,248 |
| `apps/ios/ADE/Views/Work/WorkSessionDestinationView.swift` | 3,669 |
| `apps/desktop/src/renderer/components/app/CommandPalette.tsx` | 3,309 |
| `apps/desktop/src/main/services/plugins/pluginHostService.ts` | 3,039 |
| `apps/desktop/src/shared/plugins/manifest.ts` | 2,466 |
| `apps/desktop/src/renderer/components/prs/CreatePrModal.tsx` | 2,272 |
| `apps/desktop/src/main/services/plugins/pluginSdkServer.ts` | 1,646 |
| `apps/ios/ADE/Views/Work/WorkRootScreen.swift` | 1,331 |
| `apps/desktop/src/renderer/components/plugins/marketplaceLocalIndex.ts` | 1,249 |
| `plugins/ade-linear/index.js` | 1,179 |

Nothing crossed the threshold because of this change. Two are close and worth acting on before the
next addition: `settingsManifest.ts` at 983 (M12.3) and `WorkRootScreen+Actions.swift` at 945.

`index.js` has one real seam: lines 917-1155 are `ownActions` (tools, steps, search, sockets, CLI);
lines 1-900 are lifecycle and publish. Extracting `actions.js` puts both under the threshold along a
responsibility, not a line count. M1's extraction also removes ~60 lines from `manifest.ts`.

### L2. `webhook.js:51` `TRIGGER_ID_REMAP` has no reader

Documented as exported "so the core-removal change can read it". A forward-looking export. Keep, but
note it in the wave report so the core-removal change is the thing that consumes it — otherwise it
becomes a fourth stale artefact.

### L3. `pluginEntityChanges.ts` is the third module-level bus in this layer

The header says so and cites `pluginRuntimeHooks`. A generic bus would be one concept instead of three.
The payload types differ enough that I do not recommend merging them now. Standard 1, deferred.

### L4. `pluginEntityChanges.ts:132` checks `=== undefined` on a `string | null`

The type says it cannot happen. Defensive for JS callers. Standard 6, cosmetic. Preserving: yes.

### L5. `linearApi.js:188` — `resetAt: new Date(resetAt).toISOString()`

`x-ratelimit-requests-reset` is a unix timestamp; `new Date(seconds)` yields 1970. Reaches nothing
today because `rateLimitStatus` has no caller (M5), so deleting the verb removes the latent defect.

### L6. `ForeignLaneContextMenu.tsx:181` — `copyText(lane.linearIssue?.url ?? "")`

Inside a guard that already proved `lane.linearIssue?.url`. Pre-existing. Hoist to a const, as
`laneContextMenuItems.tsx:268` already does. Standard 6. Preserving: yes.

### L7. `IngressStatusStrip.tsx:96-122` uses `linear?.state` after `linear != null` is proven at `:83`

Standard 6, cosmetic. Preserving: yes.

### L8. Test fixtures introduced by this change use `as unknown as LaneSummary`

`laneContextMenuItems.linearSurface.test.tsx`, `ForeignLaneContextMenu.linearSurface.test.tsx`, plus
one `as any` on `window.ade.cto`. Standard 6 at a test boundary. A `laneFixture()` builder removes all
three. Preserving: yes.

### L9. The supersedes-polarity paragraph is restated in six renderer files

`builtinTabs.ts:9-22` and `:109-117` is canonical. It is re-argued in prose at
`builtinSurfaces.ts:165-183`, `LinearIntegrationSection.tsx:13-18`, `LinearIssueBadge.tsx:61-63`,
`settingsManifest.ts:879-884`, `TriggerCard.tsx:310-323`. ~120 lines of comment for ~25 lines of logic.
`chatSources.ts:203-218` is 16 lines of comment over a zero-line code change — the argument is sound
but belongs in the extraction plan doc. Standard 4. Judo: one-line pointer to `builtinTabs.ts` at each
site. Preserving: yes. (This is the renderer twin of M11.7.)

---

## Read and judged clean

**Plugin (`plugins/ade-linear/`)**
`webhook.js` — the trigger port, the label-suppression rule and the ack-last ordering are correct and
well tested. `automation.js` — the four-caller/one-verb split and `asStep` are the right shape.
`linearApi.js` apart from M5 — the auth-mode branch, the retry budget, the 401-refresh latch and the
error taxonomy are all sound. `panels/issues.js` — the filter-strip slice at `:296` is the whole safety
story and it is correct. `panels/launch.js`. `panels/settings.js` apart from B2. `panels/rows.js`.
`panels/contract.js` apart from M4. `plugin.json`.

**Shared TypeScript**
`builtinSurfaces.ts` — the `enables`/`supersedes` polarity and the `actionDomains` vs `actionNames`
split, with the reasoning for each, are the strongest structural work in this change.
`urlMatchers.ts` — the pattern language, the capture handling, `isUnsafeDisplayCodePoint` written as
numbers, and `Object.hasOwn` at `:509` are all correct.

**Main services**
`pluginOfficialClients.ts` — three independent reasons a client secret cannot leak, and
`assertNoClientSecret` runs on the value that actually crosses the process boundary. One refusal code
for both "not the owner" and "no such provider", so a plugin cannot enumerate. `pluginEntityChanges.ts`
— the bus and `prTransitionsFromChanges` are clean; dropping a change with no `previousState` rather
than reporting `merged → merged` is the right call.

**Relay**
`apps/webhook-relay/src/relay.ts:271` — adding `linear-signature` to the stored headers is correct and
necessary now that the manifest declares `verify` against that header.

**CLI**
`apps/ade-cli/src/tuiClient/commands.ts` — the seven `builtin: "linear"` tags are the declared-gating
model done right.

**iOS**
`CtoRootScreen.swift`, `DeepLinkRouter.swift` (the `awaitDrawsBuiltin` vs `awaitInstalled` split is
well reasoned and documented), `WorkSessionDestinationView.swift` changes (re-checking in the action is
right for a context menu that outlives its gate), `WorkRootScreen+Actions.swift` apart from M11.3,
`LinearPaneToolbarButton.swift` logic, and the gate's concurrency core
(`PluginPresenceGate.swift:263-323`) — the `hasAnswer=false` on a failed call versus `hasAnswer=true`
on an old host is a sharp distinction, correctly implemented and correctly tested. The narrow
`PluginPresenceGateSyncing` protocol is the reason the gate is testable at all.

**Renderer**
`useOfferedTemplates.ts`, `TemplateGallery.tsx`, `templateData.ts` (the `builtin?` field is the model
the rest of the change should have followed), `AutomationsEmptyState.tsx`,
`settingsManifest.ts` entry model (`SettingEntry.builtinSurface?` + the check at `:774`, correctly
ordered before the web-client rules), `LinearIntegrationSection.tsx`, `LinearIssueBadge.tsx`,
`LaneContextMenu.tsx`, `LaneActionsSubmenu.tsx`, `ForeignLaneContextMenu.tsx` apart from L6,
`CreatePrModal.tsx` (gating the card and not the magic-word effect is the right call), `chatSources.ts`
(no code change; the decision not to gate a past turn's external link is correct).
