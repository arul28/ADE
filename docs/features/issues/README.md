# Issues: opening an issue where you are

Clicking an issue anywhere in ADE shows the issue itself, rendered natively,
without leaving the page you are on. It used to open the whole Linear browser and
search for the identifier, which covered the chat and made "show me this ticket"
a search.

Linear and GitHub issues both open natively and both are editable in place:
status and the other properties through pickers, the title and description
inline, and comments from the activity thread. Each tracker also has a top-bar
pane for browsing. New issues start in one composer for both trackers.

## The rule: open it where you are

| Where the click happens | What opens |
|---|---|
| The Work page (a chat, its composer, a session card, the PR tool, an `ade://linear-issue` chip in a transcript) | The **Issues** tab in the Work tools pane, beside the chat |
| Any other page (Lanes, PRs, CTO, History), the command palette, an `ade://` deeplink from outside | The **issue sheet**, a right-side panel that floats over the page |
| The top-bar Linear button | The Linear pane (browse, filter, batch launch) |
| The top-bar GitHub Issues button | The GitHub Issues pane (this project's repository) |

Every container reads the one issue by identifier. Linear's `issue(id:)`
accepts `ADE-123` as well as a UUID, so nothing is searched for.

Mod+Click on an issue link still opens it externally, and Shift+Click still
opens the web page in ADE's browser.

Issue references an agent writes in plain text are chips too: `ADE-123` when
`ADE` is one of the connected workspace's team keys (see below), and GitHub
`/issues/N` links.

## The layout

The properties box floats top-right and the description and activity flow
around it, then wrap to full width underneath. A fixed second column left long
descriptions squeezed into a narrow strip. Below 600px of viewer width (the
tools pane is often that narrow) the box sits under the title instead. The
sheet is 760px wide.

## Plain `ADE-123` in agent replies

`shared/threadEntities.ts` turns an identifier in agent prose into a Linear
chip when it matches Linear's format (a team key of a letter plus up to nine
letters or digits, a hyphen, a number) AND the key is one of the connected
workspace's teams. Prose matches only the uppercase form Linear prints, and
never inside a path, a branch name, or a version (`feat/ADE-1`, `ade-1-fix`,
`ADE-1.2`), so `SHA-256` and `UTF-8` never match. Code blocks and existing links
are never rewritten.

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

## Creating issues

One composer (`IssueCreateDialog.tsx`, mounted once by `IssueCreateHost` in
the app shell) makes Linear and GitHub issues. It opens from:

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
- **Pictures.** Paste or drop an image into the description. Linear uploads it
  at once (`cto.uploadLinearFile`) and inserts the markdown. GitHub has no API
  for issue attachments, so the pictures go with the create through
  `gh issue create --attach` (GitHub CLI 2.99 or later on the brain machine);
  labels and the other fields follow in one PATCH.
- **Similar issues.** Open issues ADE has already read whose titles share most
  words with the new title show under it. Nothing is requested for this.
- **Drafts.** Kept per tracker in `localStorage` while you type; Esc keeps the
  draft, a create clears it. "Create more" keeps the form open.
- **Context footer.** An issue started from a chat gets a collapsed "Context"
  section with an `https` ADE link back to that chat and its lane.
- **After a create.** A toast with "Start lane". From a pane, the pane selects
  the new issue; from anywhere else it opens where you are. The GitHub lists
  show it at once and re-read in the background (one GraphQL point).
- **Sub-issues.** Linear takes `parentId` on create. GitHub links with
  `POST …/sub_issues` after the create; if only that step fails, the issue
  exists and the toast says it was not linked.

## Starting work from a GitHub issue

"Launch agent" and "Lane only" in the GitHub viewer (and "Start lane" on the
create toast) open `githubIssueLaunch.tsx`: one lane named `#123 Title` on the
branch `gh-123-short-title`, and, for "Launch agent", a chat in it with the
model controls of the Work composer and an editable kickoff prompt. The issue
goes to the chat as a `github_issue` context attachment, which records the
session's issue link. The lane itself is linked too (`githubIssue` on
`lanes.create`, stored as a `session_github_issues` row under the session id
`lane:<laneId>`), so "Lane only" also shows under "Linked in ADE" and the
lane's PR says `Closes #123`. Lanes carry these links as `githubIssueLinks`.
The machine picker is the Linear launcher's: the lane and its chat go to one
machine that has the repository open.
If the chat fails to start, the new lane is deleted again. The Linear batch
launcher is not reused: it is built around Linear's lane link and runs many
issues at once, and a GitHub issue needs one lane at a time.

## Agents: the CLI

Agents create and edit issues in both providers with the `ade` CLI. The calls
go through the running brain, which holds the Linear and GitHub credentials, so
an agent needs no token. Names work where the provider has names (states,
users, labels, projects, milestones, cycles, templates); ids work too. Add
`--text` for a short receipt (id, title, URL); the default is JSON.

