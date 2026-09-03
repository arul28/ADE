# Official ADE plugins

The plugins ADE publishes itself, kept in this repository so they move with the
platform they are built on. Each directory is a complete, installable plugin: a
`plugin.json`, whatever panels and code it needs, and a README that is what the
Marketplace shows.

```
plugins/
  ade-graph/            ADE's Graph product (supersedes the compiled Graph tab)
  ade-review/           ADE's AI review product (supersedes the compiled Review tab)
  ade-history/          ADE's History product (supersedes the compiled History tab)
  ade-linear/           ADE's Linear product (supersedes the compiled Linear pane)
  ade-ios-sim/          ADE's iOS Simulator product (supersedes the compiled Work pane)
  ade-app-control/      ADE's Electron Control product (supersedes the compiled Work pane)
  ade-log-viewer/       renders .log and .ndjson in the Files tab
  themes/
    ade-theme-paper/    warm paper light
    ade-theme-ink/      deep ink dark
    ade-theme-contrast/ high-contrast, for reading in bad light
```

## Installing one while working on it

```sh
ade plugin install ./plugins/ade-log-viewer
ade plugin dev ade-log-viewer      # reload on change
ade plugin logs ade-log-viewer
```

A path install copies the tree into `~/.ade/plugins/<id>/` and records it in
`~/.ade/plugins/state.json`, which is the only thing that makes a plugin
installed — a directory sitting under the plugins root that no registry entry
names is a leftover, not a plugin.

## House rules for anything published here

- **No native code and no dependencies in the entry.** Entry code is plain
  CommonJS talking to the `ade` SDK global. A plugin that needs a compiled
  module is not a plugin, and an entry with a `node_modules` is a supply chain
  we did not agree to ship. A page's build tooling is a separate thing — see
  **Pages** below.
- **Data, never code, in a panel.** Panels are vocabulary JSON. Anything that
  needs computing is computed on the machine that owns the data and published as
  rows — see `shared/plugins/vocabulary.ts`. Code in the UI belongs in a page.
- **Every panel carries a `fallback`.** It is what a phone, a terminal or an
  older desktop renders when it cannot draw the body, and it is the reason one
  schema is safe to ship across four release trains.
- **Official is a claim the directory verifies.** `"official": true` in a
  manifest is a request; what makes it true is the entry in the plugin directory
  (`registry/`), which carries a per-version sha256 the installer checks.

## Pages

A `webview` surface is the plugin's own HTML, and it is the primary UI tier:
desktop, the hosted web client and iOS each draw it in an isolated guest, and
every other client draws the surface's `panelId` panel instead. Scaffold one
with:

```sh
ade plugin create my-plugin --webview
```

Four rules the host enforces, so a page that breaks one simply does not load:

- **No inline script and no CDN.** The content policy is `script-src 'self'`:
  every script is an external file inside the plugin's own directory, and a
  library is vendored rather than linked. `style-src` adds `'unsafe-inline'`, so
  an injected `<style>` works; `img-src` and `media-src` reach `https:`,
  `connect-src` is `https:`, and `font-src` is `'self'` — vendor the `.woff2`
  files.
- **Every path is relative.** The page's origin is `ade-plugin://<pluginId>`
  and nothing outside it loads.
- **Source and built output are both committed.** Keep the page source under the
  plugin (`page/src`, built with Vite) and commit the built `dist/`. Install
  copies the tree as it stands, minus `.git` and `node_modules`, so the
  committed output is what a user installs and no build runs on their machine.
- **`panelId` stays required.** The panel is the fallback, and it is what keeps
  the plugin working on the terminal and on a phone that has not cached the
  page yet.

Use **`@ade-dev/ui`** (`packages/ui`) to look like the app. Import the narrowest
entry point that covers what you draw — `@ade-dev/ui/tokens`,
`@ade-dev/ui/theme`, `@ade-dev/ui`, `@ade-dev/ui/icons`, `@ade-dev/ui/markdown`
— then inject the stylesheet once with `<AdeStyles/>` or `injectAdeStyles()`,
and hand `adePlugin.theme.get()` to `applyAdeTheme` on startup and on every
`theme` event. The kit's own README has the worked examples.

## Keeping the catalogue copies in step

Two places describe these plugins and neither is generated:

- `registry/index.json` — the directory the app fetches.
- `apps/desktop/src/renderer/components/plugins/marketplaceLocalIndex.ts` — the
  copy bundled in the app, so the Marketplace works offline.

`pilotPackages.test.ts` (under `apps/desktop/src/shared/plugins/`) fails when a
manifest here disagrees with either of them on identity, so drift shows up as a
red test rather than as a wrong "Adds" list in an install dialog.
