# Close the v1 gaps in the ADE Work-tab Chat Orchestrator

You're picking up work on the ADE orchestrator. The full product spec lives at
`/Users/arul/ADE/.ade/worktrees/orchestrator-2e3a194b/goal.md` (1069 lines).
The audit summary that opens these gaps is the prior conversation; what you
need to know is below.

## Context: what already exists

Working directory: `/Users/arul/ADE/.ade/worktrees/orchestrator-2e3a194b/apps/desktop`.

The orchestrator is a Work-tab-native multi-agent coordinator. One chat is the
**lead** (planner/dispatcher); it spawns ordinary ADE chats as **workers** and
**validators** in the same lane. Coordination is through a lane-local bundle:
`<laneWorktree>/.ade/orchestration/<runId>/{manifest.json, plan.md, artifacts/}`.

What landed in the previous pass:

- **Service** (`src/main/services/orchestration/orchestrationService.ts`):
  bundle CRUD, etag concurrency, per-runId AsyncMutex, atomic writes,
  chokidar watcher with self-write suppression, RFC-6902 subset patch with
  id-predicate paths, history ring buffer.
- **Patch policy** (`src/main/services/orchestration/patchPolicy.ts`): per-role
  allow/deny patterns; coordinated-transaction enforcement (status=done +
  required gate requires `humanOverride` + `UserOverrideEntry`).
- **Types** (`src/shared/types/orchestration.ts`): full manifest schema, ping
  primitives, model routing, validation concerns, context items.
- **IPC** (`src/shared/ipc.ts`, `src/main/services/ipc/registerIpc.ts`,
  `src/preload/preload.ts`): 13 handlers + `window.ade.orchestration.*` bridge,
  event broadcast on `ade.orchestration.event`.
- **Session plumbing** (`src/main/services/chat/agentChatService.ts`):
  `createSession` accepts orchestration fields, `persistChatState` writes
  them, the deserializer hydrates them, `setOrchestrationFields` exposes a
  stitch-back path for `orchestrationRunCreate`. Public `readTranscript`
  wrapper exists.
- **System prompt directive** (`src/main/services/ai/tools/systemPrompt.ts`):
  `buildOrchestratorRoleDirective` exported and injected from
  `buildCodingAgentSystemPrompt` when orchestration args are set. Threaded
  through Codex + Droid call sites in `agentChatService.ts`.
- **SKILL.md**: `/Users/arul/ADE/.agents/skills/ade-orchestrator/SKILL.md`
  is the canonical protocol for all three roles.
- **Tool factory** (`src/main/services/ai/tools/orchestrationTools.ts`):
  `createOrchestrationToolSet` returns role-appropriate tools (lead gets
  read-only base + orchestration-only tools; worker/validator gets full
  edit+bash with `buildOrchestrationSandboxConfig` applied — protected files
  for `<bundlePath>/{manifest.json,plan.md}`, `blockByDefault: true`).
- **Bash hardening** in `src/main/services/ai/tools/universalTools.ts`:
  `MUTATING_BASH_RE` extended with `ln` (hardlink), `INTERPRETER_RE` for
  `python|node|ruby|perl -c|-e`, `commandUsesInterpreterPayload` exported.
- **UI**: `OrchestrationPanel.tsx`, `PlanMarkdown.tsx`, `OrchestratorLeadFrame.tsx`
  (conic-gradient ring), `AnnotationPopover.tsx`, `SpecPreviewCard.tsx`,
  `ChatModelSelectionPendingCard.tsx`, sidebar role badges in `SessionCard.tsx`,
  composer "+ New orchestrator chat" entry + `orchestrationRole` lock prop.

Current test state: 420 tests across 15 files, typecheck clean from `apps/desktop`.

## Gaps to close, in priority order

### Gap 1 (HIGHEST PRIORITY) — Wire orchestration tools into the chat runtime

