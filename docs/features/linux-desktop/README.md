# Linux Desktop

Each lane on a Linux machine can own a screen: its own X display, with a window
manager and its own D-Bus session, created when the lane asks and gone when it
stops. The service, the lease, proof, streaming and the Work-tools pane are
shared with [Mac Desktop](../mac-desktop/README.md) and
[Windows Desktop](../windows-desktop/README.md); only the seat backend differs,
so read the Mac page first. This page covers what Linux adds or changes.

The command family is `ade screen` (`ade mac-desktop` is an alias on a Linux
host), and the verbs are the Mac Desktop verbs plus the window verbs
(`focus`, `minimize`, `close`).

It is built for the headless brain: `curl -fsSL https://ade-app.dev/install.sh | sh`
and `ade connect --headless` on any Linux box (a server, a VPS, a cloud VM). The
desktop app, the web client and the phone watch and drive the screen over the
same relay as every other lane screen.

## Source file map

Only the Linux-specific files; the shared service, lease, ownership, streaming
and proof files are in the [Mac Desktop map](../mac-desktop/README.md#source-file-map).

| Path | Role |
|---|---|
| `apps/desktop/native/ADEDesktopDriverLinux/` | The native helper, `ade-desktop-driver` (Rust, static musl). Same NDJSON wire, ops and error codes as the Mac and Windows drivers. |
| `.../src/main.rs` | The NDJSON loop and dispatcher: one worker thread per lane (requests for a lane run in order), `ping`/`wait`/cross-lane ops on their own threads, SIGTERM/stdin-close teardown, the orphaned-X-server sweep. |
| `.../src/lane.rs` | One lane's screen: Xvfb + Xauthority cookie, the lane's `dbus-daemon`, openbox, app launch/quit, observe, input, window verbs, screenshots, the media ops. |
| `.../src/xconn.rs` | The X11 connection (x11rb): window list (EWMH), XTEST input, keymap and scratch-keycode typing, `GetImage`/MIT-SHM capture, the XFixes cursor overlay. |
| `.../src/atspi.rs` | The element map: AT-SPI over the lane's own accessibility bus (zbus), the breadth-first concurrent walk with its node cap and time budget, element actions. |
| `.../src/media.rs` | The live view and recording: XDamage-driven capture, the system `ffmpeg` encoder, access-unit framing, the loopback byte server, the MP4 recorder. |
| `.../src/launch.rs` | What `app.launch` starts: app name, path, `.desktop` entry or URL; the lane-private browser profile and accessibility switches. |
| `apps/desktop/scripts/build-linux-desktop-driver.mjs` | Builds the helper for `linux-x64` / `linux-arm64` into `resources/native/<target>/`. |
| `apps/ade-cli/scripts/package-native-deps.mjs` | Ships it in `ade-linux-<arch>.native.tar.gz` as `native/ade-desktop-driver`. |
| `apps/desktop/src/main/services/native/nativeHelperPaths.ts` | `resolveLinuxDesktopDriverBinary`: `<ADE_RUNTIME_ROOT>/native/ade-desktop-driver`, then the daemon search. |
| `apps/desktop/src/main/services/linuxDesktop/linuxDesktopSeatProvider.ts` | The Linux `DesktopSeatAdapter`: the shared op set plus the window verbs, the `host --ade-home` driver client. |
| `apps/desktop/src/main/services/linuxDesktop/linuxDesktopSetup.ts` | The system packages a screen needs, per package manager, and `ade screen setup` installing them. |
| `apps/desktop/src/shared/desktopSeat.ts` | `desktopProductName("linux")`, the `linux` seat kind and its status summary. |

## How a lane's screen comes up

`display.create` runs on the lane's worker thread and:

1. Picks a free display number from `:90` up, writes a random
   MIT-MAGIC-COOKIE-1 into `<ADE home>/linux-desktop/lanes/<lane>/Xauthority`,
   and starts `Xvfb :N -screen 0 WxHx24 -nolisten tcp -auth …`. Only a client
   with the cookie (the helper, the lane's apps) can connect.
2. Starts the lane's own `dbus-daemon --session` on a socket under
   `$XDG_RUNTIME_DIR/ade-ld/<N>/`, asks it for the accessibility bus (D-Bus
   activates `at-spi-bus-launcher`), and switches accessibility on
   (`org.a11y.Status.IsEnabled` and `ScreenReaderEnabled`).
3. Starts `openbox`, waits until it manages the screen, and paints a plain
   backdrop.

Every child gets its own process group and a parent-death signal tied to the
lane's worker thread, which lives as long as the helper; a helper that crashes
takes its X servers with it, and the next helper kills any orphaned one it
finds under its ADE home. `display.destroy` quits the lane's apps (SIGTERM to
each group, SIGKILL after 3 s), then the window manager, the bus and the X
server; anything still connected to the display goes with it.

Each lane has its own X server and its own bus, so lanes cannot see or drive
each other's windows, and an observation never lists another lane's apps.
They run as the same Unix user as the brain, which is the trust level Mac
Desktop has: the isolation is from other lanes and from the user's own
desktop, not from a hostile process of the same user.

## Input

XTEST into the lane's X server. On a Mac and on the shared Windows desktop,
real input moves the user's one pointer, so it needs the lease; a lane's X
display has no human pointer, so its real input is background input by
construction and needs no lease (the status says so: `real input  needs no
lease`). A person who takes control from a viewer still wins, through the
shared takeover path. XTEST events are genuine to the app; XSendEvent is not
used, because Chromium and GTK drop synthetic pointer events.

- A click on an element raises its window if another covers it, then clicks
  its centre. An element with no frame on screen gets its AT-SPI action.
- Typing focuses the element (AT-SPI `GrabFocus`, or a click) and types with
  XTEST. A character the keymap cannot type is bound to a spare keycode first,
  as xdotool does, so any Unicode text types.
- `--cmd` is Control, `--opt` is Alt, `--win` is Super.
- `setValue` uses AT-SPI `EditableText` or `Value`.

## The element map

AT-SPI on the lane's accessibility bus. Chromium answers the AT-SPI cache for
its own UI only, so the page is a real walk: breadth first, every call of a
level in flight at once, subtrees that are not SHOWING pruned (the part of a
long page that is scrolled away), a 12,000-node cap and a 2.5 s budget. A walk
cut short reports `truncatedReason` (`node_cap`, `timeout`). Interactive roles
(buttons, links, entries, check boxes, menu items, tabs, …) and named text
roles (headings, labels, static text) with an on-screen frame become elements;
with more than the limit, the interactive ones are kept first.

Chromium and Electron build the renderer's tree only when asked: `app.launch`
adds `--force-renderer-accessibility` to Chromium-family browsers and to
Electron apps (an app with `resources/app.asar` beside its binary), and the
accessibility status flags on the bus cover apps that check them.

`app.launch` also gives them `--disable-gpu-compositing` (unless the caller
passes its own GPU switch): Xvfb has no GPU, so Chromium would composite every
frame through SwiftShader, about four times the CPU of software compositing.
WebGL keeps working. A Chromium profile lock left by a Chrome that is gone (a
killed helper, a reboot, a cloud VM resumed under a new hostname) is removed
before launch; otherwise Chrome exits with "profile in use" and no window.

Measured on a 2-vCPU box: Chrome on a Wikipedia article, 383 elements in about
0.3–0.6 s.

## Live view and recording

Frames are taken only when the X server reports damage (XDamage), with MIT-SHM
so a 1080p frame is a 2 ms copy instead of 8 MB over the socket. The cursor is
drawn from XFixes (Xvfb never draws it). A still screen sends one frame a
second so a viewer's picture stays fresh.

Encoding is the system's `ffmpeg`: libx264 on Debian, Ubuntu and Arch,
libopenh264 on Fedora. ADE ships no codec of its own. The live encoder runs
ultrafast/zerolatency with no B-frames and in-band SPS/PPS; the helper splits
its byte stream into access units at the delimiter, or when the encoder goes
quiet, and sends them in the same 12-byte record framing the other drivers use,
so every viewer (desktop, web, phone) decodes it unchanged. A new reader, or
one that fell behind, starts on a fresh encoder whose first picture is a
keyframe. The stream is capped at 30 fps (`ADE_LINUX_DESKTOP_MAX_FPS`).

`record.start` writes an MP4 through ffmpeg at a fixed rate, cutting still
time over 1.5 s unless `keepIdle`. With no desktop app attached, the proof is
filed as recorded (the demo engine is the desktop app's).

Measured at 1920x1080 on a 2-vCPU box: a still screen costs the helper and
ffmpeg about 1% of one core; scrolling a page at ~25 fps costs the helper ~4%,
ffmpeg ~19% and Chrome ~30%.
An empty lane screen (Xvfb + openbox) is about 37 MB.

## Setup

A plain Linux server has none of what a screen needs. The helper reports what
is missing on every `ping`; the status lists it with the one command that
installs it:

```
ade screen status --text
  missing packages  xvfb, openbox, at-spi2-core, ffmpeg
  install with      sudo apt-get install -y --no-install-recommends xvfb openbox at-spi2-core ffmpeg
```

`ade screen setup --allow-prompt` (a trusted client: the desktop pane, the
phone, `ade --role cto`) runs it when ADE is root or `sudo` needs no password,
which covers most cloud VMs; otherwise it answers with the command for the user
to run. An agent cannot run setup. Packages per manager:

| Manager | Packages |
|---|---|
| apt | `xvfb openbox dbus at-spi2-core ffmpeg` |
| dnf | `xorg-x11-server-Xvfb openbox dbus-daemon at-spi2-core ffmpeg-free` |
| pacman | `xorg-server-xvfb openbox dbus at-spi2-core ffmpeg` |
| zypper | `xorg-x11-server-Xvfb openbox dbus-1 at-spi2-core ffmpeg` |
| apk | `xvfb openbox dbus at-spi2-core ffmpeg` |

Only Xvfb is required to start a screen. Without openbox, windows are
unmanaged (no title bars; Chrome draws its own); without D-Bus or AT-SPI,
observations carry the screenshot and windows but no elements (the reason is in
`stalledApps`); without ffmpeg, everything works except the live view and
recording. A browser is not a dependency; `ade screen open <url>` names what to
install when none is found.

`ade connect` on a Linux machine also turns on systemd lingering for the user
(best effort), so the brain keeps running after logout and comes back after a
reboot; where that needs root, the install message prints the command.

## Remote

A Linux machine never has a local ADE desktop app, so every client of its
screen is remote, and every call reaches it through the lane's pin like any
other lane screen (`callPinnedRuntimeAction`, the `mac_desktop` action domain,
the stream over the sync socket). "Bring to my screen", claim, release and
present do not exist on Linux: every window on the lane's screen is already
the lane's. So the pane's **Add app** opens an app on the screen instead (an
app name, a path or a web address, with Chrome, Firefox and Terminal one click
away; `macDesktop.open`), and a window card offers **Close**
(`macDesktop.closeWindow`) where a Mac card offers Release. Both carry the
lane's pin like every other pane call. A watch-only client (the phone, a browser tab without control)
gets **Stop** through `macDesktop.stopSeat`, as on Windows.

## Not in scope

Wayland (a lane screen is its own X server; apps that only speak Wayland do not
run on it), per-lane Unix users or containers (same-user isolation, as on a
Mac), GPU encoding, and the iOS simulator. ADE's built-in browser stays an
Electron view on the desktop; a Chrome on the lane screen is the Linux
equivalent.
