---
name: ade-plugins
description: Use this skill to build, extend, debug, or publish an ADE plugin — whenever the task is to add a tab, panel, row badge, toolbar action, row menu item, filter chip, empty state, file viewer, theme, or `ade` CLI command to ADE; to write or fix a `plugin.json` manifest; to author a panel schema in ADE's declarative UI vocabulary; to build a desktop-only custom UI page (a `webview` surface) against the `window.adePlugin` bridge; to link to a plugin panel or hand it a context; to call the plugin SDK (collections, secrets, contributions, config, actions, panels, events); to run `ade plugin create|install|dev|logs|list`; or to make something a plugin renders show up on desktop, web, iOS, and the `ade code` TUI at once.
---

# Authoring ADE plugins

## The model, in seven lines

1. A plugin is a folder with a `plugin.json` at its root. It installs to `~/.ade/plugins/<id>/`.
2. Its code runs **only on the machine that owns it**, in a supervised Node child process. There is no remote execution.
3. Its UI is **data, never code**: a versioned JSON *panel schema* naming components from a fixed set.
4. Desktop, web, iOS, and the TUI each interpret that same JSON with their own native widgets — write once, appear everywhere.
5. Everything a plugin stores goes in one shared table, and the **writer** enforces every budget before a row lands.
6. Any surface that cannot render a panel renders the panel's required `fallback` instead. A panel is never blank.
7. One exception to line 3: a `webview` surface draws the plugin's own HTML page, on the desktop and nowhere else. It still names a panel the other surfaces show in its place — see *Custom UI*.

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
| `surfaces[]` | no | `{kind: "tab"\|"pane"\|"webview", id, title, panelId, icon?, order?}`. `panelId` is required on all three kinds. A `webview` also needs `entryHtml` — see *Custom UI* |
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
- A `webview` surface requires `entryHtml`, and it must name an `.html` (or `.htm`) file inside the plugin. A `webview` with no page is dropped, not warned about. `entryHtml` on any other kind is ignored.

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
| `video`, `image` | full | full | named placeholder; `Ctrl+Y` copies a link to the panel |
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

### Context, navigation, and links to a panel

A panel can arrive carrying a small object — the *context*. It gets there two ways: a `plugin` deeplink's `?ctx=`, or an action that asked the client to go there. Two things then read it:

- **The schema**, through the reserved binding `{"collection": "$context"}` — one row per top-level key, in declaration order. A real collection can never be called `$context`, so nothing shadows it. This is the only way to put a value the panel was opened with into the panel's own text, and it is a binding rather than an expression on purpose.
- **Every action that panel dispatches**, which carries the same object along.

An action asks for navigation by returning it:

```js
exports.actions = {
  async file(args) {
    const id = await createIssue(args);
    return { navigate: { panelId: "detail", context: { issue: id } } };
  },
};
```

`panelId` must be a panel of the same plugin — anything else is ignored, and a return value with no `navigate` key behaves exactly as before. The context is capped at **2 KiB**; over the cap the navigation still happens and the context is dropped, so keep it a pointer ("the issue is ISS-14") and read the rest from your own collections.

The same destination has a link:

```bash
ade link plugin graph detail --ctx '{"issue":"ISS-14"}' --ade
# ade://plugin/graph/detail?ctx=…   (drop --ade for the https://ade-app.dev/open form)
```

The link opens the panel on a machine where the plugin is installed and enabled, and says so plainly on one where it is not — plugins are per-machine, so a link one person mints is routinely a link another cannot open. A malformed or oversized `ctx` on the way in is dropped and the panel still opens; `--ctx` on the way out refuses rather than minting a link quietly missing what you asked for. In the TUI, `Ctrl+Y` copies a link to the panel you have open.

## Custom UI (webview)

A `webview` surface renders the plugin's **own HTML page** instead of a panel schema. It is the one place a plugin ships UI code, and the price is fixed: the page draws on the desktop and nowhere else. iOS, the web client, and the TUI render the surface's `panelId` panel in its place — which is why `panelId` is required on a webview surface rather than optional.

### When to choose it — and when not to

