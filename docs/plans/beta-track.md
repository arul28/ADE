# Beta update track

The Beta track: its decisions, its shared contracts, and the guard for each
known failure of a Stable/Nightly split. Code cites this file; keep it current.
The user-facing behavior is in
`docs/features/onboarding-and-settings/desktop-auto-update.md` ("Update
tracks").

## Decisions

- Beta (shown as "DAEX Beta") is an **update track** of the normal install,
  not a package channel. It uses the same app id (`com.ade.desktop`), the same
  `~/.ade`, the same brain service, the same CLI and the same device identity.
- One app on disk. A track switch installs the other track's build over the
  current app.
- The app file and Electron's app name stay `ADE` on both tracks (frozen; see
  `docs/brand/README.md`). A beta build differs only by its version
  (`X.Y.Z-beta.N`), its orange icon (`build/icon.beta.icns`), the "Beta" label
  next to the logo, and Settings. A fixed name keeps `/Applications/ADE.app`,
  the keychain and `safeStorage` names, the Windows install folder and every
  CLI path the same.
- Beta builds run automatically from `main`. Stable promotes the commit of the
  newest beta that passes the Sentry gate (`scripts/release-tools/beta-gate.mjs`):
  machines ran it, Sentry received errors the whole time it was out, and it
  brought no new errors. Age is not a measure. The stable tag is pushed by the
  release agent as the owner, because the tag rule refuses the workflow's own
  token.
- iPhone: two TestFlight apps. Beta builds go to the separate Beta app
  (`com.ade.ios.beta`); a stable release builds the normal app for every
  group. See `docs/features/sync-and-multi-device/ios-companion.md`. The
  phone shows an orange "Beta" chip on a machine that runs the Beta track.
- "Stable" and "Beta" are the only track names. Alpha stays a separate
  package channel.

## Contracts

### Versions and tags

- Stable: `vX.Y.Z`. Beta: `vX.Y.Z-beta.N`, where `X.Y.Z` is the latest stable
  with the patch raised by one and `N` counts from 1 for that base.
- The track of a build comes from its version only: a `-beta.` prerelease is
  Beta, anything else is Stable (`apps/desktop/src/shared/updateTrack.ts`).
- Beta builds are packaged with `detectUpdateChannel=false`, so their updater
  manifests keep the names `latest-mac.yml`, `latest.yml`, `latest-linux.yml`
  and `latest-linux-arm64.yml`.

### Release manifest (every release, stable and beta)

Asset `release-manifest.json`, written by
`scripts/release-tools/release-manifest.mjs` and required by
`scripts/release-tools/verify-desktop-draft.sh`:

```json
{
  "schema": 1,
  "version": "1.2.128-beta.3",
  "tag": "v1.2.128-beta.3",
  "track": "beta",
  "commit": "<40-char sha>",
  "publishedAt": "<iso>",
  "dbCompat": 1,
  "syncProtocol": { "version": 1, "minSupported": 1 }
}
```

`dbCompat` comes from `DB_COMPAT_LEVEL` in
`apps/desktop/src/shared/releaseCompat.ts`. `syncProtocol` comes from
`apps/ade-cli/src/services/sync/syncProtocol.ts`.

### Beta feed

- A GitHub prerelease with the fixed tag `beta-feed`. It is never "latest".
- Assets, replaced only after each beta is fully published:
  - `latest-mac.yml` and `latest.yml`: the beta's updater manifests with every
    file URL made absolute to the versioned beta release.
  - `beta.json`: the current beta's `release-manifest.json`.
- Clients read `BETA_FEED_BASE_URL` (`updateTrack.ts`). A 404 there means "no
  beta right now", never an error banner.
- Why not electron-updater's GitHub provider: for a `-beta.` version it takes
  the newest feed entry of any kind, stable included. The fixed feed names
  exactly one build.
- The feed relies on immutable releases staying off for the repository; with
  them on, its assets cannot be replaced.

### Track selection on a machine

- `~/.ade/update-track.json`: `{ "track": "stable" | "beta", "updatedAt" }`.
  It is the one source for the app, the brain and the CLI. Absent means the
  track of the running version.
- Updates are offered only from the selected track and only when newer than
  the running build. Crossing tracks happens only through the guarded switch
  (`apps/desktop/src/main/services/updates/trackSwitchGuard.ts`). Remote
  "Update & restart" and `daex brain update` never cross a machine's track.

### Additive wire rule

