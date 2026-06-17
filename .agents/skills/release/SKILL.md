---
name: release
description: 'Cut a new ADE release: scope desktop/iOS, write changelog, push + tag main, poll release workflow, and ship an iOS build via asc'
---

# Release Command

Drive a full ADE release end-to-end: figure out what needs to ship (desktop, iOS, or both), generate the Mintlify changelog page, push + tag on `main` to kick the release workflow, poll it to completion, and (when iOS is in scope) drive the TestFlight build through `asc`.

**Usage:**
- `/release` — interactive. Agent will ask for the new version number and the iOS build number when it needs them.
- `/release <version>` — e.g. `/release v1.1.3`. Skip the version prompt; agent will still ask for the iOS build number if iOS is in scope.
- `/release <version> <ios-build-number>` — e.g. `/release v1.1.3 42`. Fully unattended.

**Arguments:** $ARGUMENTS

---

## Execution mode

Mostly autonomous, but **pause for explicit user input** on:
- The new version number (if not passed in `$ARGUMENTS`).
- The iOS build number (if iOS is in scope and not passed in `$ARGUMENTS`).
- **The iOS target TestFlight group(s)** (always — enumerate groups + tester counts first; never assume a default). See Phase 7a.
- Any step that would force-push `main`, bypass a ruleset in a surprising way, or publish a release that is still in `draft=false`.

Do NOT publish the GitHub draft release automatically. Leave it as a draft for a human to flip.

---

## Pipeline overview

```
Phase 0: Verify repo state and find last release
Phase 1: Scope — desktop, iOS, or both (surface-level path scan)
Phase 2: Version number (ask user if not provided)
Phase 3: Generate changelog MDX + register in docs.json
Phase 4: Commit + push changelog to main
Phase 5: Tag the release commit, push tag, confirm workflow started
Phase 6: Poll release workflow every 5 minutes until done (scheduled wake-ups)
Phase 7: iOS build via asc (only if iOS is in scope)
Phase 8: Final summary — draft release link, changelog link, TestFlight status
```

---

## Phase 0 — Verify repo state and find last release

1. Confirm you are on `main` locally and clean, OR that the branch you are on already contains the commits that will be released (if working in an ADE worktree, fetch and reason about `origin/main`).

   ```bash
   git fetch origin --tags --prune
   git log origin/main --oneline -1
   ```

2. Find the last release tag:

   ```bash
   git describe --tags --abbrev=0 origin/main 2>/dev/null || \
     git tag --list 'v*' --sort=-v:refname | head -n 1
   ```

3. Count commits since that tag on `origin/main`:

   ```bash
   LAST_TAG=$(git tag --list 'v*' --sort=-v:refname | head -n 1)
   git log --oneline "$LAST_TAG..origin/main"
   ```

   If the list is empty → nothing to release. Exit with a clear message. Do not proceed to any later phase.

4. Sanity-check GitHub state:

   ```bash
   gh release view "$LAST_TAG" --json tagName,isDraft,isLatest
   gh run list --workflow release.yml --limit 3
   ```

   If there is already an in-flight release workflow, stop and surface it to the user before doing anything else.

Record `LAST_TAG` and the ordered commit list in your working notes — Phases 1 and 3 both need them.

---

## Phase 1 — Release scope (surface-level)

Decide whether desktop, iOS, or both need to ship. **This is intentionally shallow** — path-based signals only, no deep diff review.

Produce the changed-file list:

```bash
git diff --name-only "$LAST_TAG..origin/main"
```

Classification rules:

- **Desktop in scope** if any file matches:
  - `apps/desktop/**`
  - `apps/ade-cli/**` (ships with desktop)
  - shared packages that desktop imports (e.g. root-level shared types used by desktop — check `apps/desktop/package.json` imports if unsure)
  - `.github/workflows/release.yml`, `release-core.yml`, `prepare-release.yml`
- **iOS in scope** if any file matches:
  - `apps/ios/**`
  - iOS-specific shared code (Swift files anywhere)
- **Both** if both sets are non-empty.
- If only doc-only or changelog-only files changed → warn and ask the user whether they really want to cut a release (usually no).

Output a one-line scope decision:

