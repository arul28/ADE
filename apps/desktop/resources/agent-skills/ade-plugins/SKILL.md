---
name: ade-plugins
description: Use this skill to build, extend, debug, or publish an ADE plugin — whenever the task is to add a tab, panel, row badge, toolbar action, row menu item, filter chip, empty state, file viewer, theme, or `ade` CLI command to ADE; to write or fix a `plugin.json` manifest; to author a panel schema in ADE's declarative UI vocabulary; to call the plugin SDK (collections, secrets, contributions, config, actions, panels, events); to run `ade plugin create|install|dev|logs|list`; or to make something a plugin renders show up on desktop, web, iOS, and the `ade code` TUI at once.
---

# Authoring ADE plugins

## The model, in six lines

1. A plugin is a folder with a `plugin.json` at its root. It installs to `~/.ade/plugins/<id>/`.
2. Its code runs **only on the machine that owns it**, in a supervised Node child process. There is no remote execution.
3. Its UI is **data, never code**: a versioned JSON *panel schema* naming components from a fixed set.
4. Desktop, web, iOS, and the TUI each interpret that same JSON with their own native widgets — write once, appear everywhere.
5. Everything a plugin stores goes in one shared table, and the **writer** enforces every budget before a row lands.
6. Any surface that cannot render a panel renders the panel's required `fallback` instead. A panel is never blank.

Corollary you will feel immediately: **anything you want computed, compute in your code and store as data.** The schema has no expressions, no conditionals, no formatting strings, and no callbacks.

## Scaffold and run one

```bash
ade plugin create my-thing --dir ~/plugins   # writes the four starter files
ade plugin install ~/plugins/my-thing        # registers it on this machine
ade plugin dev my-thing                      # watch + reload on every save
```

`create` writes exactly:

| File | What it is |
|---|---|
| `plugin.json` | Manifest — identity, surfaces, panels, sockets, settings, CLI words |
| `index.js` | Entry module (CommonJS, dependency-free). Exports `activate`, `deactivate`, `actions` |
| `panels/main.json` | The panel schema the tab renders |
| `README.md` | Shown on the plugin's Marketplace detail page |

`ade plugin list` and `ade plugin create` work with ADE closed — they read the machine install registry directly. Everything else (`install`, `remove`, `enable`, `disable`, `reload`, `logs`, `dev`) goes through the ADE brain and fails with a clear message if it is not running.

| Command | Does |
|---|---|
| `ade plugin list [--text]` | Installed plugins on this machine, from `~/.ade/plugins/state.json` |
| `ade plugin create <name> [--dir <path>]` | Scaffold a new plugin directory |
| `ade plugin install <source> [--ref <r>] [--no-enable]` | Install from a local path or git URL |
| `ade plugin remove <id>` | Uninstall |
| `ade plugin enable <id>` / `disable <id>` | Turn a plugin on or off |
| `ade plugin reload <id>` | Re-read the manifest and restart the child |
| `ade plugin logs <id> [--limit <n>]` | Recent log lines from the plugin's ring buffer |
| `ade plugin dev [<id>\|<path>]` | Watch a directory; reload on every save |

JSON is the default output; pass `--text` for human-readable. `ade plugin dev` survives ADE being closed: it says so once, keeps watching, and reloads when the brain returns.

Once installed and enabled, a plugin that declares `cli` words is reachable as `ade <pluginId> <word> [args]` — the CLI routes it to the plugin's own action.

## `plugin.json` reference

Parsing is **strict on keys it knows, tolerant of keys it does not**: an unknown field is dropped so a manifest written for a newer ADE still loads on an older one, but a known field with the wrong shape is an error. A single bad `sockets` entry is dropped with a warning; the plugin still installs.

