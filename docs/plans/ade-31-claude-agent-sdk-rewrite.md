# ADE-31 — Claude Agent SDK upgrade & full Claude Code parity

**Owner:** Arul (planning) / TBD (implementation)
**Linear:** [ADE-31](https://linear.app/ade-linear/issue/ADE-31/look-into-updating-claude-agent-sdk-and-new-features)
**Status:** Plan (locked decisions from 2026-05-11 → 2026-05-12 planning session)
**Worktree:** `.ade/worktrees/updating-claude-agent-sdk-de25474d`
**Branch:** `ade-31-look-into-updating-claude-agent-sdk-and-new-features`

---

## 0. Read me first

This is a planning document for a load-bearing rewrite. It's long because:

- The Claude chat backend in ADE today is built on a now-deprecated session API (`unstable_v2_*`) and **must** migrate before the next SDK bump removes it.
- The same rewrite is the cheapest opportunity to bring ADE chat + `ade code` TUI to feature parity with Claude Code 2.1.x, which has shipped two dozen user-visible features since ADE last upgraded.
- Decisions on subagent UI, handoff semantics, permission modal, session storage, config home, and runtime scope (Claude-only vs cross-runtime) were locked over seven rounds of Q&A. They're recorded in §6 (Locked Decisions) so this is a single source of truth, not a thinking-out-loud document.

**Pass this plan to Codex** to drive implementation. It includes file paths, library citations, UI mockups, parallelization suggestions, and a testing strategy.

---

## 1. Context

### 1.1 Where ADE is today

- **SDK pin:** `@anthropic-ai/claude-agent-sdk@^0.2.119` in both `apps/desktop/package.json:53` and `apps/ade-cli/package.json:28`.
- **Desktop chat backend:** `apps/desktop/src/main/services/chat/agentChatService.ts` (~18,800 lines). Uses `unstable_v2_createSession` / `unstable_v2_resumeSession` / `runtime.v2Session.send()` / `runtime.v2Session.stream()`.
- **`ade code` TUI:** `apps/ade-cli/src/tuiClient/cli.tsx` (Ink/React). Does **not** call the SDK directly — it's an Ink RPC client of the desktop main process via JSON-RPC over Unix socket. The desktop runtime owns the SDK lifecycle for both surfaces.
- **Tools registered today:** workflowTools, linearTools, ctoOperatorTools, universalTools, memoryTools (built at `agentChatService.ts:4698–4780`). `ENABLE_TOOL_SEARCH` env: `"auto"`, off for CTO sessions.
- **Hooks registered today:** **PreCompact only** (`DEFAULT_FLUSH_PROMPT`, `agentChatService.ts:11509–11522`).
- **settingSources today:** `["user","project","local"]` (`agentChatService.ts:11503`).
- **Subagent UI:** `apps/desktop/src/renderer/components/chat/ChatSubagentsPanel.tsx:246-361`, keyed by ADE-internal `taskId` (not the SDK's `agent_id` / `parent_tool_use_id`). Derived in `chatExecutionSummary.ts:23-79` from internal `subagent_started` / `subagent_progress` / `subagent_result` events.
- **Handoff button:** `AgentChatPane.tsx:5335-5504` → IPC `ade.agentChat.handoff` → `registerIpc.ts:6317-6320` → `agentChatService.ts:12612-12711`. Today builds a 12-message brief, spawns a new chat in the same lane with the target model.
- **Settings page:** `apps/desktop/src/renderer/components/app/SettingsPage.tsx`, route `/settings`, 20+ sections.

### 1.2 Why now

[SDK 0.2.133](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md) deprecated `unstable_v2_createSession` / `unstable_v2_resumeSession` / `unstable_v2_prompt` — the exact APIs ADE chat is built on:

> **0.2.133:** Deprecated unstable V2 session API (`unstable_v2_createSession` / `unstable_v2_resumeSession` / `unstable_v2_prompt`) — use `query()` instead.

They still work on 0.2.139, but they will be removed. ADE is one SDK release away from broken chat. Bundling the bump with the broader parity push is cheaper than two passes.

### 1.3 Reference: t3code

[pingdotgg/t3code](https://github.com/pingdotgg/t3code) is the closest open-source analogue: a multi-provider GUI on top of the Agent SDK (Claude / Codex / OpenCode). They pin `^0.2.111` (`apps/server/package.json`), use Effect + Bun + SQLite-Bun, and structure per-provider adapters in `apps/server/src/provider/Layers/` (`ClaudeAdapter.ts`, `CodexAdapter.ts`, `ProviderSessionDirectory.ts`, `ProviderSessionReaper.ts`).

Things to borrow:

- **Session reaper pattern.** Explicit cleanup of orphaned SDK subprocesses on crash/restart. ADE doesn't have an equivalent; we should add one (see §4.2 Subprocess Lifecycle).
- **Canonical event vocabulary across runtimes.** They normalize provider events into `content.delta` / `item.started` / `turn.completed`. ADE has this conceptually across five runtimes (Claude/Codex/Cursor/Droid/OpenCode); the migration is a chance to formalize it so the new SDK shape feeds cleanly into the existing renderer.

Things ADE does already better than t3code:
- Newer SDK target (0.2.139 vs 0.2.111).
- Five runtimes vs three.
- TUI surface (`ade code`); t3code is web GUI only.
- Lanes/worktrees as a core concept (t3code only has session scope).
- Far richer UI: ChatSubagentsPanel, 20-section Settings, handoff button, plan-mode approval, AskUserQuestion integration, memory system, and Linear/CTO integrations.
- Effect adoption isn't a fit for ADE; we keep TS without it.

---

## 2. Goals & Non-Goals

### 2.1 Goals

1. Migrate `agentChatService.ts` off `unstable_v2_*` to `query()` + async-iterable prompt + `streamInput` before the API is removed.
2. Bring ADE chat (Claude runtime) to feature parity with Claude Code 2.1.x on subagents, sessions, hooks, output styles, plugins, skills, permission modes.
3. Bring `ade code` TUI to full parity with Claude Code's terminal UX on keybindings + vim mode, status line, image paste, and the slash-command surface.
4. Pass it to Codex with enough context to execute.

### 2.2 Non-goals (this pass)

- **Sandbox isolation** (FS + network). Skipped this pass; lane-as-worktree already gives some isolation.
- **Channels** (Telegram / Discord / iMessage / webhooks). Skipped; ADE has its own multi-surface story (desktop/TUI).
- **CLI flag compatibility with `claude`** (`--continue` / `--resume` / `--print` / etc.). `ade code` is multi-runtime; flag passthrough is ambiguous. No new CLI flags.
- **Replicating the `claude agents` machine-wide view.** ADE Claude sessions auto-appear in `claude agents` via shared storage. If you want that view, run `claude agents`.
- **forkSession-as-user-feature.** The Handoff button covers branching; no `/branch` command.
- **Agent teams (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`)** as a first-class feature. Hooks are wired as no-ops; UI structurally ready. Users who set the env var get it; ADE doesn't ship it on.
- **Subagent / `/agents` / `/skills` / `/context` / new hooks for non-Claude runtimes.** Claude runtime only this pass. Codex / Cursor / Droid / OpenCode subagent stories are separate initiatives.
- **`/config` slash command.** ADE's settings page is broader and already exists at `/settings`.
- **Multi-pass migration.** Hard cutover in a single PR (no feature flag).
- **Old chat history migration.** Drop existing transcripts; users start fresh.

---

## 3. Source material & references

### 3.1 Claude Agent SDK

- [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)
- [TypeScript SDK reference](https://code.claude.com/docs/en/agent-sdk/typescript)
- [Sessions guide](https://code.claude.com/docs/en/agent-sdk/sessions)
- [Hooks guide](https://code.claude.com/docs/en/agent-sdk/hooks)
- [Subagents in the SDK](https://code.claude.com/docs/en/agent-sdk/subagents)
- [Skills in the SDK](https://code.claude.com/docs/en/agent-sdk/skills)
- [Plugins in the SDK](https://code.claude.com/docs/en/agent-sdk/plugins)
- [Permissions](https://code.claude.com/docs/en/agent-sdk/permissions)
- [Migration guide (claude-code SDK → claude-agent-sdk + V2 → V1)](https://code.claude.com/docs/en/agent-sdk/migration-guide)
- [TypeScript SDK CHANGELOG](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md)
- [TypeScript SDK repo](https://github.com/anthropics/claude-agent-sdk-typescript)
- [Example agents (demos repo)](https://github.com/anthropics/claude-agent-sdk-demos)

### 3.2 Claude Code (CLI) features for parity

- [Claude Code overview](https://code.claude.com/docs/en/overview)
- [Claude Code CLI changelog](https://code.claude.com/docs/en/changelog)
- [Output styles](https://code.claude.com/docs/en/output-styles)
- [Status line](https://code.claude.com/docs/en/statusline)
- [Keybindings](https://code.claude.com/docs/en/keybindings)
- [Agent teams](https://code.claude.com/docs/en/agent-teams)
- [Subagents (filesystem-based)](https://code.claude.com/docs/en/sub-agents)
- [Permission modes](https://code.claude.com/docs/en/permission-modes)
- [Settings](https://code.claude.com/docs/en/settings)
- [Plugins](https://code.claude.com/docs/en/plugins)
- [Plugin marketplaces](https://code.claude.com/docs/en/plugin-marketplaces)
- [Skills](https://code.claude.com/docs/en/skills)

### 3.3 Reference implementation

- [pingdotgg/t3code](https://github.com/pingdotgg/t3code) — `apps/server/src/provider/Layers/ClaudeAdapter.ts`, `ProviderSessionDirectory.ts`, `ProviderSessionReaper.ts`

### 3.4 Local references

- `apps/desktop/src/main/services/chat/agentChatService.ts` — chat backend (target of the migration)
- `apps/desktop/src/main/services/chat/buildClaudeV2Message.ts` — multimodal message builder
- `apps/desktop/src/renderer/components/chat/ChatSubagentsPanel.tsx` — subagent UI (target of the redesign)
- `apps/desktop/src/renderer/components/chat/chatExecutionSummary.ts` — snapshot derivation
- `apps/desktop/src/renderer/components/chat/AgentChatComposer.tsx:2217–2241` — existing clipboard image paste in desktop (already works)
- `apps/desktop/src/renderer/components/chat/AgentChatPane.tsx:5335-5504` — Handoff button (target of the split)
- `apps/desktop/src/main/services/ipc/registerIpc.ts:6317-6320` — handoff IPC entry
- `apps/desktop/src/main/services/ai/aiIntegrationService.ts:788` — `availability.claude` (target of the binary/auth split)
- `apps/desktop/src/main/packagedRuntimeSmoke.ts` — startup health probe (will simplify after dropping `pathToClaudeCodeExecutable`)
- `apps/ade-cli/src/tuiClient/cli.tsx` — TUI entry
- `apps/ade-cli/src/tuiClient/app.tsx` — TUI main state
- `apps/ade-cli/src/tuiClient/commands.ts` — TUI built-in slash command list
- `apps/ade-cli/src/tuiClient/components/SlashPalette.tsx`, `MentionPalette.tsx`, `ApprovalPrompt.tsx`, `Drawer.tsx`, `RightPane.tsx`, `ChatView.tsx`

---

## 4. Target architecture

### 4.1 Session lifecycle

#### Today
```
agentChatService.ts
  ├─ unstable_v2_createSession(opts)  → runtime.v2Session
  ├─ runtime.v2Session.send(userMsg)
  ├─ for await (msg of runtime.v2Session.stream()) { … }
  └─ unstable_v2_resumeSession(sessionId, opts)
```

#### Target
```
agentChatService.ts
  ├─ asyncInputQueue: AsyncIterable<SDKUserMessage>   (internal pump)
  ├─ q = query({ prompt: asyncInputQueue, options })  → Query
  ├─ q.streamInput(asyncIterable) or asyncInputQueue.push(userMsg)
  ├─ for await (msg of q) { … }
  ├─ q.setPermissionMode(mode)
  ├─ q.setModel(model)
  ├─ q.interrupt() / q.close()
  └─ resume:  query({ prompt: …, options: { resume: sessionId } })
```

Reference: [Sessions guide → "automatic session management" + "use session options with query()"](https://code.claude.com/docs/en/agent-sdk/sessions).

#### Key surfaces on `Query` we'll use

| Method | Purpose | Today's equivalent |
|---|---|---|
| `streamInput(asyncIter)` | feed user turns into the live session | `session.send()` |
| `setPermissionMode(mode)` | swap mode mid-session | `session.setPermissionMode()` |
| `setModel(model?)` | swap model mid-session | n/a today |
| `setMaxThinkingTokens(n)` | force thinking budget | manual in opts today |
| `applyFlagSettings({...})` | apply settings at runtime without spawning CLI | n/a |
| `supportedCommands()` / `supportedAgents()` / `supportedModels()` | runtime introspection | partial today |
| `getContextUsage()` | context breakdown by category (drives `/context`) | n/a |
| `promptSuggestion()` | re-request prompt suggestions | implicit today |
| `interrupt()` | cancel turn | similar |
| `rewindFiles(userMessageId, { dryRun })` | roll back file changes from a turn | n/a |
| `close()` | force-terminate | similar |

### 4.2 Subprocess lifecycle (new — borrowed from t3code's reaper)

Each `query()` spawns a Claude Code subprocess (since 0.2.113, the SDK ships a per-platform native binary as optional dep). We need explicit reaping:

- A new `ClaudeSubprocessReaper` service tracks `(pid, sessionId, lane, createdAt)` for every live `query()` instance.
- On process exit (ADE quits, daemon SIGTERM, crash), the reaper sends `SIGTERM` then `SIGKILL` after a grace period to every tracked subprocess.
- Reference: `pingdotgg/t3code` — `apps/server/src/provider/Layers/ProviderSessionReaper.ts`.

### 4.3 Storage

- **Transcripts:** SDK default `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`. The encoding replaces every non-alphanumeric in the absolute `cwd` with `-` (see [Sessions guide → Resume by ID tip](https://code.claude.com/docs/en/agent-sdk/sessions#resume-by-id)).
- **ADE pointer table:** new SQLite table `claude_sessions` mapping `session_id ↔ lane_id ↔ title ↔ tags ↔ created_at`. Updated on `system:init` (capture session_id, title) and on rename/tag operations (call `renameSession()` / `tagSession()`, mirror into table).
- **Cross-tool compatibility:** ADE-created Claude sessions are visible to `claude --resume` from a terminal `cd`'d into the lane worktree; `claude agents` lists them automatically. Conversely, sessions a user started via `claude` are discoverable via `listSessions({ dir: laneWorktree })`.
- **Old chat history:** drop. The migration release notes call this out. No conversion tool.

### 4.4 Config home

| Directory | Owner | Contents |
|---|---|---|
| `~/.claude/` | Claude Code-compat | settings.json, agents/, commands/, skills/, output-styles/, statusline (script + setting), keybindings.json, plugins/, projects/ (transcripts) |
| `.claude/` | Project-level Claude-compat | settings.json, settings.local.json, agents/, commands/, skills/, output-styles/ |
| `~/.ade/` | ADE-only | lanes/, identities/, memory DB, ade-state, runtime sock |
| `.ade/` | Project-level ADE-only | lanes/, ade.db, skills/ (multi-runtime — read alongside `.claude/skills/`) |

`settingSources` stays `["user", "project", "local"]`.

### 4.5 Permission flow (updated)

[Reference](https://code.claude.com/docs/en/agent-sdk/permissions#how-permissions-are-evaluated).

```
tool requested
   │
   ▼
Hooks (PreToolUse) ──[deny]──► blocked
   │
   ▼
Deny rules (disallowedTools + settings)
   │
   ▼
Permission mode (default / plan / acceptEdits / bypassPermissions / auto)
   │   ─ auto: model-classifier decides per call (NEW)
   ▼
Allow rules (allowedTools + settings)
   │
   ▼
canUseTool callback  (ADE's approval dialog lives here)
   ▼
ADE approval dialog (Allow / Allow for Session / Deny)
```

ADE's `canUseTool` (`agentChatService.ts:4284-4630`) stays as the **last-step gate**. The "memory orientation guard" stays inside `canUseTool`. The `EnterPlanMode` / `ExitPlanMode` / `AskUserQuestion` special-casing stays.

What's new:
- `auto` mode added to the picker. UI explanation: "Claude judges each tool call — uses model classifier instead of asking you."
- The permission modal gets a visual refresh + adds the `auto` row.

### 4.6 Multi-runtime canonical event vocabulary

We formalize what t3code does. Every runtime adapter (ClaudeAdapter, CodexAdapter, CursorAdapter, DroidAdapter, OpenCodeAdapter) emits the same internal event shape so the renderer doesn't branch on runtime:

```ts
type RuntimeEvent =
  | { type: "turn.started"; turnId: string }
  | { type: "content.delta"; turnId: string; text: string; agentId?: string; parentToolUseId?: string }
  | { type: "tool.started"; toolUseId: string; toolName: string; input: unknown; agentId?: string }
  | { type: "tool.completed"; toolUseId: string; output: unknown; durationMs?: number }
  | { type: "tool.failed"; toolUseId: string; error: string }
  | { type: "subagent.started"; agentId: string; parentToolUseId: string; type: string; background?: boolean }
  | { type: "subagent.progress"; agentId: string; text?: string; tokens?: number }
  | { type: "subagent.completed"; agentId: string; summary: string; usage: Usage }
  | { type: "teammate.idle"; teamName: string; teammateName: string }       // Claude-only
  | { type: "task.completed"; taskId: string; subject: string; teammateName?: string; teamName?: string }  // Claude-only
  | { type: "turn.completed"; turnId: string; stopReason: string; usage: Usage }
  | { type: "compact.boundary"; uuid: string };
```

The ClaudeAdapter is the first one to migrate. Other adapters keep emitting their existing shapes; a shim translates to the canonical vocabulary as we go.

### 4.7 Availability detection split

Today: `availability.claude: boolean` at `aiIntegrationService.ts:788`. After: split into two:

```ts
availability.claude = {
  binary: { present: boolean; version?: string; source: "bundled" | "path" | "missing" },
  auth: { ready: boolean; mode: "api_key" | "oauth" | "bedrock" | "vertex" | "foundry" | "none" },
};
```

Integration tile shows states distinctly:
- **Binary missing** → "Claude unavailable (binary missing — should not happen with bundled install; run `/doctor`)"
- **Binary ready · awaiting auth** → "Sign in to use Claude"
- **Binary ready · authenticated** → "Ready" + last-used model

Caller sites for `availability.claude` need a sweep — anywhere that previously treated it as a boolean now checks `availability.claude.auth.ready`.

---

## 5. Phases

### Phase 0 — SDK bump (0.5 day)

**Goal:** trivially bump pinned version so the migration starts from a known-good baseline.

Tasks:
1. Bump `@anthropic-ai/claude-agent-sdk` `^0.2.119` → `^0.2.139` in:
   - `apps/desktop/package.json:53`
   - `apps/ade-cli/package.json:28`
2. `bun install`.
3. Smoke-test desktop chat + `ade code` against today's `unstable_v2_*` API. Expect: still works; deprecation warnings may appear at runtime/logs.
4. Run typecheck, full test suite (sharded).

Acceptance: no regressions; deprecation warnings logged but not fatal.

### Phase 1 — Migration off `unstable_v2_*` (3–5 days) — BLOCKING, HARD CUTOVER

**Goal:** rewrite `agentChatService.ts` to use `query()` + `Query` + `streamInput`. Delete `unstable_v2_*` call sites in one PR. No feature flag.

#### 1.1 Build the input pump

Create an internal async-iterable adapter:

```ts
class InputPump {
  private resolvers: Array<(v: IteratorResult<SDKUserMessage>) => void> = [];
  private buffer: SDKUserMessage[] = [];
  private closed = false;

  push(msg: SDKUserMessage) { /* … */ }
  close() { /* … */ }
  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> { /* … */ }
}
```

This lives in a new module: `apps/desktop/src/main/services/chat/claudeInputPump.ts`.

#### 1.2 Rewrite the session loop

Replace `unstable_v2_createSession` / `unstable_v2_resumeSession`:

```ts
import { query, type Query, type Options } from "@anthropic-ai/claude-agent-sdk";

function buildClaudeOptions(runtime, managed, chatConfig): Options {
  return {
    cwd: laneWorktreeRoot,
    env: { ENABLE_TOOL_SEARCH: managed.session.identityKey === "cto" ? "0" : "auto" },
    permissionMode: managed.permissionMode,                 // default | plan | acceptEdits | bypassPermissions | auto
    allowDangerouslySkipPermissions: managed.permissionMode === "bypassPermissions",
    includePartialMessages: true,
    agentProgressSummaries: true,
    promptSuggestions: true,
    maxBudgetUsd: chatConfig.sessionBudgetUsd,
    model: chatConfig.claudeModel,
    effort: chatConfig.effort,                              // NEW: pass directly, drop CLAUDE_EFFORT_TO_TOKENS
    forwardSubagentText: true,                              // NEW
    systemPrompt: { type: "preset", preset: "claude_code", append: ADE_SYSTEM_PROMPT_APPEND },
    settingSources: ["user", "project", "local"],
    skills: "all",                                          // NEW (replaces 'Skill' in allowedTools)
    hooks: buildAdeHooks(),                                 // EXPANDED (see Phase 2)
    canUseTool: buildClaudeCanUseTool(runtime, managed),
    abortController: runtime.abortController,
    title: undefined,                                       // let SDK auto-generate
    // pathToClaudeCodeExecutable: REMOVED — trust bundled binary
  };
}

const pump = new InputPump();
const q: Query = query({ prompt: pump, options: buildClaudeOptions(...) });

runtime.claudeQuery = q;
runtime.claudeInputPump = pump;

// stream
for await (const msg of q) {
  handleClaudeMessage(runtime, msg);
}
```

For resume:

```ts
const q = query({
  prompt: pump,
  options: { ...buildClaudeOptions(...), resume: sessionId },
});
```

For the Handoff (Claude → Claude only):

```ts
const q = query({
  prompt: pump,
  options: { ...buildClaudeOptions(...), resume: sourceSessionId, forkSession: true },
});
```

#### 1.3 Translate control surfaces

| Today | After |
|---|---|
| `runtime.v2Session.send(msg)` | `pump.push(toSDKUserMessage(msg))` |
| `runtime.v2Session.stream()` | `for await (const m of q) { … }` |
| `runtime.v2Session.setPermissionMode(m)` | `await q.setPermissionMode(m)` |
| `runtime.v2Session.interrupt()` | `await q.interrupt()` |
| `runtime.v2Session.close()` | `q.close()` |

#### 1.4 Drop `'Skill'` from allowedTools

Replace any `allowedTools: [..., 'Skill', ...]` with the new `skills` option (`'all'` or `string[]`). The SDK auto-enables the Skill tool when `skills` is set.

#### 1.5 Drop `pathToClaudeCodeExecutable`

Stop resolving and passing the path. The SDK loads its bundled per-platform binary. Convert `apps/desktop/src/main/packagedRuntimeSmoke.ts` from a path-resolver to a lightweight `query()` health probe:

```ts
async function probeClaudeStartup() {
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), CLAUDE_PROBE_TIMEOUT_MS);
  try {
    const stream = query({
      prompt: "System initialization check. Respond with only the word READY.",
      options: { cwd: os.tmpdir(), permissionMode: "plan", abortController },
    });
    for await (const msg of stream) {
      if (msg.type === "result" && msg.subtype === "success") return { ok: true };
    }
    return { ok: false, reason: "no result message" };
  } finally {
    clearTimeout(timeout);
  }
}
```

#### 1.6 Drop manual effort → token-budget mapping

Delete `CLAUDE_EFFORT_TO_TOKENS` and any code that builds `thinking: { type: 'enabled', budget_tokens: N }`. Pass `effort` directly. Keep `xhigh` as a valid value (SDK accepts it at runtime even though the publicly-exported `EffortLevel` type since 0.2.84 is the narrower `'low' | 'medium' | 'high' | 'max'`).

References:
- [SDK CHANGELOG 0.2.84](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md): "Exported `EffortLevel` type (`'low' | 'medium' | 'high' | 'max'`)"
- [SDK CHANGELOG 0.2.49](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md): "SDK model info includes `supportsEffort`, `supportedEffortLevels`, `supportsAdaptiveThinking`"

#### 1.7 Build the canonical event translator

Wherever `agentChatService.ts` today emits `subagent_started` / `subagent_progress` / `subagent_result` events (used by `chatExecutionSummary.ts:23-79`), additionally emit the new canonical event shape (§4.6). Existing renderer paths keep working during the transition.

#### 1.8 Subprocess reaper

Wire `ClaudeSubprocessReaper` as a new service. Register on every `query()` create. Tear down on:
- Desktop main process exit (Electron `before-quit`)
- ADE daemon SIGTERM/SIGINT
- Lane close
- Process crash recovery on launch (scan for orphans)

#### 1.9 Fix the finicky slash command reliability bug

User-reported: "claude chat still finicky, commands don't always come through." Almost certainly lives in the input pump / pre-expansion logic. As part of the rewrite:

- Add an `expandSlashCommand(rawInput, registry)` step *before* anything reaches the pump.
- Log every input expansion at debug level.
- Add a test fixture exercising `/clear`, `/commit`, `/push`, multi-word commands like `/linear list`, and slash commands typed mid-sentence.

Acceptance for Phase 1: desktop chat + `ade code` work for all current flows on the new pipeline. Old call sites of `unstable_v2_*` removed.

### Phase 2 — SDK feature adoption (3–4 days, parallelizable)

Each item is independent and small enough to ship in its own PR after Phase 1 merges.

#### 2.1 `startup()` pre-warm

When (a) a lane is selected AND (b) a Claude model is the active model:
- Call `startup({ options: buildClaudeOptions(...) })` to warm a `WarmQuery`.
- Cache per `(lane_id, model_id)`.
- Re-warm on lane switch or model change. Discard previous warm.
- First user message in the warmed session consumes the `WarmQuery`; subsequent messages create fresh `query()` instances normally.

Reference: [CHANGELOG 0.2.89](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md) ("Added `startup()` to pre-warm CLI subprocess before `query()`, ~20x faster first query").

#### 2.2 `getContextUsage()` + `/context` view

Add slash command `/context`. On invocation, call `q.getContextUsage()` and render a breakdown panel:

```
Context usage
  System prompt           4,287   3.5%
  Tools                   8,113   6.6%
  CLAUDE.md / AGENTS.md     842   0.7%
  Skills (loaded)         2,401   2.0%
  Conversation          61,884  50.4%
  Free                  39,571  32.2%
  ─────────────────────────────────
  Total                122,700  100%
```

Both surfaces (desktop chat + TUI right pane).

#### 2.3 Hooks expansion

Beyond the existing PreCompact, register:

| Hook | What it does in ADE |
|---|---|
| `PreCompact` (existing) | inject `DEFAULT_FLUSH_PROMPT` for memory save before compaction |
| `SubagentStart` | open ChatSubagentsPanel if collapsed; create snapshot row keyed by `agent_id` |
| `SubagentStop` | mark snapshot complete; render summary chip |
| `PostToolUse` | for tool outputs > 200KB, trim with a summarizer; surface `updatedToolOutput` |
| `PostToolUseFailure` | log structured error to ADE diagnostics; emit canonical `tool.failed` event |
| `Notification` | route to ADE's existing green/yellow status indicators (desktop chat list + TUI chat list) |
| `Stop` | end-of-turn metrics: turn duration, model usage, tool count |
| `TeammateIdle` (no-op) | wire so it doesn't crash if a user enables agent teams; UI tab structurally ready |
| `TaskCompleted` (no-op) | same |

Memory and identity context **stay in systemPrompt appends**. We are not moving them to `UserPromptSubmit` / `SessionStart` in this pass.

Reference: [Hooks guide](https://code.claude.com/docs/en/agent-sdk/hooks).

#### 2.4 Session library

Power the chat sidebar's session list from SDK functions instead of ADE's bespoke transcript table:

- `listSessions({ dir: laneWorktree })` for lane-scoped listing.
- `getSessionInfo(sessionId)` for hover details.
- `getSessionMessages(sessionId, { limit, offset })` for transcript preview.
- `renameSession(sessionId, title)` and `tagSession(sessionId, tag)` for user edits.
- Maintain the ADE pointer table (`claude_sessions`) for lane association and tag history.

References: [CHANGELOG 0.2.53, 0.2.59, 0.2.74, 0.2.75](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md).

#### 2.5 Subagent UI re-plumb (Claude runtime only)

The biggest visual change. See §7 (UI mockups) for the desktop panel design and §8 (TUI mockups) for the TUI side.

In `chatExecutionSummary.ts`:
- Add second snapshot derivation keyed by `agent_id` (alongside today's `taskId`).
- New event subscribers: `SubagentStart` / `SubagentStop` hooks.
- Group nested messages by `parent_tool_use_id` for the timeline view.
- Add `agent_id` and `parent_tool_use_id` to the existing `ChatSubagentSnapshot` type.
- Add `final_summary` field populated on SubagentStop.

In `ChatSubagentsPanel.tsx`:
- Add three tabs: **Subagents (this chat)** | **Teammates (this team)** | **Background sessions**.
- The Teammates tab is structurally present but empty unless `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` is on.
- Background sessions tab lists results of `listSessions()` for the lane.
- Each row shows: status dot · name · type chip (`subagent` / `bg` / `teammate`) · runtime summary (tokens · duration) · status pill.
- Click row → detail view (existing) plus live-streamed text deltas inline when `forwardSubagentText` is on.
- Completed rows show a **final summary chip** (e.g., "All 412 tests passed", "Found 47 TODOs").

Show the panel only when the active runtime is Claude. Other runtimes' chat lifecycle continues to use their existing panel (or no panel).

#### 2.6 `rewindFiles` "Undo from here" affordance

On every past user message in the chat transcript:
- Render a small rewind-icon button that **appears on hover** of the message.
- On hover of the icon itself, an explanatory tooltip appears regardless of the user's tooltip-disable setting (this is too discoverable-critical to suppress).
- Tooltip text: *"Undo the file changes the agent made after this message. Conversation stays intact."*
- On click, open a confirmation dialog showing:
  - The user message timestamp
  - A `git diff --stat`-style list of files that will be reverted
  - Per-file expandable diff preview (read-only)
  - **Cancel** | **Revert files**
- On confirm, call `q.rewindFiles(userMessageId)` (no `dryRun`).
- Show a non-blocking toast on success: "Files restored to before [message preview]".

Reference: [`Query.rewindFiles`](https://code.claude.com/docs/en/agent-sdk/typescript) (returns `RewindFilesResult`; supports `{ dryRun: true }` for preview).

#### 2.7 `forwardSubagentText` default on

Pass `forwardSubagentText: true` in options. Per-agent opt-out via `AgentDefinition` for headless specialists. Streamed text deltas render inline in the subagent's panel row.

Reference: [CHANGELOG 0.2.119](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md).

#### 2.8 Output styles

Wire `/output-style` slash command. Read from:
- `~/.claude/output-styles/*.md` (user)
- `.claude/output-styles/*.md` (project)
- Plugin `output-styles/` directories

Expose Claude Code's built-in styles via `applyFlagSettings({ outputStyle: 'Default' | 'Proactive' | 'Explanatory' | 'Learning' })`. Selection persists to `.claude/settings.local.json`.

Reference: [Output styles](https://code.claude.com/docs/en/output-styles).

#### 2.9 ADE CLI guidance

ADE built-ins stay on the ADE CLI control plane. Claude SDK sessions receive the normal ADE CLI prompt guidance and environment instead of provider-side tool-server configuration.

### Phase 3 — UI refresh (4–6 days, parallelizable across components)

#### 3.1 Permission modal refresh

Targets: the approval dialog rendered by `canUseTool` and the permission-mode picker.

- Add **Auto** row to the picker, between **Accept Edits** and **Bypass Permissions**.
- Copy: "**Auto** — Claude judges each tool call. Uses a model classifier instead of asking you."
- Visual polish: typography, spacing, icon set. Match design language of the rest of ADE.
- "Allow for Session" affordance stays.
- "Memory orientation guard" warning stays.

#### 3.2 Handoff split — two buttons

Replace the single Handoff button with two clearly-labelled buttons (no clutter):

- **Fork (full history)** — Claude → Claude only. Uses `query({ resume: sourceSessionId, forkSession: true })`. Source session untouched. New session inherits the entire conversation. Tooltip: "Create a new Claude chat that continues from this point. The original chat stays intact."
- **Handoff (brief)** — for cross-runtime handoffs (Claude → Codex, etc.) and as a manual choice for users who don't want full-context fork. Uses today's 12-message brief flow. Tooltip: "Send a 12-message summary to another model or runtime."

The Fork button is only visible when source and target are both Claude runtimes. Cross-runtime defaults to Handoff.

Code paths to touch:
- `apps/desktop/src/renderer/components/chat/AgentChatPane.tsx:5335-5504` — button group
- `apps/desktop/src/main/services/chat/agentChatService.ts:12612-12711` — backend; add `mode: 'fork' | 'brief'` to the IPC params
- `apps/desktop/src/shared/ipc.ts:182` — IPC channel signature

#### 3.3 ChatSubagentsPanel redesign

See §7 for ASCII mockup. Three-tab layout, agent_id-keyed snapshots, final-summary chips on completion, streamed text deltas inline.

#### 3.4 rewindFiles UI

See §2.6.

#### 3.5 Availability detection split UI

- Settings → Integrations → Claude row reflects both `binary.present` and `auth.ready` distinctly.
- Status text: "Bundled · awaiting auth" / "Bundled · authenticated" / "Binary missing (run /doctor)".
- Caller sweep: every site that read `availability.claude` as boolean now reads `availability.claude.auth.ready`.

#### 3.6 `/context` panel

See §2.2 mockup. Inline in chat or in right pane (desktop); right pane (TUI).

### Phase 4 — TUI parity push (6–10 days, biggest scope)

`ade code` becomes a Claude Code peer for keyboard-heavy users. **Claude-only** features (subagent panel, `/agents`, `/skills`, `/context`, hooks-driven indicators) light up only in Claude lanes/sessions.

#### 4.1 Keybindings (`~/.claude/keybindings.json`)

Verbatim adoption of the [keybindings schema](https://code.claude.com/docs/en/keybindings). Support every documented context (`Chat`, `Autocomplete`, `Confirmation`, `Tabs`, `Help`, `Transcript`, `HistorySearch`, `Task`, `ThemePicker`, `Attachments`, `Footer`, `MessageSelector`, `DiffDialog`, `ModelPicker`, `Select`, `Plugin`, `Scroll`, `Doctor`). Support every action namespace (`chat:*`, `app:*`, `history:*`, `scroll:*`, `selection:*`, etc.). Chord syntax. Reserved-key warnings.

Implementation:
- New module `apps/ade-cli/src/tuiClient/keybindings/` with parser, validator, dispatcher.
- Hot-reload on file change.
- `/keybindings` slash command opens `~/.claude/keybindings.json` with the system editor.
- `/doctor` surfaces keybinding warnings.

#### 4.2 Vim mode

Toggle via `/config` → Editor mode (we noted no `/config` slash command; this lives in ADE's `/settings` instead, surfaced as **Settings → AI Features → Editor mode**). When on:
- INSERT / NORMAL modes in the chat input.
- `j` / `k` in NORMAL navigate history (and select footer pill at input boundary).
- `Space` in NORMAL moves cursor right.
- Standard vi motions, operators, NFD-safe handling.

#### 4.3 Status line

Verbatim contract: a shell script reading JSON on stdin, output rendered as the bottom status line. JSON schema mirrors [Claude Code's status line](https://code.claude.com/docs/en/statusline):
- `model` — { id, displayName, supportsEffort, fastMode }
- `workspace` — { cwd, gitBranch, gitWorktree }
- `context_window` — { used, total, percentage }
- `rate_limits` — { fiveHourUsed, fiveHourTotal, sevenDayUsed, sevenDayTotal, resetsAt }
- `session_id`, `session_name`, `cwd`, `lane` (ADE addition), `permission_mode` (ADE addition)
- `refreshInterval` (seconds)

User configures via `~/.claude/settings.json` → `statusLine` setting key. Multi-line output supported. Examples shipped under `docs/examples/statuslines/`.

#### 4.4 Plugins

Read `~/.claude/plugins/` (so anything installed via `claude /plugin install …` works in `ade code`). Internal ADE features (ade-linear, ade-cto, ade-memory) restructure as plugins using the same `.claude-plugin/plugin.json` manifest. Plugin sources (skills, commands, agents, hooks, output styles) all flow through ADE's pipelines.

Implementation:
- `apps/desktop/src/main/services/plugins/pluginRegistry.ts` — scan + load.
- Pass `plugins: [{ type: "local", path }]` to `query()`.
- `q.reloadPlugins()` on filesystem change.
- `/plugin` slash command for list / enable / disable / install instructions.

Reference: [Plugins guide](https://code.claude.com/docs/en/agent-sdk/plugins).

#### 4.5 Clipboard image paste (all runtimes)

Keystroke handler reads clipboard via:
- macOS: `pbpaste -Prefer image`
- Linux/X11: `xclip -selection clipboard -t image/png -o`
- Linux/Wayland: `wl-paste -t image/png`
- Windows: PowerShell `Get-Clipboard -Format Image | …`

Image becomes a content block via the existing `buildClaudeV2Message.ts` multimodal pipeline. Works for all runtimes (input-layer feature, runtime-agnostic).

#### 4.6 Right pane integration for subagent view (Claude only)

When a Claude chat is active and the model spawns a subagent:
- If the right pane is closed, **auto-open it** to the Subagents view.
- The right pane has a view-switcher button list (existing pattern with pane-open buttons). Add a "Subagents" entry. Users can arrow down to and click it to swap views.
- The right pane Subagents view renders the same data as the desktop's three-tab panel, in TUI layout: rows with status dot, name, type chip, runtime summary, status pill.
- Live text deltas wrap inline under the row, capped at 3 lines visible.
- Tab key cycles among Subagents / Teammates (no-op) / Background sessions tabs within the pane.

#### 4.7 Slash command set in TUI

**Keep all existing** ADE TUI slash commands (don't break compat): `/clear`, `/commit`, `/push`, `/pull`, `/stage all`, `/help`, `/model`, `/effort`, `/new chat`, `/new lane`, `/resume`, `/linear …`, `/remember`, `/forget`, `/diff`, `/log`, etc.

**Add Core:**
- `/agents` — list view of installed agents (project + user + plugin sources). No Running tab — Running lives in the right-pane Subagents view.
- `/skills` — list view of installed skills with type-to-filter search; Enter pre-fills `/<skill-name>`; sort by token count toggle.
- `/memory` — open the canonical memory file (ADE memory: opens memory manager; Claude: opens CLAUDE.md). Dual-write: edits flow to both.
- `/context` — context-usage breakdown panel (§2.2).
- `/compact` — manual compaction trigger.
- `/init` — generate AGENTS.md (canonical) + CLAUDE.md (thin pointer `@include AGENTS.md`).

**Add Operational:**
- `/usage` — 5-hour and 7-day rate limit usage.
- `/insights` — session analytics.
- `/fast` — fast mode toggle for Opus 4.6 (gated on `supportsFastMode`).
- `/goal` — set a completion condition; live elapsed/turns/tokens overlay (Claude 2.1.139).
- `/rename <title>` — calls `renameSession()`.
- `/tag <tag>` — calls `tagSession()`.

**Do not add:** `/config` (settings page covers this), `/branch` / `/teleport` / `/scheduled` (out of scope), `/release-notes` / `/scroll-speed` (low ROI).

#### 4.8 History search (Ctrl+R)

Cross-session history search. `Ctrl+S` cycles scope (session → project → everywhere). Backed by `listSessions()` + an in-memory prompt index.

#### 4.9 External editor handoff (Ctrl+G)

Open the current prompt in `$EDITOR` (default vi). Save returns to TUI.

### Phase 5 — Cleanups (1–2 days)

- Delete `unstable_v2_*` import sites (Phase 1 already does this; double-check after merge).
- Delete `CLAUDE_EFFORT_TO_TOKENS` constants and helpers.
- Delete `pathToClaudeCodeExecutable` resolution code; reduce `packagedRuntimeSmoke.ts` to the new `query()` probe.
- Sweep `availability.claude` boolean usage sites; convert to `availability.claude.auth.ready` or `availability.claude.binary.present`.
- Drop ADE's session-title-derivation code (SDK auto-generates).
- Delete dead ADE-side subagent event types if everything is on the canonical vocabulary by end of Phase 4.
- Remove old chat history reader code paths.

---

## 6. Locked decisions (reference)

This is the single source of truth from Q&A. If something below conflicts with the prose above, **the locked decision wins** — please flag for an explicit override discussion.

### SDK & migration
1. Bump `@anthropic-ai/claude-agent-sdk` `0.2.119` → `0.2.139` in `apps/desktop` and `apps/ade-cli`.
2. Rewrite `agentChatService.ts` to use `query()` + async-iterable prompt + `streamInput`. Resume via `resume: sessionId`.
3. **Hard cutover in a single PR.** No feature flag.
4. Replace `'Skill'` in `allowedTools` with `skills: 'all'`.
5. Drop `pathToClaudeCodeExecutable`; trust the SDK's bundled binary.
6. Pass `effort` directly. Drop the manual token-budget mapping. Keep `xhigh` as a value.
7. Convert `packagedRuntimeSmoke.ts` to a `query()` health probe.

### Storage & sessions
8. Transcript storage: SDK default `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`.
9. ADE pointer table: `claude_sessions(session_id, lane_id, title, tags, created_at)`.
10. Cross-tool resume compatibility: yes.
11. Session titles: SDK auto-generates; ADE captures via system:init. Users rename via `/rename` (calls `renameSession()`).
12. Old chat history: drop.

### Hooks
13. Keep PreCompact.
14. Add SubagentStart, SubagentStop, PostToolUse (with `updatedToolOutput` for large output trimming), PostToolUseFailure, Notification, Stop.
15. **Do not** move memory / identity / skill-discovery out of systemPrompt. Keep current append architecture.
16. Wire TeammateIdle / TaskCompleted as no-ops.

### Subagents (Claude runtime only)
17. Desktop UI: three-tab unified panel — **Subagents | Teammates | Background sessions**.
18. TUI UI: right-pane integration; auto-open on subagent spawn; navigable view-switcher button.
19. Re-key on `agent_id` + `parent_tool_use_id`.
20. `forwardSubagentText: true` by default; per-agent opt-out.
21. Final summary chip on completion.
22. Subagent infra only — **no ADE-shipped named subagent definitions**.
23. Agent teams: skip `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`; hooks wired as no-ops; UI tab structurally ready.

### Handoff
24. Split into two buttons:
    - **Fork (full history)** — Claude→Claude, uses `forkSession: true` + `resume: sourceSessionId`.
    - **Handoff (brief)** — today's 12-message brief flow; default for cross-runtime.

### Permissions
25. Keep ADE approval dialog.
26. Add `auto` mode to the picker; ensure default/plan/acceptEdits/bypassPermissions all work.
27. Update permission modal UI (auto row + polish).
28. **Skip sandbox** this pass.

### Config & discovery
29. `~/.claude/` and `.claude/` for Claude-compat content (skills, commands, agents, output-styles, statusline, keybindings, plugins).
30. `~/.ade/` and `.ade/` for ADE-only state (lanes, identities, memory DB).
31. Skills: read both `.ade/skills/` and `.claude/skills/` (multi-runtime support).
32. `settingSources` stays `["user", "project", "local"]`.
33. ADE CLI guidance stays the integration point for ADE-owned tools.

### TUI parity
34. Keybindings: verbatim `~/.claude/keybindings.json` schema; vim mode via Settings.
35. Status line: verbatim Claude Code shell-script + JSON contract.
36. Plugins: read `~/.claude/plugins/`; internal ADE plugins use Claude plugin manifest format.
37. Image paste from clipboard in TUI: all runtimes.
38. No new CLI flags.
39. No `/config` slash command.

### Slash commands
40. Keep all existing ADE slash commands.
41. Add Core: `/agents`, `/skills`, `/memory`, `/context`, `/compact`, `/init`.
42. Add Operational: `/usage`, `/insights`, `/fast`, `/goal`, `/rename`, `/tag`.
43. Skip: `/config`, `/branch`, `/teleport`, `/scheduled`, `/release-notes`, `/scroll-speed`.
44. `/agents` and `/skills` are list-only — no Running tab (Running lives in ChatSubagentsPanel).
45. Fix finicky slash command reliability bug as part of Phase 1 rewrite.

### Memory
46. Dual-write to ADE memory + Claude `/memory` + CLAUDE.md.

### Performance
47. `startup()` warm when (lane selected) AND (Claude model selected); cache per `(lane, model)`; refresh on either change.
48. `getContextUsage()` powers `/context` in both surfaces.

### Files
49. `rewindFiles` UI: hover-revealed icon on past user messages; always-on tooltip on icon hover; click opens confirmation dialog enumerating files + per-file diff preview; confirm calls `q.rewindFiles(userMessageId)`.

### Availability detection
50. Split `availability.claude` → `availability.claude.binary` + `availability.claude.auth`.

### `/init`
51. Generate both AGENTS.md (canonical, multi-runtime) and CLAUDE.md (thin pointer: `@include AGENTS.md`).

### Channels, lanes, scope
52. Skip channels this pass.
53. Don't replicate `claude agents` machine-wide view in ADE; ADE sessions auto-appear in `claude agents`.
54. Lanes stay runtime-agnostic worktree containers.
55. All subagent / `/agents` / `/skills` / new hooks / new UI work is **Claude runtime only** this pass.

### Plan mode
56. Keep ADE's existing ExitPlanMode UI; absorb the new SDK `planFilePath` field.

### Notifications
57. Wire to existing ADE green/yellow status indicators (desktop chat list + TUI chat list).

### Output styles
58. Expose Default, Proactive, Explanatory, Learning. Read user-custom from `.claude/output-styles/` and plugin output-styles. Wire `/output-style`.

### Architecture lessons from t3code
59. Add an explicit `ClaudeSubprocessReaper` (modeled on `ProviderSessionReaper`).
60. Formalize the canonical multi-runtime event vocabulary (§4.6) so non-Claude adapters plug in cleanly.

---

## 7. Desktop chat UI mockups

### 7.1 Three-tab subagent panel (chosen design)

```
┌─ Agents ───── 3 active · 1 bg · 2 done ─┐
│ [Subagents] Teammates  Background        │
├───────────────────────────────────────────┤
│ ● research-explorer    subagent  2.3k·14s │
│   scan repo for TODO patterns             │
│   ▎ Found 47 TODOs in 12 files...     ▼  │
│                                           │
│ ● code-reviewer    [bg]      6.1k·1m12s   │
│   review PR #281 for security             │
│                                           │
│ ✓ test-runner       done   12.4k·4m20s    │
│   ┊ Summary chip: All 412 tests passed    │
└───────────────────────────────────────────┘
```

Notes:
- Header: panel label, summary chip (active · bg · done · stopped · failed).
- Tab row: active tab highlighted; tabs are **Subagents** / **Teammates** / **Background**.
- Each row: status dot · agent name · type chip · runtime summary (tokens · duration) · status pill.
- Streamed text deltas appear inline (▎ prefix) when `forwardSubagentText: true`.
- Final-summary chip on completion (┊ prefix).
- Background subagents get a `[bg]` chip.
- Click row → detail timeline (existing pattern preserved).

### 7.2 Permission modal (refresh)

```
┌─ Permission required ─────────────────────────┐
│                                                │
│  Tool:  Bash                                   │
│  Command:  rm -rf ./node_modules               │
│                                                │
│  Mode:                                         │
│    ○ Default      ask each time                │
│    ○ Plan         read-only tools only         │
│    ○ Accept Edits auto-approve file ops        │
│    ● Auto         model decides (NEW)          │
│    ○ Bypass       no prompts (dangerous)       │
│                                                │
│  Memory check: ✓ relevant context found        │
│                                                │
│  [ Deny ]  [ Allow ]  [ Allow for Session ]    │
└────────────────────────────────────────────────┘
```

### 7.3 Handoff button — split

```
┌─ Chat header ────────────────────────────────────────────┐
│  Lane: ade-31  ·  Claude Opus 4.7  ·  effort: high       │
│                                          [Fork] [Handoff] │
└──────────────────────────────────────────────────────────┘
                                            ▲      ▲
                                            │      │
                              Tooltip:      │      │  Tooltip:
                              "New Claude   │      │  "Send 12-msg
                               chat with    │      │   summary to
                               full history"│      │   another model"
                              (Claude→Claude│      │  (any direction)
                               only)        │      │
```

### 7.4 `/context` panel

```
┌─ Context usage ─── 122,700 / 200,000 tokens · 61% ───┐
│                                                       │
│  System prompt           4,287    3.5%  ▏             │
│  Tools                   8,113    6.6%  ▎             │
│  AGENTS.md / CLAUDE.md     842    0.7%  ▏             │
│  Skills (loaded)         2,401    2.0%  ▎             │
│  Conversation           61,884   50.4%  ████████▌    │
│  Free                   39,571   32.2%  █████▎       │
│  ─────────────────────────────────────────────       │
│  Total                 122,700   100%                 │
│                                                       │
│  [ Compact now ]  [ View transcript ]                 │
└───────────────────────────────────────────────────────┘
```

### 7.5 `rewindFiles` confirmation dialog

```
┌─ Undo file changes ──────────────────────────────────────┐
│                                                           │
│  Revert to before:                                        │
│    "Refactor the auth module to use JWT instead of..."    │
│    sent 14 minutes ago                                    │
│                                                           │
│  Files that will be restored:                             │
│    ▶ src/auth/jwt.ts             +84 / -0  (new file)    │
│    ▶ src/auth/index.ts            +12 / -34              │
│    ▶ src/middleware/auth.ts        +5 / -18              │
│    ▶ tests/auth/jwt.test.ts      +120 / -0  (new file)   │
│                                                           │
│  Conversation history is not affected.                    │
│                                                           │
│                       [ Cancel ]  [ Revert 4 files ]      │
└───────────────────────────────────────────────────────────┘
```

---

## 8. TUI mockups

### 8.1 Right pane with subagents view (chosen design)

```
┌─ ade code · lane: ade-31 ─ Claude · Opus 4.7 ─────────────────┐
│                                                                │
│  user: review the codebase for security issues                 │
│                                                                │
│  ◌ Claude is using agents...                                   │
│                                                                │
└───────────────────────────────────────────┬────────────────────┘
                                            │
┌─ Right pane ──── Subagents ── Teammates ──┤ Background ────────┐
│                                            │                    │
│  ▶ ● research-explorer  subagent     14s   │  (no team active) │
│    scan repo for TODO patterns             │                    │
│    ▎ Found 47 TODOs in 12 files...         │  no background    │
│                                            │  sessions          │
│  ▶ ● code-reviewer [bg] subagent     1m12s │                    │
│    review PR #281                          │                    │
│                                            │                    │
│  ▶ ● feature-builder    teammate    2m30s  │                    │
│    implementing /context command           │                    │
│                                            │                    │
│  ▶ ✓ test-runner        subagent     done  │                    │
│    ┊ All 412 tests passed                  │                    │
└────────────────────────────────────────────┴────────────────────┘
─[F1 help][Ctrl+J toggle pane][Tab cycle view][Esc cancel]────────
```

Behavior:
- Right pane auto-opens to Subagents view when a subagent spawns AND pane is closed.
- View-switcher button in the pane chrome (arrow-navigable like the existing left-pane and right-pane toggle buttons) returns to Subagents view from other right-pane views.
- Tab key cycles tabs *within* the pane (Subagents → Teammates → Background → Subagents).
- Each row: status dot · name · type chip · runtime · duration.
- Live text deltas inline (▎ prefix), wrapped to row width, capped at 3 lines.
- Final-summary chip (┊ prefix) on completion.

### 8.2 Status line (verbatim Claude Code contract)

Single-line example:

```
opus-4.7 · main * ade-31 · 61% ctx · 4.20$ · ade-31 lane · auto
```

Multi-line example:

```
opus-4.7 · main * ade-31 · 4h 32m left in window
[████████▌      ] 61% context · $4.20 spent · auto mode
```

The script receives JSON on stdin, prints to stdout. ADE additions to the JSON: `lane`, `permission_mode`.

### 8.3 `/agents` list view (TUI)

```
┌─ /agents · 7 installed ──────────────────────────── type-to-filter ─┐
│                                                                      │
│  code-reviewer       project   Expert code review for quality & sec │
│  test-runner         project   Run tests and analyze failures        │
│  research-explorer   user      Broad codebase exploration            │
│  doc-writer          user      Write API documentation               │
│  linear-triage       plugin    Triage Linear issues (plugin: ade-…) │
│  pr-summarizer       plugin    Summarize PRs (plugin: ade-…)         │
│  security-auditor    project   Static security review                │
│                                                                      │
│  [Enter] pre-fill /<name>  · [/] search  · [Esc] close              │
└──────────────────────────────────────────────────────────────────────┘
```

### 8.4 `/skills` list view (TUI)

```
┌─ /skills · 14 installed ───── sort: name · [t] toggle token sort ───┐
│                                                                      │
│  ade-31-context        project   ~840 tok   load ADE-31 context     │
│  shipLane              user     ~1.2k tok   autonomously ship a PR  │
│  audit                 user     ~2.1k tok   audit recent work       │
│  release               user     ~3.0k tok   cut an ADE release      │
│  finalize              user     ~1.8k tok   final pre-ship gate     │
│  simplify              user     ~1.5k tok   simplify changed code   │
│  review                user     ~1.1k tok   review a PR             │
│  security-review       user     ~2.4k tok   security review changes │
│  hyperframes           plugin   ~6.2k tok   HyperFrames composition │
│  …                                                                   │
│                                                                      │
│  [Enter] pre-fill /<name>  · [/] search  · [t] sort by tokens       │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 9. Parallelization with agents (suggestions)

This rewrite is large enough to benefit from parallel agent work. Independent slices that can run concurrently after Phase 1 ships:

### After Phase 1 lands

**Wave 1 — pure backend SDK adoptions (parallelizable, low UI coupling)**
1. `startup()` pre-warm + cache (Phase 2.1)
2. `getContextUsage()` + emit canonical context-usage event (Phase 2.2)
3. Hooks wiring: SubagentStart/Stop, PostToolUse trim, PostToolUseFailure, Notification, Stop (Phase 2.3)
4. Session library wiring: `listSessions`, `renameSession`, `tagSession`, `getSessionMessages` + ADE pointer table (Phase 2.4)
5. ADE CLI guidance (Phase 2.9)
6. ClaudeSubprocessReaper (§4.2)

These six tickets touch different modules in the backend and have minimal UI overlap.

**Wave 2 — UI work (parallelizable across components)**
1. Permission modal refresh + auto mode row (Phase 3.1)
2. Handoff split (Phase 3.2) — backend + frontend touches but isolated to handoff path
3. ChatSubagentsPanel three-tab redesign (Phase 3.3 + Phase 2.5 subagent re-plumb) — single agent owns both since they're tightly coupled
4. rewindFiles UI + backend exposure (Phase 3.4 / Phase 2.6)
5. `availability.claude` split + caller sweep (Phase 3.5)
6. `/context` panel (Phase 3.6)

**Wave 3 — TUI parity (parallelizable across modules)**
1. Keybindings + vim mode (Phase 4.1 / 4.2)
2. Status line (Phase 4.3)
3. Plugins discovery + `q.reloadPlugins()` (Phase 4.4)
4. Clipboard image paste cross-runtime (Phase 4.5)
5. Right-pane subagent integration (Phase 4.6)
6. Slash command set additions (Phase 4.7)
7. Ctrl+R history search (Phase 4.8)
8. External editor handoff (Phase 4.9)

### Suggested agent assignment

- **Agent A — Migration captain (Phase 1).** Single-threaded; this is the highest-risk piece. Cannot parallelize.
- **Agents B/C — Backend wave (Phase 2.1, 2.4 and Phase 2.2, 2.9, reaper).** Two agents, three tickets each.
- **Agent D — Hooks wave (Phase 2.3).** Owns all hook registrations + canonical-event translator.
- **Agents E/F — UI wave (Phase 3).** One owns permission modal + handoff + availability split. The other owns subagent panel + rewindFiles + `/context`.
- **Agents G/H — TUI wave (Phase 4).** One owns keybindings + vim + status line. The other owns plugins + clipboard + right-pane + slash commands.
- **Agent I — Cleanups (Phase 5).** Sweeps last-call removals; pairs with each PR landing.

### Coordination rules

- Phase 1 merges *first*, full stop. Every other agent waits for that merge.
- Agents in the same wave coordinate via the shared canonical event vocabulary (§4.6) — define it as a TypeScript interface in `apps/desktop/src/main/services/chat/runtimeEvents.ts` before Phase 2 starts.
- Daily 15-min sync (or async via Linear comments) on:
  - Type-shape changes that touch multiple agents.
  - SDK-version surprises (changelog drift).
  - Subagent / agent-team scoping (Claude-only constraint).

### What *not* to parallelize

- Phase 1 itself — keep it single-threaded.
- The subagent re-plumb (Phase 2.5) + ChatSubagentsPanel redesign (Phase 3.3) — same agent owns both because the type changes ripple.
- Any work touching `agentChatService.ts` should be sequenced through one captain to avoid merge conflicts on the largest file in the repo.

---

## 10. Testing strategy

### 10.1 Per-phase smoke checks

- **Phase 0:** `bun run typecheck` + sharded test suite green. Manual desktop chat smoke (one message, one tool call, exit).
- **Phase 1:** end-to-end chat flow on the new pipeline. Specific tests:
  - send / receive / streaming (assistant + partial messages)
  - tool approval through `canUseTool` (Allow / Deny / Allow for Session)
  - resume by session_id from sidebar
  - permission mode switch mid-turn
  - compact_boundary + identity continuity preserved
  - PreCompact hook fires DEFAULT_FLUSH_PROMPT
  - slash command reliability — `/clear`, `/commit`, `/push`, `/linear list`, mid-sentence `/help`
  - subprocess teardown on tab close
- **Phase 2:**
  - `startup()` warm — first-chat latency < 500ms when warmed
  - `getContextUsage()` numbers reasonable
  - SubagentStart/Stop hooks fire; panel reflects state
  - PostToolUse trim — supply a 5MB tool output; verify trimmed to <200KB before reaching model context
  - Notification hook triggers green/yellow indicator
  - `listSessions()` round-trip with rename / tag
- **Phase 3:**
  - Permission modal renders all 5 modes; auto row works
  - Handoff Fork — confirm full transcript inheritance
  - Handoff Brief — confirm 12-msg brief works
  - rewindFiles — dryRun shows diffs; confirm reverts files
- **Phase 4:**
  - Keybindings — every documented action namespace mapped
  - Vim mode — INSERT/NORMAL transitions; j/k history; Space-right
  - Status line — JSON contract round-trips; refreshInterval honored
  - Plugins — install a fixture plugin, see its commands/agents/skills appear
  - Clipboard image paste — macOS + Linux + Windows
  - Right pane auto-open on subagent spawn

### 10.2 Cross-tool resume test

After Phase 1+2:
1. Start a chat in ADE desktop in lane `test-lane`.
2. Send some messages, edit a file.
3. Close ADE.
4. From terminal: `cd .ade/worktrees/test-lane && claude --resume`.
5. Expect: the session appears in the picker; resuming it yields the same conversation.

### 10.3 Test scoping

Per CLAUDE.md / project memory: **always shard test runs; suite is too large for single-process execution.** After focused changes, run only related test files — never the full suite unless asked.

Targeted test files for this initiative:
- `apps/desktop/src/main/services/chat/agentChatService.test.ts`
- `apps/desktop/src/renderer/components/chat/ChatSubagentsPanel.test.tsx`
- `apps/desktop/src/renderer/components/chat/AgentChatPane.handoff.test.tsx`
- `apps/desktop/src/renderer/components/settings/ProvidersSection.test.tsx`
- `apps/ade-cli/src/tuiClient/*.test.tsx`
- New: `apps/desktop/src/main/services/chat/claudeInputPump.test.ts`
- New: `apps/desktop/src/main/services/chat/claudeSubprocessReaper.test.ts`

---

## 11. Risk & rollback

### 11.1 Risks

- **Phase 1 is a hard cutover.** If a regression slips, the only path back is `git revert`. Mitigation: heavy local smoke before opening the PR; require a second engineer's review specifically of the input-pump and stream loop.
- **Cross-tool resume edge cases.** If session JSONL files end up under unexpected `cwd` encodings, `claude --resume` won't find them. Test on path with spaces, unicode, deep nesting.
- **Subprocess orphans on Electron crash.** The reaper handles this only if it had a chance to register PIDs. Add a scan-on-startup for orphan PIDs matching the claude-code binary path.
- **Project setting surprises.** A user may have stale Claude project settings in their lane. Surface parse or compatibility errors through `/doctor`.
- **Bundled binary version skew.** The bundled binary version is pinned to the SDK release (`claudeCodeVersion` in SDK package.json since 0.2.6). If a user's project has a `.claude/` config that requires a newer Claude Code feature, surface this in `/doctor`.
- **Subagent UI re-key (`taskId` → `agent_id`).** During the rewrite, old events may coexist with new ones. Solution: dual-key snapshots (both fields populated) for one release.
- **Handoff Fork inheriting too much.** A 200-message session forked yields a 200-message new session that costs full context on first turn. Mitigation: warn in the Fork tooltip; add a "Fork from message…" variant later if usage shows this matters.

### 11.2 Rollback

- **Phase 0:** revert the package.json bump.
- **Phase 1:** `git revert` the migration PR. Old `unstable_v2_*` paths are gone, so this is a real revert (not flag flip). Plan for a known-good tag before merging.
- **Phase 2+:** each subticket is independently revertable.

### 11.3 Telemetry

- Phase 0 ships a tag in OTEL spans: `claude_sdk.version=0.2.139`.
- Phase 1 ships a tag: `claude_sdk.api=v1_query` vs old `v2_session`.
- Track first-turn latency, time-to-first-token, time-to-result, tool-call counts. Compare before/after.

---

## 12. Open implementation questions

These don't block the plan; they get resolved during implementation review:

1. **Pump backpressure.** If the user sends three messages while the model is mid-turn, do we queue or reject? Today `unstable_v2_session.send` queues. We should match. Confirm shape of `Query.streamInput` re: queueing.
2. **Where do we render compact boundary events?** Existing UI inserts a divider; verify with the new system message type.
3. **`session_state_changed` events.** Opt-in via `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1` since 0.2.83. Useful for telemetry; do we enable?
4. **`title` option for the *very first* chat in a fresh lane.** Should ADE prepend something like `[ade-31] …` to make sessions identifiable in `claude --resume`? Or let SDK auto-generate cleanly?
5. **Effort default for new chats.** Today ADE picks per-identity. SDK 0.2.49 added `supportsEffort` per-model. If a model doesn't support effort, hide the picker for that model. Plumb this.
6. **`agentProgressSummaries` cache miss issue (CHANGELOG 0.2.128).** Verify post-migration we don't regress on cache hits for subagent progress.
7. **`AskUserQuestion.previewFormat`.** Today ADE sets `markdown` for non-lightweight sessions (`agentChatService.ts:11461`). Keep that.
8. **`includeHookEvents` option (CHANGELOG 0.2.89).** For diagnostics, useful to emit hook lifecycle messages. Off by default; surface via `/doctor`.
9. **Settings hot-reload after Phase 4.** Plugin install / settings.json edit → does `q.reloadPlugins()` plus `q.applyFlagSettings()` cover all reactive cases?
10. **Plan mode + `planFilePath`.** Today's UI shows the plan inline. If `planFilePath` is set, do we open the file in the editor? Show side-by-side?
11. **`/memory` UI in desktop chat.** Opens a memory pane vs opening the settings Memory section? Spec needed.
12. **`/init` interactive flow.** Walk the user through generating AGENTS.md vs auto-generate from repo content vs both? Spec needed.

---

## 13. Glossary

- **Agent SDK** — `@anthropic-ai/claude-agent-sdk`. The npm package ADE depends on.
- **Claude Code** — Anthropic's terminal CLI / IDE plugin / web product built on top of the SDK. The bundled binary in `node_modules` is the Claude Code binary, shipped as an optional dep per platform.
- **Lane** — ADE's concept: a git worktree under `.ade/worktrees/<name>/` plus its own chat sessions. Runtime-agnostic.
- **Subagent (in-session)** — spawned via the `Agent` tool inside one Claude Code session. Shares the process.
- **Background agent** — a full separate Claude Code session running in parallel on the same machine. Listed in `claude agents`.
- **Agent team** — a Team Lead session orchestrating Teammate sessions via SendMessage + shared mailbox under `~/.claude/tasks/<team-name>/`. Experimental (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`).
- **Skill** — a Markdown-defined capability under `.claude/skills/<name>/SKILL.md`. Model autonomously invokes when description matches request. Also user-invocable via `/<skill-name>`.
- **Plugin** — a directory with `.claude-plugin/plugin.json` bundling skills / commands / agents / hooks.
- **Output style** — a Markdown file under `.claude/output-styles/` that modifies the system prompt for tone / format.
- **Handoff (ADE-specific)** — explicit user action that spawns a new chat from the current one. Two flavors: Fork (Claude→Claude, full history) and Brief (any direction, 12-message summary).

---

## 14. Sign-off checklist (Codex: tick when done)

- [ ] Phase 0: SDK bump merged. No regressions.
- [ ] Phase 1: `unstable_v2_*` call sites removed. New `query()` pipeline live. Cross-tool resume working. Slash command reliability fixed.
- [ ] Phase 2.1–2.9: backend SDK adoptions shipped.
- [ ] Phase 3.1–3.6: UI refresh shipped.
- [ ] Phase 4.1–4.9: TUI parity shipped.
- [ ] Phase 5: cleanups merged.
- [ ] Testing: phase smoke checks all green. Cross-tool resume test passes.
- [ ] Telemetry: new tags emitting; latency before/after captured.
- [ ] Docs: README + ARCHITECTURE.md updated.
- [ ] Memory: project memory updated to reflect new architecture.
