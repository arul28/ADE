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

### 3d. Self-check

```bash
ls changelog/v<VERSION>.mdx
grep -n "changelog/v<VERSION>" docs.json
```

Both must succeed before moving on.

---

## Phase 4 — Commit and push changelog to main

### Respect the "never edit main directly" rule

The user's standing guidance is to land changes through a lane/worktree, not by pushing directly to `main`. For the release changelog:

1. **Preferred path — PR merge:**
   - From the current ADE worktree branch, commit the changelog + `docs.json` change:
     ```bash
     git add changelog/v<VERSION>.mdx docs.json
     git commit -m "release: changelog for v<VERSION>"
     git push -u origin HEAD
     gh pr create --fill --title "release: changelog for v<VERSION>" \
       --body "Changelog for v<VERSION>. Tag will be cut after this lands on main."
     ```
   - Then hand off to `/shipLane` to drive the PR to merge, OR merge it yourself with `gh pr merge --admin --squash` if the user has already said "merge it".
   - Wait for `origin/main` to contain the new commit before Phase 5.

2. **Admin-bypass path (only if user explicitly says "push directly"):**
   - `git push origin HEAD:main` with admin bypass. Note in the summary that the ruleset was bypassed.

Do not force-push. Do not `--no-verify`. If the push is rejected, investigate (rebase onto latest `origin/main`) — do not bypass checks.

After the commit is on `origin/main`, re-fetch and record the SHA you will tag:

```bash
git fetch origin main
RELEASE_SHA=$(git rev-parse origin/main)
```

---

## Phase 5 — Tag and trigger the release workflow

1. Create the tag on the exact release SHA:

   ```bash
   git tag -a "v<VERSION>" "$RELEASE_SHA" -m "v<VERSION>"
   git push origin "v<VERSION>"
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
   gh release view "v<VERSION>" --json body,isDraft,url
   gh release edit "v<VERSION>" --notes "$(cat <<EOF
   ADE v<VERSION>

   Full changelog: https://www.ade-app.dev/docs/changelog/v<VERSION>

   <one-paragraph summary — same opener as the Mintlify page>
   EOF
   )"
   ```

   Leave `isDraft=true`. Do not publish.

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

If `scope.ios=true` and you do not have a build number:

> What build number should this TestFlight build use? The last one uploaded was `<N>` (run `asc builds list --app <APP_ID> --limit 5` to confirm).

Validate: must be a positive integer strictly greater than the last build number on record.

### Pre-flight

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

### iOS signing gotchas (mirrored from AGENTS.md — keep in sync)

- Project uses **automatic** signing (`CODE_SIGN_STYLE = Automatic`, `DEVELOPMENT_TEAM = VQ372F39G6`). `apps/ios/ExportOptions.plist` ships with `signingStyle = manual` + named profiles for CI determinism. Local ad-hoc exports need `signingStyle = automatic` instead (drop the per-bundle profile map).
- `asc signing fetch` only downloads provisioning profiles and the `.cer` — it does **not** include the private key. Don't expect it to make local signing work on its own.
- Local exports need the ASC API key passed to `xcodebuild`. In addition to `-allowProvisioningUpdates`:
  ```
  -authenticationKeyPath ~/.apple/asc/keys/AuthKey_WRRA7YU7RA.p8 \
  -authenticationKeyID WRRA7YU7RA \
  -authenticationKeyIssuerID 4d523a6c-e68c-49b2-8560-34e59786d8e3
  ```
  Pull current values from `~/.asc/config.json`; do not hard-code.
- After upload, `processingState = VALID` is not enough for TestFlight distribution. Also set `usesNonExemptEncryption` and assign to a group:
  ```bash
  asc builds update --build-id <ID> --uses-non-exempt-encryption=false
  asc publish testflight --build <ID> --group "<Beta Group>"
  ```

### One-shot publish

Full flow (archive + export + upload + distribute):

```bash
asc publish testflight \
  --app <APP_ID> \
  --project apps/ios/ADE.xcodeproj \
  --scheme ADE \
  --version <VERSION-without-v> \
  --build-number <BUILD_NUMBER> \
  --export-options <auto-plist> \
  --group "<Beta Group>" \
  --wait
```

If `--wait` times out, fall back to polling via `asc builds get` every 5 minutes using the same `ScheduleWakeup` pattern as Phase 6. Update `.ade/release/v<VERSION>.json` with `status=ios-running` so a re-invocation resumes here.

### Post-upload checks

```bash
asc builds get --build-id <ID> --json
```

Confirm:
- `processingState = VALID`
- `usesNonExemptEncryption` is answered
- Build is in the intended beta group

If any check fails, run it explicitly (see gotchas above) and re-verify.

---

## Phase 8 — Summary

Print a single final block and stop. Example:

```
Release v<VERSION> — summary

- Changelog:     https://www.ade-app.dev/docs/changelog/v<VERSION>
- Draft release: <gh release url>  (still draft — flip manually)
- Workflow run:  <gh run url>      (conclusion: success)
- iOS TestFlight build <BUILD_NUMBER>: <VALID | processing | skipped>
- Beta group:    <group name | n/a>

Next step: review the draft release, then `gh release edit v<VERSION> --draft=false` to publish.
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
