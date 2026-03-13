---
name: 'get context'
description: 'Load focused context for the current work area'
---

# Get Context

Load context for the current work session. Detects what you're working on from git state, reads the right docs, and gives you the rules to follow.

**Usage:** `/getContext` or `/getContext missions` or `/getContext cto linear`

**Arguments:** `$ARGUMENTS`

---

## Step 1: Always read these

Read all three — they are short and contain mandatory rules:

1. `docs/PRD.md` — product requirements and boundaries
2. `docs/architecture/SYSTEM_OVERVIEW.md` — system model and current state
3. `docs/architecture/DESKTOP_APP.md` — desktop runtime contract and **performance best practices** (the rules every change must follow)

---

## Step 2: Detect work area

### If arguments are provided

Map keywords to docs:

| Keyword(s) | Docs |
|---|---|
| `lanes`, `worktrees`, `git` | `docs/features/LANES.md` |
| `terminals`, `pty`, `sessions` | `docs/features/TERMINALS_AND_SESSIONS.md` |
| `missions`, `orchestrator`, `workers` | `docs/features/MISSIONS.md` |
| `cto`, `linear`, `workflows` | `docs/features/CTO.md` |
| `prs`, `github`, `integration` | `docs/features/PULL_REQUESTS.md` |
| `graph`, `workspace` | `docs/features/WORKSPACE_GRAPH.md` |
| `settings`, `onboarding` | `docs/features/ONBOARDING_AND_SETTINGS.md` |
| `computer-use`, `artifacts`, `proof` | `docs/computer-use.md`, `docs/architecture/COMPUTER_USE_ARTIFACT_BROKER.md` |
| `jobs`, `automation` | `docs/architecture/JOB_ENGINE.md` |
| `memory`, `digest`, `embedding` | `docs/features/MISSIONS.md` (memory section) |

### If no arguments are provided

Auto-detect from recent changes:

```bash
git log --oneline -10
git diff HEAD --name-only
git diff --cached --name-only
```

Map changed file paths to the feature area:

| Path contains | Feature area |
|---|---|
| `services/lanes/`, `components/lanes/` | Lanes |
| `services/pty/`, `services/sessions/`, `components/terminals/` | Terminals |
| `services/orchestrator/`, `services/missions/`, `components/missions/` | Missions |
| `services/cto/`, `components/cto/` | CTO |
| `services/prs/`, `components/prs/` | PRs |
| `components/graph/` | Graph |
| `services/computerUse/`, `components/settings/ComputerUse` | Computer-use |
| `services/chat/`, `components/chat/` | Chat |
| `services/jobs/` | Jobs |
| `main/main.ts`, `services/ipc/` | Desktop core |

Read the corresponding feature docs from the keyword table above.

---

## Step 3: Summarize

Output a short summary:

```
## Context

**Working on:** [feature area]
**Recent changes:** [1-2 sentence summary of git log/diff]
**Docs loaded:** [list]
**Key rules:** [2-3 most relevant best practices from DESKTOP_APP.md for this area]

Ready to assist with [feature area].
```

Keep it brief. The point is context, not a report.
