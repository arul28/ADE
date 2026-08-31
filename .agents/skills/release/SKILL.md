---
name: release
description: 'ADE release conductor: detect whether desktop, iOS, and/or the Cloudflare web tier actually changed, bump desktop patch versions, keep iOS marketing versions fixed while bumping build numbers, ship desktop through the GitHub Actions release workflow, distribute TestFlight builds to all beta users, and reconcile every Cloudflare surface (Pages web client, the four Workers, D1 migrations, R2 buckets and lifecycle rules, Durable Object migration tags, cron triggers, vars and secrets) against what actually exists in the Cloudflare account.'
---

# ADE Release Skill

Use this skill when the user wants to release ADE, automate releases from a
cron/agent, decide whether a release is needed, publish a desktop release, ship
a TestFlight build, or reconcile the hosted Cloudflare surfaces.

ADE ships **three independent tiers**, and a release conductor owns all three:

- **desktop** — GitHub Actions release workflow, macOS + Windows assets
- **iOS** — local ASC archive/export/upload to TestFlight
- **Cloudflare web tier** — the `ade-web-client` Pages project and four Workers,
  plus the account-side state they depend on (D1 databases and their applied
  migrations, R2 buckets and their lifecycle rules, Durable Object migration
  tags, cron triggers, vars, secrets). Phase 5.5 owns this. Neither the desktop
  workflow nor TestFlight touches it, and most of its failure modes are invisible
  to every test in the repository because they live in account state, not code.

This is a **GitHub desktop + local ASC iOS release flow**. Desktop releases must
use the repository GitHub Actions release workflow for **both** platforms: macOS
updater assets are produced reproducibly as per-arch ZIP/DMG artifacts on a macOS
runner, and the signed Windows installer is produced on a Windows runner. Neither
is built from the release host, whatever that host is — macOS and Windows are
peers here, not a primary and a follow-up.

The release host runs checks, creates release docs/tags, and monitors and
recovers the workflow. The only host-dependent phase is iOS: building and
uploading TestFlight releases through ASC requires a macOS host. On a Windows
host, run the desktop release normally and stop before the mobile phase, stating
that iOS needs a macOS host — do not report a desktop-only release as complete
when iOS was also in scope.

A **preflight** is a cheap check that runs before expensive build/upload work.
Use preflights to catch release blockers while fixes can still be committed
without burning a notarization, TestFlight upload, or build number.

## Hard Rules

- **No-op is valid.** If no relevant product code changed, do not create a
  release just to bump numbers.
- **Desktop and iOS are independent.** Release desktop without iOS when only
  desktop changed; release iOS without desktop when only iOS changed.
- **Desktop version bumps the patch segment only** unless the user explicitly
  asks otherwise: `v1.2.14 -> v1.2.15`.
- **iOS marketing version does not change** unless the user explicitly asks.
  Only bump the TestFlight build number by one, using App Store Connect as the
  source of truth.
- **Do not omit App Clip in normal releases.** The v1.1.10 build 16 omission was
  an emergency unblock. Normal mobile releases must include the app, widgets,
  and App Clip after signing is fixed.
- **Desktop release uses GitHub Actions only.** Do not build, sign, notarize, or
  upload desktop release assets from the release host unless the user explicitly asks
  for a one-off manual recovery.
- **No universal updater ZIPs.** `latest-mac.yml` must reference per-arch
  `arm64` and `x64` ZIPs. Never publish a `latest-mac.yml` that points to
  `ADE-*-universal.zip`; v1.2.16 proved that giant universal updater ZIPs can
  crash Squirrel.Mac during in-app update.
- **Do not publish broken updater metadata.** Before making a desktop release
  public/latest, verify `latest-mac.yml` references assets that exist and that
  the expected arm64/x64 DMGs and ZIPs are present. When Windows is enabled,
  apply the same rule to `latest.yml` and the Windows installer.
- **Do not publish a half-platform release.** The Windows gate and the Windows
  assets must agree. If `ADE_WINDOWS_PUBLIC_RELEASE_ENABLED` is `1` the draft
  must carry Windows assets; if it is not `1` the draft must carry none. Either
  mismatch means the workflow did not do what you think it did, so keep the
  release draft/private and investigate before publishing.
- **Do not discover obvious release blockers after upload.** Preflight iOS App
  Clip packaging metadata before starting the expensive mobile phase.
- **Do not wait forever.** If GitHub notarization or TestFlight processing
  exceeds its normal window by a lot, preserve state, retry only the failed
  phase when possible, or stop with a clear recovery command.

## Machine Notes

Detect the release host rather than assuming it (`uname -s` / `process.platform`)
— this lane runs on Windows or on an Apple Silicon Mac. Either way, desktop
release artifacts for both platforms are produced remotely by GitHub Actions;
treat local desktop packaging scripts as diagnostic/recovery tools only. Host
type affects exactly two things: shell syntax for the commands below, and
whether the iOS/TestFlight phase can run at all (macOS only).

Desktop updater correctness requires, on macOS:

- `latest-mac.yml`
- one arm64 ZIP and one x64 ZIP referenced by that file
- one arm64 DMG and one x64 DMG
- no universal ZIP in the updater feed

and, when `ADE_WINDOWS_PUBLIC_RELEASE_ENABLED` is `1`, additionally on Windows:

- `latest.yml`
- one `ADE-<VERSION>-win-x64.exe` installer referenced by that file
- the matching `ADE-<VERSION>-win-x64.exe.blockmap`

Windows builds fresh on the tag alongside macOS. There is one repository
variable, `ADE_WINDOWS_PUBLIC_RELEASE_ENABLED`; it decides whether the release
carries Windows at all. Read it before verifying assets, because it determines
which of the two asset matrices below is correct.

## State and Locking

Create a state file before mutating release state:

```bash
mkdir -p .ade/release
```

Use a path like:

```text
.ade/release/release-YYYYMMDD-HHMMSS.json
```

Track:

```json
{
  "desktop": { "needed": false, "version": null, "tag": null, "lastTag": null, "platforms": null },
  "ios": { "needed": false, "marketingVersion": null, "buildNumber": null, "lastTag": null },
  "cloudflare": {
    "needed": false,
    "driftPreflight": "pending|pass|blocked",
    "surfaces": {
      "ade-web-client": { "changed": false, "action": "skip|ci|manual", "status": "pending|deployed|verified|blocked", "note": null },
      "ade-account-directory-production": { "changed": false, "action": "skip|ci|manual", "status": "pending|deployed|verified|blocked", "migrationsApplied": null, "note": null },
      "ade-github-webhook-relay": { "changed": false, "action": "skip|ci|manual", "status": "pending|deployed|verified|blocked", "migrationsApplied": null, "note": null },
      "ade-tunnel-relay": { "changed": false, "action": "skip|ci|manual", "status": "pending|deployed|verified|blocked", "note": null },
      "ade-push-relay": { "changed": false, "action": "skip|ci|manual", "status": "pending|deployed|verified|blocked", "migrationsApplied": null, "note": null }
    },
    "accountState": {
      "r2": {
        "ade-diagnostics": { "exists": null, "lifecycle30d": null, "devUrlDisabled": null, "customDomains": null },
        "ade-diagnostics-production": { "exists": null, "lifecycle30d": null, "devUrlDisabled": null, "customDomains": null }
      },
      "d1": {
        "ade-account-directory-production": { "exists": null, "idMatchesConfig": null, "migrationsPending": null },
        "ade-github-relay": { "exists": null, "idMatchesConfig": null, "migrationsPending": null },
        "ade-push-relay": { "exists": null, "idMatchesConfig": null, "migrationsPending": null, "triggersPresent": null }
      },
      "config": {
        "ade-account-directory-production": { "secretsBound": null, "varsSet": null, "unverified": [] },
        "ade-push-relay": { "secretsBound": null, "varsSet": null, "unverified": [] }
      },
      "cronTriggers": { "ade-account-directory-production": null, "ade-push-relay": null },
      "durableObjectMigrations": { "ade-github-webhook-relay": null, "ade-tunnel-relay": null },
      "productEnablement": { "r2": null }
    },
    "rollbacks": []
  },
  "phase": "detect|docs|desktop|ios|cloudflare|verify|done|blocked",
  "notes": []
}
```