Every app and brain speaks sync protocol 1. A protocol change may only add
things. When a newer side asks for a feature an older machine lacks, it shows
"needs a newer DAEX on this machine" instead of an error. The iPhone minimum
(`MIN_SUPPORTED_MOBILE_APP_BUILD`) is raised only up to a build the normal
iPhone app already has, because a raise reaches Beta machines first.

### Database compatibility

- Every `openKvDb` database records, in a local-only table, the highest
  `DB_COMPAT_LEVEL` that has opened it.
- Raise `DB_COMPAT_LEVEL` in the same PR as any migration an older build cannot
  run against: a rebuilt or renamed table, a dropped or renamed column, a new
  `NOT NULL` column with no default, or rewritten data. Additive changes (a new
  table, a nullable or defaulted column, an index) do not raise it.
- A switch to a build whose manifest `dbCompat` is lower than a local
  database's recorded level is blocked, and so is a switch whose levels cannot
  be read.
- Before the first open by a new app version, DAEX copies each database with
  SQLite's online backup (`<db>.pre-<version>-from-<previous>.bak`, disk
  checked first).
- Copies do not pile up (`apps/desktop/src/main/services/state/dbCompatRecord.ts`):
  - One copy per database. A new copy deletes that database's older copies.
  - The copy goes once the update has proven itself for that database: a
    clean open by the running version at least 24 hours after its first clean
    open of that file (`firstOpenedAt` in `<db>.compat.json`). That first clean
    open also stops the recovery window from offering Go back for that
    database, so the window never offers a copy cleanup could take.
  - What Go back set aside (`…_kept.bak`) goes 7 days after the version DAEX
    went back to first opened the file.
  - Cleanup deletes only names that parse as copies, plus journal files left
    beside a copy that is gone; never the live database, its journal files,
    `.pre-crsqlite-w1.bak` or a `.tmp`. A file it cannot delete (a Windows
    lock) is skipped and tried again later; the open never fails for it.
- Settings > Advanced > Database copies lists them (this computer only) with
  Reveal and Delete. It has no restore: Go back in the "DAEX could not start"
  window restores, after the brain has stopped.

### Startup recovery

Code: `apps/desktop/src/main/services/startupRecovery/`.

The "DAEX could not start" window opens once per launch, from failure signals
DAEX already had:

| Trigger | Signal | Needs an update |
|---|---|---|
| `database` | Before any project opened this launch, a project open fails with `db_integrity`, `migration_incomplete` or `migration_unknown_state` (from the error's code, or `classifySqliteOpenError` for a raw SQLite error), or the brain wrote a `project_db_open` last-failure record during this launch | yes |
| `brain` | A project open fails with `brain_crash_looping`, or the post-update transaction fails at `service`, `restart` or `health` and the brain recorded a `brain_startup` or `project_db_open` failure during this launch | yes |
| `window_crashed` | The main window's renderer crashed until its recovery budget ran out | no (no Go back once a project opened this launch) |
| `window_load_failed` | The main window's renderer never loaded | no (no Go back once a project opened this launch) |

"Needs an update" means the update record (`recentlyInstalledUpdate`) names
the running version, or a database copy names a move into it. Without one, the
project recovery screen handles the failure. A database whose compat record
says the running version already opened it cleanly does not count either: that
failure came later, and going back would drop what was done since. Problems
the person can fix (disk full, a cloud folder, moved data, macOS blocking the
service) never open the window.

The window offers Go back to `<version>` and Try again, plus Open logs folder
(`~/.ade/runtime`) and Copy details. Go back first shows what it will do and
asks, then shows progress. It is its own small page and preload, so it opens
when the app's renderer is what broke.

**Which version and which databases** (`goBackPlan.ts`): this computer's
database and the personal chats' database always go back; a project's
database only when it is the one that failed to open (a project database
syncs, and putting back one that works would drop what was done in it). None
goes back that the running version already opened cleanly. If that leaves
nothing to put back, there is no Go back. Among those, copies whose name moves
into the running version (`pre-<running>-from-<V>`) from a release version are
the way back; `unknown`, `before-1.2.127` and `_kept` copies are not. The
update record's `fromVersion` wins when a copy for that move exists;
otherwise the newest copy's `<V>`. Every other database must be readable by
`<V>`.

**Going back:**

1. Read the target's `release-manifest.json`. A database that is not restored
   must be at or below its `dbCompat`; a 404 is a pre-manifest stable at
   level 1.
2. Wait for any running check or download to settle, drop what it staged,
   then point the updater at that release (`/releases/download/v<V>/`,
   generic provider, `allowDowngrade`) and accept only `<V>`. A track switch
   is refused meanwhile.
3. When downloaded, the ordinary `quitAndInstall` runs. Its prepare step stops
   the brains and closes projects, checks every copy is still there, then
   moves each current database (with `-wal`, `-shm`, `-journal`) to
   `pre-<V>-from-<running>_kept.bak` and moves the copy into place. All or
   nothing: if any move fails, every moved database is moved back. Moves only:
   nothing is overwritten or decrypted, and renames need no free space. A
   failed restore stops the install.
4. The compat record is rewritten for `<V>` at `<V>`'s own level with no
   `firstOpenedAt`. This is the one place a level is lowered. `wentBackFrom`
   is saved so ordinary checks never offer that build again, automatic install
   is turned off, and `startupRecovery.went_back` is logged. Then the native
   installer runs.

**Not looping back onto the broken build.** Older builds do not know
`wentBackFrom`. The one persisted switch they read is
`autoUpdatePreferences.automaticInstall` in `ade-state.json`, so Go back sets
it to false (and records whether it was on). The older build still offers the
build it left, so the confirmation says not to install it until a newer
version is out. A build newer than the one left turns automatic install back
on and drops `wentBackFrom`.

Known gaps:

- The download and install of an older release has not run on a packaged
  build, on macOS or Windows.
- Another machine's "Update & restart" could install the build a machine went
  back from.
- A desktop main process that crashes before its first window is not caught
  (a launch marker would risk blocking normal starts after a force-quit).

## Parts

Code comments cite these numbers. All are built except item 11.

1. Track model, `update-track.json`, beta feed client, offer filter.
2. Remove the old Beta package channel.
3. DB compat level, recorded level, snapshots before migrations.
4. Track switch in Settings > About, with the database guard.
5. Branding: header "Beta" label, About, orange icon, Sentry `track` tag.
6. CLI: `daex brain update` follows the machine's track; `daex doctor` shows it.
7. CI: beta workflow, prerelease publish, feed, prune, notes, failure issue,
   launch check with an old database.
8. iOS: defer changes for unknown columns and replay them once the column
   exists; "Beta" chip; TestFlight builds from CI.
9. Resume: cap automatic resumes at 3 in a row (persisted), never resume a
   chat that waits for the user, resume before optional work.
10. Release skill: stable promotes the newest beta that passes the Sentry gate.
11. One-time real-machine tests (MacBook, Windows PC, no-app machine),
    including that queued messages survive an update.

## Known failures of a Stable/Nightly split and their guards

The numbers are T3 Code issues that showed each failure.

| T3 | What broke | Guard here |
|---|---|---|
| #2186 | Nightly tags not semver, no versions found | `vX.Y.Z-beta.N`; feed check in the beta workflow |
| #2049 | Updates from the other channel offered | Offer filter by selected track |
| #4374, #13282 | Downgrade never installed; old stable crash-looped on newer data | DB compat guard before any switch; old builds skip unknown tables and columns |
| #25175, #26830 | A nightly migration later removed; machines bricked | Migrations are idempotent "ensure" steps; compat level rule; never remove a merged migration |
| #15017 | Stale per-track DB reused | One shared `~/.ade`; no per-track DB |
| #20906, #22219, #23917 | Rename changed safeStorage key; connections lost | App name fixed as `ADE`; going back moves files, never overwrites |
| #20103 | `.app` rename failed relaunch | App file name fixed |
| #20345, #25450 | Windows update stuck on quit | Quit hard deadline |
| #11753, #9138 | Changelog mixed tracks | What's new filters by track |
| #22907 | Stable lookups buried under nightlies | Stable uses `releases/latest`; beta uses the fixed feed |
| #25928, #25840 | Nightlies passed CI but would not open | Beta publishes only after a packaged launch with an old database |
| #26917 | Prerelease public before assets uploaded | Draft first; feed replaced last |
| #7579, #5253 | String version compare; downgrade offered | Semver compare; track-aware messages |
| #23109, #23647, #26446 | Wire change broke old clients silently | Additive wire rule; protocol number; "needs a newer DAEX" message |
| #25724 | CLI on PATH kept the old version | CLI path never changes; doctor shows drift |
| #24340 | Nightly telemetry looked like production | Sentry `track` tag |
| #18461, #25603 | Resume loops | Cap of 3, persisted |
| #20240 | Pending inputs lost on restart | Queued messages and open questions survive |
| #19291 | Silent reinstall after a failed update | "Install did not land" record; notice with Retry |

## CI (work items 7 and 10)

- `beta.yml` runs when main's CI finishes (`workflow_run`; only a successful
  push to main passes the `resolve` job), and at :17 and :47. That timer is
  the `ade-github-webhook-relay` Worker's cron
  (`apps/webhook-relay/src/betaTimer.ts`); the workflow's own `schedule` is a
  backup, because GitHub's scheduler ran hours late for this repository.
