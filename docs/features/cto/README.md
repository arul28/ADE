# CTO

The CTO is ADE's persistent, project-level operator identity. One identity per project, not a family of rotating chats or a constantly running daemon. It owns persistent identity, shared project understanding, worker management, Linear dispatch and sync, and the operator-facing chat surface.

The runtime is organized around one contract: the CTO tab should be usable as a daily chat surface without forcing every optional subsystem (Linear, realtime ingress, budget telemetry) to fully hydrate on mount.

## Source file map

### Main services (apps/desktop/src/main/services/cto/)

- `ctoStateService.ts` — identity, session logs, daily logs, system-prompt preview; owns immutable doctrine, personality overlay, CTO continuity model, environment knowledge, and capability manifest constants.
- `workerAgentService.ts` — worker CRUD, worker identity, config revisions, org tree.
- `workerHeartbeatService.ts` — heartbeat policy and worker-activity telemetry.
- `workerBudgetService.ts` — budget snapshots per worker and CTO org.
- `workerRevisionService.ts` — worker config revision history.
- `workerTaskSessionService.ts` — task-scoped worker sessions.
- `workerAdapterRuntimeService.ts` — adapter lifecycle for the three supported worker adapters: `claude-local`, `codex-local`, and `process`.
- `linearCredentialService.ts` — personal API key + OAuth client + auth-mode storage and token status. Backed by the active project's `.ade/secrets` store so separate ADE projects can use separate Linear workspaces, with a one-time migration from the legacy project-scoped files. See [Linear integration](../linear-integration/README.md#source-file-map).
- `linearOAuthService.ts` — PKCE loopback OAuth flow on port 19836.
- `linearClient.ts` — Linear GraphQL client (shared by desktop and headless ADE CLI). The shared issue fragment fetches cycle metadata, label colors, and enriched child-issue fields. `fetchIssueComments(issueId)` returns the comment thread for the issue detail pane. `addIssueLabel(issueId, labelId)` / `removeIssueLabel(issueId, labelId)` add/remove a label by id (back the `ade linear label` write-bridge command).
- `linearIssueTracker.ts` / `issueTracker.ts` — Linear issue cache, change detection, `fetchIssueComments` forwarding, and the `addIssueLabel` / `removeIssueLabel` write surface alongside the existing `updateIssueState` / `updateIssueAssignee` / `createComment` / `addLabel` writes.
- `linearLiveStatusService.ts` — optional live status round-trip that reflects an ADE agent's progress (launch → In Progress + self-assign + branch comment; PR open → PR-link comment; merge → Done) back into Linear via the existing `issueTracker` write surface. Gated OFF unless `ADE_LINEAR_LIVE_STATUS_ROUNDTRIP=1`. See [Linear integration](../linear-integration/README.md#live-status-round-trip).
- `flowPolicyService.ts` — canonical `LinearWorkflowConfig` (intake, workflows, migration), file-backed via `linearWorkflowFileService`.
- `linearWorkflowFileService.ts` — repo YAML persistence for workflows.
- `linearTemplateService.ts` — workflow template metadata.
- `linearIntakeService.ts` — issue intake rules (active/terminal state types).
- `linearRoutingService.ts` — match a normalized issue against the workflow list and produce a `LinearWorkflowMatchResult`.
- `linearIngressService.ts` — optional realtime webhook/relay ingress; auto-starts only if configured.
- `linearSyncService.ts` — background polling loop; short-circuits when idle/disconnected.
- `linearDispatcherService.ts` — launches target runs (employee_session, worker_run, run, pr_resolution, review_gate), tracks run state, emits events.
- `linearCloseoutService.ts` — success/failure Linear state transitions, comments, proof attachment.
- `linearOutboundService.ts` — outbound Linear writes (state, comments, assignees).

### Runtime daemon parity

- `apps/ade-cli/src/headlessLinearServices.ts` — wires the same CTO Linear services (client, tracker, template, workflow file, flow policy, routing, intake, outbound, closeout, dispatcher, sync, ingress) into the `ade serve` runtime daemon, plus a headless `workerHeartbeatService`, `workerTaskSessionService`, and the supporting `fileService` / `processService` / `prService` / `automationSecretService` instances the dispatcher needs to actually launch targets. The CTO is no longer "desktop-only" — every Linear capability runs identically inside the daemon, so a headless host can intake issues, dispatch worker runs, and close out tickets with the same code path the desktop renderer drives.

### Renderer (apps/desktop/src/renderer/components/cto/)

