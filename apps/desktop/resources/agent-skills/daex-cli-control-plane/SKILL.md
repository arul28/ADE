---
name: daex-cli-control-plane
description: "Daex's own state via `daex`: hand work to another Daex agent and wait or check on it, read another agent's transcript, Work-row status or question, wake-ups, messages to a chat later, rename the chat, create lanes, secrets, MCP servers, runtime/socket status."
---

# Daex CLI control plane

Daex was called ADE: the CLI is `daex`, and `ade …` still works the same (older transcripts and prompts use it).

## Core rule

Use normal shell commands for local repo edits, tests, and local Git. Push, pull and fetch with `daex git` (see daex-lanes-git). Use `daex` when you need Daex state or Daex-owned services: lanes, chats, PR metadata, proof/artifacts, managed terminals, App Control, iOS Simulator, browser, settings, project secrets, usage, updates, or service actions.

Do not route ordinary repo commands through Daex chat-attached terminals. Those
terminals exist so Daex Work chats can expose long-running process logs or let a
user inspect/control a chat-owned shell. In a tracked CLI session, run normal
shell commands through the CLI's own shell/tooling; use `daex terminal ...` only
to inspect or control an existing Daex-owned terminal session.

## First checks

1. Run `daex doctor --text` when the Daex environment is unclear.
2. Run `daex help <command>` or `daex help <command> <subcommand>` before guessing flags.
3. Prefer `--text` for human-readable output and JSON output when scripting.
4. Use `daex actions list --text` or `daex actions list --domain <domain> --text` as the escape hatch for service methods without a typed command.
5. Before running an action, `daex actions describe <domain.action> --text` prints its read/write access, description, documented input fields and an example (actions without a documented contract say so).

## Detail files

Rarely needed detail lives next to this file. Read one when its topic comes
up (or `daex skill show daex-cli-control-plane references/<file>`):

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
`daex secrets request NAME --reason "<why>"` (add `--generate` to suggest a
strong one). Use a stored secret by name; you never read its value:
`daex secrets exec --env NAME -- sh -c 'gh secret set X --body "$NAME"'` runs
the command with it in the environment and masks it in the output. Use
secrets only when the user names one or the task plainly needs it.
Saved logins are **daex-browser**'s `daex browser signin`; sign-in codes are
`daex code wait --site <host>`. The person's texts (on their Mac, when they
connected Messages): `daex messages recent|chats --text`; `daex messages send
--to <number> --text "…"` shows them a card to approve each text. Webhooks (run an agent when another service does
something) are the **daex-webhooks** skill. Full detail:
`references/secrets-and-webhooks.md`.

## Connecting an integration

GitHub, Linear and Jira are Daex integrations: Daex holds the credential, and
you use them through `daex prs`, `daex github`, `daex linear` and `daex jira`.
Never ask for a key in chat. Check, then ask with the connect card:

```
daex integrations status --text
daex integrations connect linear --reason "To read the issues you mentioned and move them to In Review"
```

The card offers a browser sign-in where the provider has one, otherwise the
key fields; Daex checks the key, then saves it. The command blocks and prints
only the outcome: `{provider, connected: true, method, account, next}` or
`{provider, connected: false, declined: true}` (`method: "already"` when it was
connected). If the person named the integration, raise the card at once; if it
was your own idea, ask in words first.

## The running app

Browser, App Control, Apple device and proof commands talk to the running Daex
app. They find it on their own; you do not need `--socket`. When Daex is not
running they fail with a clear error instead of acting on a copy.
To show a surface to the user: `daex ui show browser|apple|proof`. To take over
a surface you did not start: that surface's `claim` command. Detail:
`references/app-surfaces.md`.

## Linear issues attached to your session

The **daex-linear** skill is the home for working an attached Linear issue: the env vars Daex injects, the read/write commands, and attach/detach. You never need a Linear token — `daex linear ...` routes over the daemon to the desktop runtime, which holds the credentials. Two attachment commands live outside that skill's `daex linear` surface:

```
daex chat attach-linear-issue <session> --issue-id ENG-431
daex lanes link-linear-issue <lane> --linear-issue-json '{...}'
```

## Sync and pairing

- `daex sync web [--open]` — print + copy the web-client pairing link and code (pair a browser to this machine).