**Why this matters.** The factory at `src/main/services/ai/tools/orchestrationTools.ts`
defines the tools (`spawnAgent`, `messageAgent`, `manifestPatch`, `claimTask`,
`releaseTask`, `planAppend`, `planWrite`, `registerAsset`, `getAgentTranscript`,
`askUserForModelSelection`) but no provider runtime actually hands these tools
to the model. Until that happens the lead chat can't autonomously spawn
workers via tool calls — the entire agentic loop only works if a human in the
UI clicks buttons. This is the single biggest blocker between "demo-able
orchestrator" and "production orchestrator".

**What to do.** Each provider has a different tool-wiring path. Investigate and
integrate per provider:

- **Claude Agent SDK** — the prompt + tools come from a `query()` setup in
  `agentChatService.ts`. Look for where Claude's `tools` array is built (grep
  for `tools:` near the Claude runtime section). When
  `session.interactionMode` starts with `orchestrator-`, merge the result of
  `createOrchestrationToolSet({...})` into the tool list. Claude tool schemas
  use a `name`/`description`/`input_schema` shape — `executableTool` in
  `src/main/services/ai/tools/executableTool.ts` is the existing wrapper that
  bridges Vercel-AI-style tools into the Claude SDK shape; trace how
  universalTools tools are surfaced today and follow that pattern.
- **Codex App-Server** — Codex uses MCP-style tool exposure. Find where
  custom tools are registered (search `codexAppServer`, `mcp`, `customTools`)
  and add the orchestration toolset behind the same interactionMode gate.
- **Cursor / Droid / OpenCode** — each has its own SDK adapter
  (`cursorSdkPool.ts`, `droidSdkWorker.ts`, OpenCode HTTP). Check whether
  each runtime supports caller-supplied tools (some may not — the spec
  acknowledges this in §8.2). For runtimes that can't accept custom tools,
  document the limitation and rely on the IPC bridge — the renderer can
  expose action buttons that call the same service methods.

The `OrchestrationToolSetOptions` interface tells you what you need to pass.
`sessionContext.bundlePath` comes from `session.orchestrationBundlePath`;
`runId` from `session.orchestrationRunId`; `role` from `session.orchestrationRole`;
`leadSessionId` from `session.orchestrationParentSessionId`. The
`orchestrationService` handle is on the `AppContext` in `registerIpc.ts`.

Add a smoke test: spawn a lead chat (mocked), verify the tool list includes
`spawnAgent` and `messageAgent` but NOT `editFile`/`writeFile`/`bash`. Spawn a
worker — verify the list includes both sets.

Lives mostly in `src/main/services/chat/agentChatService.ts`; the tool factory
itself doesn't need changes.

### Gap 2 — Cancellation watcher (§16.2)

