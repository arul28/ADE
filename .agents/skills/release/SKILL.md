---
name: release
description: 'ADE release conductor: detect whether desktop and/or iOS actually changed, bump desktop patch versions, keep iOS marketing versions fixed while bumping build numbers, ship desktop through the GitHub Actions release workflow, and distribute TestFlight builds to all beta users.'
---

# ADE Release Skill

Use this skill when the user wants to release ADE, automate releases from a
cron/agent, decide whether a release is needed, publish a desktop release, or
ship a TestFlight build.

This is a **GitHub desktop + local ASC iOS release flow**. Desktop releases
must use the repository GitHub Actions release workflow so macOS updater assets
are produced reproducibly as per-arch ZIP/DMG artifacts. This Mac may still run
checks, create release docs/tags, monitor and recover the workflow, and build
and upload iOS/TestFlight releases through ASC.

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
  upload desktop release assets from this Mac unless the user explicitly asks
  for a one-off manual recovery.
- **No universal updater ZIPs.** `latest-mac.yml` must reference per-arch
  `arm64` and `x64` ZIPs. Never publish a `latest-mac.yml` that points to
  `ADE-*-universal.zip`; v1.2.16 proved that giant universal updater ZIPs can
  crash Squirrel.Mac during in-app update.
- **Do not publish broken updater metadata.** Before making a desktop release
  public/latest, verify `latest-mac.yml` references assets that exist and that
  the expected arm64/x64 DMGs and ZIPs are present.
- **Do not discover obvious release blockers after upload.** Preflight iOS App
  Clip packaging metadata before starting the expensive mobile phase.
- **Do not wait forever.** If GitHub notarization or TestFlight processing
  exceeds its normal window by a lot, preserve state, retry only the failed
  phase when possible, or stop with a clear recovery command.

## Machine Notes

This release lane runs on an Apple Silicon Mac (`arm64`), but desktop release
artifacts are produced remotely by GitHub Actions. Treat local desktop packaging
scripts as diagnostic/recovery tools only.

Desktop updater correctness requires:

- `latest-mac.yml`
- one arm64 ZIP and one x64 ZIP referenced by that file
- one arm64 DMG and one x64 DMG
- no universal ZIP in the updater feed

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
  "desktop": { "needed": false, "version": null, "tag": null, "lastTag": null },
  "ios": { "needed": false, "marketingVersion": null, "buildNumber": null, "lastTag": null },
  "phase": "detect|docs|desktop|ios|verify|done|blocked",
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
   gh workflow view release.yml --repo arul28/ADE
   ```

6. For desktop releases, verify the workflow path is the intended one before
   tagging:

   - `.github/workflows/release-core.yml` builds `dist:mac:arm64:signed`.
   - `.github/workflows/release-core.yml` builds `dist:mac:x64:signed`.
   - The publish job merges per-arch manifests into one `latest-mac.yml`.

   If the workflow has been changed to publish universal updater ZIPs, stop and
   fix the workflow before releasing.

7. For iOS releases, preflight App Clip packaging metadata before archiving:

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

### Scope outcomes

Print one concise decision:

```text
Scope: desktop=<yes|no> ios=<yes|no>
Desktop since: <DESKTOP_LAST_TAG>
iOS since: <IOS_LAST_TAG or bootstrap-needed>
```

If both are `no`, write state `phase=done` and stop.

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

Only create public docs/changelog entries when desktop is in scope. A mobile-only
TestFlight build does not need a public desktop changelog unless the user asks.

For desktop releases, update all release-doc surfaces:

- `changelog/v<VERSION>.mdx`
- `docs.json`
- `changelog/index.mdx`
- root `CHANGELOG.md`

Then run:

```bash
node scripts/validate-docs.mjs
```

Commit and land the docs/release metadata on `main` before tagging. The desktop
release tag must point at the final `main` commit that includes the
changelog.

## Phase 4: Desktop GitHub Workflow Release

Do this only if desktop scope is `yes`.

The desktop happy path is GitHub Actions. Do not run local desktop release
commands such as `release:mac:local`, `dist:mac:universal:signed`,
`dist:mac:perarch:signed`, or manual `gh release upload` from this Mac.

### Create the release tag

After release docs are committed on `main`:

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
- `publish-release` merges the per-arch updater manifests and creates the draft
- `update-brew-tap` runs after publication

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

Required assets:

- `ADE-<VERSION>-arm64.dmg`
- `ADE-<VERSION>-arm64.zip`
- `ADE-<VERSION>-x64.dmg`
- `ADE-<VERSION>-x64.zip`
- `latest-mac.yml`

Also verify:

- `latest-mac.yml` references the uploaded arm64 and x64 ZIPs.
- `latest-mac.yml` does not reference `universal`.
- no updater ZIP is suspiciously huge; a ZIP over about 900 MB needs human
  review because Squirrel.Mac can crash while handling oversized updater ZIPs.
- every `latest-mac.yml` referenced ZIP exists in the release assets.

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
- GitHub Release URL and asset count
- whether `latest-mac.yml` references only present assets
- iOS marketing/build number
- TestFlight build ID
- group membership verification
- any skipped surface and why
- whether the repo is clean

Keep the report short, but include exact version/build numbers.
