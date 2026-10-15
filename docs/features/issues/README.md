# Issues: opening an issue where you are

Clicking an issue anywhere in ADE shows the issue itself, rendered natively,
without leaving the page you are on. It used to open the whole Linear browser and
search for the identifier, which covered the chat and made "show me this ticket"
a search.

Linear, GitHub and Jira issues open natively and are editable in place:
status and the other properties through pickers, the title and description
inline, and comments from the activity thread. Each tracker also has a top-bar
pane for browsing. New issues start in one composer for all three trackers, and
lanes and agents start from any of them through one launcher (see
[Starting work from an issue](#starting-work-from-an-issue)).

## The rule: open it where you are

| Where the click happens | What opens |
|---|---|
| The Work page (a chat, its composer, a session card, the PR tool, an `ade://linear-issue` chip in a transcript) | The **Issues** tab in the Work tools pane, beside the chat |
| Any other page (Lanes, PRs, CTO, History), the command palette, an `ade://` deeplink from outside | The **issue sheet**, a right-side panel that floats over the page |
| The top-bar Linear button | The Linear pane (browse, filter, batch launch) |
| The top-bar GitHub Issues button | The GitHub Issues pane (this project's repository) |
| The top-bar Jira button | The Jira pane (browse, filter and load more) |

Every container reads the one issue by identifier. Linear's `issue(id:)`
accepts `ADE-123` as well as a UUID, so nothing is searched for.

Mod+Click on an issue link still opens it externally, and Shift+Click still
opens the web page in ADE's browser.

Issue references an agent writes in plain text are chips too: `ADE-123` when
`ADE` is one of the connected workspace's team keys (see below), and GitHub
`/issues/N` links. Jira `/browse/KEY-123` links open in the same viewer.

## The layout

The properties box floats top-right and the description and activity flow
around it, then wrap to full width underneath. A fixed second column left long
descriptions squeezed into a narrow strip. Below 600px of viewer width (the
tools pane is often that narrow) the box sits under the title instead. The
sheet is 760px wide.

## Plain `ADE-123` in agent replies

`shared/threadEntities.ts` turns an identifier in agent prose into an issue
chip when it matches a tracker's key format (a letter, then up to nine letters
or digits, a hyphen, a number). Prose matches only the uppercase form the
trackers print, and never inside a path, a branch name, or a version
(`feat/ADE-1`, `ade-1-fix`, `ADE-1.2`), so `SHA-256` and `UTF-8` never match.
Code blocks and existing links are never rewritten.

Which tracker gets the chip depends on the key's project. A key in the Jira
projects bound to this project (`issueTrackers.jira.projectKeys`, see Jira
below) is a Jira chip. Otherwise the key is a Linear chip when it is one of the
connected workspace's team keys.

The team keys come from `useLinearWorkspaceTeamKeys` (`linearIssueStore.ts`):
read from the picker catalog at most once an hour per project, kept in
localStorage, so opening a chat costs no Linear request. Keys from lanes'
linked issues are added too, so a team renamed since keeps its old issues
clickable.

## GitHub Issues

- **Reads.** An issue and its comments are REST GETs (`github.getIssue`,
  `github.listIssueComments`), sent with the last ETag, so a re-read of an
  unchanged issue is a free 304. Lists use GraphQL's `issues` connection
  (`github.listRepoIssueList`, one point for up to 100) because REST `/issues`
  mixes in pull requests: on `arul28/ADE` the REST page cap filled with closed
  pull requests and showed no closed issues at all. Filters (state, assignee,
  label, milestone, text) run on the loaded rows; the search API is never
  called.
- **The button.** Shown when "Show GitHub issues in the top bar" is on, the
  project's origin is a GitHub repository with issues enabled, and at least one
  issue is open. The count comes from `github.getRepoIssueSummary` (one GraphQL
  point; REST `open_issues_count` counts pull requests too), kept on disk and
  re-read at most every 15 minutes, on window focus after that, and when the
  pane opens or refreshes. Nothing polls.
- **Both GitHub services.** `githubService.ts` (desktop) and the headless
  runtime's twin in `apps/ade-cli/src/headlessLinearServices.ts` implement the
  new reads; they share one type, so the compiler keeps them together. The list
  query and its mapping live in `shared/githubIssueList.ts`.
- **Pull requests behind an issue number.** GitHub numbers issues and pull
  requests from one sequence; an `/issues/N` link to a pull request shows a
  note pointing at the PR tool instead of an issue.
- **Editing.** Status (open, closed as completed, closed as not planned),
  assignees, labels and milestone are pickers; title and description edit in
  place; comments post from the activity thread. Every edit is one PATCH
  (`github.updateIssue`) applied optimistically and rolled back with a toast if
  GitHub refuses. The pickers read the repo's labels, collaborators and open
  milestones the first time one opens, not before.
- **Which credential edits.** Issue edits use the `issue-write` capability
  (`shared/githubOperationCredential.ts`), the one write the ADE GitHub App may
  serve. The order is environment token → App → `gh` → PAT, but the App is only
  tried when its installation on the repository's owner grants `Issues: write`
  (`main/services/github/githubIssueWriteAccess.ts`). The grant is read from the
  user's installations (`GET /user/installations`, one request, cached 15
  minutes). An ungranted App is skipped before any request: a 403 per edit
  would also land in the request budget that slows PR polling. Pull request
  writes keep their own path even though GitHub serves PR comments and labels
  from `/issues` too.
- **When nothing can write,** the controls stay visible and say why, and the
  viewer shows one notice with the fix (approve the permission, or connect
  GitHub CLI or a token).
- **The permission banner.** When the App is installed but its `issues`
  permission is not `write`, an app banner says "Update GitHub permissions to
  edit issues in ADE" with "Review on GitHub" (the installation's settings page,
  where an owner approves). It says whether edits currently go through
  GitHub CLI or a token, and its dismissal is fingerprinted on the permission,
  so it comes back only if that changes. Settings → GitHub → Issues shows the
  same status as a row.
