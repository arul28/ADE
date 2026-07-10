# Linear Integration

ADE's Linear integration is a **read surface plus a developer-driven write flow**, not an autonomous orchestrator. It lets you connect a Linear workspace, browse and search issues, attach an issue to a lane or a chat session, and carry that link through branch naming, commit messages, and PR bodies so Linear links the PR back to the issue. An optional live-status round-trip reflects an ADE agent's progress back into Linear.

> **Removed:** the earlier autonomous Linear workflow engine — intake, routing, dispatcher, sync loop, webhook/relay ingress, flow policy, closeout, and the visual pipeline builder — was deleted along with the CTO worker/hiring model. There is no longer a `LinearWorkflowDefinition`, no dispatcher, no reconciliation timer, and no `ade serve` workflow runtime. The CTO ([`../cto/README.md`](../cto/README.md)) is a single chat thread that can read and lightly update Linear issues through its operator tools; it does not own an intake pipeline. Legacy `linear_workflow_*` / `linear_dispatch_*` / `linear_ingress_*` tables remain in the schema for migration safety but are not written by any live service.

## Source file map

### Connection, client, and writes (`apps/desktop/src/main/services/cto/`)

The Linear services live under the `cto/` service directory as shared plumbing; they are not CTO-owned workflow machinery.

- `linearAppClient.ts` — the ADE Linear OAuth app constants: the bundled public `ADE_LINEAR_APP_CLIENT_ID` and the `LinearOAuthClientSource` (`"ade-app" | "custom"`) type. This app is the default sign-in client; its authorization auto-provisions the workspace webhook the automations Linear ingress consumes.
- `linearCredentialService.ts` — personal API key + OAuth client + auth-mode storage in the active project's `.ade/secrets`, with `ensureFreshToken()` for automatic OAuth refresh. `getOAuthClientCredentials()` falls back to the bundled ADE app client (secretless) when no custom client is configured, and `getOAuthClientSource()` reports which is in effect.
- `linearOAuthService.ts` / `linearOAuthRefreshLock.ts` / `linearTokenRefresh.ts` — PKCE loopback OAuth flow (port 19836), the cross-process refresh lock, and the token-refresh exchange. The authorize URL requests `read,write,admin` for the ADE app client and `read,write` for a custom client.
- `linearClient.ts` — the GraphQL client shared by desktop and the headless ADE CLI (reads plus the lightweight `updateIssueState` / `updateIssueAssignee` / `createComment` / `addIssueLabel` writes, and the `listWebhooks` / `createWebhook` / `deleteWebhook` methods the automations Linear ingress uses to manage a per-workspace webhook).
- `linearIssueTracker.ts` / `issueTracker.ts` — normalization into `NormalizedLinearIssue` and the read shims + write helpers renderer/CLI surfaces call through.
- `linearGraphQLInput.ts` — GraphQL input builders shared by client and tracker.
- `linearLaneCardService.ts` — builds the "Open in ADE" Linear attachments for lanes, PRs, issue quick-view links, and chat sessions.
- `linearLiveStatusService.ts` — the optional launch → PR → merge status round-trip, gated OFF unless `ADE_LINEAR_LIVE_STATUS_ROUNDTRIP=1`.

### Renderer surfaces

- `renderer/components/app/LinearQuickViewButton.tsx`, `LinearIssueBrowser.tsx`, `LinearIssueSelectModal.tsx`, `LinearIssueResolveModals.tsx` — the top-bar quick view, the filter/search browser, and the single-issue select/resolve dialogs.
- `renderer/components/app/BatchLaunchModal.tsx`, `BatchLaunchStatusToast.tsx`, `renderer/components/shared/SessionLaunchModelControls.tsx`, and `renderer/lib/linearBatchLaunch.ts` — multi-select batch launch: per-issue configuration, the single canonical model-picker Fast control, bounded-parallel create-lane → session → kickoff, and lifecycle-backed readiness/attention status.
- `renderer/components/settings/LinearSection.tsx` — Settings → Integrations connect/disconnect panel.
- `renderer/components/lanes/LinearIssueBadge.tsx` (+ `linearBrand.tsx`, `linearIssueDisplay.ts`, `linearProjectIcon.tsx`) — the lane-list badge and brand/display helpers.

### Shared and CLI