```json
{
  "name": "graph",
  "version": "1.2.0",
  "displayName": "Graph",
  "description": "Workspace graph as an ADE tab.",
  "icon": "graph",
  "accent": "#7C6FF0",
  "minAdeVersion": "1.3.0",
  "vocabVersion": 1,
  "entry": "index.js",
  "surfaces": [{ "kind": "tab", "id": "graph", "title": "Graph", "panelId": "main" }],
  "panels":   [{ "id": "main", "schemaFile": "panels/main.json", "title": "Graph" }],
  "sockets":  [{ "socket": "file-viewer", "surface": "files", "id": "video",
                 "extensions": [".mp4", ".mov"], "panelId": "player" }],
  "collections": { "issues": { "sync": true } },
  "settings": [{ "key": "defaultLane", "kind": "select", "label": "Default lane",
                 "optionsAction": "listLanes" }],
  "cli": ["issues", "open"],
  "skills": ["skills/using-graph"],
  "theme": { "tokens": { "dark": { "--color-accent": "#7C6FF0" }, "light": {} } },
  "official": false
}
```

| Field | Required | Rules |
|---|---|---|
| `name` | yes | The plugin id. `^[a-z][a-z0-9-]{0,63}$`. It is a directory name, a secret namespace, a sync primary key, and a CLI word — uppercase is refused, not folded |
| `version` | yes | `major.minor.patch`, optional `-pre`/`+build` tail |
| `displayName` | no | Defaults to `name` |
| `description` | no | Defaults to `""` |
| `icon` / `accent` | no | `accent` is a 3- or 6-digit hex color |
| `minAdeVersion` | no | Floor. An ADE below it will not load the plugin; an unknown host version never locks the user out |
| `vocabVersion` | no | Panel-schema vocabulary version. Positive integer, defaults to `1` |
| `entry` | no | Relative path to the entry module. **Omit for UI-only plugins** (themes, static panels) — they run no code at all |
| `surfaces[]` | no | `{kind: "tab"\|"pane", id, title, panelId, icon?, order?}` |
| `panels[]` | no | `{id, schemaFile?, title?, icon?}`. `schemaFile` is the default schema; `sdk.panels.update()` replaces it at runtime |
| `sockets[]` | no | See *Sockets* below |
| `collections` | no | `{"<name>": {"sync": true\|false}}`. `sync: true` rides the sync layer to your other devices |
| `settings[]` | no | `{key, kind, label, description?, options?, optionsAction?, default?}`; `kind` ∈ `text`, `secret`, `select`, `toggle`, `number` |
| `cli[]` | no | Subcommand words, `^[a-z][a-z0-9-]{0,31}$`, reachable as `ade <id> <word>` |
| `skills[]` | no | Relative paths to agent-skill directories this plugin contributes; they join `ADE_AGENT_SKILLS_DIRS` |
| `theme` | no | Token sets — see *Themes* |
| `official` | no | **Ignored for trust.** Official status comes from the registry's curated file, never from the manifest |

Every path in a manifest (`entry`, `schemaFile`, `skills[]`) must be relative, inside the plugin directory, and free of `..` — absolute paths and traversal are refused at parse time.

Manifest-level rules the parser enforces (a violation drops that entry, not the plugin):

- `detail-section` and `file-viewer` sockets require `panelId`.
- `toolbar-action` and `row-menu-item` sockets require `actionId`.
- `file-viewer` requires at least one `".ext"` extension.

## Panel schemas — the UI vocabulary

A panel is a JSON document. `v` is the vocabulary version, `fallback` is **required**, `body` is the tree.

```json
{
  "v": 1,
  "title": "Recent issues",
  "fallback": { "title": "Recent issues", "text": "Open ADE to see this panel.",
                "deeplink": "ade://lane/…" },
  "body": [
    { "component": "stack", "direction": "vertical", "gap": "md", "children": [
      { "component": "text", "text": "Open issues", "variant": "title" },
      { "component": "list", "bind": { "collection": "issues", "keyPrefix": "open:", "limit": 20 },
        "emptyText": "Nothing open." },
      { "component": "button", "label": "Refresh", "kind": "primary",
        "onPress": { "action": "refresh" } }
    ]}
  ]
}
```

### Components

