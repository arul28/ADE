# CTO

The CTO is ADE's persistent, project-level operator identity. One identity per project, not a family of rotating chats or a constantly running daemon. It owns persistent identity, shared project understanding, worker management, Linear dispatch and sync, and the operator-facing chat surface.

The runtime is organized around one contract: the CTO tab should be usable as a daily chat surface without forcing every optional subsystem (Linear, OpenClaw, realtime ingress, budget telemetry) to fully hydrate on mount.

## Source file map

### Main services (apps/desktop/src/main/services/cto/)

- `ctoStateService.ts` — identity, core memory, session logs, daily logs, system-prompt preview; owns immutable doctrine, personality overlay, memory operating model, environment knowledge, and capability manifest constants.
- `workerAgentService.ts` — worker CRUD, worker identity, config revisions, org tree.
- `workerHeartbeatService.ts` — heartbeat policy and worker-activity telemetry.
- `workerBudgetService.ts` — budget snapshots per worker and CTO org.
- `workerRevisionService.ts` — worker config revision history.
- `workerTaskSessionService.ts` — task-scoped worker sessions.
- `workerAdapterRuntimeService.ts` — adapter lifecycle for claude-local / codex-local / process / openclaw-webhook.
- `linearCredentialService.ts` — personal API key storage, token status.
- `linearOAuthService.ts` — PKCE loopback OAuth flow on port 19836.
- `linearClient.ts` — Linear GraphQL client (shared by desktop and headless ADE CLI).
- `linearIssueTracker.ts` / `issueTracker.ts` — Linear issue cache and change detection.
- `flowPolicyService.ts` — canonical `LinearWorkflowConfig` (intake, workflows, migration), file-backed via `linearWorkflowFileService`.
- `linearWorkflowFileService.ts` — repo YAML persistence for workflows.
- `linearTemplateService.ts` — workflow template metadata.
- `linearIntakeService.ts` — issue intake rules (active/terminal state types).
- `linearRoutingService.ts` — match a normalized issue against the workflow list and produce a `LinearWorkflowMatchResult`.
- `linearIngressService.ts` — optional realtime webhook/relay ingress; auto-starts only if configured.
- `linearSyncService.ts` — background polling loop; short-circuits when idle/disconnected.
- `linearDispatcherService.ts` — launches target runs (employee_session, worker_run, mission, pr_resolution, review_gate), tracks run state, emits events.
- `linearCloseoutService.ts` — success/failure Linear state transitions, comments, proof attachment.
- `linearOutboundService.ts` — outbound Linear writes (state, comments, assignees).
- `openclawBridgeService.ts` — optional OpenClaw device pairing and bridge runtime state.

### Headless parity

- `apps/ade-cli/src/headlessLinearServices.ts` — wires the same CTO Linear services (client, tracker, template, workflow file, flow policy, routing, intake, outbound, closeout, dispatcher, sync, ingress) into the headless ADE CLI so `ADE CLI` acts as a drop-in Linear-capable runtime, not a read-only stub.

### Renderer (apps/desktop/src/renderer/components/cto/)

- `CtoPage.tsx` — the `/cto` shell. Four tabs: Chat, Team, Workflows, Settings. Lazy-loads history, budget, and external-ADE CLI registry.
- `AgentSidebar.tsx` — memoized worker tree; budget footer isolated so budget refresh does not rerender siblings.
- `OnboardingBanner.tsx` / `OnboardingWizard.tsx` — minimal first-run flow: personality preset only.
- `IdentityEditor.tsx` — editable identity surface (personality preset + custom overlay + model). No longer a full identity-prompt editor.
- `CtoSettingsPanel.tsx` — identity, core memory (project summary / conventions / preferences / focus / notes), external-ADE CLI access policy, onboarding reset.
- `CtoPromptPreview.tsx` — three-section prompt preview: doctrine, personality overlay, memory model.
- `TeamPanel.tsx` — worker editor and detail view.
- `WorkerCreationWizard.tsx` — two-step wizard: template selection then configure.
- `WorkerActivityFeed.tsx` — recent worker sessions and runs.
- `LinearConnectionPanel.tsx` — API key and OAuth connect surface.
- `LinearSyncPanel.tsx` / `LinearSyncPanel.test.ts` — workflow list, sync dashboard, run timeline, "Watch It Live" monitor.
- `OpenclawConnectionPanel.tsx` — advanced-only OpenClaw pairing.
- `identityPresets.ts` — re-exports from `shared/ctoPersonalityPresets`.
- `shared/designTokens.ts` — CTO-wide class patterns (`cardCls`, `stageCardCls`, `pipelineCanvasCls`, ACCENT palette, `WORKER_TEMPLATES`).
- `shared/AgentStatusBadge.tsx`, `shared/ConnectionStatusDot.tsx`, `shared/StepWizard.tsx`, `shared/TimelineEntry.tsx` — shared visual building blocks.
- `pipeline/` — the visual pipeline builder (see `pipeline-builder.md`). This is the newest surface; flagged fragile.

### Shared