- `apps/desktop/src/shared/linearMagicWords.ts` — `Refs`/`Fixes` commit and PR magic-word injection (`ensureLinearCommitReference`, `ensureLinearPrReference`, `buildLinearPrTitle`, multi-issue linkage block).
- `apps/desktop/src/shared/linearIssueBranch.ts` — `linearIssueLaneName` / `linearIssueBranchName` derivation.
- `apps/desktop/src/shared/chatContextAttachments.ts` — the `linear_issue` chat context attachment shape.
- `apps/ade-cli/src/cli.ts` — the `ade linear` bridge (`buildLinearPlan`) routed over the daemon to the desktop runtime's Linear connection.

IPC channel names live in `apps/desktop/src/shared/ipc.ts` (registered in `registerIpc.ts`), reached via `window.ade.cto.*`; the lane-scoped session-attach channels are on `window.ade.lane.*`. See the [Read surface](#read-surface) and [Session-scoped issue attachment](#session-scoped-issue-attachment-and-cli-context-injection) sections for the exact channel lists.

## Connection model

Credentials are owned by `apps/desktop/src/main/services/cto/linearCredentialService.ts`, backed by the active project's `.ade/secrets` store, so separate ADE projects can attach separate Linear workspaces. Two connection paths:

1. **OAuth** (the primary "Sign in with Linear" path; bundled public client with PKCE). By default sign-in uses the **ADE Linear OAuth app** — its public client id (`ADE_LINEAR_APP_CLIENT_ID` in `cto/linearAppClient.ts`) ships with the app, and PKCE means no client secret is bundled. A user-configured custom OAuth client, when present, takes precedence; `linearCredentialService.getOAuthClientSource()` reports `"ade-app"` vs `"custom"` and `oauthConfigured` is now always `true` (the bundled client makes OAuth always available). The ADE app requests the `read,write,admin` scope, while a custom client keeps the narrower `read,write` — the `admin` scope is Linear's requirement for OAuth-app data-change webhooks, so a workspace that authorizes the ADE app gets its Linear webhook auto-provisioned (pointed at the ADE relay) and can drive automation Linear triggers with no manual "Connect Linear events" step. `linearOAuthService.ts` boots an ephemeral loopback server on port 19836, returns the authorize URL for the renderer to open, and finalizes on callback. The sign-in session expires after 10 minutes. The resulting access token (which Linear expires ~24h after sign-in) is refreshed automatically: `linearCredentialService.ensureFreshToken()` exchanges the stored `refresh_token` via `linearTokenRefresh.ts` proactively before requests and reactively on a 401, rotating the refresh token on success. `linearOAuthRefreshLock.ts` serializes refresh across processes. An `invalid_grant` clears the connection so the user re-authorizes; transient failures leave the token in place.
2. **Personal API key** — pasted into the connection panel, validated by a `viewer` query, stored the same way. It does not expire and is the alternative for headless use.

Until a token is stored, nothing binds and no background work runs — connecting is a deliberate act of storing a token.

## Read surface

- `linearClient.ts` — the GraphQL client (shared by desktop and the headless ADE CLI). Reads: `fetchIssueById`, `listProjects`, `searchIssues` (paginated), `getQuickView` (workspace + active-project counters), `fetchIssueComments`, `listLabels`, `listUsers`. The shared issue fragment also carries cycle metadata, label colors, and child-issue fields.
- `linearIssueTracker.ts` / `issueTracker.ts` — normalization into `NormalizedLinearIssue` plus `getQuickView` / `searchIssues` / `fetchIssueComments` read shims and the `updateIssueState` / `updateIssueAssignee` / `createComment` / `addLabel` write helpers used for lightweight issue updates.
- `linearGraphQLInput.ts` — GraphQL input builders shared by client and tracker.

Renderer surfaces over these reads:

- `renderer/components/app/LinearQuickViewButton.tsx` — top-bar button and deeplink receiver. When Linear is connected it opens a popover hosting the shared `LinearIssueBrowser`; it also receives `requestLinearIssueQuickView` deeplink events and shows a setup modal when the project or Linear connection is missing.
- `renderer/components/app/LinearIssueBrowser.tsx` — the full filter/search surface with checkbox multi-select (shift-click range, select-all), an issue detail pane that renders the comment thread (markdown) plus cycle and child-issue metadata, and per-project filter persistence in `localStorage`.
- `renderer/components/app/LinearIssueSelectModal.tsx` / `LinearIssueResolveModals.tsx` — single-issue select/resolve dialogs mounted from `CreateLaneDialog`, the quick view, and the chat composer.
- `renderer/components/lanes/LinearIssueBadge.tsx`, `linearBrand.tsx`, `linearIssueDisplay.ts`, `linearProjectIcon.tsx` — the lane-list badge, brand tokens (`LINEAR_BRAND`, `LinearMark`, `LinearStateIcon`, `LinearPriorityIcon`), and display/label helpers.
- `renderer/components/settings/LinearSection.tsx` — Settings → Integrations panel for connecting/disconnecting Linear and surfacing the connected workspace.

Mobile surfaces over the same reads:

- `apps/ios/ADE/Views/Linear/` — the Work top-bar Linear pane: grouped issue browser, detail view with description/comments/sub-issues, and a launcher for "New lane" or "Launch agent". The pane is UI orchestration only; it reuses the existing `cto.*` read RPCs and the existing lane/chat/CLI launch primitives exposed through sync.
- `apps/ios/ADE/App/DeepLinkRouter.swift` — routes `ade://linear-issue/<IDENT>` and the matching `https://ade-app.dev/open?type=linear-issue` handoff into the mobile pane when a project is open, otherwise bouncing the link to the paired Mac.

IPC (named in `apps/desktop/src/shared/ipc.ts`, registered in `registerIpc.ts`, reached via `window.ade.cto.*`): `ctoGetLinearConnectionStatus`, `ctoSetLinearToken`, `ctoClearLinearToken`, `ctoStartLinearOAuth`, `ctoGetLinearOAuthSession`, `ctoSetLinearOAuthClient`, `ctoClearLinearOAuthClient`, `ctoGetLinearProjects`, `ctoGetLinearQuickView`, `ctoGetLinearIssuePickerData`, `ctoSearchLinearIssues`, `ctoGetLinearIssueComments`. The mobile client drives the read subset through `cto.*` sync commands (see [`../cto/README.md`](../cto/README.md#sync-command-surface)).

## Lane attachment, commit references, and PR magic words

The everyday path: a developer picks a Linear ticket and creates a lane (or attaches it to a chat) to work on it. ADE exposes this in a few places sharing the same primitives:

- **Create a lane from a Linear issue.** `CreateLaneDialog` hosts a "Connect Linear issue" affordance (backed by `LinearIssueSelectModal` + the shared `LinearIssueBrowser`). Selecting an issue auto-derives the lane name (`linearIssueLaneName` → `IDENT title`) and branch name (`linearIssueBranchName` → `ident-title-slug`, sanitised against git ref rules — both in `apps/desktop/src/shared/linearIssueBranch.ts`), pre-fills the create form, and enforces a branch-collision check. The same picker is reached from the top-bar `LinearQuickViewButton` and the chat composer's Linear attach dialog, so all entry points produce identical lane shapes.
- **iOS lane or agent launch.** The mobile Linear pane mirrors the desktop issue browser's launch path: "New lane" creates a Linear-attached lane only, while "Launch agent" creates the lane and then starts either a chat or CLI session with the issue context and an editable kickoff prompt. If agent launch fails after the lane is created, the phone rolls the lane back through `deleteLane` before surfacing the error.
- **`lane_linear_issues` table.** `laneService.create` / `createChild` accept `linearIssue?: LaneLinearIssue`; the payload is upserted keyed by `(project_id, lane_id)` and hydrated into `LaneSummary.linearIssue` on every list/get.
- **Commit message prefix.** When a lane has a connected issue, `gitOperationsService.commitChanges` (and the AI commit-message generator) auto-prefix the subject with `Refs IDENT: …` via `ensureLinearCommitReference` (`apps/desktop/src/shared/linearMagicWords.ts`). Subjects already mentioning the identifier are left alone.
- **PR title + body magic word.** `prService.draftPrMetadata` / `createFromLane` and the renderer `CreatePrModal` default the PR title to `buildLinearPrTitle(issue)` (`IDENT: title`) and use `ensureLinearPrReference(body, issue, closeOnMerge)` to inject `Fixes IDENT` (closes the issue when the PR merges) or `Refs IDENT` (links without closing). The user toggles `closeLinearIssueOnMerge` from a checkbox in `CreatePrModal`; the same flag is forwarded by `syncRemoteCommandService` so phones drive the same behavior.
- **Multi-issue PR linkage.** Lanes can accumulate additional issues beyond the primary one (`LaneSummary.linearIssueLinks`, stored in `lane_linear_issue_links`). `prService.applyLinearPrLinkage` collects the primary plus every link with `includeInPr === true`, dedupes by issue id, and writes per-issue magic words plus a single idempotent "Linked Linear issues" markdown block (fenced by `<!-- ade:linear-links v=N -->` comments) into the PR body. Helpers live in `linearMagicWords.ts`.
- **Chat context attachment.** Chats opened on a Linear-connected lane automatically receive an `AgentChatLinearIssueContextAttachment` (`type: "linear_issue"`, `source: "lane_link"`) via `AgentChatPane`; the composer also supports manual attachment through `LinearIssueContextDialog`. Helpers live in `apps/desktop/src/shared/chatContextAttachments.ts`.

## Session-scoped issue attachment and CLI context injection

Issues can be attached to a **session** (chat or CLI) independently of any lane, so a standalone chat or an `ade chat` / `ade serve` CLI session can carry an attached issue even with no lane. The store is `session_linear_issues`; the lane service owns the surface over the **lane** IPC channels (`lanesAttachLinearIssueToSession`, `lanesDetachLinearIssueFromSession`, `lanesListLinearIssuesForSession`, `lanesListLinearIssuesForLaneSessions`, `lanesUnlinkLinearIssues`), exposed on `window.ade.lane.*`:

- `attachLinearIssueToSession({ chatSessionId, issues, role, source, includeInPr, closeOnMerge, evidence })` persists a `SessionLinearIssueLink` per issue (deduped), and when the session has a lane also mirrors each issue into `lane_linear_issue_links` (source `chat_attach`) without ever promoting the lane's primary issue.
- On agent spawn, `agentChatService` materializes the attached issues into a per-session context file and sets `ADE_LINEAR_ISSUE_IDS` and `ADE_LINEAR_CONTEXT_FILE` so the spawned agent (or `ade linear …`) reads issue context **without** Linear credentials.
- On PR open, `prService` fans out session → lane → Linear so a session-only issue still gets a PR attachment.

## Multi-select batch launch

From the quick view's `LinearIssueBrowser`, selecting multiple issues opens `renderer/components/app/BatchLaunchModal.tsx` — one unified dialog with a per-issue config row (model, reasoning effort, provider-supported Fast mode, editable kickoff prompt, editable branch override) plus a "default" config seeding every row, a `laneOnly` mode, and a `findIssueConflicts` duplicate guard that inspects both each lane's primary `linearIssue` and its `linearIssueLinks`. `SessionLaunchModelControls` delegates Fast mode to the model picker, so the launch row has one Fast toggle rather than a second local copy.

On submit, `renderer/lib/linearBatchLaunch.ts#runBatchLaunch` runs bounded-parallel (`BATCH_LAUNCH_CONCURRENCY = 3`) create-lane → create-session → send-kickoff per issue. Sibling failures never abort the pool; a failure before the durable agent session exists rolls back the lane so retries do not orphan lanes. Chat launch deliberately returns once the durable session exists while the kickoff turn continues in the background, so the per-issue state remains `initializing-agent` until `BatchLaunchAgentReadinessTracker` observes the session's first `user_message` / started lifecycle event. A failed kickoff becomes `agent-error` ("Needs attention") rather than a retryable lane-creation failure because the lane and chat already exist; `agentChatService` emits an error event if the detached kickoff promise rejects so this state cannot spin forever. Events that race ahead of the launch IPC response are buffered only while the current batch is registering session ids.

As soon as the launch returns its session, `LinearQuickViewButton` announces it through `chatSessionEvents.ts`. The Work and lane-scoped session hooks insert the chat optimistically and refresh in the background, while both session-list caches are invalidated so a forced read cannot reuse an older in-flight snapshot. This keeps the new tab/chat visible during concurrent launches rather than waiting for list-cache convergence. `BatchLaunchStatusToast.tsx` reports queued, lane creation, launch, initialization, ready, attention, and pre-session failure separately; successful batches auto-dismiss, while attention/failure rows remain visible. The orchestrator still returns `createdLaneIds`, `createdSessionIds`, and `failedIssueIds`, and `renderer/lib/launchedLanesHighlight.ts` signals the Lanes tab to open its stack drawer and pulse the newly launched agents (one-shot, 30s TTL).

## Live status round-trip

`linearLiveStatusService.ts` (`createLinearLiveStatusService`) reflects an ADE agent's progress back into Linear, reusing the `issueTracker` write surface — **no new credentials**. It is **gated OFF** by default and only runs when `ADE_LINEAR_LIVE_STATUS_ROUNDTRIP=1`:

- **On agent launch** (`onAgentLaunched`, wired from `main.ts`): move the issue to the team's "In Progress" state, self-assign it to the connected viewer, and post a branch-link comment. Workflow states are resolved once per team and cached; transitions are de-duped per issue per direction.
- **On PR open** (`onPrOpened`, from `prService`): comment the PR link onto each linked issue.
- **On merge** (`onIssueMerged`, from `main.ts`): move each linked issue to the team's Done state.

Every write is best-effort: failures are logged (`linear_live_status.*`) and de-dupe markers roll back so a transient failure can retry, but they never block the launch / PR / merge path.

## `ade linear` bridge

The `ade linear` CLI (`buildLinearPlan` in `apps/ade-cli/src/cli.ts`) is the issue attach/read bridge for CLI and remote sessions, routed over the daemon to the desktop runtime's Linear connection — no local API key needed. Subcommands: `attach` / `attach-issue`, `detach` / `detach-issue`, `issues`, `attached`, and `my-issues`. This is how a headless or CLI session attaches, lists, and reads issues; issue writes go through the same `issueTracker` surface over the bridge.

## Deeplinks and ADE attachments

`linearLaneCardService.ts` builds the "Open in ADE" Linear attachments for lanes, PRs, issue quick-view links, and chat sessions. Portable links use the canonical `https://ade-app.dev/open` web handoff; chat/lane links that are machine-local use the `ade://session/<id>?lane=<lane-id>` form. A teammate clicking from Linear lands in ADE and sees a setup modal when the project or connection is missing.

## Database tables

State lives in `.ade/ade.db` and replicates through cr-sqlite. Tables the live Linear surface writes:

- `lane_linear_issues` — the primary issue attached to a lane at create time, keyed by `(project_id, lane_id)`.
- `lane_linear_issue_links` — additional issues attached to a lane after creation (`role`, `source`, `include_in_pr`, `close_on_merge`, JSON `evidence`).
- `session_linear_issues` — session-scoped links (chat or CLI session), mirroring `lane_linear_issue_links` fields plus `lane_id`. Like the other CRR-converted Linear tables it carries no secondary UNIQUE index; uniqueness on `(project_id, session_id, issue_id, role)` is enforced in `upsertSessionLinearIssueLink` (delete-then-insert in a transaction).
- `linear_issue_claims` — active-claim ledger so two lanes don't drive the same issue simultaneously.

## Gotchas

- **Dormant until connected.** Until a token is stored, nothing fires and no listener binds. Tests should stub `getStatus().tokenStored` accordingly.
- **OAuth is loopback-only.** Port 19836 must be free; the service does not pick alternatives. Collisions surface as a startup error in the panel.
- **Token storage is per-app, not per-project.** `LinearConnectionStatus.storageScope` is `app`; switching projects does not change which workspace is attached unless the token is rotated.
- **Live status is off by default.** Nothing writes back to Linear on launch / PR / merge unless `ADE_LINEAR_LIVE_STATUS_ROUNDTRIP=1`; every hook short-circuits when the flag is unset.
- **CRR strips non-PK uniqueness.** Linear tables don't rely on secondary UNIQUE constraints for upserts; use explicit select-then-update or the delete-then-insert pattern instead of `ON CONFLICT(some_unique_col)`.

## Cross-links

- [`../cto/README.md`](../cto/README.md) — the CTO thread and its Linear read/write operator tools.
- [`../lanes/README.md`](../lanes/README.md) — lane creation and the `lane_linear_issues` hydration path.
- [`../chat/README.md`](../chat/README.md) — chat context attachments and session links.
- [`../automations/README.md`](../automations/README.md) — the automations Linear ingress (relay + ADE Linear OAuth app webhook) that turns `linear.*` events into automation triggers. Distinct from the removed CTO workflow ingress.
