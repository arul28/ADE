# Official ADE plugins

The plugins ADE publishes itself, kept in this repository so they move with the
platform they are built on. Each directory is a complete, installable plugin: a
`plugin.json`, whatever panels and code it needs, and a README that is what the
Marketplace shows.

```
plugins/
  ade-graph/            gates the built-in Graph tab
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

- **No native code and no dependencies.** Entry code is plain CommonJS talking
  to the `ade` SDK global. A plugin that needs a compiled module is not a
  plugin, and a plugin with a `node_modules` is a supply chain we did not agree
  to ship.
- **Data, never code, in a panel.** Panels are vocabulary JSON. Anything that
  needs computing is computed on the machine that owns the data and published as
  rows — see `shared/plugins/vocabulary.ts`.
- **Every panel carries a `fallback`.** It is what a phone, a terminal or an
  older desktop renders when it cannot draw the body, and it is the reason one
  schema is safe to ship across four release trains.
- **Official is a claim the directory verifies.** `"official": true` in a
  manifest is a request; what makes it true is the entry in the plugin directory
  (`registry/`), which carries a per-version sha256 the installer checks.

## Keeping the seeded copies in step

Two places describe these plugins and neither is generated:

- `registry/index.json` — the directory the app fetches.
- `apps/desktop/src/renderer/components/plugins/marketplaceLocalIndex.ts` — the
  copy bundled in the app, so the Marketplace works offline.

`pilotPackages.test.ts` (under `apps/desktop/src/shared/plugins/`) fails when a
manifest here disagrees with either of them on identity, so drift shows up as a
red test rather than as a wrong "Adds" list in an install dialog.