The vocabulary's ceiling is the thirteen components above, arranged in stacks. Rows, tables, key/value pairs, forms, a line or bar chart, an image, a video. No expressions, no conditionals, no custom layout, no pointer events of your own, no canvas, no drag.

Choose a webview when what you need to draw is genuinely past that line — a graph someone pans, a diagram editor, a timeline with blocks people drag. Do not choose it to skip learning the vocabulary: everything you build in a page is invisible on three of ADE's four clients, and you will have written the panel anyway.

A rule of thumb that decides most cases: **if it is rows of things with buttons on them, it is a panel; if it is a drawing surface, it is a page.**

### Scaffold

`ade plugin create` scaffolds a tab, so add the surface by hand:

```json
{
  "surfaces": [{ "kind": "webview", "id": "board", "title": "Board",
                 "entryHtml": "web/index.html", "panelId": "board" }],
  "panels":   [{ "id": "board", "schemaFile": "panels/board.json", "title": "Board" }]
}
```

`entryHtml` is a relative path inside the plugin, free of `..`, ending in `.html` (or `.htm`). The page and everything it loads are served from `ade-plugin://<pluginId>/…`, which maps to the install directory and nothing above it. A request ending in `/` resolves to `index.html`; a directory itself is a 404, never a listing.

`web/index.html` — note there is no inline `<script>`, because there cannot be one:

```html
<!doctype html>
<meta charset="utf-8" />
<title>Board</title>
<link rel="stylesheet" href="./board.css" />
<div id="root">Loading…</div>
<script src="./board.js"></script>
```

`web/board.js`:

```js
const root = document.getElementById("root");

async function render() {
  const rows = await window.adePlugin.collections.list("cards", { limit: 100 });
  root.textContent = `${rows.length} cards`;
}

window.adePlugin.events.on("changed", () => void render());
void render();
```

Ship plain `.js` and `.css`. Content types come from a closed map — `.js`, `.mjs`, `.css`, `.json`, `.svg`, the usual images and fonts, `.mp4`, `.webm`, `.txt` — and anything else is served as `application/octet-stream` with `nosniff`, so a `.ts` or `.jsx` file will not execute.

### The bridge

`window.adePlugin` is the whole API. Every method is async and rejects with an ordinary `Error` carrying the host's own message; there is no error class to catch, so the code rides in the text.

| Call | Contract |
|---|---|
| `adePlugin.version` | Bridge version of the host that attached the page. **1** today. Additive like the SDK — check it before calling anything newer |
| `adePlugin.pluginId` | The page's own plugin id, from the host. Informational; nothing on the wire carries it |
| `collections.get(collection, key)` | One value, or `null` |
| `collections.put(collection, key, value)` | Write one value — see the note below before relying on it |
| `collections.list(collection, {keyPrefix?, limit?})` | `{key, value}` rows, at most 500 |
| `invoke(action, args?)` | Call one of the plugin's own action handlers. Needs an `entry` — a page-only plugin has nothing to invoke |
| `config.get()` | Current values for `manifest.settings`, defaults applied |
| `events.on("changed", cb)` | Fires when this plugin's data moves. Returns an unsubscribe function; payload is `{kind, panelId?, collection?}`. Refetch on a `kind` you do not recognize |
| `openDeeplink(url)` | An `ade://` link opens in ADE; an `https:` link goes to the user's real browser. Nothing else is accepted |

The plugin id is never sent by the page: the host derives it from the guest's own origin and answers every call against that. Collections still have to be declared in `plugin.json` — an undeclared name is refused, not created.

Deliberately missing, and not stubbed:

| Absent | Why |
|---|---|
| `secrets` | A page is the last place a plugin's credentials should be readable, and the first place an injected script would look. Read secrets in your child process and hand the page the *result* |
| `contributions.publish`, `panels.update` | A page draws itself. Publishing into ADE's other surfaces stays the child process's job |
| `collections.delete` | Destructive, and not needed to build a UI |
| Raw IPC, `require`, `window.ade` | There is no such object in the page |

