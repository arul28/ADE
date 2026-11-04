# Working on another machine

## Running one command on another machine

To run tests, a build, or a CLI signed in only there, keep this chat where it
is and run the command there. It runs in this chat's **work copy** on that
machine: a hidden worktree at your commit (not a lane), with your uncommitted
changes applied. Nothing is installed for you; install deps there yourself
when a command needs them, and they stay for the next run.

```bash
git push                                          # your commit must be on origin
ade shell start --machine "Windows PC" --wait -- npm test   # streams output, exits with its code
ade terminal list --machine "Windows PC" --text   # this chat's shells there
ade shell clean --machine "Windows PC"            # delete the work copy when done
```

- The command uses that machine's shell (PowerShell on Windows).
- The simulator works the same way: `ade apple launch --machine "Mac Studio"`
  with no `--lane` builds this chat's work copy there and runs it on a free
  simulator that machine already has (a new one only when none is free).
  `--no-sync` builds the copy as it is; `--discard` throws away unpushed work there first.
  `launch`, `install` and `test` sync the copy first; taps and screenshots use it as it is.
- Git moves code between the machines. To keep work you did there, commit and
  push from there (`ade shell start --machine … --no-sync -- git push origin HEAD:<branch>`),
  then pull here. A sync refuses while the copy holds unpushed work; `--no-sync`
  runs in the copy as it is, `--discard` throws that work away.
- The copy goes by itself after a week unused, or when this chat is deleted or
  archived; unpushed work there stays, except when the chat is deleted. A whole task with its own lane there is `ade chat create --machine`.

## Moving this chat to another machine

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