```
Scope: desktop=<yes|no> ios=<yes|no>  — <count> commits since <LAST_TAG>
```

Store `scope.desktop` and `scope.ios` as booleans for later phases.

---

## Phase 2 — Version number

If `$ARGUMENTS` provided a version (first positional arg that matches `v?\d+\.\d+\.\d+`), use it. Strip or add the leading `v` so you have both `v1.1.3` (tag form) and `1.1.3` (bare form) available.

Otherwise, ask the user:

> What version should this release be cut as? Last tagged release was `<LAST_TAG>`. Reply with e.g. `v1.1.3`.

Validation:
- Must be strictly greater than `LAST_TAG` under semver. Reject otherwise.
- Must not already exist as a tag: `git rev-parse "v$VERSION" >/dev/null 2>&1 && exit 1`.
- Must not already exist on GitHub: `gh release view "v$VERSION" 2>/dev/null` should fail.

---

## Phase 3 — Generate changelog MDX

The Mintlify site renders `changelog/vX.Y.Z.mdx` at `https://www.ade-app.dev/docs/changelog/vX.Y.Z`. Match the style of `changelog/v1.1.2.mdx` (which is the current latest — read it first for tone and structure).

### 3a. Gather commits per scope

```bash
git log --pretty=format:'%h %s' "$LAST_TAG..origin/main" -- apps/desktop apps/ade-cli
git log --pretty=format:'%h %s' "$LAST_TAG..origin/main" -- apps/ios
```

For each commit, you can pull the body when you need more than the subject:

```bash
git show --no-patch --pretty=format:'%B' <sha>
```

### 3b. Write `changelog/v<VERSION>.mdx`

Required frontmatter (match existing files):

```mdx
---
title: "v<VERSION>"
description: "Release notes for ADE v<VERSION> — <Month Day, Year>"
---
```

Body structure — **two top-level sections, exactly these headings when both are in scope**:

```mdx
<short one-paragraph summary of what this release does>

---

## Desktop

<grouped bullets by theme — one bullet per user-visible change, not per commit. Collapse trivial refactors. Lead with the user impact, then the mechanism in a sub-clause.>

---

## iOS

<same shape>
```

If only one platform is in scope, include only that section (no placeholder "No changes" block for the other).

**Tone rules** (from `AGENTS.md` style preferences):
- Direct and operational, not marketing.
- Concrete and stateful: say what changed and why it matters.
- Sentence case for headings unless an existing UI pattern uses something else.
- Bold the headline of each bullet (e.g. `**Chat continuity.**`) — see `v1.1.2.mdx` for pattern.

### 3c. Register the new page in `docs.json`

Open `docs.json`, find the `"Changelog"` group's `pages` array, and insert `"changelog/v<VERSION>"` at the **top** of the list (above the current latest). Do not touch any other `docs.json` entries.

### 3d. Satisfy `validate-docs` — the easy-to-miss trio

> **Why this exists:** CI runs `node scripts/validate-docs.mjs`, and the release `verify` job will not run until `ci-pass` is green. The changelog MDX + `docs.json` entry is **not enough** — `validate-docs` also enforces the three things below. Skipping any one makes the whole release fail at `verify` with the build already tagged. (Learned the hard way on v1.2.7.)

1. **Root `CHANGELOG.md`** (Keep a Changelog format). Insert a new section directly under `## [Unreleased]` and above the previous release:

   ```md
   ## [<VERSION>] - <Month Day, Year>

   ### Added
   - ...
   ### Changed
   - ...
   ### Removed
   - ...
   ### Fixed
   - ...
   ```

   Then, at the bottom link-reference block, add a `[<VERSION>]:` line and repoint `[Unreleased]`:

   ```md
   [Unreleased]: https://github.com/arul28/ADE/compare/v<VERSION>...HEAD
   [<VERSION>]: https://github.com/arul28/ADE/compare/v<PREV_VERSION>...v<VERSION>
   ```

   The validator checks: the top release heading equals the latest git tag, the heading for `v<VERSION>` exists, and the `[<VERSION>]` link reference exists. Use only `### Added/Changed/Removed/Fixed` subsections.

2. **`changelog/index.mdx`** — update the "Latest release" `<Card>` so its `href` is `/changelog/v<VERSION>` **and** the copy mentions `v<VERSION>`. The validator checks both.