For cron mode, also use a lock file under `.ade/release/` so two releases do not
overlap. If the lock is held by a live process, exit cleanly.

## Phase 0: Preflight

Keep this phase read-only except for the `.ade/release` state/lock files. Do
not edit release docs, bump versions, create tags, or upload artifacts until the
relevant preflights pass.

1. Sync repository state:

   ```bash
   git fetch origin --tags --prune
   git status --short
   git rev-parse --abbrev-ref HEAD
   ```

2. Release from `main`. If not on `main`, switch only after confirming the
   worktree is clean.

3. Do not proceed with uncommitted changes unless they are the release docs
   changes created by this skill.

4. Verify tools:

   ```bash
   gh auth status
   ```

   Do not block a desktop-only release on ASC auth. Run `asc doctor` after scope
   detection if iOS is in scope.

5. Verify the desktop GitHub release workflow exists:

   ```bash
   test -f .github/workflows/release.yml
   test -f .github/workflows/release-core.yml
   test -f .github/workflows/release-publish.yml
   gh workflow view release.yml --repo arul28/ADE
   ```

6. For desktop releases, verify the workflow path is the intended one before
   tagging:

   - `.github/workflows/release-core.yml` builds `dist:mac:arm64:signed`.
   - `.github/workflows/release-core.yml` builds `dist:mac:x64:signed`.
   - `.github/workflows/release-core.yml` builds `dist:win:signed` in
     `build-win-release`.
   - The publish job merges per-arch manifests into one `latest-mac.yml`.
   - The publish job attaches the Windows installer, its `.blockmap`, and
     `latest.yml` when the Windows gate is on.

   If the workflow has been changed to publish universal updater ZIPs, stop and
   fix the workflow before releasing.

7. For desktop releases, resolve the expected platform matrix before tagging.
   This decides what the draft must contain in Phase 4:

   ```bash
   gh variable get ADE_WINDOWS_PUBLIC_RELEASE_ENABLED --repo arul28/ADE 2>/dev/null || echo "unset"
   ```

   - `1` means the release must carry macOS **and** Windows assets. Record
     `platforms=mac,win`.
   - Anything else, including unset, means macOS only. Record `platforms=mac`.

   Windows signing is fail-closed: if the gate is `1` and the signing secrets
   are missing, the `verify` job stops the run in about a minute. Do not
   "fix" that by clearing the gate mid-release; fix the secrets or stop.

8. For iOS releases, preflight App Clip packaging metadata before archiving:

   ```bash
   xcodebuild -showBuildSettings \
     -project apps/ios/ADE.xcodeproj \
     -scheme ADE \
     -configuration Release \
     -json > .ade/tmp/ios-release-build-settings.json
   ```

   Confirm from the JSON/build settings:

   - `ADE`, `ADEWidgets`, and `ADEClip` targets are present in the `ADE` scheme.
   - `ADEClip` Release `IPHONEOS_DEPLOYMENT_TARGET` matches the parent app
     baseline when Apple requires it. Current known-good value is `26.0`.
   - `ADEClip` has `ASSETCATALOG_COMPILER_APPICON_NAME=AppIcon`.
   - `ADEClip/Info.plist` includes valid App Clip store metadata, supported
     interface orientations, and device family values accepted by App Store
     validation.
   - `apps/ios/ExportOptions.auto.plist` exists; prefer it for local ASC-backed
     archive/export.

   If any of these fail, fix and commit before archiving. Do not upload an IPA
   produced from uncommitted project-signing or App Clip metadata changes.

## Phase 1: Detect Release Scope

Do this separately for desktop and iOS.

### Desktop scope

Find the latest public desktop release tag:

```bash
DESKTOP_LAST_TAG=$(git tag --list 'v*' --sort=-v:refname | head -n 1)
git diff --name-only "$DESKTOP_LAST_TAG..origin/main"
```

Desktop release is needed if any changed file matches:

- `apps/desktop/**`
- `apps/ade-cli/**`
- desktop/runtime release scripts under `apps/desktop/scripts/**`
- `.github/workflows/release*.yml`, `.github/workflows/update-brew-tap.yml`
- shared package files that desktop imports
- root package/build files that affect desktop packaging

Do **not** count these as product changes by themselves:

- `changelog/**`
- `docs/**`
- `sdk/**` (Mintlify SDK tab — handled under SDK / public docs scope)
- `docs.json`
- `CHANGELOG.md`
- pure website/docs assets

### iOS scope

iOS needs its own shipped marker. Prefer tags of this shape:

```text
ios-v<marketing-version>-build<build-number>
```

Find the latest one:

```bash
IOS_LAST_TAG=$(git tag --list 'ios-v*-build*' --sort=-creatordate | head -n 1)
```

If no iOS shipped tag exists, do not guess in cron mode. Ask once to bootstrap
from the latest known TestFlight build and create the first tag at the current
release commit after the next successful upload.

iOS release is needed if any changed file since `IOS_LAST_TAG` matches:

- `apps/ios/**`
- Swift/iOS-specific shared files
- iOS signing/export configuration

Do not use desktop tags to decide iOS scope once iOS shipped tags exist.

### SDK / public docs scope

This does **not** trigger a desktop GitHub release by itself. npm publish is
`publish-sdk-packages.yml` on merge to `main` (OIDC), not this conductor.

SDK Mintlify pages (`sdk/*.mdx`) and the two npm READMEs need an update if
since `$DESKTOP_LAST_TAG` (when desktop is in scope) — or, when checking an
SDK-only window, since the last commit that already shipped those docs — any
of:

- `packages/sdk/**`
- `packages/chat-ui/**`
- `apps/desktop/src/shared/callerMcpServers.ts` (honesty table)
- `apps/ade-cli` embedded profile / `parentDeathWatchdog`
- `sdk/*.mdx` already in the diff (verify they still match the code)

Print `SDK docs: <yes|no>` with that decision. User-visible contract changes
(install, threads, MCP residuals, chat-ui props, `doctor()` fields) are `yes`.
Internal-only test or comment churn is `no`.

### Scope outcomes

Print one concise decision:

```text
Scope: desktop=<yes|no> ios=<yes|no> sdk-docs=<yes|no>
Desktop since: <DESKTOP_LAST_TAG>
iOS since: <IOS_LAST_TAG or bootstrap-needed>
```

If desktop and iOS are both `no`:

- If `sdk-docs` is `yes`, **do not tag a desktop release**. Land or require the
  Mintlify/README updates on the SDK PR (or a docs-only follow-up). This
  conductor does not `npm publish`.
- If `sdk-docs` is also `no`, write state `phase=done` and stop.

## Phase 2: Resolve Versions

### Desktop

If desktop is in scope:

1. Parse latest tag `vMAJOR.MINOR.PATCH`.
2. Increment only `PATCH`.
3. New tag is `vMAJOR.MINOR.PATCH+1`.
4. Verify the tag and GitHub Release do not already exist.

Example:

```text
v1.2.14 -> v1.2.15
```

### iOS

If iOS is in scope:

1. Read the current marketing version from the Xcode project or latest ASC
   pre-release version. Do not change it.
2. Ask ASC for the next build number:

   ```bash
   asc builds next-build-number --app 6762759870 --version "$MARKETING_VERSION" --platform IOS
   ```

3. Use that build number. Do not hand-increment from local files if ASC says a
   different number is next.

## Phase 3: Release Notes and Docs