| Component | Shape (required fields in bold) |
|---|---|
| `stack` | **`children[]`**, `direction` (`vertical`\|`horizontal`), `gap` (`none`\|`sm`\|`md`\|`lg`), `align`, `wrap` |
| `text` | **`text`**, `variant` (`title`\|`subtitle`\|`body`\|`caption`\|`code`), `tone`. `code` is the only monospace affordance |
| `badge` | **`text`**, `tone`, `icon` |
| `button` | **`label`**, **`onPress`** (a `VocabAction`), `kind` (`primary`\|`default`\|`quiet`), `icon`, `disabled` |
| `list` | **`items[]` or `bind`**, `emptyText`. Item: **`title`**, `subtitle`, `meta`, `tone`, `icon`, `onPress` |
| `table` | **`columns[]`** and **`rows[]` or `bind`**, `emptyText`. Column: **`key`**, **`label`**, `align` |
| `form` | **`fields[]`**, **`submit`** `{label, onPress}`. Field kinds: `text`, `secret`, `select`, `toggle`, `number` |
| `chart` | **`kind`** (`line`\|`bar`), **`series[]`** of `{id, label?, tone?, points:[{x,y}]}`, `title`, `emptyText` |
| `video` | **`src`**, `poster`, `title` |
| `image` | **`src`**, **`alt`**, `maxHeight` |
| `divider` | `label` |
| `keyValue` | **`rows[]` or `bind`**, `emptyText`. Row: **`key`**, `value`, `tone` |
| `emptyState` | **`title`**, `description`, `icon`, `action` `{label, onPress}` |

Tones are `neutral`, `accent`, `success`, `warning`. **There is no red.** Any red-ish value you write (`danger`, `error`, `fail`) folds to `warning` — the house rule cannot be bypassed by a payload.

`bind` reads your own `plugin_collections` rows: `{collection, keyPrefix?, limit?}`. The rows must **already be in render shape** for the component that binds them — a `list` binding reads `{title, subtitle?, …}` values, a `table` binding reads column-keyed records. The renderer does no reshaping.

`onPress` is `{action, args?, confirm?}`. `args` is flat scalars only (nested objects are dropped — that is where "data, never code" would start to leak). `confirm` makes the client ask before dispatching.

### Per-surface support

| Component | Desktop / web | iOS | `ade code` TUI |
|---|---|---|---|
| `stack`, `text`, `badge`, `button`, `list`, `table`, `keyValue`, `divider`, `emptyState` | full | full | full |
| `form` | full | full | full (via the composer prompt line) |
| `video`, `image` | full | full | named placeholder + `Ctrl+Y` to copy the fallback deeplink |
| `chart` | full | named marker | named placeholder |
| anything a later vocabulary version adds | inline "not supported here" marker | marker | placeholder |

Two consequences worth designing around: **put a `deeplink` in every `fallback`** so a surface that cannot draw the body still gets the user somewhere, and **do not make a chart the only content of a panel** — half your surfaces will show a marker where the point of the panel was.

### Degradation ladder

- **Panel-fatal** — bad JSON, unsupported `v`, missing `fallback`, over a size/node/depth ceiling → the client renders the fallback card.
- **Node-local** — a malformed known component or binding → that node becomes an inline error marker, the rest of the panel renders.
- **Unknown component** — a name this build never heard of → a marker naming it. This is the forward-compat path, and a warning rather than an error.

### Vocabulary limits

`maxNodes` 200 · `maxDepth` 8 · `maxSchemaBytes` 65,536 · `maxSelectOptions` 40 · `maxTableRows` 100 · `maxTableColumns` 8 · `maxListItems` 100 · `maxKeyValueRows` 60 · `maxChartSeries` 3 · `maxChartPoints` 200 · `maxFormFields` 24 · `maxTextChars` 4,000 · `maxLabelChars` 200 · `maxValueChars` 1,000.

These are part of the contract, not a client's private defence — a schema over any of them is invalid everywhere, identically.

## Sockets — appearing on core surfaces

Six core surfaces: `work`, `lanes`, `files`, `prs`, `automations`, `cto`. Seven socket kinds. Placement is **host-controlled and always after core content** — a contribution never reorders, replaces, or interleaves with the product's own rows. `order` sorts plugins against each other and nothing more.

