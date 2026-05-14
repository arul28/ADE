---
name: ade-cli-control-plane
description: Use this skill when an agent needs to inspect or operate ADE itself through the `ade` CLI, including lanes, chats, actions, memory, proof, runtime/socket state, or help/flag discovery.
---

# ADE CLI control plane

## Core rule

Use normal shell commands for local repo edits, tests, and Git inspection. Use `ade` when you need ADE state or ADE-owned services: lanes, chats, missions, PR metadata, memory, proof/artifacts, managed terminals, App Control, iOS Simulator, browser, macOS VM, settings, usage, updates, or service actions.

## First checks

1. Run `ade doctor --text` when the ADE environment is unclear.
2. Run `ade help <command>` or `ade help <command> <subcommand>` before guessing flags.
3. Prefer `--text` for human-readable output and JSON output when scripting.
4. Use `ade actions list --text` or `ade actions list --domain <domain> --text` as the escape hatch for service methods without a typed command.

## Socket mode

Use `--socket` when the CLI and ADE desktop drawer must share live state. This matters for App Control, iOS Simulator, Preview Lab, browser tabs, terminal logs, context selection, and proof drawer updates.

## Fallback path

If `command -v ade` fails:

1. Try `${ADE_CLI_PATH:-}` if set.
2. Try `${ADE_CLI_BIN_DIR:-}/ade` if set.
3. In an ADE source checkout, after confirming it exists, use `node apps/ade-cli/dist/cli.cjs ...`.

The normal reason to skip ADE CLI is that it is truly unreachable after these fallbacks.

