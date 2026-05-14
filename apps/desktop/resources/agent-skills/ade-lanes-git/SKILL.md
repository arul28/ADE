---
name: ade-lanes-git
description: Use this skill when creating, inspecting, syncing, committing, pushing, archiving, or rebasing ADE lanes and lane worktrees through `ade lanes` and `ade git`.
---

# ADE lanes and git

## Lanes

Lanes are ADE-managed git worktrees and branches.

```bash
ade lanes list --text
ade lanes show <lane> --text
ade lanes create --name <name> --description "..." --text
ade lanes child --lane <parent> --name <name> --text
ade lanes archive <lane> --text
```

## ADE-aware Git

Use ADE git commands when the operation should update ADE operation state and refresh lane status:

```bash
ade git status --lane <lane> --text
ade git status --full --lane <lane> --text
ade git sync --lane <lane> --rebase --base main --text
ade git stage --lane <lane> <path>
ade git stage-all --lane <lane>
ade git commit --lane <lane> -m "message"
ade git push --lane <lane> --set-upstream --text
```

## Rebase and conflicts

```bash
ade git rebase --lane <lane> --ai --text
ade git conflict show --lane <lane> --text
ade git rebase continue --lane <lane> --text
```

For conflicts, inspect both sides and preserve intent from both branches. Do not blindly accept ours/theirs.

## Gotchas

- Use `--lane` for anything other than the active workspace.
- Use `ade diff changes --lane <lane> --text` when you need ADE's view of file changes.
- Do not archive or delete lanes unless the user asked for cleanup or the release workflow explicitly requires it.