| Socket kind | Payload | What it draws |
|---|---|---|
| `toolbar-action` | `{label, actionId, icon?, disabled?}` | A button in a surface's toolbar |
| `row-badge` | `{text, tone, icon?, tooltip?}` | A badge on a row |
| `row-menu-item` | `{label, actionId, icon?, danger?}` | An entry in a row's context menu |
| `detail-section` | `{panelId, title?}` | A panel rendered as a section in a detail view |
| `empty-state` | `{title, body?, actionId?, actionLabel?}` | Extra content on a surface's empty state |
| `filter-chip` | `{label, filterKey, count?}` | A chip in a surface's filter row |
| `file-viewer` | `{panelId, extensions[]}` | A viewer for matching files in the Files tab |

Two sources, deliberately different:

- **Static** contributions come from `manifest.sockets` — "this plugin has a toolbar button here".
- **Dynamic, per-entity** values come from `sdk.contributions.publish(...)` — "PR #1234 gets this badge, right now". The machine that owns the data computes them; other devices read the row.

A payload that fails validation renders nothing at all rather than a half-built row, so a missing `label` or `actionId` shows up as an absence, not as a blank button.

Entity kinds for `publish`: `lane`, `pr`, `session`, `file`, `automation`, `surface`. Row badges cap at **2 visible** per row with the rest behind a "+N"; a single plugin may place at most **8** contributions in one socket slot.

Your action receives a typed, read-only context object — a projection, not a handle:

| Context | Fields |
|---|---|
| `pr` | `number`, `title`, `branch`, `state` (`open`\|`closed`\|`merged`\|`draft`\|`unknown`), `ciStatus` (`passing`\|`failing`\|`pending`\|`none`\|`unknown`) |
| `lane` | `id`, `name`, `branch`, `machineKey`, `dirty` |
| `session` | `id`, `title`, `provider`, `status` |
| `file` | `path`, `size`, `extension`, `workspaceId` |
| `surface` | `surface` (for toolbar actions, empty states, chips — no per-entity subject) |

You cannot reach the lane's worktree, the PR's token, or the session's transcript from a context. Widening one is a platform change, not something a plugin arranges.

### Per-surface socket support

| Socket | Desktop / web | iOS | TUI |
|---|---|---|---|
| `row-badge`, `row-menu-item` | yes | yes | no |
| `toolbar-action`, `detail-section`, `empty-state`, `filter-chip`, `file-viewer` | yes | decoded, not drawn — a later iOS build adds the arm with no wire change | no |

The TUI surfaces plugins through `/plugin-view [plugin]`, which opens a panel in the right pane; it renders no sockets. Design so a badge is an enhancement, never the only way to learn something.

## The SDK your code gets

The entry module is CommonJS and dependency-free — the child bootstrap `require`s it and a plugin may not assume a bundler ran.

```js
exports.activate = async (ade) => { /* ade is the SDK */ };
exports.deactivate = async () => {};
exports.actions = {
  async refresh(args) { return { ok: true }; },
};
```

`ade` is also available as a global inside the child. Everything on it is async and host-mediated: there is no direct database, no ambient filesystem authority, no synchronous escape hatch.

| Call | Contract |
|---|---|
| `ade.actions.invoke(domain, action, args?)` | Invoke an ADE action at **agent** role. CTO-only actions are refused; project-scoped domains need `projectId` in `args` |
| `ade.collections.get(collection, key)` | Read one value |
| `ade.collections.put(collection, key, value)` | Write one value. Budget-checked inside the writer transaction |
| `ade.collections.delete(collection, key)` | Delete one value |
| `ade.collections.list(collection, {keyPrefix?, limit?})` | Rows as `{collection, key, value, updatedAt}` |
| `ade.secrets.get/set/delete(name)` | Machine credential store, namespaced `plugin:<id>:<NAME>`. Never readable by another plugin |
| `ade.contributions.publish(entityKind, entityId, socket, payload)` | Publish or clear (`payload: null`) a dynamic contribution |
| `ade.events.on(event, cb)` | `lane.changed`, `pr.changed`, `session.changed`, `install.changed`. Debounced; returns an unsubscribe function. Payload is `{event, ids[], projectId}` |
| `ade.panels.update(panelId, schema)` | Replace a panel's schema. Refused for a panel the manifest never declared |
| `ade.config.get()` | Current values for `manifest.settings`, defaults applied. `secret` kinds are redacted |
| `ade.log(level, message, fields?)` | `debug`/`info`/`warn`/`error` into the ring buffer `ade plugin logs` reads |
| `ade.pluginId` / `ade.sdkVersion` / `ade.manifest` | Identity, read-only |