Only create public **desktop changelog** entries when desktop is in scope. A
mobile-only TestFlight build does not need a public desktop changelog unless
the user asks.

For desktop releases, update all release-doc surfaces:

- `changelog/v<VERSION>.mdx`
- `docs.json` (changelog page list)
- `changelog/index.mdx`
- root `CHANGELOG.md`

**Additionally, when `sdk-docs` is `yes`** (whether or not desktop is in
scope):

- Update the Mintlify **SDK** tab: `sdk/overview.mdx`, `sdk/install.mdx`,
  `sdk/quickstart.mdx`, `sdk/threads.mdx`, `sdk/mcp.mdx`, `sdk/chat-ui.mdx`,
  `sdk/runtime.mdx`, `sdk/reference.mdx`, and the `docs.json` SDK tab /
  footer links if pages were added or renamed.
- Keep the MCP honesty table aligned across `sdk/mcp.mdx`,
  `packages/sdk/README.md`, and `docs/features/sdk/README.md`. Strict MCP is
  **enforced only on Claude**; never market it as uniform. `mcpCapability`
  (`strictRequested` first, then `level === "enforced"`) is the honesty
  mechanism.
- Both npm READMEs (`packages/sdk/README.md`, `packages/chat-ui/README.md`)
  must link to `https://www.ade-app.dev/docs/sdk/overview` as the full docs.
  README edits publish on the **next** `@ade-dev/sdk` / `@ade-dev/chat-ui`
  version bump (`publish-sdk-packages.yml`). Do not `npm publish` from this
  skill.
- Register new Mintlify pages in `docs.json` before validating.

Then run:

```bash
node scripts/validate-docs.mjs
```

Commit and land the docs/release metadata on `main` before tagging. The desktop
release tag must point at the final `main` commit that includes the
changelog. An SDK-docs-only commit does not get a `v*` tag.

## Phase 4: Desktop GitHub Workflow Release

Do this only if desktop scope is `yes`.

The desktop happy path is GitHub Actions. Do not run local desktop release
commands such as `release:mac:local`, `dist:mac:universal:signed`,
`dist:mac:perarch:signed`, or manual `gh release upload` from the release host.

### Create the release tag

**The tag must point at a commit that already has a green `ci-pass` check run.**
`release-core.yml`'s `verify` job is fail-closed on it: it looks up the `ci-pass`
check run for the tagged SHA and exits 1 with
`No ci-pass check run was found for <sha>. Run CI before releasing.` when the
check is absent, still running, or red. Merging the release-docs PR and tagging
immediately is exactly how you hit this — the squash-merge creates a brand-new
commit on `main` whose CI has not started yet.

Wait for it before tagging:

```bash
RELEASE_SHA=$(git rev-parse origin/main)
gh api "repos/arul28/ADE/commits/$RELEASE_SHA/check-runs" \
  --jq '.check_runs[] | select(.name=="ci-pass") | {status,conclusion,html_url}'
```

Tag only when that prints `completed` / `success`. An empty result means CI has
not reported on the commit yet.

After release docs are committed on `main` and `ci-pass` is green:

```bash
git fetch origin --tags --prune
git status --short
RELEASE_SHA=$(git rev-parse origin/main)
git rev-parse --verify "v<VERSION>" >/dev/null && {
  echo "Tag v<VERSION> already exists"
  exit 1
}
git tag -a "v<VERSION>" "$RELEASE_SHA" -m "ADE v<VERSION>"
git push origin "v<VERSION>"
```

If you tagged early and `verify` failed, the tag is still correct and nothing
was published — do **not** delete or move it. Wait for `ci-pass` to go green on
the same SHA, then rerun only the failed job:

```bash
gh run rerun "$RUN_ID" --repo arul28/ADE --failed
```

The pushed tag triggers `.github/workflows/release.yml`, which calls
`.github/workflows/release-core.yml` and creates a draft GitHub Release.

### Find and watch the workflow run

Find the run for the pushed tag/SHA:

```bash
gh run list --repo arul28/ADE --workflow release.yml --event push \
  --json databaseId,headBranch,headSha,status,conclusion,createdAt,url \
  --limit 20
```

Choose the run whose `headBranch` is `v<VERSION>` or whose `headSha` matches
`RELEASE_SHA`, then watch it:

```bash
gh run view "$RUN_ID" --repo arul28/ADE --json status,conclusion,url,jobs
gh run watch "$RUN_ID" --repo arul28/ADE --interval 60
```

Expected shape:

- runtime/resource jobs run first
- `arm64 mac release` and `x64 mac release` build/sign/notarize independently
- `build-win-release` builds/signs/validates Windows independently, in parallel
  with the mac jobs, when `platforms` includes `win`. With the gate off it is
  skipped, and a skipped Windows job does not block the mac release.
- `publish-release` (in `release-publish.yml`, called by `release.yml` after
  `run-release` succeeds) merges the per-arch updater manifests and creates the
  draft
- `update-brew-tap` runs after publication

If `platforms=mac,win` and `build-win-release` did not run, stop. The gate and
the run disagree, and publishing would ship a macOS-only release under a
version that is supposed to carry Windows.

### Retry policy

Do not start duplicate full release workflows.

If a job fails or is cancelled:

```bash
gh run rerun "$RUN_ID" --repo arul28/ADE --failed
```

If one mac notarization step sits far beyond recent normal history, treat it as
stuck instead of waiting forever. Recent normal mac notarize/staple time has
been about 6-8 minutes; use 12-15 minutes as the practical cutoff unless GitHub
logs show useful progress. Cancel only the stuck run, then rerun failed jobs:

```bash
gh run cancel "$RUN_ID" --repo arul28/ADE
gh run rerun "$RUN_ID" --repo arul28/ADE --failed
```

If GitHub cannot recover after one narrow rerun, stop and report the failing job
URL/log excerpt. Do not switch to local desktop publishing unless the user
explicitly authorizes a manual recovery.

### Draft release verification

When the workflow succeeds, the release should still be draft/private. Verify
the draft before publishing:

```bash
gh release view "v<VERSION>" --repo arul28/ADE --json tagName,isDraft,url,assets
rm -rf ".ade/tmp/release-v<VERSION>-verify"
mkdir -p ".ade/tmp/release-v<VERSION>-verify"
gh release download "v<VERSION>" --repo arul28/ADE \
  --pattern latest-mac.yml \
  --dir ".ade/tmp/release-v<VERSION>-verify" \
  --clobber
cat ".ade/tmp/release-v<VERSION>-verify/latest-mac.yml"
```

When `platforms` includes `win`, also pull the Windows updater feed:

```bash
gh release download "v<VERSION>" --repo arul28/ADE \
  --pattern latest.yml \
  --dir ".ade/tmp/release-v<VERSION>-verify" \
  --clobber
cat ".ade/tmp/release-v<VERSION>-verify/latest.yml"
```

Required assets, always:

- `ADE-<VERSION>-arm64.dmg`
- `ADE-<VERSION>-arm64.zip`
- `ADE-<VERSION>-x64.dmg`
- `ADE-<VERSION>-x64.zip`
- `latest-mac.yml`
- `install.sh`
- `SHA256SUMS`
- `ade-darwin-arm64`, `ade-darwin-x64`, `ade-linux-arm64`, `ade-linux-x64`, and
  the matching `.native.tar.gz` for each

Required additionally when `platforms` includes `win`:

- `ADE-<VERSION>-win-x64.exe`
- `ADE-<VERSION>-win-x64.exe.blockmap`
- `latest.yml`
- `install.ps1`
- `ade-win32-x64.exe`
- `ade-win32-x64.native.tar.gz`

Gate/asset agreement is a hard check, in both directions:

