# DAEX Cloud Mac drive template

A DAEX Cloud Mac is a NoMac Mac (macOS 26, Xcode 27, the iOS 27 Simulator,
6 cores, 8 GB) started for one lane, with that lane's own drive at `~/drive`.
NoMac deletes everything outside `~/drive` when the Mac stops, the login
keychain and every sign-in included, so DAEX lives on the drive. A lane's
first drive is a copy of its channel's **template drive**, built here.

The account server starts and stops the Mac (`apps/account-directory/src/cloud/macProvider.ts`).
This folder is what runs on it.

## On the drive

| Path | What |
| --- | --- |
| `~/drive/.daex/env.sh` | Where DAEX's files are; sourced by the boot, the supervisor and every command the server runs (`MAC_EXEC_PRELUDE`). Picks the newer of the template's DAEX and the one `ade brain update` installed. |
| `~/drive/.daex/boot.sh` | The boot job. The server runs it once per session with the brain's env (`bootMac`). It links the agents' dotfiles to the drive, then starts `supervise.sh` as the NoMac service `daex` and returns within seconds. |
| `~/drive/.daex/supervise.sh` | The brain's supervisor (the Mac counterpart of `infra/ade-cloud/template/ade-entrypoint.sh`): it unlocks the login keychain, brings DAEX up to `ADE_MIN_VERSION`, and keeps `ade --role cto serve` running with backoff. |
| `~/drive/.daex/ade/` | The template's DAEX release (binary and runtime). |
| `~/drive/.daex/tools/` | The agents that release pins, baked (`ADE_TOOLS_BAKED_ROOTS`). |
| `~/drive/.daex/home/` | The dotfiles agents keep in `$HOME` (`.claude`, `.codex`, `.config/gh`, `.ssh`, …), linked from `$HOME` at each boot. |
| `~/drive/.ade/` | `ADE_HOME`: the brain's identity, databases and sign-ins, and the DAEX `ade brain update` installs. `~/.ade` links to it. Never in the template. |
| `~/drive/src/<repo>` | The lane's repositories, as NoMac advises, so builds stay incremental. |
| `~/drive/.cache/` | Package and build caches (DerivedData, SwiftPM, CocoaPods, npm…), where NoMac already puts them. |

Two NoMac facts shape the scripts:

- **A command ends together with everything it started.** The boot job can't
  start the brain as a child process. It starts the brain under `nomac-service`.
- **A service is not restarted when it exits.** So `supervise.sh` is the loop.
  NoMac's idle clock counts commands, SSH and the desktop, never a service.
  While the brain is busy, it reports use to the server every 5 minutes
  (`POST /cloud/instances/:id/use`). The server then runs an empty command
  (`touchMac`), so NoMac never stops a Mac in the middle of a long build. The
  brain's own idle wait (5 minutes, from the boot report) stops it.

The loop marks the brain `ADE_BRAIN_SUPERVISOR=entrypoint`. A restart, such as
`ade brain update`, stops the brain and waits for the loop to start the new
one. It never installs launchd's service beside it
(`apps/ade-cli/src/serviceManager/entrypointSupervisor.ts`).

## Build a template

```sh
# One Mac, about 10 minutes; it is stopped on every exit path and the script waits for the drive's save.
daex secrets exec --env nomac_key -- sh -c 'NOMAC_API_KEY="$nomac_key" node infra/ade-cloud-mac/build-template.mjs --drive adem:template:stable --version 1.2.150'
# Point the channel at it (the server checks that NoMac has the drive):
daex secrets exec --env CLOUD_OWNER_TOKEN -- node scripts/cloud-owner.mjs mac-template stable --drive adem:template:stable --min-version 1.2.150
```

- **Naming.** The drive is named `<prefix>template:<channel>`, where the
  prefix is the environment's `MAC_LABEL_PREFIX`: production `adem:`, the
  test Worker `ademdev:`. The server refuses any other name for its
  environment.
- **What a rebuild changes.** A rebuild changes only what new Macs copy;
  lanes made earlier keep their own drive.
- **Upkeep.** A template drive unused for 25 days gets a 2-minute session in
  the daily upkeep (NoMac deletes a drive after 30 days without one). A
  missing template sends the owner an alert.
- **Min version.** `--min-version` brings an older drive's DAEX up to that
  release at its next boot.

## What the drive never holds

- **No identity.** No `ADE_HOME`: a copy starts signed out, as its own
  machine. The server gives each Mac `ADE_HOST_INSTANCE_ID=cloud:<mac id>`.
  The brain's machine key lives in that lane's `ADE_HOME`, on its own drive.
  The hardware anchor (IOPlatformUUID) changes with every session; that only
  refreshes the anchor column.
- **No secrets.** NoMac gives the account's secrets and Apple signing to
  every Mac the account starts **without** a label, never to a labelled Mac
  ("a user's Mac gets … none of the account's secrets, signing or drives").
  Every lane's Mac is labelled. The account keeps no secrets and no Apple
  connection anyway (checked on 2026-11-28: `GET /api/v1/secrets` and
  `GET /api/v1/apple` are empty). Keep it that way: the template build and
  the template upkeep start unlabelled Macs.
- **No join code.** A launch's one-time join code goes to the supervisor in
  `~/.daex-boot`, outside the drive, and the supervisor deletes the file once
  it has read it.

## Keychain and code signing on a stopped and restarted Mac

Each session gets a new login keychain, unlocked by `supervise.sh` with that
session's password (`$NOMAC_MAC_PASSWORD`, which NoMac also uses to answer the
macOS password dialogs). It is deleted at stop.

What works on every start, with nothing to set up:

- Simulator builds, runs and tests (`xcodebuild … -destination 'platform=iOS Simulator,…'`, `daex apple` on the local simulator).
- macOS builds that sign to run locally.
- Swift packages.
- Everything kept on the drive: repositories, DerivedData, package caches.

What doesn't work:

- **Signing for a device, the App Store or notarization.** It needs the
  person's certificate and profile in the keychain, and the keychain is new
  at each start. The person can't connect their Apple account through DAEX's
  NoMac account: NoMac gives Apple signing only to that account's unlabelled
  Macs.
- **Keychain sign-ins** (a tool that keeps its token in the keychain). They
  last one session. Agents' file-based sign-ins on the drive survive.

A person who needs device signing builds on their own Mac. DAEX tells them
so (`describeAdeCloudComputer` in the brain's prompt).