3. **Brand assets referenced by `docs.json` must be committed.** `docs.json` points `logo`/`favicon` at files like `/logo/ade-wordmark.png` and `/favicon.png`. The repo **gitignores `*.png`**, so a plain `git add -A` silently skips them and the validator reports `missing target /...png`. Any such asset must be force-added in Phase 4 (`git add -f <file>`).

### 3e. Self-check — run the validator locally before committing

```bash
ls changelog/v<VERSION>.mdx
grep -n "changelog/v<VERSION>" docs.json
node scripts/validate-docs.mjs        # MUST print "Documentation validation passed"
mint broken-links                     # optional but cheap; should be clean
```

Do not proceed to Phase 4 until `scripts/validate-docs.mjs` passes locally. It catches every gotcha above before CI does.

---

## Phase 4 — Commit and push changelog to main

### Respect the "never edit main directly" rule

The user's standing guidance is to land changes through a lane/worktree, not by pushing directly to `main`. For the release changelog:

1. **Preferred path — PR merge:**
   - From the current ADE worktree branch, commit the changelog + `docs.json` change:
     ```bash
     # Stage the changelog page + docs.json + the Phase 3d trio, and FORCE-ADD
     # any gitignored brand assets docs.json references (*.png is gitignored).
     git add changelog/v<VERSION>.mdx docs.json CHANGELOG.md changelog/index.mdx
     git add -f favicon.png logo/*.png 2>/dev/null || true
     git commit -m "release: changelog for v<VERSION>"
     git push -u origin HEAD
     gh pr create --fill --title "release: changelog for v<VERSION>" \
       --body "Changelog for v<VERSION>. Tag will be cut after this lands on main."
     ```
   - Then hand off to `/ship` to drive the PR to merge, OR merge it yourself with `gh pr merge --admin --squash` if the user has already said "merge it".
   - Wait for `origin/main` to contain the new commit, **then wait for `ci-pass` to be green on it** (CI gate below) before Phase 5. Admin-merging does **not** wait for CI — and the release `verify` job rejects any tag whose `ci-pass` is not `success`.

2. **Admin-bypass path (only if user explicitly says "push directly"):**
   - `git push origin HEAD:main` with admin bypass. Note in the summary that the ruleset was bypassed.

Do not force-push. Do not `--no-verify`. If the push is rejected, investigate (rebase onto latest `origin/main`) — do not bypass checks.

After the commit is on `origin/main`, re-fetch and record the SHA you will tag:

```bash
git fetch origin main
RELEASE_SHA=$(git rev-parse origin/main)
```

### CI gate — `ci-pass` MUST be green on `RELEASE_SHA` before you tag

The release `verify` job calls `repos/<repo>/commits/<tag>/check-runs` and fails if there is no `ci-pass` check run, or if it is not `completed/success`. Push-to-`main` CI takes a few minutes; admin-merge does not wait for it. Poll until terminal **before** Phase 5:

```bash
# wait until ci-pass is completed on RELEASE_SHA, then assert success
for i in $(seq 1 40); do
  row=$(gh api "repos/$GH_REPO/commits/$RELEASE_SHA/check-runs" \
    --jq '[.check_runs[]|select(.name=="ci-pass")]|sort_by(.completed_at//"")|last//empty | "\(.status)\t\(.conclusion//"")"')
  status=$(printf '%s' "$row" | cut -f1); concl=$(printf '%s' "$row" | cut -f2)
  echo "ci-pass: $status/$concl"
  [ "$status" = "completed" ] && break
  sleep 30
done
[ "$concl" = "success" ] || { echo "ci-pass is $concl — fix CI before tagging"; }
```

If `ci-pass` is red, **do not tag.** Fix the failing check on a new commit, land it on `main`, re-fetch `RELEASE_SHA`, and re-run this gate. (For docs-only releases the usual culprit is `validate-docs` — see Phase 3d.)

---

## Phase 5 — Tag and trigger the release workflow

