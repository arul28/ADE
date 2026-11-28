# Agent tools cache

DAEX runs its own pinned, checksum-verified copy of every agent CLI and runtime.
It never runs a CLI the user installed: no PATH lookup, no common install
directories. Copies download on demand into a machine-level, version-addressed
cache shared by the desktop app, the brain and every release channel. Nothing
is vendored into the app or the brain tarball. Internet at first use is a
requirement, not a degraded mode.

Three rules hold for every copy DAEX runs (chats, auth probes, model discovery,
one-shots, terminals):

- **DAEX's copy only.** A miss is a download state, never filled from the PATH.
  A host with no vendor build reads "not available on this machine". A user who
  wants their own version opens a plain shell.
- **Vendor self-update is off**, so the bytes on disk match the pin (see
  [Self-update switches](#self-update-switches)).
- **Logins stay in the default config homes** (`~/.claude`, `~/.codex`,
  `~/.copilot`, `~/.factory`, `~/.grok`, `~/.qwen`, `~/.kimi-code`, `~/.gemini`,
  `~/.pi/agent`, `~/.config/muse`, Devin's XDG dirs). DAEX's copy reads the same
  login as the user's own CLI and never writes the user's config files.

## Source file map

- `apps/ade-cli/src/services/tools/`: the cache.
  - `toolsManifest.generated.json`: every pin (the source of truth for versions,
    URLs, integrity and entry paths). `manifest.ts` validates it at load time as
    untrusted input and holds `allowedDownloadHosts`.
  - `install.ts` (`ensureTools`, staging, sentinel), `download.ts`,
    `extract.ts`, `diskSpace.ts`, `lock.ts`, `errors.ts` (`ToolError`).
  - `paths.ts` (root and layout), `toolRoots.ts`, `systemCache.ts`, `usage.ts`
    (use record), `inUse.ts` (hold installs a process runs from).
  - `cacheLookup.ts`, `pinnedTool.ts`: resolver cache steps and
    `getPinnedToolStatus`. They never throw.
  - `onDemand.ts`: on-demand downloads; `backgroundFetch.ts`: the brain's
    startup pass.
  - `gc.ts`, `ledger.ts`, `overrides.ts`: collection, the package ledger,
    fall-forward records.
  - `muse.ts`: the Muse resolver (desktop re-exports it from
    `museExecutable.ts`).
- `apps/ade-cli/scripts/generate-tools-manifest.mjs`, `pin-tool.mjs`,
  `pin-muse-release.mjs`, `scripts/pins/<tool>.json`, `muse-release.json`:
  pin inputs and generators.
- `apps/ade-cli/src/commands/tools.ts`: `daex tools`.
- `apps/desktop/src/main/services/tools/agentToolDemand.ts`: which tools a
  machine fetches at startup. `agentToolsCacheService.ts`: the desktop launch
  pass.
- `apps/desktop/src/main/services/ai/pinnedProviderTools.ts`: provider → tool
  map, the blocker sentence, `requirePinnedProviderExecutable`.
- `apps/desktop/src/main/services/ai/claudeFallForward.ts`,
  `codexFallForward.ts`, `museFallForward.ts`, `providerVersionRejection.ts`:
  fall-forward.
- `apps/desktop/src/shared/pinnedToolSpawnEnv.ts`: self-update switches.
- `apps/desktop/src/renderer/hooks/usePinnedToolStatus.ts`,
  `settings/providers/bodies/PinnedToolStatusRow.tsx`: the status row.
- `apps/ade-cli/scripts/native-deps-entry-filter.mjs`
  (`RUNTIME_FETCHED_TOOL_PACKAGES`): packaging exclusions.

## What is fetched

Fetched: Codex, Claude Code (the binary half of the Agent SDK), OpenCode, the
Copilot SDK runtime (`copilot`) and Copilot CLI (`copilot-cli`), Cursor CLI,
Droid, Grok, Qwen Code, Kimi Code, Devin, Antigravity (`agy`), Pi (an npm tree),
Node (Pi's terminal runtime only) and Muse. Versions are in the manifest.

Still bundled: `@cursor/sdk` (Cursor chats; small, reached by bare `import()`),
`@factory/droid-sdk` (pure JS), and the JS launcher/SDK halves of the npm tools
(`@anthropic-ai/claude-agent-sdk`, `@openai/codex`, `@opencode/client`,
`@github/copilot-sdk`). Only their native platform siblings move to the cache.

## The manifest

`generate-tools-manifest.mjs` builds it offline from checked-in inputs:

| Input | Tools |
|---|---|
| `apps/ade-cli/package-lock.json` | `codex`, `claude-code`, `opencode` |
| `apps/desktop/package-lock.json` | `copilot` (paired with `@github/copilot-sdk`, a desktop dependency; an SDK bump alone fails `tools:manifest:check`) |
| `apps/ade-cli/scripts/muse-release.json` | `muse` (generation fails when its `sdkVersion` is not the locked `@muse-code/sdk`) |
| `apps/ade-cli/scripts/pins/<tool>.json` | `droid`, `grok`, `qwen`, `kimi`, `devin`, `antigravity`, `pi`, `copilot-cli`, `cursor-cli`, `node` |

Lockfile pins carry `checkoutCopy: true`: a source checkout resolves them from
`node_modules` and never downloads them.

Pin formats: `npm-tarball` (SRI-checked, optional brotli `decompress` step for
Grok), `file` (the download is the binary: Muse), `archive` (sha256 and size
checked **before** unpacking), `npm-tree` (every package at its lockfile path,
no install scripts). An entry may name extra required `files` (Qwen's and
Cursor's `script`, Pi's `module` and `cli`); an install that lacks one is not
usable. A `*` in an entry path matches one directory level (Codex nests its
binary under a Rust target triple).

Node-run tools spawn as `<entry> <script> …`, never through a `.cmd` shim or
Electron-as-Node; the ACP spawn context carries the leading args as
`binaryArgs`.

**Gotchas**

- The Codex pin's `package` is the install directory name
  (`@openai/codex-darwin-arm64`), an npm alias; the tarball is published under
  `@openai/codex` with a target-suffixed version.
- Windows x64 OpenCode is always `@opencode/cli-windows-x64-baseline` (the AVX2
  build dies on older CPUs). The name is mirrored in
  `openCodeBinaryManager.ts` (`OPENCODE_PLATFORM_PACKAGES`), the generator,
  `native-deps-entry-filter.mjs` and `apps/desktop/package.json`; move them
  together.
- Each pin downloads only from its own hosts (`allowedDownloadHosts`); every
  redirect is checked and HTTPS is required.

## Muse: a direct-file pin

Meta publishes `muse` as one bare executable per platform, so its pins are
`format: file` with `url`, `sha256` and `size`. `install.ts` writes it straight
to the entry path, checks sha256 and size, marks it executable and publishes it
with the same atomic rename. The disk preflight uses the pinned size plus
256 MiB.

`npm run tools:muse-pin` is the only network step: it reads the locked
`@muse-code/sdk`, picks the paired binary build (`<sdk version>-R…`), and writes
`muse-release.json` from Meta's manifest. Settings › Providers › Muse Code can
start the download on the page's machine (`ai.ensureMuseBinary`, returns at
once) and poll it (`ai.museBinaryStatus`), because 350+ MB must not hold a
remote action open.

## Cache layout on disk

`resolveMachineToolsRoot` / `resolveToolsRootLayout` (`paths.ts`):

| Condition | Root |
|---|---|
| `ADE_TOOLS_ROOT` set | that path |
| `ADE_SYSTEM_CACHE_ROOT` set | `<that>/tools`, with the per-user root as fallback |
| `win32` | `%LOCALAPPDATA%\ADE\tools` (never roaming) |
| otherwise | `~/.ade/tools` |

- **Not derived from `ADE_HOME`**, which is channel-scoped. Stable, Alpha and
  the brain share one copy; contents are addressed by exact package and
  version, so channels never mix builds.
- **Baked roots** (`ADE_TOOLS_BAKED_ROOTS`): read-only caches an image ships
  (DAEX Cloud's `/opt/ade-tools`), used only while their version is the pin.
  Never collected.
- **System cache** (`ADE_SYSTEM_CACHE_ROOT`, budget
  `ADE_SYSTEM_CACHE_BUDGET_BYTES`, default 7 GB): installs go there when they
  fit; before an install, old entries are evicted by last use. A tool used in
  the last 24 hours and any install a running process holds
  (`holdToolInstallsWhileRunning`) are never evicted.
- **Use record** (`.last-used.json`, `usage.ts`): when each tool last ran,
  written right before a spawn, in the per-user root.

```
<tools root>/
  <package>/<version>/…           one directory per exact version
    .install-complete             sentinel (TOOL_INSTALL_SENTINEL)
  .staging/  .locks/
  .installed-packages.json        GC ledger
  .version-overrides.json         fall-forward records (Claude, Codex, Muse, Devin)
```

Vendor pins use their own directory names (`devin-<target>`,
`qwen-code-<target>`, …).

- **Publish is atomic.** An install runs in `.staging/<slug>-XXXXXX/` under the
  same root, then renames the finished payload into place.
- **Usable = sentinel + entry.** `readInstalledEntry` (`install.ts`) requires
  both; a directory without a usable entry is a crashed install, removed and
  refetched.
- **Cross-process lock** (`lock.ts`): `O_EXCL` create under `.locks/` per
  `package@version`. The holder refreshes its mtime; `STALE_LOCK_MS` (60 s)
  trips only on a crash; `LOCK_TIMEOUT_MS` is 15 min. A dead PID proves a stale
  holder only on the same `host`. Heartbeat and release check that the record
  is still this process's. On Windows, `EPERM`/`EACCES`/`EBUSY` count as
  contention (`isToolLockContention`).
- `ensureTools` installs serially on purpose (disk-full profile).

## Resolution order

Every provider resolver uses the same order:

1. **Env override**: a developer/test hook only; no UI sets it.
2. **Fall-forward override**: Claude Code, Codex and Muse only. Devin's
   deleted-pin override stands in for the pin itself, at step 3 (below).
3. **Current pin** in the tools cache.
4. **`node_modules` copy**: source checkouts only, lockfile tools only
   (`codex`, `claude-code`, `opencode`, `copilot`). Muse has no checkout copy.
5. **Previous pin**, which GC keeps so a machine downloading a new pin can
   still run.
6. **Missing**: `source: "fallback-command"` with an **empty** `path` (OpenCode:
   `missing`). Nothing spawns a bare command name, so a forgotten call site
   fails instead of running a PATH CLI.

Neither package keeps a second resolver: `apps/ade-cli` imports the desktop
main-process resolvers (`ai/claudeCodeExecutable.ts`, `ai/codexExecutable.ts`,
`opencode/openCodeBinaryManager.ts`, `ai/acpExecutables.ts`,
`ai/droidExecutable.ts`, `ai/piInstallation.ts`, `ai/pinnedProviderTools.ts`),
and Muse runs the other way. Each resolver's env override is named at the top
of its file. Every resolver reports its source; `tools-cache` is distinct from
`bundled`.

### Status and the Download/Retry action

`getPinnedToolStatus(name)` (`pinnedTool.ts`) reports `ready` (current or
previous pin; `runningVersion` says which), `downloading` (in this process,
with bytes), `failed` (with `errorKind`), `missing` (with `fetchAllowed`) or
`unavailable` (no pin for this host). Status is per process: a download in
another process reads `missing` until it lands.

Two runtime actions in the `ai` domain, reachable remotely:
`ai.pinnedToolStatus {provider}` (no entry path) and `ai.pinnedToolDownload
{provider}` (calls `retryPinnedToolDownload`, ignores the failure backoff,
returns at once). The preload methods take a `pin` and route through
`callPinnedOrBoundRuntimeActionOr`, so Settings and the chat card act on the
machine that owns the row or chat. `usePinnedToolStatus` reads once per
provider and `pin?.key`, polling 1 s only while downloading.

Runtime starts, one-shots and automations call
`requirePinnedProviderExecutable`, which awaits the download and throws
`PinnedToolNotReadyError` on a miss.

### Self-update switches

Every spawn of a pinned copy applies `shared/pinnedToolSpawnEnv.ts` (env vars,
or a flag where the tool has no env switch: Codex
`-c check_for_update_on_startup=false`, Cursor `--disable-auto-update`). Qwen's
switch lives in DAEX's own system-defaults file; the user's
`~/.qwen/settings.json` is never written. Devin and Muse have none. A pin bump
must re-check that the switch still exists.

### Claude fall-forward

Claude moves past its pin only when Anthropic provably refuses the pinned build
as too old (`providerVersionRejection.ts` matches exact typed signals such as
`cli_version_too_old`; network, auth, rate-limit and crash errors never match).
`claudeFallForward.ts` installs npm's `latest` platform package through the
normal npm path, probes it (`--version`, `auth status --json`) and only then
writes a record to `.version-overrides.json`. A build that fails the probe is
deleted at once.

Shared rules for every override (Claude, Codex, Muse):

- Active only while its `pinnedVersion` equals the current pin and its install
  is complete. A new pin ends it with no extra code.
- Never counts as the previous pin. GC keeps recorded override dirs and drops
  records unused for 14 days.
- One attempt per pinned version per process; a refusal of the override itself
  stops (`newest-refused`).
- Gated by `pinnedToolFetchAllowed`: tests, `ADE_DISABLE_TOOLS_FETCH=1` and
  source checkouts never fall forward; an env override is left alone.
- The status row reads "Running untested <Tool> X: <vendor> stopped supporting
  Y" (`PinnedProviderToolStatus.notice`).

For Claude, a startup refusal restarts that turn once on the new build; a
mid-turn refusal shows a notice and resends nothing. Logs `ai.claude_fall_forward`.

### Codex fall-forward

Codex moves only when OpenAI refuses the pinned build for the chat's model
("The '<model>' model requires a newer version of Codex…", from an app-server
error or a failed turn, or a one-shot's non-zero exit). `codexFallForward.ts`
re-checks the refusal with one short request, installs npm's `latest`, probes it
for that model with an isolated `codex exec` (temp `CODEX_SQLITE_HOME` and
`log_dir`, so a newer build never migrates the user's databases), and writes the
record with `scope` = the model. Each probe costs one short request of the
user's Codex quota; the notice says so. The override switches every Codex on
the machine. A chat never resends; an idle app-server is torn down so the next
message starts the new build. Logs `ai.codex_fall_forward`.

### Muse vendor floor

Muse has no refusal to detect. Every Muse host start calls
`checkMuseVendorFloor` (`museFallForward.ts`, at most every 4 hours) against
Meta's channel document. Below the floor, with a channel build of the same
release, DAEX falls forward (a `file` pin, `reason: "vendor_min_version"`);
otherwise the status line asks the user to update DAEX.

### Devin fall-forward (deleted pin)

Devin's CDN keeps only its current release; an older archive answers HTTP 403.
When a tracked download of the pin (`trackPinnedToolFetch` in `onDemand.ts`:
a chat, a CLI, a Retry, and the launch and `daex serve` prefetches) fails
with HTTP 403 or 404, and only then (never a
network error or a 5xx; `isDeletedPinFailure`), the registered
`DeletedPinFallback` (`ai/devinFallForward.ts`) reads
`static.devin.ai/cli/current/manifest.json` (the pin's own source), takes this
target's URL and sha256, installs it through the tools cache (Devin's host
only; sha256 and size checked before unpacking), checks `devin --version`, and
records an `archive` override with `reason: "vendor_pin_deleted"`. Such a
record stands in for the pin: `lookupCachedTool`, `resolveCurrentPinnedTool`,
the status (`ready`, `runningVersion` the new build) and
`pinnedToolFetchPending` all take it once the pin itself is not on disk
(`resolveDeletedPinReplacement`). The person sees nothing new. The switch logs
`ai.devin_fall_forward` and sends one Sentry warning per install (fingerprint
`tool-pin-deleted/devin/<pin>`, versions only) so the pin gets moved. A failed
attempt keeps the download failure; the next start tries again.

Copilot has no fall-forward: its runtime is paired with the SDK. The org-policy
refusal shows the required and pinned versions.

## Dev checkouts

A checkout resolves the lockfile tools from `node_modules`. Every other pin
exists only as a download, so a dev desktop and a checkout `daex serve` turn on
fetch in **download-only** mode (`enablePinnedToolFetch(logger, {
downloadOnly: true })`). The startup pass stays packaged-only. Claude never
falls through to the developer's own `claude`.

| Variable | Effect |
|---|---|
| `ADE_TOOLS_ROOT` | Use this root. Point validation runs at a temp dir. |
| `ADE_DISABLE_TOOLS_FETCH=1` | No download of any kind. Wins over everything. |
| `ADE_FORCE_TOOLS_FETCH=1` | A checkout `daex serve` behaves like a packaged install. |

Desktop never fetches under `NODE_ENV=test`.

## When the cache gets populated

Downloads happen only on demand or for tools the machine shows signs of using;
all pins together are well over a gigabyte.

### Which tools a machine fetches

`selectDemandedAgentTools` (`agentToolDemand.ts`) picks tools at startup from
file, env and PATH checks only (never a spawn): a tool that ran here in the last
30 days, or a provider's login file, API-key variable or CLI on the PATH (a PATH
CLI is only a sign of use; DAEX never runs it). Being in the cache is not a
sign. OpenCode is also fetched when no agent is set up, since its free models
are the only chat such a person can start. `ADE_TOOLS_PREFETCH` narrows it:
`signals` (default), `used` (recent use only, for a DAEX Cloud computer whose
sign-ins were all copied in) or `off`.

### Downloading on demand

`onDemand.ts` is off until a process calls `enablePinnedToolFetch` (desktop
`main.ts`, `daex serve`).

- `pinnedToolDownload(name)` is synchronous: it returns the running or new
  download, or `null` (on disk, not allowed, no pin, or failed less than two
  minutes ago). `retryPinnedToolDownload` is the user's Retry and ignores the
  backoff. One download per tool per process; the lock serializes processes.
  Both resolve and never reject.
- Who waits: chat runtime starts (the chat shows "Getting <Agent> ready"), one-
  shots, automation planning, OpenCode sessions and terminals, provider
  terminals (`pty/pinnedProviderCli.ts` prints that it is downloading and types
  the launch when it lands), `daex harness env`.
- A DAEX Cloud launch that knows its agent starts only that agent's tools
  early (`startPinnedToolsForLaunch`).
- **A status read never downloads**: not the AI status refresh, model lists,
  sign-in checks or usage reads. A provider whose copy is missing but
  downloadable and whose sign-in is on disk keeps its models and carries
  `runtimeDownloadPending`, so a chat can still start and its first turn
  downloads. Otherwise a DAEX Cloud computer with every sign-in copied would
  fetch every agent on every wake.
- Saving an API key (other than Cursor's) starts OpenCode's download.
- A landed download bumps `pinnedToolInstallGeneration()`, voiding cached
  status.
- Every download runs in the process that owns the chat, lane or status, on
  that machine's root.

### Brain startup

`daex serve` enables on-demand fetch and calls `startBackgroundAgentToolsFetch`
fire-and-forget after it listens (a cold cache must not leave RPC unanswered).
Each tool gets its own `ensureTools` call, so one failure does not abandon the
rest. GC runs only after a fully clean pass. Log lines: `tools.fetch_skipped`,
`tools.fetch_deferred`, `tools.fetch_progress`, `tools.fetch_complete`,
`tools.fetch_failed`, `tools.gc_complete`, `tools.gc_failed`.

The desktop's `agentToolsCacheService.ts` does the same on packaged launch and
keeps a per-tool snapshot (`ai.getToolsCache`). Resolution failures are per
tool, never per pass (`agentTools.resolve_failed`).

### `daex tools`

| Command | Behavior |
|---|---|
| `daex tools status` | Per-tool install state and the tools root. No network. A tool with no build for this platform (ffmpeg on macOS) is one row, `unsupported: true`, not in `missing`. |
| `daex tools ensure` | Fetch the demanded tools (same rule as the brain). |
| `daex tools ensure <names…>` / `--all` | Fetch exactly those, or every pin this platform has a build of. A named tool with none fails `unsupported-target`. |
| `daex tools gc [--dry-run] [--no-keep-previous]` | Collect, plus stale staging and locks. |

JSON by default; `--text` streams progress to stderr. A typed failure returns
`{ ok: false, errorKind, … }` and exits 1. `daex setup` ensures the demanded
set. The install scripts do not prefetch.

### Garbage collection

`gcTools` (`gc.ts`) runs after a clean startup pass and on `daex tools gc`,
over every root DAEX writes, never a baked root.

- Keeps the current pin and the newest superseded version (preferring a
  finished install), plus fall-forward dirs.
- A package the manifest no longer pins is removed only when it is in the
  ledger and unpinned by every DAEX run here for 14 days
  (`RETIRED_PACKAGE_GRACE_MS`), so another channel still using it keeps it.
- **Anything not in the ledger is left alone**: it probably belongs to another
  channel.

## Failure modes

`ToolError` (`errors.ts`) carries a typed `kind`. **Branch on `kind`, never on
message text.** `asToolError` keeps an existing kind.

| `kind` | Cause |
|---|---|
| `manifest` | Malformed manifest or unknown tool. |
| `unsupported-target` | No pinned build for this host (`win32-arm64`, musl Linux). |
| `network` | DNS, TLS, HTTP, redirect limit, truncation, idle socket, disallowed host. |
| `integrity` | Hash or size mismatch, checked before unpacking. Do not retry blindly. |
| `disk-space` | Preflight or `ENOSPC`; names required vs available bytes. |
| `extract` | tar/zip failure, hostile archive, missing entry or file. |
| `lock-timeout` | Another process held the lock past 15 minutes. |
| `filesystem` | Other mkdir/rename/unlink failures. |
| `not-installed` | Pinned but not fetched; callers start the download. |

- **Disk preflight** (`diskSpace.ts`): `file` size + 256 MiB; `archive`
  size × 4 + 256 MiB; npm tarballs use `Content-Length` before any body byte
  (384 MiB assumed without it). An unmeasurable volume proceeds.
- **No partial trees**: `.part` files renamed on completion, staging removed in
  a `finally`, publish by rename.
- **Hostile archives**: `extract.ts` uses the system `tar` (System32 bsdtar by
  absolute path on Windows), then `auditExtractedTree` refuses escaping
  symlinks and special files. Zips use DAEX's own streaming reader on every OS,
  which refuses symlinks, encryption, unsafe paths, duplicates and members that
  overrun their size or CRC.
- Downloads: HTTPS only, at most 5 redirects, a 30-second idle timeout on the
  body too.
- **macOS Gatekeeper**: files written by DAEX's Node process get
  `com.apple.provenance` but never `com.apple.quarantine`, so fetched binaries
  run without a Gatekeeper prompt. `probeOpenCodeBinaryQuarantine` still tells
  a quarantined binary apart from a bad signature.

## Packaging exclusions

The runtime native archive and the packaged desktop app both exclude the
fetched packages through one exact-name set, `RUNTIME_FETCHED_TOOL_PACKAGES`
(`native-deps-entry-filter.mjs`, re-exported by
`apps/desktop/scripts/runtime-fetched-tool-packages.mjs`). Exact names, not
prefixes: a prefix on `@anthropic-ai/claude-agent-sdk` would drop the SDK DAEX
calls in-process.

- `apps/desktop/package.json` needs a `"!node_modules/<name>/**"` entry in
  `build.files` for each, and no `asarUnpack` entry (dropping it from
  `asarUnpack` alone moves it into `app.asar`).
- `apps/desktop/scripts/after-pack-runtime-fixes.cjs` prunes them and throws if
  any remains.
- `validate-mac-artifacts.mjs` / `validate-win-artifacts.mjs` fail on
  `source === "bundled"`.

## Bumping a pinned version

A bump is a product change: run the new version in DAEX before it merges.

- **Lockfile tools**: edit the version in `apps/ade-cli/package.json`,
  reinstall, run `npm run tools:manifest` in `apps/ade-cli`, commit manifest and
  lockfile together. `@github/copilot-sdk` is bumped in `apps/desktop` first;
  `@muse-code/sdk` in both apps, then `npm run tools:muse-pin`.
- **Vendor pins**: `npm run tools:pin -- <tool> [version]` (newest stable by
  default; `--latest-version` prints it). Set `GITHUB_TOKEN` for `qwen` and
  `kimi`. A Pi bump also re-checks its CLI path and the SDK surface
  `piSdkWorker.ts` uses.
- **Daily workflow** `.github/workflows/agent-tool-pins.yml` opens one
  `pins/<item>` PR per tool or SDK with the bump and regenerated manifest, and
  dispatches `ci.yml` on it. It closes the PR when main catches up.
- **Before merging**: `npm run tools:manifest:check` passes (the CI drift gate
  and `pretest`); a chat or terminal, sign-in status, model list and resume work
  on a real machine with a temp `ADE_TOOLS_ROOT`; the self-update switch and
  entry paths still hold.

The old copy is not stranded: GC keeps the newest superseded version, and a new
pin ends any fall-forward override.

## Cross-links

- ACP providers (spawn plans, `binaryArgs`):
  [../chat/acp-providers-spec.md](../chat/acp-providers-spec.md)
- Copilot SDK runtime and terminal CLI:
  [../chat/copilot-sdk-provider.md](../chat/copilot-sdk-provider.md)
- Log lines: [../../logging.md](../../logging.md)
