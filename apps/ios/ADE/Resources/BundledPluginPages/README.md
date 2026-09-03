# Bundled plugin pages

A directory here is a **pre-seeded cache entry** for one official plugin's page:

```
BundledPluginPages/
  <pluginId>/
    manifest.json        # the same shape plugin.pageAssets.manifest answers
    index.html           # the files, laid out BY PATH (not by hash)
    assets/…
```

`PluginPageAssetStore` reads it exactly the way it reads a downloaded entry, with
one difference that matters: a downloaded entry stores files under their SHA-256
in `blobs/`, and this one stores them under their own relative paths, because a
build phase copies files and not blobs. The store knows which is which from the
entry's `source`.

`manifest.json` must carry the plugin id, the version, a revision, the entry HTML
and every file with its byte count and SHA-256:

```json
{
  "pluginId": "ade-linear",
  "version": "1.4.0",
  "revision": 0,
  "entry": "index.html",
  "files": [{ "path": "index.html", "bytes": 812, "sha256": "…" }]
}
```

## Why bundle a page at all

So a fresh install draws a real page before it has ever reached a machine. The
bundled entry wins over a download at the same version and revision — its bytes
shipped with the binary and were signed with it — and loses to any newer version
the phone downloads.

## Do not edit this directory by hand

Every file under it is generated. Run

```
npm run sync:plugin-pages
```

from the repo root and commit what changes. The script
(`scripts/sync-bundled-plugin-pages.mjs`) copies the `dist/` of every plugin
under `plugins/` that declares a `webview` surface, writes the `manifest.json`,
deletes files a plugin stopped shipping, and removes the whole directory of a
plugin that no longer has a page. It is idempotent: a run against an unchanged
`dist/` writes nothing, so it never invalidates an incremental Xcode build.

**Run it before any iOS archive.** These files are an iOS app resource, so a
stale copy ships silently — the phone would draw last release's page and have no
way to know. `npm test` runs the script's own tests, not the sync itself.

## Why `revision` is always 0

A downloaded entry's revision is the machine registry's `updatedAt` in
milliseconds, and the phone breaks a version tie on that number. Zero is the only
value that always loses that tie, so at equal versions the machine's own copy
wins and the bundled copy is used exactly when it should be: before anything has
been downloaded, or when the app ships a newer version than the machine holds.

## What is here today

`ade-linear/` — the Linear plugin's page at version 2.0.0, six files.

Never commit a plugin's SOURCE here. Only a built page, and only for a plugin
ADE ships.
