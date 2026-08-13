---
name: ade-plugins
description: Use this skill to build, extend, debug, or publish an ADE plugin — whenever the task is to add a tab, panel, row badge, toolbar action, row menu item, filter chip, empty state, file viewer, chat composer button, theme, or `ade` CLI command to ADE; to write or fix a `plugin.json` manifest; to author a panel schema in ADE's declarative UI vocabulary; to build a desktop-only custom UI page (a `webview` surface) against the `window.adePlugin` bridge; to link to a plugin panel or hand it a context; to call the plugin SDK (collections, secrets, contributions, config, actions, panels, events); to run `ade plugin create|install|dev|logs|list`; or to make something a plugin renders show up on desktop, web, iOS, and the `ade code` TUI at once. Also use it to answer what a plugin can and cannot do — what its code is allowed to reach, which surfaces it may claim, and which budgets and reserved bindings will refuse it.
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

## What you can build — and what you can't

### The engine has no fence around it

Your `entry` module is a real Node process on the machine that owns the plugin. ADE spawns it from its own Node binary, with the plugin directory as the working directory, the user's environment minus a denylist of ADE's internal socket paths and credentials, and `require` anchored at the plugin root — so vendored `node_modules` and every Node builtin load normally. Read and write any file the user can, open any socket, shell out with `child_process`, run your own database, poll an API on a timer. There is no API allowlist, no declared-capability list, and nothing reviews a plugin before it installs.

Say the consequence out loud when you ship one: **installing a plugin is trusting its author with the machine.** The SDK is a convenience layer over what that process could already do, not a boundary around it. Almost every limit below guards something *shared* — the sync layer, the relay, four clients that must render the same JSON. None of them guards the plugin's own machine, and there is nothing there to guard it with.

### What you can put in front of the user

- **Whole surfaces** — a `tab` or a `pane` rendering a panel schema, and on the desktop a `webview` drawing your own HTML page.
- **Declarative panels**, which desktop, web, iOS and the `ade code` TUI each render with their own native widgets from one JSON document.
- **Sockets on the six core surfaces** — `work`, `lanes`, `files`, `prs`, `automations`, `cto` — in eight shapes: `toolbar-action`, `row-badge`, `row-menu-item`, `detail-section`, `empty-state`, `filter-chip`, `file-viewer`, `composer-action`. Dynamic ones attach to a `lane`, `pr`, `session`, `file`, `automation` or `surface`.
- **Themes** (token sets, no code at all), **`ade` CLI subcommands**, **agent skills** that load only where the plugin is installed, **deeplinks** into your own panels, **cross-surface navigation** — an action returns `{navigate: {…}}` and the client moves the user to another of your panels — and **draft edits**, where an action returns `{composer: {…}}` and writes into the chat prompt the user is typing.

Three shapes that fit the platform well:

- **A Jira mirror.** The Mac engine polls Jira with the user's token and writes ~50 issues into a synced collection; the phone renders them in a panel, offline, holding no token.
- **A CI dashboard.** One row per branch, green or amber (there is no red), recomputed by the machine that owns the repo and identical on every device.
- **A live agent task tracker.** An agent updates rows through your CLI word or your action handler while every open client watches them move.

### The lines you cannot cross

**The rule that explains the rest of them: limits follow the data, not the UI target.** A plugin that draws a `webview` page, sets `mobile: false`, and keeps its state in its own files or its own SQLite meets effectively none of the ceilings below — no vocabulary ceiling, because the panel its webview surface must still name can be a single fallback card; no collection budget, because it stores nothing in the shared table; no relay concern, because it puts nothing on the wire. The caps engage the moment a plugin writes into synced collections, and from then on they apply wherever the UI happens to render: ADE is multi-machine, so those rows replicate to every machine and device on the account even when only the desktop ever draws them. "Desktop-only" is not a permission tier and there is no flag that opts a plugin out of the guardrails — keeping the data local is what opts it out.

**Synced collections are small, and they are not your database.** 2 MiB per plugin per machine, 4,000 rows, 64 KiB per value — the full table is in *Budgets*. Every byte replicates to every device the user owns, and a phone has to hold all of it. Full is not broken: a `put` past a ceiling throws `plugin_budget_exceeded` and changes nothing else, reads and deletes keep working, and the accounting is delta-based — replacing a 60 KiB value with a 1 KiB one is allowed *at* the ceiling, so a plugin can always shrink itself. Treat collections as synced state; bulk data belongs in your own storage on disk, where nothing is counting. Writing a plugin that survives its own store filling up is a requirement, not a nicety — the rules are in *Never stall*.