**Why this matters.** Lead's `messageAgent({ kind: "interrupt-replace",
intent: "cancellation", cancellation: { revert: true } })` flips
`agents[X].cancellationRequested = true` via `manifestPatch`. The worker is
supposed to notice this and immediately SIGTERM in-flight bash steps so a
long test/build/clone gets interrupted promptly. Without the watcher,
cancellation is cooperative-on-next-turn — wasted compute and frustrating
UX when the user says "stop".

**What to do.** I started a stub at one point (`cancellationWatcher.ts`)
but deleted it because nothing was calling it. The correct integration:

1. **Subscribe at the right layer.** The orchestration tool factory
   (`orchestrationTools.ts` `createOrchestrationToolSet`) is the natural
   home — when it builds the worker/validator toolset, also start a
   per-session subscription to `orchestrationService.on("event", ...)`.
   The session context (`bundlePath`, `sessionId`) is already available.

2. **Watch for the flag flip.** When a `manifest` event arrives with a
   patch that touches `/agents/{sessionId:SELF}/cancellationRequested`
   set to `true`, fire SIGTERM into the in-flight bash child process tree.

3. **Find the bash child handle.** `universalTools.ts` builds bash
   commands using `spawn`. Look for `eventAbortController` in
   `agentChatService.ts` around line 8091 (the pattern the spec calls
   out) — that's the existing cancellation signal. The bash factory in
   `universalTools.ts` uses `AbortController` per command run; expose a
   way to abort the *active* one externally.

4. **After SIGTERM**, let the worker's normal loop pick up the cancellation
   envelope on its next turn (it reads the manifest and follows
   SKILL.md §9: revert/keep/review).

Tests:
- Spawn a worker via mocked service. Set `cancellationRequested` via patch.
  Assert that a registered abort callback gets invoked synchronously after
  the next event tick.
- Bonus: spawn a real `sleep 30` subprocess, fire the flag, assert the
  child exits within ~100ms.

### Gap 3 — Sanitise PlanMarkdown raw HTML

**Why this matters.** `src/renderer/components/orchestration/PlanMarkdown.tsx`
uses `rehype-raw` (line ~31 + line ~496) which lets `<script>` tags in
plan.md execute in the renderer. Workers write to plan.md via the
`planAppend` IPC — the body is a string the model produces. A misbehaving
worker or a prompt-injection from a web fetch quoted into a plan section
could land script tags in plan.md and execute them locally.

**What to do.**

1. Install `rehype-sanitize`:
   cd apps/desktop && pnpm add rehype-sanitize

2. Import the default schema (`defaultSchema` from `rehype-sanitize`) and
extend it for our needs — we WANT `<a>`, `<sub>`, `<details>`, and the
`data-section-id` attribute on headings (used by anchor scrolling).
Block `<script>`, `<iframe>` (the spec preview card mounts its OWN
sandboxed iframe through React, separately), event handlers (`onClick`,
`onError`, etc.), and `javascript:` URLs.

3. In `PlanMarkdown.tsx`, change:
```ts
rehypePlugins={[rehypeRaw, rehypeSectionAnchors]}
   to:
rehypePlugins={[rehypeRaw, [rehypeSanitize, planSanitizeSchema], rehypeSectionAnchors]}
   The order matters: rehypeRaw parses raw HTML into the hast tree,
   then rehypeSanitize strips dangerous nodes, then our slug visitor
   runs on the cleaned tree.

4. Add a test in PlanMarkdown.test.tsx:
  - <script>alert(1)</script> in source → not rendered.
  - <a href="javascript:alert(1)">x</a> → href stripped or sanitised.
  - <sub>2026-05-22</sub> (used in plan.md timestamps) → preserved.
  - <a id="section-foo"> heading anchors → preserved.

Gap 4 — Persistent run-discovery index

Why this matters. orchestrationService.runList() only returns runs
in the in-memory Map. After an app restart, a lane could have ten
on-disk bundles but runList({laneId}) returns nothing until each is
lazy-loaded via bundleRead. The lead chat's orchestrationRunId lets
the panel mount on its own chat, but there's no "show all runs in this
lane" UI surface and no recovery path if the chat record vanishes.

What to do.

1. On runCreate, append an entry to a tiny index file at
<laneWorktree>/.ade/orchestration/index.json:
{
  "version": 1,
  "runs": [
    { "runId": "R-...", "createdAt": "...", "title": "...", "bundlePath": "..." }
  ]
}
1. Use the same atomic-write pattern (tmp + fsync + rename) as
persistManifest. Index writes happen inside the service's
per-runId mutex, so two concurrent runCreates for the same lane
serialize — but two concurrent runCreates for DIFFERENT lanes share
no mutex. Solution: an additional per-lane mutex around the index
read-modify-write.
2. runList(laneId) should:
  - Resolve the lane worktree (the resolver is in the service deps).
  - Read index.json from that lane.
  - For each entry not yet loaded in the in-memory runs Map, do a
lazy bundleRead to hydrate.
  - Return the summary list.