## Starting chats

Do the user's work in this chat and this lane. Start another chat or lane only
when the user asks, or when they ask another model to do part of the work
(below). `daex new chat` is the launch command:

```
daex new chat --mode chat --provider codex --model openai/gpt-5.6-sol --reasoning-effort xhigh --prompt "Fix the issue"
daex new chat --mode chat --lane auto --lane-name fix-issue --provider codex --model <m> --prompt "Fix the issue"   # only when the user asks for a new lane
daex lanes create --name ENG-431 --issue-id ENG-431 --start-chat --provider codex --model <m>   # a lane for an issue, when asked
```

Always use `--mode chat`. `--mode cli` starts the provider's own CLI in a
terminal instead (a "CLI session"); use it only when the user asks for a
terminal. It is still your subagent and reports back, but it can do less than
a chat: see **Chats and CLI sessions** below.

### Spawning agents

When the user asks you to have another model or agent do work, start a
subagent. Do this unless they ask for a separate chat:

```
daex new chat --mode chat --provider <p> --model <m> --prompt "<task>"
```

From an agent this is your subagent. It runs in your lane, under your chat,
and reports back after every turn it finishes: Daex steers you if you are busy
and wakes you if you are idle. Two opt-outs, used only when the user asks:

- `--no-report`: linked to you, but it does not report back. Nothing is posted
  to you when it finishes.
- `--no-parent`: a separate top-level chat that does not report back.

Daex is a mesh. You can read, message, interrupt, or stop any chat, whoever
started it, but act on a chat that is not yours only when the user asks.
Stop a chat with `daex chat interrupt <session>`. A chat with no parent can be
made your subagent with `daex chat set-parent <session> --parent
$ADE_CHAT_SESSION_ID`.

For persistent Work chats, a subagent turn reports back with its child turn id
and latest assistant summary whenever the parent still owns the child's
mission — including turns the child's own scheduled wakeups start, so a long
self-paced mission still reports when it actually finishes. Daex steers an active
parent or wakes an idle parent. Once a human messages the child directly,
ownership moves to the human and completions become quiet notes until the parent
dispatches again. The persisted parent link and
turn metadata survive brain restarts; a missing parent is noted once in the
child and stops the report channel. A delivery failure against a parent that
still exists retries and then becomes one visible warning in the child. Every
child receives `ADE_PARENT_CHAT_SESSION_ID` and direct-report guidance while
that parent is reachable.

A `--mode cli` child reports after every turn it finishes, like a chat child
(Daex reads the CLI's closing message), and it is also told to send its own
report with `daex chat message`; a turn it reported on wakes you once. Check
any child with `daex chat status <id>` (running / blocked / waiting / idle;
`waiting` means its turn ended but work it started still runs, so it is not
done yet) and read it with `daex chat read <id>` (`daex terminal read <id>` for
the full output). Give a CLI child a new instruction with `daex chat send <id>
--text "…"`, as you would a chat: Daex types it at the CLI's prompt, or queues
it until the running turn ends.

### Chats and CLI sessions

Every `daex chat` command takes a chat id or a CLI-session id. A chat is Daex's own
agent runtime; a CLI session is a provider's CLI (Claude Code, Codex, Cursor,
...) running in a Daex terminal, which Daex drives by typing into it. You can
be either: `$ADE_CHAT_SESSION_ID` names yours.

The same for both: send, steer, interrupt, restart, `update` (pin, title,
model, effort, permissions), `generate-names`, delete and Reopen from Recently
deleted, archive, hand off or fork into a chat, move to another machine,
subagents in either direction (a CLI parent gets each child report typed at
its prompt), `daex chat wait --async`, cards (`daex secrets request`, `daex
integrations connect`, `daex mcp servers add`), proof, and `daex chat
scheduled-work`.

What differs for a CLI session:

- **Turn status is exact only for Claude Code and Codex.** For other CLIs Daex
  reads the screen, so `status`, the turn-end report and when a queued message
  is typed can lag by several seconds.
- **Text only.** No images or attachments; put a file's path in the message.
- **Model, effort, permissions and account change by relaunch.** `daex chat
  update` restarts the CLI and resumes its conversation. A change made inside
  the CLI (its own `/model`) is not seen by Daex, so `daex chat show` keeps
  what Daex last launched.
