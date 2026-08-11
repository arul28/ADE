# ADE plugin registry

This directory is the plugin directory ADE fetches: a static `index.json` plus
the curated files and the crawler that produces it.

It lives here so it can be reviewed with the code that reads it. It is meant to
be **extracted** into a standalone public repository — `ade-plugins-registry`
— once the platform ships. Nothing here runs in this repository, and nothing
here is deployed by this repository's CI.

## Why a repository and not a service

The directory has to be world-readable, cheap, cached at the edge, and
auditable. A public GitHub repository is all four for nothing: `raw.githubusercontent.com`
serves and caches the file, a scheduled Action rebuilds it, and every change to
what ADE recommends is a commit with a diff. A worker plus a database would cost
money, need a deploy pipeline, and make curation invisible.

The one thing a static file cannot do is count installs. That is the only piece
that lives in a worker — see "Install counts" below.

## Files

| File | What it is |
|---|---|
| `index.json` | The published directory. Written by the crawler; do not hand-edit. |
| `featured.json` | Curated hero row. Hand-edited. |
| `official.json` | Curated Official set and the sha256 digests ADE vouches for. Hand-edited. |
| `schema/index.schema.json` | The index contract, as JSON Schema. |
| `scripts/crawl.mjs` | The crawler. No dependencies; Node 22. |
| `crawl.yml` | The scheduled workflow. Becomes `.github/workflows/crawl.yml` after extraction. |

The **enforcing** copy of the contract is not here: it is
`apps/desktop/src/shared/plugins/registryIndex.ts` in the ADE repository, which
every install runs against every fetched index. `schema/index.schema.json`
documents the same shape for plugin authors and for anyone validating the file
by hand. When the two disagree, the TypeScript parser wins, because it is what
actually decides what a user sees.

## How a plugin gets listed

1. Publish a public repository with a valid `plugin.json` at its root.
2. Add the `ade-plugin` topic to it.

That is the whole process. The crawler finds the topic every six hours, reads
`plugin.json`, and adds an entry. There is no submission, no review queue, and
no account — a directory that requires permission to be in stops being a
directory.

Being listed is not an endorsement, and the UI says so: community entries carry
their author and no Official mark.

## Official

`official` is set from `official.json` and from nowhere else. A plugin's own
manifest can say `"official": true` — anyone can write that in a JSON file — so
the crawler ignores the manifest's claim entirely. Being official is a statement
ADE makes about a plugin, never one the plugin makes about itself.

`official.json` also binds each official id to one repository. A different repo
publishing a manifest that claims a bound id is refused outright rather than
listed as a community plugin, because a second "graph" beside the official one
is exactly the confusion the binding exists to prevent.

### Signing

Official entries carry `checksums`: a map of released version to the sha256 of
that version's source tree.

- The digest is computed from the tag, once, when a version is released, and
  never edited afterwards. Editing a published digest is indistinguishable from
  covering up a compromise.
- The installer computes the same digest over what it fetched and compares
  (`verifyPluginChecksum` in `registryIndex.ts`). A mismatch is fatal and always
  refuses the install.
- A version with no published digest installs as **unverified**, not as failed.
  Community plugins live here permanently, and an official release the crawler
  has not indexed yet lives here briefly. The digest is a tamper check on the
  directory's own claim, not a licence to run.

The tree digest is defined as: `git archive` of the tag, excluding `.git`,
piped through `sha256sum`. Recording the recipe matters more than the choice —
a digest nobody can reproduce is decoration.

## Install counts

`index.json` publishes an `installs` count per plugin, so the Marketplace can
sort by popularity. The number comes from the ADE push relay, which the crawler
reads over one public endpoint:

    GET https://ade-push-relay.<account>.workers.dev/plugins/installs
    → { "ok": true, "generatedAt": "...", "counts": [ { "pluginId": "graph", "installs": 42 } ] }

### Data minimisation

The relay side is `apps/push-relay` in the ADE repository. What it stores and
what it exposes were both chosen to be the minimum that can produce that number:

- **The ping carries `{pluginId, version}` and nothing else.** No project, no
  repository, no account, no user, no path, no timing.
- **It is signed with the machine identity the relay already holds** — the same
  HMAC key used for push registration. The ping creates no new identifier, and a
  machine that never registered for push never pings at all: telemetry does not
  get to mint an identity.
- **One row per (plugin, machine).** Reinstalling, upgrading, or retrying cannot
  inflate a count, and the table cannot become a history of what anyone did.
- **The public endpoint returns totals only.** No machine key, no version, no
  timestamps — one integer per plugin id. It is unauthenticated because the
  numbers are published in this file anyway.
- **Rows expire after 180 days without a re-report,** so a count reflects
  machines still running ADE rather than growing forever.
- **`ADE_PLUGIN_INSTALL_PINGS=0` turns it off** on a machine, and everything
  else keeps working; that machine simply is not counted.

## Extraction

To move this into `ade-plugins-registry`:

1. Create the public repository.
2. Copy the contents of this directory to its root, so `index.json`,
   `featured.json`, `official.json`, `schema/` and `scripts/` sit at the top
   level.
3. Move `crawl.yml` to `.github/workflows/crawl.yml`. It is deliberately NOT
   under `.github/workflows/` here, because anything there would run in the ADE
   repository, where it has nothing to crawl and no index to write.
4. Confirm the repository's Actions have write permission for contents
   (Settings → Actions → Workflow permissions), which the commit step needs.
5. Run the workflow once by hand (`workflow_dispatch`) and check the resulting
   `index.json` diff before trusting the schedule.
6. If the repository or branch name differs from the default, set
   `ADE_PLUGIN_REGISTRY_URL` in ADE to the new raw URL, or update
   `DEFAULT_PLUGIN_REGISTRY_INDEX_URL` in
   `apps/ade-cli/src/services/plugins/pluginRegistryService.ts`.
7. Delete this directory from the ADE repository. The seed-index test in
   `apps/desktop/src/shared/plugins/registryIndex.test.ts` skips itself when the
   directory is gone.

Until then, ADE works without any of it: the Marketplace ships a bundled index
of the official plugins (`marketplaceLocalIndex.ts`), and a live index layers on
top when one becomes reachable.

## Local development

Serve a copy of `index.json` and point ADE at it:

    cd registry && python3 -m http.server 8080
    ADE_PLUGIN_REGISTRY_URL=http://127.0.0.1:8080/index.json ade ...

Plaintext is accepted only for loopback hosts; every other override must be
`https`, and an unusable one falls back to the published URL rather than
disabling the directory.

To run the crawler against the live topic without publishing:

    GITHUB_TOKEN=$(gh auth token) node registry/scripts/crawl.mjs

It rewrites `index.json` in place and writes nothing else.
