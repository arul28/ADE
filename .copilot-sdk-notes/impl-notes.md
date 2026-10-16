# Copilot SDK implementation notes

## Decisions

- The pool key hashes the complete worker environment. `buildAgentRuntimeEnv`
  includes `ADE_CHAT_SESSION_ID`, so each Copilot chat owns a separate worker
  with the correct chat-scoped environment. Releasing the runtime decrements
  its reference count and disposes the worker at zero; SDK shutdown gets four
  seconds before ADE force-terminates the worker tree. Startup orphan recovery
  covers both Copilot and Cursor worker names through the shared owner-PID sweep.

- Copilot is now a first-class SDK-backed chat runtime using the exact
  `@github/copilot-sdk` version `1.0.22`; the existing provider id remains
  `copilot`.
- The shared per-provider permission property is **`copilotPermissionMode`**.
  Its values are `plan`, `ask`, `auto-edit`, and `full-auto`; missing or invalid
  persisted values resolve to `ask`. Create, update, persistence, chat summary,
  permissions, and cross-machine handoff carry that field. The generic
  `permissionMode` remains independent.
- Copilot active-turn steering supports `inline` and `queue`. Both use SDK
  `session.send()` with `immediate` / `enqueue` and return on acceptance. ADE
  settles the turn from `session.idle`; `data.aborted` marks it interrupted.
  Interrupt-and-resend is not used; Stop calls SDK `abort()`.
- The SDK worker uses the installed `copilot` CLI over stdio. The desktop and
  CLI builds emit one worker entry, and the desktop package resources copy the
  CLI worker beside its other ADE CLI workers. Platform SDK runtime packages
  are excluded from the packaged desktop app.
- Interactive chat sessions enable SDK config discovery to match Copilot CLI
  behavior, including workspace `.mcp.json`. Background utility sessions turn
  config discovery off, explicitly enumerate and disable every server in the
  user-level Copilot MCP config, expose no tools, skip custom instructions,
  disable infinite sessions, and delete the temporary session afterward. If
  user-config enumeration fails, utility session creation fails closed.
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
- Settings status reads `getAuthStatus()` from the SDK and displays the signed-in
  Copilot login when the SDK reports one. SDK auth is queried even when the
  `copilot` command resolves from PATH, and its result adds/updates the Copilot
  detected-auth row. Quota and premium-request accounting are not yet surfaced.
- The SDK utility reply is an `AssistantMessageEvent` whose text is under
  `data.content`. `runCopilotTask` reads that field before compatibility
  fallbacks; the live title call showed why reading top-level `content` alone
  returned no usable name.
- The chat MCP auth callback first skips ADE lookup when the launch config
  already carries an Authorization header. Otherwise it resolves the owning
  brain's account-vault token by registry server URL, refreshes due tokens via
  the shared MCP OAuth renewal path, and returns the SDK token result. Missing
  sign-in produces one Settings → MCP servers notice per chat/server and then
  cancels. Browser sign-in remains desktop-only.
- The event mapper covers streaming without replaying final messages that had
  deltas, tool progress/results and file edits, SQL todos, subagent lifecycle,
  usage/context, compaction, warnings, and served-model selection/mismatch.
  Quota and premium-request accounting remain unavailable.
- The isolated dev app rendered ADE sign-in and its runtime opened the primary
  project database despite an explicit throwaway project root. I stopped that
  app immediately and sent no Copilot chat action through it. Subsequent live
  checks used the CLI-only runtime with the isolated `ADE_HOME`; `lsof` showed
  it opened no primary project database.
- Dependency installation used `npm install --ignore-scripts` in
  `apps/desktop` to avoid the `koffi` native build failure. A no-save install
  restored the lockfile-pinned Rollup macOS ARM package needed to run Vitest.

## Live validation a–h

The live runtime command was:

```sh
ADE_HOME="$PWD/.copilot-sdk-notes/dev-home" ADE_DEV_ALLOW_ALT_HOME=1 \
ADE_DEV_RUNTIME_SYNC=0 ADE_PROJECT_ROOT="$PWD/.copilot-sdk-notes/live-project" \
npm run dev:runtime -- --project-root "$PWD/.copilot-sdk-notes/live-project" \
  --socket /tmp/ade-runtime-copilot-review5.sock --no-sync --skip-runtime-build
```

It listened on `/tmp/ade-runtime-copilot-review5.sock`. The only project-backed
database handle it opened was the isolated personal-chat database under
`.copilot-sdk-notes/dev-home`; the primary project DB was held only by the
installed ADE brain. Personal chat transcript and cache files are under the
isolated ADE home. All chat calls below used `--personal`.