- **Its own permission prompts stay in the terminal.** `daex chat respond
  --approve|--deny` presses the CLI's key for Claude Code, Codex and Cursor;
  for other CLIs answer with `daex terminal write`.
- **No Daex transcript.** `daex chat read` gives its last message;
  `daex terminal read` the full output. `daex chat subagents` lists the CLI's
  own built-in agents; the Daex sessions it started are the ones whose parent
  it is.
- **Wake-ups:** Claude Code's own `ScheduleWakeup` and `/loop` are saved in
  Daex and survive a restart; other CLIs have none, so use `daex chat
  scheduled-work create`.
- **MCP servers:** your Daex MCP servers reach Claude Code and Copilot; Codex
  gets only those with no secret in them; other CLIs get none.
- **Moving machines:** Claude Code and Codex take their conversation along;
  other CLIs start fresh there with a brief. The other machine must run a Daex
  that accepts CLI moves.

**Which lane a child goes in.** A Daex child chat is a subagent that can run
another provider, so it works where a native subagent would: in your lane,
under your chat. Leaving `--lane` out picks your lane when `ADE_LANE_ID` is
set (it is in a Daex chat or lane shell); elsewhere pass `--lane <your lane>`.
Create a new lane for it (`--auto-create-lane`, `daex lanes create`) only when the user
asks. Agents in one lane share its Apple device: let one agent drive it and
hand that agent the device work (see daex-apple).

When the new work must carry the current lane's unmerged commits, use
`daex lanes create --name <n> --from <your branch> --on local` to continue unmerged work. Use `--on uncommitted` to copy uncommitted changes too.

Transcript reads are silent and available for any project-backed chat in any
registered project on this machine. Personal/no-project chats remain on the
separate `--personal` surface and are not included. Reads are bounded by
default; inspect a recent window, then page older content deliberately:

```bash
daex chat read <session> --limit 20 --max-chars 8000 --text
daex chat read <session> --page --cursor <nextCursor> --limit 20 --max-chars 8000 --text
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
thread. Use a Daex subagent chat for a model from another provider.

A raw background CLI (`codex exec` in a shell) is not tracked by Daex. Prefer
a Daex subagent chat. If you must, close its stdin (`</dev/null`), capture the
PID, and `wait "$PID"` for its exit status; never use a bare `pgrep`, which
matches your own shell.

### Messaging and stopping other chats

Any chat, whoever started it. Act on a chat you did not start only when the
user asks.

- **Send:** `daex chat message <session> --text "..."`. Daex picks the route: an
  active chat is steered, an idle one gets a new turn. This is the only send
  verb you need.
- **Stop:** `daex chat interrupt <session>`. To redirect, stop it, then
  `daex chat message` the new instruction.
- **Long or multi-line text** goes through `--text-file -` (stdin) or a path,
  never an argument. A long first prompt for a new chat is `--prompt-file -`:

  ```bash
  daex chat message "$ADE_PARENT_CHAT_SESSION_ID" --text-file - <<'REPORT_END'
  ...the report...
  REPORT_END
  ```

  On Windows, never pass multi-line text to `ade.cmd` (cmd.exe cuts it at the
  first line break). In PowerShell, write the text to a file and pass
  `--text-file $f`, or call `& $env:ADE_CLI_PATH`. In Git Bash, call `daex`
  with a here-doc.
- **A chat waiting on a question or approval** refuses messages (error
  -32011). When your subagent asks a question, Daex forwards it to you with the
  options. See it with `daex chat pending <session> --text`, then answer with
  `daex chat respond <session> --option 2` (or `--text "<answer>"`;
  `--answer 1=<v> --answer 2=<v>` for several; `--item <id>` when more than
  one is open). Questions that need the person (money, credentials, a product
  call) and every approval are theirs: tell them, and do not start a second
  chat for the same work.
- **Restart:** only when the user asks (to pick up new skills, plugins, MCP
  servers or instructions), run `daex chat restart`. It restarts your chat
  after this turn; finish your reply first.

### Waiting for work to finish

Never poll and never block on a long wait. Match the thing you wait on:

| Waiting on | Do this, then end your turn or keep working |
| --- | --- |
| A subagent chat | Nothing. Its report wakes you. |
| A PR the user asked you to watch or land | `daex prs watch <pr>` (or `daex prs ship <pr>` to land it) |
| A dev server, build or log | `daex terminal watch <terminal-id> [--match "ready"]` |
| A chat that does not report back (`--no-report`) | `daex chat wait <id> --async [--for idle]` |
| A chat, from a script or outside Daex | `daex chat events <id> --since <cursor> --json` answers at once; `daex chat notify <id> --url https://…` POSTs when it goes idle, needs input or fails |

