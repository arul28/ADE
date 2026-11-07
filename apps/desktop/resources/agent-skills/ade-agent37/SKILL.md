---
name: ade-agent37
description: Use this skill when work needs a cloud machine on Agent 37 — listing the account's boxes and VMs, making one, waking or sleeping one, resizing it, copying a warm one for a new lane, moving a box to a VM (or back), deleting one, checking spend against the monthly cap, or turning "keep a cloud machine ready" on, off or retrying it — through `ade agent37`.
---

# ADE on Agent 37

Agent 37 machines are cloud Linux machines on the person's account, billed per
minute from their Agent 37 wallet. ADE treats each one as an ordinary machine
of theirs: lanes, chats, terminals and `--machine` calls work on it.

| Type | What it runs | Price |
|---|---|---|
| box | Lanes, chats, terminals, a Linux Desktop screen | about 0.8¢ an hour (2 vCPU / 4 GB) |
| VM | Everything a box does, plus Docker and the Android emulator | about 2.5x a box |

Sizes, either type: `2x4`, `4x8`, `4x16`, `4x32` (vCPU x GB). Asleep, a machine
bills only its disk (about 1¢ a day).

## Commands

```bash
ade agent37 list --text                       # machines: state, size, price, spend, saved asleep
ade agent37 spending --text                   # this month against the cap, the wallet
ade agent37 create --kind vm --shape 4x8 --name "android vm"
ade agent37 sleep <machine>
ade agent37 wake <machine>
ade agent37 resize <machine> --shape 4x16
ade agent37 copy <machine> --name "lane box"  # same files, a new machine
ade agent37 move <machine> --to vm            # change type, keep repos, lanes, chats
ade agent37 delete <machine>
ade agent37 sleep-after <machine> 10          # or never
ade agent37 cap 50                            # or off (no cap by default)
ade agent37 limits                            # what unattended agents may spend
ade agent37 ready on --kind vm --setup "npm ci && docker compose up -d"
ade agent37 ready status|off|retry
ade chat create --machine agent37:ready --prompt "…"
```

`<machine>` is its name or Agent 37 id from `ade agent37 list`. Add `--json`
for the full shape.

## Sleep and wake are automatic

- A machine sleeps on its own after a few idle minutes (10 by default). It
  stays awake while a chat turn, a terminal command, an agent CLI or a setup
  runs on it, so never keep one awake by hand.
- A `--machine` call, opening one of its lanes, or sending to one of its chats
  wakes it in about a second; ADE on it answers a few seconds later.
- So you rarely need `wake` or `sleep`. Sleep one only when the person asks,
  or when you know nothing else will use it soon.

## Money and approvals

These ask the person in your chat first: `create`, `resize`, `copy`, `move`,
`delete`, `sleep-after … never`, raising or removing the cap, `ready on`.

- The command waits for the answer; the card gives up after 5 minutes and the
  command then fails with "nobody answered". Don't retry it in a loop: say what
  you wanted and why, and let the person decide.
- In a full-auto chat or an automation run, ADE answers for the person with
  their limits (`ade agent37 limits`; by default 3 new machines a day, up to
  4 vCPU · 16 GB): yes within them, no past them, no to raising the cap or a
  limit, keeping a machine awake for good, or deleting a machine your chat
  didn't make. A line in the chat records the answer. At the daily limit,
  reuse a machine instead of making another.
- At the monthly cap ADE makes, wakes and resizes nothing. Running work carries
  on. Don't look for a way around the cap; tell the person.
- Asked from a shell with no chat (no `ADE_CHAT_SESSION_ID`), costly commands
  are refused: there is nobody to ask.

## Choosing

- **Too small** (builds swap, tests time out): offer `resize` to the next size.
  It restarts the machine, so wait for running chats to finish.
- **Needs Docker or Android**: a box can't; offer `move --to vm` (keeps every
  repo, lane and chat; Docker data and running processes don't move). From a
  chat that runs on that box, `move` refuses (it would stop your own chat):
  see the next section.

## Your chat runs on a box and needs a VM

`ade android start` on a box says why in plain words, with the price. Tell the
person that, then, within their limits:

1. `ade agent37 create --kind vm --shape <the size the message names> --name
   "<name>"`: 4x8, or the box's own size when the box is bigger. ADE asks the
   person, or answers for them in full-auto with their limits. The VM joins
   on its own.
2. `ade chat handoff "$ADE_CHAT_SESSION_ID" --machine "<name>" --fork
   --include-changes --clone --when-turn-ends --note "<the task to carry on
   with>. Then offer to delete the box <box name>; it bills while awake and
   sleeps when idle."` The move starts when your turn ends.
3. End your turn. The new chat on the VM has the whole history and carries on
   with the note; the person's window follows it there. This chat shows
   **Continues on <name>**.

The box stays as it is. Delete it only when the person says yes in the new chat.
- **A fresh machine for a lane**: `copy` a warm machine of the project (its
  dependencies are already installed), or `ade chat create --machine
  agent37:ready` when the project keeps one ready.
- **Moving one chat and its lane** to another computer (the person's Mac, a
  cloud machine): that is `ade chat move`, not `agent37 move`.
- **Idle and costly**: offer `sleep`, or `delete` for a machine nobody needs.

## Making machines

`create`, `copy` and `move` work from any of the person's signed-in machines.
With the ADE desktop app open there, the new machine joins on its own; without
it, your chat gets a link the person opens on their phone or in a browser to
approve it joining, and the command waits up to 10 minutes for that.

## Don'ts

- Never ask for the Agent 37 key or print it. If Agent 37 isn't connected,
  `ade integrations connect agent37 --reason "…"` shows the person a card.
- Never sign Claude or another provider in on a cloud machine for the person;
  they do that themselves. One sign-in covers every new machine: **Claude on
  your cloud machines** on the Agent 37 page (ade://settings/integrations.agent37).
  Machines made before it keep what they had.
- Don't delete a machine you didn't make unless the person asked for that one.
