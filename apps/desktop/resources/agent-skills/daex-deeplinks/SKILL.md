---
name: daex-deeplinks
description: "Make, share or open Daex deeplinks (lane, chat or CLI session, file, commit, artifact, branch, PR, Linear issue) to paste in GitHub, Linear, Slack, email, a terminal or the phone (`daex link`)."
---

# Daex deeplinks

Daex was called ADE: the CLI is `daex`, and `ade …` still works the same (older transcripts and prompts use it).

## What a deeplink is

Daex deeplinks are URLs that route directly to a specific Daex entity. Two forms,
identical semantics:

```
ade://lane/<uuid>                                # local-only — focuses an existing lane
ade://session/<id>[?lane=<lane-uuid>&event=<n>&offset=<bytes>]  # a chat or CLI session + anchors
ade://file/<repo-relative-path>[?line=<n>&lane=<lane-uuid>]      # Files tab
ade://commit/<sha>[?lane=<lane-uuid>]            # Lanes git detail, or GitHub fallback with envelope
ade://artifact/<artifact-id>                     # local proof/history artifact
ade://repo/<owner>/<repo>/branch/<branch>        # cross-machine — find or offer-to-create lane
ade://pr/<owner>/<repo>/<number>                 # PR detail view
ade://linear-issue/<ADE-123>[?branch=<branch>]   # Linear handoff — opens the Linear pane

https://ade-app.dev/open?type=lane&id=<uuid>
https://ade-app.dev/open?type=session&id=<id>[&lane=<lane-uuid>]
https://ade-app.dev/open?type=file&path=<path>[&line=<n>&lane=<lane-uuid>]
https://ade-app.dev/open?type=commit&sha=<sha>[&lane=<lane-uuid>]
https://ade-app.dev/open?type=artifact&id=<artifact-id>
https://ade-app.dev/open?type=branch&repo=<owner/repo>&branch=<branch>[&pr=<n>]
https://ade-app.dev/open?type=pr&repo=<owner/repo>&number=<n>
https://ade-app.dev/open?type=linear-issue&issue=<ADE-123>[&branch=<branch>]
```

The HTTPS form is the share-friendly variant (it gets a Vercel-rendered
OpenGraph card in Slack/Discord/iMessage/Gmail/Linear). The web landing page
tries the `ade://` upgrade and falls back to an install card. Both forms parse
to the same target shape.

**Lane, session, commit, and artifact ids are local** — the UUID/id is
meaningful only on the machine that created it. Daex can attach an envelope to
local links as query params:

```
repo=<owner>/<repo>&branch=<branch>&pr=<number>&linear=<ADE-123>
```

The envelope does not change the primary target; it gives receivers a portable
fallback chain. If the local id is unknown, Daex can offer to switch to the
matching project, create/open the branch or PR, open the Linear issue, or open a
commit on GitHub. **Branch links are portable** — they fetch/import the remote
branch as a lane if the receiver does not have it yet. **Linear-issue links are
portable** — they open Daex's Linear pane for the issue and show setup if the
active project has not connected Linear.

## Settings and pages in a chat reply