Scratch files belong in the lane's `.ade/tmp` (git-ignored). Apps connected
to Daex over MCP can read a chat, so never print a secret or a `.env` file into
one.
| Anything else, later | `daex chat scheduled-work create --in 20m --prompt "<what to check>"` (see Scheduled work) |

Claude's own `ScheduleWakeup`, `CronCreate` and `/loop` are mirrored into the
same scheduler, so in a Claude chat they are equivalent.

**Terminals.** Watch one instead of polling `daex terminal read`:
`daex terminal watch <terminal-id> [--match error |
--match "ready|listening"] [--lifetime 30m]`, then end your turn. Daex wakes
you with the new output (last ~4 KB, colors and redraws removed) once it goes
quiet, and once more when the terminal exits (with the exit code). Output
already on screen never wakes you. `daex terminal watch --command "npm run dev"`
starts the command in a new shell in your lane and watches it from the first
byte. `daex terminal watches` lists yours; `daex terminal unwatch <watch-id>`
stops one. A watch ends after 2h by default (max 24h), after 20 wakes in an
hour, or if Daex restarts; re-arm it then.

### Finishing: settling is not yours

**You cannot settle or unsettle a session.** `daex chat settle`, `daex chat unsettle`,
`daex session settle`, and `daex session unsettle` were removed: whether work is
actually finished is a subjective judgment, and a chat that settles itself
disappears from the user's active list on your say-so. A row leaves the active
list only when the user settles it, or when its PR merges.

What to do instead when you finish: say so in your final message, and use
`daex chat note "<one-line status>"` to leave a durable status line on the Work
row. If your reply asks the user anything, `daex chat ask "<question>"` raises
the row's hand. Update the note along the way as the state changes; do not wait until the end.

Lane and chat names are yours to keep accurate. When the work changes
direction or moves to a new branch, rename the lane or the chat without asking.
A lane keeps its name when its branch changes, so a name that still describes
the old work is yours to fix:

```bash
daex chat generate-names                      # title, lane name, and status line
daex chat generate-names --title --status     # subset of fields
daex chat update --title "Better chat title"  # defaults to $ADE_CHAT_SESSION_ID
daex lanes rename <lane> --name "Better name"
```

#### What `note` and `ask` do to the Work row

They are two separate signals on the row the user is looking at:

- **`daex chat note` sets the row's status line.** It shows a durable one-line
  summary of the current state; it does not change the row's phase. Keep it to six words or fewer with the decisive state first; Daex cuts a note at 72 characters.
  Good: `CI green; awaiting Codex review`
  Bad: `Working`, `Still looking`, `Blocked`, or `Done`.
- **`daex chat ask` raises the row's hand**, moving it to **Needs you**. Because
  a note alone never changes the phase, an idle row with only a note can read as
  **Done** — whenever your reply asks the user a question or for a decision,
  call `note` for the context and then `ask` for the exact question.
- **Subagents do not ask the user.** A subagent asks in its report instead of
  `daex chat ask`: put the question in your final reply; it reaches your parent,
  which asks the user if it cannot answer.
- **Ask even while background work runs.** A chat whose subagents or monitors
  are still running reads as **Working**, so a question at the end of your turn
  is invisible unless you `ask`. "Ship this, or keep building?" and "Want me to
  run the test now?" are asks; "Both agents are running, I'll report when they
  land" is not, so do not `ask` for progress updates. If you forget, Daex may
  raise the hand itself when it reads a question at the end of your turn.
- **The next accepted user message clears the hand-raise** and the row returns
  to **Working** while the reply is handled. If the reply does not unblock you,
  leave an updated note and `ask` again.
