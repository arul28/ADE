# Drawer surfaces and the runtime

## Owning a drawer surface

Daex injects `ADE_LANE_ID` and `ADE_CHAT_SESSION_ID` into every agent it launches, and the drawer services (App Control, Apple device, browser) carry them so the Work tools pane attributes what you drive to your lane rather than to the visible chat. When you *attach to something already running* instead of starting it yourself, run that surface's `claim` subcommand first — `daex app-control claim`, `daex apple claim`, `daex browser claim` — or Work will keep showing the previous owner.

## Showing a surface to the user

`daex ui show apple | floating-apple | browser | proof | app-control | floating-app-control | android | floating-android` asks the desktop window that has your chat in front to open that surface (`daex apple show` is the Apple alias). It prints `shown`, `held` (a window has the project but the user cannot see your chat yet — another chat is in front or the window is hidden; it opens when the user goes there) or `no_desktop` (exit 1, nothing was shown — tell the user rather than claiming it opened). A shell with no `ADE_CHAT_SESSION_ID` (an OpenCode agent shell, for one) cannot use it; ask the user to open the surface.

## Daex runtime vs. desktop app

Most commands (`lanes`, `git`, `chat`, `app-control`, `apple`, …) run **inside the Daex runtime** on this machine (`~/.ade/sock/ade.sock`) and work whether or not the desktop app is open.

A few need the **desktop app** because they use real Electron APIs. Today that is only the built-in browser; the **daex-browser** skill documents that hop, its socket path, and the exact failure text when no desktop is running. A bridge-backed domain with no desktop also surfaces as `Domain unavailable` — report the blocker and continue with the rest of the control plane, which is unaffected.
