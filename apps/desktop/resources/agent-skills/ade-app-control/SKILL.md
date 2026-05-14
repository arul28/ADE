---
name: ade-app-control
description: Use this skill when inspecting, launching, logging, clicking, typing, or selecting context from Electron apps through ADE App Control and the `ade app-control` CLI.
---

# ADE App Control

## Use socket mode

App Control is a live desktop drawer service. Prefer socket-backed commands:

```bash
ade help app-control
ade --socket app-control status --text
ade --socket app-control launch --command "npm run dev" --text
ade --socket app-control connect --cdp-port <port> --text
```

ADE sets `ADE_APP_CONTROL_CDP_PORT` and `ADE_APP_CONTROL_DEBUG_FLAGS` for launches. Custom Electron launchers should forward one of those values to `--remote-debugging-port`.

## Inspect

```bash
ade --socket app-control snapshot --text
ade --socket app-control elements --text
ade --socket app-control select --x <x> --y <y> --text
```

Use Inspect mode or `select` to return screenshot-backed DOM, selector, and source context. When the session is chat-owned, ADE can attach the selection to the drawer chat.

## Act

```bash
ade --socket app-control click --x <x> --y <y> --text
ade --socket app-control type --value "text" --text
```

Use Control mode for input. Re-snapshot after meaningful UI changes.

## Logs and terminal

Start with App Control status, then prefer App Control terminal/log commands:

```bash
ade --socket app-control logs --text --max-bytes 8388608
ade --socket app-control terminal write --data "y\n"
ade --socket app-control terminal signal --signal SIGINT
```

Only fall back to `ade --socket terminal list --text` and `ade --socket terminal read ...` when no App Control terminal is active.