**Churning synced values spends the user's relay allowance.** Per-machine daily relay ceilings exist and a machine past one loses relay transport until midnight UTC — numbers and the rule in *Budgets*. Direct and LAN sync are never counted. Read it as etiquette rather than a limit you will hit: publish when something changed, not on a loop.

**The vocabulary is thirteen components with hard ceilings** — 200 nodes, depth 8, 64 KiB per schema, plus the per-component caps in *Vocabulary limits*. No expressions, conditionals, formatting strings or callbacks. A component this build has never heard of renders a marker naming it, and a panel over any ceiling renders its required `fallback` instead — which is why `fallback` is mandatory rather than nice to have. What draws where differs per surface: *Per-surface support* is the authority, and worth reading before you design a panel around a `chart`.

**A `webview` page is desktop-only and sandboxed.** Its own origin, `script-src 'self'`, no Node, no `require`, no raw IPC, and no `window.ade` — the `window.adePlugin` bridge is the entire capability, and even `collections.put` through it is refused on the desktop app (write through `invoke` instead). iOS, the web client and the TUI render the surface's `panelId` panel in its place. **There is no custom native UI on iOS or the TUI at all**; declarative panels are the only cross-device UI that exists.

**Nothing you write executes anywhere but the owning machine.** The other clients render data — they never run a plugin's code, which is why a value has to be materialized in render shape before anyone can see it. The `mobile` flag only ever takes a surface away from the phone (see *Mobile*); it cannot put code there.

**The six built-in surface bindings belong to ADE's own plugins.** `graph`, `review`, `history`, `linear`, `ios` and `app-control` are gated by `ade-graph`, `ade-review`, `ade-history`, `ade-linear`, `ade-ios-sim` and `ade-app-control`. A manifest that does not set `official: true` has its `builtin` dropped with a warning; a manifest that does set it still only gates the surface whose registered owner is its own plugin id, because the owner table is compiled into every client. Naming someone else's surface parses clean and changes nothing.

**You cannot declare yourself Official.** The directory decides: an entry is official only when ADE's curated `official.json` lists it *and* both its repo and its install source sit in ADE's own GitHub organizations — otherwise it lists as community with a warning. Official entries carry a per-version sha256 the installer checks against the fetched tree; community plugins are not checksummed by the directory and install as unverified. Being listed in the Marketplace is not an endorsement.

**Sockets and action domains are closed sets.** You fill the eight slots above on those six surfaces; there is no way to inject UI anywhere else, and placement is host-controlled and always after core content, so a contribution never reorders or interleaves with the product's own rows. `ade.actions.invoke` reaches ADE's existing action domains at **agent** role — CTO-only actions are refused — and a plugin cannot define a domain of its own.

**Plugins cannot see each other.** The SDK server is constructed per plugin and answers every call against that plugin's id; the child never puts an id on the wire. Collections must be declared in your own manifest (an undeclared name is refused, not created), secrets are namespaced `plugin:<id>:<NAME>`, and `config.get()` returns your own settings. There is no cross-plugin read of any kind.

