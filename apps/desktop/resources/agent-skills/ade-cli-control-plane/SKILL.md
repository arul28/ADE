---
name: ade-cli-control-plane
description: Use this skill when you need to hand work to another ADE agent, wait for or check whether delegated work has finished, read another agent's chat transcript, report status or raise a question on the Work row, schedule a wake-up for later, send a message to a chat later, or create a lane — and generally whenever you need ADE's own state (lanes, chats, actions, proof, secrets, runtime/socket status) through the `ade` CLI.
---

# ADE CLI control plane

## Core rule

Use normal shell commands for local repo edits, tests, and local Git. Push, pull and fetch with `ade git` (see ade-lanes-git). Use `ade` when you need ADE state or ADE-owned services: lanes, chats, PR metadata, proof/artifacts, managed terminals, App Control, iOS Simulator, browser, settings, project secrets, usage, updates, or service actions.

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
5. Before running an action, `ade actions describe <domain.action> --text` prints its read/write access, description, documented input fields and an example (actions without a documented contract say so).

## Detail files

Rarely needed detail lives next to this file. Read one when its topic comes
up (or `ade skill show ade-cli-control-plane references/<file>`):

| Topic | File |
| --- | --- |
| Secrets: request, get, set, file delivery; webhooks | `references/secrets-and-webhooks.md` |
| Claiming and showing drawer surfaces; runtime vs desktop bridge | `references/app-surfaces.md` |
| Work board columns, activity labels, card drags | `references/work-board.md` |
| Usage limits: early resume, switching accounts, what to tell the user | `references/usage-limits.md` |
| Scheduled work in full; drafts | `references/scheduled-work.md` |
| Running a command on another machine; moving this chat there | `references/machines.md` |
| Lane branch drift; archived lanes, chats and shells | `references/lanes-and-archives.md` |

## Secrets

**Never ask the user to paste a secret into chat.** Ask with the private card:
`ade secrets request NAME --reason "<why>"` (add `--generate` to suggest a
strong one). Use a stored secret by name without printing it:
`gh secret set X --body "$(ade secrets get NAME --text)"`. Read secrets only
when the user names one. Webhooks (run an agent when another service does
something) are the **ade-webhooks** skill. Full detail:
`references/secrets-and-webhooks.md`.

## Connecting an integration

GitHub, Linear and Jira are ADE integrations: ADE holds the credential, and
you use them through `ade prs`, `ade github`, `ade linear` and `ade jira`.
Agent 37 (cloud Linux machines) is one too: once connected, the person makes
machines from Add a computer in ADE; there are no `ade` verbs for it yet.
Never ask for a key in chat. Check, then ask with the connect card:

```
ade integrations status --text
ade integrations connect linear --reason "To read the issues you mentioned and move them to In Review"
```

The card offers a browser sign-in where the provider has one, otherwise the
key fields; ADE checks the key, then saves it. The command blocks and prints
only the outcome: `{provider, connected: true, method, account, next}` or
`{provider, connected: false, declined: true}` (`method: "already"` when it was
connected). If the person named the integration, raise the card at once; if it
was your own idea, ask in words first.

## The running app

Browser, App Control, Apple device and proof commands talk to the running ADE
app. They find it on their own; you do not need `--socket`. When ADE is not
running they fail with a clear error instead of acting on a copy.
To show a surface to the user: `ade ui show browser|apple|proof`. To take over
a surface you did not start: that surface's `claim` command. Detail:
`references/app-surfaces.md`.

## Linear issues attached to your session

The **ade-linear** skill is the home for working an attached Linear issue: the env vars ADE injects, the read/write commands, and attach/detach. You never need a Linear token — `ade linear ...` routes over the daemon to the desktop runtime, which holds the credentials. Two attachment commands live outside that skill's `ade linear` surface:

```
ade chat attach-linear-issue <session> --issue-id ENG-431
ade lanes link-linear-issue <lane> --linear-issue-json '{...}'
```

## Sync and pairing

- `ade sync web [--open]` — print + copy the web-client pairing link and code (pair a browser to this machine).

## Starting chats

Do the user's work in this chat and this lane. Start another chat or lane only
when the user asks, or when they ask another model to do part of the work
(below). `ade new chat` is the launch command:

```
ade new chat --mode chat --provider codex --model openai/gpt-5.6-sol --reasoning-effort xhigh --prompt "Fix the issue"
ade new chat --mode chat --lane auto --lane-name fix-issue --prompt "Fix the issue"     # only when the user asks for a new lane
ade lanes create --name ENG-431 --issue-id ENG-431 --start-chat --provider codex --model <m>   # a lane for an issue, when asked
```