`PLUGIN_SDK_VERSION` is **0** and the handshake is additive: methods get added, never removed or re-shaped. Anything that would break a shipped plugin gets a new method name.

Every rejection is a structural error carrying a `code` you can branch on: `plugin_not_found`, `plugin_disabled`, `plugin_no_entry`, `plugin_crashed`, `plugin_timeout`, `invalid_args`, `plugin_budget_exceeded`, `not_permitted`, `unsupported_method`, `internal_error`. A budget refusal additionally carries `detail: {budget, limit, actual}` — enough to tell the user exactly which ceiling they hit.

Naming rules the SDK enforces: collection names `^[A-Za-z][A-Za-z0-9._-]{0,63}$`, keys `^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$`, secret names `^[A-Za-z][A-Za-z0-9_.-]{0,127}$`.

## Budgets

Writer-enforced, inside the transaction. These are not advice — a write past a ceiling is refused with `plugin_budget_exceeded`, never silently truncated.

| Budget | Limit |
|---|---|
| Collection bytes per plugin per machine | 2 MiB |
| Collection rows per plugin | 4,000 |
| One collection value | 64 KiB |
| Contribution rows per plugin | 2,000 |
| One contribution payload | 4 KiB |
| Panels per plugin | 32 |
| One panel schema | 64 KiB |
| Log ring | 500 lines, 2,000 bytes each |

Contributions are glances, not pages: 4 KiB is room for a badge and a tooltip, and that is the intent.

## Recipes

### A dashboard tab backed by an API

Manifest: one `tab` surface, one panel, one collection, one `secret` setting for the token.

```js
exports.activate = async (ade) => {
  const refresh = async () => {
    const token = await ade.secrets.get("API_TOKEN");
    const rows = await fetchIssues(token);              // your own code
    for (const row of rows) {
      // Materialize in RENDER shape — a `list` binding reads exactly these keys.
      await ade.collections.put("issues", `open:${row.id}`, {
        title: row.title, subtitle: row.repo, meta: row.age, tone: row.stale ? "warning" : "neutral",
      });
    }
  };
  await refresh();
  ade.events.on("pr.changed", () => void refresh());
};
exports.actions = { refresh: async () => ({ ok: true }) };
```

Panel: a `list` with `{"bind": {"collection": "issues", "keyPrefix": "open:"}}` and a `button` whose `onPress.action` is `refresh`.

### Row badges from CI

Declare `{"socket": "row-badge", "surface": "prs", "id": "ci"}`, then publish per PR from the machine that owns the data:

```js
ade.events.on("pr.changed", async ({ ids }) => {
  for (const number of ids) {
    const status = await checkCi(number);
    await ade.contributions.publish("pr", number, "row-badge",
      status ? { text: status, tone: status === "green" ? "success" : "warning" } : null);
  }
});
```

Publishing `null` clears the badge — do that rather than leaving a stale one, and remember badges cap at 2 visible per row.

### A file viewer

```json
{ "socket": "file-viewer", "surface": "files", "id": "video",
  "extensions": [".mp4", ".mov"], "panelId": "player" }
```

The `player` panel uses `video` with a `src` your code fills in via `sdk.panels.update` when a file is opened. Extensions are lowercase and include the dot.

### A theme

Themes are UI-only — **omit `entry` entirely** and ship no code.

```json
{ "theme": { "tokens": {
  "dark":  { "--color-accent": "#7C6FF0", "--shell-bg": "#0B0B0F" },
  "light": { "--color-accent": "#5B4FD6" } } } }
```

Only these token namespaces are accepted; anything else is dropped with a warning: `--color-*`, `--shell-*`, `--chat-*`, `--work-*`, `--pane-*`, `--pr-*`, `--gradient-*`. The user previews a theme and presses Esc to revert, or applies it to persist. Coverage is token-backed surfaces; iOS applies the accent only.

