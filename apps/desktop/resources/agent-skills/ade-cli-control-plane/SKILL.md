---
name: ade-cli-control-plane
description: Use this skill when an agent needs to inspect or operate ADE itself through the `ade` CLI, including lanes, chats, actions, proof, runtime/socket state, or help/flag discovery.
---

# ADE CLI control plane

## Core rule

Use normal shell commands for local repo edits, tests, and Git inspection. Use `ade` when you need ADE state or ADE-owned services: lanes, chats, PR metadata, proof/artifacts, managed terminals, App Control, iOS Simulator, browser, macOS VM, settings, usage, updates, or service actions.

## First checks

1. Run `ade doctor --text` when the ADE environment is unclear.
2. Run `ade help <command>` or `ade help <command> <subcommand>` before guessing flags.
3. Prefer `--text` for human-readable output and JSON output when scripting.
4. Use `ade actions list --text` or `ade actions list --domain <domain> --text` as the escape hatch for service methods without a typed command.

## Socket mode

Use `--socket` when the CLI and ADE desktop drawer must share live state. This matters for App Control, iOS Simulator, Preview Lab, browser tabs, terminal logs, context selection, and proof drawer updates.

## Runtime daemon vs. desktop bridge

Most domains (`lane`, `git`, `chat`, `app_control`, `ios_simulator`, `macos_vm`, etc.) run **inside the runtime daemon** at `~/.ade/sock/ade.sock` and work whether or not the desktop is open.

A small set of domains require the **desktop bridge** because the underlying service needs real Electron APIs. Today that is just `built_in_browser` (it owns a `WebContentsView`), but expect the list to grow if more Electron-only services get exposed to the CLI. The runtime forwards these calls over `<adeHome>/sock/desktop-bridge.sock` (override with `ADE_DESKTOP_BRIDGE_SOCKET_PATH`).

When no desktop is running, calls into a bridge-backed domain surface as `Domain unavailable` or `Desktop browser bridge not running at <path>. Open ADE Desktop with a project to enable \`ade browser\` commands.` — report the blocker and continue with the rest of the control plane, which is unaffected.

## Fallback path

If `command -v ade` fails:

1. Try `${ADE_CLI_PATH:-}` if set.
2. Try `${ADE_CLI_BIN_DIR:-}/ade` if set.
3. In an ADE source checkout, after confirming it exists, use `node apps/ade-cli/dist/cli.cjs ...`.

The normal reason to skip ADE CLI is that it is truly unreachable after these fallbacks.
