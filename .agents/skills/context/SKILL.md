---
name: context
description: >-
  Session primer for ADE work: what ADE is, the dev loop, the tooling you can
  reach (the `ade` CLI control plane, app/browser/iOS-sim control, Linear,
  computer-use), and what's in flight on this branch. Auto-detects the active
  feature area from branch changes (or explicit keywords) and loads only the
  relevant docs + the matching perf skill — never a broad dump.
---

# Context Skill

Session primer. Run once at the start of a session to learn what ADE is, how we
work, the tooling you can reach, and what (if anything) is in flight on this
lane. Feature-aware — load only the docs relevant to the work, never a broad
dump.

**Invocation:** `/context` or `/context <keywords>`
**Arguments:** optional feature/domain keywords (e.g., `prs`, `lanes rebase`, `tui`).

---

## Step 1 — Determine scope

**Args given:** parse the feature/domain keywords; pick the product area; build
the doc + perf-skill set from `references/doc-map.md`.

**No args:** auto-detect from the lane.

```bash
git diff main --name-only                       # tracked changes vs main
git status --short                              # NEW (untracked) files git diff misses
git log main..HEAD --oneline                    # commits unique to this lane
```

`git diff main` does **not** list untracked files — on a lane whose whole point
is new files (a new service, a new skill), the changes are invisible without
`git status`. Always fold both in. Then infer the area from the changed paths and
resolve docs + the matching `ade-perf-*` skill via `references/doc-map.md`.

---

## Step 2 — Baseline (always read)

- `AGENTS.md` — how to run/build/test, working norms, gotchas, the dev loop.
- `docs/README.md` — the internal-docs navigation map.
- `docs/PRD.md` — what ADE is, who it's for, the feature index.
- `docs/ARCHITECTURE.md` — read the **section** relevant to the touched area
  (IPC, data plane, build/test/deploy), not the whole file. It's large.

---

## Step 3 — Feature docs + perf skill

Match changed paths / keywords against `references/doc-map.md` and load that doc
set only. Each `docs/features/<area>/README.md` opens with a **Source file map**
and a **gotchas / fragile areas** section — read those first; a flagged
invariant usually deserves care (and a test later in `/test`).

If the area maps to a performance skill (`ade-perf-boot`, `ade-perf-lanes`,
`ade-perf-prs`, `ade-perf-work`, or `ade-tui-web-preview`), open that skill too
**before editing** — it records measured patterns you must preserve.

---

## Step 4 — Ongoing work (the *why*, not just filenames)

```bash
git log main..HEAD --stat        # what the lane's commits changed
git diff main                    # committed + uncommitted tracked work
git status --short               # new/untracked work the diff omits
```

- Read the diff to understand the purpose of the in-flight work.
- If a commit or branch name carries a Linear ID (e.g. `ADE-123`), read the
  issue for intent (`ade linear` — see the `ade-linear` skill).
- Cross-check the feature doc's task tracking (`[ ]` / `[x]`).
- **No lane commits and no diff → say "Fresh lane — no in-flight work."**
  Don't invent context.

---

## Step 5 — Summarize

Emit this and nothing more (keep it scannable):

```markdown
## Context Loaded

**Project:** ADE — local-first desktop env for orchestrating coding agents,
lanes, PRs, and proof/artifacts (Electron + React + TS; CLI in `apps/ade-cli`).
**Branch:** [name] · [N changed files | fresh lane]
**Area:** [feature] — [desktop / cli / tui / ios / cross-cutting]
**Docs:** [loaded list]   **Perf skill:** [ade-perf-* loaded | none for this area]

**In flight:** [what the work does + why, or "Fresh lane — no in-flight work"]
**Tracking:** [open N / done N · Linear: IDs or none · gaps if any]

**Tools (configured — use them for live state, don't ask):** `ade` CLI control
plane · app/browser/iOS-sim/macOS-VM control · Linear (via `ade`) · computer-use
+ proof drawer. Depth → the matching `ade-*` skill.
**Dev loop:** /context → work → /quality → /test → /ship. Utilities: /audit,
/finalize, /optimize, /release. Open each skill when you reach it.
**Tests:** [commands for this area — see AGENTS.md "Validation"]

Ready to assist with [feature].
```

---

## Tooling you have

ADE ships its capabilities as Agent Skills. State them briefly in the summary;
open the relevant one only when a task needs it.

- **`ade` CLI** — the control plane for ADE state (lanes, chats, actions, PRs,
  proof, runtime/socket, project secrets via `ade secrets`). Ground truth is
  `ade help <command>` and `ade actions list --text`, not memory.
  → `ade-cli-control-plane`.
- **Lanes & git** → `ade-lanes-git`. **PR workflows** → `ade-pr-workflows`.
- **App / browser / iOS-sim control** → `ade-app-control`,
  `ade-browser`, `ade-ios-simulator`.
- **Linear** (no API key needed; routed through ADE) → `ade-linear`.
- **Proof & computer-use** (screenshots, video, traces → proof drawer) →
  `ade-proof-artifacts`. **Deeplinks** → `ade-deeplinks`.

**Worktree note:** ADE runs this session inside a lane worktree
(`.ade/worktrees/<lane>/`). Every edit must target a path under that worktree,
never the project-root checkout.

---

## Optional deepening (load only when architecture detail is needed)

`docs/ARCHITECTURE.md` covers IPC, the data plane, and build/test/deploy in full
— read the specific section when touching `preload/`, `shared/ipc.ts`,
`registerIpc`, or a cross-app/service boundary.