### A CLI command

Add the word to `cli`, add a handler of the same name to `exports.actions`, and it is reachable as `ade <pluginId> <word>`. The plugin receives the raw `argv`, so it owns its own usage text.

### Contributing an agent skill

Put a `SKILL.md` under `skills/<name>/` with `name` + `description` frontmatter and list the directory in `manifest.skills`. Installed plugin skill roots are appended to `ADE_AGENT_SKILLS_DIRS`, so every runtime that reads extra skill roots picks it up.

## Hard rules

1. **Data, never code.** No expressions, no conditionals, no formatting strings, no callbacks in a schema. Compute on your machine, store the result.
2. **Every panel declares `fallback` with a `title` and `text`.** A panel without one is fatal on every client. Add a `deeplink` too.
3. **Secrets go through `ade.secrets`, never through the environment.** The child's env is denylisted, and a secret in a collection value is a secret in the sync layer.
4. **Never assume a socket renders.** iOS draws two of the seven kinds today, and the TUI draws none. A contribution is an enhancement; the panel and the fallback are the floor.
5. **The `plugin_*` SQL shapes are frozen.** A plugin never gets its own table or its own column on an ADE entity — collections and contributions are the two storage shapes there are.
6. **Budgets are refusals, not warnings.** Handle `plugin_budget_exceeded` and prune your own data.
7. **`"official": true` in your manifest means nothing.** Official is a statement the registry makes about a plugin, never one the plugin makes about itself.
8. **Bump `version` on every published change.** The install registry, the checksum table, and the update path all key off it.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Plugin shows as `crashed` | The child exited. `ade plugin logs <id> --text` — the crash line carries the exit status and the tail of stderr. It restarts automatically with backoff `min(30s, 1s × 2ⁿ)`; a child that stays up 60s resets the counter |
| Status stuck at `starting` | The child never sent `ready` within 20s. Usually a top-level throw in the entry module or a `require` of something not installed — check the logs |
| An action hangs then fails | `plugin_timeout`: one `invoke` round-trip is capped at 60s. Do slow work in `activate` or an event handler and store the result |
| A write fails with `plugin_budget_exceeded` | Read `detail.budget`, `detail.limit`, `detail.actual`. Prune with `ade.collections.delete`, or store less per row |
| Panel renders as a fallback card | Panel-fatal: bad JSON, `v` mismatch, missing `fallback`, or over 200 nodes / depth 8 / 64 KiB. Compare against the limits above |
| One component shows a marker, rest renders fine | Node-local. Either the component is malformed, or that surface does not draw it (see the support matrix) |
| Panel renders on desktop, marker on iOS or the TUI | Expected for `chart`, and for `video`/`image` in the TUI. Not a bug — give the panel something else to say |
| Contribution never appears | Check `manifest.sockets` declares the kind on that surface, the payload validates for that kind, and you published from the machine that owns the entity |
| `ade plugin <cmd>` says it needs the brain | `install`/`remove`/`enable`/`disable`/`reload`/`logs`/`dev` are daemon-backed. Start ADE or run `ade brain start`. `list` and `create` never need it |
| `ade <pluginId> <word>` says unknown command | The plugin must be installed, **enabled**, and declare that exact word in `cli` — otherwise the CLI treats it as a typo, which is what you want |
| A directory in `~/.ade/plugins/` is ignored | `state.json` is the only source of truth for "installed". A stray clone is a leftover, not a plugin. Install it properly |
| Plugin missing on another device | Installs are per-machine. Missing plugins hide silently rather than showing broken rows; install it there or use the Marketplace's machine coverage matrix |

## Publishing

1. Push a public repository with a valid `plugin.json` at its root.
2. Add the `ade-plugin` GitHub topic.

That is the whole process — no submission, no review queue, no account. A crawler picks up the topic and the plugin appears in the Marketplace. Being listed is not an endorsement; community entries show their author and carry no Official mark.

Users can also install straight from a git URL or a local path, from the Marketplace's install dialog or with `ade plugin install`.
