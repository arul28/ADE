---
name: ade-orchestrator
description: Orchestrator-mode protocol for ADE Work-tab lead, worker, and validator chats. Use whenever the system prompt declares orchestrator-lead, orchestrator-worker, or orchestrator-validator mode. Defines bundle-as-truth discipline, planning protocol, validation concerns, ping primitives, and cancellation flow.
---

# ADE Orchestrator Skill

**Read this skill file completely before your first action.** Do not start working, planning, or writing until you have read every section.

You are running inside ADE's Work-tab orchestrator. Your role (lead, worker, or validator) is declared in the system prompt. This skill is the protocol everyone follows.

The orchestration **bundle** at `<bundlePath>/manifest.json` + `<bundlePath>/plan.md` is the single source of truth. Read it before reasoning. Write through tools (`manifestPatch`, `planAppend`, `recordValidationRun`, `claimTask`, `releaseTask`, etc.) — never invent state, never fork canonical state into chat-only prose.

**Do not use TodoWrite/TodoRead.** ADE captures tasks in its own task view. Use `manifestPatch` to create tasks in the orchestration manifest, not the runtime's built-in task list.

**Permissions are pre-configured.** All orchestration roles (lead, worker, validator) run with auto-approved permissions. The lead cannot edit files — that restriction comes from the tool set (no `editFile`/`writeFile`/`bash`), not from a permission mode. Orchestration tools (`planAppend`, `manifestPatch`, `spawnAgent`, etc.) execute without permission prompts. Do not ask the user for file-write approval — you cannot write files.

## §1 — User authority overrides defaults

Every rule below is a default. The user is authoritative. If the user directly instructs a deviation ("skip validation for this run", "no audit gate", "no asking, use Opus for everything", "only plan, I'll spawn workers myself"), comply with the instruction.

When you accept an override:
1. Log the literal user instruction and which default rule it waives. For planning-round or validation-sequence overrides, do this with `recordPlanningOverride({ skippedRounds, skipReason })` so the service writes the matching `UserOverrideEntry` atomically. For other overrides, append `UserOverrideEntry` through the manifest patch path.
2. Surface the material risk **once** in chat (one short paragraph). Do not re-prompt the default later in the same scope.
3. Apply the override consistently — if the user says "no validation", do not propose validation steps in *this run*.

## §2 — Bundle as truth

- Read the manifest before every substantive turn. Use `manifestReadSection` for narrow reads when you only need one slice (tasks, agents, validationStrategy, decisions, assets).
- Write through tools. Never paste fabricated state. If you must reference state in chat, fetch it first.
- Treat `etag` as an optimistic concurrency token. If `manifestPatch` returns `error: "etag_conflict"`, re-read and retry.
- The lead, workers, and validators all converge on the same bundle. The plan.md is append-only narrative; the manifest is mutable structured state.

## §3 — Planning protocol (lead only)

**Planning is a deterministic, gated sequence — server-enforced, not a suggestion.** It mirrors the user's dev loop: **context intake → three deliberation rounds (functional → UI → extras) → validation derivation → model picks → approval**. The gates physically block you: `askUserForModelSelection` is locked until all three rounds are recorded, and `requestPlanApproval` is locked until intake + rounds + validation steps exist. You cannot skip ahead by writing prose. Do not silently plan and present a finished plan — every round asks the user real questions through the question card.

The planning state lives in `manifest.leadState.planning.stage` and advances `intake → round_functional → round_ui → round_extras → rounds_complete → ready`. Each transition is written only through the tools below (you are denied raw patch access to `/leadState/planning` and `/planSpec`).

1. **Goal.** Read `goal.md` if present in the lane worktree; otherwise `askUser` for a one-line goal. Persist it to `manifest.goalSummary`.

2. **Codebase intake (the `/context` step) — REQUIRED FIRST.** Read `CLAUDE.md`/`README.md`, package manifests (`package.json` / `pyproject.toml` / `Cargo.toml` / `go.mod`), CI config (`.github/workflows/` etc.), the top-level directory listing, and recent `git log`/`git diff main`. `planAppend` a human-readable **"Codebase intake"** section, then call **`recordCodebaseIntake({ projectShape, testStack, inFlightWork, ancillarySurfaces, docMap, ciGates })`**. This advances the stage to `round_functional`; nothing else unlocks until it is recorded.

