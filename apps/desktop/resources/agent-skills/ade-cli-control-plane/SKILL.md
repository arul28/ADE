---
name: ade-cli-control-plane
description: Use this skill when you need to hand work to another ADE agent, wait for or check whether delegated work has finished, read another agent's chat transcript, report status or raise a question on the Work row, schedule a wake-up for later, or create a lane — and generally whenever you need ADE's own state (lanes, chats, actions, proof, secrets, runtime/socket status) through the `ade` CLI.
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
5. Before running an action, `ade actions describe <domain.action> --text` prints its read/write access, description, documented input fields and an example (actions without a documented contract say so).

## Project secrets

ADE project secrets are encrypted, project-scoped, and shared by ADE Desktop,
the CLI, runtime-backed actions, lanes, and agents on the same machine. They live
under the active project root, not inside an individual lane worktree.

Use them only when the user names a secret or clearly asks you to use a stored
credential. List output is metadata-only; `get` prints the value, so avoid
echoing it into logs or chat unless the user explicitly asks.

```
ade secrets list --text
ade secrets pull --text                 # take this repository's account secrets out of the vault
ade secrets get STRIPE_API_KEY --text
ade secrets set STRIPE_API_KEY --value sk_...
printf %s "$TOKEN" | ade secrets set TOKEN --stdin
ade secrets set TOKEN --value-file token.txt
ade secrets delete STRIPE_API_KEY
ade actions list --domain project_secret --text
```

**Never ask the user to paste a secret into chat.** When you need a key,
token, or webhook secret the project does not have yet, ask for it with the
private secret card:

```
ade secrets request GITHUB_WEBHOOK_SECRET --reason "Signs GitHub deliveries to your triage webhook" --generate
```

The chat shows the user a password field (with a "Generate a strong one"
button; `--generate` marks it as suggested). The command blocks until they
answer and prints only the outcome — `{name, saved: true}`, `{name, saved:
false, kept: true}` or `{name, saved: false, declined: true}` — never the
value. For a token a shell CLI needs that should not stay in ADE, add
`--delivery file --request-id <key>`: the user may choose a temporary private
file, and you get `{saved: true, delivery: "file", file}`. Read it only inside
a command (`TOKEN="$(cat <file>)" wrangler deploy`) and never print it; it is
deleted after 24 hours or when the chat is archived. Otherwise use the secret by name without printing it, e.g.
`gh secret set X --body "$(ade secrets get NAME --text)"`. If the user
declines, carry on without it or explain what is blocked.

## Webhook automations

To run an agent whenever another service does something (GitHub, Stripe,
Linear, Sentry, a deploy hook), read the **ade-webhooks** skill. The short
version: `ade automations webhook create --preset github --filter
body.action=opened --in-this-chat --text` makes the URL and the rule;
`ade secrets request <NAME> --reason "…"` collects the signing secret without
it ever entering chat; `ade automations webhook deliveries <wh-id> --text`
shows what arrived and why it ran or was skipped.

## Socket mode

Use `--socket` when the CLI and ADE desktop drawer must share live state. This matters for App Control, Apple devices / Preview Lab, browser tabs, terminal logs, context selection, and proof drawer updates. The **ade-app-control**, **ade-apple**, and **ade-browser** skills all assume it. `ade-ios-simulator` still resolves and points at **ade-apple**.

### Owning a drawer surface

ADE injects `ADE_LANE_ID` and `ADE_CHAT_SESSION_ID` into every agent it launches, and the drawer services (App Control, Apple device, browser) carry them so the Work tools pane attributes what you drive to your lane rather than to the visible chat. When you *attach to something already running* instead of starting it yourself, run that surface's `claim` subcommand first — `ade --socket app-control claim`, `ade --socket apple claim`, `ade --socket browser claim` — or Work will keep showing the previous owner.

### Showing a surface to the user

`ade ui show apple | floating-apple | browser | proof` asks the desktop window that has your chat in front to open that surface (`ade apple show` is the Apple alias). It prints `shown`, `held` (a window has the project but the user cannot see your chat yet — another chat is in front or the window is hidden; it opens when the user goes there) or `no_desktop` (exit 1, nothing was shown — tell the user rather than claiming it opened). A shell with no `ADE_CHAT_SESSION_ID` (an OpenCode agent shell, for one) cannot use it; ask the user to open the surface.

## Runtime daemon vs. desktop bridge

Most domains (`lane`, `git`, `chat`, `app_control`, `ios_simulator`, etc.) run **inside the runtime daemon** at `~/.ade/sock/ade.sock` and work whether or not the desktop is open.

