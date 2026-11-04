# A device on another machine

`ade apple`, `ade screen` and `ade app-control` take `--machine <name>` to
drive that machine's simulator, screen or app (`--lane <lane there>`; use
`--machine-project` to pick the project, since `ade apple` already uses
`--project`). `proof` captures there and files the still in YOUR proof drawer.
Recordings stay on that machine. The person at that Mac sees "Driven by an
agent on <your machine>" and can end your session; stop it yourself when done.
If the app needs building, start a subagent on that machine instead
(`ade chat create --machine …`, see ade-cli-control-plane). Let one agent
drive a device; other agents hand it work rather than take turns on it.
