# Usage limits

## Usage limits: waiting out a reset

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

## Usage limits: when the user asks about them

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

## Continuing on another account

When the user asks to keep going now on another account, move the same chat
(same thread, nothing restarted) instead of starting a new one:

```bash
ade chat continue-on-account <session>                 # an account that still has room; exit 1 when none has
ade chat switch-account <session> --account <email>    # a specific Claude or Codex account
```
