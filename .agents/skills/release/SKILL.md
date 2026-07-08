---
name: release
description: 'Local-first ADE release conductor: detect whether desktop and/or iOS actually changed, bump desktop patch versions, keep iOS marketing versions fixed while bumping build numbers, publish desktop GitHub Releases from this Mac, and distribute TestFlight builds to all beta users.'
---

# ADE Release Skill

Use this skill when the user wants to release ADE, automate releases from a
cron/agent, decide whether a release is needed, publish a desktop release, or
ship a TestFlight build.

This is a **local-first release flow**. GitHub Releases remain the public
artifact host for Electron updater, but this Mac can be the release machine for
Apple signing, notarization, GitHub asset upload, and TestFlight upload.

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
- **Do not publish broken updater metadata.** Before making a desktop release
  public/latest, verify `latest-mac.yml` references assets that exist.
- **Do not wait forever on Apple.** If notarization or TestFlight processing
  exceeds its normal window by a lot, preserve state, retry only the failed
  phase, or stop with a clear recovery command.

## Machine Notes

This release lane runs on an Apple Silicon Mac (`arm64`). Rosetta is available
on the intended release machine, so x64 desktop builds are plausible through
Electron Builder/Rosetta, and ADE already has scripts for x64/per-arch/local
mac release builds.

Still verify the output instead of trusting architecture assumptions:

- Desktop updater correctness requires `latest-mac.yml` plus the referenced mac
  ZIP assets.
- If supporting Intel users, the feed must include an Intel/x64 ZIP as well as
  arm64. Do not silently publish arm64-only unless the user explicitly accepts
  dropping Intel updates for that release.
- If local x64 build fails, use a fallback: reuse a known-good x64 app/ZIP input
  with `release:mac:local -- --x64-app=... --x64-zip=...`, or run only the x64
  build on a remote runner and publish locally after verification.

## State and Locking

Create a state file before mutating release state:

```bash
mkdir -p .ade/release
```

Use a path like:

```text
.ade/release/local-release-YYYYMMDD-HHMMSS.json
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
   asc doctor
   security find-identity -v -p codesigning
   ```

5. Verify this Mac can sign desktop releases:

   ```bash
   test -f apps/desktop/scripts/release-mac-local.mjs
   test -f apps/desktop/scripts/require-macos-release-secrets.cjs
   ```

   `release:mac:local` reads `.env.local` itself. Do not print secret values
   while checking signing/notarization setup.

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

Commit and land the docs/release metadata on `main` before building artifacts.
The desktop release tag must point at the final `main` commit that includes the
changelog.

## Phase 4: Desktop Local Build and Publish

Preferred local command:

```bash
npm --prefix apps/desktop run release:mac:local -- v<VERSION>
```

This script:

- reads `.env.local` and installed keychain identities
- can use the installed Developer ID Application identity
- sets package versions temporarily from `ADE_RELEASE_TAG`
- builds/signs/notarizes mac artifacts
- restores `apps/desktop/package.json` and `apps/ade-cli/package.json`

If local x64 inputs are needed, pass them explicitly:

```bash
npm --prefix apps/desktop run release:mac:local -- v<VERSION> \
  --x64-app=/path/to/ADE.app \
  --x64-zip=/path/to/ADE-x64.zip
```

If the local script cannot produce x64, do not publish until one of these is
true:

- the local x64 build succeeds under Rosetta
- a remote x64 artifact is available and verified
- the user explicitly approves an arm64-only desktop release

### Desktop asset verification

Before uploading or publishing, verify:

```bash
npm --prefix apps/desktop run validate:mac:artifacts
```

Also verify updater references:

```bash
grep -oE 'ADE-[^ ]+\.(zip|dmg)' apps/desktop/release/latest-mac.yml | sort -u
```

Every referenced ZIP/DMG must exist in the upload set.

### GitHub Release publication

1. Create/update a draft release for `v<VERSION>`.
2. Upload desktop assets.
3. Upload runtime/installer assets when they are available and part of the
   release contract.
4. Verify expected assets and `latest-mac.yml`.
5. Flip public/latest:

   ```bash
   gh release edit "v<VERSION>" --draft=false --latest
   ```

6. Verify:

   ```bash
   gh api repos/arul28/ADE/releases/latest --jq '{tag_name,draft,prerelease,html_url,asset_count:(.assets|length)}'
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

- If notarization stalls, do not restart everything. Preserve artifacts and
  retry only notarization/publish when possible.
- If GitHub upload is interrupted, inspect existing release assets first, then
  upload missing assets only.
- If `latest-mac.yml` references a missing asset, keep the release draft/private
  until fixed.

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
