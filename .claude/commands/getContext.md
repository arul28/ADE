---
name: 'get context'
description: 'Load focused context for the feature area being worked on in the ADE desktop app'
---

# Get Context Command

This command loads context for the current work session and is **feature-aware**.

It must:
- detect the active feature area from branch changes (or arguments),
- load the correct docs for that feature,
- avoid broad, unfocused doc dumps.

**Usage:**
- `/getContext`
- `/getContext lanes`
- `/getContext terminals sessions pty`

**Arguments:** `$ARGUMENTS`

---

## Step 1: Determine Scope

### If Arguments Are Provided
- Parse feature/domain keywords.
- Determine layer (`main-services`, `renderer-ui`, `shared`, or `cross-cutting`).
- Build a target doc list from the mapping table below.

### If No Arguments Are Provided
Auto-detect from branch changes:

```bash
git diff main --name-only
git diff main --stat | tail -20
```

Use changed paths to infer feature area and docs.

---

## Step 2: Load Baseline Context (Always)

Read packs first (bounded, reviewable), then docs as fallback.

Read (in order):
- `.ade/packs/project_pack.md` (project-wide context)
- Relevant lane context (when laneId is known):
  - Prefer bounded export via IPC: `ade.packs.getLaneExport({ laneId, level: "standard" })`
  - Otherwise read: `.ade/packs/lanes/<laneId>/lane_pack.md`
- `docs/architecture/CONTEXT_CONTRACT.md` (markers/exports/deltas contract)

Only pull in `docs/PRD.md` / `docs/IMPLEMENTATION_PLAN.md` if packs are missing/empty or the user explicitly asks for roadmap context.

---

## Step 3: Feature-Aware Doc Mapping

Use this mapping to load the right docs based on changed paths or arguments.

### Main Process Services Mapping

| Path Pattern | Feature | Docs |
|---|---|---|
| `apps/desktop/src/main/services/lanes/` | Lanes | `docs/features/LANES.md`, `docs/architecture/GIT_ENGINE.md` |
| `apps/desktop/src/main/services/git/` | Git Engine | `docs/architecture/GIT_ENGINE.md` |
| `apps/desktop/src/main/services/pty/`, `apps/desktop/src/main/services/sessions/` | Terminals & Sessions | `docs/features/TERMINALS_AND_SESSIONS.md` |
| `apps/desktop/src/main/services/processes/`, `apps/desktop/src/main/services/tests/` | Processes & Tests | `docs/features/PROJECT_HOME.md` |
| `apps/desktop/src/main/services/files/` | Files | `docs/features/FILES_AND_EDITOR.md` |
| `apps/desktop/src/main/services/packs/` | Packs | `docs/features/PACKS.md` |
| `apps/desktop/src/main/services/conflicts/` | Conflicts | `docs/features/CONFLICTS.md` |
| `apps/desktop/src/main/services/history/` | History | `docs/features/HISTORY.md` |
| `apps/desktop/src/main/services/jobs/` | Job Engine | `docs/architecture/JOB_ENGINE.md` |
| `apps/desktop/src/main/services/config/`, `apps/desktop/src/main/services/state/` | Config & State | `docs/architecture/CONFIGURATION.md`, `docs/architecture/DATA_MODEL.md` |
| `apps/desktop/src/main/services/ipc/` | IPC | `docs/architecture/DESKTOP_APP.md` |
| `apps/desktop/src/main/services/logging/` | Logging | `docs/architecture/SYSTEM_OVERVIEW.md` |
| `apps/desktop/src/main/services/projects/` | Project Management | `docs/features/PROJECT_HOME.md` |

### Renderer Components Mapping

| Path Pattern | Feature | Docs |
|---|---|---|
| `apps/desktop/src/renderer/components/lanes/` | Lanes UI | `docs/features/LANES.md` |
| `apps/desktop/src/renderer/components/terminals/` | Terminal UI | `docs/features/TERMINALS_AND_SESSIONS.md` |
| `apps/desktop/src/renderer/components/project/` | Project Home UI | `docs/features/PROJECT_HOME.md` |
| `apps/desktop/src/renderer/components/files/` | Files UI | `docs/features/FILES_AND_EDITOR.md` |
| `apps/desktop/src/renderer/components/packs/` | Packs UI | `docs/features/PACKS.md` |
| `apps/desktop/src/renderer/components/conflicts/` | Conflicts UI | `docs/features/CONFLICTS.md` |
| `apps/desktop/src/renderer/components/prs/` | Pull Requests UI | `docs/features/PULL_REQUESTS.md` |
| `apps/desktop/src/renderer/components/history/` | History UI | `docs/features/HISTORY.md` |
| `apps/desktop/src/renderer/components/app/` | App Shell & Navigation | `docs/architecture/DESKTOP_APP.md`, `docs/architecture/UI_FRAMEWORK.md` |
| `apps/desktop/src/renderer/state/` | State Management | `docs/architecture/DATA_MODEL.md` |

