# ADE plugin registry

This directory is the plugin directory ADE fetches: a static `index.json` plus
the curated files and the crawler that produces it.

It lives here so it can be reviewed with the code that reads it. It is meant to
be **extracted** into a standalone public repository —
`github.com/arul28/ade-plugins-registry` — once the platform ships. Nothing
here runs in this repository, and nothing here is deployed by this repository's
CI.

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
| `index.json` | The published directory. Written by the crawler; do not hand-edit. Does not exist until the first crawl runs in the extracted repo. |
| `seed-entries.json` | Staging for the bundled plugins' future directory entries. Never published and read by nothing at runtime — see the `notes` inside it for why copying it into `index.json` breaks bundled installs. |
| `featured.json` | Curated hero row. Hand-edited. |
| `official.json` | Curated Official set and the sha256 digests ADE vouches for. Hand-edited. |
| `schema/index.schema.json` | The index contract, as JSON Schema. The crawler validates against it before publishing. |
| `scripts/crawl.mjs` | The crawler. No dependencies; Node 22. |
| `scripts/validateSchema.mjs` | The JSON Schema subset the crawler validates with. No dependencies, by the same rule. |
| `scripts/crawl.test.mjs` | Crawler regression tests. `node --test registry/scripts/crawl.test.mjs`. |
| `crawl.yml` | The scheduled workflow. Becomes `.github/workflows/crawl.yml` after extraction. |

The **enforcing** copy of the contract is not here: it is
`apps/desktop/src/shared/plugins/registryIndex.ts` in the ADE repository, which
every install runs against every fetched index. `schema/index.schema.json`
documents the same shape for plugin authors, and the crawler now checks its own
output against it before writing — a drifted entry would otherwise be dropped
SILENTLY by the reading side, which shows up as a plugin vanishing from the
Marketplace with nothing anywhere saying why. When the two disagree, the
TypeScript parser wins, because it is what actually decides what a user sees;
the schema is kept deliberately as permissive as the parser (objects stay open,
only identity is required) so it can never refuse a document the app accepts.

The crawler publishes **facts, not copy**. `surfaces`, `sockets` and `isTheme`
say what a plugin extends; the sentences an install dialog shows are derived by
the app from the manifest, so there is exactly one place that wording lives.

## How a plugin gets listed

1. Publish a public repository with a valid `plugin.json` at its root.
2. Add the `ade-plugin` topic to it.

That is the whole process. The crawler finds the topic every six hours, reads
`plugin.json`, and adds an entry. There is no submission, no review queue, and
no account — a directory that requires permission to be in stops being a
directory.

Being listed is not an endorsement, and the UI says so: community entries carry
their author and no Official mark.

## Download size

Each entry carries a `sizeBytes`, and the Marketplace shows it on the plugin's
page. The crawler derives it from GitHub's own `size` for the repository, which
is reported in kilobytes and measures the packed repository rather than a
release artefact — so it is an **estimate**, deliberately. The alternative is
cloning every repository in the topic on every crawl to weigh it exactly, and
the question a reader is actually asking ("a few hundred KB, or enormous?") is
answered fine by an estimate. A repository GitHub has not sized yet reports `0`,
and `0` is omitted rather than published: readers render an absent size as
nothing, so a published zero would say "this weighs nothing" on ADE's own page.

A plugin that downloads something for **itself** on first use — a model, a
runtime, a data pack — should say so in its `plugin.json`:

```json
{
  "name": "ade-voice",
  "extraDownloads": [{ "label": "Speech model", "bytes": 147800000 }]
}
```

The crawler passes that through to the entry (up to four items, labels up to 60
characters, each with a positive byte count; anything else is dropped), and the
Marketplace shows it as its own line — "Downloads a further 141 MB (Speech
model) the first time you use it." It is a separate figure rather than part of
the package size on purpose: the second download happens later and only for
people who use the feature, and one combined number would say neither of those
things.

Note that `extraDownloads` is read by the **crawler**, not by ADE's manifest
parser: the app's `manifest.ts` does not model the field, because the registry
entry is what the Marketplace reads. Declaring it changes what the directory
publishes, not how the plugin runs.

## Official

`official` is set from `official.json` and from nowhere else. A plugin's own
manifest can say `"official": true` — anyone can write that in a JSON file — so
the crawler ignores the manifest's claim entirely. Being official is a statement
ADE makes about a plugin, never one the plugin makes about itself.

`official.json` also binds each official id to one repository. A different repo
publishing a manifest that claims a bound id is refused outright rather than
listed as a community plugin, because a second "graph" beside the official one
is exactly the confusion the binding exists to prevent.

The lookup is a `Map` built with `Object.hasOwn`, and that is load-bearing:
`constructor`, `toString` and `__proto__` are all valid plugin ids, and looking
them up on a plain object resolves them up the prototype chain to something
truthy. A repository publishing `{"name": "constructor"}` was enough to be
stamped Official — with no checksums, so it installed as "vouched for by ADE,
verified against nothing". `scripts/crawl.test.mjs` pins it.

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
  Community plugins live here permanently, and that is the whole point: the
  digest is a tamper check on the directory's own claim, not a licence to run.

An OFFICIAL entry is where "unverified" stops being acceptable, and the
installer owes two rules:

