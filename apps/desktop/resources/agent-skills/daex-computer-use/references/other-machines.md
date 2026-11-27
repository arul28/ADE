# A device on another machine

You can use any device on any of the person's machines: an iPhone simulator,
an Android emulator, a screen (Mac, Windows or Linux Desktop), an app under
App Control. Ask the person before you use another machine; say which and why.

## Find a device, pick it once

```bash
daex devices --text                   # every device you can use, on every machine
daex devices --kind ios --text        # only iPhones
daex devices use "ios@MacBook Pro"    # this chat's iPhone is on the MacBook from now on
daex devices current --text           # what this chat picked
daex devices use ios@here             # back to this machine
```

A device id is `<kind>@<source>`. Kinds: `ios`, `android`, `screen`, `app`.
The source is `here`, or a machine's name or key. Each row says what the
device needs first ("SDK missing there", "repository missing there: use
--clone"). A machine that did not answer (asleep) is listed as such. Listing starts
and copies nothing. An `ios` row is never the Mac's already-booted simulator:
`daex apple start` there gives this chat's lane its own (or attaches one,
`--udid <udid>`), and `daex apple status` describes that one.

After `use`, the plain commands (`daex apple launch`, `daex apple tap …`,
`daex apple screenshot`) act on that device. The choice survives a restart.
For one command only, name the machine: `daex apple screenshot --machine "MacBook Pro"`.
(`--device` on `daex apple` and `daex android` still picks which simulator or
emulator, by name; it does not take an id.)
`--machine-project` picks the project there.

## Your code there

A device on another machine runs your code from a copy Daex keeps there,
made on first use. Push your commit first. A build (`daex apple launch`,
`daex android install --gradle`, `daex app-control launch`) brings that copy up
to your checkout, uncommitted changes included. Taps, screenshots and status
reads use it as it is.

| Flag | Means |
|---|---|
| (none) | `--code synced`: before a build, the copy matches your checkout |
| `--code as-is` | use the copy as it is now |
| `--code fresh` | throw away changes made there first |
| `--clone` | the repository is missing there: clone it first |
| `--no-code` | `daex shell` only: an empty folder for a command that needs no code |

To use one of that machine's own lanes instead, `daex apple` and `daex android`
take `--lane <lane there>`; `daex screen` and `daex app-control` refuse it.

## Long builds, turn end, cleanup

A build or boot there can take minutes. The command waits (as long as it would
on that machine, plus a minute) and prints `still running …` every 30 s. Do
not run it again while it waits.

When your turn ends, Daex releases what you hold there (the device's claim,
the screen's input). The simulator or emulator stays on for your next turn.
Turn it off with `daex apple stop` or `daex android stop` (add `--machine
<name>` if you did not pick it with `use`).
`daex shell clean --machine <name>` deletes your code there and everything it
held: its simulator session, emulator, screen and app. It names each folder it
deleted (in every checkout of the repository there), or says nothing was there.

## Who sees what

`proof`, Apple and Android screenshots and captioned recordings land in YOUR
proof drawer (`daex screen screenshot` files nothing, as here). The person at
that machine sees "Driven by an agent on <your machine>" and can end your
session; stop it yourself when done. `daex screen lease` and `daex screen start --shared` are refused
there; use the default input.

For more than a few commands there, start a subagent on that machine
(`daex chat create --machine …`, see daex-cli-control-plane). Let one agent
drive a device; other agents hand it work.

## Daex Cloud iPhone

`ios@cloud` is an iPhone in the cloud that runs for the Daex account, so it works
from any machine. `daex devices` lists it only when the account has it.

```bash
daex devices use ios@cloud       # this chat's iPhone, then the usual daex apple …
daex apple status --text         # access, the minutes the credits have left, capabilities
```

`launch` and `test` build Xcode projects from your checkout there; for Expo,
React Native or Flutter, `daex apple install --app <Simulator .app>`. It spends
the account's credits, one a minute (`daex cloud status`). daex-apple has the rest.
