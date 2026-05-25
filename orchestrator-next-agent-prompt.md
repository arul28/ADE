# Next-agent prompt: fix ADE Work-tab orchestration UX

You are taking over ADE Work-tab Chat Orchestrator work in:

`/Users/arul/ADE/.ade/worktrees/orchestrator-2e3a194b`

Branch:

`ade/orchestrator-2e3a194b`

Primary spec:

`/Users/arul/ADE/.ade/worktrees/orchestrator-2e3a194b/goal.md`

Read `goal.md` first. The important sections for this pass are the locked decisions, UI components, live-editable plan, model routing, validation concerns, user authority, hardening, testing strategy, and final audit gate.

Do not commit or open a PR unless the user explicitly asks.

## User intent

The user wants ADE orchestration to feel like a real office, not a bot status dashboard.

The desired mental model:

1. The lead behaves like a lead.
2. Workers behave like coworkers.
3. Messages between lead and workers are clear, first-person, and materially useful.
4. The live plan is the working room where decisions, previews, validation, and status are visible.
5. HTML design/spec previews should be embedded directly in the plan where they matter.
6. Full HTML previews should be reachable through ADE's built-in browser from inline plan links/buttons.
7. Users should not have to hunt through a separate artifact drawer to understand the run.

The current implementation got the mechanics mostly working, but the UX shape is wrong.

## Recent smoke evidence and cleanup

A disposable smoke project called ProductOps Studio was used to stress the orchestrator. It was only a test target, not a real ADE product.

The temporary smoke projects were removed after the run:

- `/private/tmp/ade-orchestrator-complex-smoke`
- `/private/tmp/ade-orchestrator-smoke-webapp`

The Electron dev app was also stopped after cleanup.

The smoke proved that the orchestrator can:

- Create and run a Work-tab orchestrator lead.
- Ask planning questions before implementation.
- Request and receive plan approval.
- Spawn multiple scoped workers.
- Let workers read the plan and patch the shared run bundle.
- Relay at least one real state-contract change from worker to lead and dependent workers.
- Run a final validator.
- Register HTML artifacts.
- Render HTML artifact iframe previews in the current Artifacts tab.
- Open a registered HTML artifact in ADE's built-in browser after the local file URL fix.

The smoke also proved the current UX is not yet the product the user wants.

## Main problems to fix

### 1. Wrap-up stays active forever

Observed state:

- Planning: done.
- Developing: done.
- Validating: done.
- Wrap-up: active, no tasks.

This is confusing. It makes a completed run look unfinished.

Fix direction:

- Add a real terminal run state or explicit "complete run" transition.
- If wrap-up has no tasks and the lead has written final evidence, the run should clearly read complete.
- Consider `currentPhase: "wrapup"` plus `runStatus: "completed"` or mark wrap-up done when final lead handoff is recorded.
- Update UI labels so completion is obvious.
- Add tests for completed runs and empty wrap-up.

### 2. The Artifacts tab/drawer is the wrong primary UX

The current UI has `Plan`, `Status`, `Validation`, and `Artifacts` tabs. HTML iframes only show in `Artifacts`.

The user does not want to hunt in an artifact drawer. The plan should contain embedded previews directly.

Fix direction:

- Keep the asset registry internally if useful, but stop making the separate Artifacts tab the primary way to inspect deliverables.
- Render registered HTML spec assets inline inside the live plan itself.
- Each embedded preview should include:
  - title/path/version metadata,
  - a sandboxed iframe preview,
  - an "Open in ADE browser" action that opens the full bundled HTML artifact in the existing ADE browser pane.
- If there are multiple versions of the same path, either collapse to the latest in the plan or make version history clear without duplicate confusing cards.
- The current v1/v2 same-path artifact behavior is misleading because both cards can render the same current bundle file. Either snapshot versions into distinct bundle paths or collapse same-path assets to latest unless version history is explicitly requested.
- Update `OrchestrationPanel.tsx`, `PlanMarkdown.tsx`, and relevant tests.

### 3. The plan itself has no iframe snippets

The user expected embedded snippets of HTML specs in the live plan, not a separate tab.

