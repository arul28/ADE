# Devices and machines: one model for agents

An agent on any machine can use any device on any of the person's machines:
an iPhone simulator on the Mac, an Android emulator on the Windows PC, the
screen of a Linux box, an app under App Control. Later, a DAEX Cloud iPhone
that runs on no machine of theirs. This page is the one model an agent learns
for all of it: the words, the commands, and how MCP and the cloud phone fit.

The implementation underneath is [cross-machine agents](cross-machine-agents.md)
(work copies, the bridge, release and cleanup). This page is what agents and
people see.

## The words

Use these words, and only these, in help text, skills, errors and UI.

| Word | Means | Not |
|---|---|---|
| **machine** | One of the person's computers on their DAEX account (this one, a Mac, a Linux box), or DAEX Cloud. DAEX Cloud is one machine for the account; each cloud lane runs on its own cloud computer behind it, and people never see those by name. | "computer" in commands, "host", "brain", "runtime" |
| **device** | Something an agent drives and watches: an **iPhone** (simulator, later cloud phone), an **Android** phone (emulator), a **screen** (Mac, Windows or Linux Desktop), an **app** (App Control). | "device" for a machine |
| **source** | Where a device comes from: **here** (this machine), **another machine** by name, or **cloud** (DAEX Cloud iPhone, later). | |
| **lane** | Where code lives on a machine: a branch with its own folder. | "worktree" in agent text |
| **your code there** | The copy of this chat's code that DAEX keeps on another machine so its devices can build and run it. Made, synced and deleted by DAEX. | "work copy" in agent text (it stays the internal name) |

Device kinds, as agents type them: `ios`, `android`, `screen`, `app`.
Products keep their names in prose: "iPhone simulator", "Android emulator",
"Mac Desktop", "Windows Desktop", "Linux Desktop", "App Control".

## The commands

### See what you can use

```bash
daex devices --text                 # every device this chat can use, on every machine
daex devices --kind ios --text      # only iPhones
```

One row per device: its **id**, what it is, its source, its state (off,
on, in use by a chat), and what it needs first ("SDK missing there",
"repository missing there: use --clone"). Machines that did not answer are
listed as such, never left out: each gets a few seconds to name its projects,
so an asleep machine the account still shows online is one "did not answer"
row, not a wait for the whole list. It reads only; it starts and copies
nothing. An `ios` row describes the chat's lane's own simulator there, never
a simulator the Mac already has booted: `daex apple start` makes one for the
lane (or attaches an installed one with `--udid`).

A device id is `<kind>@<source>`: `ios@here`, `ios@MacBook Pro`,
`android@Windows PC`, `screen@build-box`, later `ios@cloud`. A source may be a
machine's name or its key.

### Pick a device once per chat

```bash
daex devices use "ios@MacBook Pro"  # this chat's iPhone is on the MacBook from now on
daex devices use ios@here           # back to this machine
daex devices current --text         # this chat's choices
```

After `use`, the plain commands go there with no other flag:
`daex apple launch`, `daex apple tap …`, `daex apple screenshot` all act on the
MacBook's simulator, and a build sends your code there first. The choice is
kept by the chat's own machine (it survives a restart of DAEX) and shown by
`daex devices current`.

### Or name the machine on one command

```bash
daex apple screenshot --machine "MacBook Pro"
daex screen open Calculator --machine "MacBook Pro"
```

The command says the kind, so `--machine` is all it needs. Ids
(`ios@MacBook Pro`) are only for `daex devices use`. `--device` keeps its
existing meaning on `daex apple` and `daex android`: which simulator or emulator
of the lane's, by name.

### Your code there

A device on another machine runs your code from a copy DAEX keeps there.

| Flag | Means |
|---|---|
| (none) | `--code synced`: before a build, the copy matches your checkout, uncommitted changes included. Your commit must be pushed. |
| `--code as-is` | Use the copy as it is now (was `--no-sync`). |
| `--code fresh` | Throw away changes made there first (was `--discard`). |
| `--clone` | The repository is missing there: clone it first. |
| `--no-code` | A command that needs no code (`nvidia-smi`, a system check): an empty folder there, removed after (was `--scratch`). Shells only. |

`daex shell clean --machine <name>` deletes your code there and everything it
held: its simulator session, emulator, screen and app. A machine can hold
two checkouts of one repository; the calls of a chat keep landing in the one
that holds its copy (asked of that machine once, then kept; a lookup that
got no answer is asked again on the next call), and `clean`
deletes the chat's copy in every checkout there, naming each folder. It says
"Deleted" only when it deleted something. The chat's record of that machine
(its work copy lane, its shells) is cleared with it. The tools pane's
**Clean up** deletes the same copies for a person, each through its own
project there, but keeps a copy holding work nobody pushed and names it
(Settings › Machines deletes it on purpose, after asking). Archiving or
deleting the chat removes its copies the same way, unpushed work kept: its
shells there stop first, in whichever checkout they run, and a copy still
busy is left for that machine's hourly sweep.

The old flags keep working as aliases and are no longer shown in help.

### Run a command there

```bash
daex shell start --machine "Windows PC" --wait -- npm test
daex shell start --machine "Windows PC" --no-code --wait -- nvidia-smi
```

### Moving a chat, not using a device

`--machine` means "do this there": run a command, use a device, list lanes,
start a new chat there (`daex chat create --machine "Mac mini"`). Moving an
existing chat away is different, so it takes `--to`:

```bash
daex chat handoff <session> --to "Mac mini"     # this chat continues there
daex chat move --to "Mac Studio" <session>      # move chats there
```

`--machine` is still accepted on these two as an alias. A move onto DAEX Cloud
is not built. `--machine cloud` on other commands starts a new lane on DAEX
Cloud.

## Over MCP

An MCP client (claude.ai, ChatGPT, a bot) has no chat on any machine, so it
does not get "your code there". It picks the machine per call with the `ade`
tool's `machine` input and works in a lane on it:

1. `machines_list`, then `projects_list` on that machine.
2. `["devices","--text"]` with that `machine`: the devices there.
3. Device commands with `--lane <lane there>`.

`--machine` (other than `--machine cloud`) and `devices use` are refused
over MCP with the sentence "Pick the machine
with the tool's `machine` input". Cloud phones, once on the account, are
listed by `devices` on any machine and used the same way.

## Where the DAEX Cloud iPhone fits

The cloud iPhone is one more **source** for the `ios` kind. Nothing else
changes for the agent:

- `daex devices` lists `ios@cloud` ("DAEX Cloud iPhone") when the person's
  account has access, and says how many minutes its credits have left.
- `daex devices use ios@cloud`, then the same `ade apple launch | tap |
  screenshot | record` verbs. A build sends the code to the cloud Mac instead of
  a machine of theirs.
- What differs is stated in the answers, not in new commands: it costs phone
  minutes while on, it turns off by itself when idle, and it has no Xcode
  previews.
- On a Mac with simulators, `here` stays the default; the cloud phone is a
  choice, as another machine is.

In code, a device source is `here | { machine } | { cloud }`
(`shared/types/deviceSources.ts`). The cloud variant is reserved now: `use
ios@cloud` answers "DAEX Cloud iPhone is not on this account yet".

## Rules for anything new

- A new command that acts on a device takes `--machine`, and reads the
  chat's choice when it is absent.
- Words outside the table above do not go into agent-facing text.
- One skill page holds this model: ade-computer-use
  `references/other-machines.md`. Other skills link to it.