- **Live updates.** An `issues` or `issue_comment` webhook delivery for an
  issue (not a pull request) emits a `github-issue-changed` PR event; open
  views re-read that issue (one ETag'd GET), and the repo's lists and badge are
  marked stale. Nothing is read for an issue nobody has open. The ADE GitHub
  App (`ade-for-github`) has `Issues: Read and write` and subscribes to the
  `issues` and `issue_comment` events since 2026-10-08. Each existing
  installation keeps read-only until its owner accepts the update; the
  permission banner covers that window.

## Jira

Settings → Integrations → Jira connects this machine to one Jira Cloud site
with an Atlassian API token. The site URL, the account email and the token are
stored in the machine's encrypted credential store under `jira.siteUrl`,
`jira.email` and `jira.apiToken`. The token is never logged and never sent back
to a client. The site URL must be `https://`; plain `http://` is accepted only
for a loopback host, so the test server below works. Jira URLs use
`/browse/KEY-123`.

The project binding is `issueTrackers.jira.projectKeys` in this project's
`.ade/local.yaml`. It is the one place ADE reads Jira project keys from: the
pane's default project filter, the create form's default project, and whether a
bare `KEY-123` in agent prose is a Jira chip. The shared `ade.yaml` is no longer
read.

The runtime exposes Jira as `window.ade.jira` (runtime-only; see
[ARCHITECTURE](../../ARCHITECTURE.md)). Its actions are in the `jira` action
domain. Connecting and disconnecting are CTO-only, because the credential is
machine-wide.

The Jira viewer edits the title and Markdown description inline. Its property
box changes status through the workflow transitions Jira offers, and edits
assignee, priority, labels and due date; issue type is read-only. Comments load
in pages. Reads use a per-issue cache and edits appear immediately, then roll
back with a toast if Jira rejects them. Connection, authentication, permission
and rate-limit errors explain the next action.

The Jira pane filters by project, open/done/all, assignee and text, and loads
older pages on demand while keeping existing rows visible during refresh. New
issues use the shared composer with project, issue type, assignee, priority,
labels, parent and due date. Issue types with required fields the form cannot
fill are disabled with the missing field names. Description text is Markdown;
the Jira API converts it to Atlassian Document Format.

### Testing without a Jira site

`apps/desktop/scripts/fake-jira-server.mjs` is a dependency-free Node server on
`127.0.0.1` that answers the REST v3 calls the client makes. It has two seeded
projects (ADE and PAY), issues, comments, users, transitions and create
metadata. Start it with `node apps/desktop/scripts/fake-jira-server.mjs --port
4318` (the port defaults to `PORT`, then 4318). In ADE, connect to
`http://127.0.0.1:4318` with any email and the token `fake-token`. Add
`--rate-limit` to answer every authenticated call with 429 and `Retry-After: 30`,
which shows the rate-limit message. ADE does not start the server.

### The `ade jira` CLI

`ade jira` (`apps/ade-cli/src/cliJira.ts`) does the same work from a terminal or
an agent: `status`, `connect` (CTO role; the token comes from stdin with
`--token-stdin`, never as an argument), `disconnect` (CTO role), `projects`,
`list` (paged; pass the returned cursor to `--cursor`), `issue`, `create`,
`edit`, `comment`, `transition`, `assign`, `label` and `unlabel`. Add `--text`
for a readable answer; the default is JSON.

## Creating issues

One composer (`IssueCreateDialog.tsx`, mounted once by `IssueCreateHost` in
the app shell) makes Linear, GitHub and Jira issues. It opens from:

- "New" in the header of the Linear pane and the GitHub Issues pane;
- "New sub-issue" in an issue viewer's ⋯ menu (the parent is fixed);
- "Create issue" in the chat's text-selection toolbar. The selection's first
  sentence is the title, the whole selection the description.

The form is a big title, the description, a row of property chips (the same
`PickerMenu` the viewer uses) and a ⋯ row for the fields most issues skip.
⌘↵ (Ctrl+Enter on Windows) creates.

- **Linear fields.** Team, status, priority, assignee, labels, project; under
  ⋯ the project milestone, cycle, estimate, due date and parent. Cycle and
  estimate show only when the team uses them, and the estimate scale follows
  the team's estimation type (`cto.getLinearIssueCreateOptions`, one request
  per team). Templates come from the same call and fill the title, priority
  and labels; Linear applies the rest on create.