One limit that is not about sharing, because it will bite you anyway: the *process* may work for as long as it likes, but the *host round-trip* is supervised. The child has 20s to send `ready` after it is spawned, one `invoke` is capped at 60s and then fails with `plugin_timeout`, and after 5 crashes in a row inside the first minute of life the host stops reviving it until someone reloads. Long work belongs in `activate` or an event handler, with the result stored — never inside the action the user is waiting on. The single exception is a `composer-action`, which gets 15 minutes because the user watches it work the whole time (*Long-running composer actions*).

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
| `surfaces[]` | no | `{kind: "tab"\|"pane"\|"webview", id, title, panelId, icon?, order?, mobile?, builtin?}`. `panelId` is required on all three kinds. A `webview` also needs `entryHtml` — see *Custom UI*. `mobile` — see *Mobile*. `builtin` names a compiled-in ADE tab this plugin gates instead of rendering, and is reserved — see *What you can build* |
| `panels[]` | no | `{id, schemaFile?, title?, icon?}`. `schemaFile` is the default schema; `sdk.panels.update()` replaces it at runtime |
| `sockets[]` | no | See *Sockets* below |
| `collections` | no | `{"<name>": {"sync": true\|false}}`. `sync: true` rides the sync layer to your other devices |
| `settings[]` | no | `{key, kind, label, description?, options?, optionsAction?, default?}`; `kind` ∈ `text`, `secret`, `select`, `toggle`, `number` |
| `cli[]` | no | Subcommand words, `^[a-z][a-z0-9-]{0,31}$`, reachable as `ade <id> <word>` |
| `skills[]` | no | Relative paths to agent-skill directories this plugin contributes; they join `ADE_AGENT_SKILLS_DIRS` |
| `theme` | no | Token sets — see *Themes* |
| `official` | no | **Not a trust claim.** The Official badge and the checksum rule come from the registry's curated file, never from the manifest. Locally the field does exactly one thing: a surface may carry `builtin` only on a manifest that sets it — see *What you can build* |

Every path in a manifest (`entry`, `schemaFile`, `skills[]`) must be relative, inside the plugin directory, and free of `..` — absolute paths and traversal are refused at parse time.

Manifest-level rules the parser enforces (a violation drops that entry, not the plugin):

- `detail-section` and `file-viewer` sockets require `panelId`.
- `toolbar-action`, `row-menu-item` and `composer-action` sockets require `actionId`.
- `file-viewer` requires at least one `".ext"` extension.
- A `webview` surface requires `entryHtml`, and it must name an `.html` (or `.htm`) file inside the plugin. A `webview` with no page is dropped, not warned about. `entryHtml` on any other kind is ignored.

### Mobile

Every surface says whether it belongs on the phone. Set `"mobile": false` on a surface that only makes sense on a big screen, and ADE's iOS app leaves it out of the plugin menu and will not open it.

- **Default: `true`** for a `tab` or a `pane`. Say nothing and your panel shows up on the phone, which is the point of writing a panel schema instead of a page.
- **`false` is a good answer** when the panel needs a wide table, a long form, or a keyboard to be worth opening. Hiding it there is kinder than shipping a cramped version of it.
- **A `webview` is desktop-only either way.** Its page never draws on the phone; the panel named by its `panelId` does. Setting `mobile` on a webview surface changes nothing (ADE warns and ignores it), so put your effort into making that panel say something useful.
- **`mobile` only ever takes a surface away.** It cannot add one. A value that is not `true` or `false` is ignored with a warning, and the default applies.

Set it per surface, not per plugin: a plugin with a summary pane and a settings tab can keep the first and drop the second.

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

Six core surfaces: `work`, `lanes`, `files`, `prs`, `automations`, `cto`. Eight socket kinds. Both sets are closed — a plugin fills a slot, it never invents one. Placement is **host-controlled and always after core content** — a contribution never reorders, replaces, or interleaves with the product's own rows. `order` sorts plugins against each other and nothing more.

| Socket kind | Payload | What it draws |
|---|---|---|
| `toolbar-action` | `{label, actionId, icon?, disabled?}` | A button in a surface's toolbar |
| `row-badge` | `{text, tone, icon?, tooltip?}` | A badge on a row |
| `row-menu-item` | `{label, actionId, icon?, danger?}` | An entry in a row's context menu |
| `detail-section` | `{panelId, title?}` | A panel rendered as a section in a detail view |
| `empty-state` | `{title, body?, actionId?, actionLabel?}` | Extra content on a surface's empty state |
| `filter-chip` | `{label, filterKey, count?}` | A chip in a surface's filter row |
| `file-viewer` | `{panelId, extensions[]}` | A viewer for matching files in the Files tab |
| `composer-action` | `{label, actionId, icon?, disabled?}` | A button in the chat composer's accessory row (`work`). The one socket whose handler may run for minutes — see *Long-running composer actions* |

Two sources, deliberately different:

- **Static** contributions come from `manifest.sockets` — "this plugin has a toolbar button here".
- **Dynamic, per-entity** values come from `sdk.contributions.publish(...)` — "PR #1234 gets this badge, right now". The machine that owns the data computes them; other devices read the row.

A payload that fails validation renders nothing at all rather than a half-built row, so a missing `label` or `actionId` shows up as an absence, not as a blank button.

