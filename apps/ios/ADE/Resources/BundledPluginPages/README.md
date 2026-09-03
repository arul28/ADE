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

## What is here today

Nothing but this file. The Linear plugin's built `dist/` is copied in by the
coordinator once the plugin's page is built in CI; until then every plugin page
arrives over the sync file channel, and a phone with no cached page draws the
plugin's vocabulary panel.

Never commit a plugin's SOURCE here. Only a built page, and only for a plugin
ADE ships.
