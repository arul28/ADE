# Issues: opening an issue where you are

Clicking an issue anywhere in DAEX shows the issue itself, rendered natively,
without leaving the page. Linear, GitHub and Jira issues are editable in place
(properties through pickers, title and description inline, comments in the
thread). Each tracker has a top-bar pane; new issues start in one composer for
all three; lanes and agents start from any of them through one launcher. The
CLI is `daex` (`ade` still works). Linear keys such as `ADE-123` are the
team's own keys, not product names.

## Source file map

Shared and routing:

- `apps/desktop/src/shared/issueRefs.ts` — `IssueRef`, `issueRefKey`,
  `issueRefFromUrl` (reuses the smart-link classifier, so a chip and the viewer
  never disagree), `proseIssueKeyPattern`, `linearIssueLinkTarget`.
- `apps/desktop/src/renderer/lib/issueNavigation.ts` — `openIssueRef` (tools pane
  when an in-place host is registered, else the sheet), `openIssueInSheet`.
- `apps/desktop/src/renderer/lib/openExternal.ts` — `openLinkFromUi` checks for
  an issue link first, so every link routes through the viewer.
- `apps/desktop/src/shared/threadEntities.ts` — prose issue chips.
- `apps/desktop/src/shared/types/issueTrackers.ts` — the tracker-neutral contract;
  Jira types and helpers in `shared/types/jira.ts`, `jiraAdf.ts`,
  `jiraErrors.ts`, `laneJiraIssue.ts`, `jiraIssueBranch.ts`.

Main and runtime:

- `apps/desktop/src/main/services/issueTrackers/` — `issueTrackerService.ts`
  (resolve a reference to a tracker; `list`, `get`, `comment`, `update`,
  `setState`, `create`, …), `adapters.ts` (one per tracker),
  `issueTrackerError.ts` (`[issues:<reason>]`). Used by the `issues` action domain
  and `daex issue`.
- `apps/desktop/src/main/services/jira/` — `jiraService.ts`, `jiraClient.ts`
  (REST v3), `jiraCredentialService.ts`.
- `apps/desktop/src/main/services/github/githubIssueOps.ts` — every GitHub issue
  operation, shared by the desktop service and the headless runtime
  (`apps/ade-cli/src/headlessLinearServices.ts`); list query in
  `shared/githubIssueList.ts`; templates in `shared/githubIssueTemplates.ts`.
- `apps/desktop/src/shared/linearIssueCreateInput.ts` — the one Linear create
  parser.
- `apps/desktop/src/main/services/chat/agentChatService.ts` —
  `refreshLinkedIssueSnapshots`, `recordJiraIssueContextForLane`;
  `prs/prService.ts` — `applyJiraPrLinkage`.
- `apps/desktop/src/main/services/adeActions/actionPolicy.ts` — the `jira` and
  `issues` domains.
- Account server: `apps/account-directory/src/cloud/integrations.ts`; client
  `apps/desktop/src/shared/adeCloud/integrationReads.ts`,
  `shared/linearIssueNormalize.ts`, `shared/jiraIssueMapping.ts`.
- CLI: `apps/ade-cli/src/cliIssue.ts`, `cliJira.ts`, `cliGithubIssue.ts`,
  `issueCliFields.ts`.
- Test server: `apps/desktop/scripts/fake-jira-server.mjs`.

Renderer (`apps/desktop/src/renderer/components/issues/`):