Fix direction:

- Add a plan-rendering convention. Options:
  - Auto-inject preview blocks near asset references in `plan.md`.
  - Support explicit markdown directives like `<!-- ade:asset-preview path="artifacts/ui/foo.html" -->`.
  - Support links to known registered asset paths and upgrade them into preview cards.
- The best implementation is probably directive-based plus fallback auto-detection for registered HTML assets.
- The lead and workers should be instructed to add those directives when registering design/spec HTML.
- The renderer should resolve directives against `manifest.assets`.
- Add tests proving an HTML asset referenced from the plan renders an iframe in the Plan view and opens in ADE browser.

### 4. Worker and lead messages feel automated

Current messages include robotic lines like:

- `worker html-spec finished...`
- `Evidence is in Orchestration details.`
- generic completion pings.

The user wants office-like first-person communication.

Desired examples:

- Worker to lead: "I updated the risk model. I added `targetDate`, `forecastDate`, and `readiness` to milestones, and I need persistence/tests to use the same fields."
- Lead to worker: "Thanks. Keep the fields inside the existing collections and do not add a new top-level timeline array. I am notifying persistence and analytics now."
- Validator to lead: "I found one issue: the artifact opens from the bundle but the plan preview still points at the stale path. I marked validation failed and added the repro."

Fix direction:

- Update `apps/desktop/resources/agent-skills/ade-orchestrator/SKILL.md` and the main/source skill copy so workers and leads are told to speak in first person.
- Update lead/worker system prompt text in `systemPrompt.ts`.
- Audit `messageAgent`, worker-finished notifications, and any synthetic chat insertion path.
- Distinguish human-readable coordination messages from internal machine events.
- Synthetic lifecycle events can exist in the manifest/status panel, but chat messages should be material and human-readable.
- Preserve provenance chips (`from lead`, `from worker/tag`) but make the message text itself clear.
- Add tests around generated worker brief/direction text if feasible.

### 5. Provenance is visible but not clear enough

The UI has role badges and some `from <agent>` chips, but the conversation can still feel ambiguous.

Fix direction:

- Message headers should clearly show sender role, tag, and target when message metadata has orchestration origin.
- Lead and worker messages should mention the recipient naturally when useful.
- Worker tabs/session titles should make it obvious whether the selected chat is the lead or a worker.
- When the user is looking at the run details panel from a worker chat, the panel should make the selected worker context obvious and provide a clear jump back to the lead.

### 6. Validation and asset status labels are stale

Observed during the ProductOps smoke:

- UI phase card showed Validating done.
- Manifest checklist rows still had row-level `status: pending` while their latest run was `passed`.
- Asset cards showed `PENDING` even though the previews opened and rendered.

Fix direction:

- Make checklist row status roll up from latest run or update it when recording validation runs.
- Make asset status meaningful. If there is no asset lifecycle, do not show `PENDING`.
- Add tests for validation status rollup and asset labels.

### 7. The UI shape drifted from `goal.md`

`goal.md` says the right panel should be a unified view, not a multi-tab dock. The current implementation has tabs.

Do not blindly delete all tabs if the better UI still needs drilldowns, but align with the product intent:

- The plan should be the primary always-visible source of truth.
- Status, validation, and asset previews should feel integrated into the live plan, not separate rooms.
- Phase cards can be useful, but they should not obscure the plan.
- HTML previews should live inline with the relevant plan section.

### 8. Browser pane state is confusing

During the smoke, the ADE browser pane was sometimes left on Google while artifact previews were elsewhere. After a fix, artifact Open successfully opened `file://.../productops-spec.html`, but defaulting to Google made the proof look unrelated.

Fix direction:

- When opening an artifact from the plan, ensure the browser pane visibly switches to the artifact tab.
- Consider closing/hiding the browser pane by default unless the user opens an artifact.
- Ensure `file://` allowance stays narrow: local `.html` and `.htm` files only.

### 9. Dirty/clean labels can be stale

Observed mismatch:

- Stage & Commit showed six changed files.
- Some clean/dirty labels elsewhere lagged or looked stale.