- **Read the directory fresh.** The entry behind the check comes from
  `resolveEntryForVerification` (`apps/ade-cli/src/services/plugins/pluginRegistryService.ts`),
  which confirms the index against the network on that call and answers
  `unreachable` rather than falling back to the cache. A digest that never left
  the machine proves nothing about what the directory currently vouches for, and
  a cold cache would silently downgrade every official install to unverified.
- **Refuse what cannot be verified.** For an id the directory publishes as
  official, a requested version with no digest refuses the install rather than
  proceeding unverified — otherwise "we verify official plugins" would mean "we
  verify them except on the version an attacker picked". When the directory
  could not be reached at all there is no entry to read, so the check falls back
  to the staged manifest's own `official` claim and refuses on that: a plugin
  lying about being official gets refused, and one lying the other way was never
  going to be verified anyway, so reading the claim there can only add refusals.

The tree digest is defined as:

    git -c core.autocrlf=false archive --format=tar <tag> | sha256sum

`core.autocrlf` is pinned, not incidental. It is a per-machine git setting, on
by default on Windows, and it rewrites line endings inside the archive — so the
same tag digests differently on a Windows machine than on the one that published
the number, and the mismatch shows up as "this official plugin has been
tampered with" on the one check that must never cry wolf. The verifier pins it
the same way. Recording the recipe matters more than the choice: a digest nobody
can reproduce is decoration, and one that only reproduces on some machines is
worse than none.

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
- **A machine may claim at most 50 NEW plugins per day** (`PLUGIN_INSTALL_DAILY_CLAIM_CAP`).
  The row key already stops a machine inflating any single plugin past one; the
  cap bounds breadth, so one signed machine cannot add an install to a thousand
  ids at once. Re-reporting a plugin it already has is always accepted — that is
  what keeps its rows inside the retention window, and it can never move a count.
- **The public endpoint returns totals only.** No machine key, no version, no
  timestamps — one integer per plugin id. It is unauthenticated because the
  numbers are published in this file anyway.
- **Rows expire after 180 days without a re-report,** so a count reflects
  machines still running ADE rather than growing forever.
- **`ADE_PLUGIN_INSTALL_PINGS=0` turns it off** on a machine, and everything
  else keeps working; that machine simply is not counted.

What remains, stated plainly: the count is a count of *signed machines that
reported an install*, not of people. Somebody with many registered machines has
proportionally many votes, and the cap above bounds how fast one machine can
spread its votes rather than making them impossible. That is the accepted
trade — the alternative is an account-scoped identity attached to install
telemetry, which is a far worse thing to build than a slightly gameable
popularity sort. The number is never a security signal, and nothing in ADE
treats it as one.

## Extraction

To move this into `github.com/arul28/ade-plugins-registry`:

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

**Sequencing, for the ten plugins ADE bundles.** Do not publish directory
entries for them until their repositories actually exist. A directory entry
REPLACES the bundled listing for the same id — `mergeMarketplaceCatalogue` is
last-writer-wins by plugin id — so the Install button stops resolving the
bundled copy on disk and starts cloning the entry's `repo`. While those
repositories are empty that turns a working offline install into a failing one.
The index format cannot soften this: `repo` must be an https URL or the entry is
dropped, and `source` falls back to `repo` unless it is also a URL
(`registryIndex.ts:212` and `:215`), so a directory entry can never name a
bundled package. Either create the repositories first, or leave those ten ids
out of the first published index and let the bundled listings serve them.

Until then, ADE works without any of it: the Marketplace ships a bundled index
of the official plugins (`marketplaceLocalIndex.ts`), and a live index layers on
top when one becomes reachable.

### What the seed index does NOT claim

`seed-entries.json` is hand-written, and it names repositories under
`github.com/arul28` that **do not exist yet**. Those are where these
plugins will be published; today the packages live in this repository under
`plugins/`, and the app installs them from its own bundled copy. So the seed is
a directory of ids and descriptions, not a set of working install sources — an
install driven from this file would have nothing to clone.

That is also why it carries no `installs`, `stars`, `sizeBytes`, `publishedAt`
or `updatedAt`. Those are things the crawler measures, and inventing them would put
numbers in front of a reader that nobody measured. An omitted count renders as
nothing; a zero would render as a measurement.

## Local development

Serve a copy of `index.json` and point ADE at it:

    cd registry && python3 -m http.server 8080
    ADE_PLUGIN_REGISTRY_URL=http://127.0.0.1:8080/index.json ade ...

Plaintext is accepted only for loopback hosts; every other override must be
`https`, and an unusable one falls back to the published URL rather than
disabling the directory.

To run the crawler against the live topic without publishing:

    GITHUB_TOKEN=$(gh auth token) node registry/scripts/crawl.mjs

It rewrites `index.json` in place and writes nothing else — and refuses to write
at all if what it assembled does not match `schema/index.schema.json`.

To exercise it without a network, against fixtures:

    node --test registry/scripts/crawl.test.mjs

Those cases build a throwaway registry per run, so nothing here is touched.
No vitest project collects them — the ADE suites only collect `src/**` — so ADE
CI runs them directly, in the `typecheck-ade-cli` job's `node --test` step,
alongside the other repo scripts vitest cannot see. Without that they were green
by never running, and this directory is where a silent break is most expensive:
a crawler that drops entries publishes a directory missing plugins, with nothing
anywhere saying why. After extraction they become the registry repository's own
CI and the ADE step drops the path.
