# Linux desktop support

ADE supports a Linux desktop alongside the standalone brain. The desktop must
adopt an existing brain on the same ADE home and channel; it must not create a
second authority or change a headless machine's pairing identity. Lanes and
commands on another machine follow that machine's runtime pin, including an iOS
simulator on a Mac. Linux lane screens use their own Xvfb display; that is
separate from the user's X11 or Wayland desktop session.

## Development and network

Use Node 24 and the isolated, detached dev launcher in
[local development](local-development.md). Give each agent its own socket,
ADE home and throwaway project; a separate home alone does not isolate a project
database. Rebuild native dependencies for the target Electron and architecture;
never install Linux dependencies into a macOS checkout. Do not weaken Chromium's
sandbox globally. Diagnose user-namespace/AppArmor restrictions on the affected
host and use an explicit, scoped remedy only where necessary.

The sync host advertises `_ade-sync._tcp` via mDNS/Bonjour and publishes whether
a PIN is configured, not the PIN. The default TCP port is 8787, with fallback
through 8999 if occupied; use the actual advertised port. For LAN discovery,
allow UDP 5353 multicast and the chosen TCP sync port on the trusted network in
the host firewall, and check network isolation between devices. Do not open the
whole fallback range indiscriminately. If multicast is unavailable, use an
available direct address, Tailscale or relay route; pairing still needs the
machine's configured PIN or other authorized pairing flow.

## Decisions

- **Formats:** AppImage and deb, x64 and arm64, named `ADE-<version>-linux-<x64|arm64>.<ext>`. Other formats are not built.
- **Updates:** the AppImage updates in place from `latest-linux.yml` (x64) or `latest-linux-arm64.yml` (arm64), through the same stop-brain, swap, relaunch path as macOS and Windows. A deb cannot update itself without root, so it links the download. An apt repository is the follow-up that would change this.
- **Menu entry and links:** the deb installs a desktop entry. An AppImage writes its own to `~/.local/share/applications` at launch, so it appears in the menu and `ade://` can open it. It is rewritten when the file moves, a deb launch removes it so it cannot shadow the package's entry, and a file ADE did not write is left alone. The AppImage's `ade` shim follows the file the same way.
- **Keep awake:** "While I'm away" runs `systemd-inhibit`. polkit grants the sleep lock only to a user with a local seat session, so a headless machine and a distribution without systemd both report that the lock failed.
- **Brain version:** an AppImage keeps a brain newer than itself, except after Go back or a switch to an older track, which leave a marker so the next launch installs the matching brain.
- **Sandbox:** never turned off automatically. electron-builder's AppRun appends `--no-sandbox` when user namespaces are blocked, so `scripts/linux-appimage-launcher.sh` strips it and stops with an explanation; `ADE_ALLOW_NO_SANDBOX=1` is the person's explicit opt-in. No AppArmor profile is offered for the AppImage, because it could only match a path under `/tmp` that any local user could create. The deb installs a profile for its fixed path.
- **Brain:** an AppImage copies its standalone runtime to the same `~/.ade` layout `install.sh` uses, so the service never points into the temporary mount. A deb can use its stable `/opt` path. A compatible running brain is adopted; a newer one is kept.

## Release flow

`release-core.yml` builds each architecture in `build-linux-release`, and `release-publish.yml` refuses to publish without all four packages and both manifests. Beta and stable use the same job. On a beta, `scripts/beta/feed.mjs` publishes the two Linux manifests to `beta-feed` with absolute URLs, as for macOS and Windows.

Linux packages build on a fixed Ubuntu, never `ubuntu-latest`: a native module needs the glibc of the image that built it, and a moved image once broke every system older than itself. `validate-linux-artifacts.mjs` holds each packaged binary, and the brain's native archive, to what Ubuntu 22.04 provides (`linux-system-library-ceiling.mjs`), so moving the image means re-checking that. `transcribe-cli` is linked statically on Linux for the same reason. electron-builder fetches its own tools during the build, so `run-linux-electron-builder.mjs` retries a target when one of those downloads fails.

To try a release without reaching any machine's update feed, dispatch `beta.yml` from the branch with `preview_ref` set. It publishes a prerelease that is installed by hand.

Testing a build at a new version: delete `apps/desktop/resources/runtime/ade-linux-*` first, or the stale brain binary fails the AppImage's version check. `ADE_UPDATE_FEED_URL` is honored only by unpacked builds, so an update test against a local feed needs a throwaway build with that guard lifted.

## Release evidence

The release target is unsigned AppImage and deb for x64 and arm64, with
`SHA256SUMS` and architecture-specific AppImage update metadata. A deb offers a
new download rather than an in-app install. Source review and existing focused
tests run on ordinary changes; CI owns the full matrix. Do not run a second
full suite merely for Linux. A real Linux run is required for changes to the
host-sensitive paths below, and a release needs the installed-product evidence
on both architectures. Record the exact build, host, commands and results;
missing evidence stays unverified, never inferred from macOS or a container.

| Failure | Evidence that addresses it |
|---|---|
| Wrong architecture, missing executable, native addon or CR-SQLite | Inspect checksums and package contents; launch each architecture and make a real CRR mutation with its packaged extension. |
| Brain duplicated or existing headless identity lost | Start a headless brain, open the installed desktop in the same home, verify the same process/identity and a working project; restart both. |
| AppImage fails on FUSE or user-namespace policy | Run on a normal installed host with sandbox enabled and confirm an Ubuntu host with the namespace restriction gets the explanation, and that the deb works there. A container's `--appimage-extract-and-run` is useful smoke, not FUSE or sandbox proof. |
| Window fails under X11 or Wayland | Launch and exercise window, input, resize and scaling in native X11 and Wayland sessions; Xvfb smoke alone is not either proof. |
| Package integration or cleanup fails | Install deb and run AppImage as a normal user; check launcher, protocol link, CLI, restart and removal without deleting user data. |
| Update feed points to wrong architecture or deb offers a failing install | Verify release metadata references matching published bytes and checksums; exercise AppImage N-to-N+1 and verify deb offers a download, not install. |
| Pairing or discovery fails | Discover from a physical phone on LAN, verify actual advertised port/PIN and bidirectional CRR; repeat direct or relay with multicast blocked and inspect firewall behavior. |
| Wrong machine executes remote action | From Linux control a paired Mac and Linux brain, verify the lane owner receives commands and remote Mac-only capability remains available. Check phone and web as clients. |
| Native keyring, service or desktop session behaves differently | On a clean host test locked/unlocked credential store, login/logout, reboot and process ownership; container without systemd cannot prove this. |

For a release, also check provider/PTY launch and resume, paths with spaces and
Unicode, browser/App Control, and local/remote screen capabilities. Preserve
macOS and Windows validation. See
[Linux quirks](../../.agents/skills/quality/references/linux-quirks.md) for
review triggers. Record all unresolved host checks before publishing.