Entity kinds for `publish`: `lane`, `pr`, `session`, `file`, `automation`, `surface`. A composer belongs to its chat, so publish a `composer-action` row against `session` to change what your button says for one conversation. Row badges cap at **2 visible** per row with the rest behind a "+N", and composer buttons do the same in the accessory row; a single plugin may place at most **8** contributions in one socket slot.

Your action receives a typed, read-only context object — a projection, not a handle:

| Context | Fields |
|---|---|
| `pr` | `number`, `title`, `branch`, `state` (`open`\|`closed`\|`merged`\|`draft`\|`unknown`), `ciStatus` (`passing`\|`failing`\|`pending`\|`none`\|`unknown`) |
| `lane` | `id`, `name`, `branch`, `machineKey`, `dirty` |
| `session` | `id`, `title`, `provider`, `status` |
| `file` | `path`, `size`, `extension`, `workspaceId` |
| `automation` | `id`, `name`, `enabled` |
| `composer` | `sessionId`, `projectKey`, `projectRoot`, `laneId`, `draft`, `cursor` |
| `surface` | `surface` (for toolbar actions, empty states, chips — no per-entity subject) |

You cannot reach the lane's worktree, the PR's token, or the session's transcript from a context. Widening one is a platform change, not something a plugin arranges.

**The `composer` context is the exception, and deliberately so.** `draft` is the user's full unsent prompt, verbatim, and `cursor` is where their caret sits in it — a button that rewrites, translates, or expands a prompt cannot do its job from a session id, and one that asked the user to paste their draft somewhere else would not be a composer button. Installing a plugin grants it, the same grant that already lets the plugin's child process read any file the user can. `sessionId` is null on a composer that has not started a chat yet (the hero composer, a fresh Work pane), and `cursor` is null when the composer holds no live caret — append, in that case. The draft is read when the button is PRESSED, not when it rendered, so what you receive is the text on screen at that moment.

### Per-surface socket support

| Socket | Desktop / web | iOS | TUI |
|---|---|---|---|
| `row-badge`, `row-menu-item` | yes | yes | no |
| `toolbar-action`, `detail-section`, `empty-state`, `filter-chip`, `file-viewer` | yes | decoded, not drawn — a later iOS build adds the arm with no wire change | no |
| `composer-action` | yes | no — dropped where the row decodes, so it is simply absent | no |

The TUI surfaces plugins through `/plugin-view [plugin]`, which opens a panel in the right pane; it renders no sockets. Design so a badge is an enhancement, never the only way to learn something.

### Writing into the draft

An action can return `{composer: {…}}` the way it can return `{navigate: {…}}`, and the client applies it to the chat composer:

| Verb | Effect |
|---|---|
| `{composer: {insertText: "…"}}` | Insert at the caret, leaving the rest of the draft alone. An empty string does nothing |
| `{composer: {replaceText: "…"}}` | Replace the whole draft. An empty string clears it |

Four things worth knowing before you rely on it:

- **The verb belongs to the response, not to the socket kind.** Any action invoked from a composer- or chat-scoped socket can carry one — a `row-menu-item` on a chat row that returns `{composer: {insertText}}` writes into that chat's composer. Invoked from somewhere with no composer at all (a Lanes toolbar, a PR row), the edit is dropped with a console warning rather than queued: a draft that surfaced under an unrelated chat minutes later would be worse than nothing happening.
- **`replaceText` wins if you send both.** "Replace, then insert into the replacement" is not what either verb means.
- **32 KiB is the ceiling**, in UTF-8 bytes. Over it the edit is dropped, never truncated — a prompt cut off mid-sentence and then sent is worse than one that never arrived.
- **You cannot send the message.** Composing and sending stay the user's; the verbs write text and stop there.

### Long-running composer actions

Every other socket's handler is capped at **60s**, and the guidance everywhere else in this skill stands: do slow work in `activate` or an event handler and store the result. A `composer-action` is the deliberate exception, capped at **15 minutes**, because its canonical uses are open-ended by nature — record until I stop, transcribe this, draft that.

The reason is the busy state, not the socket. A composer button is the one contribution the user watches for its whole duration:

