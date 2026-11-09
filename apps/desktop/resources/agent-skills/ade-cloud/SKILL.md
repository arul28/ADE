---
name: ade-cloud
description: Use this skill when work needs an ADE Cloud computer: listing the account's computers, making one, waking or sleeping one, resizing it, updating it, copying a warm one for a new lane, moving one to a full computer (or back), deleting one, checking the plan and hours left, or turning "keep a cloud machine ready" on, off or retrying it, through `ade cloud`.
---

# ADE Cloud

ADE Cloud computers are Linux computers ADE runs for the person. ADE treats each
one as an ordinary machine of theirs: lanes, chats, terminals and `--machine`
calls work on it.

The plan is hours of a Small computer: 50 a month free, 500 on the $5 plan.
Bigger computers use hours faster. Asleep, a computer uses no hours.

| Size | CPU / memory | Standard | Full computer (Docker, Android) |
|---|---|---|---|
| Small (`2x4`) | 2 / 4 GB | 1× | 2.5× |
| Medium (`4x8`) | 4 / 8 GB | 2× | 5× |
| Large (`4x16`) | 4 / 16 GB | 3.3× | 8.2× |
| X-Large (`4x32`) | 4 / 32 GB | 5.8× | 14.5× |

Default is Small, standard. Android needs a full computer of Medium or bigger.

## Commands

```bash
ade cloud list --text                       # computers: state, size, how fast each uses hours
ade cloud hours --text                      # plan, hours left, reset date
ade cloud create --shape medium --name "lane box"
ade cloud create --kind vm --shape medium --name "android vm"   # full computer
ade cloud sleep <machine>
ade cloud wake <machine>
ade cloud resize <machine> --shape large
ade cloud update <machine>                  # restart on the current ADE
ade cloud copy <machine> --name "lane box"  # same files, a new machine
ade cloud move <machine> --to vm            # change type, keep repos, lanes, chats
ade cloud delete <machine>
ade cloud limits                            # what unattended agents may spend
ade cloud ready on --kind vm --setup "npm ci && docker compose up -d"
ade cloud ready status|off|retry
ade chat create --machine cloud:ready --prompt "…"
```

`<machine>` is its name or id from `ade cloud list`. Add `--json`
for the full shape. `list`, `hours`, reading `limits`, `sleep` and `wake`
are the account's, so they work from any folder; the rest run in the current
folder's project.

## Sleep and wake are automatic

- A machine sleeps 3 minutes after its last activity. It stays awake while a
  chat turn or a real command runs, while an agent CLI works, during setup, a
  first clone, a copy or a move, and while a person has a tool open on it (the
  terminal, Linux Desktop, a preview). A shell at its prompt, an agent CLI at
  its prompt, or a chat waiting on your approval lets it sleep, and so does a
  command with no output and no input for an hour. Never keep one awake by hand.
- A `--machine` call, opening one of its lanes or tools, or sending to one of
  its chats wakes it in about a second; ADE on it answers a few seconds later.
  A computer that was stopped (at 0 hours) comes back only with an explicit
  wake from someone with hours.
- So you rarely need `wake` or `sleep`. Sleep one only when the person asks,
  or when you know nothing else will use it soon.

## Hours and approvals

These ask the person in your chat first: `create`, `resize`, `update`, `copy`,
`move`, `delete`, loosening `ade cloud limits`, `ready on`. The card says what it uses in hours ("about 2 hours for each hour
it's awake").

- The command waits for the answer; the card gives up after 5 minutes and the
  command then fails with "nobody answered". Don't retry it in a loop: say what
  you wanted and why, and let the person decide.
- In a full-auto chat or an automation run, ADE answers for the person with
  their limits (`ade cloud limits`; by default 3 new machines a day, up to
  Large): yes within them, no past them, no to loosening a limit, keeping a
  machine awake for good, or deleting a machine your chat
  didn't make. A line in the chat records the answer. At the daily limit,
  reuse a machine instead of making another.
- At 0 hours the server refuses new computers and wakes, and computers stop.
  Tell the person; don't look for a way around it. In a full-auto chat or an
  automation, hours ADE can't read count as 0: try again in a minute.
- Asked from a shell with no chat (no `ADE_CHAT_SESSION_ID`), commands that
  use hours are refused: there is nobody to ask.

## Choosing

- **Too small** (builds swap, tests time out): offer `resize` to the next size,
  and say how many hours it uses ("about 2 hours for each hour awake").
  It restarts the machine, so wait for running chats to finish.
- **Needs Docker or Android**: a standard computer can't; offer `move --to vm` (keeps every
  repo, lane and chat; Docker data and running processes don't move). From a
  chat that runs on that box, `move` refuses (it would stop your own chat):
  see the next section.

## Your chat runs on a box and needs a VM

`ade android start` on a standard computer says why in plain words, with the hours. Tell the
person that, then, within their limits:

1. `ade cloud create --kind vm --shape <the size the message names> --name
   "<name>"`: Medium, or the computer's own size when it's bigger. ADE asks the
   person, or answers for them in full-auto with their limits. The VM joins
   on its own.
2. `ade chat handoff "$ADE_CHAT_SESSION_ID" --machine "<name>" --fork
   --include-changes --clone --when-turn-ends --note "<the task to carry on
   with>. Then offer to delete the computer <name>; it uses hours while awake and
   sleeps when idle."` The move starts when your turn ends.
3. End your turn. The new chat on the VM has the whole history and carries on
   with the note; the person's window follows it there. This chat shows
   **Continues on <name>**.

The box stays as it is. Delete it only when the person says yes in the new chat.
- **A fresh machine for a lane**: `copy` a warm machine of the project (its
  dependencies are already installed), or `ade chat create --machine
  cloud:ready` when the project keeps one ready.
- **Moving one chat and its lane** to another computer (the person's Mac, a
  cloud machine): that is `ade chat move`, not `cloud move`.
- **Idle and using hours**: offer `sleep`, or `delete` for one nobody needs.

## Making machines

`create`, `copy` and `move` work from any of the person's signed-in machines.
With the ADE desktop app open there, the new machine joins on its own; without
it, your chat gets a link the person opens on their phone or in a browser to
approve it joining, and the command waits up to 10 minutes for that.

## Don'ts

- If `ade cloud` says ADE Cloud isn't available, tell the person. Never ask for a key: ADE's server holds it.
- Never sign Claude or another provider in on a cloud machine for the person;
  they do that themselves. One sign-in covers every new machine: **Sign-ins
  for your cloud machines** on the ADE Cloud page
  (ade://settings/integrations.ade-cloud-sign-ins). Machines made before it keep
  what they had. You cannot save these sign-ins: ADE refuses an agent.
- Don't delete a machine you didn't make unless the person asked for that one.
