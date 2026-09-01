# Quality Track A (correctness/security) — wave-3 range c35bc0b88^..54df53935

Status at handoff: B1/B2/H1/H6/H11 and the plugin-side items are with the plugin fix agent; desktop/CLI/iOS items dispatched. Anything not in a commit after 366e6fe9d is STILL OPEN.

# Track A — Correctness & Security Review

**Scope:** `git diff a199ed1c33272a1bd39e42a91914c52ea122752c` (parent of `c35bc0b88`) — the wave-3 Linear plugin extraction, ~110 files.
**Base HEAD:** `54df53935`, branch `plugin-platform`.
**Method:** every changed file read in full; the panel seam, the vocabulary parser limits, the CI list and the plugin test suite were verified by execution, not by reading alone.

**Note on drift:** `plugins/ade-linear/index.js` and `plugins/ade-linear/data.js` were edited on disk by another agent while this review ran. All line numbers below are **HEAD (`54df53935`)** line numbers. `connect.js` also changed on disk (a `HANDOFF_ANSWER_KEY` rename) — that change looks correct and addresses part of H-family finding H11 below.

**Counts:** 2 Blocker · 11 High · 9 Medium · 10 Low = 32 findings.

---

## Blockers

### B1 — The issue-list and issue-detail panels always render "Connect Linear". The plugin's whole UI is dead.

**Location:** `plugins/ade-linear/panels.js:151-182` and `:194-218` vs `plugins/ade-linear/index.js:216-278`

**Evidence.** `buildIssuesPanel` / `buildIssuePanel` read the WHOLE model. `panels.js:84-87`:

```js
function connectionOf(model) {
  const connection = model && typeof model === "object" ? model.connection : null;
  return connection && typeof connection === "object" ? connection : {};
}
```

and `filtersOf(model)` at `panels.js:103-110` reads `model.filters`.

`viewFor()` returns the FLAT per-panel view, which has neither key — `index.js:220-247`:

```js
if (panelId === "issues") {
  const connection = snapshot.connection;
  return {
    state: snapshot.error ? "error" : (snapshot.counts.issues === 0 ? "empty" : "list"),
    error: snapshot.error,
    groups: snapshot.groups ?? [],
    query: filters.text || null,
    title: "Linear",
    statePreset: filters.stateTab,
    sort: filters.sort,
    view: filters.view === "flat" ? "flat" : "grouped",
    viewerId: connection?.viewerId ?? null,
    ...
  };
}
```

and `index.js:180` calls `schema = panels.build(panelId, view, context);`.

So `isConnected(model)` (`panels.js:113-115`) is always false and `state` is always `"disconnected"`. Verified by execution — feeding the exact `viewFor("issues")` output for a connected workspace with groups through `panels.build`:

```
ISSUES body components: ["emptyState","button"]
ISSUES first node: {"component":"emptyState","title":"Connect Linear",
  "description":"Sign in to browse and launch Linear issues from ADE. The token stays on this machine.",
  "icon":"plug","action":{"label":"Sign in with Linear","onPress":{"action":"connectOAuth"}}}
ISSUE  body components: ["emptyState","button"]
```

Secondary damage: every filter value the view computed is discarded too, because `filtersOf` finds no `model.filters` and falls back to `statePreset:"all"`, `sort:"updated_desc"`, `view:"grouped"`, `query:null`, `filtersActive:false`, `viewerId:null`, `workspace:null`, `age:null`.

The `settings` panel is unaffected — `viewFor("settings")` does return a `connection` key.

**Why the tests miss it.** `plugins/ade-linear/test/panels.test.js:80-88` builds `issuesModel()` as `{connection: CONNECTION, groups, filters, updatedAgo}`, and `apps/desktop/src/renderer/components/plugins/linearPluginPanels.test.tsx:236-242` does the same. Both call the builders with hand-written whole-model fixtures. Nothing exercises `viewFor → panels.build`.

**Fix.** One shape for the seam: either `viewFor` returns the whole-model shape `panels.js` documents (`{connection, filters, groups, loading, updatedAgo}`), or the `panels.js` wrapper builders are deleted and `panels.build` becomes a plain dispatcher onto the body builders. Add a regression test that drives `publish()` end to end.
**Classification:** needs human judgment (which side is canonical).
**Status:** the lead reports this is already being fixed — one mapper, `viewFor` stays canonical, `panels.build` becomes a plain dispatcher.

---

### B2 — `commentProgress` posts the chat transcript to an unrelated Linear issue, every time.

**Location:** `plugins/ade-linear/index.js:1046-1052`

**Evidence.**

```js
async commentProgress(args) {
  const sessionId = args?.context?.kind === "session" ? args.context.id : args?.sessionId ?? null;
  if (!sessionId) return { message: "Open this from inside a chat.", ok: false };
  const laneId = args?.laneId ?? null;
  const { rows } = await data.laneIndex();
  const link = rows.find((row) => row.laneId === laneId) ?? rows[0] ?? null;
```

The action is registered on the `chat-header-action` socket (`plugin.json` `sockets[2].menu[1]`). That socket dispatches `{ context, ...(options?.args ?? {}) }` (`apps/desktop/src/renderer/components/plugins/sockets/pluginActionDispatch.ts:111`) and `PluginChatHeaderActions.tsx:148` passes `session` with **no extra args**:

```tsx
void invoke(pluginId, actionId, session, { socket: "chat-header-action" })
```

`PluginSessionContext` is `{kind, id, title, provider, status}` (`apps/desktop/src/shared/plugins/context.ts:44-50`) — there is no `laneId`. So `args.laneId` is always `undefined`, `laneId` is always `null`, `rows.find(row => row.laneId === null)` always misses, and **`rows[0]` — the first Linear-linked lane in the whole project — is always taken**. The last assistant message is then posted as a comment on that lane's issue (`index.js:1068`, via `automation.addComment`), a ticket other people read.

`openSessionIssue` two functions above deliberately does NOT do this (`index.js:1026` returns a message instead), so the `?? rows[0]` is an inconsistency rather than a shared convention.

**Fix.** Drop `?? rows[0]` and resolve the lane from `sessionId` (see H1). Removing the fallback alone is behavior-preserving for the correct case and turns the wrong case into an honest message.
**Classification:** removing the fallback is unambiguous + behavior-preserving; the full lane resolution needs human judgment.
**Status:** the lead reports this is being forwarded now.

---

## High

### H1 — `openSessionIssue`, the chat header's primary Linear button, can never resolve its lane.

**Location:** `plugins/ade-linear/index.js:1020-1026`

```js
async openSessionIssue(args) {
  const laneId = args?.context?.kind === "lane"
    ? args.context.id
    : args?.laneId ?? (args?.context?.kind === "composer" ? args.context.laneId : null);
  const { rows } = await data.laneIndex();
  const link = rows.find((row) => row.laneId === laneId) ?? null;
  if (!link) return { message: "This lane has no Linear issue attached.", ok: false };
```

Same root cause as B2: the declared socket for this action is `chat-header-action` (`plugin.json` `sockets[2].actionId`), whose context is `{kind: "session"}`. Neither the `lane` branch nor the `composer` branch matches, and `args.laneId` is never sent, so `laneId` is `null` and the action **always** answers "This lane has no Linear issue attached." — even when the session's lane carries an issue. The `composer` branch is itself correct (`PluginComposerContext.laneId` exists, `context.ts:98`) but this action is not on the composer socket.

**Fix.** Add a `session` branch that maps `sessionId` → lane, via `sdk.lanes.list()` + `sdk.lanes.listSessionIssues(laneId)` (the new verb, `sdk.ts:1812`), or through `sdk.actions.invoke("chat", …)`.
**Classification:** needs human judgment.
**Status:** the lead reports this is being forwarded now.

---

### H2 — The TUI refuses `/linear` in the palette but not at dispatch, and a test asserts otherwise.

**Location:** `apps/ade-cli/src/tuiClient/app.tsx:12616, 12621, 12626, 12644, 12655, 12665, 12684`