- **a — PASS.** Created Copilot Auto chat `2527d2eb-1a7c-473f-925c-7475c1752564`
  with “Reply with exactly: ok.” Event history had one assistant `text` event
  (`ok`), then `status: completed` and `done: completed` for the same turn.
- **b — PASS.** The shell request produced one ADE pending input titled
  “Copilot shell permission” for `echo permission-denial-check`, with Allow
  once / Allow for this session / Deny choices. Denial completed with the
  assistant saying the command was denied and no output was produced. A second
  request was answered with `decision: accept` and
  `answers.copilot-permission=approve-once`; its tool result contained
  `approved-and-over-60` and exit code 0.
- **c — PASS.** A streamed number response had multiple text chunks under one
  message ID. Interrupt produced `system_notice: Copilot turn was interrupted`,
  `status: interrupted`, and `done: interrupted`; the chat summary then showed
  `status: idle` and `runtimeAlive: true` before the runtime restart.
- **d — PASS.** Created Copilot Auto personal chat
  `4705f1e5-41ea-4464-9296-853d9ed56c8d` and got `before-restart`. Stopped the
  isolated CLI-only runtime and started it again with the same isolated ADE
  home. The same ADE chat accepted `Reply with exactly: after-restart` and
  returned `after-restart`; its transcript contains both turns in order.
- **e — FAIL (partial SDK evidence).** Read-only inspection found an existing
  persisted Copilot chat with an ACP-era `acpSessionId` in the primary cache.
  `CopilotClient.resumeSession` through ADE's built SDK worker returned the
  same session ID and 10 history events. The session was disconnected without
  sending a message or changing its ADE record. This did not exercise the
  ADE-managed persisted-session path, so it does not fully pass the requested
  check. A fresh empty `copilot --acp` session could not resume after its ACP
  process exited (`Session not found`); that empty-session probe was not
  treated as the validation because it had no persisted Copilot turn.
- **f — PASS.** The approved `sleep 70; echo approved-and-over-60` shell tool
  started at `21:39:15` and returned at `21:40:26` (71 seconds). Its assistant
  turn ended `completed`, with the shell output visible in the tool result.
- **g — PASS.** A live `runProviderTask` Copilot session-title call returned
  `Review the effect of urban tree planting on summer heat.` A marker MCP
  server configured in the throwaway workspace `.mcp.json` did not create its
  marker file. The call used the installed Copilot account and the production
  utility path (`availableTools: []`, config discovery disabled).
- **h — FAIL for the requested UI check; data PASS.** `chat models --provider
  copilot --json` returned the single default `github-copilot/auto` Auto row.
  `ai.getStatus` returned Copilot auth `{authenticated:true, verified:true,
  login:"arul28"}`. I could not inspect the model picker or Settings renderer:
  the isolated desktop displayed ADE sign-in, and starting it opened the primary
  DB, so I stopped it before acting in the UI.

The a–h receipts came from these live ADE entry points and observed results:

| Check | ADE command/API exercised | Observed receipt |
| --- | --- | --- |
| a | `chat.create` / `chat.read` (`--personal`, Copilot Auto) | Session `2527d2eb-1a7c-473f-925c-7475c1752564`: one assistant `ok` event, then completed status and done. |
| b | `personalChats.pendingInputs` and answer action | Deny card named `Copilot shell permission`; denial produced no output. Accept-once produced `approved-and-over-60`, exit 0. |
| c | `chat.interrupt` then chat read/summary | Interrupted notice and done status; summary returned idle with `runtimeAlive: true`. |
| d | `chat.create`, `chat.send`, `chat.read` before and after runtime stop/start | Session `4705f1e5-41ea-4464-9296-853d9ed56c8d` transcript contains `before-restart` then `after-restart` across restart. |
| e | Built SDK worker `CopilotClient.resumeSession` using the persisted ACP-era id | Same SDK session id and 10 history events; no ADE-managed resume/send, so this remains a partial FAIL. |
| f | ADE chat permission answer plus approved shell request | `sleep 70; echo approved-and-over-60` took 71 seconds and completed with the expected shell output. |
| g | Production `runProviderTask` session-title path with marker workspace | Returned `Review the effect of urban tree planting on summer heat.`; marker file stayed absent. |
| h | `chat.models --provider copilot` and `ai.getStatus` | One Auto row and authenticated login `arul28`; visual Settings/model-picker check was not reached. |

The runtime was stopped after the checks with
`node scripts/dev-runtime-stop.mjs --socket /tmp/ade-runtime-copilot-review5.sock`.

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
- Passed: live title-task extraction and Copilot SDK auth status after the
  final source changes; title text was returned and the signed-in login appeared
  in `ai.getStatus`.