```bash
WINDOWS_GATE="$(gh variable get ADE_WINDOWS_PUBLIC_RELEASE_ENABLED --repo arul28/ADE 2>/dev/null || echo unset)"
WINDOWS_ASSETS="$(gh release view "v<VERSION>" --repo arul28/ADE --json assets \
  --jq '[.assets[].name | select(test("win-x64|win32-x64|^latest\\.yml$|^install\\.ps1$"))] | length')"
echo "gate=$WINDOWS_GATE windows_assets=$WINDOWS_ASSETS"
```

- `gate=1` and `windows_assets=0` means the Windows build silently did not
  contribute. Stop; keep the release draft/private.
- `gate` not `1` and `windows_assets` greater than `0` means Windows assets
  reached a release that was not supposed to carry them. Stop; keep the release
  draft/private.

Also verify:

- `latest-mac.yml` references the uploaded arm64 and x64 ZIPs.
- `latest-mac.yml` does not reference `universal`.
- no updater ZIP is suspiciously huge; a ZIP over about 900 MB needs human
  review because Squirrel.Mac can crash while handling oversized updater ZIPs.
- every `latest-mac.yml` referenced ZIP exists in the release assets.
- when Windows is in scope, `latest.yml` references the uploaded
  `ADE-<VERSION>-win-x64.exe`, and that installer and its `.blockmap` both
  exist in the release assets.
- `SHA256SUMS` lists every published standalone runtime asset, including the
  `ade-win32-x64` entries when Windows is in scope, and lists nothing that is
  not published.

### Publish public/latest

Only after verification passes:

```bash
gh release edit "v<VERSION>" --repo arul28/ADE --draft=false --latest
gh api repos/arul28/ADE/releases/latest \
  --jq '{tag_name,draft,prerelease,html_url,asset_count:(.assets|length)}'
```

## Phase 5: iOS TestFlight Build and Distribution

Do this only if iOS scope is `yes`.

Preflight:

```bash
asc doctor
asc testflight groups list --app 6762759870 --paginate
```

Normal build rule:

- Use current `MARKETING_VERSION`.
- Use ASC next build number.
- Include app, widgets, and App Clip.
- Do not omit App Clip unless the user explicitly accepts an emergency build.

Recommended explicit sequence:

```bash
OUT=.ade/tmp/ios-testflight-$MARKETING_VERSION-build$BUILD_NUMBER
mkdir -p "$OUT"

ASC_KEY_PATH=$(jq -r '.profiles.ade.keyPath // .keyPath // .privateKeyPath // .private_key_path // empty' ~/.asc/config.json)
ASC_KEY_ID=$(jq -r '.profiles.ade.keyId // .keyId // .key_id // empty' ~/.asc/config.json)
ASC_ISSUER_ID=$(jq -r '.profiles.ade.issuerId // .profiles.ade.issuer_id // .issuerId // .issuer_id // empty' ~/.asc/config.json)

asc xcode archive \
  --project apps/ios/ADE.xcodeproj --scheme ADE \
  --configuration Release --clean \
  --archive-path "$OUT/ADE.xcarchive" --overwrite --output json \
  --xcodebuild-flag=-destination --xcodebuild-flag=generic/platform=iOS \
  --xcodebuild-flag=-allowProvisioningUpdates \
  --xcodebuild-flag=-authenticationKeyPath --xcodebuild-flag="$ASC_KEY_PATH" \
  --xcodebuild-flag=-authenticationKeyID --xcodebuild-flag="$ASC_KEY_ID" \
  --xcodebuild-flag=-authenticationKeyIssuerID --xcodebuild-flag="$ASC_ISSUER_ID" \
  --xcodebuild-flag=CURRENT_PROJECT_VERSION=$BUILD_NUMBER \
  --xcodebuild-flag=MARKETING_VERSION=$MARKETING_VERSION

asc xcode export \
  --archive-path "$OUT/ADE.xcarchive" \
  --export-options apps/ios/ExportOptions.auto.plist \
  --ipa-path "$OUT/ADE.ipa" --overwrite --output json \
  --xcodebuild-flag=-allowProvisioningUpdates \
  --xcodebuild-flag=-authenticationKeyPath --xcodebuild-flag="$ASC_KEY_PATH" \
  --xcodebuild-flag=-authenticationKeyID --xcodebuild-flag="$ASC_KEY_ID" \
  --xcodebuild-flag=-authenticationKeyIssuerID --xcodebuild-flag="$ASC_ISSUER_ID"
```

Before upload, unpack and inspect the exported IPA. This is mandatory for App
Clip releases:

```bash
TMP_IPA_CHECK="$OUT/ipa-check"
rm -rf "$TMP_IPA_CHECK"
mkdir -p "$TMP_IPA_CHECK"
ditto -x -k "$OUT/ADE.ipa" "$TMP_IPA_CHECK"
/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$TMP_IPA_CHECK/Payload/ADE.app/Info.plist"
/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$TMP_IPA_CHECK/Payload/ADE.app/Info.plist"
/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$TMP_IPA_CHECK/Payload/ADE.app/Info.plist"
find "$TMP_IPA_CHECK/Payload/ADE.app" -maxdepth 3 -name 'ADEClip.app' -print
find "$TMP_IPA_CHECK/Payload/ADE.app" -maxdepth 3 -name 'ADEWidgets.appex' -print
```

Before continuing, inspect `ADEClip.app/Info.plist` too. Continue only if the
main app, widgets, and App Clip all use the intended marketing version/build
number and the App Clip bundle has the expected icon/deployment metadata.

Use Apple package validation before upload so metadata errors surface before
the final upload step:

```bash
xcrun altool --validate-app --type ios --file "$OUT/ADE.ipa" \
  --apiKey "$ASC_KEY_ID" --apiIssuer "$ASC_ISSUER_ID"
```

Upload only after validation passes:

```bash
asc builds upload --app 6762759870 --ipa "$OUT/ADE.ipa"

asc builds wait \
  --app 6762759870 \
  --build-number "$BUILD_NUMBER" \
  --version "$MARKETING_VERSION" \
  --platform IOS \
  --timeout 40m
```

If automatic export fails due signing, use the repo's signing gotchas in
`AGENTS.md` and the `asc-*` skills. Fix signing/profiles; do not silently remove
targets.

After processing:

```bash
BUILD_ID=$(asc builds list --app 6762759870 --version "$MARKETING_VERSION" --platform IOS --limit 10 \
  | jq -r --arg b "$BUILD_NUMBER" '.data[]|select(.attributes.version==$b)|.id' | head -n1)

asc builds update --build-id "$BUILD_ID" --uses-non-exempt-encryption=false
```

Attach all non-empty beta groups:

```bash
asc testflight groups list --app 6762759870 --paginate
asc builds add-groups --build-id "$BUILD_ID" --group "<group-id>" --submit --confirm
```

Use `--submit --confirm` for external groups. Internal groups may also be added
explicitly if they do not automatically receive the build.

Verify every group:

```bash
asc builds info --build-id "$BUILD_ID"
asc builds build-beta-detail view --build-id "$BUILD_ID"
for gid in <all-group-ids>; do
  asc testflight groups links view --group-id "$gid" --type betaTesters
  asc testflight groups links view --group-id "$gid" --type builds
done
```

Success requires:

- build `processingState=VALID`
- `usesNonExemptEncryption=false`
- `internalBuildState` is `READY_FOR_BETA_TESTING` or `IN_BETA_TESTING`
- external groups are `IN_BETA_TESTING` or otherwise clearly submitted/approved
- each target group has at least one tester
- each target group contains the new build

After successful distribution, tag the shipped iOS build:

```bash
git tag -a "ios-v${MARKETING_VERSION}-build${BUILD_NUMBER}" "$RELEASE_SHA" \
  -m "iOS ${MARKETING_VERSION} build ${BUILD_NUMBER}"
git push origin "ios-v${MARKETING_VERSION}-build${BUILD_NUMBER}"
```

