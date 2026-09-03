---
name: ade-cursor-cloud
description: Launch, watch, stop and adopt Cursor Cloud agents from inside ADE. Use when the user asks to run something on Cursor Cloud, asks what their cloud agents are doing, wants a finished cloud run's branch pulled into a lane, or mentions "background agent", "cloud agent" or "cursor.com/agents".
---

# Cursor Cloud, from inside ADE

A Cursor Cloud agent clones a lane's branch, works on it on Cursor's machines,
and pushes back. You reach them through four tools; there is no shell command
for this and no reason to write one.

## The tools

| Tool | Use it for |
|---|---|
| `list_agents` | What is running, what finished, what failed. Takes `includeArchived` and `limit`. |
| `launch_agent` | Start one. Takes `prompt` (required), `laneId`, `model`, `openPr`. |
| `stop_agent` | Cancel a run. Takes `agentId`. |
| `pull_into_lane` | Fetch a finished agent's branch into its lane. Takes `agentId`. |

## Before you launch one

**Check the lane.** A cloud agent works on ONE lane's branch, and it is the
branch as it exists on the remote — not the working tree. Uncommitted work on
this machine is invisible to it. If the user has changes they want the agent to
build on, say so and let them push first; a cloud run against a stale branch
produces a diff that will not apply.

**Write the prompt as a whole task.** The agent gets one message and then works
alone until it finishes. It cannot ask a clarifying question, and there is no
way to steer it mid-run except by stopping it. A prompt that would need a
follow-up in an interactive chat needs to be a paragraph here.

**`openPr` is creation-time only.** Cursor cannot add a pull request to a run
that is already going. If the user wants one, pass it now. If the lane's branch
already HAS an open pull request, the agent attaches to that one and `openPr` is
ignored — that is correct, not a bug to work around.

**The launch pushes the lane's branch for you.** You do not need to push first.
What you cannot fix from here is a branch that has *diverged* from origin: the
launch refuses it and says to pull or rebase in the lane. Do that, then launch.

## What to do while it runs

Do not poll `list_agents` in a loop. A cloud run takes minutes to tens of
minutes, and ADE already watches it: the agent's chat updates itself while it is
on screen, and a webhook wakes it when it finishes. Tell the user it is running,
say where to watch it, and move on to something else.

If the user asks again later, `list_agents` once is the right answer.

## When it finishes

`pull_into_lane` fetches the branch into the lane worktree and attaches it to
the chat, which is what makes the ordinary branch, diff and PR affordances work.
Do that before reviewing the diff — reading a branch that has not been fetched
gets you nothing.

A run can finish having pushed **no** branch. That is not a failure to
investigate with more tool calls; it means the agent decided no change was
needed, and the run's own transcript says why. Open the agent in ADE and read
it.

## When it fails

`ERROR` is Cursor's own failure, not ADE's. Do not retry it automatically — the
same prompt against the same branch usually fails the same way, and a retry loop
spends the user's Cursor budget. Report what failed and ask.

## What this is not

Cursor Cloud is not a faster local agent. It is a second machine, with its own
clone, its own environment and its own credentials. Anything that depends on
this computer — a local database, an unpushed branch, a file outside the
repository, a secret in the user's shell — is not there. If the task needs any
of that, do it locally instead and say why.