- Passed: focused retained ACP/provider suites: 8 files, 228 tests.
- Passed: direct built-worker auth/model request against the installed Copilot
  CLI, with output limited to auth-present and model-count booleans/count. Auth
  was available and the account returned one model row. This opened no session
  and used no premium request.
- Not validated: the app's visible model picker and Settings page, and an
  ADE-managed persisted-session resume using the legacy `acpSessionId` field.
  The SDK worker's resume of an existing legacy ACP id and its history was
  verified directly.

## Review 2 follow-up

- **1 — PASS.** `copilotSdkWorker` reads server-level `client.rpc.mcp.config.list()`
  before utility session creation, rejects an unreadable server list, passes all
  configured names as `disabledMcpServers`, and keeps the auth callback
  cancelled. A rebuilt ADE CLI worker ran with an isolated user-level
  `.copilot-sdk-notes/user-mcp-home/mcp-config.json` containing marker server
  `review-user-marker`: `session.rpc.mcp.list()` reported it disabled, the
  utility produced “Urban Tree Planting: Cooling Cities in Summer”, and the
  marker script did not start. Receipt:
  `{"configuredUserMcpNames":["review-user-marker"],"markerServerDisabled":true,"title":"Urban Tree Planting: Cooling Cities in Summer","markerStarted":false}`.
- **2 — PASS.** An isolated resolver run matched the enabled registry entry by
  URL, refreshed a near-expiry synthetic vault token, persisted the rotated
  refresh token, and returned a positive lifetime:
  `{"tokenResolved":true,"expiresInPositive":true,"refreshCalls":1,"writeCalls":1,"refreshTokenRotated":true,"rawTokenPrinted":false}`.
  The callback is wired in the chat-owning brain and returns `{kind:"token",...}`
  before notice/cancel when a token resolves; absent tokens keep the one-time
  notice and cancellation. Launch configs with a nonempty Authorization header
  are filtered before ADE token resolution. Limitation: no live external MCP
  OAuth challenge was run; callback behavior is evidenced by the service path
  and live resolver, not a registry server requiring OAuth.
- **3 — PASS.** Seeded a real ACP session through ADE's `createAcpConnection`
  and `initializeAcpConnection` host transport in the isolated
  `legacy-copilot-home-ade-host`, temporary cwd `.copilot-sdk-notes/legacy-acp-work`.
  The Copilot ACP session id was `82ad1440-d22c-41f0-8fde-73af4c4ef683`; its
  persisted event history contained the seed prompt and assistant response
  `ade-host-legacy-ok`. Created isolated personal ADE chat
  `452c22d9-7c35-48cc-9389-f3d9ec4fb65b` with only `acpSessionId` set to that
  value, then sent `Reply with exactly: ade-managed-resume-ok` through ADE.
  ADE returned that answer, converted the pointer to
  `copilotSdkSessionId: 82ad1440-d22c-41f0-8fde-73af4c4ef683`, and the same
  Copilot `events.jsonl` now contains both the seed and ADE-managed follow-up
  turns. The fix admits Copilot in the persisted-state provider guard.
- **4 — PASS (UI skipped as directed).** Data validation remains the prior
  single Auto model row and authenticated account `arul28`; the visual model
  picker and Settings check were skipped for the coordinator.
- **5 — PASS.** Pool key hashes the complete `buildAgentRuntimeEnv`; that
  includes `ADE_CHAT_SESSION_ID`, so a worker is scoped to one chat. Each
  worker is ref-counted and disposed at zero. `apps/ade-cli/package.json` does
  not need `@github/copilot-sdk`: `apps/ade-cli/tsup.config.ts` marks it
  `noExternal`, and the built `apps/ade-cli/dist/copilotSdkWorker.cjs` bundles
  the SDK. `npm --prefix apps/ade-cli run build` passed and emitted the
  733,122-byte worker; the CLI build verifier passed.

The isolated CLI-only runtime for the managed resume was stopped with
`node scripts/dev-runtime-stop.mjs --socket /tmp/ade-runtime-copilot-review2b.sock`;
the socket was absent afterward.

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
- Utility sessions must not discover or start configured user, workspace, or
  plugin MCP servers, expose tools, or leave sessions behind.
- SDK model discovery must hide disabled entries, preserve supported model
  metadata, provide Auto when empty, and keep the six-hour persistent cache
  fresh.
- SDK stream mapping must retain turn/item identity, avoid duplicate final text,
  preserve tool output/file edits/todos/subagent events, usage/context, served
  model and error classification across worker events and resume.