- `CtoPage.tsx` — the `/cto` shell. Four tabs: Chat, Team, Workflows, Settings. Lazy-loads history and budget data.
- `AgentSidebar.tsx` — memoized worker tree; budget footer isolated so budget refresh does not rerender siblings.
- `OnboardingBanner.tsx` / `OnboardingWizard.tsx` — minimal first-run flow: personality preset only.
- `IdentityEditor.tsx` — editable identity surface (personality preset + custom overlay + model). No longer a full identity-prompt editor.
- `CtoSettingsPanel.tsx` — identity, recent sessions, and onboarding reset.
- `CtoPromptPreview.tsx` — prompt preview: doctrine, personality overlay, CTO continuity, environment knowledge, and capabilities.
- `TeamPanel.tsx` — worker editor and detail view.
- `WorkerCreationWizard.tsx` — two-step wizard: template selection then configure.
- `WorkerActivityFeed.tsx` — recent worker sessions and runs.
- `LinearConnectionPanel.tsx` — API key and OAuth connect surface.
- `LinearSyncPanel.tsx` / `LinearSyncPanel.test.ts` — workflow list, sync dashboard, run timeline, "Watch It Live" monitor.
- `identityPresets.ts` — re-exports from `shared/ctoPersonalityPresets`.
- `shared/designTokens.ts` — CTO-wide class patterns (`cardCls`, `stageCardCls`, `pipelineCanvasCls`, ACCENT palette, `WORKER_TEMPLATES`).
- `shared/AgentStatusBadge.tsx`, `shared/ConnectionStatusDot.tsx`, `shared/StepWizard.tsx`, `shared/TimelineEntry.tsx` — shared visual building blocks.
- `pipeline/` — the visual pipeline builder (see `pipeline-builder.md`). This is the newest surface; flagged fragile.

### Shared

- `apps/desktop/src/shared/ctoPersonalityPresets.ts` — `CTO_PERSONALITY_PRESETS` (strategic, professional, hands_on, casual, minimal, custom) with label, description, and `systemOverlay` body.
- `apps/desktop/src/shared/linearWorkflowPresets.ts` — `LinearWorkflowVisualPlan` type, `deriveVisualPlan`, `rebuildWorkflowSteps`, completion contract tables, step synthesis.
- `apps/desktop/src/shared/types/linearSync.ts` — `LinearWorkflowDefinition`, `LinearWorkflowTarget`, trigger groups, step types, closeout types. `NormalizedLinearIssue` carries cycle metadata, per-label colors, and structured child issues.
- `apps/desktop/src/shared/types/cto.ts` — `CtoGetLinearIssueCommentsArgs` and `CtoLinearIssueComment` types for the issue detail comment thread.
- `apps/desktop/src/main/services/ai/tools/ctoOperatorTools.ts` — complete operator tool surface registered for CTO chat sessions.

### iOS companion (apps/ios/ADE/Views/Cto/)

- `CtoTabShell.swift` — segmented mobile shell for Chat / Team /
  Workflows with shared glass navigation styling.
- `CtoTeamScreen.swift` — worker roster, hire action, worker rows,
  quick actions, and per-worker context menus.
- `CtoWorkflowsScreen.swift` — mobile workflow dashboard, policy list,
  recent sync events, and connection/not-connected states backed by the
  same Linear workflow command surface as desktop.

## Domain model

### Identity layers (immutable to user-editable, in order)

1. **Immutable doctrine** — `IMMUTABLE_CTO_DOCTRINE` in `ctoStateService.ts`. Defines the CTO role, ADE environment, precision rules. Always injected. Not user-editable. Not compacted away. Runs even after context compaction via `refreshReconstructionContext()`.
2. **Personality overlay** — one of six presets (`strategic`, `professional`, `hands_on`, `casual`, `minimal`, `custom`). Only the `custom` preset reads `customPersonality` from the identity record.
3. **CTO continuity model** — the runtime describes doctrine, current context, and compaction/recovery rules.
4. **Environment knowledge** — `CTO_ENVIRONMENT_KNOWLEDGE` is a glossary of ADE entities (lanes, chats vs terminals vs subprocess agents, runs, workers, convergence, conflicts) plus the intent-to-tool routing guide. Distinguishes `spawnChat` from `createTerminal` from `spawn_agent` explicitly.
5. **Capability manifest** — `CTO_CAPABILITY_MANIFEST` lists the complete operator tool surface. It is intentionally kept in sync with `ctoOperatorTools.ts` tool registrations, not auto-generated.

These layers combine into `CtoSystemPromptPreview` which the onboarding and settings surfaces render verbatim, so the UI matches the runtime.

### Persistent state

On disk under `.ade/cto/`:

- `identity.yaml` — name, personality preset, custom overlay, model, reasoningEffort.
- `CURRENT.md` — current working context (recent sessions, worker activity).
Portability rule: identity YAML is git-tracked; generated CTO continuity files and session state are local or ADE-sync only.

### Tab model (`CtoPage.tsx`)

| Tab | What loads | When |
| --- | --- | --- |
| Chat | CTO session, subordinate activity summary | Immediate |
| Team | Agents, revisions, worker runs | On tab activation |
| Workflows | `LinearSyncPanel` (dashboard + run detail + pipeline) | On tab activation; refresh debounced |
| Settings | Identity and session logs | On tab activation |

The CTO tour switches tabs through `ade:tour-cto-tab` before the Team
and Workflows steps. The first-run journey wraps those CTO steps but
preserves their `beforeEnter` hooks, so the correct tab is active
before each wrapped anchor is awaited.

The sidebar worker tree is precomputed and memoized. The budget footer is isolated so a budget refresh does not rerender the tree.

## Wiring and IPC

The renderer never reaches into services directly. It goes through `window.ade.cto`, `window.ade.linearSync`, `window.ade.automations`, etc. (see `apps/desktop/src/preload/preload.ts` and `global.d.ts`). The main process registers those handlers in `apps/desktop/src/main/services/ipc/registerIpc.ts` and dispatches to the service instances created during project bootstrap.

Event flow for a Linear workflow run:

```
Linear poll / webhook
   -> linearIngressService (optional realtime path)
   -> linearSyncService (reconciliation loop)
   -> linearRoutingService (match triggers against LinearWorkflowConfig)
   -> linearDispatcherService (launch target; emit linear-workflow-run events)
   -> workerAgentService / agentChatService / prService (target-specific launch)
   -> linearCloseoutService (on completion)
   -> renderer via emitRunEvent + ipc channel
   -> LinearSyncPanel dashboard / run timeline
```

## CTO operator tools

Registered in `ctoOperatorTools.ts` and exposed as ADE CLI actions to the CTO chat session. Organized by domain: lanes, chats, workers, git, PRs, convergence, conflicts, files, context, processes, tests, terminals, Linear, automations, events, project health, computer use, budget, and CTO continuity. When the CTO wants to surface something in the UI it returns an `OperatorNavigationSuggestion` instead of silently switching tabs.

The environment knowledge block inside the system prompt teaches intent-to-tool routing (e.g. "start a chat" -> `spawnChat`, "open a terminal" -> `createTerminal`). The capability manifest is injected in full, not summarized, so the CTO can pick the right tool even for less common actions.

## Cross-links

- `../agents/identity-and-personas.md` — personality presets, identity reconstruction, daily logs, post-compaction recovery.
- `pipeline-builder.md` — the new visual Linear workflow builder (fragile area).
- `linear-integration.md` — connection model, workflow engine, dispatcher, sync loop, ingress, headless parity.
- `workers.md` — worker creation wizard, team panel, adapter types, budgets.
- `onboarding.md` — `OnboardingBanner`, `OnboardingWizard`, identity editor.
- `../automations/README.md` — automations as event-driven rules; note CTO owns Linear intake, Automations never duplicate it.
- `../computer-use/README.md` — computer-use proof appears in workflow closeout.

## Current product contract

- Default chat path is light; subsystems hydrate only when their tab is active.
- Setup finishes without Linear; Linear connects after.
- Linear sync short-circuits when no workflows are enabled and no runs are active.
- Ingress only auto-starts when realtime config is actually present.
- Management surfaces (Team, Workflows, Settings) hydrate lazily without weakening persistent identity.
- The `ade serve` runtime daemon uses the same Linear services as the desktop renderer; the CTO is not a desktop-only feature.
- Worker adapter type is one of `claude-local`, `codex-local`, or `process`. There are no other adapter types — anything that needs to wrap an external service does so as a `process` adapter.

## Gotchas and fragile areas

- **Pipeline builder** (`pipeline/`) is the newest surface. Nested `downstreamTarget` chain is stored recursively but edited as a flat list via `flattenTargetChain` / `rebuildTargetChain`. See `pipeline-builder.md` for the detailed mapping.
- **Identity re-injection after compaction** happens inside `refreshReconstructionContext()` — changes to the doctrine, personality, CTO continuity model, or capability manifest must keep the preview and runtime in sync. The capability manifest is the single place to keep aligned with tool registrations.
- **Workflow match precedence** runs by `priority` descending; values inside a trigger group are OR-ed, populated groups are AND-ed. A `watchOnly` route logs a match without launching.
- **Dynamic employee delegation** — when routing resolves no employee, runs enter `awaiting_delegation` instead of dispatching to an invalid target. Do not assume dispatch always happens.
