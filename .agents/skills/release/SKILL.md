---
name: release
description: 'ADE release conductor: detect whether desktop, iOS, and/or the Cloudflare web tier actually changed, bump desktop patch versions, keep iOS marketing versions fixed while bumping build numbers, ship desktop through the GitHub Actions release workflow, distribute TestFlight builds to all beta users, and reconcile every Cloudflare surface (Pages web client, the four Workers, D1 migrations, R2 buckets and lifecycle rules, Durable Object migration tags, cron triggers, vars and secrets) against what actually exists in the Cloudflare account.'
---

# ADE Release

ADE ships three independent tiers: **desktop** (GitHub Actions, macOS + Windows),
**iOS** (TestFlight, built on this Mac), and **Cloudflare** (the web client and
four Workers, deployed by `deploy-web.yml` on every push to `main`).

The mechanical steps are scripts. **Run them; do not retype their commands.**
Every hand-typed step in past releases is where the mistakes came from.

| Script | Does |
|---|---|
| `bash scripts/release-tools/scope.sh` | What each tier needs to ship, and `main`'s `ci-pass` |
| `bash scripts/release-tools/betas.sh` | The newest betas: age, commit, PRs, the Sentry gate's answer, and the recommended one to promote |
| `node scripts/release-tools/beta-gate.mjs <beta tag>` | The Sentry gate for one beta: it ran, Sentry was receiving errors, and it brought no new ones. Exit 0 pass, 1 fail, 2 could not check |
| `bash scripts/release-tools/verify-desktop-draft.sh <version>` | Checks the desktop draft; prints `DRAFT OK` or each problem |
| `bash scripts/release-tools/ios-testflight.sh <mv> <build> <sha>` | Archive → export → inspect → validate → upload → dSYMs to Sentry → wait → groups → tag. Resumable; retries every App Store Connect call. The dSYM upload needs an `ade-app` Sentry token (`SENTRY_AUTH_TOKEN` env or ADE secret); a `WARNING: Sentry dSYM upload FAILED` line means iOS reports for that build stay unsymbolicated, so rerun |

`reference.md` in this folder is the long form: incident history, the full
Cloudflare account checklist, and recovery detail. Read the section named below
only when a step goes off the happy path.

## Hard rules

- **Nothing changed → do nothing.** No release just to bump numbers.
- **Tiers are independent.** Ship only the tiers that changed. Never wait on one
  tier to start another; run long waits in the background and keep going.
- **Desktop bumps the patch only** (`v1.2.108 → v1.2.109`). **iOS keeps its
  marketing version**; the build number is App Store Connect's next one.
- **Stable promotes a beta that passed the Sentry gate.** `beta.yml` builds
  `vX.Y.Z-beta.N` from `main` every few hours; a stable release rebuilds the
  commit of a beta, as `vX.Y.Z`. The beta must pass `beta-gate.mjs`: machines
  ran it, Sentry received errors the whole time it was out, and it brought no
  new errors. Its age does not count. Never tag `main`'s head directly, and
  never promote a beta the gate failed or could not check.
- **Desktop builds only in GitHub Actions.** Never build, sign or upload desktop
  assets from this machine.
- **Never publish a draft that `verify-desktop-draft.sh` rejects.** npm versions
  published on undraft are permanent.
- **Every iOS build includes the app, widgets and App Clip.** The script refuses
  an IPA missing any of them.
- **A blocked tier is reported as blocked**, with the failing check and the
  recovery command. Never call it skipped, and never call the release done.

## The run

### 1. Scope (2 min)

```bash
git checkout main && git pull --ff-only
bash scripts/release-tools/scope.sh
```

- desktop `changed_files > 0` → desktop is in scope; the next tag is printed.
- ios `changed_files > 0` → iOS is in scope.
  `asc builds next-build-number --app 6762759870 --version <mv> --platform IOS`
  gives the build number; the marketing version is the current one
  (`MARKETING_VERSION` in the Xcode project).
- any cloudflare line with `undeployed_commits > 0` or `UNKNOWN` → Cloudflare
  needs work (step 5).
- Nothing in scope → stop. Changes only under `docs/`, `changelog/`, `sdk/` do
  not count. SDK page or README updates ride on the SDK PR, never a desktop tag.

### 1b. Pick the beta (desktop only)

```bash
bash scripts/release-tools/betas.sh
```