A small set of domains require the **desktop bridge** because the underlying service needs real Electron APIs. Today that is just `built_in_browser`; the **ade-browser** skill documents that hop, its socket path, and the exact failure text when no desktop is running. A bridge-backed domain with no desktop also surfaces as `Domain unavailable` — report the blocker and continue with the rest of the control plane, which is unaffected.

## Linear issues attached to your session

The **ade-linear** skill is the home for working an attached Linear issue: the env vars ADE injects, the read/write commands, and attach/detach. You never need a Linear token — `ade linear ...` routes over the daemon to the desktop runtime, which holds the credentials. Two attachment commands live outside that skill's `ade linear` surface:

```
ade chat attach-linear-issue <session> --issue-id ENG-431
ade lanes link-linear-issue <lane> --linear-issue-json '{...}'
```

## Sync and pairing

- `ade sync web [--open]` — print + copy the web-client pairing link and code (pair a browser to this machine).

Start work from an issue:

```
ade new chat --mode chat --lane <lane> --provider codex --model <m> --type subagent --prompt "Work this issue"
ade lanes create --name ENG-431 --issue-id ENG-431 --start-chat --provider codex --model <m> --type subagent
ade chat create --from-linear-issue ENG-431 --type subagent # compatibility path: chat with the issue attached + kickoff
```

## Chat vs. CLI sessions

Use `ade new chat` as the canonical launch command. It mirrors the desktop New
Chat mode toggle:

```
ade new chat --mode chat --lane <lane> --provider codex --model openai/gpt-5.6-sol --type subagent --reasoning-effort xhigh --permissions full-auto --no-fast --prompt "Fix the issue"
ade new chat --mode cli --lane <lane> --provider codex --model openai/gpt-5.6-sol --type subagent --reasoning-effort xhigh --permissions full-auto --no-fast --prompt "Fix the issue"
ade new chat --mode chat --lane auto --lane-name fix-issue --type subagent --prompt "Fix the issue"
```

`--mode chat` creates a persistent ADE Work chat. `--mode cli` starts a tracked
provider CLI terminal. Both accept lane, provider, model, reasoning effort,
permission mode, fast/no-fast, and prompt flags. Use `--lane auto` or
`--auto-create-lane` when the desktop UI would use the auto-create lane row.

### Spawning agents

`ade new chat --mode chat --provider <p> --type <subagent|peer> --prompt "..."`
spawns a tracked ADE agent and automatically links it to the current chat
through `ADE_CHAT_SESSION_ID`. The type is required for every parented agent
spawn; omitting it is a hard error whose message includes the decision rule.
There is no silent `none` type.

The type controls what happens to the parent when the child finishes: a
`subagent` turn wakes or steers the parent, a `peer` turn only leaves a quiet
completion note. `--no-parent` creates an unparented top-level session that
neither nests under you nor wakes you. ADE still records it as launched by
you: once it finishes, it stays out of Focus only while you are busy in the
same lane, and only if it is not asking for anything. A helper that needs
input, or one in another lane, stays visible, so `--no-parent` never hides
work. Use `--type peer` for a fire-and-forget helper you want linked.

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