- `IssueViewer.tsx` (picks the tracker's viewer), `LinearIssueViewer.tsx` /
  `LinearIssueView.tsx`, `GitHubIssueViewer.tsx` / `GitHubIssueView.tsx`,
  `JiraIssueViewer.tsx` / `JiraIssueView.tsx`; shared parts in
  `issueViewerParts.tsx`, `issueEditing.tsx`, `issueMarkdown.tsx`,
  `IssuePickerMenu.tsx`, `issuePickerChip.tsx`, `issueViewer.css`.
- Caches: `issueEntryCache.ts` (one read in flight, freshness, LRU, newest edit
  wins), `linearIssueStore.ts`, `githubIssueStore.ts`, `jiraIssueStore.ts`.
- `IssuesToolPanel.tsx` + `issueTabsStore.ts` — the Work Issues tool;
  `IssueSheetHost.tsx` — the sheet (mounted once in `AppShell`).
- Panes and buttons: `GitHubIssuesPane.tsx`, `JiraIssuesPane.tsx` and their
  buttons; `app/LinearQuickViewButton.tsx`; `issueTopBarPreferences.ts`.
- Create: `IssueCreateDialog.tsx`, `IssueCreateHost.tsx`, `issueCreateDraft.ts`,
  `issueCreateChips.tsx`, `GitHubIssueFormFields.tsx`, `useSimilarIssues.tsx`,
  `issueCreateSubmit.ts`; requests in `renderer/lib/issueCreateRequests.ts`.
- Launch: `app/IssueLaunchHost.tsx`, `app/BatchLaunchModal.tsx`,
  `renderer/lib/issueLaunchRequests.ts`, `linearBatchLaunch.ts`
  (`LaunchIssue`, builders, `BATCH_LAUNCH_CONCURRENCY`).
- `renderer/lib/issueDrag.ts` — dragging an issue chip onto the composer.

## Gotchas

- **The in-place host is registered by `TerminalsPage` only while it is the
  active page** (pages stay warm behind others).
- **The Work page reveals, the panel drains**: the page only switches the pane;
  `IssuesToolPanel` takes the held request. The page must not clear the hold.
- **One launch dialog**: every launch goes to `IssueLaunchHost`. A cancel returns
  to the Linear pane only for a launch that came from it (`returnToLinearPane`).
- The GitHub and Linear sheets close when a launch starts; the Jira sheet does
  not.
- **Comments over the runtime** take the issue id as a scalar (`{ arg }` in
  preload); `{ args }` breaks every runtime comment read.
- Failures say what fixes them (no project, not connected, not returned, request
  error).

Not supported yet: the full create form on iOS ("+" opens GitHub's page), Jira on
iOS. The DAEX GitHub App itself needs `Issues: write` and the `issues` event in
its GitHub settings; DAEX only detects and explains the grant.

## The rule: open it where you are

| Where | What opens |
|---|---|
| The Work page (chat, composer, session card, PR tool, a `daex://linear-issue` chip) | The **Issues** tab in the Work tools pane |
| Any other page, the command palette, an outside `daex://` (or `ade://`) link | The **issue sheet** (right side, 760 px) |
| Top-bar Linear / GitHub Issues / Jira button | That tracker's pane |

Every container reads one issue by identifier (Linear's `issue(id:)` accepts
`ADE-123`). Mod+Click opens externally; Shift+Click opens the web page in DAEX's
browser. The properties box floats top-right, and moves under the title below
600 px.

## Plain `ADE-123` in agent replies

`threadEntities.ts` chips an uppercase key (letter, ≤9 letters/digits, hyphen,
number) in prose, never inside a path, branch or version, never in code. A key in
the project's bound Jira projects (`issueTrackers.jira.projectKeys`) is a Jira
chip; otherwise a Linear chip when it is one of the connected workspace's team
keys (`useLinearWorkspaceTeamKeys`: read at most hourly, kept in localStorage,
refreshed on `LINEAR_CONNECTION_CHANGED_EVENT`; keys from lanes' linked issues are
added).

PR text in DAEX's PR view links bare team keys the same way
(`prs/shared/prMarkdownAutolinks.ts`, DAEX's own `linear-issue` link, using
`useCachedLinearWorkspace` with no Linear request). A full `linear.app` link
opens in the viewer only for the connected workspace. iOS does not link bare
keys in PRs.

A plain `#123` stays a PR chip; clicking it on the tab's own machine asks GitHub
first, and an issue opens in the issue viewer (`chatDeeplinks.ts`).

## GitHub Issues

- **Reads.** One issue and its comments are REST GETs with ETags (unchanged =
  free 304). Lists use GraphQL's `issues` connection (`github.listRepoIssueList`;
  REST `/issues` mixes in PRs). Filters run on loaded rows. A list row is a
  partial copy; opening reads the whole issue, and edits wait for that read.
- **The button** shows when enabled, the origin is a GitHub repo with issues, and
  at least one is open (`github.getRepoIssueSummary`, cached, re-read at most every
  15 minutes). Nothing polls.
- **Editing.** Status, assignees, labels, milestone, title, description,
  comments; each edit is one optimistic PATCH (`github.updateIssue`) rolled back
  with a toast on refusal.
- **Credential.** Issue edits use the `issue-write` capability
  (`shared/githubOperationCredential.ts`): env token → DAEX GitHub App (only when
  its installation grants `Issues: write`, read from `GET /user/installations`,
  cached 15 minutes; `shared/github/githubAppGrant.ts`) → `gh` → PAT. With no
  writer, controls stay visible and say why; a banner offers "Review on GitHub"
  when the App lacks the permission.
- **Live updates.** `issues` / `issue_comment` webhooks emit
  `github-issue-changed`; open views re-read that issue; lists and the badge go
  stale.
- An `/issues/N` link that is a PR shows a note pointing to the PR tool.

## Jira

Settings → Integrations → Jira connects the project to one Jira Cloud site with
an Atlassian API token (`jira.siteUrl`, `jira.email`, `jira.apiToken` in
`<project>/.ade/secrets`). The connection follows the project to every computer
through the account vault (scope `repo:<host>/<owner>/<repo>`, kind
`integration`, key `jira`), DAEX Cloud included; a project with no remote keeps
it on that computer. The token is never logged or returned. The site must be
`https://` (plain `http://` only for loopback). The project binding is
`issueTrackers.jira.projectKeys` in `.ade/local.yaml`. `window.ade.jira` is
runtime-only; connecting and disconnecting are CTO-only.

The viewer edits title and Markdown description, transitions status through
Jira's workflow, and edits assignee, priority, labels and due date (issue type is
read-only). The pane filters by project, state, assignee and text with paging.
Create disables issue types with required fields the form cannot fill.