- **Take the hand down when you moved on without an answer.**
  `daex chat ask --clear` drops the marker this chat raised (alias
  `daex chat unask`, TUI `/chat unask`). Use it the moment the question stops
  being the thing you are waiting on: a coordinator or another chat sent new
  instructions, or you decided and kept working. Otherwise the row keeps saying
  **Needs you** for the rest of the run, and the person reads a live "blocked on
  you" badge about a decision that was already made. It clears only an
  agent-raised ask — never one the user raised, never a provider question card.
  When you answered a subagent's question yourself, take its hand down too:
  `daex chat ask --clear --session <subagent>` (only chats you started).
  A message from another agent is not a user answer, so it does not clear the
  hand on its own.
- **`daex notify --title "<t>" [--body "<b>"]` tells the user something they
  asked to hear about**, and only then: "tell me when the deploy is done",
  "ping me if the tests fail". Never on your own initiative; Daex already alerts
  the user when you need them, fail, or finish. Run from your chat, it is your
  chat's message: the chat shows "Notified you", Activity's Inbox lists it on
  every device, a tap opens your chat, and the phone stays quiet while the user
  is at the computer or has muted the chat. Lead with what they would act on
  ("Deploy failed on step 3, rolling back"), not "Done". A chat may send 6 an
  hour, and the same words twice within ten minutes go out once; past the limit
  the command exits non-zero and says when to try again. It is not a question:
  if you need an answer, `ask`.

#### The Work board

Daex puts your row in a column (Needs you, Working, Waiting, Done) from what
you do; there is no command to move it, so never claim one. Keep the inputs
true: a current `note`, and `ask` when you need the user. Daex detects your
activity label (Implementing, Testing, …) by itself.

**When the user drags your card you get one message. Act on it:**
- **Done → Working:** they reopened the work. Re-read the recent transcript
  and continue.
- **→ Needs you:** stop, summarise where you are in one short message, and
  list exactly what you need from them.

Snoozing a row is the user's call; do not snooze. Detail:
`references/work-board.md`.

### Usage limits

When a provider hits a usage limit, Daex parks the chat and resumes it on its
own when the limit resets. Nothing is lost, so the default is to wait; do not
start another chat to work around it. When the user asks to keep going on
another account, move this same chat there: `daex chat continue-on-account
<session>` (picks an account with room; exits 1 when none has any), or
`daex chat switch-account <session> --account <email>` to name one.
`daex chat status <session> --text` shows a `resume` line while a limit is live. To resume early, switch
accounts, or answer the user's questions about limits, read
`references/usage-limits.md`.

### Scheduled work

To wake yourself later, `daex chat scheduled-work create`:

```
daex chat scheduled-work create --in 20m --prompt "Check CI and report" --text
daex chat scheduled-work create --cron "0 9 * * *" --prompt "Daily check" --text
daex chat scheduled-work list --text
daex chat scheduled-work cancel <id> --text
```

Prefer `--in`; it needs no timezone math. Cron runs in the Daex machine's local
time. Check the next run time the command prints. In a Claude chat,
`ScheduleWakeup`, `CronCreate` and `/loop` feed the same scheduler.

To make a message arrive later *as the user* (it shows in their Drafts), use
`daex drafts` instead. Detail on both: `references/scheduled-work.md`.

### MCP servers

A chat keeps the MCP servers it started with. To get a new one, ask the user:
`daex mcp servers add <name> --reason "…"` shows a card in the chat, and the
user approves it in every permission mode. Never ask for a key in chat.

- A name from Daex's catalogue (`daex mcp servers --help` lists them: `notion`,
  `sentry`, `supabase`, `stripe`, …) uses the vendor's own server. The card
  shows its brand, asks only for the key it needs, and runs the sign-in when
  the server uses one.
- `github`, `linear` and `atlassian` open Daex's own connect card instead: one
  connection covers `daex github`/`daex linear`/`daex jira` and every agent.
- Any other server works too: describe it (`--url`, or the command line after
  `--`). Its card says Custom, so the user reads what it runs.
- Never guess an address. For a server you do not know, say so and ask for its
  link, or offer to search for it. Raise the card only with a real URL or
  command.

When the user named the server, raise the card at once. When it was your own
idea, ask in words first. A server the user adds reaches this chat only after
they press **Refresh chat** above the composer; ask them to. If a server says it
needs a sign-in, tell them to press **Sign in** on its row at
ade://settings/mcp.servers, then **Refresh chat**.