Always use `--mode chat`. `--mode cli` starts the provider's own CLI in a
terminal instead. ADE cannot tell reliably when a terminal finishes a task, so
it is told it is your subagent and messages you its reports itself. Use it
only when the user asks for a terminal.

### Spawning agents

When the user asks you to have another model or agent do work, start a
subagent. Do this unless they ask for a separate chat:

```
ade new chat --mode chat --provider <p> --model <m> --prompt "<task>"
```

From an agent this is your subagent. It runs in your lane, under your chat,
and reports back after every turn it finishes: ADE steers you if you are busy
and wakes you if you are idle. Two opt-outs, used only when the user asks:

- `--type peer`: linked to you, leaves only a quiet note when it finishes.
- `--no-parent`: a separate top-level chat that does not report back.

ADE is a mesh. You can read, message, interrupt, or stop any chat, whoever
started it, but act on a chat that is not yours only when the user asks.
Stop a chat with `ade chat interrupt <session>`. A chat with no parent can be
made your subagent with `ade chat set-parent <session> --parent
$ADE_CHAT_SESSION_ID`.

For persistent Work chats, a subagent turn reports back with its child turn id
and latest assistant summary whenever the parent still owns the child's
mission — including turns the child's own scheduled wakeups start, so a long
self-paced mission still reports when it actually finishes. ADE steers an active
parent or wakes an idle parent. Once a human messages the child directly,
ownership moves to the human and completions become quiet notes until the parent
dispatches again. The persisted parent link and
turn metadata survive brain restarts; a missing parent is noted once in the
child and stops the report channel. A delivery failure against a parent that
still exists retries and then becomes one visible warning in the child. Every
child receives `ADE_PARENT_CHAT_SESSION_ID` and direct-report guidance while
that parent is reachable.

A `--mode cli` child sends its own report with `ade chat message` when it
finishes a task, and ADE adds one more when its process exits. Check any child
with `ade chat status <id>` (running / blocked / waiting / idle; `waiting`
means its turn ended but work it started still runs, so it is not done yet) and read it with `ade chat read <id>` (`ade terminal
read <id>` for the full output). To give it a new instruction, type into it:
`ade terminal write --terminal <id> --data "<text>\n"`.

**Which lane a child goes in.** An ADE child chat is a subagent that can run
another provider, so it works where a native subagent would: in your lane,
under your chat. Leaving `--lane` out picks your lane when `ADE_LANE_ID` is
set (it is in an ADE chat or lane shell); elsewhere pass `--lane <your lane>`.
Create a new lane for it (`--auto-create-lane`, `ade lanes create`) only when the user
asks. Agents in one lane share its Apple device: let one agent drive it and
hand that agent the device work (see ade-apple).

When the new work must carry the current lane's unmerged commits, use
`ade lanes create --name <n> --from <your branch> --on local` to continue unmerged work. Use `--on uncommitted` to copy uncommitted changes too.

Transcript reads are silent and available for any project-backed chat in any
registered project on this machine. Personal/no-project chats remain on the
separate `--personal` surface and are not included. Reads are bounded by
default; inspect a recent window, then page older content deliberately:

```bash
ade chat read <session> --limit 20 --max-chars 8000 --text
ade chat read <session> --page --cursor <nextCursor> --limit 20 --max-chars 8000 --text
```

The first read returns `truncated` when more content exists. A paged read
returns `nextCursor`; repeat only while you actually need older context. Do not
dump an entire long transcript into the model context. `--max-chars` is a hard
response ceiling; a single oversized entry is visibly clipped and the response
sets `truncated`. This machine-wide route is read-only; it does not broaden
cross-project message or mutation routing.

#### Claude models in a Claude chat

In a Claude chat, run another Claude model (Opus, Sonnet, Haiku) with the
native `Agent` tool and its `model` override. It is a subagent in the same
thread. Use an ADE subagent chat for a model from another provider.

A raw background CLI (`codex exec` in a shell) is not tracked by ADE. Prefer
an ADE subagent chat. If you must, close its stdin (`</dev/null`), capture the
PID, and `wait "$PID"` for its exit status; never use a bare `pgrep`, which
matches your own shell.

### Messaging and stopping other chats

Any chat, whoever started it. Act on a chat you did not start only when the
user asks.

- **Send:** `ade chat message <session> --text "..."`. ADE picks the route: an
  active chat is steered, an idle one gets a new turn. This is the only send
  verb you need.
