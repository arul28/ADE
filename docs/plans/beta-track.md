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
- Beta builds run automatically from `main`. Stable promotes the commit of a
  beta the owner picked with the release agent.
- iPhone: one TestFlight app. Beta builds go to Internal Testers only; a stable
  release adds the same build to Friends and Public Beta. The phone shows an
  orange "Beta" chip on a machine that runs the Beta track.
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
  `VACUUM INTO` (`<db>.pre-<version>.bak`, last 2 kept, disk checked first).

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
8. iOS: defer changes for unknown columns (as desktop does), "Beta" chip,
   TestFlight builds from CI to Internal Testers.
9. Resume: cap automatic resumes at 3 in a row (persisted), never resume a
   chat that waits for the user, resume before optional work.
10. Release skill: stable promotes a chosen beta.
11. One-time real-machine tests (MacBook, Windows PC, no-app machine).

## T3 lessons and their guards

| T3 | What broke | Guard here |
|---|---|---|
| #2186 | Nightly tags not semver, no versions found | `vX.Y.Z-beta.N`; feed check in the beta workflow |
| #2049 | Updates from the other channel offered | Offer filter by selected track |
| #4374, #13282 | Downgrade never installed; old stable crash-looped on newer data | DB compat guard before any switch; old builds already skip unknown tables and columns |
| #25175, #26830 | A nightly migration later removed; machines bricked | ADE migrations are idempotent "ensure" steps; compat level rule; never remove a merged migration |
| #15017 | Stale per-track DB reused | One shared `~/.ade`; no per-track DB |
| #20906, #22219, #23917 | Rename changed safeStorage key; connections lost | App name fixed as `ADE`; never overwrite an undecryptable file |
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