1. Create the tag on the exact release SHA (only after the CI gate above is green):

   ```bash
   git tag -a "v<VERSION>" "$RELEASE_SHA" -m "v<VERSION>"
   git push origin "v<VERSION>"
   ```

   **Recovery — re-pointing a prematurely-created tag.** If `verify` already failed because the tag landed on a red-CI commit, fix CI, land it, wait for green `ci-pass` on the new SHA, then move the tag to it. Force-updating the tag is acceptable here **only because no release was published** from the bad tag (the draft is created by `publish-release`, which never ran):

   ```bash
   git fetch origin main --tags
   git tag -f "v<VERSION>" "$NEW_RELEASE_SHA"
   git push origin "v<VERSION>" --force   # re-fires release.yml on the tag-update push
   ```

2. `.github/workflows/release.yml` triggers on `push` of `v*` tags and calls `release-core.yml`. Confirm the workflow registered:

   ```bash
   sleep 10
   gh run list --workflow release.yml --limit 1
   ```

   If no run appears within ~60s, fall back to a manual dispatch:

   ```bash
   gh workflow run release.yml \
     -f tag_name="v<VERSION>" \
     -f target_sha="$RELEASE_SHA"
   ```

3. Once the draft release appears (the workflow creates it), make sure the release body links to the Mintlify changelog page:

   ```bash
   gh release view "v<VERSION>" --json body,isDraft,url,assets
   gh release edit "v<VERSION>" --notes "$(cat <<EOF
   ADE v<VERSION>

   Full changelog: https://www.ade-app.dev/docs/changelog/v<VERSION>

   <one-paragraph summary — same opener as the Mintlify page>
   EOF
   )"
   ```

   Leave `isDraft=true`. Do not publish.

   Expect the draft to carry the macOS-only **per-arch** asset set once `publish-release`
   runs (the Windows/runtime surface is currently disabled in `release-core.yml`):
   - `ADE-<version>-arm64.dmg`, `ADE-<version>-arm64.zip`, `ADE-<version>-x64.dmg`, `ADE-<version>-x64.zip`, `latest-mac.yml`

---

## Phase 6 — Poll the release workflow

Release runs can take 20–40 minutes. Wait between polls instead of holding the turn open.

After kicking off the workflow, schedule a wake-up for +5 minutes and **exit the current turn**:

```
ScheduleWakeup({
  delaySeconds: 300,
  reason: "release v<VERSION> workflow running; poll in 5m",
  prompt: "/release $ARGUMENTS"
})
```

On each re-invocation, read a small state file at `.ade/release/v<VERSION>.json` (create it on first run) so you know what phase to resume in:

```json
{
  "version": "v1.1.3",
  "releaseSha": "<sha>",
  "scope": { "desktop": true, "ios": true },
  "workflowRunId": 1234567,
  "status": "running | release-done | ios-running | done | blocked",
  "iosBuildNumber": null
}
```

Per iteration:

```bash
gh run view "$RUN_ID" --json status,conclusion,url,jobs
```

- `status=queued|in_progress` → schedule another `+300s` wake, exit.
- `status=completed conclusion=success` → set `status=release-done`, move to Phase 7 (or Phase 8 if iOS is out of scope).
- `status=completed conclusion=failure|cancelled|timed_out` → stop, dump the failing job logs:
  ```bash
  gh run view "$RUN_ID" --log-failed | head -400
  ```
  Surface to the user and set `status=blocked`. Do not re-tag automatically.

Do not loop in-turn. One poll per wake-up.

---

## Phase 7 — iOS build via `asc`

Skip entirely if `scope.ios=false`.

### 7a. Ask the user: build number + target group(s)

Always pause for these two inputs (even if build number came in via `$ARGUMENTS`, confirm the group choice). Ask together so the user answers once:

> 1. **Build number.** The last one uploaded for `<MARKETING_VERSION>` was `<N>`. New build will be `<N+1>`. Override if you want a different number.
> 2. **Target TestFlight group(s).** The workspace has the groups below. Which should receive this build? (comma-separated names or IDs; default = `Internal Testers` if only you will be testing.)

Before asking, enumerate the groups and their tester counts so the user can pick knowingly:

```bash
# List all groups (note isInternal)
asc testflight groups list --app "$APP_ID"

# For each group ID, count actual testers
for gid in <group-ids>; do
  count=$(asc testflight groups links view --group-id "$gid" --type betaTesters \
    | jq -r '.meta.paging.total')
  echo "$gid testers=$count"
done
```

