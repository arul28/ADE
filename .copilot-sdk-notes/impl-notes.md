# Copilot SDK implementation notes

## Decisions

- Copilot is now a first-class SDK-backed chat runtime using the exact
  `@github/copilot-sdk` version `1.0.22`; the existing provider id remains
  `copilot`.
- The shared per-provider permission property is **`copilotPermissionMode`**.
  Its values are `plan`, `ask`, `auto-edit`, and `full-auto`; missing or invalid
  persisted values resolve to `ask`. Create, update, persistence, chat summary,
  permissions, and cross-machine handoff carry that field. The generic
  `permissionMode` remains independent.
- Copilot active-turn steering supports `inline` and `queue`. Inline maps to
  SDK `sendAndWait({ mode: "immediate" })`, queue maps to
  `sendAndWait({ mode: "enqueue" })`; interrupt-and-resend is not supported.
  The existing stop path uses SDK `abort()`.
- The SDK worker uses the installed `copilot` CLI over stdio. The desktop and
  CLI builds emit one worker entry, and the desktop package resources copy the
  CLI worker beside its other ADE CLI workers. Platform SDK runtime packages
  are excluded from the packaged desktop app.
- Background Copilot tasks use the shared worker and a temporary utility
  session. The worker enumerates configured MCP names before creating it,
  disables those servers, makes no tools available, skips custom instructions,
  disables infinite sessions, and deletes the utility session afterward. If it
  cannot enumerate MCP servers, it fails closed.
- Copilot no longer appears in ACP provider unions, metadata, model probes,
  diagnostics/update lists, or its ACP dialect and ACP-only fixtures. Copilot's
  terminal CLI and external-session import remain.
- The user coordination note's `copilotPermissionMode` name and semantics were
  adopted. `apps/desktop/resources/ade-cli-help.txt` already listed Copilot as
  a valid provider; the harness skill only described its CLI sign-in behavior,
  so neither needed a content change.

## Deviations and incomplete behavior

- Model discovery uses `client.listModels()`, keeps the last good list in the
  ADE cache directory, serves it without waiting on the read path, and refreshes
  it after six hours.
- The SDK's `getAuthStatus()` is available in the worker and was verified, but
  settings status still uses the existing CLI credential-presence heuristic;
  account identity and quota are not yet surfaced from SDK auth/quota APIs.
- The MCP auth callback de-duplicates requests and posts a Settings → MCP
  servers notice, then cancels the request. It does not yet resolve a stored
  registry token or offer a direct sign-in action in the chat.
- The event mapper covers streamed/final assistant text and reasoning, tool
  start/completion, usage tokens, context occupancy, compaction, and runtime
  errors. It does not yet map SDK tool progress/partial output, todos, or
  subagent lifecycle events; served-model mismatch notices and premium-request
  quota/cost accounting are also incomplete.
- Full live ADE chat validation could not run. App Control's isolated dev launch
  reported the worktree-local ADE home and sync off, but Electron startup failed
  because `ensure-electron` did not produce `node_modules/electron/path.txt`;
  CDP never became ready. The session was stopped and its unique runtime socket
  was confirmed closed. No Copilot prompt was sent.
- Dependency installation used `npm install --ignore-scripts` in
  `apps/desktop` to avoid the `koffi` native build failure. A no-save install
  restored the lockfile-pinned Rollup macOS ARM package needed to run Vitest.

## Files changed

- Shared chat types and permission ladder; main chat runtime, persistence,
  projections, handoff, worker protocol/pool/events/model discovery; AI provider
  status, auth detection, Copilot SDK loader and one-shot task runner.
- ACP provider metadata, probes, dialect registration and ACP-only Copilot
  fixtures/tests; provider settings and harness availability; build, worker
  packaging and desktop package manifest/lockfile.
- `apps/desktop/resources/ade-cli-help.txt` and
  `apps/desktop/resources/agent-skills/ade-harnesses/SKILL.md` were reviewed and
  required no edits.

## Validation

- Passed: `npm run typecheck` in `apps/desktop`.
- Passed: `npm run build` in `apps/desktop`; CLI worker bundle was emitted and
  CLI build verification passed. The build reports existing `import.meta` CJS
  warnings; one Copilot pointer-switch duplicate-case warning found in the first
  build was fixed.
- Passed: focused retained ACP/provider suites: 8 files, 228 tests.
- Passed: direct built-worker auth/model request against the installed Copilot
  CLI, with output limited to auth-present and model-count booleans/count. Auth
  was available and the account returned one model row. This opened no session
  and used no premium request.
- Not validated: a user-visible Copilot answer, streaming in ADE, permission
  approval/denial UI, interrupt, restart/resume, legacy ACP session migration,
  title-generation MCP isolation, and model picker interaction.

## Existing test failures and cleanup

- In the broad existing run, 283 tests passed and six failed. Five failures in
  `agentChatServiceAcpRuntime.test.ts` assert the retired Copilot ACP launch,
  cancellation, permission-reconfigure, served-model, and slash-command
  behavior. They were left unchanged per the brief.
- The `providerTaskRunner.test.ts` Copilot metadata case still expects the old
  ACP process-spawn contract; the SDK worker exits because that unit test does
  not provide an installed Copilot runtime. It was left unchanged per the brief.
- Copilot-only model-discovery test contents and the empty `turn boundaries`
  suite were removed along with the retired ACP coverage so Vitest does not
  report empty suites.

## Failure modes for /test

- Missing/invalid `copilotPermissionMode` must read as `ask`; every valid ladder
  value must survive create, update, summary, persistence reload, and handoff.
- The permission callback must honor plan/ask/auto-edit/full-auto, keep
  auto-edit within the lane worktree, and still surface managed-approval
  requests. An approved or denied tool request must settle its pending input.
- Inline steering must enter the live SDK turn once via `immediate`; queued
  steering must follow the SDK queue once via `enqueue`; neither may interrupt
  and resend. Abort must resolve the turn as interrupted without losing chat
  history.
- Resume must use the persisted SDK session id, including an ACP-era id, and
  worker crash/reopen must retain the conversation.
- Utility sessions must not start configured user MCP servers, expose tools, or
  leave sessions behind; inability to enumerate MCP servers must prevent task
  execution.
- SDK model discovery must hide disabled entries, preserve supported model
  metadata, provide Auto when empty, and keep the six-hour persistent cache
  fresh.
- SDK stream mapping must retain turn/item identity, usage/context, served model,
  tool results and error classification across worker events and resume.
