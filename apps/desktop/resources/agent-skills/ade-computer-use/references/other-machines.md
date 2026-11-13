# A device on another machine

`ade apple`, `ade android`, `ade screen` and `ade app-control` take
`--machine <name>` to drive that machine's simulator, emulator, screen (Mac,
Windows or Linux Desktop) or app, with no lane there. Use `--machine-project`
to pick the project, since `ade apple` already uses `--project`.

Without `--lane`, the device works for this chat's work copy there: a hidden
worktree at your commit (it must be on origin), made on first use. This chat
owns the device, the screen's windows or the App Control session, as it would
a lane's. Status reads (`status`, `devices`, `screen windows`, `app-control
drivers`) make no copy. A build (`ade apple launch`, `ade android install
--gradle`, `ade app-control launch`) sends your checkout and its uncommitted
changes first; on `ade apple` and `ade app-control`, `--no-sync` runs the copy
as it is. `ade screen` and `ade
app-control` refuse `--lane` (the copy is the lane); `ade apple` and `ade
android` take `--lane <lane there>` to use one of that machine's lanes.

`proof`, Apple and Android screenshots, and captioned recordings are filed
in YOUR proof drawer (`ade screen screenshot` files nothing, as here).
`ade screen lease` and `ade screen start --shared` ask in a chat on that
machine, so they are refused there; use the default input. The person at that
machine sees "Driven by an agent on <your machine>" and can end your session;
stop it yourself when done. `ade shell clean --machine <name>` removes the
copy and with it its simulator, emulator, screen and app.

A build or boot there can take minutes: the command waits for it (up to the
same limit as on that machine, plus a minute) and prints `still running …`
every 30 s. Do not run it again while it waits. When your turn ends, ADE
releases what you hold there (the device's claim, the screen's input lease);
the simulator or emulator stays on for your next turn. Turn it off with
`ade apple stop --machine …` / `ade android stop --machine …`, or remove
everything with `ade shell clean --machine …`.

If the work there is more than a few commands, start a subagent on that
machine instead (`ade chat create --machine …`, see ade-cli-control-plane).
Let one agent drive a device; other agents hand it work rather than take turns
on it.
