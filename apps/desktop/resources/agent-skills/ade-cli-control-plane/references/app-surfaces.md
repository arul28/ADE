# Drawer surfaces and the runtime

## Owning a drawer surface

ADE injects `ADE_LANE_ID` and `ADE_CHAT_SESSION_ID` into every agent it launches, and the drawer services (App Control, Apple device, browser) carry them so the Work tools pane attributes what you drive to your lane rather than to the visible chat. When you *attach to something already running* instead of starting it yourself, run that surface's `claim` subcommand first — `ade app-control claim`, `ade apple claim`, `ade browser claim` — or Work will keep showing the previous owner.

## Showing a surface to the user

`ade ui show apple | floating-apple | browser | proof` asks the desktop window that has your chat in front to open that surface (`ade apple show` is the Apple alias). It prints `shown`, `held` (a window has the project but the user cannot see your chat yet — another chat is in front or the window is hidden; it opens when the user goes there) or `no_desktop` (exit 1, nothing was shown — tell the user rather than claiming it opened). A shell with no `ADE_CHAT_SESSION_ID` (an OpenCode agent shell, for one) cannot use it; ask the user to open the surface.

## Runtime daemon vs. desktop bridge

Most domains (`lane`, `git`, `chat`, `app_control`, `ios_simulator`, etc.) run **inside the runtime daemon** at `~/.ade/sock/ade.sock` and work whether or not the desktop is open.

A small set of domains require the **desktop bridge** because the underlying service needs real Electron APIs. Today that is just `built_in_browser`; the **ade-browser** skill documents that hop, its socket path, and the exact failure text when no desktop is running. A bridge-backed domain with no desktop also surfaces as `Domain unavailable` — report the blocker and continue with the rest of the control plane, which is unaffected.