**Writing from a page is conditional.** `collections.put` needs the plugin host in the same process, and on the desktop app the host lives in the daemon — so a page's write is refused with `plugins_unavailable` ("This page can't save data on this computer.") while reads and `invoke` route through to the project's runtime and work normally. Write through your own handler instead: `await adePlugin.invoke("save", {…})`, and let the child call `ade.collections.put`.

### The sandbox, plainly

- The page gets **its own origin**, `ade-plugin://<pluginId>`, one per plugin, so the browser's same-origin rules do the isolating.
- **Only files inside the plugin's install directory are served.** A path that escapes it — `..`, an absolute path, a symlink pointing out — is refused. An uninstalled or disabled plugin has no origin at all, so disabling a plugin closes its pages.
- **No Node, no `require`, no `window.ade`, no raw IPC.**
- **Scripts and styles must ship with the plugin** (`script-src 'self'`). No CDN, no inline `<script>`, no `onclick=` attributes, no `eval`. A library you want, you vendor. Inline `style=` and `<style>` are fine.
- **Images and media may come from `https:`**, and the page may call `https:` services. Plain `http:` cannot be fetched.
- **The session is per-plugin and throwaway.** Cookies, `localStorage`, and caches die with the window. Put state in collections, where it is budgeted and the user can see it in the usage meter.
- **The page cannot leave its own origin.** A link to a site opens in the user's real browser; a new window is denied; forms cannot post anywhere; the page cannot be framed.

### The dev loop

```bash
ade plugin install ~/plugins/board   # once
ade plugin dev board                 # watch + reload on every save
```

`ade plugin dev` reloads the plugin on every save — it re-reads the manifest and restarts the child. Page files are read off disk when the guest asks for them, so re-opening the surface picks up your edits. `ade plugin logs board --text` is still where the child's log lines are; `ade.log` from the child, not `console.log` from the page, is what lands there.

### How it sits next to panels

- Write the surface's panel as the honest small version of the page, and give its `fallback` a `deeplink` — that panel is what three of four clients show.
- `$context` and `{navigate:{…}}` belong to panels; a page navigates itself. To send the user to one of your panels from a page, call `adePlugin.openDeeplink("ade://plugin/<pluginId>/<panelId>?ctx=…")`.

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
| `ade.events.on(event, cb)` | `lane.changed`, `pr.changed`, `session.changed`, `install.changed`. Debounced; returns an unsubscribe function. Payload is `{event, ids[], projectId, overflow?}` — `overflow: true` means `ids` was truncated at the delivery cap; treat it as a bare refetch signal rather than trusting the partial list |
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

Put a `SKILL.md` under `skills/<name>/` with `name` + `description` frontmatter and list the CONTAINING directory in `manifest.skills` — `"skills": ["skills"]` resolves to `<plugin>/skills/<name>/SKILL.md`. Installed plugin skill roots are appended to `ADE_AGENT_SKILLS_DIRS`, passed to Codex as `skills/extraRoots`, handed to Claude as a plugin root (ship a `.claude-plugin/plugin.json` marker in the containing directory — Claude reads plugin roots, never the env var), and listed by `ade skill list`. A skill inside a plugin loads only where that plugin is installed and enabled, which is why ADE's own `ade-linear`, `ade-ios-simulator` and `ade-app-control` skills live in their packages rather than in the shared bundled root.

## What a plugin gates

A plugin is a whole vertical: its surfaces, its agent tooling and its skills arrive and leave together.

- **Surfaces** vanish from the rail, the palette, deeplinks and restored routes. Hidden is the default, not a fallback — a surface appears only on three positive facts (this host publishes plugins, the registry has resolved, the owner is installed and enabled).
- **Action domains** the plugin owns are refused at dispatch with `policyDenied` and `data.kind = "plugin_not_installed"`, never `methodNotFound`. The message names the fix and its wording comes from the plugin catalog, so a plugin ADE cannot name produces a plain error and no advice.
- **Skills** stop loading, on every runtime, because the root itself is gone.
- **Connections** the plugin held are deleted on uninstall. Removing `ade-linear` clears the stored Linear token; the confirm dialog says so first.

