---
name: ade-deeplinks
description: Use this skill when an agent needs to mint, share, or open ADE deeplinks (lane, branch, PR, Linear issue) so users — or the agent itself — can jump straight to a specific ADE surface from anywhere (GitHub PR description, Linear issue, Slack, email, terminal, mobile).
---

# ADE deeplinks

## What a deeplink is

ADE deeplinks are URLs that route directly to a specific ADE entity. Two forms,
identical semantics:

```
ade://lane/<uuid>                                # local-only — focuses an existing lane
ade://repo/<owner>/<repo>/branch/<branch>        # cross-machine — find or offer-to-create lane
ade://pr/<owner>/<repo>/<number>                 # PR detail view
ade://linear-issue/<ADE-123>[?branch=<branch>]   # Linear handoff — resolves via lane.linearIssue

https://ade.app/open?type=lane&id=<uuid>
https://ade.app/open?type=branch&repo=<owner/repo>&branch=<branch>[&pr=<n>]
https://ade.app/open?type=pr&repo=<owner/repo>&number=<n>
https://ade.app/open?type=linear-issue&issue=<ADE-123>[&branch=<branch>]
```

The HTTPS form is the share-friendly variant (it gets a Vercel-rendered
OpenGraph card in Slack/Discord/iMessage/Gmail/Linear). The web landing page
tries the `ade://` upgrade and falls back to an install card. Both forms parse
to the same target shape.

**Lane links are local** — the UUID is meaningful only on the machine that
created the lane. **Branch and Linear-issue links are portable** — they re-
resolve to whichever lane (if any) owns that branch / Linear identifier on the
receiving machine.

## When to use which form

| Need                                                          | Use                                  |
| ------------------------------------------------------------- | ------------------------------------ |
| Jump back to MY lane from another terminal on the same Mac    | `ade://lane/<uuid>`                  |
| Share a branch with a teammate or your other devices          | `https://ade.app/open?type=branch&…` |
| Drop into a PR's detail tab                                   | `https://ade.app/open?type=pr&…`     |
| Linear "Open in coding tool" hand-off (resolves to your lane) | `https://ade.app/open?type=linear-issue&…` |

## Minting a deeplink — `ade link`

```bash
ade link lane <lane-uuid>                                  # local lane link
ade link branch <owner/repo> <branch> [--pr <number>]      # cross-machine branch
ade link pr <owner/repo> <number>                          # PR detail
ade link linear-issue <ADE-123> [--branch <branch>]        # Linear hand-off
ade link <url>                                             # round-trip an existing link

# Flags
--ade            # emit ade:// instead of https:// (default: https)
--no-clipboard   # print without copying
```

Every form copies to the clipboard by default and prints the URL to stdout.
Use `--no-clipboard` in scripts.

## Opening a deeplink — `ade open`

```bash
ade open <url>                                             # any ade:// or https://ade.app/open URL
ade open --linear-issue <ADE-123> --branch <branch>        # Linear coding-tool entry point
```

The CLI hands the URL to the OS, which routes through the registered `ade://`
protocol back to a running ADE desktop window (or launches ADE cold). If the
focused window's project doesn't match the deeplink's repo, the cross-repo
banner appears with a "Switch to <project>" button.

## Wiring Linear hand-off — `ade linear install`

```bash
ade linear install               # writes ~/.linear/coding-tools.json
ade linear install --dry-run     # show what would be written
```

Adds an entry so Linear's "Open issue in coding tool" picker can launch ADE.
The template uses Linear's documented placeholders (`{{issue.identifier}}`,
`{{issue.branchName}}`) — Linear does NOT expose the GitHub repo, so the
desktop renderer resolves the lane locally by `lane.linearIssue.identifier`
match (falling back to a lanes-page filter on the branch hint).

## RPC for programmatic dispatch

For agents working through the ADE RPC layer, deeplinks dispatch via the
existing `app/navigate` method:

```jsonc
// JSON-RPC over the ADE socket (`ade serve` / desktop RPC port)
{ "method": "app/navigate", "params": {
    "target": { "kind": "lane", "laneId": "<uuid>" }
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
Use `ade open <url>` when you already have a stringified deeplink (e.g.
something a user pasted).

## Auto-attached deeplinks

ADE automatically appends an "Open in ADE" footer to PR descriptions it
creates or adopts (idempotent via an HTML marker), and pushes the same
cross-machine link to any Linear issue linked to the lane (Linear attachment
+ one-time comment). Agents do not need to call `ade link` for those flows —
they fire on PR creation / Linear-link events.

Agents should still include a user-facing ADE PR link when handing off a newly
created or adopted PR. Use the GitHub PR URL for the browser link and the
`adeUrl` printed by `ade prs create`. If the PR came from another path, mint
the ADE link with:

```bash
ade link pr <owner/repo> <number> --no-clipboard
```

for the ADE link. Prefer the default HTTPS form in chat and terminal output
because it is clickable, shareable, and upgrades into the ADE PRs tab.

When you copy a deeplink from a lane context menu in the desktop UI, the
right-click menu offers: Copy lane link, Copy branch link (cross-machine),
Copy PR link, Copy Linear-issue link.

## What deeplinks NEVER do silently

- Clone a repository you don't have — the user always confirms via the
  inbound modal that reuses the PRs-tab "Create lane from PR branch"
  preflight (with its existing safety blocks).
- Mutate state for pure navigation — opening an existing lane is silent;
  creating one is not.
- Trust the URL params blindly — the parser rejects bad UUIDs, traversal
  segments, malformed Linear identifiers, and non-https hosts on the mirror
  form.

## Quick command palette for the CTO

```bash
# Mint links the user can paste anywhere
ade link branch anthropics/claude-code feat-deeplinks               # share with teammates
ade link pr anthropics/claude-code 1234                             # PR detail
ade link linear-issue ADE-512 --branch arul/ade-512-feat            # Linear hand-off
ade link lane "$(ade lanes list --text | head -2 | tail -1 | awk '{print $1}')"  # current lane

# Open a link locally (any of these reach a running ADE)
ade open ade://lane/<uuid>
ade open "https://ade.app/open?type=branch&repo=a/b&branch=feat"
ade open --linear-issue ADE-123 --branch feat-x

# One-time setup so Linear's "Open in coding tool" calls into ADE
ade linear install
```
