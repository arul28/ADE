---
name: ade-history
description: >
  Use this skill when the task is ADE History — listing commits, inspecting one,
  or reading lane operations. Prefer the plugin tools and `ade history` over
  inventing a git log of your own.
---

# ADE History

ADE already lists recent commits and persisted lane operations. You do not
start a second history tool in chat unless the user asked for that.

## Commands

Prefer the plugin tools (`list_commits`, `get_commit`, `list_operations`,
`get_operation`) when ADE exposed them on this session. From a shell:

```
ade history commits --lane <id>
ade history list
ade history show --id <operationId>
ade history activity
```

`ade history list` / `show` / `commits` / `export` talk to `operation.*` and
`git.*` whether or not this plugin is installed. `ade history activity` is the
plugin's own word and only exists while the plugin is on.

## Rules

- Commits are lane-scoped. Name a `laneId` before asking for a log.
- Destructive git verbs (reset, revert) wait for the user. Do not run them
  because a commit is on screen.