- **Stop:** `ade chat interrupt <session>`. To redirect, stop it, then
  `ade chat message` the new instruction.
- **Long or multi-line text** goes through `--text-file -` (stdin) or a path,
  never an argument. A long first prompt for a new chat is `--prompt-file -`:

  ```bash
  ade chat message "$ADE_PARENT_CHAT_SESSION_ID" --text-file - <<'REPORT_END'
  ...the report...
  REPORT_END
  ```

  On Windows, never pass multi-line text to `ade.cmd` (cmd.exe cuts it at the
  first line break). In PowerShell, write the text to a file and pass
  `--text-file $f`, or call `& $env:ADE_CLI_PATH`. In Git Bash, call `ade`
  with a here-doc.
- **A chat waiting on a question or approval** refuses messages (error
  -32011). When your subagent asks a question, ADE forwards it to you with the
  options. See it with `ade chat pending <session> --text`, then answer with
  `ade chat respond <session> --option 2` (or `--text "<answer>"`;
  `--answer 1=<v> --answer 2=<v>` for several; `--item <id>` when more than
  one is open). Questions that need the person (money, credentials, a product
  call) and every approval are theirs: tell them, and do not start a second
  chat for the same work.
- **Restart:** only when the user asks (to pick up new skills, plugins, MCP
  servers or instructions), run `ade chat restart`. It restarts your chat
  after this turn; finish your reply first.

### Waiting for work to finish

Never poll and never block on a long wait. Match the thing you wait on:

| Waiting on | Do this, then end your turn or keep working |
| --- | --- |
| A subagent chat | Nothing. Its report wakes you. |
| A PR the user asked you to watch or land | `ade prs watch <pr>` (or `ade prs ship <pr>` to land it) |
| A dev server, build or log | `ade terminal watch <terminal-id> [--match "ready"]` |
| A peer (it does not report back) | `ade chat wait <id> --async [--for idle]` |
| Anything else, later | `ade chat scheduled-work create --in 20m --prompt "<what to check>"` (see Scheduled work) |

Claude's own `ScheduleWakeup`, `CronCreate` and `/loop` are mirrored into the
same scheduler, so in a Claude chat they are equivalent.

**Terminals.** Watch one instead of polling `ade terminal read`:
`ade terminal watch <terminal-id> [--match error |
--match "ready|listening"] [--lifetime 30m]`, then end your turn. ADE wakes
you with the new output (last ~4 KB, colors and redraws removed) once it goes
quiet, and once more when the terminal exits (with the exit code). Output
already on screen never wakes you. `ade terminal watch --command "npm run dev"`
starts the command in a new shell in your lane and watches it from the first
byte. `ade terminal watches` lists yours; `ade terminal unwatch <watch-id>`
stops one. A watch ends after 2h by default (max 24h), after 20 wakes in an
hour, or if ADE restarts; re-arm it then.

### Finishing: settling is not yours

**You cannot settle or unsettle a session.** `ade chat settle`, `ade chat unsettle`,
`ade session settle`, and `ade session unsettle` were removed: whether work is
actually finished is a subjective judgment, and a chat that settles itself
disappears from the user's active list on your say-so. A row leaves the active
list only when the user settles it, or when its PR merges.

What to do instead when you finish: say so in your final message, and use
`ade chat note "<one-line status>"` to leave a durable status line on the Work
row. If your reply asks the user anything, `ade chat ask "<question>"` raises
the row's hand. Update the note along the way as the state changes; do not wait until the end.

Lane and chat names are yours to keep accurate. When the work changes
direction or moves to a new branch, rename the lane or the chat without asking.
A lane keeps its name when its branch changes, so a name that still describes
the old work is yours to fix:

```bash
ade chat generate-names                      # title, lane name, and status line
ade chat generate-names --title --status     # subset of fields
ade chat update --title "Better chat title"  # defaults to $ADE_CHAT_SESSION_ID
ade lanes rename <lane> --name "Better name"
```

#### What `note` and `ask` do to the Work row

They are two separate signals on the row the user is looking at:

- **`ade chat note` sets the row's status line.** It shows a durable one-line
  summary of the current state; it does not change the row's phase. Keep it to about six words with the decisive state first; long notes are cut off.
  Good: `CI green; awaiting Codex review`
  Bad: `Working`, `Still looking`, `Blocked`, or `Done`.
- **`ade chat ask` raises the row's hand**, moving it to **Needs you**. Because
  a note alone never changes the phase, an idle row with only a note can read as
  **Done** — whenever your reply asks the user a question or for a decision,
  call `note` for the context and then `ask` for the exact question.