**Rules of thumb:**
- **Internal** groups (`isInternalGroup=true`): builds appear for testers as soon as the build is `VALID` and added to the group. No beta app review needed. Use this for dev-only testing.
- **External** groups (`isInternalGroup=false` or `None`): need beta app review (usually auto-approved for subsequent builds of the same marketing version). Use for wider-audience betas.
- **A group with zero testers is invisible.** If you add a build only to an empty group, nobody sees it and no emails go out. Verify tester counts before choosing.

Validate build number: strictly greater than the last recorded for that marketing version — confirm with `asc builds next-build-number --app "$APP_ID" --version "$MARKETING_VERSION" --platform IOS`.

### 7b. Pre-flight

`AGENTS.md` and the `asc-*` skills are the source of truth. Re-read before every release; the gotchas below are stable but the skill contents may change:

- `asc-xcode-build`
- `asc-testflight-orchestration`
- `asc-release-flow`
- `asc-signing-setup`
- `asc-submission-health`

Quick sanity:

```bash
asc doctor
```

Fail fast if keychain auth is broken.

### 7c. iOS signing gotchas (mirrored from AGENTS.md — keep in sync)

- Project uses **automatic** signing (`CODE_SIGN_STYLE = Automatic`, `DEVELOPMENT_TEAM = VQ372F39G6`). `apps/ios/ExportOptions.plist` ships with `signingStyle = manual` + named profiles for CI determinism. Local ad-hoc exports need `signingStyle = automatic` instead (drop the per-bundle profile map). `apps/ios/ExportOptions.auto.plist` is the ready-to-use auto-signing variant.
- `asc signing fetch` only downloads provisioning profiles and the `.cer` — it does **not** include the private key. Don't expect it to make local signing work on its own.
- Local exports need the ASC API key passed to `xcodebuild`. In addition to `-allowProvisioningUpdates`:
  ```
  -authenticationKeyPath ~/.apple/asc/keys/AuthKey_WRRA7YU7RA.p8 \
  -authenticationKeyID WRRA7YU7RA \
  -authenticationKeyIssuerID 4d523a6c-e68c-49b2-8560-34e59786d8e3
  ```
  Pull current values from `~/.asc/config.json`; do not hard-code.
- Override the build number at archive time via `--archive-xcodebuild-flag "CURRENT_PROJECT_VERSION=<N>"` so you do not need to commit a `pbxproj` bump just to ship a build.

### 7d. `asc publish testflight` requires `--group` — don't use it for the build/upload step

In the current `asc`, `asc publish testflight` **requires `--group`** and will just print help (exit 0, nothing uploaded) without it. Its one-shot local-build form also races encryption (`--wait` returns at `processingState=VALID` while `usesNonExemptEncryption` is still unanswered). So **do not** use `asc publish testflight` to build+upload. Use the explicit sequence in 7e instead. (Both gotchas hit on v1.2.7.)

### 7e. Safe sequenced flow (archive → export → upload → wait → encryption → distribute)

Each step is its own command so you can see exactly where it fails. Run the heavy steps with `run_in_background` and poll the log.