### Shared & Cross-Cutting Mapping

| Path Pattern | Feature | Docs |
|---|---|---|
| `apps/desktop/src/shared/types.ts` | Shared Types | `docs/architecture/DATA_MODEL.md` |
| `apps/desktop/src/shared/ipc.ts` | IPC Channels | `docs/architecture/DESKTOP_APP.md`, `docs/architecture/DATA_MODEL.md` |
| `apps/desktop/src/preload/` | Preload Bridge | `docs/architecture/DESKTOP_APP.md` |

### Keyword-to-Feature Mapping (for argument-based lookups)

| Keyword(s) | Feature | Docs |
|---|---|---|
| `lanes`, `worktrees`, `stacks` | Lanes | `docs/features/LANES.md`, `docs/architecture/GIT_ENGINE.md` |
| `terminals`, `pty`, `sessions` | Terminals | `docs/features/TERMINALS_AND_SESSIONS.md` |
| `files`, `editor`, `monaco` | Files & Editor | `docs/features/FILES_AND_EDITOR.md` |
| `packs`, `context`, `checkpoints` | Packs | `docs/features/PACKS.md` |
| `conflicts`, `diffs`, `merge` | Conflicts | `docs/features/CONFLICTS.md` |
| `prs`, `pull-requests`, `github` | Pull Requests | `docs/features/PULL_REQUESTS.md` |
| `history`, `graph`, `commits` | History | `docs/features/HISTORY.md`, `docs/features/WORKSPACE_GRAPH.md` |
| `processes`, `tests`, `project` | Project Home | `docs/features/PROJECT_HOME.md` |
| `settings`, `onboarding`, `config` | Settings | `docs/features/ONBOARDING_AND_SETTINGS.md`, `docs/architecture/CONFIGURATION.md` |
| `ipc`, `preload`, `electron` | Desktop Architecture | `docs/architecture/DESKTOP_APP.md` |
| `git`, `worktree`, `branch` | Git Engine | `docs/architecture/GIT_ENGINE.md` |
| `jobs`, `automation` | Jobs & Automations | `docs/architecture/JOB_ENGINE.md`, `docs/features/AUTOMATIONS.md` |
| `cloud`, `hosted`, `agent` | Cloud & Agents | `docs/architecture/CLOUD_BACKEND.md`, `docs/architecture/HOSTED_AGENT.md` |

---

## Step 4: Task-Tracking Awareness

For each loaded feature doc:
- extract task-tracking signals (`[ ]`, `[x]`, `Task Tracking`),
- summarize open vs done tasks,
- flag missing/inconsistent tracking.

Also check `docs/IMPLEMENTATION_PLAN.md` for the current phase status and what's next.

---

## Step 5: Summarize Context

Output format:

```markdown
## Context Loaded

### Branch Status
- Branch: [name]
- Changed files: X
- Primary layer: [main-services/renderer-ui/shared/cross-cutting]

### Active Feature Area
- Feature: [name]
- Docs loaded: [list]

### What Is Being Worked On
- [specific files/areas]
- [work type: new feature / bug fix / refactor / docs]

### Implementation Phase
- Current phase: [from IMPLEMENTATION_PLAN.md]
- Phase status: [% complete, key remaining items]

### Task Tracking Snapshot
- Open tasks: [count + key items]
- Done tasks: [count + key items]
- Tracking gaps: [if any]

### Key Implementation Context
- [most relevant services/components/types/IPC channels]
- [architectural constraints or patterns to follow]

### Available Commands
- `npm run dev` — start dev server (Vite + tsup + Electron)
- `npm run build` — production build
- `npm run typecheck` — TypeScript check
- `npm run rebuild:native` — rebuild node-pty for Electron
```

End with:
`Ready to assist with [feature area].`

---

## Optional Deepening

Only load if the feature area requires broader architectural context:
- `docs/architecture/SYSTEM_OVERVIEW.md`
- `docs/architecture/UI_FRAMEWORK.md`
- `docs/architecture/SECURITY_AND_PRIVACY.md`
- `docs/architecture/CLOUD_BACKEND.md`
