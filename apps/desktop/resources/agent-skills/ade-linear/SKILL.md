---
name: ade-linear
description: Use this skill whenever your task is a Linear issue (or an ADE chat/lane launched with a Linear issue attached) and you need to read or update that issue — change its workflow state, comment progress, assign it, add a label, or read its comments. ADE routes all of this through its own Linear connection via the `ade linear` CLI, so you have effective Linear write access with no API key.
---

# ADE Linear

## What you have

If ADE launched you on a Linear issue, that issue lives in **ADE's Linear
connection** and you can both **read and write** it through the `ade linear`
CLI. You do not hold a Linear token and you do not need one: every `ade linear`
command routes over the ADE daemon to the desktop runtime, which owns the Linear
credentials. The daemon does the authenticated Linear API call on your behalf.

You do **not** need to know how you were launched, what mode you are in, or how
the issue got attached. You have a task, an attached issue, and these commands.

Prefer `ade linear` over any Linear MCP server or direct Linear API call — the
`ade linear` bridge is the connection that is actually configured for this
workspace, and it keeps the issue's ADE links and sync state consistent.

## Knowing which issue is yours

When ADE attaches an issue to your session it injects two environment variables:

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
`ade linear issues` for what your session has.

## Reading

The attached-issue commands default to your session's first attached issue when
you omit the id (precedence: `--issue-id <id>` flag → leading positional →
`$ADE_LINEAR_ISSUE_IDS`). So inside a tracked session you can drop the id.

```bash
ade linear issues --text                         # list issues attached to this session
ade linear issue --text                          # read your attached issue (full detail)
ade linear issue ENG-431 --text                  # read a specific issue
ade linear issue-comments --issue-id ENG-431 --text   # read an issue's comment thread
ade linear graphql --query 'query { viewer { id name } }'  # advanced Linear API via ADE credentials
ade linear graphql --query-file query.graphql --variables-file vars.json
```

Use `--text` for human-readable output; omit it for JSON when you want to parse.

## Updating (you have write access)

These move the issue forward through ADE's Linear connection — no API key. Each
takes an optional leading issue id; omit it to target your attached issue.

```bash
ade linear set-state ENG-431 <state-id>          # move workflow state (e.g. In Progress, Done)
ade linear comment "Pushed a fix, CI is running" # comment on your attached issue
ade linear comment ENG-431 "Done — see PR #123"  # comment on a specific issue
ade linear assign me                             # assign to the connected user
ade linear assign ENG-431 <user-id>              # assign to a specific user
ade linear assign none                           # clear the assignee (also: null / unassigned)
ade linear label ENG-431 "needs-review"          # add a label by name
```

Notes:
- `set-state` takes a **workflow state id**, not a free-text name. To discover
  the valid states/ids (and users) for the issue picker, run
  `ade linear picker-data --text` (you may need to prefix `--role cto`:
  `ade --role cto linear picker-data --text`). The state id can also be passed
  via `--state-id <id>`.
- `comment`, `set-state`, `assign`, and `label` all accept the value via a flag
  too (`--message/-m`, `--state-id`, `--assignee`, `--label`) if a positional is
  ambiguous.
- Use `ade linear graphql` for Linear operations not covered by the typed
  commands. It still routes through ADE's saved Linear OAuth/API key; do not ask
  for or print token material.

## ADE deeplinks in Linear comments

ADE posts deterministic Linear attachments/cards for these flows when the
runtime owns the Linear connection:

| Flow | ADE handles it |
| --- | --- |
| Create a lane from a Linear issue | Lane attachment + one-time ADE branch comment |
| Attach a Linear issue to an existing lane | Lane attachment + one-time ADE branch comment |
| Create or attach a chat/CLI session with a Linear issue | ADE chat attachment |
| Open/create a PR from a linked lane | ADE PR attachment/footer |

For direct issue actions (`comment`, `set-state`, `assign`, `label`, `graphql`)
include the relevant ADE link in any user-facing Linear comment you write,
especially when the action creates new Linear state or hands work to a human.
Use the **ade-deeplinks** skill to mint links:

```bash
ade link linear-issue ENG-431 --no-clipboard
ade link branch <owner/repo> <branch> --no-clipboard
ade link session "$ADE_CHAT_SESSION_ID" --lane <lane-id> --no-clipboard
ade link pr <owner/repo> <number> --no-clipboard
```

Example when creating a new Linear issue via GraphQL:

```bash
ade linear graphql --query-file create-issue.graphql --variables-file vars.json
ade linear comment NEW-123 "Created via ADE. Open in ADE: $(ade link linear-issue NEW-123 --no-clipboard)"
```

## Attaching / detaching this session

```bash
ade linear attach --this-session --issue-id ENG-431   # attach an issue to your session
ade linear detach --this-session --issue-id ENG-431   # detach one issue
ade linear detach --this-session                      # detach every issue from your session
```

## Recommended workflow

1. When you start real work on the issue, move it to **In Progress**
   (`ade linear set-state <state-id>`), so watchers see it's being worked.
2. As you make progress, **comment** what you did and link the PR
   (`ade linear comment "..."`). Include ADE branch/session/PR links when a card
   was not already posted automatically. That comment is how reviewers and the
   issue's watchers see status — report what you actually did, not what you
   intend to do.
3. When you finish, set the **appropriate final state** (e.g. Done / In Review).
   Defer the exact final-state policy to the user's workflow — if you're unsure
   whether to mark Done vs. In Review, comment your result and ask rather than
   guessing.

## Discovery

Run `ade help linear` for the full flag set, or `ade linear --help`. If `ade` is
not on PATH, see the **ade-cli-control-plane** skill for the fallback resolution
order (`$ADE_CLI_PATH`, `$ADE_CLI_BIN_DIR/ade`, or `node apps/ade-cli/dist/cli.cjs`).