- **Subagents do not ask the user.** Put the question in your final reply; it
  reaches your parent, which asks the user if it cannot answer.
- **Ask even while background work runs.** A chat whose subagents or monitors
  are still running reads as **Working**, so a question at the end of your turn
  is invisible unless you `ask`. "Ship this, or keep building?" and "Want me to
  run the test now?" are asks; "Both agents are running, I'll report when they
  land" is not, so do not `ask` for progress updates. If you forget, ADE may
  raise the hand itself when it reads a question at the end of your turn.
- **The next accepted user message clears the hand-raise** and the row returns
  to **Working** while the reply is handled. If the reply does not unblock you,
  leave an updated note and `ask` again.
- **Take the hand down when you moved on without an answer.**
  `ade chat ask --clear` drops the marker this chat raised (alias
  `ade chat unask`, TUI `/chat unask`). Use it the moment the question stops
  being the thing you are waiting on: a coordinator or peer sent new
  instructions, or you decided and kept working. Otherwise the row keeps saying
  **Needs you** for the rest of the run, and the person reads a live "blocked on
  you" badge about a decision that was already made. It clears only an
  agent-raised ask — never one the user raised, never a provider question card.
  When you answered a subagent's question yourself, take its hand down too:
  `ade chat ask --clear --session <subagent>` (only chats you started).
  A message from another agent is not a user answer, so it does not clear the
  hand on its own.
- **`ade notify --title "<t>" [--body "<b>"]` tells the user something they
  asked to hear about**, and only then: "tell me when the deploy is done",
  "ping me if the tests fail". Never on your own initiative; ADE already alerts
  the user when you need them, fail, or finish. Run from your chat, it is your
  chat's message: the chat shows "Notified you", Activity's Inbox lists it on
  every device, a tap opens your chat, and the phone stays quiet while the user
  is at the computer or has muted the chat. Lead with what they would act on
  ("Deploy failed on step 3, rolling back"), not "Done". A chat may send 6 an
  hour, and the same words twice within ten minutes go out once; past the limit
  the command exits non-zero and says when to try again. It is not a question:
  if you need an answer, `ask`.

#### The Work board

ADE puts your row in a column (Needs you, Working, Waiting, Done) from what
you do; there is no command to move it, so never claim one. Keep the inputs
true: a current `note`, and `ask` when you need the user. ADE detects your
activity label (Implementing, Testing, …) by itself.

**When the user drags your card you get one message. Act on it:**
- **Done → Working:** they reopened the work. Re-read the recent transcript
  and continue.
- **→ Needs you:** stop, summarise where you are in one short message, and
  list exactly what you need from them.

Snoozing a row is the user's call; do not snooze. Detail:
`references/work-board.md`.

### Usage limits

When a provider hits a usage limit, ADE parks the chat and resumes it on its
own when the limit resets. Nothing is lost, so the default is to wait; do not
start another chat to work around it. When the user asks to keep going on
another account, move this same chat there: `ade chat continue-on-account
<session>` (picks an account with room; exits 1 when none has any), or
`ade chat switch-account <session> --account <email>` to name one.
`ade chat status <session> --text` shows a `resume` line while a limit is live. To resume early, switch
accounts, or answer the user's questions about limits, read
`references/usage-limits.md`.

### Scheduled work

To wake yourself later, `ade chat scheduled-work create`:

```
ade chat scheduled-work create --in 20m --prompt "Check CI and report" --text
ade chat scheduled-work create --cron "0 9 * * *" --prompt "Daily check" --text
ade chat scheduled-work list --text
ade chat scheduled-work cancel <id> --text
```

Prefer `--in`; it needs no timezone math. Cron runs in the ADE machine's local
time. Check the next run time the command prints. In a Claude chat,
`ScheduleWakeup`, `CronCreate` and `/loop` feed the same scheduler.

To make a message arrive later *as the user* (it shows in their Drafts), use
`ade drafts` instead. Detail on both: `references/scheduled-work.md`.

### MCP servers

A chat keeps the MCP servers it started with. To get a new one, ask the user:
`ade mcp servers add <name> --reason "…"` shows a card in the chat, and the
user approves it in every permission mode. Never ask for a key in chat.

- A name from ADE's catalogue (`ade mcp servers --help` lists them: `notion`,
  `sentry`, `supabase`, `stripe`, …) uses the vendor's own server. The card
  shows its brand, asks only for the key it needs, and runs the sign-in when
  the server uses one.
