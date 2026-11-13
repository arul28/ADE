# Devices and machines: one model for agents

An agent on any machine can use any device on any of the person's machines:
an iPhone simulator on the Mac, an Android emulator on the Windows PC, the
screen of a Linux box, an app under App Control. Later, an ADE Cloud iPhone
that runs on no machine of theirs. This page is the one model an agent learns
for all of it: the words, the commands, and how MCP and the cloud phone fit.

The implementation underneath is [cross-machine agents](cross-machine-agents.md)
(work copies, the bridge, release and cleanup). This page is what agents and
people see.

## The words

Use these words, and only these, in help text, skills, errors and UI.

| Word | Means | Not |
|---|---|---|
| **machine** | One of the person's computers on their ADE account: this one, a Mac, a Linux box, an ADE Cloud computer. | "computer" in commands, "host", "brain", "runtime" |
| **device** | Something an agent drives and watches: an **iPhone** (simulator, later cloud phone), an **Android** phone (emulator), a **screen** (Mac, Windows or Linux Desktop), an **app** (App Control). | "device" for a machine |
| **source** | Where a device comes from: **here** (this machine), **another machine** by name, or **cloud** (ADE Cloud iPhone, later). | |
| **lane** | Where code lives on a machine: a branch with its own folder. | "worktree" in agent text |
| **your code there** | The copy of this chat's code that ADE keeps on another machine so its devices can build and run it. Made, synced and deleted by ADE. | "work copy" in agent text (it stays the internal name) |

Device kinds, as agents type them: `ios`, `android`, `screen`, `app`.
Products keep their names in prose: "iPhone simulator", "Android emulator",
"Mac Desktop", "Windows Desktop", "Linux Desktop", "App Control".

## The commands

### See what you can use

```bash
ade devices --text                 # every device this chat can use, on every machine
ade devices --kind ios --text      # only iPhones
```

One row per device: its **id**, what it is, its source, its state (off,
on, in use by a chat), and what it needs first ("SDK missing there",
"repository missing there: use --clone"). Machines that did not answer are
listed as such, never left out. It reads only; it starts and copies nothing.

A device id is `<kind>@<source>`: `ios@here`, `ios@MacBook Pro`,
`android@Windows PC`, `screen@build-box`, later `ios@cloud`. A source may be a
machine's name or its key.

### Pick a device once per chat

```bash
ade devices use "ios@MacBook Pro"  # this chat's iPhone is on the MacBook from now on
ade devices use ios@here           # back to this machine
ade devices current --text         # this chat's choices
```

After `use`, the plain commands go there with no other flag:
`ade apple launch`, `ade apple tap …`, `ade apple screenshot` all act on the
MacBook's simulator, and a build sends your code there first. The choice is
kept by the chat's own machine (it survives a restart of ADE) and shown by
`ade devices current`.

### Or name the device on one command

```bash
ade apple screenshot --device "ios@MacBook Pro"
ade screen open Calculator --device "screen@MacBook Pro"
```

`--machine <name>` stays as the short form of `--device <kind>@<name>`.

### Your code there

A device on another machine runs your code from a copy ADE keeps there.

| Flag | Means |
|---|---|
| (none) | `--code synced`: before a build, the copy matches your checkout, uncommitted changes included. Your commit must be pushed. |
| `--code as-is` | Use the copy as it is now (was `--no-sync`). |
| `--code fresh` | Throw away changes made there first (was `--discard`). |
| `--clone` | The repository is missing there: clone it first. |
| `--no-code` | A command that needs no code (`nvidia-smi`, a system check): an empty folder there, removed after (was `--scratch`). Shells only. |

`ade shell clean --machine <name>` deletes your code there and everything it
held: its simulator session, emulator, screen and app.

The old flags keep working as aliases and are no longer shown in help.

### Run a command there

```bash
ade shell start --machine "Windows PC" --wait -- npm test
ade shell start --machine "Windows PC" --no-code --wait -- nvidia-smi
```

### Moving a chat, not using a device

`--machine` means "do this there": run a command, use a device, list lanes,
start a new chat there (`ade chat create --machine "Mac mini"`). Moving an
existing chat away is different, so it takes `--to`:

```bash
ade chat handoff <session> --to "Mac mini"     # this chat continues there
ade chat move --to "Mac Studio" <session>      # move chats there
```

`--machine` is still accepted on these two as an alias. `--machine cloud` (a new
lane on its own ADE Cloud computer) stays as it is: it names a place that does
not exist yet.

## Over MCP

An MCP client (claude.ai, ChatGPT, a bot) has no chat on any machine, so it
does not get "your code there". It picks the machine per call with the `ade`
tool's `machine` input and works in a lane on it:

1. `machines_list`, then `projects_list` on that machine.
2. `["devices","--text"]` with that `machine`: the devices there.
3. Device commands with `--lane <lane there>`.

`--device <kind>@<other machine>` and `--machine` (other than
`--machine cloud`) are refused over MCP with the sentence "Pick the machine
with the tool's `machine` input". Cloud phones, once on the account, are
listed by `devices` on any machine and used the same way.

## Where the ADE Cloud iPhone fits

The cloud iPhone is one more **source** for the `ios` kind. Nothing else
changes for the agent:

- `ade devices` lists `ios@cloud` ("ADE Cloud iPhone · phone minutes") when
  the person's account has access, and says how many phone minutes are left.
- `ade devices use ios@cloud`, then the same `ade apple launch | tap |
  screenshot | record` verbs. A build sends the code to the cloud Mac instead of
  a machine of theirs.
- What differs is stated in the answers, not in new commands: it costs phone
  minutes while on, it turns off by itself when idle, and it has no Xcode
  previews.
- On a Mac with simulators, `here` stays the default; the cloud phone is a
  choice, as another machine is.

In code, a device source is `here | { machine } | { cloud }`
(`shared/types/deviceSources.ts`). The cloud variant is reserved now: `use
ios@cloud` answers "ADE Cloud iPhone is not on this account yet".

## Rules for anything new

- A new command that acts on a device takes `--device`, and reads the chat's
  choice when it is absent.
- Words outside the table above do not go into agent-facing text.
- One skill page holds this model: ade-computer-use
  `references/other-machines.md`. Other skills link to it.
