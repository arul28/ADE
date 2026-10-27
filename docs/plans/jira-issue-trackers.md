# Jira Cloud, one tracker layer, and one launcher for every tracker

Status: built on the context-skill-improvements branch. All four workstreams (W1–W4) are in that branch. This plan does not record the live check on a Jira Cloud site or the "Done means" checks (typecheck, lint, on-screen proof); those are not confirmed here. The user-facing description is in [features/issues/README.md](../features/issues/README.md).

## Goal

1. **Jira Cloud** as a third issue tracker beside Linear and GitHub, at the
   same level of polish: connect, browse, open natively where you are, edit,
   comment, change status, create, link to lanes and chats, launch agents.
2. **One tracker layer** under the views. The views stay per tracker (they are
   ADE's strength); the reads, writes, errors, CLI and launch plumbing are
   shared.
3. **One launcher.** "Launch agent", "Lane only" and multi-issue batch launch
   work the same way from Linear, GitHub and Jira.
4. Settings, the top bar and the docs cover all three.

Learned from an open-source tracker stack: a capability-
declaring tracker port, one error vocabulary (`not-connected | unauthenticated
| forbidden | rate-limited(retryAt) | not-found | invalid | failed`), a
permission re-check before writes, cursor paging that keeps loaded pages, and
a linked-issue snapshot refreshed when a turn ends instead of polling.

## Contracts (already written; do not change without the coordinator)

- `apps/desktop/src/shared/types/jira.ts`: every Jira type.
- `window.ade.jira` (runtime-only, like `chatLaunch`: no Electron IPC channel;
  every call goes to the bound or pinned runtime's `jira` action domain; an
  unbound window rejects with "Jira needs a connected ADE runtime."). Every
  method takes an optional trailing `pin?: OpenProjectBinding | null`
  (see "Built for remote machines" in AGENTS.md):

  | method | args | returns |
  |---|---|---|
  | `getConnectionStatus` | – | `JiraConnectionStatus` |
  | `connect` | `JiraConnectArgs` | `JiraConnectionStatus` (probes `/rest/api/3/myself` before storing) |
  | `disconnect` | – | `JiraConnectionStatus` |
  | `listProjects` | `{ query?: string }` | `JiraProject[]` |
  | `listIssues` | `JiraListIssuesArgs` | `JiraIssuePage` |
  | `getIssue` | `{ key }` | `JiraIssueDetail` |
  | `listComments` | `{ key, cursor }` | `{ comments: JiraComment[]; nextCursor: string \| null }` |
  | `addComment` | `{ key, body }` | `JiraComment` |
  | `updateIssue` | `JiraUpdateIssueArgs` | `void` |
  | `listTransitions` | `{ key }` | `JiraTransition[]` |
  | `transitionIssue` | `{ key, transitionId }` | `void` |
  | `listAssignableUsers` | `{ projectKey?: string; key?: string; query?: string }` | `JiraUser[]` |
  | `listLabels` | `{ query?: string }` | `string[]` |
  | `getCreateMeta` | `{ projectKey }` | `JiraCreateMeta` |
  | `createIssue` | `JiraCreateIssueArgs` | `JiraCreateIssueResult` |

  Errors cross the boundary as an `Error` whose message starts with
  `[jira:<reason>]` (reason from `JiraErrorReason`), so the renderer can parse
  the reason with `parseJiraError(err)` from `shared/jiraErrors.ts`.

- **Project binding.** Project config (`.ade/local.yaml`; the shared layer is not written any more) gains
  `issueTrackers?: { jira?: { projectKeys: string[] } }` in
  `shared/types/config.ts`. It tells ADE which Jira projects this repo's work
  lives in: the pane's default filter, the create form's default project, and
  how a bare `KEY-123` in agent prose is classified (a key in the bound Jira
  projects is Jira; otherwise the Linear team-key rule applies).

- **Lane/chat link.** `AgentChatJiraIssueContextAttachment = { type:
  "jira_issue"; issue: LaneJiraIssue; source?: "manual" | "lane_link";
  attachedAt?: string }`, joining `AgentChatContextAttachment`. Lanes carry
  `jiraIssueLinks?: LaneJiraIssueLink[]` (same shape as
  `LaneGitHubIssueLink` with `issue: LaneJiraIssue`). Stored in a new
  `session_jira_issues` table mirroring `session_github_issues` exactly
  (desktop `kvDb.ts`, the retire-session cleanup, iOS
  `DatabaseBootstrap.sql` and `Database.swift` cleanup). `lanes.create`
  accepts `jiraIssue?: LaneJiraIssue`. Branch name: `proj-123-short-title`.
  The PR body mentions the key (`PROJ-123`) so Jira's GitHub integration
  links it.

## Credentials

Site URL + account email + API token (Atlassian "API tokens" page), Basic
auth. Stored by the brain in the machine credential store
(`EncryptedFileCredentialStore`, keys `jira.siteUrl`, `jira.email`,
`jira.apiToken`). Never logged, never returned to a client (status returns
site, email and account only). `siteUrl` must be `https://*.atlassian.net`
(or another https host for custom domains); plain `http://` is accepted only
for loopback hosts so the dev fake server works.

## Testing without a Jira account

- `apps/desktop/scripts/fake-jira-server.mjs`: a dependency-free Node HTTP
  server on loopback that implements the REST v3 endpoints the client uses,
  with seeded projects, issues, comments, users, transitions and create
  metadata, Basic auth (any email, token `fake-token`), `nextPageToken`
  paging, ADF bodies, and a switch that answers 429 with `Retry-After`.
  Connect ADE to `http://127.0.0.1:<port>` with it.
- Unit tests run the real client against recorded Atlassian response shapes.
- A free Jira Cloud site (up to 10 users) is the final live check.

## Workstreams and file ownership

Workers run in parallel in one worktree. **Edit only the files your stream
owns.** If you need a change in another stream's file, write it in your
report instead. Never commit, stash, reset or checkout; the coordinator
commits.

### W1: Jira backend, wiring and CLI (owner: Luna #1)

Owns: `apps/desktop/src/main/services/jira/**` (new), `shared/jiraAdf.ts`,
`shared/jiraErrors.ts` (new), `shared/types/config.ts` (the binding field
only), `apps/desktop/scripts/fake-jira-server.mjs` (new),
`main/services/adeActions/registry.ts`, `actionPolicy.ts`,
`shared/adeActionAccess.ts`, `preload/preload.ts`, `preload/global.d.ts`,
`shared/ipc.ts` (only if needed), `apps/ade-cli/src/bootstrap.ts`,
`apps/ade-cli/src/services/sync/syncRemoteCommandService.ts`,
`shared/syncMobileCompatibility.ts` (only if required),
`renderer/webclient/adapter/**` (a `jira` adapter over the sync commands),
`renderer/browserRuntimeBridge.ts`, `renderer/browserMock.ts` (jira mock),
`renderer/components/automations/adeActionSchemas.ts`, the CLI
(`apps/ade-cli/src/cli.ts` command table + new `cliJira.ts`), and
`apps/ade-cli/src/headlessLinearServices.ts` only if wiring needs it.

### W2: Lane and chat links (owner: Luna #2)

Owns: `shared/types/lanes.ts`, `shared/types/chat.ts` (the attachment
union), `shared/laneJiraIssue.ts` (new; mirror `laneGitHubIssue.ts`),
`shared/jiraIssueBranch.ts` (new), `shared/chatContextAttachments.ts`,
`main/services/state/kvDb.ts`, `main/services/lanes/laneService.ts`,
`main/services/chat/agentChatService.ts` and `chatLaunchArgs.ts` (how a
`jira_issue` attachment becomes prompt context), `main/services/prs/prService.ts`
(PR body mention), `apps/ios/ADE/Resources/DatabaseBootstrap.sql`,
`apps/ios/ADE/Services/Database.swift` (cleanup only),
`renderer/components/chat/ChatAttachmentTray.tsx`,
`renderer/components/chat/UserMessageIssueContext.tsx`,
`shared/types/sync.ts`, `renderer/webclient/adapter/lanes.ts`.

### W3: Jira UI and settings (owner: Luna #3)

Owns: `renderer/components/issues/Jira*.tsx`, `jiraIssueStore.ts`,
`renderer/components/lanes/jiraBrand.tsx` (real Jira logo, official SVG
path, Atlassian blue `#1868DB`/`#2684FF`), `issueRefs.ts` (a `jira` ref),
`renderer/lib/issueNavigation.ts`, `IssueViewer.tsx`, `IssuesToolPanel.tsx`,
`issueTabsStore.ts`, `issueTopBarPreferences.ts`, `shared/threadEntities.ts`
(bare `KEY-123` → Jira when bound), the smart-link classifier for
`*.atlassian.net/browse/KEY-1`, `IssueCreateDialog.tsx` + `issueCreateDraft.ts`
+ `issueCreateChips.tsx` + `issueCreateSubmit.ts` (a Jira tracker in the one
composer), `renderer/components/app/TopBar.tsx` (the Jira button),
`renderer/components/settings/JiraSection.tsx` (new) + `settingsManifest.ts`
+ `IntegrationsSettings*`, `docs/features/issues/README.md` (Jira section).

### W4 (after W1–W3): one launcher and one tracker layer (owner: Luna #4)

Generalises `lib/linearBatchLaunch.ts` and `BatchLaunchModal.tsx` from
`LaneLinearIssue` to a tracker-neutral `LaunchIssue`
(`{ tracker: "linear" | "github" | "jira"; key; title; url; laneName;
branchName; contextAttachment; laneLink }`), routes `githubIssueLaunch.tsx`
through it, adds multi-select + "Launch N" to the GitHub and Jira panes, and
adds `main/services/issueTrackers/` (the port + registry over the three
trackers) behind a runtime `issues` domain and `ade issue …` CLI.

## Done means

Typecheck and lint clean (`npm --prefix apps/desktop run typecheck`,
`lint:ci`), the touched test files pass, the dev app connects to the fake
Jira server and every flow above works on screen, proof recorded.