When the user asks where something is in Daex ("how do I manage my
providers?"), run `daex settings find <words>` and put the link it prints in
your reply:

```
ade://settings/<entry-id>     # one card in Settings; the chat shows it as a chip
ade://open/<page>             # a Daex page (prs, lanes, history, connections…)
```

- The chip's label comes from Daex's own settings list, not from your text,
  and a click opens the card; a page for one computer opens on the chat's
  machine.
- `ade://open/...` works only when the user clicks it in a chat; Daex ignores
  it from anywhere else.
- `find` marks settings only the user can change (publishing, sign-ins,
  money, the computer itself, preferences). Daex refuses an agent's change to
  them. Say that the user changes it, and give the link.

## When to use which form

| Need                                                          | Use                                  |
| ------------------------------------------------------------- | ------------------------------------ |
| Jump back to MY lane from another terminal on the same Mac    | `ade://lane/<uuid>`                  |
| Jump back to a chat on this Mac                                | `ade://session/<id>`                 |
| Jump to a chat event or terminal scrollback byte offset       | `ade://session/<id>?event=<n>` / `?offset=<bytes>` |
| Open a file and reveal a line                                 | `ade://file/src/app.ts?line=42`      |
| Open a commit from a local lane or GitHub fallback            | `ade://commit/<sha>?lane=<uuid>&repo=owner/repo` |
| Open a local proof artifact/history entry                     | `ade://artifact/<artifact-id>`       |
| Share a branch with a teammate or your other devices          | `https://ade-app.dev/open?type=branch&…` |
| Drop into a PR's detail tab                                   | `https://ade-app.dev/open?type=pr&…`     |
| Linear "Open in coding tool" hand-off (opens Linear pane)     | `https://ade-app.dev/open?type=linear-issue&…` |

## Minting a deeplink — `daex link`

```bash
daex link lane <lane-uuid>                                  # local lane link
daex link session <session-id> [--lane <lane-uuid>]          # local chat or CLI session link
daex link file <path> [--line N] [--lane <lane-uuid>]        # file link
daex link commit <sha> [--lane <lane-uuid>]                  # commit link
daex link artifact <id>                                      # proof/history artifact
daex link branch <owner/repo> <branch> [--pr <number>]      # cross-machine branch
daex link pr <owner/repo> <number>                          # PR detail
daex link linear-issue <ADE-123> [--branch <branch>]        # Linear hand-off
daex link <url>                                             # round-trip an existing link

# Flags
--ade            # emit ade:// instead of https:// (default: https)
--no-envelope    # skip best-effort repo/branch/PR envelope lookup
--web            # emit the hosted web client URL (https://app.ade-app.dev/...)
--no-clipboard   # print without copying
```

Every form copies to the clipboard by default and prints the URL to stdout.
When a live Daex runtime is bound, `daex link lane`, `session --lane`, and
`commit --lane` attach repo/branch/PR envelope params best-effort. Use
`--no-envelope` to skip that lookup and `--no-clipboard` in scripts.

Concrete examples:

```bash
daex link file apps/desktop/src/shared/deeplinks.ts --line 12 --ade --no-clipboard
daex link commit abc1234 --lane 550e8400-e29b-41d4-a716-446655440000 --no-clipboard
```

## Pairing a browser — `daex sync web`

Run `daex sync web --text` on, or pointed at, a Daex machine to print the
web-client pairing link and 6-digit code. Open the link in any browser, enter
the code, and the Daex web client (Work, Lanes, Files, PRs) pairs to that
machine — the browser analogue of scanning the phone pairing QR.

Use `--open` to launch the pairing link in the default browser. Human output
copies the link by default; add `--no-clipboard` for scripts. The same link
from desktop Settings > Sync > Web client or the iOS "Pair a browser" screen
does the same thing.

## Opening a deeplink — `daex open`

```bash
daex open <url>                                             # any ade:// or https://ade-app.dev/open URL
daex open --linear-issue <ADE-123> --branch <branch>        # Linear coding-tool entry point
```

The CLI hands the URL to the OS, which routes through the registered `ade://`
protocol back to a running Daex desktop window (or launches Daex cold). If the
focused window's project doesn't match the deeplink's repo, the cross-repo
banner appears with a "Switch to <project>" button.

## Wiring Linear hand-off — `daex linear install`

```bash
daex linear install               # writes ~/.linear/coding-tools.json
daex linear install --dry-run     # show what would be written
```

Adds an entry so Linear's "Open issue in coding tool" picker can launch Daex.
The template uses Linear's documented placeholders (`{{issue.identifier}}`,
`{{issue.branchName}}`) — Linear does NOT expose the GitHub repo, so the
desktop renderer opens the active project's Linear pane to the issue. If the
project is not connected to Linear yet, Daex shows a setup modal that routes to
Settings > Integrations > Linear.

## RPC for programmatic dispatch

For agents working through the Daex RPC layer, deeplinks dispatch via the
existing `app/navigate` method:

```jsonc
// JSON-RPC over the Daex socket (`daex serve` / desktop RPC port)
{ "method": "app/navigate", "params": {
    "target": { "kind": "lane", "laneId": "<uuid>" }
}}
{ "method": "app/navigate", "params": {
    "target": { "kind": "work", "sessionId": "<session-id>", "laneId": "<uuid>" }
}}
{ "method": "app/navigate", "params": {
    "target": { "kind": "file", "path": "src/app.ts", "line": 42, "laneId": "<uuid>" }
}}
{ "method": "app/navigate", "params": {
    "target": { "kind": "commit", "sha": "<sha>", "laneId": "<uuid>", "envelope": { "repoOwner": "anthropics", "repoName": "claude-code", "branch": "feat-x" } }
}}
{ "method": "app/navigate", "params": {
    "target": { "kind": "artifact", "artifactId": "<artifact-id>" }
}}
{ "method": "app/navigate", "params": {
    "target": { "kind": "branch", "repoOwner": "anthropics", "repoName": "claude-code", "branch": "feat-x" }
}}
{ "method": "app/navigate", "params": {
    "target": { "kind": "pr", "repoOwner": "anthropics", "repoName": "claude-code", "prNumber": 1234 }
}}
{ "method": "app/navigate", "params": {
    "target": { "kind": "linear-issue", "issueIdentifier": "ADE-123", "branch": "arul/ade-123-feat" }
}}
```

