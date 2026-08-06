---
name: ade-search
description: Use this skill to search project-backed ADE chats across registered projects and search the active project's terminals, PRs, commits, branches, lanes, files, Linear issues, and proof artifacts via `ade search` instead of grepping .ade/ internals.
---

# ADE search

## What it is

`ade search` queries deterministic full-text indexes maintained by ADE. Chat
queries include project-backed chats from every project registered with the
machine brain. Other kinds — terminal/CLI scrollback, PRs, commits, branches,
lanes, workspace files, Linear issues, and proof artifacts — come from the
active project. Personal/no-project chats are intentionally excluded and stay
on the separate personal-chat surface.

This policy is identical for session-bound agents and unbound human shells;
search does not silently narrow chat hits to the caller's own session. It is
not a grep over `.ade/`: the runtime keeps each project index fresh and the
machine router combines bounded chat result pages. Each project contributes at
most its first 200 matches to one aggregate query; `resultsTruncated: true` (and
the text-mode `bounded:` line) means you should narrow the query rather than
assuming the tail was exhaustive. Every hit carries a deep
link back to the exact ADE surface.

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
`deepLink` is an `ade://…` URL you can hand to `ade open`. Machine-routed
results additionally carry `projectId`, `projectName`, and `projectRoot` so
same-named lanes and chats remain distinguishable.

## Output modes

- `--json` (default): the full `SearchQueryResult` — `results[]` (each with
  `kind`, `id`, `title`, `snippet`, `matchRanges`, `laneId`, `laneName`,
  `sessionId`, `deepLink`, `updatedAt`, and machine-routed project fields),
  `totalByKind`, `nextCursor`, and project coverage metadata. Use this when you
  need the deep link or want to page.
- `--text`: aligned `KIND  PROJECT  TITLE  SNIPPET  ID` rows when project
  metadata is present, then a
  `N results (chat 3, terminal 2, …)` summary from `totalByKind`, and a
  `more: --cursor <value>` line when another page exists. Use this for a quick
  human-readable scan.

Exit codes are script-friendly: `0` when the query matched at least one result,
`1` when it matched nothing (so `ade search "x" >/dev/null && …` works), and `2`
on a usage error such as an unknown `--kind`.

## When to use which

- **"Which chat discussed X?"** → `ade search "X" --kind chat --text`, then
  `ade open <deepLink>` or read a bounded window with
  `ade chat read <session> --limit 20 --max-chars 8000 --text`. Use
  `--page --cursor <nextCursor>` only when you need older content.
- **"Which terminal ran the failing command?"** →
  `ade search "<command or error>" --kind terminal --text`; the result offset
  drops you at the failure in scrollback.
- **"Find the PR discussing Y."** → `ade search "Y" --kind pr --text`.
- **"Where in this lane did we touch Z?"** →
  `ade search "Z" --lane <lane> --text` across files, commits, and chats.
- **Index looks stale or empty** → `ade search --status --text` to see
  `docCount`, per-kind counts, and `backfillComplete`; rebuild with
  `ade search --rebuild` only if backfill is genuinely broken.

Reach for `ade search` before grepping `.ade/` internals or asking the user to
locate something. Remember the boundary: chats span registered projects;
non-chat kinds use the active project; personal chats are excluded.
