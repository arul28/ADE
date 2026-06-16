---
name: ade-cli-control-plane
description: Use this skill when an agent needs to inspect or operate ADE itself through the `ade` CLI, including lanes, chats, actions, proof, runtime/socket state, or help/flag discovery.
---

# ADE CLI control plane

## Core rule

Use normal shell commands for local repo edits, tests, and Git inspection. Use `ade` when you need ADE state or ADE-owned services: lanes, chats, PR metadata, proof/artifacts, managed terminals, App Control, iOS Simulator, browser, settings, usage, updates, or service actions.

## First checks

1. Run `ade doctor --text` when the ADE environment is unclear.
2. Run `ade help <command>` or `ade help <command> <subcommand>` before guessing flags.
3. Prefer `--text` for human-readable output and JSON output when scripting.
4. Use `ade actions list --text` or `ade actions list --domain <domain> --text` as the escape hatch for service methods without a typed command.

## Socket mode

Use `--socket` when the CLI and ADE desktop drawer must share live state. This matters for App Control, iOS Simulator, Preview Lab, browser tabs, terminal logs, context selection, and proof drawer updates.

## Runtime daemon vs. desktop bridge

Most domains (`lane`, `git`, `chat`, `app_control`, `ios_simulator`, etc.) run **inside the runtime daemon** at `~/.ade/sock/ade.sock` and work whether or not the desktop is open.

A small set of domains require the **desktop bridge** because the underlying service needs real Electron APIs. Today that is just `built_in_browser` (it owns a `WebContentsView`), but expect the list to grow if more Electron-only services get exposed to the CLI. The runtime forwards these calls over `<adeHome>/sock/desktop-bridge.sock` (override with `ADE_DESKTOP_BRIDGE_SOCKET_PATH`).

When no desktop is running, calls into a bridge-backed domain surface as `Domain unavailable` or `Desktop browser bridge not running at <path>. Open ADE Desktop with a project to enable \`ade browser\` commands.` — report the blocker and continue with the rest of the control plane, which is unaffected.

## Linear issues attached to your session

See the **ade-linear** skill for the full read/write workflow on an attached issue; the essentials:

When ADE launches you with an attached Linear issue, it injects two env vars into your session: `ADE_CHAT_SESSION_ID` (your session) and `ADE_LINEAR_ISSUE_IDS` (comma-separated attached issue ids). You read and write that issue through the **daemon bridge** — `ade linear ...` routes over the daemon to the desktop runtime, which holds the Linear credentials. You never need a Linear token.

Read/write your attached issue (id defaults to your session's first attached issue, so you can omit it):

```
ade linear issues --this-session --text     # what is attached to me
ade linear issue --text                      # read the attached issue
ade linear comment "Pushed a fix; CI running"
ade linear set-state ENG-431 <state-id>      # move workflow state
ade linear assign ENG-431 <user-id|none>
ade linear label ENG-431 needs-review
```

Manage attachments:

```
ade linear attach --this-session --issue-id ENG-431   # attach to my session
ade linear detach --this-session [--issue-id ENG-431] # detach one or all
ade chat attach-linear-issue <session> --issue-id ENG-431
ade lanes link-linear-issue <lane> --linear-issue-json '{...}'
```

Start work from an issue:

```
ade lanes create-from-linear --issue-id ENG-431 --start-chat --provider codex --model <m>
ade chat create --from-linear-issue ENG-431            # chat with the issue attached + kickoff
```

Report what you actually did back to the issue with `ade linear comment` as you progress — that comment is how reviewers and the issue's watchers see status. Use `ade help linear` for the full flag set.

## Fallback path

If `command -v ade` fails:

1. Try `${ADE_CLI_PATH:-}` if set.
2. Try `${ADE_CLI_BIN_DIR:-}/ade` if set.
3. In an ADE source checkout, after confirming it exists, use `node apps/ade-cli/dist/cli.cjs ...`.

The normal reason to skip ADE CLI is that it is truly unreachable after these fallbacks.
