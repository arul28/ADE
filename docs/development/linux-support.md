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
| AppImage fails on FUSE or user-namespace policy | Run on a normal installed host with sandbox enabled and test affected Ubuntu AppArmor policy. A container's `--appimage-extract-and-run` is useful smoke, not FUSE or sandbox proof. |
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
