# Lane branch drift and archived items

## Lane branch drift

A lane's worktree HEAD can drift from the branch ADE recorded (someone runs
`git checkout` inside it). While drifted, PR matching is paused, because a PR
created from that lane would target the wrong branch.

```bash
ade lane drift [--lane <id>] --text
ade lane drift resolve --switch-back            # restore the recorded branch
ade lane drift resolve --keep-head              # adopt the live branch instead
```

`--switch-back` refuses on a dirty worktree rather than risking work. `--keep-head`
re-points the lane's branch and renames the lane only when its name was literally
advertising the old branch. Actions: `lane.getBranchDrift`, `lane.resolveBranchDrift`.

## Archived lanes, chats, and shells

Archiving hides an item; ADE never deletes anything on its own. Archived chats
and shells are left out of `ade chat list`, `ade terminal list`, and `ade search`
by default. Pass `--include-archived` to see them in a list. A known id still
works: `ade chat read <id>`, `ade chat show <id>`, `ade terminal read <id>`.

```bash
ade archive list --text                       # everything archived, newest first
ade archive list --kind chat --older-than 14 --text
ade archive summary --text                    # counts per kind, what is 14+ days old
```

Restoring is for the CTO (`ade archive restore <kind>:<id>`). Deleting is the
user's alone: agents and automations are refused. When old archived items pile
up, tell the user and point them to Settings → Archive; do not try to delete
them yourself.
