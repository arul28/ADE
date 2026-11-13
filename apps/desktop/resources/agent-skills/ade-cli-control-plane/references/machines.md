# Working on another machine

## Running one command on another machine

To run tests, a build, or a CLI signed in only there, keep this chat where it
is and run the command there. It runs in **your code there**: a copy of this
chat's code that ADE keeps on that machine (not a lane), at your commit with
your uncommitted changes applied. Nothing is installed for you; install deps
there yourself when a command needs them, and they stay for the next run.

```bash
git push                                          # your commit must be on origin
ade shell start --machine "Windows PC" --wait -- npm test   # streams output, exits with its code
ade terminal list --machine "Windows PC" --text   # this chat's shells there
ade shell clean --machine "Windows PC"            # delete your code there when done
```

- A command that needs no code (`nvidia-smi`, a GPU job, a system check):
  `ade shell start --machine "Windows PC" --no-code --wait -- nvidia-smi`
  runs in an empty folder there, removed when the shell ends. No commit,
  push or checkout needed. `--clone` instead sets this repository up there
  first (for `shell`, `apple`, `android` and `files`).
- Put all the steps in one call: `--wait -- sh -c "npm ci && npm test"`, or
  write a script and run it once. Each call opens a new shell there and syncs
  your code there again, so one call per command is slow. Do not do that.
- The shell runs in the background there: no list on that machine shows it
  (it is archived from the start). Read it with `ade terminal read --machine …`.
- The command uses that machine's shell (PowerShell on Windows).
- A file made there that git does not track (generated code, a pushed
  fixture) stays through the next sync. Unpushed work there (edits to tracked
  files, commits) stops a sync until you pass `--code as-is` (use it as it
  is) or `--code fresh` (throw that work away).
- Devices work the same way: `ade devices --text`, then `ade devices use` or
  `--device`; see ade-computer-use `references/other-machines.md`.
- To move one file (a fixture, a build log, a screenshot), use
  `ade files push --machine "Windows PC" ./local.bin test/fixtures/` and
  `ade files pull --machine "Windows PC" build/out.log ./logs/`. Paths there
  are relative to your code there; up to 256 MiB, checked by sha256. Never send
  a file as base64 or `echo` inside shell commands: that takes several shells
  per file. A pushed file that git does not track stays through the next sync;
  one that overwrites a tracked file counts as an edit made there.
- Git moves code between the machines. To keep work you did there, commit and
  push from there (`ade shell start --machine … --code as-is -- git push origin HEAD:<branch>`),
  then pull here.
- Your code there goes by itself after a week unused, or when this chat is
  deleted or archived; unpushed work there stays, except when the chat is
  deleted. A whole task with its own lane there is `ade chat create --machine`.

## Moving this chat to another machine

When the user says "continue this on the Mac mini" (or you need hardware
another machine has), move the chat itself rather than starting a child:

```bash
ade chat handoff <session> --options --json        # where it can go, blockers and their fixes
ade chat handoff <session> --to "Mac mini" --model <model> \
  --prompt "what to do first there" --when-turn-ends
ade chat move --to "Mac Studio" <session> [<session>…]
ade chat move --to "Mac Studio" --all               # every active Work chat on this machine
ade chat move --status <batch-id>                    # progress for every lane and chat
ade chat move --retry <batch-id>                     # resume remaining items in dependency order
```

- `--to` names where the chat goes; the command runs on this machine.
  Brief by default; `--fork` carries full history (same provider only).
  Don't add `--to` to `--cancel`/`--retry`/`--options`; it is refused.
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
  project on this machine. Busy chats otherwise wait for their turn to
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
