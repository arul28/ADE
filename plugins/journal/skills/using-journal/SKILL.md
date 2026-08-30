---
name: using-journal
description: Log what you finished, what you are doing, and what blocked you into the user's work journal. Use when you complete a unit of work, hit a blocker you cannot get past, or are asked what has been worked on today or this week — the journal is what the user's standup is written from, so work you never logged is work their standup never mentions.
---

# The user's work journal

The user keeps a one-line journal of what they are working on, tagged by lane.
Their standup is generated from it. Two tools reach it:

- `plugin__journal__add_note` — `{text, kind?, laneId?}`. `kind` is `done`,
  `blocked` or `note` (the default).
- `plugin__journal__list_notes` — `{range?}`, where `range` is `today` (the
  default), `week` or `all`.

## When to add a note

Add one when something crosses a line the user would mention out loud:

- **You finished a unit of work** — a fix landed, a migration ran, tests went
  green. `kind: "done"`.
- **You are blocked and stopping** — a credential you do not have, a decision
  only they can make, a service that is down. `kind: "blocked"`.
- **They asked you to note it** — "log that", "put that in my journal".

Do not log every tool call, every file you read, or your own progress within a
task. A journal with forty rows in it is a journal nobody reads, and the
standup written from it says nothing. One line per thing they would tell a
teammate.

## How to write the line

Write what a person would say, in the past tense, without ceremony:

- good: `fixed the login redirect loop`
- good: `blocked on the Stripe test key — need it from ops`
- bad: `Completed the task as requested.`
- bad: `Read 4 files and edited src/auth/session.ts`

Keep it under about 120 characters. It is a standup bullet, not a summary.

## Lanes

Omit `laneId` and the note is untagged, which is fine. Pass it when you know
it — ADE's lane actions give you the id, and a tagged note lets the user filter
their journal down to one piece of work.

## Reading

Use `list_notes` before writing any summary of what has been done — a report
built from what you happen to remember of this conversation will miss the work
done in every other one.
