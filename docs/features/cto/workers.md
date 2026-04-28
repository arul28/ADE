# Workers (Team)

Workers are named agent identities that ADE can wake for delegated work. The CTO owns the team; workers execute inside lanes with their own budgets, heartbeats, and core memory. Workers are distinct from mission-run workers (which are transient and role-based) — a Team worker is a stable, configurable identity.

## Source file map

### Services (apps/desktop/src/main/services/cto/)

- `workerAgentService.ts` — worker identity CRUD, core memory, config revisions, org tree. `createWorkerAgentService(args)` is the entry point. Returns `WorkerAgentService`.
- `workerBudgetService.ts` — budget caps and spend tracking per worker and for the CTO org overall. `recordCostEvent`, budget snapshots, monthly rollups.
- `workerHeartbeatService.ts` — heartbeat policy (interval, pause threshold), liveness reporting, activity feed updates.
- `workerRevisionService.ts` — config revision history; every identity change lands as a new `AgentConfigRevision`.
- `workerTaskSessionService.ts` — short-lived task session records that tie a worker to a lane/issue/run.
- `workerAdapterRuntimeService.ts` — adapter lifecycle management for `claude-local`, `codex-local`, `process`, `openclaw-webhook`.

### Renderer (apps/desktop/src/renderer/components/cto/)

- `TeamPanel.tsx` — worker editor, detail view, Linear identity mapping. Re-exports `WorkerDetailPanel`, `WorkerEditorPanel`, `workerDraftFromAgent`.
- `WorkerCreationWizard.tsx` — two-step wizard: template pick then configure.
- `WorkerActivityFeed.tsx` — recent worker runs and sessions.
- `AgentSidebar.tsx` — memoized worker list with status dot and budget chip.
- `shared/designTokens.ts` — `WORKER_TEMPLATES` array (backend engineer, frontend engineer, QA tester, DevOps, researcher, custom).

## Data model

`AgentIdentity` fields (from `shared/types`):

- `id`, `name`, `slug`, `role` (`cto` | `engineer` | `qa` | `designer` | `devops` | `researcher` | `general`).
- `title` (display), `reportsTo` (parent worker id or null).
- `capabilities` (deduplicated string list).
- `status` (`idle` | `active` | `paused` | `running`).
- `adapterType` (`claude-local` | `codex-local` | `process` | `openclaw-webhook`).
- `linearIdentity` (`AgentLinearIdentity` — user ids, display names, aliases).
- Secret-policy fields pass through `assertEnvRefSecretPolicy`: raw secret-like values are rejected; only `${env:VAR}` references are allowed. Applies recursively to any object/array under an adapter config.

`AgentCoreMemory` — per-worker core memory with the same shape as CTO core memory (`projectSummary`, `criticalConventions`, `userPreferences`, `activeFocus`, `notes`).

`AgentConfigRevision` — a historical snapshot of an identity update. Revisions are append-only; `workerRevisionService` writes one per save.

`AgentSessionLogEntry` — per-worker session log with `sessionId`, `summary`, `startedAt`, `endedAt`, `provider`, `modelId`, `capabilityMode` (`full_tooling` or `fallback`). Matches CTO session logs.

`WorkerOrgNode = AgentIdentity & { reports: WorkerOrgNode[] }` — tree representation used by `AgentSidebar`.

## Creation wizard

`WorkerCreationWizard.tsx` has two steps:

1. **Template** — pick from `WORKER_TEMPLATES`:
   - `backend-engineer` (engineer role, capabilities: api, database, architecture, debugging)
   - `frontend-engineer` (engineer role, capabilities: react, css, ui, accessibility)
   - `qa-tester` (qa role, capabilities: testing, e2e, regression, test-planning)
   - `devops` (devops role, capabilities: ci-cd, docker, infrastructure, monitoring)
   - `researcher` (researcher role, capabilities: research, analysis, documentation, architecture)
   - `custom` (general role, blank capabilities)

   Each non-custom template seeds `model: "claude-sonnet-4-6"` and `adapterType: "claude-local"`.

2. **Configure** — name, role, capabilities (comma list), model selector, budget in dollars.

On save, `window.ade.cto.saveAgent({ agent })` persists through `workerAgentService.upsert()`. The wizard auto-slugifies names and rejects invalid role/status/adapter combinations.

## Team panel

`TeamPanel.tsx` renders three surfaces depending on selection:

- **List** — table of workers with status, role, recent activity, spend.
- **Worker editor** — detailed edit surface. Fields: name, role, title, reports-to, capabilities (chip list), Linear identity (user ids + display names + aliases), adapter type, heartbeat policy, runtime config.
- **Worker detail** — read-only view with core memory, config revisions timeline, recent session logs, recent runs, Linear workflow activity.

The heartbeat policy lets the operator toggle "always running" vs idle-on-demand behavior per worker.