## Phase 5.5: Cloudflare Surfaces (Pages + Workers + account state)

The GitHub desktop workflow and TestFlight do NOT touch the hosted web tier.
Every release reconciles it, or production silently drifts (this bit v1.2.28 and
v1.2.29: a rewritten web client and two changed Workers sat undeployed while the
desktop shipped).

**A Cloudflare surface has two halves, and only one of them is in git.** The code
half is `wrangler.jsonc` plus `src/`. The account half — whether the R2 bucket
exists, whether it has a lifecycle rule, whether a D1 migration was actually
applied, whether a secret is bound — lives in the Cloudflare account and in no
repository file. No test in this repo can fail on it. Phase 5.5 exists to check
the account half.

### Hard rules for this phase

- **Package-owned deploy entry points are mandatory.** `npm run deploy` /
  `npm run deploy:production` for each app. They own the D1 migrations, the
  binding/secret preflights, and the post-deploy auth smokes. `npx wrangler deploy`
  is a bypass, not a workaround. If an entry point stops on a preflight, a missing
  migration, or a missing smoke credential, repair that blocker and rerun the entry
  point.
- **Reconcile bindings against the account BEFORE deploying.** A binding that
  names a resource which does not exist in the account is a deploy-time failure
  no code test catches.
- **`/health` green is not verification.** Know what each endpoint actually
  proves. `ade-account-directory` (`apps/account-directory/src/directory.ts:1047`)
  and `ade-github-webhook-relay` (`apps/webhook-relay/src/relay.ts:2701`) return a
  bare `{"ok":true}` from a handler that runs before any binding, migration, or
  secret is touched — those prove reachability and nothing else.
  `ade-tunnel-relay` reports its protocol version and deployed Worker version tag;
  `ade-push-relay` (`apps/push-relay/src/relay.ts:1333`) reports whether APNs and
  each Clerk issuer are configured — substantive, but still blind to D1 migration
  state. **No `/health` in this repo checks migrations.** Green `/health` with
  500s on every authenticated route is a state this repo has actually shipped.
- **A failed Cloudflare surface is a release blocker.** Record it in the release
  state file with `status: "blocked"` and a note. Never silently skip a surface
  and report the release as complete.
- **Deploy from the release commit on `main`, never from a lane.**

### Step 1: Scope

`.github/workflows/deploy-web.yml` already deploys these surfaces on push to
`main`, path-filtered per surface. **The normal case is therefore verification,
not deployment**: find the `Deploy Web Surfaces` run for the release SHA and
confirm each in-scope job succeeded. Deploy by hand only when that run failed,
was skipped, or the release commit predates it.

**The Cloudflare baseline is not the desktop tag.** This tier ships on merge, on
its own cadence; a desktop tag says nothing about what is live on Cloudflare. If
a web change landed before the last desktop tag and its `deploy-web.yml` job
failed or never ran, a `LAST_TAG..origin/main` diff reports that surface
unchanged forever. Derive each surface's baseline from what actually deployed —
the newest run whose **job for that surface** concluded `success`. Job names are
`webclient`, `account-directory`, `webhook-relay`, `tunnel-relay`, `push-relay`;
a skipped job is not a success and does not appear in `jobs` at all.

```bash
runs="$(gh run list --repo arul28/ADE --workflow deploy-web.yml --branch main \
  --json databaseId --limit 20 --jq '.[].databaseId')"
for surface in webclient account-directory webhook-relay tunnel-relay push-relay; do
  base=""
  for id in $runs; do
    sha="$(gh run view "$id" --repo arul28/ADE --json headSha,jobs \
      --jq "if any(.jobs[]; .name==\"$surface\" and .conclusion==\"success\") then .headSha else empty end")"
    if [ -n "$sha" ]; then base="$sha"; break; fi
  done
  echo "$surface baseline=${base:-UNKNOWN}"
done
```

`UNKNOWN` means nothing in the last 20 runs proves that surface is current.
Treat it as **changed** and reconcile it fully; never treat an unknown baseline
as "unchanged". Run this in `bash` — `zsh` does not word-split `$runs`.

Then diff each surface against its own baseline (`$base` from above), using
`deploy-web.yml`'s paths-filter verbatim:

```bash
git log <base>..origin/main --oneline -- apps/account-directory   # account-directory
git log <base>..origin/main --oneline -- apps/webhook-relay       # webhook-relay
git log <base>..origin/main --oneline -- apps/tunnel-relay        # tunnel-relay
git log <base>..origin/main --oneline -- apps/push-relay          # push-relay
git log <base>..origin/main --oneline -- \
  apps/desktop/src/renderer apps/desktop/src/shared apps/desktop/vite.webclient.config.ts  # webclient
```

The desktop-tag diff (`git log $LAST_TAG..origin/main -- apps/...`) is a
secondary signal only — useful for the release note, never for the deploy
decision.

Now confirm the run for the release commit itself. Resolve `RUN_ID` from the
release SHA and fail loudly when there is no match — no matching run means CI
never deployed this commit, which is a manual-deploy case, not a pass:

```bash
RELEASE_SHA="$(git rev-parse origin/main)"
RUN_ID="$(gh run list --repo arul28/ADE --workflow deploy-web.yml \
  --json databaseId,headSha --limit 50 \
  --jq "[.[] | select(.headSha == \"$RELEASE_SHA\")] | .[0].databaseId // empty")"
[ -n "$RUN_ID" ] || echo "no deploy-web.yml run for $RELEASE_SHA — deploy by hand"
[ -n "$RUN_ID" ] && gh run view "$RUN_ID" --repo arul28/ADE --json status,conclusion,jobs
```

A `workflow_dispatch` run deploys **every** surface — use it as the manual full
reconcile when the automatic run is untrustworthy:

```bash
gh workflow run deploy-web.yml --repo arul28/ADE
```

Any surface whose baseline came back `UNKNOWN` goes through that dispatch.

Record each surface's baseline SHA, `changed`, and `action` (`skip` / `ci` /
`manual`) in the state file before doing anything else.

### Step 2: Inventory — what each surface actually declares

This table is derived from the committed wrangler configs. Re-read them if a
release changes one; do not trust this table over the file.

| Surface | Config | Bindings and account resources | Deploy entry point |
|---|---|---|---|
| `ade-web-client` (Pages) | none in repo; built by `apps/desktop/vite.webclient.config.ts` | custom domain `app.ade-app.dev`, Pages URL `ade-web-client.pages.dev` | `npx wrangler@4.105.0 pages deploy apps/desktop/dist/web-client --project-name ade-web-client` |
| `ade-account-directory` / `ade-account-directory-production` | `apps/account-directory/wrangler.jsonc` | D1 `DB` → `ade-account-directory` (`215bebd4-6601-4705-ab6e-e6f2d1397156`) / `ade-account-directory-production` (`38ebe0bb-ac4d-4b39-b73e-bab2f0092971`), `migrations_dir: migrations` (`0001`–`0009`); R2 `DIAGNOSTICS` → `ade-diagnostics` / `ade-diagnostics-production`; vars `ONLINE_WINDOW_MS`, `WEB_CLIENT_ORIGIN`, `PUSH_RELAY_URL`, `DIAGNOSTICS_DAILY_GLOBAL_LIMIT`; secrets `DIRECTORY_AUTH_SECRET`, `CLERK_JWKS_URL`, `CLERK_ISSUER`, `CLERK_OAUTH_CLIENT_ID`; cron `* * * * *`; observability on | `npm run deploy:production` |
| `ade-github-webhook-relay` | `apps/webhook-relay/wrangler.jsonc` | D1 `DB` → `ade-github-relay` (`65e81b4d-2894-444f-9546-390815533b3b`), `migrations_dir: migrations` (`0001`–`0007`); Durable Object `REPO_EVENTS` → `RepoEventsDurableObject`, migration tag `v1` (`new_sqlite_classes`); no vars, no secrets in config | `npm run deploy` |
| `ade-tunnel-relay` | `apps/tunnel-relay/wrangler.jsonc` | Durable Object `TUNNEL` → `TunnelDurableObject`, migration tag `v1` (`new_sqlite_classes`); `version_metadata` binding `CF_VERSION_METADATA`; no D1, no R2, no vars, no secrets; observability on | `npm run deploy` |
| `ade-push-relay` | `apps/push-relay/wrangler.jsonc` | D1 `DB` → `ade-push-relay` (`1fab2e8a-b269-4618-9402-7a49f9651f26`), `migrations_dir: migrations` (`0001`–`0007`) plus `schema/attention_triggers.sql` applied by `d1:triggers:remote`; vars `DAILY_REQUEST_BUDGET`, `IP_RATE_LIMIT_PER_MIN`, `CLAIM_RATE_LIMIT_PER_MIN`, `WEB_CLIENT_ORIGIN`; secrets `DIRECTORY_AUTH_SECRET`, `CLERK_JWKS_URL`, `CLERK_ISSUER`, `CLERK_OAUTH_CLIENT_ID`, `CLERK_SECONDARY_JWKS_URL`, `CLERK_SECONDARY_ISSUER`, `CLERK_SECONDARY_OAUTH_CLIENT_ID` (`apps/push-relay/scripts/verify-deployment-auth.mjs`); cron `17 * * * *`; observability on | `npm run deploy` locally, `npm run deploy:ci` in CI (mints Clerk smoke tokens) |