- **It stays visibly active for the entire run** — accent-tinted, label intact, still focusable. It is *not* greyed out, because a control that looks disabled for three minutes reads as broken.
- **A second press while it runs is a no-op.** You will never be re-entered for a click the user made while your handler was still working, so a "start/stop" button must be driven by your own state, not by two invocations.
- **The user keeps typing the whole time.** Which is the next rule, and the one that actually bites.

**Insert against the draft as it reads when you RESPOND, not when you were called.** ADE splices `insertText` at the caret's *current* position in the *current* draft, so an insert is always correct on ADE's side. What is on you is your own arithmetic: if your handler captured `context.draft` at the start of a three-minute recording and returns `{composer: {replaceText: draft + transcript}}`, you have just deleted everything the user typed while you were listening. Prefer `insertText` for anything that took real time, and reserve `replaceText` for actions that answer immediately or genuinely own the whole prompt.

Worked example — a prompt-template button. Declare the socket:

```json
{ "socket": "composer-action", "surface": "work", "id": "bug",
  "label": "Bug report", "icon": "Bug", "actionId": "bugTemplate" }
```

Then answer with the edit:

```js
exports.actions = {
  async bugTemplate(args) {
    const { draft } = args.context;                 // the live prompt, verbatim
    const template = "Steps to reproduce:\n1. \n\nExpected:\n\nActual:\n";
    // Nothing typed yet: lay the template down. Otherwise slot it in at the
    // caret so the sentence they were writing survives.
    return draft.trim().length === 0
      ? { composer: { replaceText: template } }
      : { composer: { insertText: `\n\n${template}` } };
  },
};
```

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
| `ade.collections.put(collection, key, value, options?)` | Write one value. Budget-checked inside the writer transaction. `{ifFull: "evictOldest"}` drops the oldest entries in that same collection to make room instead of refusing — see *Never stall* |
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

### Relay fairness

Those budgets bound what a plugin *stores*. A separate ceiling bounds what a machine *relays*: sync frames that travel through ADE's relay are counted per machine per UTC day — **500,000 frames** and **250 MiB** — and a machine past either has its tunnels closed and new ones refused until midnight UTC. Direct and LAN sync are never counted; only the relay hop is.

Both ceilings sit roughly 100× above honest use, so nothing written normally approaches them. They are worth knowing anyway, because a plugin is the one thing on the machine that can write to the sync layer in a loop. Publish a value when it changed rather than on a timer, and clear a contribution with `null` rather than rewriting the same badge every tick.

### Never stall

A full store is a normal state, not an incident. A plugin **must** be written so that reaching a ceiling costs it one skipped item and nothing else — not a dead child, not a blank panel, not a plugin the user has to reinstall. These are requirements, not tuning advice.

1. **Catch every `put`.** `ade.collections.put` can refuse, and an uncaught refusal inside `activate` is fatal to the child, while one inside an action handler fails that action. The rejection carries `code: "plugin_budget_exceeded"` and `detail: {budget, limit, actual}` — branch on `error.code` directly. ADE's own `isPluginBudgetExceeded` helper is not reachable from a plugin: the child has no ADE package to import and the `ade` global does not carry it. Treat a refusal as **prune, retry once, then skip the item and carry on.** Never treat it as fatal, and never retry in a loop — the ceiling will not move because you asked twice. This holds even with the self-healing write below: it makes room, it does not make the impossible fit.
2. **Design the store as a bounded cache from day one, and let the platform hold the bound.** When a collection is a cache — newest N wins, nothing in it is precious — say so on the write and stop hand-rolling retention:

   ```js
   await ade.collections.put("issues", `open:${row.id}`, value, { ifFull: "evictOldest" });
   ```

   A write that would cross the byte or row budget then deletes the oldest entries **in that collection** until the value fits, atomically, and writes. It never reaches into another collection, so a cache cannot evict something precious you happened to store beside it — which is the argument for giving anything you cannot afford to lose a collection of its own. This is the recommended default for cache-shaped data. It does not rescue a value that can never fit — larger than the whole budget, or over the 64 KiB per-value cap — and that still throws, per rule 1. Omit the option and the behaviour is exactly as before: the write throws and you handle it.

   **Custom retention stays manual.** `evictOldest` keeps the newest; a plugin that has to keep the most *relevant*, or age rows out on its own clock, prunes for itself. Then the old discipline applies: delete before you insert once you are at your own soft ceiling — around 80% of the platform cap, which leaves room for a value that grew — and prefer overwriting one key to accumulating keys, since a fixed `summary` key you rewrite can never grow the row count at all.