```bash
APP_ID=6762759870
BUILD_NUMBER=<N+1>
MARKETING_VERSION=<x.y.z>           # keep the SAME version, bump only the build
OUT=/tmp/ade-ios-build${BUILD_NUMBER}; mkdir -p "$OUT"
# ASC_KEY_PATH/ID/ISSUER from ~/.asc/config.json + `asc doctor`

# 1) Archive (automatic signing needs the ASC API key for -allowProvisioningUpdates)
asc xcode archive \
  --project apps/ios/ADE.xcodeproj --scheme ADE \
  --archive-path "$OUT/ADE.xcarchive" --overwrite --output json \
  --xcodebuild-flag=-allowProvisioningUpdates \
  --xcodebuild-flag=-authenticationKeyPath --xcodebuild-flag="$ASC_KEY_PATH" \
  --xcodebuild-flag=-authenticationKeyID --xcodebuild-flag="$ASC_KEY_ID" \
  --xcodebuild-flag=-authenticationKeyIssuerID --xcodebuild-flag="$ASC_ISSUER_ID" \
  --xcodebuild-flag=CURRENT_PROJECT_VERSION=$BUILD_NUMBER \
  --xcodebuild-flag=MARKETING_VERSION=$MARKETING_VERSION

# 2) Export the IPA (auto-signing variant)
asc xcode export \
  --archive-path "$OUT/ADE.xcarchive" \
  --export-options apps/ios/ExportOptions.auto.plist \
  --ipa-path "$OUT/ADE.ipa" --output json

# 3) Upload — NOTE: `asc builds upload` has NO --timeout (only --wait / --poll-interval).
#    Passing --timeout makes it print help and upload nothing.
asc builds upload --app "$APP_ID" --ipa "$OUT/ADE.ipa"

# 4) Wait for VALID (this is where --timeout lives)
asc builds wait --app "$APP_ID" --build-number "$BUILD_NUMBER" --version "$MARKETING_VERSION" \
  --platform IOS --timeout 40m

# 5) Resolve the build ID, then answer encryption
BUILD_ID=$(asc builds list --app "$APP_ID" --limit 8 \
  | jq -r --arg v "$BUILD_NUMBER" '.data[]|select(.attributes.version==$v)|.id' | head -n1)
asc builds update --build-id "$BUILD_ID" --uses-non-exempt-encryption=false

# 6) Distribute. INTERNAL groups auto-receive every processed build — do NOT add-groups them
#    (it errors "Cannot add internal group to a build"). add-groups is for EXTERNAL groups only:
for gid in "${EXTERNAL_GROUP_IDS[@]}"; do
  asc builds add-groups --build-id "$BUILD_ID" --group "$gid" --submit --confirm
done
# If you have a mixed list, pass --skip-internal so internal IDs are ignored.
```

For **internal-only** releases (the common case — "ship to internal testers") steps 1–5 are the whole job: once the build is `VALID` with encryption answered, it is already live for every internal group. There is no add-groups step.

If a heavy step (archive/upload) errors, the IPA from a successful export is reusable — re-run only from the failing step. Update `.ade/release/v<VERSION>.json` with `status=ios-running` while waiting.

### 7f. Post-upload verification (always run this)

Do not declare iOS done based on `BETA_APPROVED` alone. Verify the build is in a **non-empty** group:

```bash
asc builds info --build-id "$BUILD_ID"                            # processingState=VALID, usesNonExemptEncryption=false
asc builds build-beta-detail view --build-id "$BUILD_ID"          # externalBuildState=BETA_APPROVED, internalBuildState=READY_FOR_BETA_TESTING
for gid in "${GROUP_IDS[@]}"; do
  count=$(asc testflight groups links view --group-id "$gid" --type betaTesters | jq -r '.meta.paging.total')
  members=$(asc testflight groups links view --group-id "$gid" --type builds | jq -r '.data[].id' | grep -Fx "$BUILD_ID" || true)
  echo "group=$gid testers=$count build_present=$([ -n "$members" ] && echo yes || echo no)"
done
```

All three must be true for a given group:
- `testers > 0` (otherwise no humans see the build)
- build appears in the group's builds list — **automatic for internal groups** the moment the build is `VALID` + encryption answered; only present for external groups after `add-groups`
- internal → `internalBuildState` is `READY_FOR_BETA_TESTING` or `IN_BETA_TESTING`; external → `externalBuildState` is `BETA_APPROVED`

If any fails, fix it explicitly and re-verify. Do not trust `autoNotifyEnabled=true` alone — it only controls push notifications, not distribution.

**External (public-link) builds need Beta App Review.** A freshly uploaded external build sits at `externalBuildState=WAITING_FOR_BETA_REVIEW` until Apple approves it — and the public TestFlight link keeps serving the **last approved** build until then. Review is per *marketing version*, not per build: the first external build of a new version is reviewed (hours–a day); later builds of the **same** version generally auto-clear. Internal distribution never needs review.

---

## Phase 8 — Summary

Before printing the summary, verify the draft release carries every expected asset. Do not flip the draft and do not report `done` if anything is missing — surface the gap.

```bash
gh release view "v<VERSION>" --json assets --jq '.assets[].name' | sort
```

