# ADE Work-tab Chat Orchestrator — Implementation Spec (goal.md)

> **You are reading the hand-off spec.** It is self-contained: you do not need the prior planning conversation. Supplements `/Users/arul/ADE/plans/orch.md` (locked product shape) with concrete data models, IPC, tool sets, UI, workflow, build order, and testing.
>
> **Single bundled PR.** The ADE mission system is being uprooted in the *next* PR — this work must not depend on `apps/desktop/src/main/services/orchestrator/*`, `apps/desktop/src/renderer/components/missions/*`, `missionService.ts`, `chatMessageService.ts`, `coordinatorTools.ts`, or `OrchestratorChatThread` types. Borrow concepts, not code.
>
> **Final gate.** After implementation, run `/Users/arul/ADE/.claude/commands/audit.md` against the diff and resolve P0/P1 findings.

---

## Table of contents

1. [Context](#1-context)
2. [Locked decisions](#2-locked-decisions)
3. [Architecture](#3-architecture)
4. [Data model](#4-data-model)
5. [IPC surface](#5-ipc-surface)
6. [Tool sets per role](#6-tool-sets-per-role)
7. [System prompt + skill (`.agents/skills/ade-orchestrator/SKILL.md`)](#7-system-prompt--skill)
8. [Inter-agent ping system (per-runtime capability matrix)](#8-inter-agent-ping-system)
9. [Cancellation with smart revert](#9-cancellation-flow)
10. [UI components (full UI spec)](#10-ui-components)
11. [Live-editable plan](#11-live-editable-plan-v1)
12. [Permission profiles per provider](#12-permission-profiles-per-provider)
13. [Model routing](#13-model-routing)
14. [Validation as universal concerns](#14-validation-as-universal-concerns)
15. [User authority overrides defaults](#15-user-authority-overrides-defaults)
16. [Hardening (must-fix before ship)](#16-hardening-must-fix-before-ship)
17. [Build order](#17-build-order)
18. [Testing strategy](#18-testing-strategy)
19. [Critical files](#19-critical-files)
20. [Open items, deferred to v2, risks](#20-open-items-deferred-to-v2-risks)
21. [Final audit gate](#21-final-audit-gate)

---

## 1. Context

The orchestrator is a Work-tab-native multi-agent coordinator that lives entirely on top of ADE's existing chat surface. One chat becomes the **lead** planner/dispatcher; it spawns ordinary ADE chats as **workers** and **validators** in the same lane; they coordinate through a filesystem-resident **ground-truth bundle** (`manifest.json` + `plan.md` + `artifacts/`). The user can see and message any chat at any time.

The design borrows ideas (not code) from three reference systems:

- **Claude Code agent teams** — shared task list, claim discipline, lead synthesis. <https://code.claude.com/docs/en/agent-teams>
- **Factory.ai missions** — planning-first, validators as a distinct role, milestone+feature decomposition, Mission Control as the truth artifact. <https://docs.factory.ai/cli/features/missions>
- **Cursor /orchestrate + Cursor plan mode** — planner/worker/verifier separation, structured handoffs, interactive plan-mode UX.

ADE extends them by:
- treating the **manifest** as live mutable state every agent reads/writes;
- wiring **HTML design specs + the existing ADE built-in browser + the existing inspect-to-chat pipeline** into the planning loop;
- supporting **live plan edits** that propagate to in-flight workers;
- letting the user **pick a model per (role × tag) pair** at Planning time via ADE's in-house model picker (NOT a flat option list);
- **treating user instructions as authoritative** — defaults are advisory, the user can waive or alter any rule at any time, including mid-run.

The orchestrator is **provider-agnostic from day one**: Claude Agent SDK, Codex App-Server JSON-RPC, Cursor (local SDK + cloud), Droid, OpenCode. Lead and workers/validators may run on different providers.

---

## 2. Locked decisions

Every entry is canon. They came out of a long planning deliberation; do not relitigate without the user.

| Area | Decision |
|---|---|
| **This document** | `/Users/arul/ADE/.ade/worktrees/orchestrator-2e3a194b/goal.md`. Spec for the implementing agent only. The orchestrator does not read or write `goal.md` at runtime. |
| **Providers** | All five from day one. |
| **Macro phases** | `Planning → Developing → Validating` (+ optional `Wrap-up`). Planner-owned sub-stages. |
| **Roles** | `lead`, `developer`, `validator`. Lead never edits files. |
| **Q&A cadence** | Adaptive — model picks are one batched askUser per wave; scope, tags, validation are one-at-a-time. |
| **Tag taxonomy** | Project-specific, lead-derived. Lead inspects repo silently, proposes, asks user to confirm/edit. |
| **Model picker per (role, tag)** | New `PendingInputKind: "model_selection"` surfaces ADE's existing `ModelPicker` UI; user picks model + fast-mode + reasoning. Permission tier is locked to the provider's highest. NEVER a flat option list. |
| **Plan-approval gate** | Explicit user approval before the lead may spawn any worker. |
| **Live plan edits** | Mid-run. v1: right panel is **read-only** render; user edits propagate by talking to the lead in chat (lead patches manifest). Direct in-panel editing is v2. |
| **Lead chat chrome** | Animated **conic-gradient border ring** around the chat surface (1–2 px). `prefers-reduced-motion` → static rainbow border. Only on lead chats. |
| **Right panel** | Single **unified view** (no multi-tab dock). The Browser is the existing Work-tab sidebar surface and **NOT** duplicated. |
| **Phases UI** | Collapsible accordion; active phase auto-expanded; per-phase progress chip. |
| **Task cards** | Expanded with full metadata: title, tag chip, status pill, description preview, file anchors, owner, elapsed time, validation badges (click-for-evidence). |
| **Markdown engine** | Dual — keep `ChatMarkdown` for chat surface; add `react-markdown` + `remark-gfm` + `remark-mermaid` + `rehype-slug` + `rehype-raw` for the plan view only. |
| **Empty state** | Live "Planning in progress" with the Q&A history. |
| **Asset previews** | Inline where possible. HTML specs render as live sandboxed iframe thumbnails (~240×180); "Open in ADE browser" link beside. Mermaid renders inline. Screenshots inline at natural size with max-width clamp. |
| **Annotations** | **Pure ephemeral.** Select text/image/diagram/HTML → comment → injects into lead chat as a user message → vanishes from the plan view. NO persistence to manifest in v1. |
| **Sidebar grouping** | Flat list. Role badges (`LEAD` purple, `WORKER` blue + tag, `VALIDATOR` green + concern) on `SessionCard.tsx`. |
| **Worker session title** | Goal-summary first (e.g. "Build login form"); role/tag chip beside. |
| **Heartbeat cadence** | Every tool call (orchestration tool wrapper bumps `agents[me].lastHeartbeatAt` free). |
| **Cancellation** | Lead's `messageAgent(kind:"interrupt-replace", intent:"cancellation", cancellation:{revert: true \| false \| "review", reason})`. Worker reads, halts, then full revert via git checkout / leave / askUser. |
| **Validator findings** | Spawn fix-task that `supersedes: T-original`. Lead notices, messages original worker with directive. Loop until validator passes. |
| **Manual spawn (user → worker)** | No, lead-only in v1. |
| **Wake-up** | Worker pings lead on every action affecting another agent — done/failed, manifest patch on shared state, asset registration, error. Inter-worker pings **always go through the lead**. |
| **Spawn brief** | Lead composes free-form; skill mandates required sections: `## TASK / ## FILES / ## DEPENDENCIES / ## GATES / ## PEERS / ## SUCCESS`. Server-side `spawnAgent` validates section presence. |
| **Peer context** | Full peer roster in every spawn brief (who, role, tag, current task, status). |
| **Ping visibility** | Regular user-role messages with `metadata.orchestrationOrigin = { runId, fromSessionId, kind, intent, taskId? }`. UI renders a small "from <agent>" purple chip in the message header. Receiving agent reads metadata to know the source. |
| **Idle heartbeat** | Lazy. Service does NOT auto-inject. On any incoming lead message (worker ping, user msg), if >5 min since lead's last turn, the system prompt is enriched with `## Since you last replied (Xm): summary`. |
| **Ping primitives** | Three: `queue` / `interrupt-replace` / `wake`. Caller picks explicitly; skill includes the per-runtime capability table (§8) so the lead knows what each target supports. |
| **Spoofing hardening** | None in v1. Skill discipline only. |
| **Schema reservations** | All in (attempts, budget, spawnFingerprint, labels, priority, supersedes, checklist.runs, schemaCompatibility, leadState, history). Cheap now, expensive later. |
| **Validation principles** | Universal concerns (NOT hardcoded `audit_like`/`automate_like`/`finalize_like` kinds with baked-in ADE behavior). Planner inspects codebase → detects applicable concerns → asks user where uncertain → writes codebase-specific validation steps into manifest. |
| **No PR handoff, no doc-structure assumptions** | Orchestrator's scope ends at `Validating` complete. It does not push, open PRs, or assume any particular doc/test/CI structure. |
| **User authority** | Authoritative. Any default in the skill can be waived by direct user instruction. Logged to `manifest.userOverrides`. No re-prompting. |

---

## 3. Architecture

Lane-local. Single new main-process service (`orchestrationService`) owns the bundle and IPC. Renderer mounts a right-side panel when the active session is part of a run. Tool sets compose from `createUniversalToolSet`'s existing branch site.

```
                              ┌──────────────────────────────────────┐
                              │ User (composer + plan-panel + chat) │
                              └───────────────┬──────────────────────┘
                                              │ ade:agent-chat:* events
                                              ▼
              ┌──────────────────────────────────────────────────────┐
              │ Lead chat (interactionMode = orchestrator-lead)      │
              │ • ade-orchestrator skill + orchestrator system prompt│
              │ • tools: spawnAgent, messageAgent, getAgentTranscript│
              │   manifestPatch, planAppend, askUserForModelSelection│
              │   askUser, registerAsset + read-only base.           │
              │ • NO editFile / writeFile / bash / exitPlanMode.     │
              └────────────┬───────────────────────────────────┬─────┘
                           │ IPC                               │ subscribe
                           ▼                                   ▼
         ┌────────────────────────────────┐         ┌─────────────────────┐
         │ orchestrationService (NEW)     │◀───────▶│ Right plan panel    │
         │ • bundle CRUD, etag, mutex     │ events  │ (NEW, unified view) │
         │ • spawn/inject/transcript-read │         └─────────────────────┘
         │ • chokidar watcher (debounced) │
         └─────────┬──────────────────┬───┘
                   │ fs writes        │ agentChatService.spawn / inject / steer
                   ▼                  ▼
   ┌────────────────────────────┐   ┌──────────────────────────────────────┐
   │ .ade/orchestration/<runId> │   │ Worker/Validator chats (lane-local)  │
   │   manifest.json (etag)     │◀──│ • orchestrationRole + runId          │
   │   plan.md (append-only)    │   │ • tightened tool set + skill rules   │
   │   artifacts/, artifacts/ui │   │ • patch manifest, append plan        │
   └────────────────────────────┘   └──────────────────────────────────────┘
```

---

## 4. Data model

### 4.1 Session schema additions

Extend `AgentChatSession` and `AgentChatSessionSummary` in `apps/desktop/src/shared/types/chat.ts:731+`:

```ts
export type OrchestrationRole = "lead" | "worker" | "validator";

// Existing AgentChatInteractionMode = "default" | "plan" → extend:
export type AgentChatInteractionMode =
  | "default" | "plan"
  | "orchestrator-lead" | "orchestrator-worker" | "orchestrator-validator";

// Added on session + summary:
orchestrationRunId?: string;
orchestrationRole?: OrchestrationRole;
orchestrationParentSessionId?: string;
orchestrationTag?: string;
orchestrationStepId?: string;
orchestrationBundlePath?: string;
```

Persist through the existing `persistChatState(managed)` path alongside `identityKey` / `surface` / `automationId`. All fields optional for migration tolerance.

### 4.2 Manifest schema

New file `apps/desktop/src/shared/types/orchestration.ts`:

```ts
export const ORCHESTRATION_MANIFEST_VERSION = 1;

export type OrchestrationPhaseId = "planning" | "developing" | "validating" | "wrapup";

export type OrchestrationManifest = {
  version: 1;
  schemaCompatibility?: { minReader: 1; maxKnown: 1 };
  runId: string;
  laneId: string;
  bundlePath: string;
  etag: string;                  // monotonic; bumped on every patch
  serverGeneration: number;      // monotonic across git-checkouts; persisted at .gen
  createdAt: string; updatedAt: string;
  title: string;
  goalSummary: string;
  currentPhase: OrchestrationPhaseId;
  phases: OrchestrationPhase[];
  agents: OrchestrationAgent[];
  tasks: OrchestrationTask[];
  validationStrategy: ValidationStrategy;
  modelRouting: ModelRouting;
  assets: OrchestrationAsset[];
  decisions: DecisionLogEntry[];
  userOverrides: UserOverrideEntry[];
  leadState: { lastSnapshotEtag?: string; lastSnapshotSeenAt?: string };
  history: Array<{ etag: string; at: string; summary: string; patchKindSummary?: string }>;  // ring buffer (last 50)
  defaultBudget?: AgentBudget;

  // v2 reservations (present in v1 schema; unused):
  coordinatorSessionId?: string;
  peerRunIds?: string[];
  parentRunId?: string;
  forkedAtEtag?: string;
  forkReason?: string;
};

export type OrchestrationPhase = {
  id: OrchestrationPhaseId;
  title: string;
  status: "pending" | "active" | "done" | "skipped";
  startedAt?: string; completedAt?: string;
};

export type OrchestrationAgent = {
  sessionId: string;
  role: OrchestrationRole;
  tag?: string;
  displayName?: string;
  goalSummary: string;
  status: "pending" | "running" | "blocked" | "completed" | "failed";
  currentStepId?: string;
  cancellationRequested?: boolean;  // §9
  lastHeartbeatAt?: string;
  spawnedAt: string;
  spawnFingerprint?: SpawnFingerprint;
  budget?: AgentBudget;
  usage?: { tokensIn?: number; tokensOut?: number; costUsd?: number; turns?: number; elapsedMs?: number };
};

export type SpawnFingerprint = {
  provider: AgentChatProvider;
  modelId: string;
  reasoningEffort?: string | null;
  codexFastMode?: boolean;
  resolvedAt: string;
  routingKey: "byRoleTag" | "byTag" | "byRole" | "default" | "fallback" | "override";
};

export type AgentBudget = {
  maxTokens?: number; maxCostUsd?: number;
  maxWallClockMs?: number; maxTurns?: number;
  onExceeded?: "pause" | "interrupt" | "warn";
};

export type OrchestrationTask = {
  id: string;                              // stable
  phaseId: OrchestrationPhaseId;
  title: string; description: string;
  status: "pending" | "claimed" | "in_progress" | "review" | "done" | "failed";
  blockedBy?: string[]; blocks?: string[];
  supersedes?: string[]; supersededBy?: string[];   // for validator fix-tasks
  relatedTaskIds?: string[];               // v2 reservation
  filesHint?: string[];
  tag?: string;
  labels?: string[];
  priority?: "low" | "normal" | "high" | "critical";
  estimatedComplexity?: "trivial" | "small" | "medium" | "large" | "spike";
  assigneeSessionId?: string;
  claimedAt?: string; claimLeaseUntil?: string;
  attempts?: OrchestrationTaskAttempt[];   // append-only history
  currentAttemptId?: string;
  evidence?: EvidenceRef[];
  validationGate: { required: boolean; stepIds: string[] };
  humanOverride?: { byUserId?: string; at: string; fromStatus: OrchestrationTask["status"]; toStatus: OrchestrationTask["status"]; reason?: string };
};

export type OrchestrationTaskAttempt = {
  id: string;
  sessionId: string;
  startedAt: string; endedAt?: string;
  outcome: "succeeded" | "failed" | "interrupted" | "cancelled" | "superseded";
  evidence?: EvidenceRef[];
  failureReason?: string;
};

// Validation — universal concerns (NOT hardcoded ADE-specific kinds)
export type ValidationConcern =
  | "reverify_changes"        // audit principle (recommended default for every worker)
  | "test_suite_truthfulness" // automate principle (only when codebase has tests)
  | "surface_parity"          // automate principle (only when ancillary surfaces exist)
  | "pre_completion_gate"     // finalize principle minus PR-handoff (when codebase has CI rubric)
  | "deep_maintainability"    // thermal principle (opt-in for high-risk diffs)
  | "custom";                 // planner-defined

export type ValidationStrategy = {
  steps: ValidationStep[];
  checklist: ValidationChecklistItem[];
};

export type ValidationStep = {
  id: string;
  concern: ValidationConcern;
  scope: "per_worker" | "per_step" | "mission_exit";
  required: boolean;
  prompt: string;                          // PLANNER-DERIVED, codebase-specific. See §14.
  evidenceRequired: ("plan_md_section" | "manifest_checklist" | "diff_summary" | "screenshot" | "test_log")[];
  appliesToTaskIds?: string[];             // empty = all tasks in scope
};

export type ValidationChecklistItem = {
  id: string;
  stepId: string;
  taskId?: string;                         // null = mission-level
  runs: ValidationChecklistRun[];          // append-only
  latestRunId: string;
};

export type ValidationChecklistRun = {
  id: string;
  runBySessionId: string;
  status: "running" | "passed" | "failed";
  attachedEvidence?: EvidenceRef[];
  notes?: string;
  startedAt: string; endedAt?: string;
  supersedes?: string;                     // prior run id (re-runs preserve history)
};

export type EvidenceRef =
  | { kind: "plan_md_section" | "artifact" | "screenshot" | "test_log"; path: string; sha256?: string; range?: { startLine: number; endLine: number } }
  | { kind: "transcript_excerpt"; sessionId: string; turnId: string; range?: { startCharOffset: number; endCharOffset: number } }
  | { kind: "external_url"; url: string };  // v2-shaped; harmless in v1

export type ModelRouting = {
  default?: ModelSelection;
  byRole?: Partial<Record<OrchestrationRole, ModelSelection>>;
  byTag?: Record<string, ModelSelection>;
  byRoleTag?: Record<string, ModelSelection>;     // key = `${role}:${tag}`
};

export type ModelSelection = {
  provider: AgentChatProvider;
  modelId: string;
  reasoningEffort?: string | null;
  codexFastMode?: boolean;
};

export type OrchestrationAsset = {
  id: string; path: string;                // relative to bundle root
  kind: "html_spec" | "screenshot" | "test_log" | "doc";
  version: number;
  approval?: "pending" | "approved" | "rejected";
  notes?: string;
};

export type DecisionLogEntry = {
  id: string; at: string;
  source: "user" | "lead" | "worker" | "validator";
  summary: string;
  refs?: { taskId?: string; stepId?: string; assetId?: string };
};

export type UserOverrideEntry = {
  id: string; at: string;
  scope: "session" | "phase" | "task" | "step";
  appliedToId?: string;
  instruction: string;                     // user's literal words
  affectedDefault?: string;                // skill rule that was overridden
};
```

### 4.3 Bundle layout

```
<lane-worktree>/.ade/orchestration/<runId>/
  manifest.json
  plan.md
  .gen                          # monotonic serverGeneration counter (outside manifest, see §16.7)
  artifacts/
    ui/<spec>.html
    evidence/<*.png|*.log|*.md>
```

`<lane-worktree>` resolved via `managed.laneWorktreePath` (`apps/desktop/src/main/services/chat/agentChatService.ts:14193`).

### 4.4 Shared-types additions

`PendingInputKind` (`apps/desktop/src/shared/types/chat.ts:692`):

```ts
"approval" | "question" | "structured_question" | "permissions" | "plan_approval" | "model_selection"
```

For `model_selection`, `providerMetadata` carries `{ role; tag; availableModels: ModelCatalogSnapshot; suggested?: ModelSelection }`. Resolved via `IPC.agentChatRespondToInput` with `{ selection: ModelSelection }`.

---

## 5. IPC surface

All channels in `apps/desktop/src/shared/ipc.ts`; handlers in `apps/desktop/src/main/services/ipc/registerIpc.ts` next to the existing `agentChat*` cluster (line 6463+). Service file: `apps/desktop/src/main/services/orchestration/orchestrationService.ts` (NEW; deliberately under `services/orchestration/` singular, NOT `services/orchestrator/` which is being deleted).

| Channel | Args | Return | Purpose |
|---|---|---|---|
| `orchestrationRunCreate` | `{ laneId; leadSessionId; title?; goalSummary? }` | `{ runId; manifest; etag }` | Bootstrap bundle with `phases:[planning]` and `agents:[lead]`. |
| `orchestrationBundleRead` | `{ runId }` | `{ manifest; planMd; etag }` | Atomic full read. |
| `orchestrationManifestReadSection` | `{ runId; section: "tasks" \| "agents" \| "validationStrategy" \| "decisions" \| "assets" }` | `{ section; data; etag }` | Sectioned read; saves bandwidth. |
| `orchestrationManifestPatch` | `{ runId; patches; ifMatchEtag }` | `{ manifest; etag }` \| `{ error:"etag_conflict"; manifest; etag }` | RFC-6902 subset (`add`/`replace`/`remove`); arrays addressed by `{id:X}` predicate, **NEVER by index**. Per-runId AsyncMutex. Validates schema + per-role patch-path whitelist (§6). Atomic write (`.tmp` + fsync + rename). Bumps etag. Broadcasts `ade.orchestration.event` with diff payload `{ patch }`. |
| `orchestrationPlanAppend` | `{ runId; section; body; pinId? }` | `{ planMd; etag }` | Append-only writer. Section headings stable for renderer anchors. |
| `orchestrationPlanWrite` | `{ runId; nextPlanMd; ifMatchEtag }` | `{ planMd; etag }` | User-only (dock edits). Etag-guarded. |
| `orchestrationSpawnAgent` | `{ runId; role:"worker"\|"validator"; tag; goalSummary; stepId?; initialMessage; modelOverride? }` | `{ sessionId; manifest; etag }` | Resolves `(role,tag) → ModelSelection` (§13). Validates `initialMessage` contains required sections (TASK/FILES/DEPS/GATES/PEERS/SUCCESS). Calls `agentChatService.createSession` with the locked permission profile (§12) and the right `interactionMode`. Writes `agents[]`. Sets initial claim if `stepId`. |
| `orchestrationAgentInject` | `{ targetSessionId; payload }` | `void` | Replacement for the deleted `sendAgentMessage`. Validates source/target are in the same run. Routes through `agentChatService.send`/`steer`/`interrupt` based on `payload.kind` (queue / interrupt-replace / wake — see §8). Delivered as a regular user-role message with `metadata.orchestrationOrigin` field on the chat row. |
| `agentChatReadTranscript` | `{ sessionId; limit?; since? }` | `AgentChatTranscriptEntry[]` | New IPC; wraps the private `readTranscriptEntries(managed)` at `agentChatService.ts:5335`. |
| `orchestrationAssetRegister` | `{ runId; relPath; kind; version?; approval? }` | `{ asset; etag }` | Records artifact metadata. |
| `orchestrationClaimTask` | `{ runId; taskId; sessionId; leaseMs }` | `{ ok; reason?; manifest; etag }` | Atomic claim under per-runId mutex. |
| `orchestrationReleaseTask` | `{ runId; taskId; sessionId; status }` | `{ manifest; etag }` | Release/transition. |
| `orchestrationRunList` | `{ laneId? }` | `OrchestrationManifest[]` (summary) | Listing. |

**Event channel.** `ade.orchestration.event` payload `{ runId; kind: "manifest" | "plan" | "asset"; etag; patch?: ManifestPatch[]; manifest?; planMd?; planPatch?: { from: string; to: string } }`. Emitted on every successful write AND by chokidar watcher (debounced 50 ms, scoped to `<bundlePath>`, with self-write suppression — see §16.1).

Preload bridge: `window.ade.orchestration.*`.

---

## 6. Tool sets per role

New factory in `apps/desktop/src/main/services/ai/tools/orchestrationTools.ts` (NEW). Composes from `createUniversalToolSet` (`apps/desktop/src/main/services/ai/tools/universalTools.ts:2617`) by taking the read-only subset and adding orchestration-specific tools. Invoked at the same site as `createUniversalToolSet`, gated on `interactionMode === "orchestrator-lead" | "orchestrator-worker" | "orchestrator-validator"`.

Patch-path whitelist lives in a sibling `apps/desktop/src/main/services/orchestration/patchPolicy.ts` (NEW; single source of truth — IPC handler, tool descriptions, and tests all consume it). Uses id-predicate paths (e.g. `/tasks/{id:T-003}/status`), never `/tasks/2`.

### 6.1 Lead (`orchestrator-lead`)

Read-only base: `readFile`, `grep`, `glob`, `listDir`, `gitStatus`, `gitDiff`, `gitLog`, `webFetch`, `webSearch`, `TodoWrite`, `TodoRead`, `askUser`.

Adds:
- `spawnAgent(role, tag, goalSummary, stepId?, initialMessage, modelOverride?)`
- `messageAgent({ targetSessionId, kind: "queue"|"interrupt-replace"|"wake", intent: "directive"|"status"|"diff_notice"|"cancellation"|"question", text, taskId?, cancellation?: { revert: boolean | "review"; reason: string } })`
- `getAgentTranscript(sessionId, limit?, since?)`
- `manifestPatch(patches[], ifMatchEtag)` — lead may patch all paths except `agents[].sessionId` and worker-owned fields
- `planAppend(section, body)`
- `planWrite(nextPlanMd, ifMatchEtag)` — for re-plans
- `askUserForModelSelection(role, tag, suggestedProvider?, suggestedModel?)`
- `registerAsset(relPath, kind, version)`

Denied: `editFile`, `writeFile`, `bash`, `exitPlanMode`. Rationale: the lead is the planner/dispatcher; all code changes flow through workers so audit trails are clean and per-worker validation gates run.

### 6.2 Worker (`orchestrator-worker`)

Full edit-capable set (`editFile`, `writeFile`, `bash`) **with the bundle bash blocklist** (§16.5): bash refuses writes under `<bundlePath>/manifest.json` and `<bundlePath>/plan.md`. `<bundlePath>/artifacts/*` is freely writable.

Adds: `claimTask`, `releaseTask`, `manifestPatch` (whitelisted to `agents[me].{status,currentStepId,lastHeartbeatAt}` + `tasks[claimedByMe].{status,evidence,attempts}`), `planAppend`, `messageAgent({ kind, intent: "status" | "question" only })`, `getAgentTranscript`, `registerAsset`.

Denied: `spawnAgent`, `askUserForModelSelection`, `planWrite`, lead-only patch paths. Workers **cannot** patch their own `validationGate` or `validationStrategy.checklist` (server-enforced).

### 6.3 Validator (`orchestrator-validator`)

Same execution capability as worker (validators run tests, take screenshots): `editFile`, `writeFile`, `bash` (with bundle blocklist).

Adds: `manifestPatch` (whitelisted to `validationStrategy.checklist[*].{runs,latestRunId}` and `agents[me].status`), `planAppend`, `getAgentTranscript`, `registerAsset`, `messageAgent({ kind, intent: "status" | "question" only })`.

Denied: `spawnAgent`, `askUserForModelSelection`, `claimTask` on non-validation tasks.

---

## 7. System prompt + skill

### 7.1 Prompt injection sites

**Claude.** Extend `opts.systemPrompt.append` builder at `agentChatService.ts:14183-14199`. New `buildOrchestratorRoleDirective(managed.session)` parallel to `buildClaudeInteractionModeDirective` (line 3141); returns directive when `interactionMode` starts with `orchestrator-`. Contents: role, runId, bundle path, "manifest is ground truth", "follow `.agents/skills/ade-orchestrator/SKILL.md`", per-role rules.

**Non-Claude (Codex / Cursor / Droid / OpenCode).** Extend `buildCodingAgentSystemPrompt` in `apps/desktop/src/main/services/ai/tools/systemPrompt.ts:79` with `orchestrationRole?`, `orchestrationRunId?`, `orchestrationBundlePath?`. Emit the same directive block early. Call sites pull from `managed.session` like `permissionMode`.

**Per-turn re-pinning.** Add `shouldInjectOrchestratorDirective` keyed off `managed.lastOrchestrationDirectiveKey !== <role>:<runId>`, parallel to `shouldInjectLaneDirective` (line ~14474).

### 7.2 `.agents/skills/ade-orchestrator/SKILL.md`

Path: `/Users/arul/ADE/.agents/skills/ade-orchestrator/SKILL.md`. Auto-discovered via existing skill-walk (`agentChatService.ts:14166`).

Outline (write all sections — this is the protocol):

**Frontmatter** — `name: ade-orchestrator`; `description: Orchestrator-mode protocol for ADE Work-tab lead, worker, and validator chats. Use whenever the system prompt declares orchestrator-lead, orchestrator-worker, or orchestrator-validator mode.`

**§1 — User authority overrides defaults.** Every rule below is a default. If the user directly instructs a deviation ("skip validation for this run", "no audit gate", "no asking, use Opus for everything", "only plan, I'll spawn workers myself"), comply, log a `UserOverrideEntry` to `manifest.userOverrides` with the literal instruction, surface the risk once in chat if material, and **do not re-prompt the default later** in the same scope.

**§2 — Bundle as truth.** Read manifest before reasoning. Write through `manifestPatch` / `planAppend` only. Never invent state. Never fork canonical state into chat-only prose.

**§3 — Planning protocol (lead only).**
1. Read `goal.md` if present; otherwise `askUser` for a one-line goal.
2. **Codebase intake — inspect-first, ask-on-uncertainty.** Read `CLAUDE.md`, `README.md`, package manifests (`package.json` / `pyproject.toml` / `Cargo.toml` / `go.mod` / etc.), CI config (`.github/workflows/` / `.circleci/` / `.gitlab-ci.yml`), top-level dir listing, recent `git log --oneline -50`. Infer: project shape, test stack, ancillary surfaces, available CI gates, doc structure (if any).
3. Propose a tag taxonomy (3–6 tags) and confirm via `askUser`. Examples seed by shape — fullstack web → `web-ui` / `backend` / `docs`; graphics → `render-pipeline` / `shaders`; mobile → `swiftui` / `storekit`. **Tags are project-specific.**
4. Propose tasks per phase. For Developing tasks, include `filesHint` derived from inspection where possible.
5. **Validation step derivation (see §6 below).** Detect which `ValidationConcern`s apply; ask user where uncertain; write codebase-specific `prompt` text into each `validationStrategy.steps[]` entry.
6. **Model picks.** For every `(role, tag)` pair, call `askUserForModelSelection`. Batched as one wave (per locked cadence). The picker UI is the ADE in-house `ModelPicker` — never present a flat option list.
7. Append a `DecisionLogEntry` per lock-in.
8. **Plan-approval gate.** Once Planning is complete, present `[ ✅ Approve Plan ]` via `askUser`. Until the user approves, do not call `spawnAgent`.

**§4 — Developing protocol (worker only).** Claim before touch (`claimTask(taskId, 30min lease)`). Heartbeat is free (tool wrapper bumps `lastHeartbeatAt` on every call). After substantive edits, satisfy every `validationGate.stepIds[]` that has `scope: "per_worker"` and `required: true`. Default gate (when present): `reverify_changes` — execute its `prompt` from the manifest. Write evidence via `planAppend`; tick the `validationStrategy.checklist`. Only then patch `tasks[mine].status = "done"`. Server rejects `status: "done"` patches when required checklist items are not `passed`.

**§5 — Validating protocol (validator only).** For each assigned step, read its `prompt` from `manifest.validationStrategy.steps[]` and execute it. The prompt is codebase-specific — do not assume vitest/jest/pytest or specific doc paths. Attach evidence; flip checklist `passed`/`failed`. On failure: **spawn fix-task** by reporting up to the lead (validator pings lead with status; lead patches a new task with `supersedes: T-original` and re-tasks the original worker). **Validators do not spawn agents themselves.**

**§6 — Validation as universal concerns.** When the planner writes a `validationStrategy.steps[]` entry, it picks a `ValidationConcern` and authors the codebase-specific `prompt`. The concern names are classifiers; the **prompt is what the validator follows**.

- **`reverify_changes`** (audit principle, *recommended default for every Developing task*).
  - Principle: after substantive edits, re-read the *final* state of every touched file (not just remembered diffs). Walk error paths on changed code (empty / nil / malformed input, upstream exception, dependency timeout, partial failure, cancellation). Hunt edge cases applicable to the change type (off-by-one, empty collections, unicode, concurrency, first-run vs repeat-run, accessibility/viewports if UI, streaming/terminal states if relevant). Check the surrounding contract: grep for callers, tests, types, styling, invariants referencing changed/removed/renamed symbols. Fix what you find directly. Call out genuine ambiguities. Report what was checked, fixed, and deliberately left alone.
  - Planner derivation: write the prompt naming the file types the worker is touching and the relevant edge-case categories for *this* codebase. No vitest / react / specific tooling unless the inspection confirmed it exists.

- **`test_suite_truthfulness`** (automate principle, *only when codebase has tests*).
  - Principle: "leave the suite more truthful and smaller, not just larger." Three passes in order: **PRUNE** (orphaned tests, `skip`/`only`/`todo`, anti-pattern tests like `expect(true)` or zero-assertion bodies, over-mocked fixtures, render-only UI tests) → **CONSOLIDATE** (merge fragmented files about one feature, respect a per-folder file budget) → **ADD** (only for new public contracts; hard caps the planner picks — e.g. "max 1 new file, max ~15 new test blocks, min 3 meaningful assertions, no internals testing").
  - Planner step: inspect for test files (common patterns + framework hints from package manifests). If none, **skip this concern entirely**. If yes, ask user `"we have tests in <patterns>. Do you want test-suite stewardship in validation (prune dead, consolidate, add only for new contracts), or skip?"`; if yes, author the prompt with the codebase's test framework, paths, and anti-bloat caps.

- **`surface_parity`** (automate principle, *only when ancillary surfaces exist*).
  - Principle: when a feature lands, cross-cutting surfaces that shadow the change must stay in lockstep. Ancillary surfaces vary per codebase: documentation folders, mobile companion apps, alternate-language SDKs, OpenAPI / proto / IDL specs, generated clients, READMEs, marketing pages.
  - Planner step: inspect for plausible surfaces (look for `docs/`, `README.md` density, `apps/mobile`/`apps/ios`/`apps/android`, `sdks/`, `openapi.yaml`, `proto/`, `.proto`, `clients/`, `examples/`, `website/`). For each surface detected, ask user `"I see <surface> in this repo. Should validation include keeping it in lockstep with the change? (e.g. update docs to reflect new behavior / update SDK types / regenerate clients)"`. For each yes, author a validation step naming that specific surface and what "in lockstep" means for it.

- **`pre_completion_gate`** (finalize principle, *minus PR/push handoff*).
  - Principle: before declaring the run complete, run the codebase's standard pre-completion checks. These vary: typecheck, lint, test suite, build, doc validators, lock-file consistency, asset compilation. **Orchestrator does not push, open PRs, or handle remote review** — that's a separate user-driven step.
  - Planner step: inspect `package.json` scripts, `Makefile`, CI workflow yaml, common entry points (`npm run typecheck`/`lint`/`test`/`build`, `cargo check`/`clippy`/`test`/`build`, `pytest`, `go vet`/`go test`/`go build`, etc.). Propose a set; ask user `"propose pre-completion gates: <list>. Add/remove?"`. Author the prompt with the exact commands and the codebase's local rules.

- **`deep_maintainability`** (thermal principle, *opt-in for high-risk diffs*).
  - Principle: when the diff is large or touches load-bearing code, run a deep maintainability/structure audit (cohesion, coupling, abstraction-leak, dead-on-arrival code, surprise contracts). Optional v1.
  - Planner step: if user marks the run `risk: high` or asks for it, propose; otherwise skip.

- **`custom`** — anything else the planner needs.

**§7 — Inter-agent ping discipline.** Every state mutation that affects another agent must trigger a ping. Examples: worker patches `tasks[mine].status = "done"` → ping lead; lead patches `tasks[T].assigneeSessionId` → ping new + old assignee; validator patches a checklist run to `passed`/`failed` → ping lead; worker registers an asset → ping lead. Inter-worker pings **always go through the lead**. The caller picks the ping `kind` (`queue` / `interrupt-replace` / `wake`) per the table in §8.

**§8 — Per-runtime ping capabilities** (lookup table the lead consults; see §8 of this spec for the source data).

**§9 — Cancellation with smart revert.** Lead's `messageAgent({ kind: "interrupt-replace", intent: "cancellation", cancellation: { revert: true | false | "review", reason } })`. Worker reads, halts, then:
- `revert: true` — `git checkout -- <hint files>` for tracked files; `rm` for untracked files the worker created. Idle.
- `revert: false` — leave changes; status → `completed` with note "lead requested keep, no revert".
- `revert: "review"` — `askUser` ("Lead requested cancel; should I keep, revert, or partial?"). Follow user's instruction. Log to `decisions`.

**§10 — Live plan-edit reaction (lead only).** When manifest etag bumps and the diff affects `tasks[*]` / `phases[*]` / `validationStrategy`: re-read manifest; compare against persisted `manifest.leadState.lastSnapshotEtag`; iterate `manifest.history.slice(after: lastSnapshotEtag)` to know what changed; for each in-flight assignee respond per §9; for newly added tasks lacking assignee, spawn or hold per dependency. After reconciling, patch `manifest.leadState = { lastSnapshotEtag: currentEtag, lastSnapshotSeenAt: now }`.

**§11 — Spawn brief.** Free-form, **but** must contain headings: `## TASK`, `## FILES`, `## DEPENDENCIES`, `## GATES`, `## PEERS`, `## SUCCESS`. Server-side `spawnAgent` validates section presence. `## PEERS` lists every other in-flight agent with role, tag, current task, status. `## GATES` lists which `validationStrategy.steps[]` entries apply (with their codebase-specific prompts inlined or referenced by id).

**§12 — Forbidden actions.** Forking canonical state into chat-only prose. Spawning agents not registered in the manifest. Using `bash` to edit `<bundlePath>/{manifest.json, plan.md}` (sandbox enforces server-side too). Validators spawning agents. Workers patching their own `validationGate`. Workers patching checklist items.

---

## 8. Inter-agent ping system

ADE already has unified IPC: `agentChatSend` / `agentChatSteer` / `agentChatInterrupt` (`apps/desktop/src/shared/ipc.ts:187-193`; handler at `apps/desktop/src/main/services/ipc/registerIpc.ts:6507`). All five providers route through one handler in `agentChatService.sendMessage` / `steer` / `interrupt`. The orchestration layer's `orchestrationAgentInject` translates `(kind, intent, target) → the right unified call`. The pattern is precedented by `workerDeliveryService.ts:1054-1128` which already implements a steer→send fallback ladder.

### 8.1 Unified primitives

```ts
type Ping =
  | { kind: "queue"; text: string }              // → agentChatService.steer
  | { kind: "interrupt-replace"; text: string }  // → interrupt then sendMessage
  | { kind: "wake"; text: string };              // → agentChatService.sendMessage (dormant-only)
```

Notes:
- `send` is **dormant-only**; mid-turn it throws. Use `steer` or `interrupt`.
- Claude can also "inline" via `dispatchSteer({ mode: "inline" })` (`agentChatService.ts:18921-19020`) for immediate fold-in without spawning a separate assistant turn.

### 8.2 Per-runtime capability matrix

| Provider | Native steer (mid-turn, model-aware) | Native cancel-and-replace | Wake-from-dormant |
|---|---|---|---|
| Claude Agent SDK | yes (`dispatchSteer inline`, `shouldQuery:false`) | yes (`query.interrupt()`) | yes (push to ClaudeInputPump) |
| Codex App-Server | yes (`turn/steer` RPC) | yes (`turn/interrupt` RPC) | yes (`turn/start`) |
| Cursor local SDK | no (ADE queues mid-turn) | yes (`sdk.cancel()`) | yes (`sdk.sendPrompt`) |
| Cursor cloud | no (`cloud.followup` queues) | yes (`cloud.run.cancel`) | yes (`cloud.send.stream` / `cloud.followup`) |
| Droid | no (ADE queues) | yes (`sdk.cancel()`) | yes (`sdk.sendPrompt`) |
| OpenCode | no (ADE queues) | yes (`session.abort`) | yes (`session.promptAsync`) |

All providers support all three primitives at the API surface. Only Claude and Codex have **native model-aware** steering. For non-native-steer providers, `queue` is ADE-buffered and flushed on the next turn.

### 8.3 When pings fire

The orchestration tool wrappers compute affected agents from the patch and emit pings automatically when a tool mutates shared state:
- `claimTask` succeeds → no ping (caller is the actor).
- `releaseTask` with `status: "done" | "failed"` → ping lead.
- `manifestPatch` to `tasks[*].status` → ping lead.
- `planAppend` from worker / validator → ping lead.
- `manifestPatch` to `agents[*].status` → ping lead.
- `registerAsset` from worker / validator → ping lead.
- Lead `manifestPatch` to `tasks[T].assigneeSessionId` (reassignment) → ping new and old assignee.
- Lead `manifestPatch` to `tasks[T].validationGate` → ping the assigned worker.
- Lead `manifestPatch` setting `agents[X].cancellationRequested = true` → triggers bash interrupt on X (§16.2).
- User dock edit → service auto-pings lead.

Workers never ping each other directly. Lead is the routing hub.

### 8.4 Visibility

The injected message lands on the target chat row with `metadata.orchestrationOrigin = { runId; fromSessionId; kind; intent; taskId? }`. UI renders a small purple "from <agent>" chip in the message header. Receiving agent's system prompt mentions: "messages with `orchestrationOrigin` metadata are sent by another orchestration agent, not the user; act accordingly".

---

## 9. Cancellation flow

`manifest.agents[].cancellationRequested` is the explicit signal. Worker bash factory subscribes to the manifest watcher; on a patch that sets it `true` for the worker, send `SIGTERM` to the in-flight child-process tree (existing `eventAbortController` pattern at `agentChatService.ts:8091`). After the child exits, the worker's normal loop picks up the cancellation envelope and follows SKILL §9 (`revert` / `keep` / `review`).

---

## 10. UI components

This section is the full UI spec. The user emphasized "make the new panel really nice."

### 10.1 Composer "+" menu entry

In `apps/desktop/src/renderer/components/chat/AgentChatComposer.tsx` add a menu item **"New orchestrator chat"** to the attachment/action menu near the composer toolbar. Also add to the sidebar "+ New Chat" picker in `apps/desktop/src/renderer/components/terminals/SessionListPane.tsx:596`. On click: new draft kind `"chat-orchestrator"`; flow ends in `agentChatCreate` with `interactionMode: "orchestrator-lead"`; immediately followed by `orchestrationRunCreate` to allocate the bundle.

Both entry points coexist with regular "+ New Chat". The orchestrator entry carries an "Orchestrator" purple-accent label tone.

### 10.2 Lead chrome (rainbow ring)

New file: `apps/desktop/src/renderer/components/chat/OrchestratorLeadFrame.tsx`. Wrapper component that renders an animated conic-gradient ring around the chat surface. Applied from `AgentChatPane.tsx` only when `session.interactionMode === "orchestrator-lead"`.

Two visual modes behind one component:
- **Default.** Slow CSS conic-gradient on a pseudo-border + subtle box-shadow pulse. Border itself slowly cycles red → orange → yellow → green → blue → violet. <40 ms additional render cost.
- **`@media (prefers-reduced-motion: reduce)`** — static rainbow border (no animation).

The wrapper does **not** alter layout; it sits between `ChatSurfaceShell` and the inner pane. Worker/validator chats get no rainbow but get a small role chip in the header (driven by `session.orchestrationRole`).

ASCII shape (default):

```
┌─🌈──────────────────────────────────────────────────┐
│ Lead · web-app orchestrator                         │
│                                                     │
│   I'm in Planning phase. Tell me the goal           │
│   in one sentence...                                │
│                                                     │
│ ┌─────────────────────────────────────────────────┐ │
│ │ type here...                                    │ │
│ └─────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────┘
(border itself slowly cycles)
```

### 10.3 Right-side plan panel

New file: `apps/desktop/src/renderer/components/orchestration/OrchestrationPanel.tsx`. Mounted in `AgentChatPane.tsx` whenever the active session has `orchestrationRunId`. Subscribes via `window.ade.orchestration.subscribe(runId, cb)` (preload wrapper around `ade.orchestration.event`).

**Layout.** Always-visible vertical pane to the right of the chat, like Cursor's right panel. Collapse arrow at the top-right (collapsed → icon strip, expanded → full panel). Width: ~360 px default, resizable.

**Single unified view — NO multi-tab dock.** The panel renders top-to-bottom:

1. **Run header.** Run title, lane name, current phase pill, lead identity. A small `⊕ collapse` arrow on the right.
2. **Phases accordion** — Planning / Developing / Validating (+ optional Wrap-up). Each header carries status + progress chip.
3. **Task cards** under each phase (§10.4).
4. **plan.md narrative** rendered through the new markdown engine (§10.5).
5. **Inline asset previews** at the spot they're referenced in `plan.md` (§10.6).

**Lead view = all of the above. Worker/Validator view = same panel but read-only (tasks not editable, no plan rewrite affordance).**

**Empty state during Planning** (before any tasks exist):

```
✨ Planning in progress

✓ Q1  What's the goal?
     A  Rebuild the login flow.

✓ Q2  Project tags I'm proposing:
        [web-ui] [backend] [docs]
     A  Confirm + add [tests]

✓ Q3  Pick model for developer:web-ui
     A  Claude Sonnet 4.6, xhigh

⏳ Q4  Pick validation steps...
     (awaiting answer)

Tasks will appear here once
planning completes.
```

Each Q&A row is built from the lead's `decisions[]` entries that match planning-question shapes.

### 10.4 Task card

Expanded card with full metadata. ASCII shape:

```
┌────────────────────────────────────────────┐
│ T-01 • [web-ui]            ◆ done  🔍  ⋯   │
│ build login form                            │
│                                             │
│ Form with email + pw inputs; uses          │
│ /auth route; routes to /dash on success.   │
│                                             │
│ 📄 src/login.tsx   src/auth.ts             │
│ 👤 worker:claude  · ⏱ 12m elapsed         │
│ ✓ reverify_changes   ✓ test_suite          │
└────────────────────────────────────────────┘
```

Elements:
- Top row: task id, tag chip, status pill (`pending` / `claimed` / `in_progress` / `review` / `done` / `failed`), 🔍 expand button, ⋯ context menu.
- Title row.
- Description (clamped to 3 lines; click to expand).
- File anchors row — `filesHint` rendered as clickable chips. Click → dispatches `ade:agent-chat:add-attachment` so the user can insert the file ref into the lead composer.
- Owner row — assignee linked to that worker's chat session; click switches the Work tab to that chat. Elapsed time computed from `claimedAt`.
- Validation badges — one per applicable `ValidationStep`. `✓` passed, `⏳` running, `✗` failed, `—` pending. Click any badge → evidence pop-over showing the latest `ValidationChecklistRun.attachedEvidence`.

Context menu (⋯): `Open worker chat` / `Cancel task...` (revert / keep / review) / `Re-spawn` / `Mark done manually` (writes `humanOverride`).

### 10.5 Markdown engine

Dual.

- Chat surface keeps `apps/desktop/src/renderer/components/chat/chatMarkdown.tsx` (`ChatMarkdown`) — unchanged.
- Plan view uses **new** `apps/desktop/src/renderer/components/orchestration/PlanMarkdown.tsx` built on `react-markdown` + `remark-gfm` + `remark-mermaid` + `rehype-slug` + `rehype-raw`.

`PlanMarkdown` component overrides:
- ```` ```mermaid ```` fence → lazy-load mermaid; render diagram inline.
- `img` referencing a registered asset → embed inline (screenshot at natural size, max-width clamp).
- `a` referencing `artifacts/ui/*.html` → render as the spec preview card (§10.6).
- Headings get stable `data-section-id="<slug-hash>"` via `rehype-slug` so annotation anchors (and any future persistence) survive content edits.

### 10.6 Inline asset previews

**HTML specs.** Render as a card containing:

```
┌─────────────────────────────────────┐
│ artifacts/ui/login.html             │
│ ┌─────────────────────────────────┐ │
│ │  [iframe sandbox=""             │ │
│ │   src="file://<bundle>/...">    │ │
│ │   240×180 thumbnail             │ │
│ │  ]                              │ │
│ └─────────────────────────────────┘ │
│ [ 🔍 Open in ADE browser ]          │
└─────────────────────────────────────┘
```

- `<iframe sandbox="">` (empty sandbox attribute → strictest: no scripts, no same-origin). Live reflection of current file contents.
- **"Open in ADE browser"** button calls `window.ade.builtInBrowser.open(<file://path>)` and focuses the Work-tab Browser surface (the existing one — we do NOT duplicate it in the panel).
- Right-click on the iframe → "Annotate spec" chip (§10.7).

**Screenshots / PNGs.** Inline at natural size, `max-width: 100%`. Click to expand modal at full size.

**Mermaid.** Rendered inline via the `PlanMarkdown` override.

### 10.7 Annotations (pure ephemeral)

User can annotate **anything in the panel**: text, image, mermaid SVG, HTML iframe surface.

Flow:
1. User selects content in the panel (text via `window.getSelection`; image / iframe / mermaid via right-click → "Annotate this").
2. Floating popover opens at the selection: `[ comment field …  → Inject ]`.
3. User types comment, presses Enter.
4. UI composes an `OrchestrationContextItem` carrying `{ anchorPreview, selectionExcerpt, comment, capturedAt }`. The anchorPreview is a short snippet of the selected content (or a screenshot of the iframe thumbnail) so the lead sees what was being annotated.
5. UI dispatches `ade:agent-chat:add-plan-annotation` (NEW `CustomEvent`) on `window`.
6. `AgentChatPane` listener (parallel to existing `add-builtin-browser-context` at `apps/desktop/src/renderer/components/chat/AgentChatPane.tsx:4452`) merges the item into the composer attachment tray via the existing `mergeChatContextAttachments` flow.
7. Popover dismisses. **Nothing persisted to manifest.** The injected attachment ships on the next composer send to the lead.

For iframes: capture target via DOM message-bridge from inside the sandboxed iframe (postMessage); for a simple "annotate this whole spec" the user clicks an "Annotate spec" chip on the spec card and the comment popover opens with the spec id as the anchor.

### 10.8 Sidebar role badges

`apps/desktop/src/renderer/components/terminals/SessionCard.tsx` reads `session.orchestrationRole` and `orchestrationTag` (projected through `useWorkSessions.ts`). Render small pills in the card header:
- `lead` → **purple** `LEAD` pill.
- `worker` → **blue** `WORKER · <tag>` pill (tag in lowercase).
- `validator` → **green** `VALIDATOR · <concern>` pill (e.g. `VALIDATOR · reverify`).

Flat list (no grouping). Worker session title = lead-supplied goal-summary (e.g. "Build login form"); role/tag chip beside.

### 10.9 Model picker pending input

When a `PendingInputRequest.kind === "model_selection"` arrives, render `apps/desktop/src/renderer/components/shared/ModelPicker/ModelPicker.tsx` inside the pending-input slot. Wire `onChange` to resolve via `IPC.agentChatRespondToInput` with `{ selection: ModelSelection }`. Pass `providerMetadata.suggested` as initial; `providerMetadata.availableModels` to scope choices.

**Permission picker rows inside `ModelPicker` are hidden** for orchestration-spawned workers/validators (permission tier is forced — §12). User only sees: model, fast-mode (if supported), reasoning level.

### 10.10 Composer locks

Extend `AgentChatComposer.tsx` lock props (near line 755) with `orchestrationRole?: OrchestrationRole`. When set:
- **Lead.** Hide permission picker entirely. Hide model picker (lead's model is fixed at create-time and rarely changes).
- **Worker / Validator.** Hide permission picker entirely. Show model + fast + reasoning rows only.

### 10.11 Header strip on lead chat

Above the conic-gradient frame, render a small one-line header showing: current phase pill, agent count (e.g. `4 agents`), elapsed run time. Click the phase pill → scrolls the plan panel to that phase.

### 10.12 Worker / validator chat headers

In `apps/desktop/src/renderer/components/chat/AgentChatPane.tsx` add a thin role banner at the top of worker/validator chats: role chip + tag + "Lead: <lead title>" link + "Current task: <task id> · <title>" link. Click on lead link → switch to lead chat; click on task link → highlight task card in plan panel.

### 10.13 Empty/no-orchestration sessions

For ordinary (non-orchestrator) chats: panel is not mounted. No rainbow chrome. No badges. Behavior unchanged from current ADE.

---

## 11. Live-editable plan (v1)

Read-only render. User edits propagate by **talking to the lead in chat** — they say "move T-02 before T-01" / "drop the audit gate on T-03" / "skip surface_parity entirely" / "swap worker T-04 to Codex" — lead patches the manifest. The lead reacts per SKILL §10 (snapshot/diff/ping affected workers).

Watcher (chokidar, debounced 50 ms, scoped to `<bundlePath>`) is the safety net for external edits (e.g. worker writing artifacts via bash). It emits `ade.orchestration.event` with the new etag; renderer re-reads via subscribe.

Direct in-panel editing (drag tasks, edit titles in place, edit `plan.md` markdown) is **v2**.

---

## 12. Permission profiles per provider

Forced at `orchestrationSpawnAgent` time. User picks model + fast + reasoning only — **never** the permission tier for orchestrator-spawned chats.

| Role | Provider | Mode fields |
|---|---|---|
| Lead | (any) | `interactionMode: "orchestrator-lead"`; safety-net flags: `claudePermissionMode: "plan"` / `codexSandbox: "read-only"` / `cursorModeId: "ask"` / `droidPermissionMode: "read-only"` / `opencodePermissionMode: "plan"`. Tool set already lacks writes; these are belt-and-braces. Composer hides permission picker. |
| Worker | Claude | `claudePermissionMode: "bypassPermissions"` |
| Worker | Codex | `codexSandbox: "danger-full-access"`, `codexApprovalPolicy: "never"` |
| Worker | Cursor | `cursorModeId: "full-auto"` (**NOT** `"agent"` — that's safe-default and pauses on approval) |
| Worker | Droid | `droidPermissionMode: "auto-high"` |
| Worker | OpenCode | `opencodePermissionMode: "full-auto"` |
| Validator | (any) | Same as worker for the matching provider; `interactionMode: "orchestrator-validator"`. |

`permissionProfile.test.ts` asserts the exact mode strings against the runtime unions (`CURSOR_AVAILABLE_MODE_IDS` in `apps/desktop/src/renderer/components/cursorModes.ts:9`, etc.) so a rename in any provider breaks the test rather than silently demoting.

---

## 13. Model routing

Storage: `manifest.modelRouting` (§4.2).

**Planning-time derivation (lead's skill responsibility).**
1. Inspect repo → propose tag taxonomy → confirm via `askUser`.
2. For each `(role, tag)` with `role ∈ {developer, validator}`: `askUserForModelSelection(role, tag)` → user picks via `ModelPicker` UI → write to `manifest.modelRouting.byRoleTag["<role>:<tag>"]`. Optionally also `byRole` fallback + `default`.

**Resolution at `spawnAgent`:**

```
resolveModel(role, tag) =
  routing.byRoleTag[`${role}:${tag}`] ??
  routing.byTag[tag] ??
  routing.byRole[role] ??
  routing.default ??
  /* fallback to lane's current default */
```

Mid-run mutation: `manifestPatch` on `modelRouting`. New spawns pick up; in-flight agents keep their assignment (we don't mutate live sessions). To swap a running worker's model: terminate and respawn.

Tag introduced mid-run: lead calls `askUserForModelSelection(role, newTag)` and patches `byRoleTag` before any spawn using it.

---

## 14. Validation as universal concerns

See SKILL §6 for the planner protocol. The schema (`ValidationConcern`, `ValidationStep.prompt` codebase-specific) is in §4.2.

**Defaults the skill recommends** (each waivable via user override):
- One `reverify_changes` step per Developing task, `scope: "per_worker"`, `required: true`.
- `test_suite_truthfulness` mission-exit step **if and only if** tests are detected.
- `surface_parity` mission-exit step(s) **only for surfaces the user opted into**.
- `pre_completion_gate` mission-exit step **if and only if** the codebase has a discoverable CI rubric.
- `deep_maintainability` mission-exit step **only if** user requests (or marks `risk: high`).

**Server-side enforcement.** `orchestrationManifestPatch` rejects a `status: "done"` patch on a task whose `validationGate.required = true` if matching checklist items are not all `passed`. EXCEPT when the same patch transaction includes:
1. `humanOverride` on the task with `byUserId` / `at` / `reason`.
2. A new `UserOverrideEntry` with `scope: "task"` and `appliedToId: <taskId>`.

Both must be present together to permit the bypass. Validators can re-run a check by adding a new `ValidationChecklistRun` with `supersedes: <priorRunId>` — prior runs are preserved in `runs[]`.

---

## 15. User authority overrides defaults

The orchestrator's defaults are recommendations. The user is authoritative.

Concrete behaviors:
- Skill §1 explicitly tells the lead: comply with direct user instructions even when they conflict with defaults.
- `manifest.userOverrides[]` records every override with the user's literal instruction.
- The plan-approval gate (SKILL §3.8) presents the proposed plan **including any user-instructed waivers** so the user sees the full state at approval.
- Validation gates with `required: true` are server-enforced — but `required` can be set to `false` by the lead **only when** a `UserOverrideEntry` is logged in the same patch transaction.
- Once a default is waived for a scope, the lead does not re-prompt within that scope.

Examples that must work:
- "skip all validation for this run" → lead writes empty `validationStrategy.steps`, logs override, never re-suggests.
- "don't ask me about models, use Opus 4.7 xhigh for everything" → lead writes `modelRouting.default = { provider:"claude", modelId:"opus[1m]", reasoningEffort:"xhigh" }`, skips `askUserForModelSelection` for this run, logs override.
- "only do planning, I'll spawn workers myself" → lead completes Planning, never calls `spawnAgent`, hands off to user. (Note: v1 has no user-spawn UI — user types in lead chat to spawn manually; OR this is a degenerate case where lead simply leaves the plan as-is and waits.)
- "spawn one worker per task, no parallelism" → lead serializes spawns, logs override.
- "skip the audit gate on T-03" → lead patches `tasks[T-03].validationGate.required = false` along with `humanOverride` + `UserOverrideEntry`.

---

## 16. Hardening (must-fix before ship)

These came from a risk audit of the design. Each is a localized addition; none requires redesigning the product shape.

### 16.1 Per-runId AsyncMutex + watcher self-write suppression

In `apps/desktop/src/main/services/orchestration/orchestrationService.ts`, gate **all writes** through a per-runId `AsyncMutex` (pattern used at `agentChatService.ts:8091`-area for runtime locks). Inside the mutex: re-read manifest from disk, fail closed if `ifMatchEtag !== currentEtag` (return `{ error: "etag_conflict" }`), apply patch, fsync + rename, bump etag, then broadcast IPC reply and watcher event in the same tick.

Suppress chokidar self-emissions during writes by tracking a `recentSelfWrite: Map<runId, expectedMtime>` window (1 s) — when chokidar fires within that window for the same etag, drop the event.

### 16.2 Bash-interrupt on `cancellationRequested`

Worker bash tool (factory in `apps/desktop/src/main/services/ai/tools/universalTools.ts:2617+`) subscribes to the manifest watcher when an orchestration session. On a patch that sets `agents[me].cancellationRequested = true`, send `SIGTERM` to the in-flight child-process tree (use the existing `eventAbortController` pattern at `agentChatService.ts:8091`). After child exits, the worker's normal loop picks up the cancellation envelope and follows SKILL §9.

### 16.3 Cursor worker mode → `"full-auto"`

Not `"agent"`. Verified via `CURSOR_AVAILABLE_MODE_IDS` in `apps/desktop/src/renderer/components/cursorModes.ts:9`. `permissionProfile.test.ts` asserts this.

### 16.4 Persist lead snapshot in manifest

`manifest.leadState.lastSnapshotEtag` + `manifest.history[]` ring buffer (last 50 entries: `{ etag, at, summary, patchKindSummary }`). Lead reads on resume; reconciles via `history.slice(after: lastSnapshotEtag)`. Replaces the "store snapshot in working memory" anti-pattern that breaks on SDK restart / app reopen.

### 16.5 Bash escape hardening

In `apps/desktop/src/main/services/ai/tools/universalTools.ts`:
- Extend `MUTATING_BASH_RE` (line 163) with `|ln\s+(?!-s)` (hardlink, not symlink).
- Add `INTERPRETER_RE` matching `python(3)?|node|ruby|perl(?!\s+-i)` that triggers path-inspection (catches `python -c "open(...)"` / `node -e "fs.writeFileSync(...)"`).
- For orchestration worker/validator sessions, force `blockByDefault: true` (line 1252) to catch interpreter writes.
- Extend `DEFAULT_WORKER_SANDBOX_CONFIG.protectedFiles` with the absolute path to `<bundlePath>/manifest.json` and `<bundlePath>/plan.md`; canonicalization via existing `resolveWritableTargetPath` (line 893) handles symlinks (it uses `fs.realpathSync`).

### 16.6 Patch-path whitelist enforcement

All patches validated against `apps/desktop/src/main/services/orchestration/patchPolicy.ts`. Workers cannot patch `validationGate.*` or `validationStrategy.checklist[*]`. Validators only patch checklist runs and their own agent row. Server rejects `tasks[*].status = "done"` patches when `validationGate.required && !checklist.every(passed)` *unless* the same patch transaction includes `humanOverride` AND a matching `UserOverrideEntry`.

### 16.7 Watcher resilience to `git checkout` / `rm -rf`

On `unlink` of `manifest.json` for an active run → mark run `status: "suspended"`. On `change` → validate `manifest.runId === expectedRunId`; if mismatch (e.g. a different branch's manifest replaced files in-place), treat as new run rather than blindly etag-bumping. `serverGeneration` is a monotonic counter persisted outside the manifest (`<bundlePath>/.gen`) so post-checkout writes produce strictly-increasing etags.

### 16.8 Chokidar lifecycle

Lazy-start on subscriber-ref-count > 0. `dispose(runId): Promise<void>` calls `watcher.close()` (chokidar 3+ returns a promise; await). Test scaffold mocks chokidar via the `vi.mock` pattern from `fileWatcherService.test.ts:28-40`.

**NOT included in v1 (per user decision):** HMAC envelope hardening. Skill discipline only. Document the residual spoofing risk in the open-items log.

---

## 17. Build order

Six commits in one PR; each independently testable.

1. **Types + IPC + bundle persistence.**
   - New `apps/desktop/src/shared/types/orchestration.ts`.
   - Extend `apps/desktop/src/shared/types/chat.ts` (`AgentChatInteractionMode`, `PendingInputKind`, session fields).
   - Create `apps/desktop/src/main/services/orchestration/orchestrationService.ts` with bundle CRUD, etag handling, per-runId AsyncMutex, RFC-6902 patch validator with role whitelist via `patchPolicy.ts`, chokidar watcher with self-write suppression and `runId` validation.
   - Register IPC channels in `apps/desktop/src/shared/ipc.ts` + `apps/desktop/src/main/services/ipc/registerIpc.ts`.
   - Preload bridge in `apps/desktop/preload.ts` + `preload/global.d.ts`.
   - Unit tests: manifest concurrency, etag conflicts, patch path whitelist per role, atomic write semantics, watcher resilience.

2. **Orchestrator lead chat + skill.**
   - Thread `interactionMode` extension; persistence; deserializer tolerance.
   - System-prompt directive builder (Claude path + `buildCodingAgentSystemPrompt` for non-Claude providers).
   - Composer "+" menu entry; new draft kind handling.
   - Create `/Users/arul/ADE/.agents/skills/ade-orchestrator/SKILL.md` (every section in §7.2).
   - Smoke test: opening a lead chat injects the right directive and reads the bundle.

3. **Orchestration tools (spawn / inject / transcript-read / manifestPatch / planAppend / claimTask).**
   - New `apps/desktop/src/main/services/ai/tools/orchestrationTools.ts`.
   - Wire into `createUniversalToolSet` branch (sibling factory, gated by `interactionMode`).
   - New IPC `agentChatReadTranscript` + public `readTranscript` wrapper on `agentChatService`.
   - Bash bundle-path blocklist + hardened `MUTATING_BASH_RE` + `INTERPRETER_RE` + `blockByDefault` for orchestration workers in `universalTools.ts`.
   - E2E test (mocked Claude): lead spawns worker that claims, edits, `planAppend`s, patches status; worker pings lead on done; lead reads bundle and reacts.

4. **Right plan panel + plan renderer + sidebar badges + lead chrome.**
   - `apps/desktop/src/renderer/components/orchestration/OrchestrationPanel.tsx`.
   - `apps/desktop/src/renderer/components/orchestration/PlanMarkdown.tsx` (react-markdown + plugins).
   - Expanded task card, accordion phases, empty-state Q&A history.
   - Inline asset previews (HTML iframe thumbnails, mermaid via plugin).
   - `apps/desktop/src/renderer/components/chat/OrchestratorLeadFrame.tsx` (conic-gradient + reduced-motion).
   - `apps/desktop/src/renderer/components/terminals/SessionCard.tsx` role badges; project `orchestrationRole` / `Tag` through `apps/desktop/src/renderer/components/terminals/useWorkSessions.ts`.
   - Subscribe to `ade.orchestration.event`.

5. **Ephemeral annotations + Spec card "Open in ADE browser" loop.**
   - Selection popover + image / iframe right-click → "Annotate this".
   - `ade:agent-chat:add-plan-annotation` CustomEvent.
   - `AgentChatPane` listener parallel to `add-builtin-browser-context` (`apps/desktop/src/renderer/components/chat/AgentChatPane.tsx:4452`).
   - "Open in ADE browser" wires through `window.ade.builtInBrowser.open` + focuses Work-sidebar Browser.

6. **Model routing + `askUserForModelSelection`.**
   - Extend `PendingInputKind` with `"model_selection"`.
   - Render `ModelPicker` in the pending-input slot for that kind.
   - Wire `askUserForModelSelection` tool (lead-only).
   - Skill section finalized.
   - Integration test: planning run records `byRoleTag` and spawns a worker on the resolved model.

Why this order: each step adds a vertical slice that can be exercised by hand without later steps. 1–3 are server-heavy; 4–6 are renderer-heavy. The PR is a single bundled release per orch.md, but commit granularity preserves reviewability.

---

## 18. Testing strategy

### Unit (vitest; `/* @vitest-environment jsdom */` for renderer tests)

- `orchestrationService.test.ts` — etag collisions, mutex serialization, concurrent `claimTask` (exactly one wins), patch-path whitelist per role, schema validation, `planAppend` idempotence on retry, watcher event emission, watcher self-write suppression, `serverGeneration` monotonicity across simulated checkout.
- `orchestrationTools.test.ts` — lead lacks editFile/writeFile/bash; worker lacks spawnAgent/planWrite; validator only patches checklist runs; `messageAgent` kind/intent whitelist per role; spawn brief section validation.
- `patchPolicy.test.ts` — id-predicate path matching; role-by-role allow/deny.
- `validationConcerns.test.ts` — server rejects `status: "done"` when required checklist incomplete; accepts when `humanOverride` + `UserOverrideEntry` present in same patch.
- `modelRouting.test.ts` — precedence `byRoleTag → byTag → byRole → default → fallback`; unresolved path errors.
- `permissionProfile.test.ts` — every provider's worker mode string is in its runtime union (`CURSOR_AVAILABLE_MODE_IDS`, etc.); cursor worker is `"full-auto"`.
- `bashHardening.test.ts` — `ln` (hardlink) blocked; `python -c "open(...)"` blocked when `blockByDefault`; symlink + hardlink to manifest both refused; `artifacts/` writes succeed.

### Renderer (vitest + RTL)

- `OrchestrationPanel.test.tsx` — accordion behavior, manifest subscribe re-renders, empty Q&A history state, asset preview embed.
- `PlanMarkdown.test.tsx` — mermaid lazy-load, stable section ids, HTML-asset link → spec card.
- `OrchestratorLeadFrame.test.tsx` — conic-gradient renders, static fallback under reduced-motion.
- `AnnotationFlow.test.tsx` — selection → popover → CustomEvent dispatch → composer attachment merge.
- `ModelPickerPendingInput.test.tsx` — `kind: "model_selection"` renders ModelPicker, resolve flow.

### Integration (mock providers)

- End-to-end Planning → Developing → Validating with a mocked Claude runtime. Lead inspects repo, asks Q&A, picks models, presents approval, user approves, spawns one worker per tag, worker patches status, emits `reverify_changes` evidence, validator runs `pre_completion_gate`, manifest reaches terminal state. Assert `plan.md` contains expected `DecisionLogEntry` rows and `UserOverrideEntry` row when override applied.

### Manual smoke

- Real run on a small repo with two workers (one `web-ui`, one `backend`) and validators of two concerns.
- Verify rainbow chrome on lead only; live plan panel updates on etag bump; annotation selection → composer; cancellation with `revert: true` actually reverts files via git.

### Final audit gate

Run `/Users/arul/ADE/.claude/commands/audit.md` against the PR diff. Apply its rubric to the new files + modified files in §19. Resolve P0 / P1 findings before review request.

---

## 19. Critical files

### New

- `apps/desktop/src/shared/types/orchestration.ts`
- `apps/desktop/src/main/services/orchestration/orchestrationService.ts`
- `apps/desktop/src/main/services/orchestration/patchPolicy.ts`
- `apps/desktop/src/main/services/ai/tools/orchestrationTools.ts`
- `apps/desktop/src/renderer/components/chat/OrchestratorLeadFrame.tsx`
- `apps/desktop/src/renderer/components/orchestration/OrchestrationPanel.tsx`
- `apps/desktop/src/renderer/components/orchestration/PlanMarkdown.tsx`
- `.agents/skills/ade-orchestrator/SKILL.md`
- All accompanying `*.test.ts(x)` per §18.

### Modified

- `apps/desktop/src/shared/types/chat.ts` — `AgentChatInteractionMode` union, `PendingInputKind` extension, session fields.
- `apps/desktop/src/shared/ipc.ts` — new channel constants.
- `apps/desktop/src/main/services/chat/agentChatService.ts` — system-prompt directive builder; persistence of new session fields; public `readTranscript` wrapper; per-turn re-pin block.
- `apps/desktop/src/main/services/ai/tools/universalTools.ts` — bash bundle-path blocklist, hardened `MUTATING_BASH_RE` + `INTERPRETER_RE`, `blockByDefault` for orchestration workers.
- `apps/desktop/src/main/services/ai/tools/systemPrompt.ts` — `buildCodingAgentSystemPrompt` extended with orchestration role args.
- `apps/desktop/src/main/services/ipc/registerIpc.ts` — register new IPC handlers next to `agentChat*` cluster (line 6463+).
- `apps/desktop/preload.ts` + `preload/global.d.ts` — `window.ade.orchestration.*` bridge.
- `apps/desktop/src/renderer/components/chat/AgentChatPane.tsx` — mount panel + lead frame; listen for `ade:agent-chat:add-plan-annotation`; role banner for worker/validator chats.
- `apps/desktop/src/renderer/components/chat/AgentChatComposer.tsx` — "+" entry; `orchestrationRole` lock prop; hide picker rows.
- `apps/desktop/src/renderer/components/terminals/SessionListPane.tsx` — "New orchestrator chat" option.
- `apps/desktop/src/renderer/components/terminals/SessionCard.tsx` — role badges.
- `apps/desktop/src/renderer/components/terminals/useWorkSessions.ts` — project orchestration fields into `TerminalSessionSummary`.
- `apps/desktop/src/renderer/components/shared/ModelPicker/ModelPicker.tsx` — accept `availableModels` prop scope; hide permission rows when invoked from pending-input.

---

## 20. Open items, deferred to v2, risks

### v2 schema reservations (present in v1; unused in v1 code paths)

- `coordinatorSessionId` / `peerRunIds` — multi-orchestrator coordination.
- `parentRunId` / `forkedAtEtag` / `forkReason` — plan forking ("Plan A → Plan B").
- `ValidationRecipe.source` — pluggable recipe files.
- `ModelRouting.byLabel` / `byPredicate` — multi-axis routing (labels + role + tag).
- `EvidenceRef.external_url` variant — linking out to Linear / Sentry / etc.
- `OrchestrationTask.relatedTaskIds` — non-blocking "see also" links.

### Deferred to v2 unless v1 budget allows

- Drag-reorder of tasks; direct in-panel editing of `plan.md` prose.
- Sandboxed full-page HTML Preview tab (the Spec card "Open in ADE browser" suffices for v1).
- `deep_maintainability` concern wiring (schema in v1, no UI surfacing).
- HMAC envelope hardening on inter-agent messages (skill discipline only in v1).
- Persistent annotations (v1 is pure ephemeral).
- Per-agent budget enforcement at runtime (schema reserved; no auto-pause logic in v1).

### Risks

- **`PlanMarkdown` rewrite** is the biggest single UI piece. Graceful fallback if budget squeezes: render `plan.md` through existing `ChatMarkdown` and show a flat task list with status pills. Lose mermaid / asset embeds / stable anchors but feature still works.
- **Provider mode strings** may shift between Cursor / Droid / OpenCode releases. `permissionProfile.test.ts` is the canary.
- **Cooperative reload latency** for in-flight bash steps. Mitigation already in place (cancellation watcher hook, §16.2).
- **Chokidar startup cost** per run. Lazy-start mitigation in §16.8.

---

## 21. Final audit gate

After all six steps land, run `/Users/arul/ADE/.claude/commands/audit.md` against the PR diff. Apply its rubric to the new files + modified files in §19. Resolve P0 / P1 findings before requesting review.

The audit's principles (retrace, error paths, edge cases, surrounding contracts, fix-what-you-find, report) are the same ones the orchestrator's `reverify_changes` validation concern embodies — so by the time the PR lands, much of the audit should already have been done by the orchestrator's own validators on themselves. But run the human-invoked `/audit` anyway as the final gate.