- **GitHub fields.** Labels, assignees, milestone, issue type (organization
  repositories only), parent under ⋯. Templates come from
  `.github/ISSUE_TEMPLATE` (`github.listIssueTemplates`). A markdown template
  fills the description; an issue form replaces it with native fields, and the
  answers become the `### Label` body GitHub itself writes
  (`shared/githubIssueTemplates.ts`). `blank_issues_enabled: false` makes a
  template required.
- **Jira fields.** Project, issue type, assignee, priority, labels, parent and
  due date. The issue type list disables options that have unsupported required
  fields. Jira stores the description as Atlassian Document Format; the form
  takes Markdown and the runtime converts it.
- **Pictures.** Paste or drop an image into the description. Linear uploads it
  at once (`cto.uploadLinearFile`; from the web client or a phone the bytes
cross the sync channel, capped at 10 MB) and inserts the markdown. GitHub has no API
  for issue attachments, so the pictures go with the create through
  `gh issue create --attach` (GitHub CLI 2.99 or later on the brain machine);
  labels and the other fields follow in one PATCH.
- **Similar issues.** Open issues ADE has already read whose titles share most
  words with the new title show under it. Nothing is requested for this.
- **Drafts.** Kept per tracker in `localStorage` while you type; Esc keeps the
  draft, a create clears it. "Create more" keeps the form open.
- **Context footer.** An issue started from a chat gets a collapsed "Context"
  section with an `https` ADE link back to that chat and its lane.