- `apps/desktop/src/shared/ctoPersonalityPresets.ts` — `CTO_PERSONALITY_PRESETS` (strategic, professional, hands_on, casual, minimal, custom) with label, description, and `systemOverlay` body.
- `apps/desktop/src/shared/linearWorkflowPresets.ts` — `LinearWorkflowVisualPlan` type, `deriveVisualPlan`, `rebuildWorkflowSteps`, completion contract tables, step synthesis.
- `apps/desktop/src/shared/types/linearSync.ts` — `LinearWorkflowDefinition`, `LinearWorkflowTarget`, trigger groups, step types, closeout types.
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
3. **Memory operating model** — `CTO_MEMORY_OPERATING_MODEL` describes the four-layer continuity model (doctrine + long-term brief + current context + durable searchable memory) and the compaction/recovery rules.
4. **Environment knowledge** — `CTO_ENVIRONMENT_KNOWLEDGE` is a glossary of ADE entities (lanes, chats vs terminals vs subprocess agents, missions, workers, convergence, conflicts) plus the intent-to-tool routing guide. Distinguishes `spawnChat` from `createTerminal` from `spawn_agent` explicitly.
5. **Capability manifest** — `CTO_CAPABILITY_MANIFEST` lists the complete operator tool surface. It is intentionally kept in sync with `ctoOperatorTools.ts` tool registrations, not auto-generated.

These layers combine into `CtoSystemPromptPreview` which the onboarding and settings surfaces render verbatim, so the UI matches the runtime.

### Persistent state

On disk under `.ade/cto/`:

- `identity.yaml` — name, personality preset, custom overlay, model, reasoningEffort.
- `MEMORY.md` — long-term CTO brief (summary, conventions, preferences, active focus, notes).
- `CURRENT.md` — current working context (recent sessions, worker activity).
- `daily/YYYY-MM-DD.md` — append-only daily logs via `appendDailyLog`, `readDailyLog`, `listDailyLogs`.
- `openclaw-device.json` — durable paired-device identity (if OpenClaw connected).

Under `.ade/cache/openclaw/` (runtime, not git-tracked):

- bridge history, outbox, route cache, idempotency data.

Portability rule (Phase 6 W3): identity YAML and the project memory schema are git-tracked; runtime memory files, daily logs, and session state are local or ADE-sync only.

### Tab model (`CtoPage.tsx`)

| Tab | What loads | When |
| --- | --- | --- |
| Chat | CTO session, subordinate activity summary | Immediate |
| Team | Agents, revisions, worker core memory, worker runs | On tab activation |
| Workflows | `LinearSyncPanel` (dashboard + run detail + pipeline) | On tab activation; refresh debounced |
| Settings | Identity, core memory, session logs, external-ADE CLI registry, OpenClaw | On tab activation |

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
   -> workerAgentService / missionService / agentChatService / prService (target-specific launch)
   -> linearCloseoutService (on completion)
   -> renderer via emitRunEvent + ipc channel
   -> LinearSyncPanel dashboard / run timeline
```

## CTO operator tools

Registered in `ctoOperatorTools.ts` and exposed as ADE CLI actions to the CTO chat session. Organized by domain: lanes, chats, missions, workers, git, PRs, convergence, conflicts, files, context, processes, tests, terminals, Linear, automations, events, project health, computer use, budget, memory. When the CTO wants to surface something in the UI it returns an `OperatorNavigationSuggestion` instead of silently switching tabs.

The environment knowledge block inside the system prompt teaches intent-to-tool routing (e.g. "start a chat" -> `spawnChat`, "open a terminal" -> `createTerminal`). The capability manifest is injected in full, not summarized, so the CTO can pick the right tool even for less common actions.

## Cross-links

- `identity-and-memory.md` — personality presets, core memory, daily logs, post-compaction recovery.
- `pipeline-builder.md` — the new visual Linear workflow builder (fragile area).
- `linear-integration.md` — connection model, workflow engine, dispatcher, sync loop, ingress, headless parity.
- `workers.md` — worker creation wizard, team panel, adapter types, budgets.
- `onboarding.md` — `OnboardingBanner`, `OnboardingWizard`, identity editor.
- `../missions/README.md` — missions as a dispatch target.
- `../automations/README.md` — automations as event-driven rules; note CTO owns Linear intake, Automations never duplicate it.
- `../computer-use/README.md` — computer-use proof appears in workflow closeout.

## Current product contract

- Default chat path is light; subsystems hydrate only when their tab is active.
- Setup finishes without Linear; Linear connects after.
- Linear sync short-circuits when no workflows are enabled and no runs are active.
- Ingress only auto-starts when realtime config is actually present.
- Management surfaces (Team, Workflows, Settings) hydrate lazily without weakening persistent identity.
- OpenClaw is advanced config, not first-run.
- Headless ADE CLI uses the same Linear services, not a read-only fake.

## Gotchas and fragile areas

- **Pipeline builder** (`pipeline/`) is the newest surface. Nested `downstreamTarget` chain is stored recursively but edited as a flat list via `flattenTargetChain` / `rebuildTargetChain`. See `pipeline-builder.md` for the detailed mapping.
- **Identity re-injection after compaction** happens inside `refreshReconstructionContext()` — changes to the doctrine / personality / memory model or capability manifest must keep the preview and runtime in sync. The capability manifest is the single place to keep aligned with tool registrations.
- **Workflow match precedence** runs by `priority` descending; values inside a trigger group are OR-ed, populated groups are AND-ed. A `watchOnly` route logs a match without launching.
- **Dynamic employee delegation** — when routing resolves no employee, runs enter `awaiting_delegation` instead of dispatching to an invalid target. Do not assume dispatch always happens.
- **OpenClaw runtime migration** — legacy repo-visible runtime files are migrated into `.ade/cache/openclaw/` on startup. Keep the bridge service tolerant of missing-but-migratable files.