Fix direction:

- Audit Work header/Files/Git pane dirty status subscriptions and lane snapshot refresh.
- Make one source of truth for the selected lane status in the Work tab.

## Code paths already touched in this branch

Important files:

- `apps/desktop/src/shared/types/orchestration.ts`
- `apps/desktop/src/main/services/orchestration/orchestrationService.ts`
- `apps/desktop/src/main/services/orchestration/patchPolicy.ts`
- `apps/desktop/src/main/services/ai/tools/orchestrationTools.ts`
- `apps/desktop/src/main/services/ai/tools/systemPrompt.ts`
- `apps/desktop/src/main/services/chat/agentChatService.ts`
- `apps/desktop/src/main/services/builtInBrowser/builtInBrowserService.ts`
- `apps/desktop/src/main/services/ipc/registerIpc.ts`
- `apps/desktop/src/preload/orchestrationBridge.ts`
- `apps/desktop/src/preload/global.d.ts`
- `apps/desktop/src/renderer/components/orchestration/OrchestrationPanel.tsx`
- `apps/desktop/src/renderer/components/orchestration/PlanMarkdown.tsx`
- `apps/desktop/src/renderer/components/chat/AgentChatPane.tsx`
- `apps/desktop/src/renderer/components/chat/AgentChatMessageList.tsx`
- `apps/desktop/src/renderer/components/terminals/SessionCard.tsx`
- `apps/desktop/src/renderer/components/terminals/WorkViewArea.tsx`
- `apps/desktop/resources/agent-skills/ade-orchestrator/SKILL.md`

Useful fixes already made and worth preserving:

- Transcript-backed Codex plan approval can recover after runtime restart.
- Orchestration decision summary no longer crashes on loose entries.
- Registered artifact bundle copies refresh when the lane-root file is newer/different.
- HTML artifact Open resolves to the run bundle `file://` URL.
- ADE built-in browser narrowly allows local `.html/.htm` file URLs for artifact previews.
- Focused tests passed for browser service, orchestration tools, orchestration panel, and chat service.

Do not regress those.

## Validation commands

Use Node 22.13.1:

```bash
cd /Users/arul/ADE/.ade/worktrees/orchestrator-2e3a194b/apps/desktop
PATH=$HOME/.asdf/installs/nodejs/22.13.1/bin:$PATH npm run typecheck
PATH=$HOME/.asdf/installs/nodejs/22.13.1/bin:$PATH npx vitest run \
  src/main/services/builtInBrowser/builtInBrowserService.test.ts \
  src/main/services/ai/tools/orchestrationTools.test.ts \
  src/renderer/components/orchestration/OrchestrationPanel.test.tsx \
  src/renderer/components/orchestration/PlanMarkdown.test.tsx \
  src/main/services/chat/agentChatService.test.ts \
  --reporter verbose
```

For any substantial UI change, run the real Electron app and verify with Codex Computer Use:

```bash
cd /Users/arul/ADE/.ade/worktrees/orchestrator-2e3a194b/apps/desktop
PATH=$HOME/.asdf/installs/nodejs/22.13.1/bin:$PATH ADE_PROJECT_ROOT=/tmp/<fresh-orchestrator-smoke-project> ADE_DISABLE_RUNTIME_SERVICE_INSTALL=1 npm run dev
```

Use the Electron app with `localhost:5173`, not Safari and not the installed ADE app.

## What the next smoke should prove

After fixes, create a fresh throwaway project and run a new complex orchestration smoke.

The smoke must prove:

1. The plan asks real planning questions.
2. The user approves an in-depth plan.
3. The lead spawns only useful workers.
4. Workers and lead talk in clear first-person coordination messages.
5. A worker registers an HTML design/spec artifact.
6. The live plan itself embeds an iframe preview of that artifact.
7. The inline preview has an Open button/link that opens the full HTML in ADE browser.
8. Validation completes and the run is clearly complete, not stuck in active wrap-up.
9. Status, validation, and asset labels do not lie or remain pending after success.

If a bug is found during the smoke, fix it and rerun with a new throwaway lane.
