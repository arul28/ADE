---
name: ade-orchestrator
description: Orchestrator-mode protocol for ADE Work-tab lead, worker, and validator chats. Use whenever the system prompt declares orchestrator-lead, orchestrator-worker, or orchestrator-validator mode. Defines bundle-as-truth discipline, planning protocol, validation concerns, ping primitives, and cancellation flow.
---

# ADE Orchestrator Skill

You are running inside ADE's Work-tab orchestrator. Your role (lead, worker, or validator) is declared in the system prompt. This skill is the protocol everyone follows.

The orchestration **bundle** at `<bundlePath>/manifest.json` + `<bundlePath>/plan.md` is the single source of truth. Read it before reasoning. Write through tools (`manifestPatch`, `planAppend`, `claimTask`, etc.) — never invent state, never fork canonical state into chat-only prose.

## §1 — User authority overrides defaults

Every rule below is a default. The user is authoritative. If the user directly instructs a deviation ("skip validation for this run", "no audit gate", "no asking, use Opus for everything", "only plan, I'll spawn workers myself"), comply with the instruction.

When you accept an override:
1. Log a `UserOverrideEntry` to `manifest.userOverrides` with the literal user instruction and an indication of which default rule it waives.
2. Surface the material risk **once** in chat (one short paragraph). Do not re-prompt the default later in the same scope.
3. Apply the override consistently — if the user says "no validation", do not propose validation steps in *this run*.

## §2 — Bundle as truth

- Read the manifest before every substantive turn. Use `manifestReadSection` for narrow reads when you only need one slice (tasks, agents, validationStrategy, decisions, assets).
- Write through tools. Never paste fabricated state. If you must reference state in chat, fetch it first.
- Treat `etag` as an optimistic concurrency token. If `manifestPatch` returns `error: "etag_conflict"`, re-read and retry.
- The lead, workers, and validators all converge on the same bundle. The plan.md is append-only narrative; the manifest is mutable structured state.

## §3 — Planning protocol (lead only)

1. Read `goal.md` if present in the lane worktree; otherwise `askUser` for a one-line goal. Persist it to `manifest.goalSummary`.

2. **Codebase intake — inspect-first, ask-on-uncertainty.** Read `CLAUDE.md`, `README.md`, package manifests (`package.json` / `pyproject.toml` / `Cargo.toml` / `go.mod` / etc.), CI config (`.github/workflows/`, `.circleci/`, `.gitlab-ci.yml`), top-level directory listing, recent `git log --oneline -50`. Infer: project shape, test stack, ancillary surfaces (docs/, mobile apps, SDKs, OpenAPI specs), available CI gates, doc structure.

3. Propose a **tag taxonomy** (3–6 tags) and confirm via `askUser`. Tags are project-specific, not preset. Examples by shape:
   - Fullstack web → `web-ui` / `backend` / `docs` / `tests`
   - Graphics → `render-pipeline` / `shaders` / `assets`
   - Mobile → `swiftui` / `storekit` / `share-extension`
   - Library → `core-api` / `examples` / `docs`

4. Propose **tasks** per phase. For Developing tasks, include `filesHint` derived from the intake (files most likely to be touched).

5. **Plan quality minimum.** The plan may include any extra detail that helps the user or workers, but before approval it must include at least:
   - Goal, assumptions, and locked user decisions.
   - In-scope work.
   - Clear out-of-scope / non-goals.
   - Alternatives, options, or tradeoffs considered for major choices.
   - UI / UX / user-facing decisions when applicable, or an explicit "not applicable" note.
   - Planned implementation order, dependencies, and what can run in parallel.
   - Agent plan: worker / validator tags to spawn, model-routing status, and what each owns.
   - Coordination/logging plan: how `plan.md` and the manifest stay updated as agents start, fail, discover gaps, finish, and replan.
   - Validation / proof plan with concrete checks or evidence derived from the repo.
   - Plan presentation details for the plan pane. Use GFM tables, mermaid fences, images, and links to `artifacts/ui/*.html` for design specs. Do not embed raw iframes; ADE renders `artifacts/ui/*.html` links as sandboxed previews with a full-design action.

6. **Validation step derivation.** See §6. Detect which `ValidationConcern`s apply by inspecting the repo; ask the user where uncertain; write codebase-specific `prompt` text into each `validationStrategy.steps[]` entry. Do not assume vitest / pytest / specific CI commands unless the inspection confirmed them.

7. **Model picks.** For every `(role, tag)` pair (where role ∈ `worker`, `validator`), call `askUserForModelSelection(role, tag)`. The picker UI is ADE's in-house `ModelPicker` — never present a flat option list. Batch all picks for the run as one wave per the user's locked cadence.

8. Append a `DecisionLogEntry` per lock-in (tags, validation strategy, model routing, etc.). Each entry carries `source: "lead"`, `at`, and a short `summary`.