**Testing without a site**: `node apps/desktop/scripts/fake-jira-server.mjs
--port 4318`, then connect to `http://127.0.0.1:4318` with token `fake-token`
(`--rate-limit` answers 429).

**`daex jira`**: `status`, `connect` (CTO; `--token-stdin`), `disconnect` (CTO),
`projects`, `list`, `issue`, `create`, `edit`, `comment`, `transition`, `assign`,
`label`, `unlabel` (JSON by default, `--text` for a receipt).

## With no computer: reads through the account

A DAEX Cloud tab and the web read Linear and Jira through the account server
when no computer answers, using the project's vault connection (never stored,
logged or returned):

| Route | Body | Answer |
|---|---|---|
| `POST /cloud/integrations/jira/search` | `{ origin, jql, fields?, maxResults?, nextPageToken? }` | `{ siteUrl, issues, nextPageToken }` |
| `POST /cloud/integrations/jira/issue` | `{ origin, key }` | `{ siteUrl, issue }` with comments |

- Only `https://<site>.atlassian.net` (`jira_site_unsupported`, 409). Reads only;
  Linear and Jira together allow 30 requests a minute per account. An older
  server's 404 keeps the computer path.
- `integrationReads.ts` answers status, lists, one issue and comments; writes
  need a computer and are refused with a sentence. `LinearQuickViewButton.tsx`
  runs no retry poll on a DAEX Cloud tab. Linear details:
  [Linear › With no computer](../linear-integration/README.md#with-no-computer).

## Creating issues

One composer (`IssueCreateDialog.tsx`) opens from a pane's "New", a viewer's
"New sub-issue", or "Create issue" on a chat selection. ⌘↵ creates.

- **Linear**: team, status, priority, assignee, labels, project; under ⋯
  milestone, cycle, estimate, due date, parent; templates from
  `cto.getLinearIssueCreateOptions`.
- **GitHub**: labels, assignees, milestone, issue type (org repos), parent;
  templates from `.github/ISSUE_TEMPLATE` (forms become native fields).
- **Jira**: project, type, assignee, priority, labels, parent, due date (Markdown
  converted to ADF).
- **Pictures**: Linear uploads at once (`cto.uploadLinearFile`, 10 MB over sync);
  GitHub attaches through `gh issue create --attach` (GitHub CLI 2.99+ on the
  brain machine).
- Drafts per tracker in localStorage; similar open issues shown from cache; a
  chat-started issue gets a Context footer linking back. After a create, a toast
  offers "Start lane". Sub-issues: Linear `parentId`, GitHub `POST …/sub_issues`
  after the create.

## Starting work from an issue

`IssueLaunchHost` owns every launch; callers use `requestIssueLaunch(issues, {
laneOnly })` from the viewers' "Launch agent" / "Lane only", the panes'
multi-select, the Linear pane and the create toast. The dialog has one row per
issue (model, effort, fast, kickoff prompt, branch); "Lane only" makes lanes
without agents. Up to three run at once (`BATCH_LAUNCH_CONCURRENCY`): lane, then
chat or CLI, then kickoff. A failure before the session exists deletes the new
lane; a failed kickoff keeps it ("Needs attention"). The batch goes to one machine
with the project open, every call pinned there.

Lane names: Linear keeps its own; GitHub `#123 Title` on `gh-123-short-title`;
Jira `PROJ-123 Title` on `proj-123-short-title`. Each lane records its issue:
GitHub `session_github_issues` (the PR says `Closes #123`), Jira
`session_jira_issues` (the PR gets `Jira: PROJ-123`, never closing it), Linear its
lane link. `findIssueConflicts` warns about issues already in work.

## Jira issues on lanes and chats

A Jira issue attaches to a chat as a `jira_issue` context attachment. Sending it
links the issue to the session (`recordJiraIssueContextForLane`, role `worked`,
source `chat_attach`). The model reads it as untrusted data
(`shared/chatContextAttachments.ts`). Jira links never close the issue on merge.

## Linked issue snapshots

At each turn end, `refreshLinkedIssueSnapshots` re-reads that chat's linked issues
(at most 12 per turn, three at a time, skipping ones read in the last 60 s and
trackers not connected) and writes title/state snapshots to the lane. Failures
are ignored; nothing polls.

## Agents: the CLI

Agents use the CLI through the brain, which holds the credentials. `daex issue`
is tracker-neutral (`list` with `--tracker` / `--scope`, `view`, `resolve`,
`comment`, `state`, `create`, `open-url`); references can be a Linear key, a Jira
key, a GitHub number or a URL. Field edits use the tracker's own command:

- `daex linear` — `create`, `edit`, `comment`, `set-state`, `assign`, `label`,
  `set-priority`, `set-estimate`, `set-cycle`, `set-project`, `set-milestone`,
  `set-due`, `set-parent`, `relate`, `issue` (see
  [Linear integration](../linear-integration/README.md)).
- `daex jira` — above.
- `daex github issue` — `list`, `view`, `create`, `edit`, `comment`, `close`,
  `reopen`, `label`, `assign`, `milestone`, `type`, `sub-issue`. Every write reads
  the number first and refuses a pull request; `label` and `assign` write the
  full set (GitHub's PATCH replaces lists).

```
daex github issue create --title "Crash on launch" --label bug --body-file notes.md --text
daex linear set-state ADE-123 "In Progress"
```

## Top-bar settings

Settings → Integrations: "Show Linear / GitHub issues / Jira in the top bar"
(this computer only). Hiding a button disconnects nothing.

## iOS

The Work tab's ⋯ menu has Linear and GitHub Issues (shown when the repo has open
issues). The GitHub pane (`apps/ios/ADE/Views/GitHubIssues/`) lists issues and
shows description, properties and comments; close, reopen and comment work with
an edit-capable credential on the machine.