- `scripts/beta/resolve.mjs` picks the newest main commit with a green
  `ci-pass` newer than the last published beta (a newer commit whose CI
  started under an hour ago holds the pick), skips inside the 3 h gap or when
  nothing under the desktop product paths changed (`force` overrides both),
  and names `vX.Y.Z-beta.N`. Fixture mode: `node scripts/beta/resolve.mjs
  --fixture <json>`. Then `release-core.yml`, `release-publish.yml` (draft
  prerelease, assets, inventory check, then public), then the `feed`,
  `prune` and `report` jobs.
- `scripts/beta/apply-build-track.mjs` runs after the version stamp in every
  mac and Windows packaging job. On a beta tag it sets
  `build.detectUpdateChannel=false` and `build.mac.icon=build/icon.beta.icns`,
  and overwrites `build/icon.ico` with a 256 px icon from `icon.beta.icns`
  (`build.win.icon` stays `build/icon.ico`, which
  `validate-win-artifacts.mjs` requires).
- `release-publish.yml` creates a missing tag at the vetted commit before the
  draft, so `release.yml` dispatches work without a pushed tag (the release
  skill uses this for stable).
- Previews: `preview_ref` builds `vX.Y.Z-beta.0.preview.<run>` without the
  main and `ci-pass` gates. Published as a prerelease, never fed, pruned after
  7 days.
- What's new on a beta: `scripts/beta/write-beta-changelog.mjs` writes the
  beta's GitHub release notes as `changelog/v<beta>.mdx` in the runner's
  checkout. A stable build takes only `changelog/` from `main` before it
  packages (`release-core.yml`, "Take release notes from main").
- The packaged launch check with an old database:
  `apps/desktop/scripts/old-database-launch-check.mjs` runs in
  `smoke-mac-x64` and `build-win-release` (`release-core.yml`).
- Sentry: a beta is its own release (`ade@1.2.128-beta.3`); the `track` tag
  comes from the app.

### DAEX Cloud template

`beta.yml`'s `cloud-template` job calls `cloud-template.yml` with the beta's
tag once it is public; a failure blocks nothing. A stable release builds it
from the `release: published` trigger. See `infra/ade-cloud/README.md`.

### iOS TestFlight from CI (work item 8)

- `beta.yml`'s `ios` job calls `ios-testflight.yml` once a real beta is
  public. Previews never call it; the feed, prune and report jobs do not wait
  for it.
- It builds only the Beta app (`com.ade.ios.beta`, `Beta` configuration).
- Its `gate` job builds only when `apps/ios`, the workflow or the script
  changed since the newest `ios-beta-v*-build*` tag (not the previous beta: a
  failed TestFlight build would hide its iOS changes from the next one).
- The `testflight` job (`xcode-27` runner) runs
  `scripts/release-tools/ios-testflight-ci.sh`: next build number (the higher
  of both apps), archive and export with the API key, IPA check, validate,
  upload, dSYMs to Sentry, the "Internal Testers" group, the "Public Beta"
  group submitted for beta review, then the `ios-beta-v<mv>-build<n>` tag.
  `--dry-run` stops after the IPA check. Dispatch by hand with `git_ref`,
  `force` and `dry_run`.
- A failure never fails the beta: the job opens or comments on the "iOS
  TestFlight failed" issue (label `beta`), closed by the next build that
  reaches testers.
- Signing: the archive signs with the CI's own Apple Development certificate
  in `IOS_SIGNING_P12_BASE64` and `IOS_SIGNING_P12_PASSWORD` (certificate
  `A4AM7ADKW2`, expires 2027-11-04). Without the .p12, Xcode makes a new
  "Created via API" certificate on every runner until the team's limit fills.
  The export signs with a cloud-managed Apple Distribution certificate, which
  needs the `APPLE_API_KEY_*` key to have the Admin role. To renew: generate a
  key and CSR, `asc certificates create --certificate-type DEVELOPMENT --csr
  <csr>`, bundle key and certificate into a .p12, set both secrets, then
  revoke the old certificate.
- Stable releases still build the normal app with
  `scripts/release-tools/ios-testflight.sh` from the release skill.