3. **History-shaped data must be windowed or aggregated.** Logs, time series, message archives and event streams append forever by nature, and forever does not fit in 4,000 rows. Keep the latest snapshot or the last N entries and roll the rest off — when the window is simply "newest wins", rule 2's `ifFull` does the rolling for you. Bulk and media data do not belong in synced storage at any size — the 64 KiB per-value cap is the platform saying so, and your own files on disk are the answer.
4. **Recovery is always available, so a stuck plugin is a written bug.** Deletes are never budget-checked and the byte accounting is delta-based, so shrinking a value succeeds at the ceiling exactly as it does on an empty store. A plugin that fills its budget can always dig itself out, unattended, with no user action and no reinstall.
5. **Never block rendering on a write.** Panels render from what is already stored, so a refused `put` should cost the user the newest row and nothing more. Update the panel when a write lands; when it does not, leave the last good data on screen rather than replacing it with an error.

The same discipline is what keeps you clear of the relay ceilings above: rewriting the same value in a tight loop spends the user's daily allowance on data nobody read. Write when the state actually changed, not on every tick of your own timer.

## Recipes

### A dashboard tab backed by an API

Manifest: one `tab` surface, one panel, one collection, one `secret` setting for the token.

```js
exports.activate = async (ade) => {
  const KEEP = 50;                                     // bounded cache, decided up front
  const refresh = async () => {
    const token = await ade.secrets.get("API_TOKEN");
    const rows = (await fetchIssues(token)).slice(0, KEEP);   // your own code
    // Correctness, not budget: drop issues that have left the window entirely.
    const keep = new Set(rows.map((row) => `open:${row.id}`));
    for (const stored of await ade.collections.list("issues", { keyPrefix: "open:" })) {
      if (!keep.has(stored.key)) await ade.collections.delete("issues", stored.key);
    }
    for (const row of rows) {
      try {
        // Materialize in RENDER shape — a `list` binding reads exactly these keys.
        // `ifFull` handles budget pressure; the catch handles a value that can never fit.
        await ade.collections.put("issues", `open:${row.id}`, {
          title: row.title, subtitle: row.repo, meta: row.age, tone: row.stale ? "warning" : "neutral",
        }, { ifFull: "evictOldest" });
      } catch (error) {
        if (error?.code !== "plugin_budget_exceeded") throw error;
        ade.log("warn", `Skipped ${row.id}: store full.`);    // skip the item, keep the plugin
      }
    }
  };
  await refresh();
  ade.events.on("pr.changed", () => void refresh());
};
exports.actions = { refresh: async () => ({ ok: true }) };
```

