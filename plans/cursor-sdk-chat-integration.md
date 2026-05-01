# Cursor SDK chat integration plan

Status: implemented; retained as historical integration notes
Date: 2026-04-29

Current implementation note: Cursor chat in ADE is SDK-only. The old Cursor-specific alternate transport, `ADE_CURSOR_CHAT_TRANSPORT`, and its pool/config/event mapper have been removed. Cursor auth is API-key based via `CURSOR_API_KEY` or ADE's encrypted API key store with provider id `cursor`.

## Security note for the implementing agent

The user supplied a Cursor API key in the originating chat for exploratory testing. Do not write that raw key into source files, docs, logs, fixtures, snapshots, commits, or persisted ADE state. Use `CURSOR_API_KEY` from the active process environment, an ADE encrypted secret, or a one-off shell environment while testing. If the key is not available to your implementation session, ask the user to set `CURSOR_API_KEY` or place it in ADE's encrypted provider credential store.

Do not add plaintext Cursor credentials to this plan or any repository file. Assume the user will rotate the exploratory key.

## Goal

Replace ADE's Cursor chat runtime path with the Cursor TypeScript SDK for this spike, while keeping ADE's permission/control surface. The desired near-term outcome is:

- Cursor local chats in ADE run through `@cursor/sdk`.
- The SDK path is the only Cursor path.
- ADE still owns approvals, plan/read-only behavior, full-auto behavior, transcript/work-log mapping, cancellation, and process cleanup.
- The UI feels native next to Claude and Codex controls.
- The implementation is tested incrementally with a real Cursor API key via `CURSOR_API_KEY`.

This is not just a transport swap. Cursor SDK has a richer runtime model than the old path, but it does not currently expose the same direct permission callback shape ADE needs. The integration should use an ADE-managed SDK worker process plus Cursor hooks as the permission bridge.

## Why do this

The previous Cursor chat path left ADE coupled to a CLI protocol surface instead of Cursor's first-party agent API. The SDK gives ADE access to:

- Cursor's same local/cloud agent harness used by desktop, CLI, and web.
- Durable agent and run objects.
- `run.stream()`, `run.wait()`, `run.cancel()`, `run.conversation()`.
- Cloud agents, repo selection, branch metadata, run listing, lifecycle controls, artifacts.
- Model catalog via `Cursor.models.list()`.
- Connected repo catalog via `Cursor.repositories.list()`.
- Inline MCP server config.
- Custom subagents.
- Structured tool/thinking/status/task events and finer `onDelta` interaction updates.

The strategic reason is cloud. The old path cannot launch or manage Cursor Cloud agents from ADE. SDK can.

## Sources

Primary Cursor sources:

- Cursor SDK docs: https://cursor.com/docs/sdk/typescript
- Cursor SDK announcement: https://cursor.com/blog/typescript-sdk
- Cursor SDK / Cloud Agents API changelog: https://cursor.com/changelog/sdk-release
- Cursor forum announcement: https://forum.cursor.com/t/cursor-sdk-cloud-agents-api-updates/159284

Local ADE source anchors:

- Cursor SDK pool: `apps/desktop/src/main/services/chat/cursorSdkPool.ts`
- Shared Droid host callbacks: `apps/desktop/src/main/services/chat/acpHostClient.ts`
- Main chat runtime: `apps/desktop/src/main/services/chat/agentChatService.ts`
- Current Cursor modes: `apps/desktop/src/shared/cursorModes.ts`
- Chat types: `apps/desktop/src/shared/types/chat.ts`
- Composer UI controls: `apps/desktop/src/renderer/components/chat/AgentChatComposer.tsx`
- Chat pane state/control wiring: `apps/desktop/src/renderer/components/chat/AgentChatPane.tsx`
- Current Cursor tests: `apps/desktop/src/main/services/chat/agentChatService.test.ts`

## Exploratory findings

Package and auth:

- Installed `@cursor/sdk@1.0.9` in a throwaway probe directory.
- The SDK authenticated with `CURSOR_API_KEY`.
- `Cursor.me()` worked.
- `Cursor.models.list()` returned 27 models.
- `Cursor.repositories.list()` returned 43 connected repos, including `https://github.com/arul28/ADE`.

Local SDK:

- Local text streaming worked with `Agent.create()` + `agent.send()` + `run.stream()`.
- Event types observed: `status`, `assistant`, `thinking`, `tool_call`.
- `onDelta` update types observed: `text-delta`, `thinking-delta`, `thinking-completed`, `token-delta`, `partial-tool-call`, `tool-call-started`, `tool-call-completed`, `step-completed`, `turn-ended`.
- File edits and shell commands worked.
- Custom subagents worked. A configured subagent appeared as a `task` tool call with custom subagent metadata.
- `run.cancel()` worked locally and stopped a long shell command before it wrote its output file.
- `Agent.list`, `Agent.listRuns`, and `Agent.messages.list` work when the SDK platform/workspace is keyed consistently.

Important local caveats:

- `local.sandboxOptions.enabled: true` failed in the probe with: `Local SDK sandboxing was requested, but sandboxing is not supported in this environment.`
- Do not rely on Cursor-native SDK sandboxing for the first ADE integration.
- If the Node process `cwd` was not the lane root, a bare `pwd` shell call ran from the Node process cwd even when `local.cwd` was set. When the SDK worker process itself was launched with `cwd = laneRoot`, shell cwd behaved correctly.
- Therefore, run Cursor SDK in a per-lane worker process whose process cwd is the lane root.

Permissions and requests:

- Public SDK stream types include `SDKRequestMessage` with `request_id`.
- No documented/exported API was found to approve, deny, or answer such requests.
- No local or cloud probe emitted a `request` event.
- Do not design ADE approvals around SDK `request` events yet.

Cursor hooks:

- Cursor hooks fired under SDK local runs.
- A user-level hook in an isolated `HOME` worked; repo mutation was not required.
- `permission: "ask"` did not pause the SDK run in the probe. The tool ran anyway.
- A hard deny from `preToolUse` did block the shell command before execution.
- Hook input included tool name, tool input, session id, workspace roots, and hook event name.
- Conclusion: hooks can enforce allow/deny policy, but the hook command must synchronously call ADE and return `allow` or `deny`. Do not depend on Cursor's built-in ask prompt.

Cloud SDK:

- Cloud agent creation required a repo URL unless the Cursor account has a default repo configured.
- A cloud probe against `https://github.com/arul28/ADE` worked.
- Observed lifecycle statuses: `CREATING`, then `RUNNING`.
- Final result included `result`, `durationMs`, and git metadata with repo branch info.
- `Agent.list`, `Agent.listRuns`, `Agent.getRun`, and `Agent.archive` worked.
- `agent.listArtifacts()` returned an empty list for the no-op probe, but the API is present.
- Cloud agents should default to no auto PR until ADE explicitly exposes and tests the PR behavior.

## Historical ADE behavior replaced by SDK policy

The previous Cursor chat path launched:

```text
legacy cursor launch command removed
```

Previous Cursor launch mapping:

| ADE state | Legacy launch |
| --- | --- |
| Agent/default | `--sandbox enabled` |
| Ask | `--mode ask --sandbox enabled` |
| Plan | `--mode plan --sandbox enabled` |
| Legacy full-auto | `--sandbox disabled --force` |

The SDK does not have equivalent mode flags. Preserve the user-facing modes, but make them ADE policy that is enforced through the worker and hooks.

## Proposed architecture

Use the Cursor SDK runtime as the only Cursor runtime.

High-level flow:

```text
AgentChatService
  -> CursorSdkPool / CursorSdkRuntime
    -> child worker process, cwd = lane root
      -> @cursor/sdk Agent
      -> isolated ADE-managed HOME
      -> user-level Cursor hooks
        -> hook bridge command
          -> worker JSON-RPC / socket
            -> AgentChatService pending input
```

### Why a child worker

Run the SDK in a child process instead of importing it directly into Electron main because:

- Process cwd must be the lane root for tool execution to behave correctly.
- We need an isolated `HOME` so Cursor does not inherit the user's desktop settings such as "Run Everything Unsandboxed".
- We need deterministic cleanup of Cursor runtime state, hook files, and child processes.
- The SDK and native optional packages are easier to isolate from Electron main bundling issues.

### Worker responsibilities

The worker should:

- Import `@cursor/sdk`.
- Create/resume an SDK agent for the lane/session.
- Stream SDK messages and interaction updates to main over a small JSON-RPC protocol.
- Relay `run.wait()`, `run.cancel()`, `run.conversation()`, `Agent.list*`, and cloud lifecycle calls when needed.
- Own a local Unix socket or named pipe for hook commands.
- Create an ADE-managed Cursor home directory under `.ade/cache` or machine-local ADE cache.
- Write `~/.cursor/cli-config.json` and `~/.cursor/hooks.json` inside that isolated home.
- Clean up or mark stale worker state on shutdown.