This gates ADE's premium layer for a capability, not the capability. An agent on a machine with no plugins still has `xcrun simctl`, the Linear REST API, AppleScript and CDP. What it loses is the typed action surface, the proof capture, and the lane and chat context ADE wraps around them — so when a domain refuses, say what is missing and reach for the raw tool rather than reporting the task impossible.

## Hard rules

1. **Data, never code.** No expressions, no conditionals, no formatting strings, no callbacks in a schema. Compute on your machine, store the result. A `webview` is the one exception, and it buys unlimited UI by giving up three of the four clients.
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
| Plugin shows as `crashed` | The child exited. `ade plugin logs <id> --text` — the crash line carries the exit status and the tail of stderr. It restarts automatically with backoff `min(30s, 1s × 2ⁿ)`; a child that stays up 60s resets the counter. After 5 fast failures in a row the host stops reviving it and the status stays `crashed` — `ade plugin reload <id>` (or the Restart button) clears the counter and tries again |
| Status stuck at `starting` | The child never sent `ready` within 20s. Usually a top-level throw in the entry module or a `require` of something not installed — check the logs |
| An action hangs then fails | `plugin_timeout`: one `invoke` round-trip is capped at 60s. Do slow work in `activate` or an event handler and store the result |
| A write fails with `plugin_budget_exceeded` | Read `detail.budget`, `detail.limit`, `detail.actual`. Prune with `ade.collections.delete`, or store less per row |
| Panel renders as a fallback card | Panel-fatal: bad JSON, `v` mismatch, missing `fallback`, or over 200 nodes / depth 8 / 64 KiB. Compare against the limits above |
| One component shows a marker, rest renders fine | Node-local. Either the component is malformed, or that surface does not draw it (see the support matrix) |
| Panel renders on desktop, marker on iOS or the TUI | Expected for `chart`, and for `video`/`image` in the TUI. Not a bug — give the panel something else to say |
| A webview page loads but stays blank | Almost always the CSP: `script-src 'self'` blocks inline `<script>`, `onclick=` attributes, `eval`, and anything from a CDN. Move the code into a `.js` file next to the page and load it with `src` |
| A file in the page 404s or does not run | The path escaped the plugin directory, the file is not there, or its extension is outside the served content-type map (a `.ts` or `.jsx` arrives as `application/octet-stream` and will not execute). A directory URL resolves to `index.html`; a directory itself is a 404 |
| The webview surface shows a panel instead of the page | You are not on the desktop. iOS, the web client, and the TUI render the surface's `panelId` — that is the design, so make that panel say something useful |
| `adePlugin.collections.put` fails with `plugins_unavailable` | A page can only write where the plugin host runs in the same process. Call your own action with `adePlugin.invoke(...)` and write from the child instead |
| Contribution never appears | Check `manifest.sockets` declares the kind on that surface, the payload validates for that kind, and you published from the machine that owns the entity |
| `ade plugin <cmd>` says it needs the brain | `install`/`remove`/`enable`/`disable`/`reload`/`logs`/`dev` are daemon-backed. Start ADE or run `ade brain start`. `list` and `create` never need it |
| `ade <pluginId> <word>` says unknown command | The plugin must be installed, **enabled**, and declare that exact word in `cli` — otherwise the CLI treats it as a typo, which is what you want |
| A directory in `~/.ade/plugins/` is ignored | `state.json` is the only source of truth for "installed". A stray clone is a leftover, not a plugin. Install it properly |
| Plugin missing on another device | Installs are per-machine. Missing plugins hide silently rather than showing broken rows; install it there or use the Marketplace's machine coverage matrix |
| An action domain answers "This machine doesn't have X" | Its plugin is not installed or is disabled here. Install it from the Marketplace, or do the job with the underlying tool — the refusal is ADE's layer being absent, not the capability |

## Publishing

1. Push a public repository with a valid `plugin.json` at its root.
2. Add the `ade-plugin` GitHub topic.

That is the whole process — no submission, no review queue, no account. A crawler picks up the topic and the plugin appears in the Marketplace. Being listed is not an endorsement; community entries show their author and carry no Official mark.

Users can also install straight from a git URL or a local path, from the Marketplace's install dialog or with `ade plugin install`.