The mac build runs a **per-arch matrix** (arm64 + x64), so the expected set is
**5 assets** (releases are macOS-only; Windows publishing is commented out in
`release-core.yml`):
- `ADE-<version>-arm64.dmg`
- `ADE-<version>-arm64.zip`
- `ADE-<version>-x64.dmg`
- `ADE-<version>-x64.zip`
- `latest-mac.yml`

> This skill previously expected a single `-universal.*` set plus a `.blockmap`.
> That changed when the build moved to the parallel-arch matrix (v1.2.5). There
> are **no** separate `.blockmap` assets in this layout — do not flag their absence.

electron-updater consumes `latest-mac.yml` → the per-arch `.zip`s (macOS updates
install from the zip, not the DMG). The real check is that `latest-mac.yml`
references only assets that are actually present — otherwise auto-update breaks:

```bash
gh release download "v<VERSION>" --pattern latest-mac.yml --dir /tmp --clobber
assets=$(gh release view "v<VERSION>" --json assets --jq '.assets[].name')
grep -oE 'ADE-[^ ]+\.(zip|dmg)' /tmp/latest-mac.yml | sort -u | while read f; do
  echo "$assets" | grep -qx "$f" && echo "  ok $f" || echo "  MISSING referenced asset: $f"
done
```

If a referenced file is missing, or the 5-asset set is incomplete → the mac build
or upload broke; re-inspect the `build-mac-release` matrix jobs.

Then print a single final block and stop:

```
Release v<VERSION> — summary

- Changelog:     https://www.ade-app.dev/docs/changelog/v<VERSION>
- Draft release: <gh release url>  (still draft — flip manually)
- Desktop assets: mac=<present|MISSING>
- Workflow run:  <gh run url>      (conclusion: success)
- iOS TestFlight build <BUILD_NUMBER>: <VALID | processing | skipped>
- Beta group:    <group name | n/a>

Next steps:
1. Review the draft release, then `gh release edit v<VERSION> --draft=false` to publish.
2. Publishing automatically bumps the Homebrew tap (arul28/homebrew-ade) via the
   `update-brew-tap.yml` workflow — verify with
   `gh run list --workflow update-brew-tap.yml --limit 1` after publishing.
   Manual fallback if that run fails: `scripts/update-brew-tap.sh v<VERSION>`.
```

If any phase ended in `blocked`, the summary says `BLOCKED` at the top with the failing phase and the command to resume.

---

## State file schema

`.ade/release/v<VERSION>.json` — created in Phase 5, read/written on every wake-up.

```json
{
  "version": "v1.1.3",
  "lastTag": "v1.1.2",
  "releaseSha": "<sha>",
  "scope": { "desktop": true, "ios": true },
  "workflowRunId": 1234567,
  "workflowStatus": "queued | in_progress | success | failure | cancelled",
  "iosBuildNumber": 42,
  "iosBuildId": "<asc build id>",
  "iosStatus": "pending | uploading | processing | valid | distributed | failed",
  "phase": "5 | 6 | 7 | 8",
  "status": "running | done | blocked",
  "notes": []
}
```

On wake-up:
1. Read the state file. If `status=done` or `status=blocked`, print the summary and exit.
2. Otherwise resume at `phase`.

---

## Things this command will NOT do

- Publish the GitHub draft release (human must flip `--draft=false`).
- Force-push to `main` or any tag.
- Bypass CI, pre-commit hooks, or rulesets without an explicit user ask.
- Edit existing changelog files (only creates the new `vX.Y.Z.mdx`).
- Guess the version number or iOS build number — always ask.
- Re-release an already-tagged version. If `vX.Y.Z` exists, stop and surface.

---

## References

- `AGENTS.md` — release + `asc` guidance (canonical).
- `docs/playbooks/ship-lane.md` — how to drive the changelog PR to merge in Phase 4.
- `.github/workflows/release.yml`, `release-core.yml`, `prepare-release.yml` — desktop release pipeline.
- `changelog/v1.1.2.mdx` — template to match for tone, structure, and section shape.
- `docs.json` — Mintlify page registration (insert new entry at top of the `Changelog` group).
- `asc-*` skills — iOS build/publish specifics.