Tracked provider CLI sessions also require `subagent` or `peer` when parented
and receive the same lineage environment. The parent thread shows a CLI child
as a subagent card, but the card closes (and a `subagent` wakes the parent with
the CLI's last message) only when the CLI process exits. An interactive CLI
that finishes its task and stays open reports nothing until it is closed.
Poll CLI children with `ade chat status <id>` (running / blocked / waiting / idle;
`waiting` means the turn ended but background agents or shells it started still
run and report back, so it is not done yet; it exits 0 like running), find
them with `ade chat list` (archived ones need `--include-archived`), and read their last message plus terminal tail with
`ade chat read <id>` (`ade terminal read <id>` for the full output). **Default
to `--mode chat` for a subagent that must report back**: a chat child reports
after every turn it finishes.

**Which lane a child goes in.** An ADE child chat is a subagent that can run
another provider, so it works where a native subagent would: in your lane,
under your chat. Leaving `--lane` out picks your lane when `ADE_LANE_ID` is
set (it is in an ADE chat or lane shell); elsewhere pass `--lane <your lane>`.
Create a new lane for it (`--auto-create-lane`, `ade lanes create`) only when the user
asks.

To wait on a terminal (a dev server, a long build, a log), watch it instead of
polling `ade terminal read`: `ade terminal watch <terminal-id> [--match error |
--match "ready|listening"] [--lifetime 30m]`, then end your turn. ADE wakes
you with the new output (last ~4 KB, colors and redraws removed) once it goes
quiet, and once more when the terminal exits (with the exit code). Output
already on screen never wakes you. `ade terminal watch --command "npm run dev"`
starts the command in a new shell in your lane and watches it from the first
byte. `ade terminal watches` lists yours; `ade terminal unwatch <watch-id>`
stops one. A watch ends after 2h by default (max 24h), after 20 wakes in an
hour, or if ADE restarts; re-arm it then.

When the new work must carry the current lane's unmerged commits, use
`ade lanes create --name <n> --from <your branch> --bring local` to continue unmerged work. Use `--bring uncommitted` to copy uncommitted changes too.

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

Within the active project, use `ade chat show <session> --text` before messaging
a chat you do not own:

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
- If you need to wait for a subagent before reading final output, use
  `ade chat wait <session> --for idle --timeout-ms <ms>` (also supports
  `active`, `awaiting-input`, and `terminal`).
- To wait on several chats without holding your turn open, arm a wait and end
  your turn: `ade chat wait <id> <id> --async [--any] [--for idle]` — ADE wakes
  you once all (or any) of them get there, even across a restart. List with
  `ade chat waits`, cancel with `ade chat wait --cancel <waitId>`.
- To start one chat after another finishes, `ade chat send <B> --after <A>
  "<prompt>"` sends B the prompt once A is idle.
- To be woken when your own background job ends, `ade chat wait --background
  [--job <id>]`, then end your turn (Claude and OpenCode already wake you on
  their own; this matters for Codex).
- **A child blocked on a question.** While a chat waits on a question or an
  approval, `ade chat message` / `ade chat send` to it are refused ("Answer or
  decline the pending request…", error -32011). When your `--type subagent`
  child asks a question, ADE also sends it to you as a message with the
  options and the exact command. See what it waits on with
  `ade chat pending <session> --text`, then answer:
  `ade chat respond <session> --option 2` (number, value or label; repeat for
  multi-select), `--text "<answer>"` for a free answer or a note on the pick,
  `--answer 1=<value> --answer 2=<value>` for several questions, and
  `--approve` / `--approve-session` / `--deny --text "<why>"` for an approval.
  Add `--item <id>` when more than one input is open. Questions that need the
  person (money, credentials, a product call) are theirs: ask them, or leave
  the card for them. Approvals and secret questions are never relayed to you.
  Approvals are the person's to answer unless you were told you may approve.
- When a subagent waits on a card only the person can answer (a real-input
  lease, a consent, a secret), you get one message that says so, also from
  another project or machine. `ade chat status` shows the same as `only the
  user can answer this`. That chat is waiting, not stuck: do not start a
  second chat for the same work or on the same lane. Tell the person, then
  carry on with other work.
- A peer (`--type peer`) never wakes you. If you wait on one, `ade chat wait`
  stops with `waiting_on_user` (exit 1) when it waits on such a card, and an
  `--async` wait wakes you once to say so and stays armed.
- `ade chat send <B> --after <A>` also tells you once when A waits on such a
  card: the queued prompt has not been sent yet. It goes when the person
  answers and A moves on.
- **Long or multi-line text goes through a file or stdin, not an argument.**
  `ade chat create ... --prompt-file -` and `ade chat message|send|steer|side
  <session> --text-file -` read stdin (or a path instead of `-`). The file is
  read on this machine, so this works with `--machine` too:

  ```bash
  ade chat message "$ADE_PARENT_CHAT_SESSION_ID" --kind auto --text-file - <<'REPORT_END'
  ...the report...
  REPORT_END
  ```

  On Windows, never pass multi-line text as an argument: `ade.cmd` runs
  through cmd.exe, which cuts the command at the first line break, so the
  other agent gets only the first line. In PowerShell, write the text to a
  file (`$f = New-TemporaryFile; Set-Content -LiteralPath $f -Value $text
  -Encoding utf8`) and pass `--text-file $f`. In Git Bash, call `ade` (not
  `ade.cmd`) and use a here-doc as above.
- If you need to stop or redirect a running chat, use
  `ade chat message <session> --kind interrupt-replace --text ...` or, when
  you need manual control, `ade chat interrupt <session>` first, then
  `ade chat send ...` with the new instruction. Do not send a second normal turn
  into an active chat and hope the provider interprets it as steering.
- When the user asks you to restart or refresh your session (to pick up new
  skills, plugins, MCP servers or project instructions), run
  `ade chat restart`. It restarts your own chat after this turn ends; the
  conversation is kept. Finish your reply in the same turn: the next message
  starts the fresh process. Background jobs you started (`run_in_background`,
  background subagents) stop with the old process, so wait for them or tell
  the user first. Only restart when the user asks.

### Checking whether delegated / backgrounded work finished

Prefer **harness-tracked** delegation and wait on the tracked handle — do not
background a raw CLI and then guess at its state:

#### Native subagents vs ADE child chats

Use the provider's native subagent tool first when the current chat exposes one
and the result belongs in the same provider SDK thread. This is especially
important for Claude: a Claude chat should use its native `Agent`/`Task` tool
(and its native `model` override for another Anthropic-family model) instead of
creating a second ADE chat in the same lane with `--type subagent` merely to
run Opus, Sonnet, or another Claude model.

Use an ADE child chat when the work needs an independent durable transcript,
its own wake/schedule, cross-provider execution, separate permissions, or a
user-visible tracked lifecycle. Do not treat `--type subagent` as the generic
replacement for a provider-native child; it adds a separate ADE session and
should be intentional.

- **ADE Work-chat subagents:** spawn with `--type subagent`; every completed
  turn wakes or steers the parent while the parent owns the mission. Read the
  bounded transcript after that signal when you need more detail. You never poll
  a transcript in a loop.
- **Tracked provider CLI subagents:** wait with `ade chat wait <session> --for
  idle|terminal --timeout-ms <ms>` or require an explicit direct report through
  `$ADE_PARENT_CHAT_SESSION_ID`.
- **A background provider CLI (e.g. `codex exec`):** run it detached with its own
  log and stdin closed, capturing the PID immediately, e.g.
  `codex exec "…" </dev/null >"$LOG" 2>&1 & CODEX_PID=$!` (closing stdin is
  required — without it `codex` blocks forever on "Reading additional input from
  stdin…"). The authoritative completion signal is the waited PID: run
  `wait "$CODEX_PID"` and read its exit status as the outcome. Log end-of-run
  markers, a new session file under `~/.codex/sessions/<date>/`, and `pgrep` are
  supporting evidence only — not a deterministic done signal. Do keep the
  session-file existence check as a liveness diagnostic for wedge detection: no
  session file after ~2 min means the process wedged (kill and relaunch). Never
  check completion with a bare `pgrep <name>` — it matches your own shell and
  sibling processes (the self-match trap); if you must use `pgrep` at all, match
  the full command line and exclude yourself (`pgrep -f "codex exec" | grep -v $$`),
  never the bare program name.

### Session lifecycle: snooze, wake (settling is not yours)

**You cannot settle or unsettle a session.** `ade chat settle`, `ade chat unsettle`,
`ade session settle`, and `ade session unsettle` were removed: whether work is
actually finished is a subjective judgment, and a chat that settles itself
disappears from the user's active list on your say-so. A row leaves the active
list only when the user settles it in ADE, or when its PR merges and the
deterministic `autoSettleLaneSessionsOnPrMerge` policy files the lane's
sessions. Running a removed command fails with that explanation.

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
  summary of the current state; it does not change the row's phase. Length
  guidance and the hard display bound live in
  `apps/desktop/src/shared/sessionStatusNote.ts` (a note past that bound is
  truncated with an ellipsis, so put the decisive state first).
  Good: `CI green; awaiting Codex review`
  Bad: `Working`, `Still looking`, `Blocked`, or `Done`.
- **`ade chat ask` raises the row's hand**, moving it to **Needs you**. Because
  a note alone never changes the phase, an idle row with only a note can read as
  **Done** — whenever your reply asks the user a question or for a decision,
  call `note` for the context and then `ask` for the exact question.
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
  Snoozing it does not help: a snooze gives way to a raised hand.
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

#### Activity detail on the card

ADE derives the parent state automatically, and for ADE chats it also detects
the activity detail (Exploring, Implementing, Testing, Reviewing, Shipping,
Monitoring) from your tool calls, so you do not need to report it. Some
provider adapters also surface structured activity, such as Plan mode or a
background monitor. ADE offers agent-reported activity only when the current
provider can invoke the session's ADE CLI; use it to correct or refine the
detected state (Debugging, which looks like testing to the detector). When available, session-specific guidance gives the exact
command and allowed values. For tracked terminals, `ade chat activity` targets
`ADE_ACTIVITY_SESSION_ID`, while other ADE commands continue to use the owning
chat in `ADE_CHAT_SESSION_ID`. Use that guidance to report or clear a detail;
when it is absent, do not try to set one.

An activity report refines a Working card and never moves it to Needs you,
Waiting, or Done. ADE clears it when a new user turn is accepted. Update it
when the work changes; do not keep a stale label. Each card shows at most one
status: Needs you has priority, otherwise one current activity detail occupies
the label in place of generic Working.

#### Board and status

The Work tab has a board view with four columns. Your row sits in exactly one of
them. The host derives the column; you never write it directly.

| Column | How the host derives it |
| --- | --- |
| **Needs you** | Your row has a raised hand or an unanswered approval card. |
| **Working** | A turn is running and nothing waits on the user. |
| **Waiting** | The row is snoozed, or its lane PR has CI pending or a review requested. |
| **Done** | The session ended or the user settled it. |

Two rules follow from that:

- **The column is derived, so keep the inputs true.** Call `ade chat note` when
  the state changes, and call `ade chat ask` whenever you need an answer or a
  decision from the user, even while background work keeps running. A stale note makes a correct column read as the wrong work.
- **Never claim a column.** There is no command that moves your own row. Do not
  say a row is Done; end the turn and leave a note.

**The user can drag your card.** A drag writes the status and then delivers one
message to you. It arrives as a normal message with a board-move marker and a
fixed sentence. React to it, do not ignore it:

- **Done to Working.** The user reopened work you thought was finished. Re-read
  the recent transcript, continue the work, and if the next step is genuinely
  unclear, ask rather than guess.
- **Any column to Needs you.** The user parked the work for their input. Stop
  what you are doing, summarise where you are in one short message, and list
  exactly what you need from them.
- **Working to Done.** The user filed the row. No message reaches you.

If your provider cannot take a message mid-turn, the board move still applies
and the message arrives at the next turn boundary. Handle it then.

Snooze is the lifecycle verb you *do* own. The typed family takes the session id
as a positional, also accepts `--session`, and falls back to
`ADE_CHAT_SESSION_ID` when you omit it.

```bash
ade session show <id> --text                 # lifecycle state incl. wake reason
ade session snooze <id> --for 1h             # also 30m, 4h, 1d (cap 30d)
ade session snooze <id> --until <iso>        # mutually exclusive with --for
ade session snooze <id> --until-asked        # no deadline; only a hand-raise returns it
ade session wake <id> [--reason <reason>]
ade session clear-woke <id>
```

Semantics that hold on every surface:

- **Snooze is a visibility overlay, not a lifecycle state.** It never changes a
  session's canonical phase; it only files the row in a quiet tier. Timer expiry
  is derived by comparing `snoozedUntil` to now — nothing schedules a wakeup.
  This is why snooze is safe for you and settling is not: snooze quiets a row
  you are waiting on without claiming the work is done.
- **A snoozed session hand-raises early** when it needs approval or input, when
  it hits an error *newer than* the snooze, or when a running turn completes.
  The row then carries a woke marker plus the reason (`needs approval`,
  `errored`, `turn finished`, `snooze ended`).
- **Nothing derives a settle.** A clean process exit means the CLI ended, not
  that the work is done — such a row is `ended`, never `settled`.

Generic action-domain equivalents you can call: `session.snoozeSession`,
`session.snoozeSessions`, `session.wakeSession`, `session.wakeSessions`,
`session.clearWokeMarker`. The settle writers (`session.settleSession`,
`session.unsettleSession`, `session.settleSessions`,
`session.unsettleSessions`, `session.setSettleOverride`) are CTO-only and will
refuse your calls.

### Usage limits: waiting out a reset

When a provider rejects a turn for a usage limit, ADE parks the chat and re-sends
a `continue` prompt on its own once the published reset passes. Nothing is lost —
subagents restart with the resumed turn — so the default answer is to wait.

`ade chat status <session> --text` prints a `resume` line whenever a limit is
live, next to `tool` / `queued` / `ask`:

```
  resume     resumes 2026-09-07T23:31:30Z (in 3 min) · usage limit · attempts 1/2
  resume     resuming now · usage limit · attempts 1/2
  resume     paused after 2 tries · turn auto-resume back on to try at <reset>
  resume     won't auto-resume (opted out)
  resume     usage limit · no reset time
```

`--json` carries the raw `usageLimitResume` object under `summary`. The line is
absent when no limit is live, and the exit codes are unchanged (0 running,
1 idle, 2 blocked).

```bash
ade chat resume-now <session> --text         # alias: ade chat resume
```

`resume-now` cancels the armed row, clears the paused streak, and sends the same
`continue` prompt immediately as an ordinary turn: `Resume sent · turn <turnId>`.
It exits 1 with a one-line reason when the host reports no live usage limit.
Use it only when you know the limit has actually lifted early — calling it while
the limit is still live burns the attempt and re-parks the chat. Action:
`chat.resumeUsageLimitNow`. To stop auto-resuming altogether, or to turn it back
on after a pause, use `chat.updateSession` with `autoContinueAtUsageLimit`.

### Usage limits: when the user asks about them

Don't track usage limits on your own. Read them only when the user asks you to:
"work until 5% is left", "start it on the account with the most room",
"split this across my machines", "how much Claude do I have left?".

```bash
ade usage limits --text                       # this machine, every account
ade usage limits --provider claude --text     # one provider
ade usage limits --machine "Mac mini" --text  # another machine (must be online)
ade usage limits --all-machines --text        # every machine in one table
ade chat status "$ADE_CHAT_SESSION_ID" --text # `account` row: the account you run on
```

Each row is one window of one account: `account` is the id
`ade chat create --instance` takes (Claude and Codex, the providers with several
logins), then `left`, `resets`, and `pace` (`lasts to reset` or
`runs out in 3h`). `(this chat)` marks your own account and `(next chat)` the
account smart balance would start a new chat on; with smart balance on, a chat
started without `--instance` goes there by itself. A `note` says when a row can't
be trusted or used: `signed out` (can't take a chat), `login expired` (renews on
its next chat), a failed check showing the last numbers, or a reading more than
10 minutes old. `--json` gives the same report with ISO times and minutes.

The numbers are the machine's cached poll (about every 1–5 minutes), so read them
between steps rather than in a loop. Common requests:

- **Work until X% is left, then continue after the reset.** Check between steps.
  At X%, finish the step you are in, then
  `ade chat scheduled-work create --at <the window's reset time> --prompt "Limits reset; continue <task>"`
  and stop. Reset times come from `--json` (`windows[].resetsAt`).
- **Start a chat on the account with the most room.**
  `ade chat create --lane <lane> --provider claude --instance <account> --prompt "…"`.
- **Use another machine's accounts.** Read them with `--machine <name>`, then
  start the chat there: `ade chat create --machine <name> --lane <lane there> --instance <account> …`.
  An offline machine answers with an error and can't take chats either.

The same login on two machines is one quota; `--all-machines` says so under the
table. Providers without a limits source (Droid, Qwen, Pi, Devin, Antigravity,
generic ACP) are not listed.

### Lane branch drift

A lane's worktree HEAD can drift from the branch ADE recorded (someone runs
`git checkout` inside it). While drifted, PR matching is paused, because a PR
created from that lane would target the wrong branch.

```bash
ade lane drift [--lane <id>] --text
ade lane drift resolve --switch-back            # restore the recorded branch
ade lane drift resolve --keep-head              # adopt the live branch instead
```

`--switch-back` refuses on a dirty worktree rather than risking work. `--keep-head`
re-points the lane's branch and renames the lane only when its name was literally
advertising the old branch. Actions: `lane.getBranchDrift`, `lane.resolveBranchDrift`.

### Scheduled work

Persistent ADE chats and tracked provider CLI sessions can schedule their own
durable wakeups. Use the typed `ade chat scheduled-work create|list|cancel`
commands or the generic `chat.createScheduledWork`, `chat.listScheduledWork`,
and `chat.cancelScheduledWork` actions. Pause or resume that session with
`ade chat schedules <session> --pause|--resume` or
`chat.setScheduledWorkPaused`. Omit the pause/resume flag, or call
`chat.getScheduledWorkState`, to inspect pause state, the next wake, and active
jobs for either a chat or tracked provider CLI session.

Omitting the target in an ADE-bound agent defaults create/list to
`ADE_CHAT_SESSION_ID`; an agent cannot schedule another session, and an
ordinary untracked shell fails instead of creating orphaned work. Chat delivery
starts a new turn at the next safe turn boundary. Tracked provider CLI delivery
waits for the provider's visible composer boundary, or resumes the same ended
CLI session before sending the prompt. Both survive brain restarts, and
recurring schedules expire seven days after creation. Users can pause chat jobs
in Chat Info or all scheduled work in Settings; CLI-owned jobs remain
manageable through these commands and the Settings recovery list.

Prefer a relative one-shot whenever the intent is "wake me in N minutes":
`--in 12m` in the typed CLI or `delaySeconds: 720` in the action. This avoids
timezone conversion entirely. Absolute one-shots use `--at` / `runAt` and must
include `Z` or an explicit UTC offset. Five-field cron is interpreted in the
ADE brain machine's local timezone, not UTC unless that machine itself uses UTC.
The create result prints the computed next run in both local and ISO form;
verify that time before ending the turn.

```
ade chat scheduled-work create --in 12m --prompt "Check CI and report" --text
ade actions run chat.createScheduledWork --input-json '{"delaySeconds":720,"prompt":"Check CI and report"}' --text
ade chat scheduled-work create --at "2026-07-23T01:05:00-04:00" --prompt "Check CI and report" --text
ade chat scheduled-work create --cron "9,29,49 * * * *" --prompt "Check CI and report" --text
ade chat scheduled-work list --all --text
ade chat scheduled-work cancel <session> <id> --text   # session first; inside your own chat, 'cancel <id>' is enough
ade chat schedules "$ADE_CHAT_SESSION_ID" --pause --text
```

Compatibility commands still exist, but do not teach them as the first choice:

```
ade chat create --lane <lane> --provider codex --model <m> --type subagent --prompt "Fix" # persistent Work chat
ade shell start-cli codex --lane <lane> --model <m> --prompt "Fix"             # tracked provider CLI terminal
```

`ade agent spawn` is the older CLI-session launcher and rejects
`--reasoning-effort`; avoid it for new flows. Common reasoning tiers include
`minimal`, `low`, `medium`, `high`, `xhigh`, `max`, and `ultracode`; confirm
model-specific support with `ade actions run chat.modelCatalog --json`.

Composer drafts and their scheduled sends are a separate surface: `ade drafts
list | create | schedule | update | delete | now | show` (actions `chat.*Draft`)
saves unsent text, arms a send for a fire time, or manages an armed one.

Pick deliberately between the two. A draft send is *the user's message arriving
later*: it lands as a real user turn in the target chat, shows in the user's
Drafts list where they can read, edit, retime or cancel it, and only the
machine it names delivers it. `ade drafts schedule <id> --in 2h --target
<chatId>` (or `--new-chat --lane <laneId> --provider <p> --model <m>`); the
target is always explicit, and `--in` avoids timezone arithmetic. A scheduled
wake (`ade chat scheduled-work create`, or Claude's `ScheduleWakeup` /
`CronCreate` / `/loop`) is *you doing work later*: it is not a message from the
user and does not appear in their drafts. Never paste secrets into an unsent
draft, and remember that a send you arm is indistinguishable from one the user
armed.

In a Claude chat, the native `ScheduleWakeup`, `CronCreate` and `/loop` are
mirrored into ADE's durable scheduler. `durable: true` also persists Claude's
own copy, but ADE's delivery does not depend on it. Due jobs start a new turn at
the next turn boundary even if the chat was busy. The SDK's `CronList` is
advisory; ADE state wins. `CronCreate` always creates a new job, so replace one
with `CronList` + `CronDelete` first. Users pause schedules in Chat Info or
project-wide in Settings.

### MCP servers

A chat keeps the MCP servers it started with; servers the user adds in
Settings › MCP servers reach chats started or restarted after the change. An
agent cannot add an MCP server or sign in to one. When the user asks for one
you do not have, or one reports it needs authentication, tell them: press
**Sign in** on its row in Settings › MCP servers if it asks for one, then
right-click this chat in Work and choose **Restart agent session** (the
conversation is kept), and send a message to try again.

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
ade chat create --machine "Mac mini" --lane <lane there> --type subagent \
  --provider claude --model anthropic/claude-opus-5 --prompt "…"
ade chat launch "…" --machine "Mac mini"          # in a new lane there
ade chat read <id> --machine "Mac mini" --text
ade chat wait <id> --machine "Mac mini" --for idle --timeout-ms 900000
```

- The project there defaults to this repository's checkout; pick another with
  `--project <name|path|id>`, add `--clone` to set a missing GitHub repo up,
  or use `--personal` for projectless chats. Your own lane is never sent: get a
  lane id with `ade lanes list --machine …`.
- A `--type subagent` child there wakes you when it finishes, like a local one,
  with "· on <machine>" and the `ade chat read … --machine` command.
- `--machine "a,b"` on `chat create` starts one child per machine.
- An offline machine fails at once and nothing is queued; retry later.
- Build where the code runs: to build or test an iOS app from a Linux or
  Windows machine, start a subagent on the Mac rather than driving its
  simulator from here.

### Moving this chat to another machine

When the user says "continue this on the Mac mini" (or you need hardware
another machine has), move the chat itself rather than starting a child:

```bash
ade chat handoff <session> --options --json        # where it can go, blockers and their fixes
ade chat handoff <session> --machine "Mac mini" --model <model> \
  --prompt "what to do first there" --when-turn-ends
ade chat move --machine "Mac Studio" <session> [<session>…]
ade chat move --machine "Mac Studio" --all          # every active Work chat on this brain
ade chat move --status <batch-id>                    # progress for every lane and chat
ade chat move --retry <batch-id>                     # resume remaining items in dependency order
```

- `--machine` here is the DESTINATION; the command runs on this machine.
  Brief by default; `--fork` carries full history (same provider only).
  Don't add `--machine` to `--cancel`/`--retry`/`--options`; it is refused.
- Moving your own chat or a descendant you started needs no approval, at any
  permission level. Moving another chat always needs the person's approval,
  including when that chat is full-auto. The moved chat runs there at its own
  permission level mapped to the target model's provider, never broader: any
  `--permissions`/`--sandbox` you pass is dropped.
- If the last move is `unknown` (its answer was lost), a new move is refused.
  Tell the user to check the other machine; `--retry` resends it, `--cancel`
  dismisses it. A retry is refused when the chat changed since it was sent.
- From inside your own turn you need `--when-turn-ends`: the move starts when
  your turn ends, and any new message from the user cancels it.
- `--include-changes` brings uncommitted and unpushed work; otherwise push
  first (`ade git push --lane <lane>`). `--clone` sets a missing repo up there.
- For an unrelated single chat, the user approves your request from that
  chat's banner. Say that you asked, and stop; do not retry while it waits. If
  they deny it, don't ask again (a new request is refused for two minutes).
- Your `--prompt` is the first message the chat gets there, so write it as the
  next instruction to yourself.
- `chat move` is a batch: selected chats expand to descendants by default, and
  their lanes plus ancestor lanes arrive root first. Fork is the default;
  `--brief` requests briefs, while a chat that cannot fork falls back to a
  brief with the reason recorded in its arrival. Use `--no-descendants` to
  select only the named chats, `--no-changes` to leave local changes behind,
  `--interrupt` to stop active turns before moving, and `--note` for a note
  every arrived chat receives. `--all` selects active Work chats in this
  project on the current brain. Busy chats otherwise wait for their turn to
  end. A lost answer or failed item can leave its dependents blocked; check
  `--status`, then retry the batch after resolving the reported issue.
  An agent batch that includes any chat outside its own subtree waits for one
  approval on the caller's chat, with a card listing every chat in the batch.
  Approve starts the whole batch; deny cancels it. Self/descendant-only agent
  batches and a person's batch need no approval.
- After the destination starts, the source chat cannot start turns or deliver
  automatic work until the person chooses **Work here instead**. Its scheduled
  work moves with it (the destination recreates it); anything the destination
  did not take stays pending while the source is locked. A chat that continues
  on another machine can't be moved again (`--all` and descendants skip it, a
  named one is refused) until the person chooses **Work here instead**.

## Archived lanes, chats, and shells

Archiving hides an item; ADE never deletes anything on its own. Archived chats
and shells are left out of `ade chat list`, `ade terminal list`, and `ade search`
by default. Pass `--include-archived` to see them in a list. A known id still
works: `ade chat read <id>`, `ade chat show <id>`, `ade terminal read <id>`.

```bash
ade archive list --text                       # everything archived, newest first
ade archive list --kind chat --older-than 14 --text
ade archive summary --text                    # counts per kind, what is 14+ days old
```

Restoring is for the CTO (`ade archive restore <kind>:<id>`). Deleting is the
user's alone: agents and automations are refused. When old archived items pile
up, tell the user and point them to Settings → Archive; do not try to delete
them yourself.

## Fallback path

If `command -v ade` fails (PowerShell: `Get-Command ade`):

1. Try `${ADE_CLI_PATH:-}` if set (PowerShell: `& $env:ADE_CLI_PATH ...`).
   On Windows it is `ade.cmd`; from Git Bash prefer step 2.
2. Try `${ADE_CLI_BIN_DIR:-}/ade` if set (PowerShell: `& "$env:ADE_CLI_BIN_DIR\ade.cmd" ...`).
   On Windows that folder holds `ade.cmd` for PowerShell and cmd.exe and an
   `ade` script for Git Bash.
3. In an ADE source checkout, after confirming it exists, use `node apps/ade-cli/dist/cli.cjs ...`.

The normal reason to skip ADE CLI is that it is truly unreachable after these fallbacks.

## Do not repair ADE from a task

- Use the `ade` your shell was given. It names the brain that started you.
  Another `ade` (for example `~/.ade/bin/ade.exe`) can belong to another
  channel and reach a different brain, or none.
- Never start, stop, restart, install or update a brain or service
  (`ade brain start|stop|restart|update`, `ade runtime run`). It may belong to
  another channel, and the user's running ADE depends on it.
- Never run `npm install` (or pnpm, yarn, bun) in the user's repo to fix ADE
  itself, for example after `Cannot find module` from ADE's `cli.cjs`.
- When ADE itself fails, stop and report the exact error.