Two environment facts that are easy to get wrong:

- **Only `ade-account-directory` has a second wrangler environment.** The release
  ships the `production` environment (`--env production`). `ade-account-directory`
  without `--env` is the development Worker and is not a release surface.
- **Wrangler environments do not inherit `vars` or `secrets`.** Every var is
  restated under `env.production` in `apps/account-directory/wrangler.jsonc` for
  exactly this reason, and every secret must be `put` a second time with
  `--env production`. An omission here does not error — it silently falls back to
  the code default.

**Surfaces this repo does not use today.** No wrangler config in `apps/` declares
KV namespaces, Queues, service bindings, Hyperdrive, Vectorize, Analytics Engine,
`routes`, or `custom_domain`. Do not run checks for them and do not invent
resource names. If a wrangler config ever declares one, this checklist applies to
it unchanged: reconcile the declared name against the account listing before
deploying, and verify it post-deploy.

### Step 3: Drift preflight — declared bindings vs the account

Run this **before** any deploy. Every command runs inside an app directory whose
`node_modules` is installed, because that is the only thing that pins the
version: bare `npx wrangler` from the repo root has no wrangler dependency to
resolve and silently fetches whatever is newest on npm. Install first, then keep
every invocation wrapped:

```bash
(cd apps/account-directory && npm ci)
(cd apps/account-directory && npx wrangler --version)   # expect 4.105.0
(cd apps/account-directory && npx wrangler whoami)      # CLOUDFLARE_ACCOUNT_ID → right account
```

Pinned versions: `4.105.0` in `apps/account-directory`, `4.112.0` in
`apps/tunnel-relay`, `^4.53.0` in the other two. Account-level reads (R2, D1,
`whoami`) are account-scoped, not app-scoped — run them from
`apps/account-directory` so the exact pin is the one talking to the account.
Every subcommand below is verified against wrangler 4.105.0.

R2 — buckets must exist before the deploy that first binds them:

```bash
(cd apps/account-directory && npx wrangler r2 bucket list)
(cd apps/account-directory && npx wrangler r2 bucket info ade-diagnostics --json)
(cd apps/account-directory && npx wrangler r2 bucket info ade-diagnostics-production --json)
```

D1 — databases must exist, and IDs must match the config:

```bash
(cd apps/account-directory && npx wrangler d1 list --json)
(cd apps/account-directory && npx wrangler d1 info ade-account-directory-production --json)
(cd apps/account-directory && npx wrangler d1 info ade-github-relay --json)
(cd apps/account-directory && npx wrangler d1 info ade-push-relay --json)
```

Secrets — names only; wrangler never prints values, so this is safe to run and
safe to paste:

```bash
(cd apps/account-directory && npx wrangler secret list --env production --format json)
(cd apps/push-relay && npx wrangler secret list --format json)
```

Current deployed state, so you know what you are replacing and what to roll back to:

```bash
(cd apps/account-directory && npx wrangler deployments list --env production)
(cd apps/account-directory && npx wrangler versions list --env production)
```

Not-used surfaces, only if a config ever declares one:
`npx wrangler kv namespace list`, `npx wrangler queues list`.

**Any declared binding whose resource is missing from the account listing is a
release blocker.** Create the resource, or ship the Worker with the binding
removed if the code degrades gracefully — but never deploy a config that binds a
resource which does not exist.