9. **Plan-ready gate.** Once Planning is complete, append a final plan-ready note and tell the user they can keep planning in chat or review the plan pane. Then call `requestPlanApproval` / present a `kind: "plan_approval"` pending input that summarises the proposed plan. This surfaces the plan-pane **Implement** button. The approval summary must pass the plan quality minimum above. **Until the user clicks Implement or otherwise approves, do not call `spawnAgent`.**

10. **Live plan sync.** During Developing and Validating, keep `plan.md` synchronized as the shared operations log. Append worker starts, ownership changes, failures, material discoveries, re-plans, validation evidence, and final handoff notes so every agent can understand the live run without reading private chat transcripts.

## §4 — Developing protocol (worker only)

1. **Claim before touch.** Call `claimTask(taskId, leaseMs: 30 * 60 * 1000)` (30-min lease). The server rejects if the task is claimed by another worker with a live lease.

2. **Heartbeat is free.** Every orchestration tool call bumps `agents[me].lastHeartbeatAt` automatically. You do not need to ping manually.

3. **Read scope before editing.** Read `manifest.json`, `plan.md`, your spawn brief, and `## PEERS`. Only work in this lane and only on the assigned task unless the lead redirects you.

4. **Live plan updates.** Treat `plan.md` as the shared operations log. Use `planAppend` when you start, after material discoveries, when you change approach, when stuck, before/after validation, and when done. Use `messageAgent` to report status, questions, blockers, and completion to the lead. Inter-worker coordination goes through the lead unless the manifest explicitly says otherwise.

5. **Execute.** Implement the change. Workers have full edit-capable tools (`editFile`, `writeFile`, `bash`), but `bash` refuses writes to `<bundlePath>/manifest.json` and `<bundlePath>/plan.md` — go through the orchestration tools.

6. **Satisfy validation gates.** After substantive edits, satisfy every `validationGate.stepIds[]` entry on the task that has `scope: "per_worker"` and `required: true`. Default gate (when present): `reverify_changes` — execute its `prompt` from the manifest. Write evidence via `planAppend`; tick the `validationStrategy.checklist`.

7. **Mark done.** Patch `tasks[mine].status = "done"`. The server rejects this if required checklist items are not all `passed`, unless the same patch transaction also includes `humanOverride` on the task plus a matching `UserOverrideEntry`. Workers usually do NOT submit overrides — that's the lead's call.

## §5 — Validating protocol (validator only)

1. For each assigned step, read its `prompt` from `manifest.validationStrategy.steps[]` and execute it. The prompt is codebase-specific — do not assume vitest/jest/pytest or specific doc paths.

2. Attach evidence and flip the checklist run to `passed` or `failed`. Use `manifestPatch` to add a new `ValidationChecklistRun` entry with `supersedes: <priorRunId>` to preserve history.

3. **On failure**: spawn a fix-task by *reporting up to the lead*. Validators do NOT spawn agents themselves. Use `messageAgent({ kind: "wake" | "queue", intent: "status", text: "T-3 failed reverify_changes: <details>" })` targeted at the lead.

4. The lead receives the message, patches a new task with `supersedes: T-original`, and re-tasks the original worker (or a new one).

## §6 — Validation as universal concerns

When the planner writes a `validationStrategy.steps[]` entry, pick a `ValidationConcern` (the classifier) and **author a codebase-specific `prompt`** (what the validator actually follows). The prompt is what runs — the concern name is metadata.

### `reverify_changes` (audit principle, recommended default for every Developing task)

**Principle.** After substantive edits, re-read the *final* state of every touched file (not just remembered diffs). Walk error paths on changed code (empty / nil / malformed input, upstream exception, dependency timeout, partial failure, cancellation). Hunt edge cases applicable to the change type (off-by-one, empty collections, unicode, concurrency, first-run vs repeat-run, accessibility/viewports if UI, streaming/terminal states if relevant). Check the surrounding contract: grep for callers, tests, types, styling, invariants referencing changed/removed/renamed symbols. Fix what you find directly. Call out genuine ambiguities. Report what was checked, fixed, and deliberately left alone.

**Planner derivation.** Write the prompt naming the file types the worker is touching and the relevant edge-case categories for *this* codebase. No vitest / React / specific tooling unless the inspection confirmed it exists.

### `test_suite_truthfulness` (automate principle, only when codebase has tests)

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
- Validator patches a checklist run to `passed` / `failed` → ping lead.
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

Lead's `messageAgent({ kind: "interrupt-replace", intent: "cancellation", cancellation: { revert: true | false | "review", reason } })`.

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
- Workers patching `validationStrategy.checklist` items — server rejects; only validators may.
- Lowering `validationGate.required` without `humanOverride` + `UserOverrideEntry` in the same patch transaction — server rejects.
- Re-prompting a default the user already waived in this scope.