## Adapter types

`workerAdapterRuntimeService.ts` owns the lifecycle for each adapter:

- `claude-local` — Claude CLI subprocess. Uses `resolveClaudeCliModel`.
- `codex-local` — Codex CLI subprocess. Uses `resolveCodexCliModel`.
- `process` — generic managed process (e.g. for running a long-lived worker bin).
- `openclaw-webhook` — routes through an OpenClaw webhook adapter.

Adapter config is validated for env-reference-only secrets — the service refuses to persist raw API keys in config fields and requires `${env:VAR}` references instead.

## Budgets

`workerBudgetService.ts` tracks cost events:

- `RecordCostEventInput`: agentId, optional runId/sessionId, provider, modelId, input/output tokens, costCents, `estimated` flag, source (`api` / `cli` / `manual` / `reconcile`).
- Cost events aggregate into monthly rollups keyed `YYYY-MM`.
- `estimateCodexCostCents(inputTokens, outputTokens)` provides the default estimate for codex/gpt families (matches ADE's Smart Budget).
- `AgentBudgetSnapshot` (returned by `getBudgetSnapshot`): per-worker `budgetMonthlyCents`, `spentMonthlyCents`, plus an aggregate across the org.

The sidebar's `AgentRow` checks `budgetBreached = (budgetMonthlyCents > 0) && (spentMonthlyCents >= budgetMonthlyCents)` and shows a warning chip. Budget caps are soft — nothing blocks execution, but the UI surfaces the breach so operators can intervene.

## Heartbeats

`workerHeartbeatService.ts` manages the optional always-running heartbeat for each worker. Configurable per worker via `HeartbeatPolicy` — interval, pause threshold, automatic restart. Workers with heartbeat disabled only come to life when woken explicitly (via `wakeWorker` from CTO chat or from a Linear workflow dispatch).

Heartbeat events feed into the CTO activity feed through `appendCtoSubordinateActivity` so the sidebar shows recent worker liveness without requiring the Team tab to be open.

## Linear mapping

`AgentLinearIdentity` on a worker identity captures:

- `linearUserIds` — Linear user IDs this worker represents.
- `displayNames` — human display names (for dashboard matching).
- `aliases` — alternate names / handles.

The Linear dispatcher uses these to resolve an issue assignee back to an ADE worker. When nothing matches, the run enters `awaiting_delegation` (see `linear-integration.md`).

## Post-compaction identity recovery

Worker sessions undergo the same post-compaction identity re-injection as CTO sessions. The worker's identity, core memory, and the capability manifest are re-injected when the runtime detects compaction. This prevents the worker from drifting into generic-chatbot behavior after long conversations. Implementation lives in `agentChatService` with per-worker context supplied by `workerAgentService.getAgent()`.

## Runs

`WorkerAgentRun` records a delegated run with `laneId`, `issueKey`, `sessionId`, `status`, timestamps, and cost totals. `workerTaskSessionService` ties runs to their triggering lane/issue/mission. Runs surface in:

- the Team panel's Recent Runs list,
- the sidebar budget footer (monthly totals),
- `WorkerActivityFeed` via the activity log.

## Secret policy

Worker config is strict about secrets (`assertEnvRefSecretPolicy`):

- Any string value at a key that looks sensitive (`looksSensitiveKey`) or that has a value that looks sensitive (`looksSensitiveValue`) must be either `isEnvRef` (exact `${env:VAR}` token) or contain an env ref token (`hasEnvRefToken`).
- Raw secrets throw a clear error: `"Raw secret-like value is not allowed at '<path>'. Use ${env:VAR_NAME}."`
- The check walks arrays and nested objects recursively.

This prevents accidental commit of API keys into worker config revisions.

## Gotchas

- **`reportsTo` forms the org tree but is not enforced.** A worker can report to another that reports back (cycle). The UI tolerates this by deduplicating during tree build; service-level validation is deliberately lenient.
- **Slug uniqueness is per-project.** `slugify` produces collisions for similar names; the service does not auto-suffix. Rename or pick distinct names.
- **Budgets don't block.** They warn. If you need hard caps, configure at the project level (`budgetCapService`).
- **Heartbeat policy on worker vs CTO.** The CTO heartbeat policy is separate (`HeartbeatPolicy` attached to CTO identity). Don't confuse them.
- **`normalizeIdentity` drops rows that don't pass validation.** Malformed DB rows are silently skipped during list; watch for missing workers if you hand-edit the sqlite store.

## Cross-links

- `README.md` — CTO overview.
- `identity-and-memory.md` — worker core memory mirrors CTO core memory schema.
- `linear-integration.md` — worker runs launched via `worker_run` target type.
- `onboarding.md` — first-run flow that gates before the team is set up.
- `../missions/workers.md` — mission-run workers (transient role-based runtime) are a different concept.