**Evidence.** `slashCommandUnavailableSurface` appears exactly once in `app.tsx`, at line 11782, guarding `/cloud` — with a comment stating the rule:

```ts
if (name === "/cloud") {
  // A hidden palette row is not access control: `/cloud` can still be typed
  // in full, restored from history, or arrive from a keybinding. The gate is
  // checked here as well, and it names the plugin so the refusal reads as a
  // move rather than a breakage.
  if (slashCommandUnavailableSurface(name, pluginInstallRecords)) {
```

The seven `/linear*` branches have no such guard:

```ts
if (name === "/linear list") {
  const linear = await conn.action("linear_issue_tracker", "listIssues", parseLinearIssueListArgs(args || "--limit 20"));
```

The rows got `builtin: "linear"` in `commands.ts:193-199`, so they leave the palette when `ade-linear` is installed — but typing `/linear list` in full, restoring it from history, or hitting a keybinding still runs ADE's compiled `linear_issue_tracker` verbs on a machine where the plugin owns Linear. That is exactly the rule the `/cloud` block, `LinearPaneToolbarButton.swift:22-25` and `DeepLinkRouter.swift:655-657` all state.

The new test asserts the guarantee without touching the app — `apps/ade-cli/src/tuiClient/__tests__/commands.test.ts:863`:

```ts
it("still refuses a typed /linear, because a hidden row is not access control", () => {
  expect(slashCommandUnavailableSurface("/linear", LINEAR_INSTALLED)).toBe("linear");
```

It exercises the pure helper only, so the suite is green while the terminal does not refuse.

**Fix.** Add the same guard the `/cloud` branch has, once, before the `/linear*` chain (e.g. at `app.tsx:12615`), with a refusal pane naming the plugin.
**Classification:** shape unambiguous; refusal copy needs human judgment.

---

### H3 — The borrowed official client id sends a redirect URI that is almost certainly not registered on ADE's Linear app.

**Location:** `plugins/ade-linear/plugin.json` `authSessions[0].loopback = {port: 19837, path: "/oauth/callback"}` vs `apps/desktop/src/main/services/cto/linearOAuthService.ts:14-16`

**Evidence.** The built-in registers:

```ts
const CALLBACK_PATH = "/oauth/callback";
const OAUTH_HOST = "127.0.0.1";
const OAUTH_PORT = 19836;
```

and builds `http://127.0.0.1:${address.port}${CALLBACK_PATH}` (`linearOAuthService.ts:528`). ADE's registered Linear OAuth app therefore has `http://127.0.0.1:19836/oauth/callback`.

The plugin declares port **19837**, and `pluginAuthSessionService.ts:623-624` builds:

```ts
const redirectUri = transport === "loopback" && flow.loopback
  ? `http://${LOOPBACK_HOST}:${flow.loopback.port}${flow.loopback.path}`
```

→ `http://127.0.0.1:19837/oauth/callback`, sent with ADE's OWN `client_id` obtained from `sdk.auth.officialClient("linear")` (`connect.js:280-288`).

Linear, like most providers, requires the redirect URI to be pre-registered on the OAuth app. Unless 19837 was added to ADE's Linear app registration, the fresh-install OAuth path — the entire reason `pluginOfficialClients.ts` exists — fails at Linear's authorize screen with a redirect-URI mismatch. Nothing in the diff records that the registration was updated, and no code test can catch it.

The port choice itself is correct: 19836 vs 19837 deliberately avoids a collision while both the compiled integration and the plugin exist.

**Fix.** Register `http://127.0.0.1:19837/oauth/callback` on ADE's Linear OAuth app, or state where that was already done.
**Classification:** needs human judgment (external registration, not a code change).

---

### H4 — `refreshCatalog(teamKey)` deletes every OTHER team's workflow states; an unknown team key wipes the catalog entirely.

**Location:** `plugins/ade-linear/data.js:657-682`, reachable from `plugins/ade-linear/automation.js:181-184`

**Evidence.**

```js
async function refreshCatalog(teamKey = null) {
  let teams;
  try { teams = await api.listTeamsAndStates(teamKey); } catch (error) { ... }
  const teamRows = new Map();
  const stateRows = new Map();
  for (const team of teams) { ... }
  await replacePrefix(COLLECTION_TEAMS, "team:", teamRows);
  await replacePrefix(COLLECTION_STATES, "team:", stateRows);
```

`api.listTeamsAndStates(teamKey)` fetches only that one team (`linearApi.js:541-549`, `teams(filter: { key: { eq: $teamKey } })`), but the sweep replaces the WHOLE `team:` prefix in both collections. `replacePrefix` (`data.js:288-294`) deletes every key under the prefix the new map does not name:

```js
async function replacePrefix(collection, prefix, wanted) {
  for (const [key, value] of wanted) await put(collection, key, value);
  const existing = await list(collection, { keyPrefix: prefix, limit: 1_000 });
  for (const row of existing) {
    if (!wanted.has(row.key)) await del(collection, row.key);
  }
}
```

Reached from the agent tool `list_states`:

```js
let states = await data.states(teamKey ? teamKey.toUpperCase() : null);
if (states.length === 0) {
  await data.refreshCatalog(teamKey ? teamKey.toUpperCase() : null).catch(() => {});
```

An agent calling `list_states({teamKey: "NOPE"})` (or any team not yet cached) gets `teams.nodes = []` → both maps empty → **every stored team row and every stored workflow-state row is deleted**. A valid key like `"ENG"` has the same effect on all other teams.

Downstream: `flows.pickCompletedStateId` and `pickStartedStateId` return null, so `closeIssueOnMerge` (`flows.js:409-412`, logs "No completed state … leaving it where it is") and `moveToStarted` (`flows.js:331-332`) silently stop working for every team until the next unfiltered `refreshCatalog`, which only runs on activate/reconnect (`index.js:872`). The settings panel's team list (`index.js:354`) also empties.

**Fix.** Either (a) run the `replacePrefix` sweep only when `teamKey === null` and plain-`put` the rows on the filtered path, or (b) scope the states sweep to `statesKeyPrefix(row.key)` per team and skip the teams sweep entirely on the filtered path.
**Classification:** needs human judgment (two reasonable shapes).

---

### H5 — The State-preset and View controls are no-ops: two key spaces that never meet.

**Location:** `plugins/ade-linear/panelActions.js:105-113` and `:300-310`

**Evidence.**

```js
/** The state keys `Reset filters` clears. `view` is deliberately not among them. */
const FILTER_STATE_KEYS = [
  STATE_PRESET, STATE_PROJECT, STATE_ASSIGNEE, STATE_PRIORITY,
  STATE_SORT, STATE_TEAM, STATE_UPDATED,
];
...
async applyFilters(args) {
  const frame = args && typeof args === "object" ? args : {};
  const patch = {};
  for (const key of FILTER_STATE_KEYS) {
    if (frame[key] !== undefined) patch[key] = frame[key];
  }
  if (typeof frame.value === "string") patch.value = frame.value;
  const result = await invoke(host, "data.setFilters", [patch], "");
```

Those constants are `"state"`, `"project"`, `"assignee"`, `"priority"`, `"sort"`, `"team"`, `"updated"` (`panels/contract.js:171-178`).

`data.js:161-176 normalizeFilters` reads `stateTab`, `projectId`, `assigneeId`, `priority`, `sort`, `text`, `view`, `updated` and drops everything else. `index.js:563-572` passes the patch straight through to `data.updateFilters(patch)` (`data.js:780-784`), which spreads it into `normalizeFilters`.

I confirmed the dispatch shape: `apps/desktop/src/renderer/components/plugins/vocabularyComponents.tsx:291`:

```tsx
void context.dispatch(node.onChange, { [node.stateKey]: value })
```

so the args arrive keyed by the **state key**, and `frame.value` is never populated for a segmented change.

Consequences:

- `presetControl` (`panels/issues.js:147-156`, `stateKey: STATE_PRESET`, `onChange: {action: "applyFilters"}`) sends `{state: "active"}` → `patch.state` → dropped by `normalizeFilters` → `stateTab` never changes → **All / Active / Backlog never changes the fetch**, and `index.js:230` (`statePreset: filters.stateTab`) always redraws on "All issues".
- `viewControl` (`panels/issues.js:229-239`, `stateKey: STATE_VIEW`, same `onChange`) — `STATE_VIEW` is **not in `FILTER_STATE_KEYS` at all**, so `patch` is empty. `filters.view` never flips, the schema keeps binding `group:` rather than `flat:`, and **the flat/selectable list and the entire bulk-action bar are unreachable** even though the toggle moves locally.
- `project`, `assignee` and `team` are also dropped, but those are client-side `where` axes (`panels/issues.js:130-137`), so the only visible cost is that `filtersActive` in `viewFor` can never become true from them.
- Only `sort` and `updated` survive the round trip by accident of matching names.

`panels/issues.js:16-25` explicitly documents both broken controls as round trips that must work.

**Fix.** Map the panel state keys to the stored filter names in `applyFilters` (or in `index.js`'s `setFilters` adapter), and add `STATE_VIEW` to the forwarded set while keeping it out of the reset set.
**Classification:** needs human judgment (one constant currently serves two jobs: forwarding and resetting).

---

### H6 — Issue label chips never render: label objects filtered as strings.

**Location:** `plugins/ade-linear/panels/issue.js:210-222`, called at `:459`

**Evidence.**

```js
function labelChips(labels) {
  const names = (Array.isArray(labels) ? labels : []).filter((name) => typeof name === "string" && name.trim());
  if (names.length === 0) return [];
```

and the call site:

```js
body.push(...labelChips(issue.labels));
```

`issueFormat.js:145-151` stores labels as objects:

```js
const labels = Array.isArray(node?.labels?.nodes)
  ? node.labels.nodes.map((label) => ({ id: ..., name: ..., color: ... }))
  : [];
```

and `data.js:406` writes that canonical row unchanged (`await put(COLLECTION_ISSUES, \`${ISSUE_KEY_CANONICAL}${row.id}\`, row)`), which is what `data.issueRow` returns and `index.js:263` hands to the builder. Every entry fails `typeof name === "string"`, so the block returns `[]` always.

The two test fixtures disagree, which is why nothing catches it: `test/panels.test.js:109` uses `labels: ["bug", "runtime"]` while `test/issueFormat.test.js:133` asserts `row.labels.map((label) => label.id)`.

**Fix.** Read `label.name`, accepting both shapes — `issueFormat.js:269` already does `row.labels.map((label) => label.name)`.
**Classification:** unambiguous + behavior-preserving.

---

### H7 — The "Reasoning effort" select is dropped by the vocabulary parser on every client.

**Location:** `plugins/ade-linear/panels/launch.js:195-206`, options from `plugins/ade-linear/index.js:83-89`

**Evidence.**

```js
const REASONING_EFFORTS = [
  { value: "", label: "Default" },
  { value: "low", label: "Low" },
  ...
];
```

```js
// `""` is a real option here — it is "whatever the model does by default" —
// so the list is not filtered for empties the way the other two would be.
const effortOptions = selectOptions(reasoningEfforts, LIMITS.maxSelectOptions);
if (effortOptions.length > 0) {
  fields.push({ kind: "select", id: "reasoningEffort", label: "Reasoning effort", options: effortOptions, value: ... });
}
```

The comment is wrong about the contract. `apps/desktop/src/shared/plugins/vocabularyNodes.ts:1229-1230`:

```ts
const value = vocabString(entry.value, VOCAB_LIMITS.maxValueChars);
if (value === undefined || seen.has(value)) return null;
```

and `vocabString` (`:805-809`):

```ts
export function vocabString(value: unknown, maxChars: number): string | undefined {
  const text = trimmed(value);
  if (text === null) return undefined;
  ...
}
```

`vocabString("")` → `trimmed("")` → `null` → `undefined`, so the **entire field** returns `null` and is skipped at `:1456`. A `segmented` node DOES allow an empty value (`vocabularyState.ts:746-749`), which is where the assumption came from; form selects do not.

The launch panel is live — `plugin.json` declares `{"id":"launch","schemaFile":"panels/launch.json","title":"Launch","icon":"rocket"}` and `index.js:688` defines `flows.openLaunch` unconditionally — so this ships. Note `test/panels.test.js` contains a test named "keeps the empty reasoning effort, which is a real choice", pinning the broken shape against a fixture rather than the real parser.

**Fix.** Use a non-empty sentinel (`"default"`) and map it back in `submitLaunch` / `spawnAgentOnIssue`, or drop the empty option.
**Classification:** needs human judgment (the sentinel must round-trip through `index.js:647`).

---

### H8 — Two of the ten plugin test files never run in CI, and they cover the layer B1/H5/H7 live in.

**Location:** `.github/workflows/ci.yml:149`

**Evidence.** The diff appends eight paths:

```
plugins/ade-linear/test/automation.test.js plugins/ade-linear/test/connect.test.js
plugins/ade-linear/test/data.test.js plugins/ade-linear/test/flows.test.js
plugins/ade-linear/test/index.test.js plugins/ade-linear/test/issueFormat.test.js
plugins/ade-linear/test/linearApi.test.js plugins/ade-linear/test/webhook.test.js
```

The directory holds ten:

```
automation.test.js connect.test.js data.test.js flows.test.js index.test.js
issueFormat.test.js linearApi.test.js panelActions.test.js panels.test.js webhook.test.js
```

`panels.test.js` (977 lines) and `panelActions.test.js` (408 lines) — 1,385 lines — are omitted. I ran them: 97 tests, all pass, so this is missing coverage rather than hidden failures. Running the full directory: 467 tests, 467 pass.

**Fix.** Add both paths to the `node --test` list.
**Classification:** unambiguous + behavior-preserving.

---

### H9 — iOS: `awaitDrawsBuiltin` answers from an empty roster before the host's command catalog arrives, and latches.

**Location:** `apps/ios/ADE/Views/Plugins/PluginPresenceGate.swift:295-298`

**Evidence.**

```swift
guard sync.supportsPluginPresenceList else {
  apply(plugins: [], trigger: trigger, answered: true)
  return
}
```

`supportsPluginPresenceList` is `supportsRemoteAction("plugins.presenceList")` (`SyncService.swift:9499-9501`) → `commandDescriptor(for:) != nil` (`:15210-15212`) → `remoteCommandDescriptors.first(where:)` (`:15198-15200`). That array is populated by the connection handshake and is **empty before it**, so the guard is false for a modern host too.

The gate then records `answered: true` with an empty roster and freezes it: `ensureAnswer()` (`:257-260`) returns early once `hasAnswer` is true, and `pluginPresenceTrigger` (`SyncService.swift:9554-9556`) is:

```swift
"\(activeProjectHostIdentity ?? "-")|\(pluginsProjectionRevision)"
```

— no capability component. `activeProjectHostIdentity` is restored from `UserDefaults` at launch (`SyncService.swift:5687`), so on a cold launch with a remembered host the trigger is already final while the catalog is empty. The stale answer only clears if the identity changes (it will not) or `pluginsProjectionRevision` increments (`:5918`, a CRR write touching a plugins table — eventually, not deterministically before a deep link is consumed).

For a `.supersedes` surface an empty roster means *draw the compiled pane*, so a cold-launch `ade://linear-issue/…` on a machine that positively has `ade-linear` opens ADE's compiled Linear pane — the exact case the twin's own doc claims to prevent (`PluginPresenceGate.swift:229-232`).

No deadlock exists: `sendCommand` is timeout-bounded and a thrown fetch leaves `answered: false` so the next consult retries (`:302-305`). This is the wrong-polarity path, not a hang.

Untested: `FakePresenceSync.supportsPluginPresenceList` defaults to `true` (`PluginPresenceGateTests.swift:28`), and the only unsupported-host test (`:103`) exercises `owns`, not the awaited twin.

**Fix.** Distinguish "this host predates the platform" from "capabilities not negotiated yet" — fold connection/capability readiness into `pluginPresenceTrigger`, or apply `answered: false` when the transport has not yet delivered a command catalog.
**Classification:** needs human judgment.

---

### H10 — `deliveries` and `comments` grow unbounded against a per-plugin budget, and the code comment claims the opposite.

**Location:** `plugins/ade-linear/webhook.js:212-235`, `plugins/ade-linear/data.js:643`

**Evidence.** The plugin's own comment (`webhook.js:216-221`):

> Bounded by the platform: `evictOldest` drops the oldest ids in THIS collection when it fills, so an ingress that has run for a year cannot push the issue rows out of the store beside it. That is the whole argument for `deliveries` being a collection of its own.

The host's eviction is same-collection only, while the budget is per-plugin — `apps/ade-cli/src/services/plugins/pluginTableWriters.ts:180-206`:

```ts
if (args.ifFull !== "evictOldest") throw refusal;
const candidates = db.all<{ key: string; bytes: number }>(
  `select key, length(cast(value_json as blob)) as bytes
     from plugin_collections
    where plugin_id = ? and collection = ? and key <> ?
    order by updated_at asc, key asc
    limit ?`, ...);
...
// Still over after emptying what it was allowed to: the value is bigger
// than the whole budget, or the rows in the way live in other collections.
// Throwing rolls the evictions back with it.
if (overBudget(nextRows, nextBytes)) throw refusal;
```

with `readPluginCollectionUsage(db, args.pluginId)` and `PLUGIN_COLLECTIONS_MAX_ROWS_PER_PLUGIN = 4_000` / `PLUGIN_COLLECTIONS_MAX_BYTES_PER_PLUGIN = 2 MiB` (`sdk.ts:77-80`).

`deliveries` is never pruned — I grepped: the only writes are `webhook.js:223` (`get`) and `:228` (`put`), no delete anywhere. `comments` is pruned only per-issue (`data.js:643`, `replacePrefix(COLLECTION_COMMENTS, commentKeyPrefix(issueId), wanted)`); nothing removes rows for issues that left the view.

Steady-state `issues` + `states` + `teams` + `projects` + `people` + `viewer` is ~970 rows, so a few thousand webhook deliveries — or ~60 opened issues at 50 comments each — exhausts the budget. After that every `put(COLLECTION_ISSUES, …)` can only evict `issues` rows, so the issue list monotonically shrinks, and `data.js:266-269` swallows the refusal, so the only symptom is a warn line per row and a list that quietly empties.

**Fix.** Give both collections an explicit self-imposed cap — sweep `deliveries` down to N (e.g. 500) by key after each `remember()`, and prune `comments` for issues no longer in the canonical key space at the end of `refreshIssues`.
**Classification:** needs human judgment (cap values are a product call).

---

### H11 — The credential-handoff button can never render (vocabulary mismatch on `handoffStatus`).

**Location:** `plugins/ade-linear/panels.js:241` vs `plugins/ade-linear/index.js:347-348`

**Evidence.** `buildSettingsPanel` reads it off `connection`:

```js
handoffStatus: connection.handoffStatus ?? null,
```

but `viewFor("settings")` puts it at the TOP level, and on the disconnected path `connection` is `null` anyway:

```js
// "offered" is the one value that draws the adopt button, so it is set
// only while the handoff genuinely has not been answered.
handoffStatus: handoffLabel(status),
```

Verified by execution — `panels.build("settings", {connection:null, handoffStatus:"offered", …})`:

```
SETTINGS: ["emptyState:Connect Linear","text","divider:API key","text","form","button:Create a key on linear.app"]
has handoff button: false
```

No "Use the connection ADE already has" (`panels/settings.js:173-188`). This is the release-day verb: without it, every existing user reconnects by hand.

**Fix.** Read `model.handoffStatus ?? connection.handoffStatus ?? null`, mirroring the `clientSource` fallback two lines above at `panels.js:254`.
**Classification:** unambiguous + behavior-preserving.
**Note:** `connect.js` on disk has since gained a `HANDOFF_ANSWER_KEY` constant separating the stored vocabulary (`accepted|declined|empty`) from the panel's (`offered|taken|declined`), which addresses the underlying vocabulary collision. Confirm the `panels.js:241` read was fixed too — the two are separate defects.

---

## Medium

### M1 — `list(collection, {limit: 1_500})` is silently clamped to 1,000, so canonical issue rows are never swept.

**Location:** `plugins/ade-linear/data.js:453-456` and `:581`

```js
const existing = await list(COLLECTION_ISSUES, { limit: 1_500 });
for (const row of existing) {
  if (!wanted.has(row.key)) await del(COLLECTION_ISSUES, row.key);
}
```

The host clamps without telling anyone — `apps/desktop/src/main/services/plugins/pluginDataStore.ts:101, 229-234`:

```ts
const PLUGIN_COLLECTION_LIST_MAX_LIMIT = 1_000;
...
const limit = Math.min(
  Math.max(1, Math.trunc(options?.limit ?? PLUGIN_COLLECTION_LIST_DEFAULT_LIMIT)),
  PLUGIN_COLLECTION_LIST_MAX_LIMIT,
);
```

with `order by key`.

`wanted` holds up to 3 keys per issue × 250 issues = 750. On a filter or sort change the ranks shift, so nearly every `flat:` and `group:` key is new and the collection momentarily holds ~1,250 keys. Prefixes sort `flat:` < `group:` < `issue:` (f < g < i), so the first 1,000 rows are consumed by flat + group and **the sweep never reaches the canonical `issue:` space**. Stale canonical rows accumulate on every filter/sort change.

Downstream: `issueRows()` (`data.js:369`) and `findIssueRow`'s identifier scan (`data.js:385`) both read `{keyPrefix: "issue:", limit: MAX_ISSUES}` ordered by key — the lexicographically first 250 UUIDs, an arbitrary mix of live and stale. The universal-search provider (`automation.js:319`) is fed from exactly that.

**Fix.** Page the sweep (`limit: 1_000` in a loop keyed on the last key seen), or run three prefix-scoped sweeps (`issue:`, `flat:`, `group:`) at 1,000 each.
**Classification:** unambiguous + behavior-preserving.

---

### M2 — A webhook body over 64 KiB is dropped entirely, and the comment says it degrades.

**Location:** `plugins/ade-linear/webhook.js:257-277`

```js
let body = null;
try { body = payload?.body ? JSON.parse(payload.body) : null; } catch { body = null; }
if (!record(body)) {
  log("warn", `Linear delivery ${deliveryId} had a body this plugin could not read.`);
  await remember(deliveryId, { at: new Date().toISOString(), unreadable: true });
  await sdk.webhooks.ack(deliveryId).catch(() => {});
  return { unreadable: true, deliveryId };
}

// A body the relay clipped at the cap is one whose `updatedFrom` may be
// missing ... The issue is still refetched — the ROW is right either way —
// and the triggers are emitted from what did arrive ...
if (payload.truncated) { ... }
```

`clampPluginWebhookBody` (`apps/desktop/src/shared/plugins/sdk.ts:3957-3966`, cap `PLUGIN_WEBHOOK_BODY_MAX_BYTES = 64 * 1024` at `:152`) clips by code unit mid-JSON. A clipped body cannot parse, so the `!record(body)` branch fires first and returns — **no refetch, no triggers, delivery acked and dropped**. The `if (payload.truncated)` branch below it is unreachable for any clipped JSON body, and the comment's promise ("the ROW is right either way") is false.

The verification order is correct and NOT part of this defect: `pluginWebhookIngressService.ts:496` runs `passesVerification` against the full `row.body` before `:505` clamps, so a large delivery is not a signature failure.

**Fix.** On `truncated`, still refetch the issue named by the delivery's headers/id even when the body will not parse.
**Classification:** needs human judgment.

---

### M3 — An unknown `authMode` surfaces as a 3-retry network failure instead of `no_token`.

**Location:** `plugins/ade-linear/linearApi.js:361-383`

```js
try {
  response = await fetchImpl(graphqlUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: authorizationHeader(credential.token, credential.authMode),
    },
    ...
} catch (error) {
  if (attempt >= maxRetries) {
    throw new LinearApiError("network", `Could not reach Linear: ${error?.message ?? error}`);
  }
  attempt += 1; await sleep(backoffMs); ...
}
```

`authorizationHeader` throws `LinearApiError("no_token", "The stored Linear credential does not say whether it is an API key or an OAuth token.")` for an unrecognised mode (`:110-118`), but the call sits INSIDE the fetch `try`, so it is treated as a transport error, sleeps the full backoff (500 + 1000 + 2000 ms), and finally throws `network`.

Consequences: `isMissingTokenError` returns false, so `failureMessage` (`index.js:902-905`) no longer says "Connect Linear in Settings → Linear."; `data.refreshIssues` maps it to `state: "error"` instead of `"no-token"` (`data.js:428`), so the panel draws an error banner rather than the Connect affordance. Reachable whenever `LINEAR_ACCESS_TOKEN` exists but `LINEAR_AUTH_MODE` does not — e.g. a partial handoff, since `readCredential` normalises anything unrecognised to `null` (`linearApi.js:229`).

**Fix.** Hoist `const authorization = authorizationHeader(credential.token, credential.authMode);` above the `try`.
**Classification:** unambiguous + behavior-preserving.

---

### M4 — `stateGroups` builds an unbounded node list; a multi-team workspace fails the whole panel.

**Location:** `plugins/ade-linear/panels/issues.js:365-380`, spread at `:530`

```js
function stateGroups(groups) {
  return groups.map((group) => ({
    component: "group", ...,
    children: [{ component: "list", bind: issueBinding(groupKeyPrefix(group.stateId)), emptyText: COPY.noIssues }],
  }));
}
```

Two nodes per group, no cap. Groups are one per distinct `stateId` across up to `MAX_ISSUES = 250` issues (`data.js:485-507`), and every Linear team has its own workflow-state ids — so ~16 teams reaches ~94 distinct states.

`VOCAB_LIMITS.maxNodes` is 200 (`vocabularyNodes.ts:82`), and `parsePluginPanel` fails the WHOLE panel on overflow rather than truncating — `vocabulary.ts:381-391`:

```ts
if (state.overflowed) {
  return fail([{ code: state.nodeCount >= VOCAB_LIMITS.maxNodes ? "too_many_nodes" : "too_deep", ... }]);
}
```

so the reader gets the fallback card ("Open ADE on the computer that holds this plugin…") on the very computer that holds it. `panels.update` (`pluginSdkServer.ts:1056-1064`) only checks bytes, so nothing catches it on the write side either.

Every other list in this plugin caps (`issue.js:219` `slice(0,12)`, `:304` `slice(0,50)`, `settings.js:342`), and `common.js:51-78` already exports `LIMITS.maxNodes`.

**Precondition:** a large multi-team workspace. Below ~93 distinct states it never fires.

**Fix.** Cap the group count and say what was dropped, the way `appendComments` does.
**Classification:** needs human judgment (cap value and overflow copy).

---

### M5 — Windows: the loopback bind treats only `EADDRINUSE` as contention.

**Location:** `apps/desktop/src/main/services/plugins/pluginAuthSessionService.ts:150-156`

```ts
function isAddressInUseError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if ("code" in error && (error as { code?: unknown }).code === "EADDRINUSE") return true;
  return error instanceof Error && (
    error.message.includes("EADDRINUSE") || error.message.includes("address already in use")
  );
}
```

On Windows a bind to a port inside a Hyper-V / WSL dynamic-port exclusion range fails with `EACCES`, not `EADDRINUSE`, so the plugin gets `internal_error` instead of the actionable `auth_session_busy` message that names the port (`:559-574`).

The helper predates this lane, but `ade-linear` is the **first and only** plugin to declare a `loopback` callback — I grepped `plugins/*/plugin.json` and it is the sole hit — so the lane is what makes the path reachable.

**Fix.** Accept `EACCES` (and `EBUSY`) on `win32`, matching the pattern `windows-quirks.md` §6 already establishes for lock contention (`isLockContention()` in `credentialStore.ts`).
**Classification:** unambiguous + behavior-preserving.

---

### M6 — Hiding the Linear PR card removes the opt-out but not the close-on-merge behaviour.

**Location:** `apps/desktop/src/renderer/components/prs/CreatePrModal.tsx:1746`, `:526`, `:921-931`

```tsx
{selectedNormalLinearIssue && linearSurfaceVisible ? (
```

but the state and the payload are untouched:

```tsx
const [normalCloseLinearIssueOnMerge, setNormalCloseLinearIssueOnMerge] = React.useState(true);
...
const body = linearIssue
  ? ensureLinearPrReference(normalBody, linearIssue, normalCloseLinearIssueOnMerge, { preserveExisting: false })
  : normalBody;
...
...(linearIssue ? { closeLinearIssueOnMerge: normalCloseLinearIssueOnMerge } : {}),
```

and `apps/desktop/src/main/services/prs/prService.ts:7333` defaults it true anyway:

```ts
const closeLinearIssueOnMerge = args.closeLinearIssueOnMerge !== false;
```

The gate's own comment (`:704-708`) says the card goes "because the plugin has a `moveToDoneOnMerge` setting … and two controls over one policy is how the two disagree." But the policy does not go: the body is still rewritten from `Refs` to `Fixes`, and `closeLinearIssueOnMerge: true` is still sent. On a machine with `ade-linear` the user gets ADE's compiled closing linkage AND the plugin's `moveToDoneOnMerge`, with the opt-out invisible. The long comment at `:760-773` justifies keeping the *reference* but never addresses the closing choice, which is the part the checkbox owned.

**Fix.** Either keep the card (it is the only opt-out) or force the non-closing form when the surface is superseded.
**Classification:** needs human judgment — a product decision about who owns close-on-merge.

---

### M7 — A transient `openLaunch` failure silently creates a lane and starts an agent.

**Location:** `plugins/ade-linear/panelActions.js:418-425`

```js
const result = await invoke(host, "flows.openLaunch", [issueId, { ...args, laneOnly }], "");
if (!result.ok) {
  return laneOnly ? await handlers.launchLaneOnly(args) : await handlers.launchLaneAndAgent(args);
}
```

`invoke` returns `{ok:false}` for BOTH "capability absent" (`:136`) and "the call threw" (`:140-142`). `flows.openLaunch` (`index.js:688-694`) awaits `loadModels()` and `publish("launch", …)`, either of which can throw. The reader presses "Launch lane + agent" expecting the configuration form and instead gets a worktree and a running agent on the plugin's defaults, with no message.

**Fix.** Distinguish "missing" from "failed" — check `capability(host, "flows.openLaunch")` for the fallback and surface a thrown error as a message.
**Classification:** unambiguous + behavior-preserving.

---

### M8 — `closeIssueOnMerge` guesses a foreign team's Done state when the link carries no team key.

**Location:** `plugins/ade-linear/flows.js:406-415`

```js
const teamKey = issue.container?.key ?? null;
const states = await data.states(teamKey);
const doneId = pickCompletedStateId(states);
...
await api.updateIssueState(issue.issueId, doneId);
```

`data.states(null)` returns every stored team's states ordered by key `team:<KEY>:<rank>:<id>` (`data.js:686-690`), and `pickCompletedStateId` takes the first `type === "completed"` it finds (`flows.js:101-104`) — the alphabetically first team's Done state. `IssueRefContainer.key` is optional (`apps/desktop/src/shared/issueRef.ts:148`), and this path deliberately consumes links from any producer including core's, so a link without a container silently attempts a cross-team state move. Linear refuses it, the error is caught and warned (`flows.js:418-423`), the latch is released — so the issue never moves and nothing tells the user why.

**Fix.** When `teamKey` is null, skip with the same "no completed state" warning rather than guessing, or resolve the team from the stored issue row (`data.issueRow(issue.issueId)?.teamKey`).
**Classification:** needs human judgment.

---

### M9 — `lane.changed` triggers an unthrottled full Linear re-read.

**Location:** `plugins/ade-linear/index.js:803-805`

```js
subscriptions.push(sdk.events.on("lane.changed", () => {
  void refreshIssues().then(() => publishLaneBadges()).catch(() => {});
}));
```

`refreshIssues` (`index.js:465`) is the uncached one, not `ensureIssues` (`:475-477`) which respects `ISSUE_CACHE_MS`. Each call is up to three paginated GraphQL requests plus ~750 collection puts plus two panel publishes. `createLaneFromIssue` itself emits a lane change AND calls `refreshIssues()` directly (`index.js:630`), so one lane creation costs two full reads.

**Fix.** Call `ensureIssues()` here, or debounce the handler.
**Classification:** unambiguous + behavior-preserving (`ensureIssues` exists for exactly this).

---

## Low

### L1 — `pluginEntityChanges.ts` doc names the wrong call site.
`apps/desktop/src/main/services/plugins/pluginEntityChanges.ts:114` says the mapping's call site is "one arrow inside `main.ts`'s `onPullRequestsChanged`". It is `apps/ade-cli/src/bootstrap.ts:2204`. I confirmed `emitPluginEntityChange` is called only from `bootstrap.ts` (grepped all of `apps/`), so this is a doc error and **not** a missed surface — the plugin host lives in the brain only, and `main.ts`'s PR poller never fed plugin events. **Auto-applyable.**

### L2 — Child action dispatch resolves through the prototype chain.
`apps/desktop/src/main/services/plugins/childRuntime/pluginChildBootstrap.ts:463-468`:
```ts
const handler = pluginModule?.actions?.[frame.action];
if (!handler) { throw new PluginSdkError("unsupported_method", ...); }
const result = await handler(frame.args);
```
A bare index lookup on a plain object (`panelActions.js:248` `const handlers = {`, merged at `index.js:774`). A crafted action id of `constructor` / `toString` / `valueOf` resolves to an `Object.prototype` function, passes the truthiness check, and is invoked — returning a bogus success instead of `unsupported_method`. No privilege escalation (it only reaches `Object(args)` / `"[object Object]"`), and `openUrl` is separately gated. Same class the vocabulary guards at `vocabularyNodes.ts:1647-1649` with `Object.hasOwn` and a comment naming it. Fix: `Object.hasOwn(actions, frame.action)` before the lookup. **Auto-applyable.**

### L3 — Four stale comments that are factually wrong about the shipped code.
- `plugins/ade-linear/index.js:21-24` — "`official: true` buys this package exactly two things: the `builtin: "linear"` gate on the pane". `linear` is now a superseded surface; the manifest declares a `tab` with no `builtin`, and `parseSurfaces` (`manifest.ts:1075-1080`) would ignore the field if it were there.
- `plugins/ade-linear/panels/contract.js:151-160` and `panels.js:277-284` — "The launch panel is NOT declared in `plugin.json` today". It is.
- `plugins/ade-linear/index.js:1077-1084` and `panels/settings.js:445-450` — "The manifest does NOT declare `verify` today". `plugin.json:38-42` does, with `secretRef: "LINEAR_WEBHOOK_SECRET"`. Since the host fails closed on a missing secret (`pluginWebhookIngressService.ts:442-443`), verification is on and every delivery drops until the user saves the secret — yet `index.js:381-388` still reports `status: "Endpoint ready"`. The user-facing copy at `settings.js:464-465` is correct.
- `plugins/ade-linear/panels/contract.js:297` — `CORE_OWNED_ACTIONS` lists `"closeIssueOnMerge"`; the registered handler is `stepCloseIssueOnMerge`. The table is documentation-only (nothing reads it).

**Auto-applyable**, except the `"Endpoint ready"` wording, which needs human judgment.

### L4 — Stale polarity statement in a doc comment future gating will read.
`apps/desktop/src/renderer/components/app/commandPaletteSearch.tsx:296-297` still describes `hiddenKinds` as "Linear issues and artifacts, when their plugin is not installed" — the `"enables"` reading. The caller is correct (`CommandPalette.tsx:342,349`). Reword to "…when the surface is not drawn on this machine". **Auto-applyable.**

### L5 — A row's `meta` is clamped to the wrong ceiling.
`plugins/ade-linear/panels/rows.js:79` `row.meta = value(metaLine(source));` clamps to `maxValueChars` (1000), but `readListItem` reads `meta` at `maxLabelChars` (200) — `vocabularyNodes.ts:1155`. `metaLine` appends `issue.labelNames`, an uncapped comma-join (`issueFormat.js:182`), so a heavily labelled issue is cut twice, the second time by the parser with its own ellipsis. Fix: `row.meta = label(metaLine(source));`. **Auto-applyable.**

### L6 — Sub-issue heading counts more than it draws.
`plugins/ade-linear/panels/issue.js:301` labels the divider `` `${COPY.subIssues} (${rows.length})` `` while `:304` draws `rows.slice(0, 50)`. An issue with 60 children says "Sub-issues (60)" over 50 rows with no note. **Auto-applyable.**

### L7 — The comment key space is spelled twice.
`plugins/ade-linear/index.js:258-259` inlines `` keyPrefix: `comment:${issue.id}:` `` instead of calling the exported `commentKeyPrefix`. `panels/contract.js:1-11` names this exact bug class ("a second spelling of them here is a bug that renders as an empty list rather than as an error"). It matches today. Fix: import and call `commentKeyPrefix(issue.id)` and `COLLECTION_COMMENTS`. **Auto-applyable.**

### L8 — TUI `/issue` still reaches ADE's compiled Linear attach on a plugin machine.
`apps/ade-cli/src/tuiClient/app.tsx:12724-12726`. `/issue attach ADE-123` is a Linear entry point; the iOS and desktop equivalents were gated (`WorkSessionDestinationView.swift:1235` `canAttachIssue: pluginGate.drawsBuiltin(.linear)`; `AgentChatComposer.tsx:2267`). Unlike `/linear` it also serves GitHub, so it cannot carry `builtin: "linear"` wholesale — gate the Linear half only, mirroring the composer's split. **Needs human judgment.**

### L9 — The autolinks list is capped by the wrong limit for an inline list.
`plugins/ade-linear/panels/settings.js:340-361` uses `LIMITS.maxListItems` (250 — the ceiling for a *bound* list), but an inline list spends schema bytes (`vocabularyNodes.ts:96-104`). Candidates are one per team, uncapped (`data.js:800-812`), against the file's own "a handful" assumption (`settings.js:313-315`). 250 candidates plus a 250-team select measures ~58,961 bytes against `maxSchemaBytes` 65,536 — already past the plugin's own `SOFT_SCHEMA_BYTES` (57,344), and over the hard limit with longer team names, at which point `encodePluginJsonWithinBudget` refuses the publish and the settings panel goes stale. **Needs human judgment** (cap value).

### L10 — `flows.sessionIssues` is dead code and its documented guard is not the path taken.
`plugins/ade-linear/flows.js:437-446` defines `sessionIssues(laneId)` with a downlevel guard (`if (typeof sdk.lanes?.listSessionIssues !== "function") return [];`), but `closeIssueOnMerge` calls `sdk.lanes.listSessionIssues(laneId)` directly at `:391`, and `sessionIssues` is neither called nor exported (`:575-586`). Behaviour is fine — on an old host the direct call throws a `TypeError` the surrounding catch converts to a warn (`:392-394`) — but the docstring describes a function nothing uses. Route `:391` through it, or delete it. **Auto-applyable.**

---

## Checked and found clean

**Security core**

- **Official-client broker** (`pluginOfficialClients.ts`). Resolves from a compile-time constant plus an env override read at call time; never touches the credential store. `PluginOfficialOAuthClient` has no secret field (structural absence). `assertNoClientSecret` re-checks every key on the way out for `secret`/`password`/`token`. Ownership comes from `builtinSurfaceOwnerForPlugin` and never from anything the plugin says about itself. One `not_permitted` code for both non-owner and unknown provider, so a plugin cannot enumerate which providers ADE has apps for. `pluginHostService.ts:1376` closes over the supervisor's `pluginId`, so the check runs against a host-derived identity, matching `requestCredentialHandoff`.
- **Credential handoff withholds the client secret.** `pluginCredentialHandoff.ts:118-161` copies exactly `LINEAR_ACCESS_TOKEN`, `LINEAR_REFRESH_TOKEN`, `LINEAR_TOKEN_EXPIRES_AT`, `LINEAR_AUTH_MODE`, `LINEAR_OAUTH_CLIENT_ID`; the `clientSecret` sibling in the same stored object is explicitly excluded with the reason stated in the card copy ("ADE's own OAuth client secret, which is ADE's identity to Linear rather than yours").
- **Webhook verification is fail-closed.** `pluginWebhookIngressService.ts:435-460` returns false on a missing secret, a missing header, an empty signature; `verifyPluginWebhookSignature` (`:242-258`) returns false on non-hex and on a length mismatch, and compares with `timingSafeEqual`. Verification runs against the FULL stored body (`:496`) before the 64 KiB clamp (`:505`), so the HMAC domain is right. The relay stores the exact raw decoded body (`relay.ts:3509, 3552`) rather than a re-serialization, so the plugin's HMAC matches what Linear signed. `linear-signature` was correctly added to `PLUGIN_WEBHOOK_STORED_HEADERS` (`relay.ts:271`) with an accurate justification.
- **PKCE.** 32-byte verifier from `crypto.randomBytes`, S256, base64url unpadded; held in memory only, never stored; one live attempt, cleared on `complete`/`cancel`; a late callback from a superseded flow is dropped by the `attempt` check (`connect.js:326`).
- **Secrets never leave the secret store.** No token, refresh token, expiry-derived material or client secret reaches a collection, `sdk.memory`, or a log line. `data.refreshConnection` writes only `refreshTokenStored: Boolean(...)` into the synced `viewer` row; `linearApi.js:300` logs "Refreshed the Linear access token." with no value; `disconnect()` deletes all four credential secrets (`connect.js:445-448`).
- **`ade:` prefix.** No id in `contract.js`'s `ACTIONS` table or in `plugin.json` uses the reserved prefix (`PLUGIN_RESERVED_ACTION_PREFIX`, `sdk.ts:574`).
- **Env injection.** `ADE_PLUGIN_LINEAR_ISSUE_IDS` / `_UUIDS` (`flows.js:83-84`) match the static `ADE_PLUGIN_` prefix pattern, so host-variable shadowing is impossible by construction; the plugin never writes `ADE_PLUGIN_SOURCE_ID`, which the host stamps.
- **Network hosts.** `plugin.json` declares only `api.linear.app`; both the GraphQL endpoint and the token endpoint live there (`linearApi.js:30-31`). The authorize URL (`linear.app`) is opened by the host, not fetched by the plugin.
- **Untrusted Linear text into links.** No URL from Linear becomes a link target unvalidated: prose goes to `markdown`, whose links pass `httpsUrl` (`vocabularyMarkdown.ts:284`, `parse.ts:63-73`) — `javascript:`, `data:`, `file:` and hostless `https:javascript:` all lose the link and keep the words. `openInLinear` returns `{openUrl}`, gated by the same check on the host. `organizationLogoUrl` → `image src` is scheme-gated on desktop and iOS.

**The supersedes flip**

- **Dispatch stays open for all 30 `linear_*` verbs.** `builtinSurfaces.ts:171-183` gives `linear` `actionDomains: []` and `actionNames: LINEAR_ACTION_NAMES`. I diffed those 30 names against `apps/desktop/src/main/services/adeActions/registry.ts:805-838` — an exact match across `linear_credentials` (6), `linear_oauth` (2) and `linear_issue_tracker` (22). `resolveDisabledActionDomains` (`gatedActionDomains.ts:69-80`) iterates only `gatedBuiltinActionDomains()`, which excludes `linear`, so no verb is refused at dispatch.
- **Advertisement is withheld in all three catalogs.** `registerIpc.ts:6244` (desktop automation picker), `adeRpcServer.ts:3898` (RPC), `bootstrap.ts:3030` (daemon automation editor, read fresh rather than memoized). The CLI memo is invalidated together with the domain memo (`adeRpcServer.ts:1411-1414`) and subscribed to plugin install/status changes (`:1430-1432`).
- **`buildMissingSurfaceDenial` asks `builtinSurfaceDrawn`, not `Installed`** (`gatedActionDomains.ts:304`), and its superseded branch inverts the copy rather than telling the user to install what is already there (`:305-314`). A cold catalog degrades the message but never turns into a pass (`:315-322`).
- **Polarity across the renderer.** `isBuiltinSurfaceVisible` (`builtinTabs.ts:104-121`) and `builtinSurfaceDrawn` (`builtinSurfaces.ts:278-284`) are the only two implementations and both invert correctly. Every renderer site routes through `useBuiltinSurfaceVisible` (`useBuiltinTabs.ts:40-43`), so the `PLUGIN_BUILTIN_SURFACE_PRESENCE` flip propagated without any site needing a sense change; all `linearSurfaceVisible` uses are positive-sense. Unresolved registry → `!(resolved && installed)` → **shows**, so nothing hides ADE's compiled Linear UI before the registry resolves.
- **`claimedBuiltinGate` returns null for a superseded surface** (`builtinTabs.ts:73`), so `ade-linear` keeps its own rail item rather than being suppressed in favour of a compiled page it replaces.
- **Missed-site sweep.** The subagent swept all 117 renderer files matching `linear`; every compiled Linear entry point reaches a gate — the pane modals via gated hosts, the badge self-gates so `LaneGitActionsPane`, `LanesPage` and `LaneNode` inherit it, every `settingsRouteFor("integrations.linear")` navigation is inside a gated component, and `buildLaneMenuGroups` takes `linearSurfaceVisible` as a **required** field so a future third caller cannot forget. `chatSources.ts` staying ungated is a documented, correct decision (past turns and external `linear.app` URLs).
- **TUI empty roster.** `builtinCommandAvailable(cmd, [])` → `builtinSurfaceDrawn("linear", [])` → not installed → superseded → available, matching the desktop rule that every unknown shows. `pluginInstallRecords` carries `enabled`, so a disabled `ade-linear` correctly keeps the commands.
- **Settings manifest.** `builtinSurface` gating is asked before the web rules and on desktop too; `sectionWebScope` folds an unavailable entry to `"hidden"`; the Integrations tab survives on GitHub so `availableSettingsTabs()` never drops it; both resolver installers use the identity-checked `clearBuiltinSurfaceResolver`; the no-resolver fallback `builtinSurfaceDrawn(builtinId, [])` lands on the correct side for both polarities; `builtinGateInput` was added to every memo that reads the manifest.

**SDK contract**

- **Additive only.** `auth.officialClient`, `lanes.listSessionIssues`, `PluginPrTransition`, `PluginPrEventState`, `PluginSessionIssues`, `transitions?` on `PluginEventPayload`, `authSessions[].clientId` are all new optional/additive shapes. No method removed or re-signatured, no vocabulary component or socket kind removed — so `PLUGIN_SDK_VERSION = 0` and `VOCAB_VERSION = 1` correctly stay put.
- **Both new methods moved together** across shared type → `pluginSdkServer` case → `pluginChildBootstrap` client → `pluginHostService` supplier. `PluginSdkMethod` gained both names.
- **`toPluginIssueLink`** is a field allowlist typed `as const satisfies readonly (keyof IssueLink)[]`, so a field added to `IssueLink` later cannot reach a plugin by omission; `toPluginLaneSummary` now projects through it so the lane surface has one rule.
- **`lanes.listSessionIssues` grouping** drops lane-scoped rows (no `sessionId`) so the two verbs do not overlap, preserves insertion order, and projects each link before it crosses the boundary.
- **`transitions` coalescing.** First-seen `from` and latest `to` (`pluginHostService.ts:2467-2483`); every transition id is re-checked against `queue.ids` in the host, so the producer's contract is enforced rather than trusted; dropped WHOLE on overflow rather than truncated alongside `ids`. `prTransitionsFromChanges` drops a change with no `previousState` rather than inventing a `from`.
- **`flows.mergedLanesFromPrIds`** (`flows.js:467-500`) reads `payload.transitions` defensively, applies exactly core's test (`from.merged === true → skip`, `to.merged !== true → skip`, matching `main.ts:3841`), handles an absent list by falling back to a per-id re-read gated on `onlyWhenMerged`, and the `decided` set correctly prevents a transition-covered id from being re-read.
- **`closeOnMerge` union.** `flows.js:377-399` unions `lane.primaryIssue` (unconditional — matches `main.ts:3853`), lane `issueLinks` gated on `closeOnMerge` (`main.ts:3855`), and session links from `listSessionIssues` gated the same way (`main.ts:3857-3858`), deduped by `issueId`. The session read is in its own try so a failure does not lose the lane half. The `movedDone` latch is released on failure so a permanent error retries rather than latching forever.

**Manifest and URL matchers**

- **The `linear.app` relaxation is narrow.** Only an EXACT host is relaxed; a wildcard stays refused for everyone including the owner (`urlMatchers.ts:378-388`). `manifest.ts:2337-2346` passes `claimedBuiltins` only from honoured `surfaces[].builtin` ids plus, for an `official` manifest, `coreSmartLinkBuiltinsOwnedBy(name)` — so a community plugin cannot reach the door at all, and an official one must also be the registered owner id. `github.com` is deliberately absent from `CORE_SMART_LINK_HOST_BUILTINS`. `official` remains a self-declared floor with provenance established by the installer's per-version sha256, which is the pre-existing design and unchanged here.
- **`clientId` parsing.** Optional; a present-but-empty, over-long or whitespace-containing value is a DROP rather than a silent omission, with the reason stated. `PLUGIN_AUTH_CLIENT_ID_MAX = 256`.
- **A superseded surface may not name `builtin`.** `parseSurfaces` warns and ignores (`manifest.ts:1075-1080`), and `ade-linear`'s manifest correctly declares a `tab` with no `builtin`, so the `pane`-with-no-builtin drop at `:1099-1104` is not reached.

**Data, sync and platform**

- **Key spaces.** `issue:` / `flat:<rank6>:<id>` / `group:<stateId>:<rank6>:<id>` each carry a literal discriminating prefix at offset 0, so a Linear-supplied id containing `:` or `/` (both permitted by `PLUGIN_COLLECTION_KEY_PATTERN`) can extend a key but cannot relocate it into another space. `rankSegment` is zero-padded to 6 and clamped. `comments`, `teams`, `states`, `projects`, `people` and `viewer` are separate collections.
- **CRR / SQL shapes.** No new plugin table, no new column, no new sibling table, no new unique index. `linkIssueRef` writes into the same tables the built-in Linear writers use, with the ref riding inside `issue_json` under `__issueRef` beside a full legacy Linear projection, so an older peer still parses and renders the row. `listIssueLinksForLaneSessions` is a read-only addition that degrades a missing `session_github_issues` table to "no GitHub session links" rather than failing the whole read.
- **`this` binding.** `listIssueLinksForLaneSessions` calls `this.listLinearIssuesForLaneSessions`, and the host supplier invokes it as a method on the lane service object (`pluginHostService.ts:1492-1493`), so the binding holds.
- **Vocabulary coverage across clients.** Every component the panels emit — `stack`, `group`, `text`, `markdown`, `badge`, `button`, `list`, `form`, `image`, `divider`, `keyValue`, `segmented`, `emptyState` — is in the desktop `NODE_PARSERS`, in the iOS renderable set (`PluginVocabularyView.swift:32-60`), and in the TUI (`pluginPane.ts:882-1293`). Nothing collapses to nothing on any client; `image` degrades to a labelled placeholder in the TUI, which is the intended degradation. All 20 icon tokens resolve in the iOS table.
- **Other panel budgets.** The issue detail panel stays well inside 200 nodes (~54 worst case) and measures bytes incrementally before each comment; `filterStrip` slices to `MAX_FILTER_CONTROLS = 8`, exactly `VOCAB_STATE_LIMITS.maxStateKeys`; `issueWhere` declares exactly `maxWhereClauses = 4`; every literal `segmented` has ≥2 and ≤8 options; row actions slice to 3 and overflow to 2; nesting depth is 2 against `maxDepth: 8`.
- **Per-issue panel state keying.** `issueStateKey` / `issuePriorityKey` change the panel's state signature per issue, and the prefix scan cannot cross-match (`"issuePriority:"` does not start with `"issueState:"`).
- **`linearApi` retry and refresh.** Non-429 4xx is not retried; the 401 path refreshes once outside the retry budget with a `didRefresh` latch so a credential Linear keeps refusing fails on the second answer; `refreshOnce` coalesces concurrent refreshes onto one call so a burst cannot spend the refresh token twice; `invalid_grant` escalates to `unauthorized` rather than retrying; the proactive refresh is deliberately non-fatal.
- **Webhook path.** Ack-last ordering; delivery dedupe through a collection that survives a child restart; re-ack on a duplicate so a lost ack does not make a delivery arrive forever; per-trigger try/catch so one refused trigger costs neither the others nor the ack; `refreshIssue(..., {comments: false})` so a webhook storm does not inflate the comments collection. The `TRIGGER_ID_REMAP` table is exported and performs no rewrite, which is correct — a rule belongs to the user.
- **Event-handler escapes.** All four `sdk.events.on` handlers terminate their promise chains; `deactivate` unsubscribes before nulling the module singletons, so a late delivery cannot hit a null `webhook` / `data`.
- **Action-name coverage.** Every `tools[].action`, `automationSteps[].action`, `searchProviders[].action`, `panels[].refreshAction`, `sockets[].actionId`, `sockets[].menu[].actionId`, `keybindings[].action` and the `cli` word resolves to a registered handler; the two ids defined by both halves (`openIssue`, `openInLinear`) are correctly won by `ownActions` via the re-apply at `index.js:774`.
- **Loopback ports do not collide.** Built-in 19836, plugin 19837 — deliberately distinct (H3 is the separate registration concern, not a collision).
- **iOS `@EnvironmentObject`.** `CtoSettingsScreen` has exactly one construction site (`CtoRootScreen.swift:43`), which injects `.environmentObject(syncService.pluginPresenceGate)` at `:49`; `ADEApp.swift:37` also injects the gate at the root. No previews, no second call site, no crash path.
- **iOS gate mechanics.** No deadlock: `refresh()` collapses concurrent callers via `inFlight` keyed by trigger, a trigger change mid-flight creates a new task and the stale `apply` is dropped by the trigger guard, and `sendDecodableCommand` is timeout-bounded. A failed fetch leaves `answered: false` so the next one-shot retries. `awaitOwner(of:)` was fully removed with no stale callers. (H9 is the capability-readiness path, which is separate from these mechanics.)
- **Windows in the plugin package.** No `path`, `process.platform`, `spawn`/`exec`, or hand-rolled separator in any of the ten plugin modules. `parseGithubRemote` handles both SSH and HTTPS remotes with optional `.git` and is anchored. `panels.js:77` uses `path.join(__dirname, "panels", "main.json")`. `sanitizeBranchName` operates on git ref syntax, `/`-separated on every platform.
- **Node / lockfiles.** No `package.json` touched, so no lockfile drift. The plugin package is dependency-free CommonJS and runs under the repo's Node 22.
- **Test suite health.** 467 tests across the ten plugin test files, all passing locally (H8 is that CI runs only eight of the ten).
- **`registry/seed-entries.json`.** The em-dash → `—` rewrite is JSON-equivalent churn, not a content change. The `ade-linear` version bump to 1.1.0 and description update are consistent with `marketplaceLocalIndex.ts`.