It runs the Sentry gate (`beta-gate.mjs`) on each beta that could still be
promoted, newest first, and recommends the first one that passes. The gate
needs an `ade-app` Sentry token (`SENTRY_AUTH_TOKEN` env or ADE secret); it
never passes without one.

Show the owner each beta's version, age, commit, PRs and gate result.
Promote the `recommended:` line; ask first only when the owner is present and
asked to choose (a scheduled run promotes it without asking). The stable
version is that beta's `X.Y.Z` (`v1.2.127-beta.4` → `v1.2.127`), which is
also scope.sh's `next`. Pin its commit: `BETA_SHA=<commit>`.

`recommended: none` means no desktop release this run: report each beta's
gate failure (no machine ran it, Sentry dropped errors, or new errors with
their issue ids) and carry on with the other tiers. Never release `main`'s
head instead, and never promote past a failed gate.

If `beta.yml` is failing, the open **Beta build failed** issue names the run.

### 2. Release notes and docs drift (desktop only, ~10 min)

Write `changelog/v<V>.mdx` (copy the previous one's shape). The changelog nav
lists months, not versions, so also add the release to `changelog/<YYYY-MM>.mdx`
for the release month (create that page if this is the month's first release).
Update the "Latest release" card in `changelog/index.mdx`, and add the `## [<V>]`
section plus compare links to `CHANGELOG.md`.

Then check the product docs, not just the changelog:

```bash
node scripts/docs-areas.mjs --changed --base v<previous-release>
```

It prints every docs area the release touched and the pages that belong to it.
For each area, update its pages or write one line in the release notes commit
message saying why it needs no change. A changelog entry is not a substitute:
the release gate exists because feature pages drift while changelogs stay
current.

These notes ship inside the app. On the first launch after a user installs
the update on that computer, What's new shows up to 3 catalogue pages they
have not seen, then an "And more" page with these notes for every version
since the one they came from (sections merged, an icon per section). A
stable build takes `changelog/` from `main` (only that folder; the code is the
beta's), so **push the notes before step 3** or they miss this build. So:

- Use `## New`, `## Improved`, `## Fixed`, then platform sections
  (`## iOS`, `## Windows`). Other names still show, with a plain mark.
- One plain sentence per bullet, ending in its PR number, e.g. `(#1896)`.
  The app turns the numbers into links.
- Pages are optional. A release with no new page still shows the notes.
- New pages: list the merged PRs with a demo video or clean screenshots and
  tell the owner which would make a page. A page is an entry in
  `apps/desktop/src/renderer/components/announcements/announcementPages.ts`
  (its `added` date is the day it ships) plus a short file in `pages/`. Use
  real captures from the dev app, cropped to the feature, GIF or WebP in
  `pages/assets/`. Pages show by themselves for 45 days. Pages are app
  code, not notes: a stable build has only the pages in the beta's commit.
  A new page merges to `main` in its own PR, and ships in the first stable
  release that promotes a beta built after that merge.

List the PRs from `git log v<previous-release>..$BETA_SHA`, not from `main`'s
head: the release ships the beta's commit, and anything merged after it waits
for the next one.

```bash
node scripts/validate-docs.mjs
git commit -m "docs(release): v<V> release notes" && git push origin main
```

### 3. Start the release (desktop only)

The beta's commit already has a green `ci-pass` (betas are built only from
one). Push the `v<V>` tag at that commit yourself; the push starts
`release.yml` on it.

```bash
git tag v<V> $BETA_SHA && git push origin v<V>
```

Do not dispatch `release.yml` instead: the tag rule ("Protect release tags")
lets only an admin create a stable `v*` tag, so the workflow's own token is
refused (HTTP 422) at the publish step, and dispatching as well as pushing
starts two runs.

Right after (or right away on an iOS-only release), start iOS in the
background. It does not need the desktop draft. TestFlight builds will move
to CI with the Beta track; until then this script is still the path:

```bash
IOS_SHA=$(git rev-parse origin/main)   # iOS is not promoted from a beta yet: main's head, the code scope.sh counted
git checkout $IOS_SHA
bash scripts/release-tools/ios-testflight.sh <mv> <build> $IOS_SHA   # run_in_background, timeout ≥ 90 min
```

### 4. Desktop workflow (~30 min)

```bash
gh run list --repo arul28/ADE --workflow release.yml --limit 2 --json databaseId,headBranch,status,conclusion
```

Poll it in the background. **The moment any job fails, read its log and act;
do not wait for the rest of the run.**

- Apple network errors (`NSURLErrorDomain`, `-1005`, staple `Error 68`, notary
  timeouts) are transient: `gh run rerun <id> --failed` once the run finishes.
  One narrow rerun; if it fails again, stop and report the job URL.
- Anything else is a real failure: stop and report it.

When the run is green:

```bash
bash scripts/release-tools/verify-desktop-draft.sh <V>                 # must print DRAFT OK
gh release edit v<V> --repo arul28/ADE --draft=false --latest
```

Undraft starts `publish-runtime-packages.yml` and `update-brew-tap.yml`. Both
must succeed. npm can take ~10 minutes to show new versions after a successful
publish; the run log's `+ @ade-dev/runtime@<V>` lines are the proof. Done when
`npm view @ade-dev/runtime@<V> version` answers `<V>`.

### 5. Cloudflare

When `scope.sh` shows every surface at `undeployed_commits=0`, CI already
deployed everything. Spot-check and move on:

```bash
for w in ade-account-directory-production ade-github-webhook-relay ade-tunnel-relay ade-push-relay; do
  echo "$w $(curl -fsS -m 10 https://$w.arulsharma1028.workers.dev/health | head -c 160)"; done
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://ade-account-directory-production.arulsharma1028.workers.dev/diagnostics/upload   # 400 = R2 bound
```

When a surface has undeployed commits or an `UNKNOWN` baseline, find its
failed `deploy-web.yml` job and rerun it (`gh run rerun <id> --failed`), or
dispatch a full reconcile with `gh workflow run deploy-web.yml`. Then follow
**reference.md → Phase 5.5** (account drift checks, migrations, verification,
rollback). Never deploy with raw `wrangler deploy`; the package scripts own the
migrations and preflights.

### 6. Report

One short block:

- desktop: tag, the beta it promoted, release URL, asset count, `DRAFT OK`,
  npm + brew status
- iOS: `<mv> (<build>)`, build id, each group with testers and the build
- Cloudflare: one line per surface — deployed by CI / rerun / unchanged, and
  what was checked
- anything blocked: the failing check and the recovery command
- repo clean and on `main`

## When something fails

| Symptom | Do |
|---|---|
| `main`'s `ci-pass` red before notes | Read the failed job. Flaky → rerun it. Secret-scan false positive → allowlist it in `.gitleaks.toml` in a PR. Real → stop. |
| Release `verify` job fails | Get `ci-pass` green on the same SHA, then `gh run rerun <id> --failed`. |
| A failed release left its tag behind | `release-publish.yml` creates the tag before the draft. To build again at a different commit, delete the private draft and the tag first: `gh release delete v<V> --repo arul28/ADE --yes` (drafts only; never a public release), then `git push origin :refs/tags/v<V>`. |
| No beta to promote | `beta.yml` failing: read the **Beta build failed** issue. Every beta fails the gate: report why and skip desktop this run. No machine ran it: it waits for a Beta machine. `gh workflow run beta.yml -f force=true` only if the owner asks. |
| `beta-gate.mjs` exits 2 | It could not check (no token, Sentry unreachable). Fix that; never read it as a pass. |
| Publish step: `Reference update failed (HTTP 422)` | The run tried to create the stable tag itself. Push `v<V>` at the run's commit (step 3), then `gh run rerun <id> --failed`. |
| Mac job: Apple network error | `gh run rerun <id> --failed`, once. |
| Notarization stuck > 15 min | `gh run cancel <id>`, then `gh run rerun <id> --failed`. |
| `verify-desktop-draft.sh` fails | Keep the draft private. reference.md → "Draft release verification". |
| npm publish run fails | Rerun `publish-runtime-packages.yml` for the same tag; it skips what already landed. |
| `ios-testflight.sh` fails or is killed | Rerun the same command. It reuses the IPA and skips the upload if App Store Connect has the build. |
| App Clip / signing error in the archive | Fix the signing; never drop a target. reference.md → Phase 5. |
| A Worker misbehaves after deploy | reference.md → Phase 5.5, Step 7 (rollback). |

Credentials: `gh` is signed in; App Store Connect keys are in `~/.asc/config.json`;
Cloudflare uses `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` from ADE secrets.
Never print their values.