- **Analytics.** One `ade_feature_used` fact per issue made here, with only
  the tracker (`docs/logging.md`).
- **After a create.** A toast with "Start lane". From a pane, the pane selects
  the new issue; from anywhere else it opens where you are. The GitHub lists
  show it at once and re-read in the background (one GraphQL point).
- **Sub-issues.** Linear takes `parentId` on create. GitHub links with
  `POST …/sub_issues` after the create; if only that step fails, the issue
  exists and the toast says it was not linked.

## Starting work from an issue

Linear, GitHub and Jira issues start lanes and agents through one launcher. It
is `IssueLaunchHost` (in `components/app/BatchLaunchModal.tsx`), mounted once by
`AppShell`. Nothing else renders the dialog. A caller asks for a launch with
`requestIssueLaunch(issues, { laneOnly })` (`lib/issueLaunchRequests.ts`). The
asks come from the "Launch agent" and "Lane only" buttons in each viewer, from
the multi-select in the GitHub and Jira panes, from the Linear pane, and from
the "Start lane" action on a create toast. Each issue is a `LaunchIssue`
(`lib/linearBatchLaunch.ts`): its tracker, id, key, title, URL, lane name,
branch name, the context attachment the chat gets, and the lane link that
records the issue on the lane.

The dialog shows one row per issue, with the model, reasoning effort, Fast mode
where the provider supports it, an editable kickoff prompt and the branch name.
A default row seeds the others. "Lane only" creates the lanes and no agents.
Up to three issues run at once (`BATCH_LAUNCH_CONCURRENCY`). Each one creates
its lane, then its chat or CLI session, then sends the kickoff. A failure before
the session exists deletes the new lane again, so a retry does not leave an
empty lane. A kickoff that fails after the session exists shows "Needs
attention" and keeps the lane. The batch goes to one machine that has the
project open, and every lane create and launch is pinned there.

Lane names and branches: a Linear issue keeps its own. A GitHub issue gets the
lane `#123 Title` on `gh-123-short-title`. A Jira issue gets `PROJ-123 Title` on
`proj-123-short-title`.

Each launched lane records its issue, so the work shows under "Linked in ADE":

- GitHub: a `githubIssue` lane link (`session_github_issues`), and the lane's PR
  says `Closes #123`. Detaching the issue from a chat in that lane removes the
  lane's link too.
- Jira: a `jiraIssue` lane link (`session_jira_issues`). The PR body gets a
  `Jira: PROJ-123` line, so Jira's GitHub integration can link it. The link
  never closes the issue.
- Linear: its existing lane link.

Before a launch, `findIssueConflicts` warns about an issue that already has a
lane or an agent. Conflicts are checked per tracker and id.

## Jira issues on lanes and chats

