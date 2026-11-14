# A device on another machine

You can use any device on any of the person's machines: an iPhone simulator,
an Android emulator, a screen (Mac, Windows or Linux Desktop), an app under
App Control. Ask the person before you use another machine; say which and why.

## Find a device, pick it once

```bash
ade devices --text                   # every device you can use, on every machine
ade devices --kind ios --text        # only iPhones
ade devices use "ios@MacBook Pro"    # this chat's iPhone is on the MacBook from now on
ade devices current --text           # what this chat picked
ade devices use ios@here             # back to this machine
```

A device id is `<kind>@<source>`. Kinds: `ios`, `android`, `screen`, `app`.
The source is `here`, or a machine's name or key. Each row says what the
device needs first ("SDK missing there", "repository missing there: use
--clone"). A machine that did not answer (asleep) is listed as such. Listing starts
and copies nothing. An `ios` row is never the Mac's already-booted simulator:
`ade apple start` there gives this chat's lane its own (or attaches one,
`--udid <udid>`), and `ade apple status` describes that one.

After `use`, the plain commands (`ade apple launch`, `ade apple tap …`,
`ade apple screenshot`) act on that device. The choice survives a restart.
For one command only, name the machine: `ade apple screenshot --machine "MacBook Pro"`.
(`--device` on `ade apple` and `ade android` still picks which simulator or
emulator, by name; it does not take an id.)
`--machine-project` picks the project there.

## Your code there

A device on another machine runs your code from a copy ADE keeps there,
made on first use. Push your commit first. A build (`ade apple launch`,
`ade android install --gradle`, `ade app-control launch`) brings that copy up
to your checkout, uncommitted changes included. Taps, screenshots and status
reads use it as it is.

| Flag | Means |
|---|---|
| (none) | `--code synced`: before a build, the copy matches your checkout |
| `--code as-is` | use the copy as it is now |
| `--code fresh` | throw away changes made there first |
| `--clone` | the repository is missing there: clone it first |
| `--no-code` | `ade shell` only: an empty folder for a command that needs no code |

To use one of that machine's own lanes instead, `ade apple` and `ade android`
take `--lane <lane there>`; `ade screen` and `ade app-control` refuse it.

## Long builds, turn end, cleanup

A build or boot there can take minutes. The command waits (as long as it would
on that machine, plus a minute) and prints `still running …` every 30 s. Do
not run it again while it waits.

When your turn ends, ADE releases what you hold there (the device's claim,
the screen's input). The simulator or emulator stays on for your next turn.
Turn it off with `ade apple stop` or `ade android stop` (add `--machine
<name>` if you did not pick it with `use`).
`ade shell clean --machine <name>` deletes your code there and everything it
held: its simulator session, emulator, screen and app. It names each folder it
deleted (in every checkout of the repository there), or says nothing was there.

## Who sees what

`proof`, Apple and Android screenshots and captioned recordings land in YOUR
proof drawer (`ade screen screenshot` files nothing, as here). The person at
that machine sees "Driven by an agent on <your machine>" and can end your
session; stop it yourself when done. `ade screen lease` and `ade screen start --shared` are refused
there; use the default input.

For more than a few commands there, start a subagent on that machine
(`ade chat create --machine …`, see ade-cli-control-plane). Let one agent
drive a device; other agents hand it work.

## ADE Cloud iPhone

`ios@cloud` is a cloud iPhone, used like any other source: `ade devices use
ios@cloud`, then the same `ade apple` commands. It is not on accounts yet:
`use ios@cloud` answers "ADE Cloud iPhone is not on this account yet".