To remove a server the user asks to drop, run
`daex mcp servers remove <name> --reason "…"`: a card asks them, and on yes the
server, its saved values and its sign-in are removed from their account. If
the receipt says the values were not removed, tell them and link
ade://settings/mcp.servers. Its tools stay in this chat until they press
**Refresh chat**. (`daex mcp remove` is for apps connected to Daex,
not these servers.) GitHub, Linear and Jira are Daex integrations: to
disconnect one, link ade://settings/integrations.github (or `.linear`,
`.jira`); the user presses Disconnect there.

Name a settings page by its `ade://settings/<id>` link (`daex settings find`
prints it); the chat shows it as a button. Never write the path out as text.

## Side chats

A person can open a read-only **side chat** beside a chat (`/side <question>`)
to ask something without adding to it. It knows the chat's history, never
edits, and is not a subagent: it does not report or wake anyone.

- **A message that starts with "[Message from your side chat…]"** came from your
  chat's side chat because the person asked it to send it. Treat it as the
  person's request. It may arrive mid-turn.
- **If you are the side chat**, the role and the `<send_to_main>` rule are in
  your first message. Send to the main chat only when the person asks.
- `daex chat side <session> "<question>"` asks a chat's side chat (opening it);
  `daex chat side <session> --end` ends it.

## Other machines on the account

Chats, lanes and shells on the user's other machines take `--machine <name>`
(a machine key or an unambiguous name); for devices, see daex-computer-use
`references/other-machines.md`. You act there under that machine's own policy.

```bash
daex machines list --projects --text              # who is online, what projects each has
daex chat list --all-machines --text              # every machine in one table
daex chat create --machine "Mac mini" --lane <lane there> \
  --provider claude --model anthropic/claude-opus-5 --prompt "…"   # your subagent there (no --lane: the primary lane there)
daex chat read <id> --machine "Mac mini" --text
daex shell start --machine "Windows PC" --wait -- npm test   # one command there, in your code there
daex files push --machine "Windows PC" ./fixture.bin test/   # one file into your code there (pull copies back)
```

- Put all the steps of a task in one `--machine` call (`-- sh -c "npm ci && npm test"`,
  or a script you run once). Each call opens a new shell there and syncs
  your code there again. Do not run single commands one call at a time. Move files
  with `daex files push|pull --machine`, never as base64 inside shell commands.

- The project there defaults to this repository's checkout; pick another with
  `--project <name|path|id>`, add `--clone` to set a missing GitHub repo up,
  or use `--personal` for projectless chats. Your own lane is never sent: get a
  lane id with `daex lanes list --machine …`.
- A subagent there reports back to you when it finishes, like a local one,
  with "· on <machine>" and the `daex chat read … --machine` command.
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
   On Windows it is an `.exe` (Daex's CLI launcher, or the standalone
   `ade.exe`), so multi-line arguments arrive whole. An older Daex may still
   set it to `ade.cmd`; from Git Bash prefer step 2 then.
2. Try `${ADE_CLI_BIN_DIR:-}/ade` if set (PowerShell: `& "$env:ADE_CLI_BIN_DIR\ade.cmd" ...`).
   On Windows that folder holds `ade.cmd` for PowerShell and cmd.exe and an
   `daex` script for Git Bash.
3. In a Daex source checkout, after confirming it exists, use `node apps/ade-cli/dist/cli.cjs ...`.

The normal reason to skip Daex CLI is that it is truly unreachable after these fallbacks.

## Do not repair Daex from a task

- Use the `daex` your shell was given. It names the brain that started you.
  An `daex` of another version still works with the running brain and may
  print a one-line note saying so; that note is not an error. If it says the
  brain speaks another protocol, use the `daex` it names.
  Another `daex` (for example `~/.ade/bin/ade.exe`) can belong to another
  channel and reach a different brain, or none.
- Never start, stop, restart, install or update a brain or service
  (`daex brain start|stop|restart|update`, `daex runtime run`). It may belong to
  another channel, and the user's running Daex depends on it.
- Never run `npm install` (or pnpm, yarn, bun) in the user's repo to fix Daex
  itself, for example after `Cannot find module` from Daex's `cli.cjs`.
- When Daex itself fails, stop and report the exact error.