> This bit us on 2026-08-19. `apps/account-directory` gained an `r2_buckets`
> binding for diagnostics report storage, but R2 was not enabled on the
> Cloudflare account, so creating either bucket failed with
> `Please enable R2 through the Cloudflare Dashboard [code: 10042]` — an
> account-level product enablement, not a token scope; the same token listed
> Workers, read D1, and deployed Pages. A Worker bound to a bucket that cannot
> exist **fails to start**, so deploying the config as written would have taken
> down machine registration, pairing, and heartbeat for every user in order to
> deliver a route nobody could reach. The recovery was to ship the Worker with
> `r2_buckets` commented out (#1126) — the code types the binding optional and
> answers `503` on `/diagnostics/upload` without it — then enable the
> subscription, create both buckets, and revert (#1127). Every test in the repo
> passed the whole time. Only a bindings-vs-account diff catches this.

### Step 4: Un-codeable account state

These settings exist only in the Cloudflare account. A freshly created resource
does not have them, and nothing in the repo will tell you they are missing.
Verify each one explicitly; do not assume.

**R2 bucket lifecycle rules.** Nothing in the Worker ever deletes a diagnostics
report (`apps/account-directory/src/diagnostics.ts`). The 30-day expiry is the
third term of the cost ceiling — 400 uploads/day × 512 KB × 30 days ≈ 6 GB,
inside R2's 10 GB free tier — and it is the one term the repository cannot
enforce in code.

```bash
(cd apps/account-directory && npx wrangler r2 bucket lifecycle list ade-diagnostics)
(cd apps/account-directory && npx wrangler r2 bucket lifecycle list ade-diagnostics-production)
```

Both buckets must show a rule expiring the `reports/` prefix after 30 days. The
rules in the account were created as `expire-reports-30d` (#1127); the README
worked example at `apps/account-directory/README.md` uses the name
`expire-reports`. Match on the effect — prefix `reports/`, 30-day expiry — not on
the name. If a rule is missing:

```bash
(cd apps/account-directory && npx wrangler r2 bucket lifecycle add ade-diagnostics \
  expire-reports-30d reports/ --expire-days 30)
(cd apps/account-directory && npx wrangler r2 bucket lifecycle add ade-diagnostics-production \
  expire-reports-30d reports/ --expire-days 30)
```

Lengthening the window moves the ceiling with it — 90 days is roughly 18 GB and
off the free tier. Changing it is a deliberate act with arithmetic attached.

> This bit us on 2026-08-19. The diagnostics buckets were created without
> lifecycle rules, because bucket creation and lifecycle configuration are two
> separate account operations and only the first one is mentioned by the binding.
> With clients auto-sending reports on failure and nothing in the Worker deleting
> them, the bucket grows forever and every report a user ever sent stays readable
> indefinitely. The rules were added out of band and the restore landed as #1127.

**R2 public access posture.** The diagnostics buckets hold user-submitted
failure reports and must stay private — no `r2.dev` public dev URL, no public
custom domain. `r2 bucket info` does **not** report this; two separate commands
do, and both must answer negatively for both buckets:

```bash
(cd apps/account-directory && npx wrangler r2 bucket dev-url get ade-diagnostics)
(cd apps/account-directory && npx wrangler r2 bucket domain list ade-diagnostics)
(cd apps/account-directory && npx wrangler r2 bucket dev-url get ade-diagnostics-production)
(cd apps/account-directory && npx wrangler r2 bucket domain list ade-diagnostics-production)
```

Both buckets, all four commands. The development bucket takes real reports from
anyone running a development build, so "it is only dev" is not a reason to skip
it. Expect `Public access via the r2.dev URL is disabled.` and
`There are no custom domains connected to this bucket.` Anything else means
user-submitted failure reports are world-readable, and that is a release
blocker, not a note.

**Subscription enablement.** R2 was the case that bit us, but the class is
general: a product that is not enabled on the account makes every resource of
that type uncreatable, and the error is an account error, not a permissions
error. If a resource cannot be created and the token works for everything else,
check product enablement in the dashboard before debugging the token.

**Cron triggers.** `ade-account-directory` declares `* * * * *` and
`ade-push-relay` declares `17 * * * *`. These deploy with the Worker; confirm the
deploy output lists them, since a Worker whose scheduled handler silently stopped
running looks perfectly healthy on every request path.

### Step 5: Deploy

Only when the CI run did not cover a surface. Install locked dependencies first;
run from the release commit on `main`.

```bash
# Hosted web client (Cloudflare Pages project ade-web-client)
# Pinned: the repo root has no wrangler dependency, so an unpinned npx here
# resolves to whatever npm publishes that day.
(cd apps/desktop && npm ci && npm run build:webclient)
npx wrangler@4.105.0 pages deploy apps/desktop/dist/web-client \
  --project-name ade-web-client --branch main \
  --commit-hash "$(git rev-parse origin/main)" --commit-dirty=false

# Workers
(cd apps/account-directory && npm ci && npm run deploy:production)
(cd apps/webhook-relay && npm ci && npm run deploy)
(cd apps/tunnel-relay && npm ci && npm run deploy -- --tag "$(git rev-parse origin/main)" --message "release $(git rev-parse --short origin/main)")
(cd apps/push-relay && npm ci && npm run deploy)
```

`deploy-web.yml` still runs the Pages step as floating `npx wrangler@4`
(`.github/workflows/deploy-web.yml:77`), so CI and a hand deploy can be on
different 4.x minors. Known and accepted for Pages, which uploads static assets;
if a Pages deploy ever behaves differently by hand than in CI, check that first.

What each entry point actually guards, so you know what you lose by bypassing it:

- `apps/account-directory` `deploy:production` = `verify-deployment-config.mjs production`
  (asserts `DIRECTORY_AUTH_SECRET` is bound and `PUSH_RELAY_URL` is set **for that
  environment**) → `d1:migrate:production` → `wrangler deploy --env production`.
  **Known coverage gap:** that preflight checks one of the four secrets and one
  of the four vars. `CLERK_JWKS_URL`, `CLERK_ISSUER`, `CLERK_OAUTH_CLIENT_ID`,
  `ONLINE_WINDOW_MS`, `WEB_CLIENT_ORIGIN`, and
  `DIAGNOSTICS_DAILY_GLOBAL_LIMIT` are unchecked by any script and unchecked by
  `/health`, which answers `{"ok":true}` before touching config. Confirm them
  by hand from Step 3's `secret list` and the deployed `env.production` vars,
  and list anything you could not confirm in `accountState.config[...].unverified`
  rather than reporting the surface verified.
- `apps/push-relay` `deploy` = `validate:migrations` → `verify:auth-preflight`
  (all seven required secrets) → `d1:migrate:remote` (migrations **and**
  `attention_triggers.sql`) → `wrangler deploy` → `verify:auth-health` →
  `verify:auth-account` (a real authenticated snapshot fetch per Clerk issuer).
- `apps/webhook-relay` `deploy` = `d1:migrate:remote` → `wrangler deploy`.
- `apps/tunnel-relay` `deploy` is a bare `wrangler deploy` — it has no D1, no
  secrets, and nothing to preflight. Still invoke it through `npm run deploy` so
  the `--tag` version metadata that `/health` reports is carried through.

The `--tag` on tunnel-relay is load-bearing: `CF_VERSION_METADATA` is what makes
`/health` able to prove *which* code is live rather than merely that something is.

### Step 6: Post-deploy verification

Green `/health` is the floor, not the check. Verify per surface:

**`ade-web-client`** — the live bundle hash must equal the one you just built:

```bash
built="$(basename apps/desktop/dist/web-client/assets/index-*.js)"
live="$(curl -fsS https://app.ade-app.dev | grep -oE 'index-[A-Za-z0-9_-]+\.js' | head -1)"
echo "built=$built live=$live"
npx wrangler pages deployment list --project-name ade-web-client --environment production
```

Pages propagation is not instant; poll for a couple of minutes before calling it
a failure, the way `deploy-web.yml` does.

**`ade-account-directory-production`** — migrations, then the diagnostics route:

```bash
curl -fsS https://ade-account-directory-production.arulsharma1028.workers.dev/health
(cd apps/account-directory && npx wrangler d1 migrations list DB --env production --remote)
```

`migrations list` prints **unapplied** migrations. Post-deploy it must report
none pending; `0009_diagnostics_upload_budget.sql` in particular is what enforces
the fleet-wide daily upload ceiling, so a green Worker with `0009` unapplied is a
Worker whose cost ceiling does not exist.

Then confirm the R2 binding is actually live. An empty unauthenticated POST
distinguishes the two states without sending or printing any credential:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  https://ade-account-directory-production.arulsharma1028.workers.dev/diagnostics/upload
```

`400` (missing report) means the `DIAGNOSTICS` bucket is bound and reachable.
`503` means it is not — the exact degradation #1126 shipped deliberately, and a
silent regression if you did not intend it. Also confirm
`DIAGNOSTICS_DAILY_GLOBAL_LIMIT` is present in the deployed `env.production`
vars; unset falls back to the code default rather than erroring, so its absence
is invisible at runtime.

**`ade-push-relay`** — the guarded deploy already ran `verify:auth-health` and
`verify:auth-account`, which fetch `/health` and assert
`accountAuthConfigured` / `primaryAccountAuthConfigured` /
`secondaryAccountAuthConfigured` are all true, then perform a real authenticated
`GET /attention/account/snapshot?since=0` per Clerk issuer. If you deployed by
any other route, run them explicitly:

```bash
(cd apps/push-relay && npm run verify:auth-bindings && npm run verify:auth-health && npm run verify:auth-account)
(cd apps/push-relay && npx wrangler d1 migrations list ade-push-relay --remote)
```

`migrations list` only reports unapplied files in `migrations/`. It is blind to
`schema/attention_triggers.sql`, which `d1:migrate:remote` applies as a sidecar
and which nothing else verifies. Ask the database directly — read-only, safe to
run any time:

```bash
(cd apps/push-relay && npx wrangler d1 execute ade-push-relay --remote --json \
  --command "SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name")
```

Both `attention_device_ownership_reject_stale` and
`attention_devices_enforce_user_limit` must come back. They are the per-user
device cap and the stale-ownership rejection; missing, the Worker looks healthy
and enforces neither. Put the returned names in the push-relay report line.

`verify:auth-account` needs the Clerk smoke credentials in the environment. If
they are absent, say so in the release report — an unverified authenticated path
is not a verified one.

**`ade-tunnel-relay`** — `/health` here is genuinely substantive; assert the
protocol version and that `workerVersion.tag` equals the release SHA:

```bash
curl -fsS https://ade-tunnel-relay.arulsharma1028.workers.dev/health
```

Expect `ok: true`, `service: "ade-tunnel-relay"`, `protocolVersion: 2`, and
`workerVersion.tag` matching `git rev-parse origin/main`.

**`ade-github-webhook-relay`** — `/health` returns a bare `{"ok":true}` and
proves nothing beyond reachability. Verify the D1 and Durable Object halves
directly:

```bash
curl -fsS https://ade-github-webhook-relay.arulsharma1028.workers.dev/health
(cd apps/webhook-relay && npx wrangler d1 migrations list ade-github-relay --remote)
```

**Durable Objects, both DO Workers.** `REPO_EVENTS`/`RepoEventsDurableObject` and
`TUNNEL`/`TunnelDurableObject` are each declared under migration tag `v1` with
`new_sqlite_classes`. Wrangler applies DO migrations at deploy time — read the
deploy output for migration errors rather than assuming success. A renamed or
deleted DO class needs a **new** migration tag in the config; changing the class
name under the existing `v1` tag is how you lose a Durable Object's stored state.

> This bit us on 2026-08-06. A direct Wrangler deployment published new
> account-directory code while production D1 migrations `0004` and `0005` were
> still pending and `DIRECTORY_AUTH_SECRET` was not bound. Authenticated machine
> list/register requests returned HTTP 500 across every device while `/health`
> stayed green. The recovery was to restore the shared secret, apply the pending
> migrations, and rerun the guarded production deploy. The same shape recurred on
> 2026-08-19 with the diagnostics work: `0009` and `DIAGNOSTICS_DAILY_GLOBAL_LIMIT`
> are what enforce the fleet-wide spend ceiling, so code deployed ahead of either
> one is code whose cost ceiling silently does not exist.

### Step 7: Rollback and blockers

A Worker deploy that verifies badly is rolled back to the previous version; it
does not sit broken while you debug. Rollback is an **attempt**, not a
guarantee — Cloudflare refuses it when the target version binds a resource that
no longer exists, or when a Durable Object class lifecycle changed between the
two versions. Try it, and if it is refused, fix forward.

```bash
(cd apps/account-directory && npx wrangler versions list --env production)
(cd apps/account-directory && npx wrangler rollback <version-id> --env production --message "release <VERSION> verification failed")
```

`wrangler rollback` with no `version-id` targets the previous deployment. Two
things it does **not** do:

- It does not revert D1 migrations. A migration is forward-only; rolling code
  back leaves the schema ahead. Confirm the previous code tolerates the new
  schema before rolling back, and if it does not, fix forward instead.
- It does not revert Durable Object migrations or R2 objects.

**Fix forward when rollback is unavailable.** If the previous version cannot
tolerate the new schema, if the rollback is refused, or if the DO class changed:
revert the offending commit on `main`, let `deploy-web.yml` redeploy, and verify
with Step 6 — same guarded entry points, same checks. Do not hand-patch
production with raw `wrangler deploy` to escape a failed rollback, and do not
hand-write a "down" migration for D1; migrations here are forward-only. Record
the fix-forward commit in `cloudflare.rollbacks` the same way you would a
version id.

Pages has **no rollback subcommand** — `wrangler pages deployment` is
list/create/tail/delete only (verified on 4.105.0). Listing tells you which
deployment to go back to; it does not restore it:

```bash
npx wrangler@4.105.0 pages deployment list --project-name ade-web-client --environment production
```

Record the target deployment id, then restore it from the Cloudflare dashboard
(Pages → `ade-web-client` → Deployments → *Rollback to this deployment*), or
rebuild the previous good commit and `pages deploy` it. Either way the id goes
in the report — "rolled back Pages" without one is not a record of anything.

Record every rollback in the state file's `cloudflare.rollbacks`.

**Blocker discipline.** If a surface cannot be deployed or cannot be verified,
set `status: "blocked"` with a note naming the surface, the failing check, and
the recovery command. Do not publish a release report that omits it, and do not
downgrade a blocked surface to "skipped". A guarded-deploy failure is a release
blocker, never a reason to fall back to raw Wrangler.

Credentials: `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` from ADE secrets.
Never echo their values; `wrangler whoami` and `wrangler secret list` are the
safe ways to prove they are right.

## Phase 6: Recovery Rules

Desktop:

- If a GitHub notarization job stalls, do not restart everything. Cancel the
  stuck run only when it has exceeded the cutoff, then use
  `gh run rerun --failed`.
- If the publish job fails after mac artifacts succeeded, inspect the draft
  release/assets and workflow logs before rerunning anything.
- If `latest-mac.yml` references a missing asset, keep the release draft/private
  until fixed.
- If `latest-mac.yml` references a universal ZIP, keep the release draft/private
  and fix the GitHub workflow. Do not publish the release.
- If `latest.yml` is missing, or references an installer that is not in the
  release assets, keep the release draft/private. Windows in-app update reads
  that file; a broken feed strands installed Windows users.
- If the Windows build fails, the draft is not created at all while the gate is
  on, by design. Fix the failure and rerun; do not clear
  `ADE_WINDOWS_PUBLIC_RELEASE_ENABLED` to force a macOS-only draft under a
  version that was announced as carrying Windows.
- If the Windows gate and the published Windows assets disagree in either
  direction, keep the release draft/private and reconcile before publishing.

iOS:

- If archive succeeds but upload fails, reuse the IPA.
- If upload succeeds but processing waits, use `asc builds wait`.
- If distribution fails, reuse the same `BUILD_ID`; do not upload another build
  unless the binary itself is wrong.
- If App Clip signing fails, fix Developer Portal/App Store Connect capability
  and profiles. Do not repeat the v1.1.10 build 16 emergency omission unless
  explicitly directed.

## Final Report

Report:

- desktop scope decision and tag
- the resolved desktop platform matrix (`mac` or `mac,win`) and the
  `ADE_WINDOWS_PUBLIC_RELEASE_ENABLED` value it came from
- GitHub Release URL and asset count
- whether `latest-mac.yml` references only present assets
- when Windows is in scope, whether `latest.yml` references only present assets
  and whether the gate and the published Windows assets agreed
- iOS marketing/build number
- TestFlight build ID
- group membership verification
- Cloudflare, one line per surface (`ade-web-client`,
  `ade-account-directory-production`, `ade-github-webhook-relay`,
  `ade-tunnel-relay`, `ade-push-relay`), each stating:
  - the decision — changed or not, and deployed by CI, deployed manually, or
    skipped — plus the deployment baseline SHA it was decided against, or
    `UNKNOWN` if none was resolvable
  - the verification outcome — what was actually checked, not just that `/health`
    was green: live bundle hash for Pages, `d1 migrations list` showing nothing
    pending for each D1-backed Worker, both `sqlite_master` triggers present for
    push-relay, `/diagnostics/upload` returning `400` for the account directory's
    R2 binding, `workerVersion.tag` matching the release SHA for tunnel-relay,
    and the auth smokes for push-relay
- Cloudflare account state, from `cloudflare.accountState`, per resource and
  environment — not one aggregate sentence:
  - each diagnostics bucket: exists, 30-day `reports/` lifecycle rule, r2.dev
    dev URL disabled, zero custom domains
  - each D1 database: exists, id matches the config, nothing pending
  - cron triggers listed in the deploy output for `ade-account-directory-production`
    (`* * * * *`) and `ade-push-relay` (`17 * * * *`)
  - Durable Object migrations: what the deploy output said for
    `ade-github-webhook-relay` and `ade-tunnel-relay`
  - per environment, which secrets and vars were confirmed bound — and name
    every one that was **not** confirmed rather than implying coverage the
    preflights do not have
- any Cloudflare rollback performed, with the version id
- any blocked surface, its failing check, and the recovery command
- any skipped surface and why
- whether the repo is clean

Keep the report short, but include exact version/build numbers.
