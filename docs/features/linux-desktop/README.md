# Linux Desktop

Each lane on a Linux machine can own a screen: its own Xvfb display, window
manager and D-Bus session, created when the lane asks and gone when it stops.
The service, lease, proof, streaming and Work-tools pane are shared with
[Mac Desktop](../mac-desktop/README.md) and
[Windows Desktop](../windows-desktop/README.md); only the seat backend differs.
Read the Mac page first. This page covers what Linux adds or changes.

Commands are `daex screen …` (`ade` still works; `mac-desktop` is an alias),
the Mac verbs plus the window verbs `focus`, `minimize`, `close`. It is built
for the headless brain: `curl -fsSL https://ade-app.dev/install.sh | sh` and
`daex connect --headless` on any Linux box. The desktop app, web client and
phone watch and drive the screen over the same relay as other lane screens.

## Source file map

Linux-specific files only; the shared files are in the
[Mac Desktop map](../mac-desktop/README.md#source-file-map).

| Path | Role |
|---|---|
| `apps/desktop/native/ADEDesktopDriverLinux/` | The native helper `ade-desktop-driver` (Rust, static musl). Same NDJSON wire, ops and error codes as the Mac and Windows drivers. |
| `…/src/main.rs` | NDJSON loop: one worker thread per lane (a lane's requests run in order), `ping`/`wait`/cross-lane ops on their own threads, SIGTERM/stdin-close teardown, orphaned-X-server sweep. |
| `…/src/protocol.rs` | The shared wire types and error codes. |
| `…/src/procs.rs` | Child processes: own process group per child, parent-death signal, stop escalation. |
| `…/src/lane/mod.rs` | One lane's screen: Xvfb + Xauthority cookie, the lane's `dbus-daemon`, openbox, app launch/quit, teardown, lease, media ops. |
| `…/src/lane/observe.rs` | The `observe` element map: AT-SPI walk (12,000-node cap, 2.5 s budget), screenshot, handle and text resolution. |
| `…/src/lane/input.rs` | click, type, `setValue`, press, scroll, drag, move, buttons, `wait`. |
| `…/src/lane/windows.rs` | Window list, window verbs, screenshots, window signature. |
| `…/src/xconn.rs` | X11 via x11rb: EWMH window list, XTEST input, scratch-keycode typing, `GetImage`/MIT-SHM capture, XFixes cursor. |
| `…/src/keys.rs`, `…/src/draw.rs` | Key names to keysyms; PNG writing and the numbered element map. |
| `…/src/atspi.rs` | AT-SPI client on the lane's own accessibility bus (zbus). |
| `…/src/media.rs` | Live view and recording: XDamage capture, system `ffmpeg`, access-unit framing, loopback byte server, MP4 recorder. Cap `ADE_LINUX_DESKTOP_MAX_FPS` (default 30). |
| `…/src/launch.rs` | What `app.launch` starts (name, path, `.desktop` entry, URL), browser profile and accessibility switches. |
| `…/src/wallpaper.rs` | The DAEX wallpaper painted once into the root window's background pixmap (`assets/ade-mark.png` compiled in). |
| `apps/desktop/scripts/build-linux-desktop-driver.mjs` | Builds the helper for `linux-x64` / `linux-arm64` into `resources/native/<target>/`. |
| `apps/ade-cli/scripts/package-native-deps.mjs` | Ships it in `ade-linux-<arch>.native.tar.gz` as `native/ade-desktop-driver`. |
| `apps/desktop/src/main/services/native/nativeHelperPaths.ts` | `resolveLinuxDesktopDriverBinary`: `<ADE_RUNTIME_ROOT>/native/ade-desktop-driver`, then the daemon search. |
| `apps/desktop/src/main/services/linuxDesktop/linuxDesktopSeatProvider.ts` | The Linux `DesktopSeatAdapter`: shared ops plus window verbs. |
| `apps/desktop/src/main/services/linuxDesktop/linuxDesktopSetup.ts` | Packages a screen needs per package manager; `daex screen setup`. |
| `apps/desktop/src/main/services/linuxDesktop/linuxHostFacts.ts` | Reads the helper's `ping.linux` report (what the host is missing). |
| `apps/desktop/src/main/services/linuxDesktop/linuxScreenTelemetry.ts` | Sentry reports tagged with distribution, version, CPU and package manager (`linux_screen.*`, see `docs/logging.md`). |
| `apps/desktop/src/shared/desktopSeat.ts` | `desktopProductName("linux")`, the `linux` seat kind and its status summary. |

## Gotchas / fragile areas

- **Isolation is per lane, not per user.** Each lane has its own X server
  (per-lane MIT-MAGIC-COOKIE-1) and bus, so lanes cannot see each other's
  windows. Everything runs as the brain's Unix user. The live-view video port
  is plain loopback TCP with no token (like the Mac byte server); clients
  normally read through the brain's token-guarded stream endpoint.
- **The bus socket dir** is `$XDG_RUNTIME_DIR/ade-ld/<N>/`, or
  `/tmp/ade-ld-<uid>/<N>/` without `XDG_RUNTIME_DIR`; it is created `0700` and
  refused if it is a link or owned by another user.
- **No lease for input.** A lane's X display has no human pointer, so XTEST
  input is background input by construction (real input needs no lease). A
  viewer's takeover still wins. XSendEvent is not used: Chromium and GTK drop
  synthetic pointer events.
- **Chromium needs flags.** `app.launch` adds `--force-renderer-accessibility`
  to Chromium-family browsers and Electron apps (detected by
  `resources/app.asar`), and `--disable-gpu-compositing` unless the caller
  passes a GPU switch (Xvfb has no GPU; SwiftShader costs about 4x CPU). A
  stale Chromium profile lock is removed before launch, or Chrome exits with
  "profile in use".
- **AT-SPI walk.** Chromium's AT-SPI cache covers only its own UI, so the page
  is a real breadth-first walk with non-SHOWING subtrees pruned. A cut-short
  walk reports `truncatedReason` (`node_cap`, `timeout`). Text targets prefer
  interactive elements, then exact names, then the smallest, as on Mac and
  Windows.
- **Encoder latency.** The live encoder runs ultrafast/zerolatency, no
  B-frames, in-band SPS/PPS, slice threads (frame threading would hold a frame
  until the next damage). A still screen sends one frame a second. A new or
  lagging reader gets a fresh encoder starting on a keyframe.
- **Locale.** Linux helpers keep the machine's locale; `en_US.UTF-8` (set for
  Mac and Windows helpers) is often not generated on Linux.
- **ffmpeg differences.** Fedora's `ffmpeg-free` has no libx264 (recording uses
  libopenh264; the demo engine falls back to DAEX's pinned ffmpeg, see
  `canRenderDemos` in `ffmpegDemoEngine.ts`). ffmpeg 9 removed
  `-filter_complex_script` and 6.1 predates `-/filter_complex`; the engine picks
  by version. An ffmpeg without an H.264 encoder is reported separately
  (`ffmpeg-encoder`) and never in the packages row.
