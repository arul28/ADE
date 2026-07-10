---
name: ade-cli-control-plane
description: Use this skill when an agent needs to inspect or operate ADE itself through the `ade` CLI, including lanes, chats, actions, proof, runtime/socket state, or help/flag discovery.
---

# ADE CLI control plane

## Core rule

Use normal shell commands for local repo edits, tests, and Git inspection. Use `ade` when you need ADE state or ADE-owned services: lanes, chats, PR metadata, proof/artifacts, managed terminals, App Control, iOS Simulator, browser, settings, project secrets, usage, updates, or service actions.

Do not route ordinary repo commands through ADE chat-attached terminals. Those
terminals exist so ADE Work chats can expose long-running process logs or let a
user inspect/control a chat-owned shell. In a tracked CLI session, run normal
shell commands through the CLI's own shell/tooling; use `ade terminal ...` only
to inspect or control an existing ADE-owned terminal session.

## First checks

1. Run `ade doctor --text` when the ADE environment is unclear.
2. Run `ade help <command>` or `ade help <command> <subcommand>` before guessing flags.
3. Prefer `--text` for human-readable output and JSON output when scripting.
4. Use `ade actions list --text` or `ade actions list --domain <domain> --text` as the escape hatch for service methods without a typed command.

## Project secrets

ADE project secrets are encrypted, project-scoped, and shared by ADE Desktop,
the CLI, runtime-backed actions, lanes, and agents on the same machine. They live
under the active project root, not inside an individual lane worktree.

Use them only when the user names a secret or clearly asks you to use a stored
credential. List output is metadata-only; `get` prints the value, so avoid
echoing it into logs or chat unless the user explicitly asks.

```
ade secrets list --text
ade secrets get STRIPE_API_KEY --text
ade secrets set STRIPE_API_KEY --value sk_...
printf %s "$TOKEN" | ade secrets set TOKEN --stdin
ade secrets set TOKEN --value-file token.txt
ade secrets delete STRIPE_API_KEY
ade actions list --domain project_secret --text
```

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

## Sync and pairing

- `ade sync web [--open]` — print + copy the web-client pairing link and code (pair a browser to this machine).

Start work from an issue:

```
ade new chat --mode chat --lane <lane> --provider codex --model <m> --prompt "Work this issue"
ade lanes create-from-linear --issue-id ENG-431 --start-chat --provider codex --model <m>
ade chat create --from-linear-issue ENG-431            # compatibility path: chat with the issue attached + kickoff
```

## Chat vs. CLI sessions

Use `ade new chat` as the canonical launch command. It mirrors the desktop New
Chat mode toggle:

```
ade new chat --mode chat --lane <lane> --provider codex --model openai/gpt-5.6-sol --reasoning-effort xhigh --permissions full-auto --no-fast --prompt "Fix the issue"
ade new chat --mode cli --lane <lane> --provider codex --model openai/gpt-5.6-sol --reasoning-effort xhigh --permissions full-auto --no-fast --prompt "Fix the issue"
ade new chat --mode chat --lane auto --lane-name fix-issue --prompt "Fix the issue"
```

`--mode chat` creates a persistent ADE Work chat. `--mode cli` starts a tracked
provider CLI terminal. Both accept lane, provider, model, reasoning effort,
permission mode, fast/no-fast, and prompt flags. Use `--lane auto` or
`--auto-create-lane` when the desktop UI would use the auto-create lane row.

Use `ade chat read <session> --text` to confirm recent transcript messages
before and after steering another chat.

Use `ade chat show <session> --text` before messaging a chat you do not own:

- If you just need to hand context/directive/status to another chat, prefer
  `ade chat message <session> --kind auto --text ...`. ADE inspects the target:
  active turns are steered, idle chats are woken with a new turn, and the result
  reports the route (`sendMessage`, `steer`, or `interrupt-replace`) plus whether
  a steer was queued.
- If `status` is `active` and it is not waiting for user input, use
  `ade chat steer <session> --text ...`. This routes through the provider's
  active-turn path: Codex receives `turn/steer`, Claude stages a steer message,
  and Cursor/Droid/OpenCode queue the message for the next safe boundary.
- If the chat is idle/dormant, use `ade chat send <session> --text ...` to start
  the next turn. The CLI also checks the session summary and will steer instead
  of sending when the target is already active, but prefer the explicit verb
  when your intent is to steer.
- If you need to wait for a peer before reading final output, use
  `ade chat wait <session> --for idle --timeout-ms <ms>` (also supports
  `active`, `awaiting-input`, and `terminal`).
- If you need to stop or redirect a running chat, use
  `ade chat message <session> --kind interrupt-replace --text ...` or, when
  you need manual control, `ade chat interrupt <session>` first, then
  `ade chat send ...` with the new instruction. Do not send a second normal turn
  into an active chat and hope the provider interprets it as steering.

Compatibility commands still exist, but do not teach them as the first choice:

```
ade chat create --lane <lane> --provider codex --model <m> --prompt "Fix"      # persistent Work chat
ade shell start-cli codex --lane <lane> --model <m> --prompt "Fix"             # tracked provider CLI terminal
```

`ade agent spawn` is the older CLI-session launcher and rejects
`--reasoning-effort`; avoid it for new flows. Common reasoning tiers include
`minimal`, `low`, `medium`, `high`, `xhigh`, `max`, and `ultracode`; confirm
model-specific support with `ade actions run chat.modelCatalog --json`.

Report what you actually did back to the issue with `ade linear comment` as you progress — that comment is how reviewers and the issue's watchers see status. Use `ade help linear` for the full flag set.

## Fallback path

If `command -v ade` fails:

1. Try `${ADE_CLI_PATH:-}` if set.
2. Try `${ADE_CLI_BIN_DIR:-}/ade` if set.
3. In an ADE source checkout, after confirming it exists, use `node apps/ade-cli/dist/cli.cjs ...`.

The normal reason to skip ADE CLI is that it is truly unreachable after these fallbacks.