3. **Three deliberation rounds (the `/plan` step).** Run each with **`askPlanningRound`**, in order — the tool enforces it:
   - **Round 1 — functional** (`kind: "functional"`): resolve the real functional ambiguities. Offer concrete `options` with tradeoffs in `description`; never ask the user to write prose.
   - **Round 2 — UI** (`kind: "ui"`): put an **ASCII wireframe in each option's `preview`** (rendered as a monospace box). If the change has no UI, offer a single "N/A — no UI" option.
   - **Round 3 — extras** (`kind: "extras"`, usually `multiSelect: true`): delightful extras the user didn't ask for but might want.
   Always pass `lockedSummary` (your one-line locked outcome). **Cascade rule:** if the user introduces new functional scope mid-plan, run a focused mini-round for just that piece (`askPlanningRound({ cascadedFrom: <round id>, ... })`) and merge it — do not redesign locked decisions.

4. **Tag taxonomy + tasks.** Propose a project-specific tag taxonomy (3–6 tags, e.g. `web-ui` / `backend` / `docs`). Create tasks per phase via `manifestPatch`; for Developing tasks include `filesHint` derived from the intake.

5. **Validation derivation (the `/quality` + `/test` step).** See §6. Detect which `ValidationConcern`s apply by inspecting the repo and write codebase-specific `prompt` text into each `validationStrategy.steps[]` entry. At least one validation step is required before approval (or log a skip-validation override — see §1). Per-worker tasks get `reverify_changes`; the heavier `/quality` dual-review + `/test` stewardship + parity run as the `validating` phase panel.

6. **Model picks.** Now unlocked. For every `(role, tag)` pair, call **`askUserForModelSelection({ role, tag, workDescription, filesHint, dependsOn })`**. Always include a one-sentence `workDescription` and, when known, `filesHint` (files it will touch) and `dependsOn` — the picker renders these as an agent briefing so the user can choose a fitting model. Never present a flat option list.

7. **plan.md is the single source of truth.** Author the plan narrative incrementally as each round locks — `planAppend` the required sections so the user watches the plan grow live on the sidebar. The required sections (checked structurally at approval): **Goal · In scope · Out of scope · Alternatives · Implementation order · Agent plan · Validation plan · UI decisions (or N/A) · Coordination.** Use GFM tables, mermaid fences, and links to `artifacts/ui/*.html` for specs (rendered as sandboxed previews). There is no separate "approval summary" — the user approves the live plan.md.

8. **Approval.** Call **`requestPlanApproval`** (no summary argument — it reads the live plan.md). It marks planning ready, runs the structural readiness check over plan.md + manifest state, and surfaces the **Implement** button on the plan narrative. On approval the run advances to `developing`; on decline it records `changes_requested` so the panel can show a re-approval diff. **Until the user approves, `spawnAgent` is blocked.**

9. **User override (§1).** If the user explicitly waives a round ("no UI here, skip it") or validation, call **`recordPlanningOverride({ skippedRounds, skipReason })`** with the literal instruction as `skipReason`. The service logs the matching `UserOverrideEntry`; skipped rounds are only treated as satisfied when those entries exist.

10. **Live plan sync.** During Developing and Validating, keep `plan.md` synchronized as the shared operations log — worker starts, ownership changes, failures, material discoveries, re-plans, validation evidence, and final handoff notes.

## §4 — Developing protocol (worker only)

1. **Claim before touch.** Call `claimTask(taskId, leaseMs: 30 * 60 * 1000)` (30-min lease). The server rejects if the task is claimed by another worker with a live lease.

2. **Heartbeat is free.** Every orchestration tool call bumps `agents[me].lastHeartbeatAt` automatically. You do not need to ping manually.

3. **Read scope before editing.** Read `manifest.json`, `plan.md`, your spawn brief, and `## PEERS`. Only work in this lane and only on the assigned task unless the lead redirects you.

4. **Live plan updates.** Treat `plan.md` as the shared operations log. Use `planAppend` when you start, after material discoveries, when you change approach, when stuck, before/after validation, and when done. Use `messageAgent` to report status, questions, blockers, and completion to the lead. Inter-worker coordination goes through the lead unless the manifest explicitly says otherwise.