Use `app/navigate` (not `deeplinks.open`) when you have structured fields.
Use `daex open <url>` when you already have a stringified deeplink (e.g.
something a user pasted).

## Auto-attached deeplinks

Daex automatically appends an "Open in Daex" footer to PR descriptions it
creates or adopts (idempotent via an HTML marker), and pushes Daex lane/chat
links with repo envelopes to any Linear issue linked to the lane (Linear
attachment + one-time comment). Agents do not need to call `daex link` for
those flows — they fire on PR creation / Linear-link events.

Linear card/comment matrix:

| Linear-related action | Who adds the Daex link |
| --- | --- |
| `daex lanes create --linear-issue-json` | Daex posts the lane attachment/comment |
| `daex lanes link-linear-issue` / `daex chat attach-linear-issue` / `daex linear attach --this-session` | Daex posts lane/chat attachments when a lane/session is known |
| `daex chat create --from-linear-issue` or `daex lanes create --start-chat` | Daex posts the chat attachment after the issue is attached |
| `daex prs create` on a linked lane | Daex posts the PR attachment/footer |
| `daex linear comment`, `set-state`, `assign`, `label`, or `graphql` | The agent should include the relevant Daex link in any Linear comment it writes |

If you create new Linear state directly (for example with `daex linear graphql`),
mint the Linear-pane link yourself and comment it back to the issue:

```bash
daex link linear-issue ADE-123 --no-clipboard
daex linear comment ADE-123 "Created via Daex. Open in Daex: <paste link>"
```

### PR closeout links

When handing off a newly created or adopted PR, include both links: the GitHub
PR URL (`githubUrl` / `html_url`) and the Daex PR link. `daex prs create` prints
the Daex link as `adeUrl`; for a PR that came from another path, mint it:

```bash
daex link pr <owner/repo> <number> --no-clipboard
```

Prefer the default HTTPS form in chat, PR comments, and terminal output: it is
clickable and shareable, and on a machine with Daex installed it upgrades into
`ade://pr/<owner>/<repo>/<number>` and lands in the PRs tab. The PR body also
gets the automatic "Open in Daex" footer, but that footer is not a substitute for
the links in your final message.

When you copy a deeplink from the desktop UI, the lane right-click menu offers
Copy lane link, Copy branch link (cross-machine), Copy PR link, and Copy
Linear-issue link. A chat's context menu also offers Copy session deep
link for returning to the selected terminal/chat session on the same desktop.

## What deeplinks NEVER do silently

- Clone a repository you don't have — the user always confirms via the
  inbound modal that reuses the PRs-tab "Create lane from PR branch"
  preflight (with its existing safety blocks).
- Mutate state for pure navigation — opening an existing lane is silent;
  creating one is not.
- Trust the URL params blindly — the parser rejects bad UUIDs, traversal
  segments, malformed Linear identifiers, and non-https hosts on the mirror
  form.

## Quick command palette

```bash
# Mint links the user can paste anywhere
daex link branch anthropics/claude-code feat-deeplinks               # share with teammates
daex link pr anthropics/claude-code 1234                             # PR detail
daex link linear-issue ADE-512 --branch arul/ade-512-feat            # Linear hand-off
daex link file apps/desktop/src/shared/deeplinks.ts --line 12         # source location
daex link commit abc1234 --lane <lane-uuid>                           # commit detail
daex link artifact proof-123                                          # proof/history artifact
daex link session <session-id> --lane <lane-uuid>                    # chat or CLI session
daex link lane "$(daex lanes list --text | head -2 | tail -1 | awk '{print $1}')"  # current lane

# Open a link locally (any of these reach a running Daex)
daex open ade://lane/<uuid>
daex open ade://session/<session-id>
daex open "https://ade-app.dev/open?type=branch&repo=a/b&branch=feat"
daex open --linear-issue ADE-123 --branch feat-x

# One-time setup so Linear's "Open in coding tool" calls into Daex
daex linear install
```