- `github`, `linear` and `atlassian` open ADE's own connect card instead: one
  connection covers `ade github`/`ade linear`/`ade jira` and every agent.
- Any other server works too: describe it (`--url`, or the command line after
  `--`). Its card says Custom, so the user reads what it runs.

When the user named the server, raise the card at once. When it was your own
idea, ask in words first. A server the user adds reaches this chat only after
they press **Refresh chat** above the composer; ask them to. If a server says it
needs a sign-in, tell them to press **Sign in** on its row in
Settings › Integrations › MCP servers, then **Refresh chat**.

## Side chats

A person can open a read-only **side chat** beside a chat (`/side <question>`)
to ask something without adding to it. It knows the chat's history, never
edits, and is not a subagent: it does not report or wake anyone.

- **A message that starts with "[Message from your side chat…]"** came from your
  chat's side chat because the person asked it to send it. Treat it as the
  person's request. It may arrive mid-turn.
- **If you are the side chat**, the role and the `<send_to_main>` rule are in
  your first message. Send to the main chat only when the person asks.
- `ade chat side <session> "<question>"` asks a chat's side chat (opening it);
  `ade chat side <session> --end` ends it.

## Other machines on the account

Chats, lanes and devices on the user's other machines are reachable with
`--machine <name>` (a machine key or an unambiguous name). You act there as an
agent, under that machine's own policy.

```bash
ade machines list --projects --text              # who is online, what projects each has
ade chat list --all-machines --text              # every machine in one table
ade chat create --machine "Mac mini" --lane <lane there> \
  --provider claude --model anthropic/claude-opus-5 --prompt "…"   # your subagent there
ade chat read <id> --machine "Mac mini" --text
ade shell start --machine "Windows PC" --wait -- npm test   # one command there, in this chat's work copy
```

- Put all the steps of a task in one `--machine` call (`-- sh -c "npm ci && npm test"`,
  or a script you run once). Each call opens a new shell there and syncs the
  work copy again. Do not run single commands one call at a time.

- The project there defaults to this repository's checkout; pick another with
  `--project <name|path|id>`, add `--clone` to set a missing GitHub repo up,
  or use `--personal` for projectless chats. Your own lane is never sent: get a
  lane id with `ade lanes list --machine …`.
- A subagent there reports back to you when it finishes, like a local one,
  with "· on <machine>" and the `ade chat read … --machine` command.
- `--machine "a,b"` on `chat create` starts one child per machine.
- An offline machine fails at once and nothing is queued; retry later.
- Ask the user before you use another machine, and say which one and why
  ("Your Windows PC is online. Run the Windows tests there?"). Do not spread
  work across machines on your own.
- Running a command there (tests on Windows) and moving this chat to another
  machine ("continue this on the Mac mini"): `references/machines.md`.

## Fallback path

If `command -v ade` fails (PowerShell: `Get-Command ade`):

1. Try `${ADE_CLI_PATH:-}` if set (PowerShell: `& $env:ADE_CLI_PATH ...`).
   On Windows it is an `.exe` (ADE's CLI launcher, or the standalone
   `ade.exe`), so multi-line arguments arrive whole. An older ADE may still
   set it to `ade.cmd`; from Git Bash prefer step 2 then.
2. Try `${ADE_CLI_BIN_DIR:-}/ade` if set (PowerShell: `& "$env:ADE_CLI_BIN_DIR\ade.cmd" ...`).
   On Windows that folder holds `ade.cmd` for PowerShell and cmd.exe and an
   `ade` script for Git Bash.
3. In an ADE source checkout, after confirming it exists, use `node apps/ade-cli/dist/cli.cjs ...`.

The normal reason to skip ADE CLI is that it is truly unreachable after these fallbacks.

## Do not repair ADE from a task

- Use the `ade` your shell was given. It names the brain that started you.
  An `ade` of another version still works with the running brain and may
  print a one-line note saying so; that note is not an error. If it says the
  brain speaks another protocol, use the `ade` it names.
  Another `ade` (for example `~/.ade/bin/ade.exe`) can belong to another
  channel and reach a different brain, or none.
- Never start, stop, restart, install or update a brain or service
  (`ade brain start|stop|restart|update`, `ade runtime run`). It may belong to
  another channel, and the user's running ADE depends on it.
- Never run `npm install` (or pnpm, yarn, bun) in the user's repo to fix ADE
  itself, for example after `Cannot find module` from ADE's `cli.cjs`.
- When ADE itself fails, stop and report the exact error.
