# Beta update track

Working plan for the Beta track. It records the decisions, the shared
contracts, and every lesson from T3 Code's Stable/Nightly history with the
guard that covers it. Keep it current while the work runs.

## Decisions (owner-approved, 2026-10-29)

- Beta is an **update track** of the normal ADE install, not a package
  channel. It uses the same app id (`com.ade.desktop`), the same `~/.ade`, the
  same brain service, the same `ade` CLI and the same device identity.
- One app on disk. A track switch installs the other track's build over the
  current app, as T3 does.
- The app file and Electron's app name stay `ADE` on both tracks. A beta build
  differs only by its version (`X.Y.Z-beta.N`), its orange icon
  (`build/icon.beta.icns`), the "Beta" label next to the logo, and Settings.
  Keeping the name fixed keeps `/Applications/ADE.app`, the keychain and
  `safeStorage` names, the Windows install folder and every CLI path the same
  (T3 #20906, #20103, #22219).
- The old Beta **channel** (`package:beta`, `~/.ade-beta`, `ade-beta`,
  `ADE Beta.app`, `ADE_PACKAGE_CHANNEL=beta`) is removed. Alpha stays.
- Beta builds run automatically from `main`. Stable promotes the commit of
  the newest beta that passes the Sentry gate
  (`scripts/release-tools/beta-gate.mjs`): machines ran it, Sentry received
  errors the whole time it was out, and it brought no new errors. Age is not
  a measure. The stable tag is pushed by the release agent as the owner,
  because the tag rule refuses the workflow's own token.
- iPhone: two TestFlight apps (owner-approved 2026-11-01,
  `docs/plans/ios-beta-app.md`). Beta builds go to the separate "ADE Beta" app
  (`com.ade.ios.beta`); a stable release builds the normal app for every
  group. The phone shows an orange "Beta" chip on a machine that runs the Beta
  track.
- New UI follows `docs/design/notices.md` and `docs/design/visual-language.md`.
  Words are short and plain. "Stable" and "Beta" are the only track names.

## Contracts

### Versions and tags

- Stable: `vX.Y.Z`. Beta: `vX.Y.Z-beta.N`, where `X.Y.Z` is the latest stable
  with the patch raised by one and `N` counts from 1 for that base.
- The track of a build comes from its version only: a `-beta.` prerelease is
  Beta, anything else is Stable (`apps/desktop/src/shared/updateTrack.ts`).
- Beta builds are packaged with `-c.detectUpdateChannel=false`, so their
  updater manifests keep the names `latest-mac.yml` and `latest.yml`.

### Release manifest (every release, stable and beta)

Asset `release-manifest.json`:

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
- Assets, replaced after each beta is fully published (never before, T3
  #26917):
  - `latest-mac.yml` and `latest.yml`: the beta's updater manifests with every
    file URL made absolute to the versioned beta release.
  - `beta.json`: the current beta's `release-manifest.json`.
- Clients read `https://github.com/arul28/ADE/releases/download/beta-feed/`.
  A 404 there means "no beta right now", never an error banner.
- Why not electron-updater's GitHub provider: for a `-beta.` version it takes
  the newest feed entry of any kind, stable included
  (`GitHubProvider.getLatestVersion`). The fixed feed names exactly one build.

### Track selection on a machine

- `~/.ade/update-track.json`: `{ "track": "stable" | "beta", "updatedAt" }`.
  It is the one source for the app, the brain and the CLI. Absent means the
  track of the running version.
- Updates are offered only from the selected track and only when newer than
  the running build. Crossing tracks happens only through the guarded switch.

### Database compatibility

- Every `openKvDb` database records, in a local-only table, the highest
  `DB_COMPAT_LEVEL` that has opened it.
- Raise `DB_COMPAT_LEVEL` in the same PR as any migration an older build cannot
  run against: a rebuilt or renamed table, a dropped or renamed column, a new
  `NOT NULL` column with no default, or rewritten data. Additive changes (a new
  table, a nullable or defaulted column, an index) do not raise it.
- A switch to a build whose manifest `dbCompat` is lower than a local
  database's recorded level is blocked, and so is a switch whose levels cannot
  be read (T3 #26288).
- Before the first open by a new app version, ADE copies each database with
  SQLite's online backup (`<db>.pre-<version>-from-<previous>.bak`, disk
  checked first).
- Copies do not pile up (`dbCompatRecord.ts`):
  - One copy per database. A new copy deletes that database's older copies
    at once.
  - The copy goes once the update has proven itself for that database: a
    clean open by the running version at least 24 hours after its first
    clean open of that file (`firstOpenedAt` in `<db>.compat.json`). That
    first clean open is also what stops the recovery window from offering
    Go back for that database, so the window never offers a copy cleanup
    could take.
  - What "Go back" set aside (`…_kept.bak`) is never "superseded"; it goes
    7 days after the version ADE went back to first opened the file.
  - Cleanup reads only the database's own folder, and only once something is
    due (the record says when it is done). It deletes only names that parse
    as copies, plus journal files left beside a copy that is gone; never the
    live database, its journal files, kvDb's `.pre-crsqlite-w1.bak`, or a
    `.tmp`. Each deletion is a `db.copy_deleted` info line. A file it cannot
    delete (a Windows lock) is skipped, logged, and tried again on a later
    open; the open never fails for it.
- Settings › Advanced › Database copies lists them (This computer only) with
  Reveal and Delete, and says the rule in one sentence. It has no restore:
  "Go back" in the "ADE could not start" window restores, after the brain
  has stopped.

### Startup recovery

Code: `apps/desktop/src/main/services/startupRecovery/`.

The "ADE could not start" window opens once per launch, from failure
signals ADE already had:

| Trigger | Signal | Needs an update |
|---|---|---|
| `database` | Before any project opened this launch, a project open fails with `db_integrity`, `migration_incomplete` or `migration_unknown_state` (from the error's code, or `classifySqliteOpenError` for a raw SQLite error), or the brain wrote a `project_db_open` last-failure record during this launch | yes |
| `brain` | A project open fails with `brain_crash_looping`, or the post-update transaction fails at `service`, `restart` or `health` and the brain recorded a `brain_startup` or `project_db_open` failure during this launch | yes |
| `window_crashed` | The main window's renderer crashed until its recovery budget ran out | no (no Go back once a project opened this launch) |
| `window_load_failed` | The main window's renderer never loaded | no (no Go back once a project opened this launch) |

"Needs an update" means the update record (`recentlyInstalledUpdate`) names
the running version, or a database copy names a move into it. Without one,
the project recovery screen handles the failure. A database whose compat
record says the running version already opened it cleanly does not count
either (for `brain_crash_looping`, the machine database): that failure came
later, and going back would drop what was done since. Problems the person can fix
(disk full, a cloud folder, moved data, macOS blocking the service) never
open the window.

The window says what happened in one sentence and offers two choices, each
with one sentence of what it does: Go back to `<version>` and Try again
(ADE's normal restart, with its quit prompt in an app window). Open logs
folder (`~/.ade/runtime`) and Copy details are for support. Go back first
shows what it will do and asks: what is put back and from when, that other
projects stay as they are, that the current data is saved as a copy first,
that ADE downloads, closes, installs and reopens in about a minute, and that
automatic updates turn off until a newer version is out. Then it shows
progress (checking, a download bar, installing). Every error says what went
wrong and what to do next. It is its own small page and preload, so it opens
when the app's renderer is what broke.

**Which version and which databases** (`goBackPlan.ts`, tested): only
databases that go back count. This computer's database and the personal
chats' database always go back; a project's database only when it is the
one that failed to open. A project database syncs with other machines, and
putting back one that works would drop what was done in it since the update.
None goes back that the running version already opened cleanly (its compat
record names the running version and has `firstOpenedAt`), whatever the
trigger: its work since then lives only in it. If that leaves nothing to put
back, there is no Go back. Among those, the copies whose name moves into the running version
(`pre-<running>-from-<V>`) from a release version are the way back.
`unknown`, `before-1.2.127` and `_kept` copies are not. The update record's
`fromVersion` wins when a copy for that move exists; otherwise the newest
copy's `<V>` does. Every other database stays as it is, and must be readable
by `<V>` (below).

**Going back**:

1. Read the target's `release-manifest.json`. A database that is not
   restored must be at or below its `dbCompat` (T3 #4374); a 404 is a
   pre-manifest stable at level 1.
2. Wait for any check or download already running (the update check's own,
   or the re-download of a vanished staged archive) to settle, drop whatever
   it staged, then point the updater at that release
   (`/releases/download/v<V>/`, generic provider, `allowDowngrade`) and
   accept only `<V>`. A track switch is refused meanwhile.
3. When it is downloaded, the ordinary `quitAndInstall` runs. Its prepare
   step stops the service brain, then the go-back stops the app's own brain
   child and closes the open projects, checks every copy is still there
   (it stops, moving nothing, if one is gone), then moves each current
   database (with its `-wal`, `-shm`, `-journal`) to
   `pre-<V>-from-<running>_kept.bak` (`_kept2` on a repeat) and moves the
   copy into place. All or nothing: if any move fails, every database
   already moved is moved back, and the error says whether that worked.
   Moves only: nothing is overwritten or decrypted (T3 #20906), a file ADE
   cannot open is kept as it is, and renames need no free space. A failed
   restore stops the install; ADE stays open and the service comes back.
4. The compat record is rewritten for `<V>` with no `firstOpenedAt` (its
   day starts at `<V>`'s first clean open) and at `<V>`'s own level from its
   manifest (level 1 for a stable from before manifests). This is the one
   place a level is lowered: the file is now the older copy. Every normal
   open still never lowers it. `wentBackFrom` is saved so
   ordinary checks never offer that build again, automatic install is
   turned off (below), and `startupRecovery.went_back` is logged (a
   release-health event the beta gate can read). Then the existing installer
   runs: Squirrel on macOS, the NSIS installer on Windows
   (`%LOCALAPPDATA%\Programs\ADE`).

**Not looping back onto the broken build.** 1.2.127 (the stable when this
was built) does not know `wentBackFrom`. The one persisted switch it reads
that stops it installing an update by itself is
`autoUpdatePreferences.automaticInstall` in `ade-state.json`: when it is
false there is no automatic apply and no install on quit. Go back sets it to
false (and records whether it was on). The older build still downloads and
offers the build it left, so the confirmation says, in one line, not to
install it until a newer version is out. A build newer than the one left
turns automatic install back on if Go back turned it off, and drops
`wentBackFrom`. Refusing to go back to builds older than this feature would
leave the person on a build that cannot start, which is worse than an offer
they are told to ignore.

Open:

- Tried in a dev app (window, confirmation, Cancel, Copy details, Open logs
  folder, Try again, the Settings list) and with the real controller,
  restore and cleanup code on temp files (including a failed third move, a
  copy gone mid-way, a locked folder). The download and install of an older
  release have not run on a packaged build, on macOS or Windows.
- An older build still offers the build it left (it cannot know better);
  only the person can install it, and the window tells them not to. Another
  machine's "Update & restart" could also install it.
- A failed restored project database comes back as of the update; its
  changes after that are in the `_kept` copy, which support can read for a
  week.
- If the native install fails after the restore, ADE stays on the broken
  version with the restored databases and automatic install off; it copies
  them again before migrating, and nothing is lost.
- A desktop main process that crashes before its first window is not
  caught. A launch marker would be cheap to write, but to help it would have
  to skip the normal startup on the next launch, and a false positive (a
  force-quit while starting) would then keep ADE from starting. Left out.

## Work list

1. Track model, `update-track.json`, beta feed client, offer filter.
2. Remove the old Beta channel.
3. DB compat level, recorded level, snapshots before migrations.
4. Track switch in Settings → About, with the database guard and a clear
   blocked message. Remote "Update & restart" never crosses a machine's track.
5. Branding: header "Beta" label, About, orange icon in beta builds, Sentry
   `track` tag.
6. CLI: `ade brain update` follows the machine's track; `ade doctor` shows it.
7. CI: beta workflow, prerelease publish, feed, prune, notes, failure issue,
   launch check with an old database, `scope.sh` look-back fix.
8. iOS: defer changes for unknown columns and replay them once the column
   exists (as desktop does), "Beta" chip, TestFlight builds from CI to
   Internal Testers.
9. Resume: cap automatic resumes at 3 in a row (persisted), never resume a
   chat that waits for the user, resume before optional work.
10. Release skill: stable promotes the newest beta that passes the Sentry gate.
11. One-time real-machine tests (MacBook, Windows PC, no-app machine).

## T3 lessons and their guards

| T3 | What broke | Guard here |
|---|---|---|
| #2186 | Nightly tags not semver, no versions found | `vX.Y.Z-beta.N`; feed check in the beta workflow |
| #2049 | Updates from the other channel offered | Offer filter by selected track |
| #4374, #13282 | Downgrade never installed; old stable crash-looped on newer data | DB compat guard before any switch; old builds already skip unknown tables and columns |
| #25175, #26830 | A nightly migration later removed; machines bricked | ADE migrations are idempotent "ensure" steps; compat level rule; never remove a merged migration |
| #15017 | Stale per-track DB reused | One shared `~/.ade`; no per-track DB |
| #20906, #22219, #23917 | Rename changed safeStorage key; connections lost | App name fixed as `ADE`; never overwrite an undecryptable file (going back moves files, never overwrites) |
| #20103 | `.app` rename failed relaunch | App file name fixed |
| #20345, #25450 | Windows update stuck on quit | Existing quit hard deadline; real Windows test |
| #11753, #9138 | Changelog mixed tracks | What's new filters by track |
| #22907 | Stable lookups buried under nightlies | Stable uses `releases/latest`; beta uses the fixed feed |
| #25928, #25840 | Nightlies passed CI but would not open | Beta publishes only after a packaged launch with an old database |
| #26917 | Prerelease public before assets uploaded | Draft first; feed replaced last |
| #7579, #5253 | String version compare; downgrade offered | Semver compare; track-aware messages name the side behind |
| #23109, #23647, #26446 | Wire change broke old clients silently | Additive wire rule; protocol number; plain "needs a newer ADE" message |
| #25724 | CLI on PATH kept the old version | CLI path never changes; doctor shows drift |
| #26144, #23843 | Second app hung with no window | Single owner with a clear window |
| #24340 | Nightly telemetry looked like production | Sentry `track` tag from day one |
| #18461, #25603 | Resume loops | Cap of 3, persisted |
| #21716 | Days-old tasks re-armed | Existing 6 h age limit, also for wake-ups |
| #25962 | Resume waited behind optional work | Resume first |
| #20240 | Pending inputs lost on restart | Check queued messages and open questions survive |
| #19837 | One slow machine blocked the run | Per-machine progress and Retry |
| #19291 | Silent reinstall after a failed update | Existing "install did not land" record; notice with Retry |

## CI notes (work item 7 and 10)

How the pipeline is built, and what is still open.

- `beta.yml` runs at :17 and :47. `scripts/beta/resolve.mjs` picks the newest
  main commit with a green `ci-pass` newer than the last **published** beta,
  skips inside the 3 h gap or when nothing under the desktop product paths
  changed (`force` overrides both), and names `vX.Y.Z-beta.N`. Then
  `release-core.yml` → `release-publish.yml` (draft prerelease, assets,
  inventory check, then public) → feed → prune → report. Fixture mode:
  `node scripts/beta/resolve.mjs --fixture <json>` (shape in the file header).
- Beta builds: `scripts/beta/apply-build-track.mjs` runs after the version
  stamp in every mac and Windows packaging job. On a beta tag it sets
  `build.detectUpdateChannel=false` and `build.mac.icon=build/icon.beta.icns`
  in the runner's `package.json`, and overwrites `build/icon.ico` with a
  one-entry 256 px PNG icon taken from `icon.beta.icns` (the same shape as the
  stable `icon.ico`). `build.win.icon` stays `build/icon.ico`, which
  `validate-win-artifacts.mjs` requires.
- Tags: `release-publish.yml` now creates a missing tag at the vetted commit
  before it creates the draft (a draft has no tag, and the target checks read
  it). This also makes `release.yml` dispatches work without a pushed tag,
  which the release skill now uses for stable. `release.yml` no longer starts
  on `v*-*` tag pushes.
- Previews: `preview_ref` builds `vX.Y.Z-beta.0.preview.<run>` without the
  main and `ci-pass` gates (release-core refuses the bypass for any other tag
  shape). Published as a prerelease, never fed, pruned after 7 days. Preview
  failures do not touch the "Beta build failed" issue.
- `release-manifest.json` is written for every release by
  `scripts/release-tools/release-manifest.mjs`; `verify-desktop-draft.sh`
  requires it. `publishedAt` is the time the publish job assembled the draft
  (for stable, the owner undrafts later).
- `beta-feed` is created on first use as a prerelease. Manifests are uploaded
  before `beta.json`. A beta without a Windows build removes `latest.yml` from
  the feed. This relies on immutable releases staying off for the repo
  (checked 2026-10-29: off); with them on, the feed's assets cannot be
  replaced.
- Sentry: a beta is its own release (`ade@1.2.128-beta.3`). Releases carry no
  environment, so the `track` tag must come from the app (work item 5).
- `concurrency.queue: max` was left out: an unknown key would stop every
  beta, and a replaced pending run is harmless because each run resolves the
  newest green commit itself.

### iOS TestFlight from CI (work item 8)

- `beta.yml`'s `ios` job calls `ios-testflight.yml` once a real beta is
  public, beside the feed. Previews never call it. The feed, prune and report
  jobs do not wait for it.
- It builds the ADE Beta app (`com.ade.ios.beta`, `Beta` configuration),
  never the normal app. See `docs/plans/ios-beta-app.md`.
- Its `gate` job (Ubuntu) builds only when `apps/ios`, the workflow or the
  script changed since the newest `ios-beta-v*-build*` tag. Not the previous
  beta: a beta whose TestFlight build failed would
  otherwise hide its iOS changes from the next one.
- The `testflight` job (`xcode-27` runner, Xcode 27.1, `asc` 1.2.3 pinned by checksum)
  runs `scripts/release-tools/ios-testflight-ci.sh`: next build number (the
  higher of both apps), `xcodebuild archive` and `-exportArchive` with
  `-allowProvisioningUpdates` and the API key, IPA check (bundle IDs,
  widgets, versions, no App Clip), `altool` validate, upload, dSYMs to
  Sentry, wait for processing, encryption flag, What to Test, the "Internal
  Testers" group, the "Public Beta" group submitted for beta review (a
  warning when it fails), then the `ios-beta-v<mv>-build<n>` tag. `--dry-run`
  stops after the IPA check. Dispatch it by hand with `git_ref`, `force` and
  `dry_run`.
- A failure never fails the beta: the step and the job continue on error,
  and the job opens or comments on the "iOS TestFlight failed" issue (label
  `beta`), closed by the next build that reaches testers.
- Signing. With no `IOS_SIGNING_P12_BASE64` secret it is cloud signing:
  Xcode makes an Apple Development certificate on the runner for the archive
  and signs the export with a cloud-managed Apple Distribution certificate.
  Both need the `APPLE_API_KEY_*` key to have the **Admin** role; an App
  Manager or Developer key fails at the archive ("No signing certificate")
  or the export (cloud signing permission). The app's capabilities (push,
  Sign in with Apple, associated domains, App Group, App Clip) all work with
  automatic signing; none needs a manual profile. Each cloud run leaves one
  "Created via API" development certificate on the team; revoke old ones now
  and then. If the key is not Admin, the owner adds two secrets and nothing
  else changes: `IOS_SIGNING_P12_BASE64` (a base64 .p12 with an Apple
  Development and an Apple Distribution certificate and their private keys)
  and `IOS_SIGNING_P12_PASSWORD`. The key then needs only App Manager, for
  profiles and uploads.
- Not yet checked on a runner: the first real run. Start it with a dry run
  (`gh workflow run ios-testflight.yml -f dry_run=true`) once the key role is
  known.

Open (updated 2026-10-30):

- **In-app release notes: decided.** A stable build takes only `changelog/`
  from `main` before it packages (`release-core.yml`, "Take release notes from
  main"). The code is the promoted beta's; notes are text the app shows. The
  release skill pushes the notes before it dispatches the release.
- `scripts/package-channel.mjs` takes its base with `--exclude 'v*-*'`: done.
- The packaged launch check with an old database (T3 #25928, #25840): done.
  `apps/desktop/scripts/old-database-launch-check.mjs` runs in `smoke-mac-x64`
  and in `build-win-release`. The last stable release's runtime makes a
  project database; the new app's own brain must open it, list the same lane,
  write its compat record and copy the old file first.
- iOS TestFlight from CI (work item 8): built, never run. See "iOS
  TestFlight from CI" below. Its first run needs the owner to confirm the
  API key's role (or add the signing .p12). Stable releases still use
  `ios-testflight.sh` from the release skill.
- iOS columns: done. A change for a column the phone does not have is kept in
  the phone's own change table and not applied, so sync never freezes on it.
  Each `alter table ... add column` on a table with rows now records the
  column (`sync_pending_column_replays`, local only); the next open writes the
  newest stored value into each existing row, once, with change capture off.
  It never inserts or resurrects a row and skips a value a later delete
  superseded.
- iOS "Beta" chip: done. Settings › Machines and the machine page show it.
  The version is the machine's own: `brain.appVersion` in its hello (new,
  optional; older brains send none and show no chip), else its Bonjour
  `runtimeVersion`. Account rows of machines the phone never connected to
  show no chip: the account directory has no version.
- What's new on a beta build: done. `beta.yml` passes the beta's GitHub
  release notes to `release-core.yml`, whose packaging jobs write them as
  `changelog/v<beta>.mdx` in the runner's checkout
  (`scripts/beta/write-beta-changelog.mjs`); the bundler takes it with the
  stable notes before it. A beta links to its GitHub release, not to the
  website changelog.
- Resume: a chat whose turn waited for the user's answer or approval when
  ADE restarted is not resumed (persisted `awaitingInput`): done. Still to
  check on the real-machine test: queued messages survive an update
  (T3 #20240).
- "ADE could not start" window with "go back to the previous version", and a
  Settings list of database copies: built on `feat/startup-recovery`. See
  "Startup recovery" below. Not yet tried on a packaged build or on Windows.
- Tests broken on purpose by the channel removal: fixed in `/test`
  (`packagedSyncHostLaunchGate.test.ts` passes, checked 2026-10-30).

## Status (2026-10-30)

Built on `ade/beta-track`: work items 1, 2, 3 (compat level, records,
copies), 4 (switch + guard + remote guard), 5 (header label, About, orange
icon via CI, Sentry `beta` environment), 6 (`brain update` follows the
track), 7 (CI), 9 (resume cap of 3), 10 (release skill). Built on
`ios/beta-track-followups`: 8 (column replay, Beta chip, TestFlight CI; the
CI has not run on GitHub yet). Not built: 11 (real-machine tests), and the
open items above.
