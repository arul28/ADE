# Devices and machines: one model for agents

An agent on any machine can use any device on any of the person's machines (an
iPhone simulator on the Mac, an Android emulator on the Windows PC, a Linux
screen, an app under App Control) or the account's DAEX Cloud iPhone. This page
is the model agents learn: words, commands, MCP and the cloud phone. The
implementation is [cross-machine agents](cross-machine-agents.md). The CLI is
`daex` (`ade` still works).

Code: `apps/ade-cli/src/cliDevices.ts` (the commands) and
`apps/desktop/src/shared/types/deviceSources.ts` (ids, sources, the chat's
choices, the subcommand parse DAEX MCP's check shares).

## The words

Use these, and only these, in help, skills, errors and UI.

| Word | Means | Not |
|---|---|---|
| **machine** | One of the person's computers on their DAEX account, or DAEX Cloud (one machine; its per-lane cloud computers are never named). | "computer" in commands, "host", "brain", "runtime" |
| **device** | What an agent drives and watches: an **iPhone** (simulator or the cloud iPhone), an **Android** emulator, a **screen** (Mac, Windows or Linux Desktop), an **app** (App Control). | "device" for a machine |
| **source** | Where a device is: **here**, **another machine** by name, or **cloud** (DAEX Cloud iPhone). | |
| **lane** | A branch with its own folder on a machine. | "worktree" in agent text |
| **your code there** | The copy of this chat's code DAEX keeps on another machine (internally the "work copy"). | "work copy" in agent text |

Kinds as typed: `ios`, `android`, `screen`, `app`.

## The commands

### See what you can use

```bash
daex devices --text              # every device this chat can use, on every machine
daex devices --kind ios --text
```

One row per device: id, what it is, source, state, and what it needs first
("SDK missing there", "repository missing there: use --clone"). Machines that
do not answer within a few seconds are listed as such. It only reads. An `ios`
row is the chat's lane's own simulator there (`daex apple start` makes one, or
attaches an installed one with `--udid`).

A device id is `<kind>@<source>`: `ios@here`, `ios@MacBook Pro`,
`android@Windows PC`, `screen@build-box`, `ios@cloud`.

### Pick a device once per chat

```bash
daex devices use "ios@MacBook Pro"
daex devices use ios@here
daex devices current --text
```

After `use`, plain commands (`daex apple launch`, `tap`, `screenshot`) go there;
a build sends your code first. The chat's own machine keeps the choice across
restarts.

### Or name the machine on one command

```bash
daex apple screenshot --machine "MacBook Pro"
daex screen open Calculator --machine "MacBook Pro"
```

Ids are only for `devices use`. `--device` on `daex apple` / `daex android`
still names one of the lane's simulators or emulators.

### Your code there

| Flag | Means |
|---|---|
| (none) | `--code synced`: before a build the copy matches your checkout, uncommitted changes included; your commit must be pushed. |
| `--code as-is` | Use the copy as it is (was `--no-sync`). |
| `--code fresh` | Discard changes made there first (was `--discard`). |
| `--clone` | Clone the repository there first. |
| `--no-code` | No code needed: an empty folder, removed after (was `--scratch`). Shells only. |

`daex shell clean --machine <name>` deletes your code there (every checkout that
holds the chat's copy) with its simulator session, emulator, screen and app, and
says "Deleted" only when it deleted something. The tools pane's **Clean up** and
archiving or deleting the chat do the same but keep a copy holding unpushed work
(Settings › Machines deletes it on purpose).

### Run a command there

```bash
daex shell start --machine "Windows PC" --wait -- npm test
daex shell start --machine "Windows PC" --no-code --wait -- nvidia-smi
```

### Moving a chat, not using a device

`--machine` means "do this there". Moving an existing chat takes `--to`:

```bash
daex chat handoff <session> --to "Mac mini"
daex chat move --to "Mac Studio" <session>
```

`--machine` is a hidden alias on these two. A move onto DAEX Cloud is not built;
`--machine cloud` on other commands starts a new lane on DAEX Cloud.

## Over MCP

An MCP client has no chat on any machine, so no "your code there". It picks the
machine per call with the `daex` tool's `machine` input and works in a lane:
`machines_list`, `projects_list`, then `["devices","--text"]` and device
commands with `--lane <lane there>`. `--machine` (other than `cloud`) and
`devices use` are refused over MCP ("Pick the machine with the tool's `machine`
input").

## The DAEX Cloud iPhone

`ios@cloud` is the account's cloud iPhone, so Windows and Linux machines can use
it. `daex devices` lists it only when the account has it; otherwise
`devices use ios@cloud` says why: not on this account yet
(`ADE_CLOUD_IPHONE_UNAVAILABLE`), or this machine's DAEX predates it (1.2.131).
It spends DAEX Cloud credits while on and turns off when idle; a Mac of the
person's spends none, and `here` stays the default on a Mac. Agent guidance is
in the `daex-apple` skill.

## Rules for anything new

- A command that acts on a device takes `--machine` and reads the chat's choice
  when it is absent.
- Words outside the table do not go into agent-facing text.
- One skill page holds this model: `daex-computer-use`
  `references/other-machines.md`; other skills link to it.