The window, the delete-before-insert pass and the `catch` are not decoration — see *Never stall*.

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
4. **Never assume a socket renders.** iOS draws two of the eight kinds today, `composer-action` is desktop and web only, and the TUI draws none. A contribution is an enhancement; the panel and the fallback are the floor.
5. **The `plugin_*` SQL shapes are frozen.** A plugin never gets its own table or its own column on an ADE entity — collections and contributions are the two storage shapes there are.
6. **Budgets are refusals, not warnings.** Catch `plugin_budget_exceeded` on every `put`, prune, and carry on — a full store must never stall a plugin (*Never stall*). Budgets bound what leaves the machine, never what the plugin's own process may do (*What you can build*).
7. **`"official": true` in your manifest buys no trust.** Official is a statement the registry makes about a plugin, never one the plugin makes about itself. The one thing the field does locally is unlock the reserved `builtin` binding, which still gates nothing unless the compiled owner table already names your plugin id.
8. **Bump `version` on every published change.** The install registry, the checksum table, and the update path all key off it.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Plugin shows as `crashed` | The child exited. `ade plugin logs <id> --text` — the crash line carries the exit status and the tail of stderr. It restarts automatically with backoff `min(30s, 1s × 2ⁿ)`; a child that stays up 60s resets the counter. After 5 fast failures in a row the host stops reviving it and the status stays `crashed` — `ade plugin reload <id>` (or the Restart button) clears the counter and tries again |
| Status stuck at `starting` | The child never sent `ready` within 20s. Usually a top-level throw in the entry module or a `require` of something not installed — check the logs |
| An action hangs then fails | `plugin_timeout`: one `invoke` round-trip is capped at 60s — 15 minutes for a `composer-action`. Do slow work in `activate` or an event handler and store the result |
| A long composer action's insert wipes what the user typed | Your handler splices against the `context.draft` it captured at the start. Return `insertText` and let ADE place it at the live caret, rather than rebuilding the whole prompt with `replaceText` — see *Long-running composer actions* |
| A write fails with `plugin_budget_exceeded` | Working as designed. Read `detail.budget`, `detail.limit`, `detail.actual`, prune with `ade.collections.delete`, retry once, then skip the item. Deletes always succeed, so recovery never needs the user — if the plugin stalled here, fix it against *Never stall* |
| Panel renders as a fallback card | Panel-fatal: bad JSON, `v` mismatch, missing `fallback`, or over 200 nodes / depth 8 / 64 KiB. Compare against the limits above |
| One component shows a marker, rest renders fine | Node-local. Either the component is malformed, or that surface does not draw it (see the support matrix) |
| Panel renders on desktop, marker on iOS or the TUI | Expected for `chart`, and for `video`/`image` in the TUI. Not a bug — give the panel something else to say |
| A webview page loads but stays blank | Almost always the CSP: `script-src 'self'` blocks inline `<script>`, `onclick=` attributes, `eval`, and anything from a CDN. Move the code into a `.js` file next to the page and load it with `src` |
| A file in the page 404s or does not run | The path escaped the plugin directory, the file is not there, or its extension is outside the served content-type map (a `.ts` or `.jsx` arrives as `application/octet-stream` and will not execute). A directory URL resolves to `index.html`; a directory itself is a 404 |
| Panel shows on desktop but not on the phone at all | The surface says `"mobile": false`, or it is a `webview` (never on the phone) — see *Mobile*. The flag is resolved by the machine that publishes the panel, so edit the manifest and `ade plugin reload <id>` on that machine |
| The webview surface shows a panel instead of the page | You are not on the desktop. iOS, the web client, and the TUI render the surface's `panelId` — that is the design, so make that panel say something useful |
| `adePlugin.collections.put` fails with `plugins_unavailable` | A page can only write where the plugin host runs in the same process. Call your own action with `adePlugin.invoke(...)` and write from the child instead |
| Contribution never appears | Check `manifest.sockets` declares the kind on that surface, the payload validates for that kind, and you published from the machine that owns the entity |
| Composer button is there but nothing lands in the draft | Look for `[plugin composer]` in the renderer console. "no composer on screen" means the action was invoked from a surface with no composer; "malformed" means the verb was not a string, was an empty `insertText`, or was over the 32 KiB ceiling |
| Composer button never appears on the phone or in the TUI | Expected — `composer-action` is desktop and web only (see the support table). Give the same action a `row-menu-item` or a panel button if it has to be reachable everywhere |
| `ade plugin <cmd>` says it needs the brain | `install`/`remove`/`enable`/`disable`/`reload`/`logs`/`dev` are daemon-backed. Start ADE or run `ade brain start`. `list` and `create` never need it |
| `ade <pluginId> <word>` says unknown command | The plugin must be installed, **enabled**, and declare that exact word in `cli` — otherwise the CLI treats it as a typo, which is what you want |
| A directory in `~/.ade/plugins/` is ignored | `state.json` is the only source of truth for "installed". A stray clone is a leftover, not a plugin. Install it properly |
| Plugin missing on another device | Installs are per-machine. Missing plugins hide silently rather than showing broken rows; install it there or use the Marketplace's machine coverage matrix |
| An action domain answers "This machine doesn't have X" | Its plugin is not installed or is disabled here. Install it from the Marketplace, or do the job with the underlying tool — the refusal is ADE's layer being absent, not the capability |

## Publishing

1. Push a public repository with a valid `plugin.json` at its root.
2. Add the `ade-plugin` GitHub topic.

That is the whole process — no submission, no review queue, no account. A crawler picks up the topic and the plugin appears in the Marketplace. Being listed is not an endorsement: community entries show their author, carry no Official mark, and are not checksummed by the directory, so they install as unverified. Official is not something publishing can earn — see *What you can build*.

Users can also install straight from a git URL or a local path, from the Marketplace's install dialog or with `ade plugin install`.