- **Linear** (`ade linear`): `create`, `edit`, `comment`, `set-state`,
  `assign`, `label`, `unlabel`, `set-priority`, `set-estimate`, `set-cycle`,
  `set-project`, `set-milestone`, `set-due`, `set-parent`, `relate`, and
  `issue`. See the Linear integration doc for the flags.
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
the commands are `buildLinearPlan` and `buildGithubIssuePlan` in
`apps/ade-cli/src/cli.ts`.

## Top-bar settings

Settings → Integrations has "Show Linear in the top bar" and "Show GitHub
issues in the top bar" (`issueTopBarPreferences.ts`), desktop-only and stored
on this computer. Hiding a button disconnects nothing; links still open in the
Issues tab and the sheet. Turning Linear off is signing out.

## Source file map

- `apps/desktop/src/shared/issueRefs.ts` — `IssueRef` (`linear` identifier, or
  GitHub owner/repo/number), `issueRefKey`, and `issueRefFromUrl`, which reuses
  the smart-link classifier so a link that draws as an issue chip and a link
  that opens the viewer cannot disagree.
- `apps/desktop/src/renderer/lib/issueNavigation.ts` — the router.
  `openIssueRef` sends to the tools pane when an in-place host is registered,
  else to the sheet; `openIssueInSheet` always uses the sheet (command
  palette, inbound deeplink modal). `hasNativeIssueViewer` limits it to Linear
  for now, so a GitHub issue link falls through to the browser.
- `apps/desktop/src/renderer/lib/openExternal.ts` — `openLinkFromUi` checks
  for an issue link first, so every markdown link and URL chip in ADE routes
  through the issue viewer with no per-surface wiring.
- `apps/desktop/src/renderer/components/issues/`
  - `IssueViewer.tsx` — the shared chrome: 40px header (provider mark, id,
    state, refresh, open on the web, ⋯ copy menu, "All issues" in the sheet,
    close), the load and failure states, and the action dock (Launch agent,
    Lane only, Attach to chat). Also "Linked in ADE": the lanes carrying the
    issue and how many chats in each were handed it, read from lane data.
  - `LinearIssueView.tsx` — the Linear issue body: title, description,
    relations and activity, with the floated property box. The Linear pane's
    detail side renders it too. `IssueMarkdown` is shared with GitHub.
  - `issueViewer.css` — the layout (see above).
  - `linearIssueStore.ts` — one cache per issue shared by the tab, the sheet
    and chip hover cards: reads, optimistic edits with rollback, the picker
    catalog, and `useLinearIssuePeek` for chips that must not fetch.
  - `IssuesToolPanel.tsx` + `issueTabsStore.ts` — the Issues tool: one chip per
    open issue (provider mark, state, id; middle-click closes; draggable onto
    the composer), stored per lane in `localStorage`.
  - `IssueSheetHost.tsx` — the sheet, mounted once in `AppShell`. It hides the
    native browser view while open.
  - `GitHubIssueViewer.tsx`, `GitHubIssueView.tsx`, `githubIssueStore.ts` — the
    GitHub viewer, its body, and its cache (issue, comments, repo, badge
    summary, lists).
  - `GitHubIssuesButton.tsx`, `GitHubIssuesPane.tsx` — the top-bar button and
    the pane (list + viewer) inside the shared `LinearPaneModal` shell.
  - `issueViewerParts.tsx` — the header, copy-with-toast and "Linked in ADE"
    shared by both providers.
  - `issueTopBarPreferences.ts` — the two top-bar toggles.
  - `issueEditing.tsx` — inline title, description and the comment box, shared
    by both providers; `issueMarkdown.tsx` — the markdown renderer they share.
    A failed image retries three times: a picture GitHub has just taken fails
    for a few seconds before it is served.
  - `IssueCreateDialog.tsx` + `IssueCreateHost.tsx` — the create composer.
  - `githubIssueLaunch.tsx` — the GitHub lane and agent launch, and its host.
- `apps/desktop/src/renderer/components/ui/dialog/Dialog.tsx` — `placement:
  "right"` is the side sheet: full height, docked right, opaque, a lighter
  scrim, slides in.
- `apps/desktop/src/renderer/lib/issueCreateRequests.ts` — "start a new
  issue" requests, and the "issue created" event the panes select from.
- `apps/desktop/src/shared/githubIssueTemplates.ts` — issue template and form
  parsing, and the body a form produces.
- `apps/desktop/src/main/services/github/githubIssueOps.ts` — GitHub create,
  templates, issue types and sub-issue links, shared by the desktop service and
  the headless runtime.
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
- **Launching from the sheet closes the sheet.** The launch modal is owned by
  `LinearQuickViewButton`; cancelling it returns to the pane only when the
  pane opened it (`batchReturnsToPaneRef`).
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
- The ADE GitHub App itself still needs `Issues: write` and the `issues` event
  added in its GitHub settings; ADE only detects and explains the grant.