Possible paths:

- `apps/desktop/src/main/services/chat/cursorSdkPool.ts`
- `apps/desktop/src/main/services/chat/cursorSdkWorker.ts`
- `apps/desktop/src/main/services/chat/cursorSdkProtocol.ts`
- `apps/desktop/src/main/services/chat/cursorSdkEventMapper.ts`
- `apps/desktop/src/main/services/chat/cursorSdkHookBridge.ts`

Exact filenames can follow nearby ADE conventions.

### Hook bridge design

Use user-level hooks in the worker's isolated Cursor home:

```json
{
  "version": 1,
  "hooks": {
    "preToolUse": [
      {
        "command": "hooks/ade-tool-gate.js --socket <worker-socket>",
        "failClosed": true
      }
    ]
  }
}
```

The hook command:

- Reads hook JSON from stdin.
- Sends it to the SDK worker over the worker socket.
- Worker relays it to `AgentChatService`.
- `AgentChatService` emits ADE pending input if needed.
- Hook blocks until ADE returns allow/deny.
- Hook writes one of:

```json
{ "permission": "allow" }
```

or:

```json
{
  "permission": "deny",
  "user_message": "ADE denied this tool call.",
  "agent_message": "The host denied this tool call."
}
```

Use fail-closed for default/plan/read-only modes. For full-auto, either do not install blocking hooks or install hooks that only enforce hard safety guards and otherwise return allow.

## Permission model

Separate Cursor chat mode from ADE permission preset.

```ts
type CursorChatMode = "agent" | "ask" | "plan";
type CursorPermissionPreset = "default" | "read-only" | "full-auto";
```

Recommended user-facing presets:

| UI preset | Cursor mode | ADE permission behavior |
| --- | --- | --- |
| Ask | `ask` | Read-only. Deny writes/shell side effects. |
| Plan | `plan` | Read-only plus plan-oriented prompt. Deny writes/shell until user explicitly leaves/approves. |
| Agent | `agent` | Ask before risky tools. Allow safe reads/search. |
| Full auto | `agent` | Ask for nothing. Auto-allow inside lane. |

Recommended internal policy:

```ts
type CursorSdkPermissionPolicy = {
  chatMode: "agent" | "ask" | "plan";
  approvalPolicy: "on-request" | "read-only" | "never";
  sandbox: "ade" | "cursor-native" | "off";
  force: boolean;
  hardGuards: boolean;
};
```

Mapping:

| Preset | Policy |
| --- | --- |
| Ask | `{ chatMode: "ask", approvalPolicy: "read-only", sandbox: "ade", force: false, hardGuards: true }` |
| Plan | `{ chatMode: "plan", approvalPolicy: "read-only", sandbox: "ade", force: false, hardGuards: true }` |
| Agent | `{ chatMode: "agent", approvalPolicy: "on-request", sandbox: "ade", force: false, hardGuards: true }` |
| Full auto | `{ chatMode: "agent", approvalPolicy: "never", sandbox: "off", force: true, hardGuards: false or protected-path-only }` |

Full auto should match Codex full-auto / Claude bypass semantics: no ADE approval prompts. Decide whether ADE still blocks obvious protected paths such as `.ade/secrets` and outside-lane writes. If kept, label it as a hard safety guard rather than an approval.

## Cursor config written inside isolated HOME

For normal controlled modes:

```json
{
  "version": 1,
  "approvalMode": "allowlist",
  "permissions": {
    "allow": [],
    "deny": []
  },
  "sandbox": {
    "mode": "disabled",
    "networkAccess": "user_config_with_defaults"
  }
}
```

Set Cursor native sandbox disabled for the initial integration because SDK sandboxing failed in the probe. ADE hooks provide the control plane.

For full-auto:

```json
{
  "version": 1,
  "approvalMode": "unrestricted",
  "permissions": {
    "allow": ["Shell(**)", "Read(**)", "Write(**)", "Mcp(**)"],
    "deny": []
  },
  "sandbox": {
    "mode": "disabled",
    "networkAccess": "allow_all"
  }
}
```

Only use this inside an ADE-managed isolated `HOME`, never by editing the user's real `~/.cursor/cli-config.json`.