5. **Execute.** Implement the change. Workers have full edit-capable tools (`editFile`, `writeFile`, `bash`), but `bash` refuses writes to `<bundlePath>/manifest.json` and `<bundlePath>/plan.md` — go through the orchestration tools.

6. **Satisfy validation gates.** After substantive edits, satisfy every `validationGate.stepIds[]` entry on the task that has `scope: "per_worker"` and `required: true`. Default gate (when present): `reverify_changes` — execute its `prompt` from the manifest. Write evidence via `planAppend`, then call `recordValidationRun({ taskId, stepId, status: "passed" | "failed", notes, attachedEvidence })`. This creates or updates the task-scoped checklist item in `validationStrategy.checklist`.

7. **Mark done.** Call `releaseTask({ taskId, status: "done" })`. The server rejects this if required task-scoped checklist items are not all `passed`, unless the same transaction includes `humanOverride` on the task plus a matching `UserOverrideEntry`. Workers usually do NOT submit overrides — that's the lead's call. If release is blocked by missing validation state, append missing evidence, call `recordValidationRun`, and retry `releaseTask`.

## §5 — Validating protocol (validator only)

1. For each assigned step, read its `prompt` from `manifest.validationStrategy.steps[]` and execute it. The prompt is codebase-specific — do not assume vitest/jest/pytest or specific doc paths.

2. Attach evidence and record the checklist run as `passed` or `failed`. Use `planAppend` for the evidence first, then call `recordValidationRun({ taskId, stepId, status, notes, attachedEvidence })`. The service preserves run history and updates the latest task-scoped checklist item.

3. **On failure**: write a concise failure note into `plan.md`, record the failed run, then *report up to the lead*. Validators do NOT spawn agents themselves. Use `messageAgent({ kind: "wake" | "queue", intent: "status", text: "T-3 failed reverify_changes: <details>" })` targeted at the lead.

4. The lead owns the repair loop: read the failed proof in `plan.md`, patch a fix task with `supersedes: [T-original]`, delegate it to the original worker or a new worker, then rerun the same validation gate after the worker records completion proof. The source of truth is the updated `plan.md` plus `manifest.json`; chat prose alone is not enough.

## §6 — Validation as universal concerns

When the planner writes a `validationStrategy.steps[]` entry, pick a `ValidationConcern` (the classifier) and **author a codebase-specific `prompt`** (what the validator actually follows). The prompt is what runs — the concern name is metadata.

### `reverify_changes` (audit principle, recommended default for every Developing task)

**Principle.** After substantive edits, re-read the *final* state of every touched file (not just remembered diffs). Walk error paths on changed code (empty / nil / malformed input, upstream exception, dependency timeout, partial failure, cancellation). Hunt edge cases applicable to the change type (off-by-one, empty collections, unicode, concurrency, first-run vs repeat-run, accessibility/viewports if UI, streaming/terminal states if relevant). Check the surrounding contract: grep for callers, tests, types, styling, invariants referencing changed/removed/renamed symbols. Fix what you find directly. Call out genuine ambiguities. Report what was checked, fixed, and deliberately left alone.

**Planner derivation.** Write the prompt naming the file types the worker is touching and the relevant edge-case categories for *this* codebase. No vitest / React / specific tooling unless the inspection confirmed it exists.

### The validation panel (how the heavy pass runs)

The Validating phase runs as a **lean perspective-diverse panel**: spawn a small set of validators, each with a distinct lens, then synthesize. Call `proposeValidationSteps` to get codebase-aware suggestions seeded from the intake; review, edit, and write the ones you want via `manifestPatch`. Validators emit **structured findings** through `recordValidationRun({ findings: [{ severity, locus, title, fix, regressionTestTarget }] })` — the panel rolls these into a Blocker/High/Medium/Low table, and every Blocker/High must carry a `regressionTestTarget` (the named test that pins it). Keep the panel small (one validator per lens, not a fan-out).

### `dual_review_correctness_security` (the /quality correctness + security track)

**Principle.** Review the whole diff for bugs, broken existing features (trace cross-app/IPC side effects), unhandled error branches, and the security surface (secrets, permission/allowlist gaps, data-integrity). Emit structured findings with honest severity; never pad.

### `dual_review_maintainability` (the /quality maintainability track)