- **xterm fonts.** xterm gets `-fa Monospace -fs 11`; a lane screen has no core
  X fonts.

## How a lane's screen comes up

`display.create` on the lane's worker thread:

1. Picks a free display from `:90` up, writes a random cookie to
   `<ADE home>/linux-desktop/lanes/<lane>/Xauthority`, and starts
   `Xvfb :N -screen 0 WxHx24 -nolisten tcp -auth …`.
2. Starts the lane's `dbus-daemon --session`, asks it for the accessibility
   bus, and sets `org.a11y.Status.IsEnabled` and `ScreenReaderEnabled`.
3. Starts `openbox`, waits until it manages the screen, and paints the
   wallpaper once (no timer; flat base colour if painting fails).

A crashed helper takes its X servers with it; the next helper kills any
orphaned one under its DAEX home. `display.destroy` sends SIGTERM to each app
group (SIGKILL after 3 s), then stops the window manager, bus and X server.

Common app names open the first installed app of that kind: `browser` (Chrome,
Chromium, Edge, Brave, Firefox), `terminal` (`x-terminal-emulator`, then
xfce4-terminal, gnome-terminal, konsole, xterm), `files` (nautilus, thunar,
pcmanfm, dolphin, nemo, caja). None installed answers with one sentence.

Typing focuses the element (AT-SPI `GrabFocus` or a click) and types with
XTEST; an untypeable character is bound to a spare keycode first. `--cmd` is
Control, `--opt` Alt, `--win` Super. `setValue` uses AT-SPI `EditableText` or
`Value`.

`record.start` writes an MP4 at a fixed rate, cutting still time over 1.5 s
unless `keepIdle`. With no desktop app attached, the proof is filed as recorded
(the demo engine lives in the desktop app).

## Setup

The helper reports missing packages on every `ping`, and the status shows the
install command:

```
daex screen status --text
  missing packages  xvfb, openbox, at-spi2-core, ffmpeg
  install with      sudo apt-get install -y --no-install-recommends xvfb openbox at-spi2-core ffmpeg
```

`daex screen setup --allow-prompt` (trusted clients only: the desktop pane, the
phone, `--role cto`; never an agent) runs the install with `sudo -n` when DAEX
is root or sudo needs no password; otherwise it prints the interactive command.

| Manager | Packages |
|---|---|
| apt | `xvfb openbox dbus at-spi2-core ffmpeg` |
| dnf | `xorg-x11-server-Xvfb openbox dbus-daemon at-spi2-core ffmpeg-free` |
| pacman | `xorg-server-xvfb openbox dbus at-spi2-core ffmpeg` |
| zypper | `xorg-x11-server-Xvfb openbox dbus-1 at-spi2-core ffmpeg` |
| apk | `xvfb openbox dbus at-spi2-core ffmpeg` |

Only Xvfb is required. Without openbox windows are unmanaged; without D-Bus or
AT-SPI observations have no elements (reason in `stalledApps`); without ffmpeg
there is no live view or recording. A browser is not a dependency.

Verified end to end on Ubuntu 24.04, Fedora 44, Debian 13 and Arch (x64) and on
Ubuntu, Fedora and Arch Linux ARM (arm64). `daex connect` also turns on systemd
lingering (best effort) so the brain survives logout and reboot.

## Remote

Calls reach the lane's machine through its pin like any lane screen
(`callPinnedRuntimeAction`, the `mac_desktop` action domain, the stream over
the sync socket). Bring-to-my-screen, claim, release and present do not exist
on Linux: every window on the lane's screen is already the lane's. The pane's
**Add app** opens an app on the screen (`macDesktop.open`) and a window card
offers **Close** (`macDesktop.closeWindow`); `macDesktop.stopSeat` stops a
seat. The phone shows Stop and Close window when the lane's machine advertises
them, and reads screen capabilities from that machine.

## Not in scope

Wayland-only apps (the lane screen is its own X server), per-lane Unix users or
containers, GPU encoding, the iOS simulator. The DAEX built-in browser stays an
Electron view on the desktop; Chrome on the lane screen is the Linux
equivalent.