## Mode prompting

Because SDK local does not expose `--mode ask|plan`, add a small system/developer directive to the first user prompt or agent creation wrapper.

Agent mode:

- Normal coding agent behavior.
- Follow ADE approval outcomes from hook denial/allow messages.

Ask mode:

- Answer from inspection only.
- Do not modify files.
- Do not run shell commands except explicitly allowed read-only inspection if ADE policy allows it. The safest first implementation denies shell entirely in Ask mode.

Plan mode:

- Produce a concrete plan before changing files.
- Do not modify files or run side-effecting shell commands.
- Let user switch to Agent/default or Full auto to execute.

Do not rely on prompt text alone for policy. Hooks must enforce.

## Event mapping

Map SDK messages to ADE chat/work-log events:

SDK `status`:

- `CREATING`, `RUNNING`, `FINISHED`, `ERROR`, `CANCELLED`, `EXPIRED`
- For cloud, surface `CREATING` clearly as provisioning/starting.

SDK `assistant`:

- Append text deltas to assistant bubble.
- SDK may emit several small assistant messages; coalesce like existing Claude/Codex streaming.

SDK `thinking`:

- Map to reasoning/thinking UI if current Cursor UI supports it, otherwise keep compact and respect user display settings.

SDK `tool_call`:

- Map `name`, `status`, `args`, `result`, `truncated`.
- Do not assume tool payload stability. Cursor docs warn tool args/results are not stable. Parse defensively.
- Use known cases for `shell`, `edit`, `task`; preserve unknown tools as generic tool calls.

SDK `task`:

- Map to task/subagent milestones where possible.

SDK `request`:

- Display defensively if it appears, but do not use it as the approval mechanism until Cursor exposes a response API.

`onDelta`:

- Use for smoother text/tool streaming when helpful.
- Observed useful updates: `text-delta`, `thinking-delta`, `tool-call-started`, `partial-tool-call`, `tool-call-completed`, `step-completed`, `turn-ended`, `user-message-appended`, `summary`.

## SDK APIs to integrate

Local:

- `Agent.create({ apiKey, model, local: { cwd }, platform: { workspaceRef } })`
- `agent.send(message, { local: { force }, onDelta, onStep })`
- `Agent.resume(agentId, options)`
- `run.stream()`
- `run.wait()`
- `run.cancel()`
- `run.conversation()`
- `Agent.list({ runtime: "local", cwd })`
- `Agent.listRuns(agentId, { runtime: "local", cwd })`
- `Agent.messages.list(agentId, { runtime: "local", cwd })`

Catalog:

- `Cursor.models.list({ apiKey })`
- `Cursor.repositories.list({ apiKey })`
- `Cursor.me({ apiKey })`

Cloud:

- `Agent.create({ apiKey, model, cloud: { repos, env, autoCreatePR, workOnCurrentBranch, skipReviewerRequest } })`
- `Agent.getRun(runId, { runtime: "cloud", agentId, apiKey })`
- `Agent.list({ runtime: "cloud", includeArchived, apiKey })`
- `Agent.listRuns(agentId, { runtime: "cloud", apiKey })`
- `Agent.archive(agentId, { apiKey })`
- `Agent.unarchive(agentId, { apiKey })`
- `Agent.delete(agentId, { apiKey })`
- `agent.listArtifacts()`
- `agent.downloadArtifact(path)`

## Cloud integration scope

Implement local SDK first. Then add cloud as a distinct runtime mode once local chat parity is stable.

Cloud UI should expose:

- Runtime: Local or Cursor Cloud.
- Repo selector from `Cursor.repositories.list()`.
- Starting ref / branch.
- `workOnCurrentBranch`.
- `autoCreatePR` default false.
- `skipReviewerRequest` default true for probes.
- Cloud agent/run links or IDs.
- Archive/delete controls for cleanup.
- Artifact/proof import when `listArtifacts()` returns items.

Cloud permissions caveat:

- Treat cloud as isolated VM execution, not ADE-local per-tool approval.
- Do not claim ADE can approve every cloud tool call unless Cursor adds a usable request-response API or hook callbacks to ADE are proven for cloud.
- Default cloud runs should not auto-create PRs.

## Legacy Cursor transport removal

Cursor SDK is the only active Cursor chat/runtime path.

In code:

- `agentChatService` routes Cursor sessions through `cursorSdkPool`.
- `cursorSdkWorker` owns the SDK agent, local/cloud runs, model/repo catalog requests, and the hook bridge.
- Persisted Cursor runtime state uses SDK agent/run ids, not legacy session ids.
- Shared ACP host/client code remains for Factory Droid only.

## UI requirements

Match existing Claude/Codex surfaces instead of creating a one-off Cursor panel.

Composer:

- Keep Cursor mode picker: Agent, Ask, Plan.
- Add a Cursor permission preset or a Cursor full-auto option.
- User-facing presets should be clear and concrete:
  - Ask
  - Plan
  - Agent
  - Full auto
- Full auto should visually align with Codex full-auto and Claude bypass.
- Tooltips should explain:
  - Agent: asks before risky tools.
  - Ask: no file changes or shell side effects.
  - Plan: drafts a plan before implementation.
  - Full auto: runs without approval prompts.

Session summary:

- Show Cursor SDK transport status while the spike is active, at least in debug/status details.
- Show local vs cloud runtime if cloud is enabled.
- Show current model from SDK catalog.

Pending input:

- Use existing ADE pending input UI for Cursor hook approval requests.
- Source should be `cursor`.
- Kind should likely be `permissions`.
- Include tool name, command/path, cwd, and risk summary.

Work log:

- Shell commands should look like existing command work-log blocks.
- Edits should look like file-change work-log blocks where possible.
- Subagent/task tool calls should look like task/subagent blocks if an existing pattern exists.

Design:

- Keep controls compact and operational, like Codex/Claude controls.
- Avoid explanatory in-app text walls.
- Reuse existing segmented controls, menus, and tooltips.

## Testing instructions for the implementing agent

Test continuously with `CURSOR_API_KEY` in the environment. Do not print the key. Do not commit it.

Manual SDK smoke tests to reproduce before wiring ADE:

1. `Cursor.me()` succeeds.
2. `Cursor.models.list()` returns models.
3. `Cursor.repositories.list()` returns repos.
4. Local text-only run streams and finishes.
5. Local run edits a temp file and runs a shell command.
6. Local run with worker cwd set to temp workspace runs `pwd` in that workspace.
7. Hook allow returns allow and tool runs.
8. Hook deny blocks shell execution.
9. Hook bridge asks ADE pending input and honors allow/deny.
10. `run.cancel()` stops a long command and prevents side effects.
11. `Agent.list` / `Agent.listRuns` find local persisted runs when `workspaceRef` is stable.
12. Full-auto mode runs without ADE approval prompts.
13. Ask/Plan deny writes and shell side effects.
14. Subagent config works and maps a `task` tool call.
15. Cloud run works against a selected repo with `autoCreatePR: false`, then archives cleanly.

Automated tests to add:

- Unit tests for Cursor mode/preset to SDK policy mapping.
- Unit tests for Cursor hook JSON classification.
- Unit tests for hook allow/deny output.
- Unit tests for SDK message/event mapper.
- Unit tests that Cursor sessions use SDK-only runtime paths.
- Main-service tests for Cursor SDK behavior with SDK mocks.
- Renderer tests for Cursor full-auto/preset UI.
- Cancellation test with mocked SDK run.
- Dirty-state/process cleanup test for worker shutdown.

Validation commands:

```bash
npm --prefix apps/desktop run typecheck
npm --prefix apps/desktop run test -- agentChatService
npm --prefix apps/desktop run test -- AgentChatComposer
npm --prefix apps/desktop run lint
```

Run narrower targeted tests first while iterating. Finish with the broader checks that cover touched surfaces.

## Implementation phases

### Phase 1: Dependency and SDK runtime

- Add `@cursor/sdk` to `apps/desktop/package.json`.
- Add SDK pool/worker/protocol plumbing.
- Remove the legacy Cursor runtime path.
- Add typed API-key auth and tests.

Acceptance:

- Cursor sessions use SDK only.
- `ADE_CURSOR_CHAT_TRANSPORT=acp` is not supported.

### Phase 2: Worker process and basic streaming

- Create SDK worker and protocol.
- Spawn worker with `cwd = laneRoot`.
- Pass `CURSOR_API_KEY` only through env.
- Create local SDK agent and send prompts.
- Map text/status events into ADE chat.
- Persist SDK agent id and run id for Cursor sessions.

Acceptance:

- Cursor SDK chat can answer a text-only prompt in ADE.
- Worker process exits on session close/app shutdown.
- No API key is logged.

