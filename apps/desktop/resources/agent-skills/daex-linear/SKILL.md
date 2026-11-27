---
name: daex-linear
description: "Any Linear issue task, also a chat or lane launched with one: read it or its comments, change its state, comment, assign, label, via `daex linear` (Daex's own connection, no API key). Not connected: `daex integrations connect linear`."
---

# Daex Linear

Daex was called ADE: the CLI is `daex`, and `ade …` still works the same (older transcripts and prompts use it).

## What you have

If Daex launched you on a Linear issue, that issue lives in **Daex's Linear
connection** and you can both **read and write** it through the `daex linear`
CLI. You do not hold a Linear token and you do not need one: every `daex linear`
command routes over the Daex daemon to the desktop runtime, which owns the Linear
credentials. The daemon does the authenticated Linear API call on your behalf.

You do **not** need to know how you were launched, what mode you are in, or how
the issue got attached. You have a task, an attached issue, and these commands.

If a `daex linear` command answers "Linear is not connected", do not ask for
an API key in chat. If the person asked for Linear, run
`daex integrations connect linear --reason "<what you will do>"`. It shows them
a connect card and returns when they connect or decline. If Linear was your
own idea, ask in words first. See "Connecting an integration" in
`daex-cli-control-plane`.

Prefer `daex linear` over any Linear MCP server or direct Linear API call — the
`daex linear` bridge is the connection that is actually configured for this
workspace, and it keeps the issue's Daex links and sync state consistent.

## Knowing which issue is yours

When Daex attaches an issue to your session it injects two environment variables:

- `ADE_LINEAR_ISSUE_IDS` — comma-separated identifiers of every attached issue,
  e.g. `ENG-431,ENG-440`. The first one is your primary issue.
- `ADE_LINEAR_CONTEXT_FILE` — absolute path to a JSON file describing the
  attached issues. Read it for title, state, URL, and team before you act.
- `ADE_CHAT_SESSION_ID` — your session id (used by the `--this-session` flag).

The context file looks like:

```json
{
  "sessionId": "...",
  "updatedAt": "2026-05-29T...",
  "issues": [
    {
      "id": "uuid",
      "identifier": "ENG-431",
      "title": "Fix Linear deeplink race",
      "url": "https://linear.app/...",
      "stateName": "Todo",
      "role": "primary",
      "teamKey": "ENG"
    }
  ]
}
```

If those vars are unset, no issue is attached — fall back to passing an explicit
identifier (e.g. `ENG-431`) to the read/write commands below, or check
`daex linear issues` for what your session has.

## Reading

The attached-issue commands default to your session's first attached issue when
you omit the id (precedence: `--issue-id <id>` flag → leading positional →
`$ADE_LINEAR_ISSUE_IDS`). So inside a tracked session you can drop the id.

```bash
daex linear issues --text                         # list issues attached to this session
daex linear issue --text                          # read your attached issue (full detail)
daex linear issue ENG-431 --text                  # read a specific issue
daex linear issue-comments --issue-id ENG-431 --text   # read an issue's comment thread
daex linear graphql --query 'query { viewer { id name } }'  # advanced Linear API via Daex credentials
daex linear graphql --query-file query.graphql --variables-file vars.json
```

Use `--text` for human-readable output; omit it for JSON when you want to parse.

## Updating (you have write access)

These move the issue forward through Daex's Linear connection — no API key. Each
takes an optional leading issue id; omit it to target your attached issue.

```bash
daex linear set-state ENG-431 <state-id>          # move workflow state (e.g. In Progress, Done)
daex linear comment "Pushed a fix, CI is running" # comment on your attached issue
daex linear comment ENG-431 "Done — see PR #123"  # comment on a specific issue
daex linear assign me                             # assign to the connected user
daex linear assign ENG-431 <user-id>              # assign to a specific user
daex linear assign none                           # clear the assignee (also: null / unassigned)
daex linear label ENG-431 "needs-review"          # add a label by name
```

Notes:
- `set-state` takes a state name (`"In Progress"`, matched within the issue's
  team) or a state id (`--state-id <id>`). `daex linear picker-data --text`
  lists the states and users.
- `comment`, `set-state`, `assign`, and `label` all accept the value via a flag
  too (`--message/-m`, `--state-id`, `--assignee`, `--label`) if a positional is
  ambiguous.
- Use `daex linear graphql` for Linear operations not covered by the typed
  commands. It still routes through Daex's saved Linear OAuth/API key; do not ask
  for or print token material.

## Filing follow-up issues and linking issues

File a follow-up when you find a real, separate problem that is outside the
scope of your issue. Do not file one for work you can finish inside your issue,
for style nits, or for guesses you did not check.

```bash
daex linear create --title "Share page leaks OG metadata" --description "…evidence, file:line…"
daex linear create --title "…" --blocked-by        # the new issue waits on your issue
daex linear create --title "…" --blocks            # your issue waits on the new one
daex linear create --title "…" --sub-issue         # a child of your issue
daex linear create --title "…" --standalone --team VER   # not linked to your issue
daex linear relate VER-12 --blocks VER-13          # link two existing issues
daex linear relate --related VER-40                 # link your issue to VER-40
daex linear inbox                                   # the connected user's unread Linear inbox
```

Rules:
- `create` links the new issue to your attached issue as `related` by default,
  in the same team and project. It refuses when an open issue in that team has
  a near-identical title and prints that issue; link to it with `relate`
  instead. Pass `--allow-duplicate` only when you checked it is different.
- File at most a few follow-ups per task. Put the evidence (what you saw, the
  file and line, how to reproduce) in `--description`.
- After filing, add one comment on your own issue that names the new issue.

## Daex deeplinks in Linear comments

Daex posts its own Linear attachments/cards for lane, chat, and PR flows. The
**daex-deeplinks** skill holds the matrix of which flow Daex covers automatically
and which one leaves the link to you, plus the `daex link ...` commands and the
HTTPS-vs-`ade://` guidance.

The short version for this skill's commands: the direct issue actions
(`comment`, `set-state`, `assign`, `label`, `graphql`) are the ones Daex does
*not* link for you, so include the relevant Daex link yourself in any user-facing
Linear comment — especially when the action creates new Linear state or hands
work to a human.

```bash
daex linear graphql --query-file create-issue.graphql --variables-file vars.json
daex linear comment NEW-123 "Created via Daex. Open in Daex: $(daex link linear-issue NEW-123 --no-clipboard)"
```

## Attaching / detaching this session

```bash
daex linear attach --this-session --issue-id ENG-431   # attach an issue to your session
daex linear detach --this-session --issue-id ENG-431   # detach one issue
daex linear detach --this-session                      # detach every issue from your session
```

Two commands outside the `daex linear` surface also attach an issue:
`daex chat attach-linear-issue <session> --issue-id <id>` and
`daex lanes link-linear-issue <lane> --linear-issue-json '{...}'`.

## What lands where

An `daex linear comment` is the issue's status channel — it is what reviewers and
the issue's watchers see, and it is visible to people who never open Daex. The
workflow state you set with `set-state` is what shows in the team's board.
Neither is inferred from your Daex activity; if you do not write them, the issue
does not move.

`set-state` takes a workflow state id, and the valid states are per-team, so
resolve the id with `daex linear picker-data --text` rather than assuming a
Done/In Review convention.

## Discovery

Run `daex help linear` for the full flag set, or `daex linear --help`. If `daex` is
not on PATH, see the **daex-cli-control-plane** skill for the fallback resolution
order (`$ADE_CLI_PATH`, `$ADE_CLI_BIN_DIR/ade`, or `node apps/ade-cli/dist/cli.cjs`).