3. On runCreate/runDelete (when we add it), update the index.
4. Resilience: if the index file is corrupt or missing, fall back to
scanning .ade/orchestration/*/manifest.json (existing behavior).
Tests should cover index-missing, index-corrupt, and index-stale
(manifest deleted but index entry remains) paths.

Add a test that creates 3 runs, restarts the service (new instance),
calls runList({laneId}), and verifies all 3 come back with correct
metadata.

Gap 5 — hidePermissionRail is no-op, will become important when permission rows ship

Why this matters. The prop is plumbed from ChatModelSelectionPendingCard
through ModelPicker.tsx → ModelPickerContent.tsx but currently the
ModelPicker doesn't render permission rows at all. When someone adds them,
the prop must actually skip rendering.

What to do. Likely nothing today. But add a guard test in
ModelPicker.test.tsx:
it("respects hidePermissionRail when forwarded", () => {
  // mount ModelPicker with hidePermissionRail={true}
  // assert that no element with `data-testid="model-picker-permission-row"`
  // (or whatever the future selector is) renders
});
That way when permission rows get added, this test forces them to
honour the flag.

Gap 6 — Add a renderer integration test that boots the preload

Why this matters. The audit caught a class of bug where my IPC
wiring was reverted by an intermediate edit and unit tests didn't
notice. OrchestrationPanel.test.tsx uses an injected source prop
to bypass window.ade.orchestration.subscribe/bundleRead. Fast and
focused, but it doesn't exercise the preload → main process round-trip.

What to do. Add OrchestrationPanel.integration.test.tsx that:

1. Creates a mock ipcRenderer (track invocations, manually fire
ipcRenderer.send-equivalent for events).
2. Stubs window.ade.orchestration by loading the same shape the
real preload exports — call the real runCreate/bundleRead
functions against the mock ipcRenderer.
3. Renders OrchestrationPanel WITHOUT the source prop.
4. Asserts that:
  - ipcRenderer.invoke was called with IPC.orchestrationBundleRead
on mount.
  - ipcRenderer.on(IPC.orchestrationEvent, ...) was registered.
  - Firing a mock event with the right shape causes the panel to
re-render.

The point is not exhaustive integration coverage — it's a canary
that fires when the preload bridge breaks. Spec §18's "manual smoke"
is the deeper integration test.

How these fit together

The orchestrator is built in layers:

SKILL.md (protocol the model follows, role-tailored)
   ↓
System prompt directive (tells model which role + bundle path)
   ↓
Tool factory (gives model the verbs: spawnAgent, manifestPatch, etc.)   ← Gap 1
   ↓
Orchestration service (persists state, broadcasts events)
   ↓                  ↓
Cancellation hook    Run index           ← Gap 2, Gap 4
   ↓
IPC bridge → preload → renderer
   ↓
OrchestrationPanel + PlanMarkdown   ← Gap 3 (sanitize)
   ↓
Integration test                     ← Gap 6

Gap 1 unlocks autonomous orchestration. Gap 2 makes cancellation feel
fast. Gap 3 closes a real but bounded XSS surface. Gap 4 unlocks v2
features (forking, multi-run UI). Gap 5 is forward-compat hygiene.
Gap 6 prevents the same class of revert-bug the audit caught.

How to work

- Always run npx tsc --noEmit from apps/desktop after each change.
- Run the orchestration tests after each change:
npx vitest run src/main/services/orchestration/ src/renderer/components/orchestration/ src/main/services/ai/tools/orchestrationTools.test.ts src/main/services/ai/tools/bashHardening.test.ts
- Don't use git worktrees (user policy). Work in the current tree.
- When you finish each gap, mark it done; if blocked, surface the
blocker rather than guessing.
- Recommended order: Gap 1 → Gap 2 → Gap 3 → Gap 6 → Gap 4 → Gap 5.
Gaps 1 and 2 are interdependent (the cancellation watcher hooks
into the same tool factory you'll wire). Gap 3 and 6 are isolated.
- After all gaps land, re-run /audit against the diff.