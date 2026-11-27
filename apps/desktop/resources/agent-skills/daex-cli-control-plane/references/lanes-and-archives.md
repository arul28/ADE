# Lane branch drift and archived items

## Lane branch drift

A lane's worktree HEAD can drift from the branch Daex recorded (someone runs
`git checkout` inside it). While drifted, PR matching is paused, because a PR
created from that lane would target the wrong branch.

```bash
daex lane drift [--lane <id>] --text
daex lane drift resolve --switch-back            # restore the recorded branch
daex lane drift resolve --keep-head              # adopt the live branch instead
```

`--switch-back` refuses on a dirty worktree rather than risking work. `--keep-head`
re-points the lane's branch and renames the lane only when its name was literally
advertising the old branch. Actions: `lane.getBranchDrift`, `lane.resolveBranchDrift`.

## Archived lanes, chats, and shells

Archiving hides an item; Daex never deletes anything on its own. Archived chats
and shells are left out of `daex chat list`, `daex terminal list`, and `daex search`
by default. Pass `--include-archived` to see them in a list. A known id still
works: `daex chat read <id>`, `daex chat show <id>`, `daex terminal read <id>`.

```bash
daex archive list --text                       # everything archived, newest first
daex archive list --kind chat --older-than 14 --text
daex archive summary --text                    # counts per kind, what is 14+ days old
```

Restoring is the person's (the CTO role), not an agent's: `daex archive restore <kind>:<id>`. Deleting is the
user's alone: agents and automations are refused. When old archived items pile
up, tell the user and point them to Settings → Archive; do not try to delete
them yourself.