### Phase 3: Tool/event mapping

- Map `tool_call` events into work log.
- Map shell command args/results.
- Map edit results and diff strings defensively.
- Map thinking if the existing UI supports it.
- Map task/subagent calls generically.
- Coalesce deltas into clean transcript events.

Acceptance:

- Temp file edit and shell command appear correctly in ADE transcript/work log.
- Unknown tool payloads render generically without crashing.

### Phase 4: Hook bridge permissions

- Create isolated Cursor home for each SDK worker/session.
- Write `cli-config.json` and `hooks.json`.
- Implement hook bridge command.
- Implement worker socket or local RPC for hook requests.
- Route hook requests to `AgentChatService` pending input.
- Return allow/deny to hook.
- Fail closed when ADE is unavailable in controlled modes.

Acceptance:

- Shell/write tool prompts ADE in Agent/default mode.
- Allow continues the tool.
- Deny blocks the tool.
- Ask/Plan block side effects.
- Full-auto does not prompt.

### Phase 5: Full-auto and UI parity

- Add Cursor full-auto preset.
- Align labels/tooltips with Claude bypass and Codex full-auto.
- Keep Cursor mode/preset state in session summary and persistence.
- Make handoff/parallel-chat controls support the new Cursor preset.

Acceptance:

- User can select Cursor Full auto from the same control surface family as Codex/Claude.
- Full-auto runs without approvals.
- Ask/Plan/Agent remain available.

### Phase 6: Cancellation, resume, and cleanup

- Wire ADE stop/interrupt to `run.cancel()`.
- Ensure long shell commands are killed.
- Handle worker crash and stale run cleanup.
- Use `SendOptions.local.force` for recovery where appropriate.
- Implement local resume/list where useful.

Acceptance:

- Stop cancels a running Cursor SDK turn.
- No stale child worker remains.
- Reopening/reusing a session does not attach to the wrong workspace state.

### Phase 7: Model catalog

- Use `Cursor.models.list()` for Cursor models.
- Preserve dynamic `cursor/<id>` model IDs in ADE's model registry.

Acceptance:

- Cursor model picker is populated from SDK.
- Selected model is passed as `{ id }` to SDK.

### Phase 8: Cloud agent mode

- Add cloud runtime behind a separate switch after local SDK is stable.
- Use repo catalog.
- Require explicit repo selection if no default repo is configured.
- Default `autoCreatePR` false.
- Show cloud statuses and git metadata.
- Add archive/delete cleanup.
- Import artifacts/proof if returned.

Acceptance:

- ADE can start a Cursor cloud run, stream progress, show final result/git metadata, and archive the cloud agent.
- No PR is created unless user explicitly enables it.

## Risks and mitigations

Risk: SDK request events are not actionable.

- Mitigation: use ADE hook bridge for local approvals.

Risk: Cursor native sandbox is unavailable.

- Mitigation: use ADE hooks and lane-root process isolation first.

Risk: SDK tool payload schemas change.

- Mitigation: parse defensively and render unknown payloads generically.

Risk: Cursor user settings leak into ADE behavior.

- Mitigation: isolated worker `HOME`; never use real `~/.cursor` for ADE SDK chat runtime.

Risk: Full-auto does something outside the lane.

- Mitigation: decide explicitly whether full-auto has protected-path hard guards. If yes, document this as a hard guard, not an approval prompt.

Risk: Cloud cannot do ADE-style approvals.

- Mitigation: represent cloud as isolated Cursor Cloud execution; default no auto PR; do not claim per-tool ADE approval.

Risk: Native optional package or bundling issues.

- Mitigation: keep SDK in a worker process, not directly bundled into Electron main if bundling becomes brittle.

## Definition of done

- Cursor SDK is the default and only active Cursor chat path.
- Local Cursor SDK chat can answer, inspect, edit, run shell, stream, and cancel.
- ADE permission presets work:
  - Ask/read-only denies side effects.
  - Plan denies side effects and prompts planning behavior.
  - Agent asks before risky tools.
  - Full auto asks for nothing.
- UI matches Claude/Codex control patterns.
- Worker isolation prevents user Cursor settings from changing ADE behavior.
- No API key or secret is stored in plaintext project files.
- Targeted tests pass.
- Manual real-key smoke tests pass.
- Stale processes and cloud agents are cleaned up after tests.
