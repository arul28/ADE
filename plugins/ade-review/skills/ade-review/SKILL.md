---
name: ade-review
description: >
  Use this skill when the task is an ADE AI review — listing runs, starting a
  review of a lane or PR, reading findings, or recording feedback. Prefer the
  plugin tools and `ade review` over inventing a review of your own.
---

# ADE Review

ADE already runs a read-only AI review of a lane, a commit range, uncommitted
changes, or a pull request. You do not start a second reviewer in chat unless
the user asked for that.

## Commands

Prefer the plugin tools (`list_runs`, `start_run`, `get_run`, `record_feedback`)
when ADE exposed them on this session. From a shell:

```
ade review runs
ade review launch --laneId <id> --targetMode lane_diff
ade review learnings
```

`ade actions run review.listRuns` still works: the engine stays in ADE. The
plugin is the UI and the catalog, not a second brain.

## Rules

- The review agent is read-only. Do not treat a finding as an instruction to
  edit until the user asks you to act on it.
- Findings stay local unless the launch set `publishBehavior` to `auto_publish`.
- Feedback kinds are `acknowledge`, `dismiss`, `snooze`, and `suppress`.