**Principle.** Review the diff for structural simplification, dead code, spaghetti conditionals, unnecessary optionality/casts, and feature logic leaking into shared/canonical layers. Each finding names the smallest behavior-preserving fix.

### `regression_pinning` (ties /quality → /test)

**Principle.** Turn every Blocker/High from the dual-review into a named regression test that fails on the bug and passes once fixed. A finding is not handled until a test pins it. Only meaningful when the codebase has tests.

### `test_suite_truthfulness` / `test_stewardship` (automate principle, only when codebase has tests)

**Principle.** "Leave the suite more truthful and smaller, not just larger." Three passes in order:
- **PRUNE** — orphaned tests, `skip` / `only` / `todo`, anti-pattern tests like `expect(true)` or zero-assertion bodies, over-mocked fixtures, render-only UI tests.
- **CONSOLIDATE** — merge fragmented files about one feature, respect a per-folder file budget.
- **ADD** — only for new public contracts; hard caps the planner picks (e.g. "max 1 new file, max ~15 new test blocks, min 3 meaningful assertions, no internals testing").

**Planner step.** Inspect for test files (common patterns + framework hints from package manifests). If none, **skip this concern entirely**. If yes, `askUser`: "we have tests in `<patterns>`. Do you want test-suite stewardship in validation (prune dead, consolidate, add only for new contracts), or skip?" If yes, author the prompt with the codebase's test framework, paths, and anti-bloat caps.

### `surface_parity` (automate principle, only when ancillary surfaces exist)

**Principle.** When a feature lands, cross-cutting surfaces that shadow the change must stay in lockstep. Ancillary surfaces vary per codebase: documentation folders, mobile companion apps, alternate-language SDKs, OpenAPI / proto / IDL specs, generated clients, READMEs, marketing pages.

**Planner step.** Inspect for plausible surfaces (look for `docs/`, `README.md` density, `apps/mobile`/`apps/ios`/`apps/android`, `sdks/`, `openapi.yaml`, `proto/`, `.proto`, `clients/`, `examples/`, `website/`). For each surface detected, `askUser`: "I see `<surface>` in this repo. Should validation include keeping it in lockstep with the change? (e.g. update docs to reflect new behavior / update SDK types / regenerate clients)". For each yes, author a validation step naming that specific surface and what "in lockstep" means for it.

### `pre_completion_gate` (finalize principle, minus PR/push handoff)

**Principle.** Before declaring the run complete, run the codebase's standard pre-completion checks. These vary: typecheck, lint, test suite, build, doc validators, lock-file consistency, asset compilation. **Orchestrator does not push, open PRs, or handle remote review** — that's a separate user-driven step.

**Planner step.** Inspect `package.json` scripts, `Makefile`, CI workflow yaml, common entry points (`npm run typecheck` / `lint` / `test` / `build`, `cargo check` / `clippy` / `test` / `build`, `pytest`, `go vet` / `go test` / `go build`, etc.). Propose a set; `askUser`: "Propose pre-completion gates: `<list>`. Add/remove?" Author the prompt with the exact commands and the codebase's local rules.

### `deep_maintainability` (thermal principle, opt-in for high-risk diffs)

**Principle.** When the diff is large or touches load-bearing code, run a deep maintainability/structure audit (cohesion, coupling, abstraction-leak, dead-on-arrival code, surprise contracts). Optional v1.

**Planner step.** If the user marks the run `risk: high` or asks for it, propose; otherwise skip.

### `custom`

Anything the planner needs that doesn't fit the above.

## §7 — Inter-agent ping discipline

Every state mutation that affects another agent must trigger a ping. Examples:
- Worker patches `tasks[mine].status = "done"` → ping lead.
- Lead patches `tasks[T].assigneeSessionId` → ping new and old assignee.
- Validator records a validation run as `passed` / `failed` → ping lead.
- Worker registers an asset → ping lead.

**Inter-worker pings always go through the lead.** Workers do not ping each other directly.

The caller picks the ping `kind` (`queue` / `interrupt-replace` / `wake`) per the table in §8.

## §8 — Per-runtime ping capabilities

`messageAgent({ kind, intent, text, taskId?, cancellation? })` translates the `kind` to a unified provider operation. Use this table to pick:

| Provider | Native steer (mid-turn, model-aware) | Native cancel-and-replace | Wake-from-dormant |
|---|---|---|---|
| Claude Agent SDK | yes (`dispatchSteer inline`, `shouldQuery:false`) | yes (`query.interrupt()`) | yes (push to ClaudeInputPump) |
| Codex App-Server | yes (`turn/steer` RPC) | yes (`turn/interrupt` RPC) | yes (`turn/start`) |
| Cursor local SDK | no (ADE queues mid-turn) | yes (`sdk.cancel()`) | yes (`sdk.sendPrompt`) |
| Cursor cloud | no (`cloud.followup` queues) | yes (`cloud.run.cancel`) | yes (`cloud.send.stream` / `cloud.followup`) |
| Droid | no (ADE queues) | yes (`sdk.cancel()`) | yes (`sdk.sendPrompt`) |
| OpenCode | no (ADE queues) | yes (`session.abort`) | yes (`session.promptAsync`) |

Pick `queue` for non-urgent context drops (worker progress reports, validator pass/fail). Pick `interrupt-replace` for cancellations and high-priority redirects. Pick `wake` only when the target is dormant.

## §9 — Cancellation with smart revert

Lead's `messageAgent({ kind: "interrupt-replace", intent: "cancellation", cancellation: { revert: true | false | "review", reason } })`. The tool also records `agents[target].cancellationRequested = true` in `manifest.json`; running worker bash tools watch that bit and abort.

Worker reads the cancellation envelope, halts work, then:

- `revert: true` — `git checkout -- <hint files>` for tracked files; `rm` for untracked files the worker created. Status → idle. Log to `decisions`.
- `revert: false` — leave changes; status → `completed` with note "lead requested keep, no revert". Log to `decisions`.
- `revert: "review"` — `askUser` ("Lead requested cancel; should I keep, revert, or partial?"). Follow user's instruction. Log to `decisions`.

## §10 — Live plan-edit reaction (lead only)

When manifest etag bumps and the diff affects `tasks[*]` / `phases[*]` / `validationStrategy`:

1. Re-read manifest.
2. Compare against persisted `manifest.leadState.lastSnapshotEtag`.
3. Iterate `manifest.history.slice(after: lastSnapshotEtag)` to know what changed.
4. For each in-flight assignee, respond per §9 (continue / cancel-revert / cancel-keep based on whether their task is still in the plan).
5. For newly added tasks lacking an assignee, spawn or hold per dependency.
6. After reconciling, patch `manifest.leadState = { lastSnapshotEtag: currentEtag, lastSnapshotSeenAt: now }`.

## §11 — Spawn brief

`spawnAgent`'s `initialMessage` is free-form, **but** must contain these headings (server validates):

```
## TASK
<one-paragraph statement of what to build / fix / verify>

## FILES
<list of file paths the worker should touch / read first>

## DEPENDENCIES
<other task ids that must be done first; "none" if none>

## GATES
<which validationStrategy.steps[] apply to this task — inline the prompts or reference by id>

## PEERS
<every other in-flight agent: role, tag, current task, status>

## SUCCESS
<concrete completion criteria; what evidence to attach>
```

The brief must also say: read `manifest.json`, `plan.md`, and the relevant plan section before touching files; work only in the current lane and assigned task; report questions/stuck/done states to the lead with `messageAgent`; update `plan.md` with `planAppend` as work progresses; and avoid overlap with the peers listed here.

`## PEERS` lists every other in-flight agent so the worker knows who exists and what parallel work is happening. `## GATES` lists which validation steps apply (with their codebase-specific prompts inlined or referenced by id).

## §12 — Forbidden actions

- Forking canonical state into chat-only prose — read the manifest.
- Spawning agents not registered in the manifest — always use `spawnAgent`.
- Using `bash` to edit `<bundlePath>/{manifest.json, plan.md}` — sandbox enforces this server-side too.
- Validators spawning agents — they report up to the lead instead.
- Workers patching their own `validationGate` — server rejects.
- Patching `validationStrategy.checklist` items directly for validation state. Workers and validators must use `recordValidationRun`; direct checklist patches are reserved for lead-level reconciliation only.
- Lowering `validationGate.required` without `humanOverride` + `UserOverrideEntry` in the same patch transaction — server rejects.
- Re-prompting a default the user already waived in this scope.