A Jira issue attaches to a chat as a `jira_issue` context attachment
(`AgentChatJiraIssueContextAttachment`, joined to the chat's attachment union).
When a message with that attachment is sent, `recordJiraIssueContextForLane` in
`agentChatService.ts` links the issue to the chat's session in
`session_jira_issues` (role `worked`, source `chat_attach`, included in the PR).
The model reads the issue as untrusted data (`shared/chatContextAttachments.ts`).
A lane launched from a Jira issue carries the same link as `jiraIssueLinks`.
Jira links never close the issue on merge.

## Linked issue snapshots

A lane's issue links keep a snapshot of the issue's title, state and update
time. When a chat's turn ends (the `done` event), `refreshLinkedIssueSnapshots`
in `agentChatService.ts` re-reads that chat's linked issues and writes the
snapshots to the lane. The read is bounded. It reads at most 12 distinct issues
per turn end; a cursor for each chat moves through longer lists. It reads three
at a time, skips an issue read in the last 60 seconds, and skips a tracker that
is not connected. A failed read is ignored and never changes the turn's result.
Nothing polls: the reads happen only at a turn's end.

## Agents: the CLI

Agents create and edit issues in all three trackers with the `ade` CLI. The
calls go through the running brain, which holds the Linear, GitHub and Jira
credentials, so an agent needs no token. Names work where the provider has
names (states, users, labels, projects, milestones, cycles, templates); ids work
too. Add `--text` for a short receipt (id, title, URL); the default is JSON.

`ade issue` is the tracker-neutral command. It works across the connected
trackers: `list` (with `--tracker linear|github|jira` and `--scope`), `view`,
`resolve`, `comment`, `state`, `create` and `open-url`. Its references can be a
Linear key, a Jira key, a GitHub number or a URL. The runtime `issues` action
domain serves `list`, `get`, `resolve`, `comment`, `setState` and `create`
(`actionPolicy.ts`). Editing fields goes through the tracker's own command below.

- **Linear** (`ade linear`): `create`, `edit`, `comment`, `set-state`,
  `assign`, `label`, `unlabel`, `set-priority`, `set-estimate`, `set-cycle`,
  `set-project`, `set-milestone`, `set-due`, `set-parent`, `relate`, and
  `issue`. See the Linear integration doc for the flags.
- **Jira** (`ade jira`): see "The `ade jira` CLI" above.
- **GitHub** (`ade github issue`): `list`, `view`, `create`, `edit`,
  `comment`, `close`, `reopen`, `label`, `assign`, `milestone`, `type`, and
  `sub-issue`. Each works on the project's origin repo, or on `--repo
  owner/name`. An issue can be `12`, `#12`, `owner/name#12`, or a URL.
  `label` and `assign` read the issue first and write the full set, because
  GitHub's PATCH replaces the list. `create --attach <file>` needs GitHub CLI
  on the machine that runs the brain.

```
ade github issue create --title "Crash on launch" --label bug --body-file notes.md --text
ade github issue close 12 --reason not-planned
ade linear create --team ADE --title "Fix login redirect" --priority high --label bug --cycle current
ade linear set-state ADE-123 "In Progress"
```

The name lookups and value checks are in `apps/ade-cli/src/issueCliFields.ts`;
the commands are `buildLinearPlan` in `apps/ade-cli/src/cli.ts` and
`buildGithubIssuePlan` in `apps/ade-cli/src/cliGithubIssue.ts`. A GitHub write
(`edit`, `close`, `reopen`, `label`, `assign`, `milestone`, `type`,
`comment`) reads the number first and refuses a pull request: GitHub numbers
both from one sequence and `/issues` accepts either.

## Top-bar settings

Settings → Integrations has "Show Linear in the top bar", "Show GitHub
issues in the top bar" and "Show Jira in the top bar" (`issueTopBarPreferences.ts`), desktop-only and stored
on this computer. Hiding a button disconnects nothing; links still open in the
Issues tab and the sheet. Turning Linear off is signing out.

## Source file map

- `apps/desktop/src/shared/issueRefs.ts` — `IssueRef` (`linear` identifier,
  GitHub owner/repo/number, or Jira site and key), `issueRefKey`, and
  `issueRefFromUrl`, which reuses the smart-link classifier so a link that draws
  as an issue chip and a link that opens the viewer cannot disagree.
- `apps/desktop/src/renderer/lib/issueNavigation.ts` — the router.
  `openIssueRef` sends to the tools pane when an in-place host is registered,
  else to the sheet; `openIssueInSheet` always uses the sheet (command
  palette, inbound deeplink modal). All three trackers have a native viewer.
- `apps/desktop/src/renderer/lib/openExternal.ts` — `openLinkFromUi` checks
  for an issue link first, so every markdown link and URL chip in ADE routes
  through the issue viewer with no per-surface wiring.
- `apps/desktop/src/shared/threadEntities.ts` — prose chips: Jira keys bound to
  the project first, then Linear team keys (see "Plain `ADE-123`" above).
- `apps/desktop/src/shared/types/issueTrackers.ts` — the tracker-neutral
  contract: `IssueTrackerKind`, the adapter and its capabilities, list and
  update args, and the service type. `shared/types/jira.ts` holds every Jira
  type; `shared/jiraAdf.ts` converts between Markdown and Atlassian Document
  Format; `shared/jiraErrors.ts` parses the `[jira:<reason>]` error prefix;
  `shared/laneJiraIssue.ts` and `shared/jiraIssueBranch.ts` hold the lane issue
  shape and its lane name and branch.
- `apps/desktop/src/main/services/issueTrackers/` — the one layer over the three
  trackers, used by the runtime `issues` action domain and `ade issue`.
  - `issueTrackerService.ts` — `createIssueTrackerService`: resolves a reference
    (URL, key, `owner/repo#N`, `#N` in the project's repository) to a tracker,
    checks the tracker is connected and has the capability, and exposes `resolve`,
    `getViewer`, `list`, `get`, `getComments`, `comment`, `update`, `setState`,
    `create` and `listStates`. A bare key is Jira only when its project is bound
    or known on the connected site; a Linear team key is tried first.
  - `adapters.ts` — one adapter per tracker (`createLinearIssueTrackerAdapter`,
    `createGithubIssueTrackerAdapter`, `createJiraIssueTrackerAdapter`), which
    map each tracker's reads and writes to the shared shape.
  - `issueTrackerError.ts` — `IssueTrackerError`, with one reason vocabulary
    (`not-connected`, `unauthenticated`, `forbidden`, `rate-limited`,
    `not-found`, `invalid`, `failed`) and the message prefix `[issues:<reason>]`.
- `apps/desktop/src/main/services/jira/` — `jiraService.ts` (the Jira reads and
  writes, with short caches for the project list and the create metadata),
  `jiraClient.ts` (the REST v3 client: Basic auth, the site URL rules, paging,
  and error mapping), and `jiraCredentialService.ts` (the three `jira.*` keys in
  the machine credential store).
- `apps/desktop/scripts/fake-jira-server.mjs` — the test server (see "Testing
  without a Jira site").
- `apps/ade-cli/src/cliIssue.ts` — `ade issue`; `apps/ade-cli/src/cliJira.ts` —
  `ade jira`.
- `apps/desktop/src/main/services/chat/agentChatService.ts` —
  `refreshLinkedIssueSnapshots` (see "Linked issue snapshots") and
  `recordJiraIssueContextForLane` (the Jira chat link).
- `apps/desktop/src/main/services/prs/prService.ts` — `applyJiraPrLinkage`, the
  `Jira: KEY` line in a lane's PR body.
- `apps/desktop/src/main/services/state/kvDb.ts` — `session_jira_issues`.
- `apps/desktop/src/main/services/adeActions/actionPolicy.ts` — the `jira` and
  `issues` action domains: which actions are reads, writes, and CTO-only.
- `apps/desktop/src/preload/preload.ts` — `window.ade.jira` (runtime-only).
- `apps/desktop/src/renderer/webclient/adapter/jira.ts` — the hosted web client's
  Jira adapter.
- `apps/desktop/src/renderer/components/issues/`
  - `IssueViewer.tsx` — picks the provider's viewer (Linear, GitHub or Jira).
  - `JiraIssueViewer.tsx`, `JiraIssueView.tsx`, `jiraIssueStore.ts` — the Jira
    viewer, its body, and its cache. `JiraIssuesPane.tsx` and
    `JiraIssuesButton.tsx` are the top-bar pane and button.
  - `LinearIssueViewer.tsx` — the Linear viewer: reads by identifier, edits,
    the load and failure states that say what fixes them, and "Linked in ADE".
  - `LinearIssueView.tsx` — the Linear issue body: title, description,
    relations and activity, with the floated property box. The Linear pane's
    detail side renders it too. `IssueMarkdown` is shared with GitHub.
  - `issueViewer.css` — the layout (see above).
  - `issueEntryCache.ts` — the single-issue cache both trackers use: one read
    in flight per issue, a freshness window, LRU eviction, and optimistic
    edits where only the newest edit's reply or rollback lands.
  - `linearIssueStore.ts` — the Linear issue cache shared by the tab, the
    sheet and chip hover cards, the picker catalog, and `useLinearIssuePeek`
    for chips that must not fetch.
  - `IssuesToolPanel.tsx` + `issueTabsStore.ts` — the Issues tool: one chip per
    open issue (provider mark, state, id; middle-click closes; draggable onto
    the composer), stored per lane in `localStorage`.
  - `IssueSheetHost.tsx` — the sheet, mounted once in `AppShell`. It hides the
    native browser view while open.
  - `GitHubIssueViewer.tsx`, `GitHubIssueView.tsx`, `githubIssueStore.ts` — the
    GitHub viewer, its body, and its cache (issue, comments, repo, badge
    summary, lists). A list row is a partial copy (the list query carries only
    the first labels and assignees): it shows at once, opening it reads the
    whole issue, and edits wait for that read so a label change cannot drop
    labels the row never had. An open issue that a list refresh turns partial
    is read again. The comment thread is read again when the
    issue's update time or comment count changes.
  - `GitHubIssuesButton.tsx`, `GitHubIssuesPane.tsx` — the top-bar button and
    the pane (list + viewer) inside the shared `LinearPaneModal` shell.
  - `issueViewerParts.tsx` — what both viewers share: the frame (header,
    scrolling body, action dock), the 40px header, the "last copy" banner, the
    action dock (Launch agent, Lane only, Attach to chat), copy-with-toast, and
    "Linked in ADE" (`lanesCarryingIssue`).
  - `IssuePickerMenu.tsx` — the filterable picker every property chip opens,
    and the GitHub label and person options.
  - `issueTopBarPreferences.ts` — the two top-bar toggles.
  - `issueEditing.tsx` — inline title, description and the comment box, shared
    by both providers; `issueMarkdown.tsx` — the markdown renderer they share.
    A failed image retries three times: a picture GitHub has just taken fails
    for a few seconds before it is served.
  - `IssueCreateDialog.tsx` + `IssueCreateHost.tsx` — the create composer.
    Its parts: `issueCreateDraft.ts` (form state and the draft, per tracker
    and project; the parent is never saved, GitHub form answers are),
    `issueCreateChips.tsx` (the property chips), `GitHubIssueFormFields.tsx`,
    `useSimilarIssues.tsx`, and `issueCreateSubmit.ts`. A sub-issue is created
    in its parent's repository.
  - `githubIssueLaunch.tsx` — a thin wrapper that turns a GitHub issue into a
    `LaunchIssue` and asks the shared launcher. It keeps the old call sites
    working; it renders no dialog of its own.
  - `JiraIssueViewer.tsx` launches through the same request (`requestIssueLaunch`).
- `apps/desktop/src/renderer/components/app/BatchLaunchModal.tsx` —
  `IssueLaunchHost`, the one shared launch dialog and runner, and its status
  toast. It is mounted by `AppShell`.
- `apps/desktop/src/renderer/lib/issueLaunchRequests.ts` — `requestIssueLaunch`
  and the launch progress and cancel events the host publishes.
- `apps/desktop/src/renderer/lib/linearBatchLaunch.ts` — `LaunchIssue`, the
  per-tracker builders (`buildLinearLaunchIssue`, `buildGitHubLaunchIssue`,
  `buildJiraLaunchIssue`), and the batch runner's config and conflict checks.
- `apps/desktop/src/renderer/components/ui/dialog/Dialog.tsx` — `placement:
  "right"` is the side sheet: full height, docked right, opaque, a lighter
  scrim, slides in.
- `apps/desktop/src/renderer/lib/issueCreateRequests.ts` — "start a new
  issue" requests, and the "issue created" event the panes select from.
- `apps/desktop/src/shared/githubIssueTemplates.ts` — issue template and form
  parsing, and the body a form produces.
- `apps/desktop/src/main/services/github/githubIssueOps.ts` — every GitHub
  issue operation (reads, the App's issue grant, write access, edits,
  comments, creates, templates, issue types, sub-issue links), shared by the
  desktop service and the headless runtime; each service passes only its
  transport and how it runs `gh`.
- `apps/desktop/src/shared/linearIssueCreateInput.ts` — the one parser for a
  Linear create request; the tracker's `createIssue` applies it, so IPC, the
  runtime action and the phone read input the same way.
- `apps/ade-cli/src/cliGithubIssue.ts` — `ade github issue`; every write reads
  the number first and refuses a pull request.
- `apps/desktop/src/renderer/lib/linearLaunchRequests.ts` — the viewer asks the
  top-bar Linear host to launch; the launch modal and runner keep one owner.
- `apps/desktop/src/renderer/lib/linearIssueQuickViewNavigation.ts` — now only
  "open the Linear pane" (the Issues tool's empty state, the sheet's "All
  issues").
- `apps/desktop/src/renderer/lib/issueDrag.ts` — the drag payload for dropping
  an issue chip onto the composer; the payload is the context attachment
  itself.

## Gotchas

- **The in-place host is registered by `TerminalsPage` only while it is the
  active page.** Pages are kept warm behind other pages, so registering on
  mount would send a click on the Lanes page into a pane nobody can see.
- **The Work page reveals, the panel drains.** As with file links, the Work
  page only switches the pane to the Issues tool; `IssuesToolPanel` takes the
  held request on mount or from the broadcast. The page must not clear the
  hold, or a panel that was not mounted yet would miss the request.
- **One launch dialog.** Every launch goes to `IssueLaunchHost`, which owns the
  dialog, the runner and the status. Nothing else mounts `BatchLaunchModal`.
- **Cancelling a launch returns to the Linear pane only for a launch that
  came from it.** The request carries `returnToLinearPane` for the Linear pane,
  and the host reports the cancel back to that pane.
- **The GitHub and Linear sheets close when a launch starts,** because the
  dialog takes over and the sheet would sit behind it over the new lane. The
  Jira sheet does not close.
- **Failures say what fixes them.** A failed read asks the Linear connection
  once: no project open, Linear not connected, issue not returned, or a request
  error each get their own words and action.
- **Detaching from a sent message** used to live in the Linear details modal a
  sent chip opened. The chip opens the viewer now, so its × detaches.
- **Comments over the runtime** take the issue id as a scalar (`{ arg }` in
  preload), like `fetchIssueById`. Passing `{ args }` handed the tracker an
  object and every runtime comment read failed.

## A plain `#123`

GitHub numbers issues and pull requests from one sequence, so `#123` in an
agent reply can be either. The chip stays a PR chip; clicking one on the tab's
own machine first asks GitHub (the viewer's cached, ETag'd issue read): an
issue opens in the issue viewer where you are, anything else (a pull request,
an unknown number, no GitHub remote, a chat on another machine) keeps the PR
route (`chatDeeplinks.ts`). An `/issues/N` link that turns out to be a pull
request shows a note with "Open pull request".

## iOS

The Work tab's ⋯ menu has Linear and GitHub Issues. GitHub Issues shows when
the project's origin is a GitHub repository with issues on and at least one
open (`github.detectRepo` + `github.getRepoIssueSummary`, read once per project
per 15 minutes). The pane (`apps/ios/ADE/Views/GitHubIssues/`) lists open,
closed or all issues with a filter, and an issue shows its description,
properties and comments. Close (completed or not planned), reopen and comment
work when the machine has a credential that can edit issues. "+" opens
GitHub's new-issue page; the full create form is desktop-only.

## Not done yet

- The full create form on iOS ("+" opens GitHub's page instead).
- Jira on iOS. The phone has no Jira pane and no Jira launch. Its database has
  the same `session_jira_issues` table as the desktop.
- The ADE GitHub App itself still needs `Issues: write` and the `issues` event
  added in its GitHub settings; ADE only detects and explains the grant.
