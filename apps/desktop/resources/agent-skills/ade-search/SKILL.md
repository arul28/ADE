---
name: ade-search
description: Use this skill when an agent needs to search across everything in ADE — chat transcripts, terminal scrollback, CLI sessions, PRs, commits, branches, lanes, files, Linear issues, proof artifacts — via the `ade search` CLI, instead of grepping .ade/ internals or asking the user where something is.
---

# ADE search

## What it is

`ade search` queries one deterministic full-text index that ADE maintains over
everything it knows about the project: chat transcripts, terminal/CLI-session
scrollback, PRs, commits, branches, lanes, workspace files, Linear issues, and
proof artifacts. It is not a grep over `.ade/` — the index is built and kept
fresh by the runtime, and query-time work is delegated to the same search
service the desktop command palette and TUI palette use. Every hit carries a
deep link back to the exact ADE surface.

Use it instead of poking at `.ade/ade.db`, replaying `git log`, or asking the
user "which chat was that in". It answers "where did this happen in ADE" across
kinds in one call.

## Command forms

```bash
ade search "<query>"                       # ranked results as JSON (default)
ade search "<query>" --text                # aligned rows + count summary
ade search "<query>" --kind chat,terminal  # restrict to kinds
ade search "<query>" --lane fix-login      # restrict to a lane (id or name)
ade search "<query>" --limit 20            # cap result count
ade search "<query>" --cursor <nextCursor> # next page from a prior query
ade search --status --text                 # index doc counts + backfill state
ade search --rebuild --text                # rebuild the index (CTO-only)
```

## Query syntax

The query string is passed through to the index. It supports:

| Form                | Meaning                          | Example                                    |
| ------------------- | -------------------------------- | ------------------------------------------ |
| bare terms          | AND-ed together                  | `ade search "retry backoff"`               |
| `"quoted phrase"`   | exact adjacent phrase            | `ade search '"connection refused"'`        |
| `kind:<kind>`       | restrict to a kind inline        | `ade search "kind:pr merge queue"`         |
| `lane:<name>`       | restrict to a lane inline        | `ade search "lane:fix-login timeout"`      |
| `session:<id>`      | restrict to one session          | `ade search "session:abc123 panic"`        |
| `since:<date>`      | recency floor (ISO date)         | `ade search "since:2026-06-01 crash"`      |

Inline `kind:` / `lane:` filters and the `--kind` / `--lane` flags can be mixed;
the flags are the scriptable form and validate their input.

Kind values: `lane`, `chat`, `terminal`, `pr`, `commit`, `branch`, `file`,
`linear`, `artifact`. `--kind` takes a comma-separated list and rejects unknown
kinds with a usage error (exit 2).

## Result kinds and where they deep-link

| kind       | deep-links to                                              |
| ---------- | --------------------------------------------------------- |
| `chat`     | the Work chat session, scrolled to the matching message   |
| `terminal` | the terminal/CLI session, at the matching scrollback offset |
| `pr`       | the PR detail tab                                         |
| `commit`   | the commit in the lane's history                          |
| `branch`   | the branch (find-or-offer-to-create lane)                 |
| `lane`     | the lane                                                  |
| `file`     | the workspace file                                        |
| `linear`   | the Linear pane for the issue                            |
| `artifact` | the proof/artifact in the proof drawer                    |

Each result also carries `laneId`/`laneName`, `sessionId`, and `updatedAt`; the
`deepLink` is an `ade://…` URL you can hand to `ade open`.

## Output modes

- `--json` (default): the full `SearchQueryResult` — `results[]` (each with
  `kind`, `id`, `title`, `snippet`, `matchRanges`, `laneId`, `laneName`,
  `sessionId`, `deepLink`, `updatedAt`), `totalByKind`, and `nextCursor`. Use
  this when you need the deep link or want to page.
- `--text`: aligned `KIND  TITLE  SNIPPET  ID` rows, then a
  `N results (chat 3, terminal 2, …)` summary from `totalByKind`, and a
  `more: --cursor <value>` line when another page exists. Use this for a quick
  human-readable scan.

Exit codes are script-friendly: `0` when the query matched at least one result,
`1` when it matched nothing (so `ade search "x" >/dev/null && …` works), and `2`
on a usage error such as an unknown `--kind`.

## When to use which

- **"Which chat discussed X?"** → `ade search "X" --kind chat --text`, then
  `ade open <deepLink>` (or read the session with `ade chat read`).
- **"Which terminal ran the failing command?"** →
  `ade search "<command or error>" --kind terminal --text`; the result offset
  drops you at the failure in scrollback.
- **"Find the PR discussing Y."** → `ade search "Y" --kind pr --text`.
- **"Where in this lane did we touch Z?"** →
  `ade search "Z" --lane <lane> --text` across files, commits, and chats.
- **Index looks stale or empty** → `ade search --status --text` to see
  `docCount`, per-kind counts, and `backfillComplete`; rebuild with
  `ade search --rebuild` (CTO-only) only if backfill is genuinely broken.

Reach for `ade search` before grepping `.ade/` internals or asking the user to
locate something — it is the one index that spans every ADE kind.
