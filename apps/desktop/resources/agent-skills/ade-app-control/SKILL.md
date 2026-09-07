---
name: ade-app-control
description: Use this skill when you need to run or drive a local Electron/desktop app and capture what it does — launch it or attach to a running renderer, read its logs or answer its terminal prompts, click and type in it, or pull screenshot-backed DOM/source context into the chat — through `ade app-control`.
---

# ADE App Control

## Use socket mode

App Control is a live desktop drawer service, so every command below uses `--socket` (the general rule is in the **ade-cli-control-plane** skill):

```bash
ade help app-control
ade --socket app-control status --text
ade --socket app-control claim --lane <lane-id> --text
ade --socket app-control launch --command "npm run dev" --text
ade --socket app-control connect --cdp-port <port> --text
```

ADE sets `ADE_APP_CONTROL_CDP_PORT` and `ADE_APP_CONTROL_DEBUG_FLAGS` for launches. Custom Electron launchers should forward one of those values to `--remote-debugging-port`.
`launch`, `connect`, and `claim` all carry lane/session ownership; see "Owning a drawer surface" in the **ade-cli-control-plane** skill for when `claim` is required.

## Inspect

```bash
ade --socket app-control snapshot --text
ade --socket app-control elements --text
ade --socket app-control select --x <x> --y <y> --text
```

Use Inspect mode or `select` to return screenshot-backed DOM, selector, and source context. When the session is owned by a chat or tracked CLI session, ADE can attach the selection to that active Work surface.

## Observe and act

App Control uses the same observe-then-act loop as `ade browser`. Start with an
observation, then act on the handles it hands you — never guess coordinates.

```bash
ade --socket app-control observe --map --text        # screenshot + numbered element map + handles
ade --socket app-control click --handle obs-...:e:7 --text
ade --socket app-control click --text-match "Save" --text
ade --socket app-control hover --test-id row-3 --text
ade --socket app-control fill --selector "#name" --value "Ada" --text
ade --socket app-control clear --selector "#name" --text
ade --socket app-control type "hello" --text
ade --socket app-control press --key Enter --text
ade --socket app-control scroll --x 120 --y 420 --delta-y 600 --text
ade --socket app-control wait --text-match "Saved" --timeout-ms 8000 --text
ade --socket app-control trace --limit 20 --text
```

Every act command returns a fresh observation, so you rarely need a separate
`observe` after acting. Add `--fast` to skip the settle delay or `--no-observe`
to skip the observation entirely. Targets are `--handle`, `--selector`,
`--text-match`, `--test-id`, `--element <n>`, or `--x`/`--y`; a disabled target
is rejected rather than clicked. Handles come from the latest observations only
— ADE keeps the newest 3 per session, so re-observe if a handle has expired.

Observations also carry console output, failed network requests, and the
in-flight request count, which is usually the fastest way to see why a click
did nothing.

Register visual evidence for the Work row with:

```bash
ade --socket app-control proof --caption "Settings saved" --text
```

## Windows and drivers

```bash
ade --socket app-control windows --text                     # debuggable windows
ade --socket app-control switch-window --target <id> --text # drive another window
ade --socket app-control drivers --text                     # cdp | computer_use availability
```

Switching windows clears the action trace, and handles minted against the
previous window stop resolving — observe again after a switch. `computer_use`
is listed but not implemented: it reports `unavailable` everywhere, and on
Windows/Linux the reason is that native app control is macOS only.

## Logs and terminal

Start with App Control status, then prefer App Control terminal/log commands:

```bash
ade --socket app-control logs --text --max-bytes 8388608
ade --socket app-control terminal write --data "y\n"
ade --socket app-control terminal signal --signal SIGINT
```

Only fall back to `ade --socket terminal list --text` and `ade --socket terminal read ...` when no App Control terminal is active.

## Launching ADE itself from inside ADE

If you are an agent running inside one ADE instance (e.g. ADE Beta or stable) and you need to launch the ADE dev desktop app under App Control, the dev launcher is already isolated and safe to run:

```bash
ade --socket app-control launch --command "npm run dev" --text
```

`npm run dev` uses its own runtime socket (`/tmp/ade-runtime-dev.sock`) and a separate Electron profile (`ade-desktop-dev`), so it will not collide with the runtime/socket that is hosting you. Confirm with `ade runtime status --text` before launching — that tells you which socket the CLI is currently attached to.

### Survive Electron restarts

`npm run dev` watches `apps/desktop/src/main/**` and restarts Electron whenever the main bundle rebuilds. After a restart, the App Control drawer UI in the parent ADE window can show stale `Waiting for CDP on 127.0.0.1:<port>` even though the new renderer is already exposed on the same port. From the CLI you can confirm and re-bind:

```bash
ade --socket app-control targets --text          # find the new page target id
ade --socket app-control attach-target --target <id> --text
ade --socket app-control snapshot --text         # forces the drawer to repaint
```

If `targets` shows a `/devtools/page/<id>` entry with the dev URL (`http://localhost:5173/...`), CDP is healthy — the drawer banner is just lagging until the next snapshot.
