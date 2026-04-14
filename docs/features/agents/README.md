# Agents

ADE does not ship a standalone "agents hub" page; instead, agent
behavior is delivered through three runtime surfaces: the **CTO**
(persistent identity inside the CTO tab), **worker agents** (named
employees with their own identity and adapters), and **regular chat
sessions** (ephemeral agents bound to a lane). This feature folder
documents the agent identity model, persona system, and the tool
registry / MCP integration that all three share.

## Source file map

| Path | Role |
|---|---|
| `apps/desktop/src/main/services/cto/ctoStateService.ts` | CTO identity, core memory, session logs, subordinate activity, immutable doctrine, personality overlays. The CTO's everything. |
| `apps/desktop/src/main/services/cto/workerAgentService.ts` | Worker identity and core memory CRUD. Persists `agent_identities` rows and `.ade/agents/<slug>/` files. |
| `apps/desktop/src/main/services/cto/workerAgentService.ts` (same file) | Also owns heartbeat, budget, and runtime policy hooks. |
| `apps/desktop/src/main/services/cto/workerHeartbeatService.ts` | Heartbeat scheduling for workers (wake-on-demand + periodic intervals). |
| `apps/desktop/src/main/services/cto/workerBudgetService.ts` | Monthly budget tracking (`budgetMonthlyCents`, `spentMonthlyCents`). |
| `apps/desktop/src/main/services/cto/flowPolicyService.ts` | Worker flow policies (guardrails, approval requirements). |
| `apps/desktop/src/main/services/cto/workerAgentService.ts` | Worker adapter configs: Claude-local, Codex-local, OpenClaw webhook, raw process. |
| `apps/desktop/src/main/services/ai/tools/ctoOperatorTools.ts` | CTO-only tools (spawnChat, mission control, worker management, Linear dispatch). |
| `apps/desktop/src/main/services/agentTools/agentToolsService.ts` | Detects external CLI tools (Claude Code, Codex, Cursor, Aider, Continue) on PATH. |
| `apps/desktop/src/main/adeMcpProxy.ts` / `adeMcpProxyUtils.ts` | Bundled stdio proxy forwarded to the in-process MCP server. Injects identity into the MCP `initialize` payload. |
| `apps/desktop/src/main/services/runtime/adeMcpLaunch.ts` | Resolves the MCP launch mode (bundled proxy, headless-built, headless-source) and builds the command + env. |
| `apps/mcp-server/src/mcpServer.ts` | Main-process MCP server: registers tools, handles JSON-RPC, applies session-identity-based tool filtering. |
| `apps/desktop/src/shared/ctoPersonalityPresets.ts` | CTO personality overlays (`strategic`, `professional`, `hands_on`, `casual`, `minimal`, `custom`). |
| `apps/desktop/src/shared/types/agents.ts` | `AgentIdentity`, `AgentCoreMemory`, `AgentRole`, `AdapterType`, adapter configs. |
| `apps/desktop/src/shared/types/cto.ts` | `CtoIdentity`, `CtoCoreMemory`, `CtoCapabilityMode`, `CtoPersonalityPreset`. |

## Three agent surfaces

### 1. CTO

One persistent identity per project. Carries a structured `CtoIdentity`
document (name, persona, personality preset, communication style,
constraints, model preferences, memory policy) and a small structured
`CtoCoreMemory` document (project summary, critical conventions, user
preferences, active focus, notes).

See [identity-and-personas](identity-and-personas.md) for the full
identity flow; see [tool-registration](tool-registration.md) for the
tool palette (universal + workflow + CTO operator + Linear, plus
`memoryUpdateCore`).

### 2. Workers (employees)

Zero-or-more named agent identities per project, stored as
`agent_identities` rows plus `.ade/agents/<slug>/*` files. Each worker
has its own role (`engineer`, `qa`, `designer`, `devops`, `researcher`,
`general`), adapter type, runtime policy, heartbeat schedule, budget,
and core memory.

Workers are activated either on-demand (chat session) or on a
scheduled heartbeat; when active they receive a memory briefing
assembled from project, agent, and mission memories.

### 3. Regular chat agents

Ephemeral sessions bound to a lane. No identity document, no persistent
core memory -- the session state lives in the chat transcript and
resumes across restarts but has no long-term persona. The CTO and
workers are just identity sessions layered on top of the same chat
runtime.

## Agent identity (CTO)

```ts
type CtoIdentity = {
  name: string;
  version: number;
  persona: string;                          // freeform persona text
  personality?: CtoPersonalityPreset;       // strategic | professional | hands_on | casual | minimal | custom
  customPersonality?: string;               // used when personality = "custom"
  communicationStyle?: {
    verbosity: "concise" | "detailed" | "adaptive";
    proactivity: "reactive" | "balanced" | "proactive";
    escalationThreshold: "low" | "medium" | "high";
  };
  constraints?: string[];
  systemPromptExtension?: string;
  externalMcpAccess?: ExternalMcpAccessPolicy;
  openclawContextPolicy?: OpenclawContextPolicy;
  onboardingState?: CtoOnboardingState;
  modelPreferences: {
    provider: string;
    model: string;
    modelId?: ModelId;
    reasoningEffort?: string | null;
  };
  memoryPolicy: {
    autoCompact: boolean;
    compactionThreshold: number;
    preCompactionFlush: boolean;
    temporalDecayHalfLifeDays: number;
  };
  updatedAt: string;
};
```

And the separate core memory document:

```ts
type CtoCoreMemory = {
  version: number;
  updatedAt: string;
  projectSummary: string;
  criticalConventions: string[];
  userPreferences: string[];
  activeFocus: string[];
  notes: string[];
};
```

Persisted in two places:

1. SQLite: `cto_identity_state` / `cto_core_memory_state` tables
   (one row per project; versioned, JSON payload).
2. Filesystem: `.ade/cto/identity.json` / `.ade/cto/core-memory.json`
   (written atomically via `writeTextAtomic`).

Reconciliation on startup prefers whichever has the higher `version`;
version-based reconciliation handles the case where the JSON file is
edited externally.

## Worker identity

```ts
type AgentIdentity = {
  id: string;
  name: string;
  slug: string;
  role: "cto" | "engineer" | "qa" | "designer" | "devops" | "researcher" | "general";
  title?: string;
  reportsTo: string | null;
  capabilities: string[];
  status: "idle" | "active" | "paused" | "running";
  adapterType: "claude-local" | "codex-local" | "openclaw-webhook" | "process";
  adapterConfig: AgentAdapterConfig;        // adapter-specific
  runtimeConfig: {
    heartbeat?: HeartbeatPolicy;
    maxConcurrentRuns?: number;
  };
  linearIdentity?: AgentLinearIdentity;     // optional Linear user mapping
  externalMcpAccess?: ExternalMcpAccessPolicy;
  personality?: string;
  communicationStyle?: string;
  constraints?: string[];
  systemPromptExtension?: string;
  budgetMonthlyCents: number;
  spentMonthlyCents: number;
  lastHeartbeatAt?: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
};

type AgentCoreMemory = {
  version: number;
  updatedAt: string;
  projectSummary: string;
  criticalConventions: string[];
  userPreferences: string[];
  activeFocus: string[];
  notes: string[];                          // same shape as CtoCoreMemory
};
```

Persisted at:

- SQLite: `agent_identities` table.
- Filesystem: `.ade/agents/<slug>/identity.json`,
  `.ade/agents/<slug>/core-memory.json`,
  `.ade/agents/<slug>/daily/<YYYY-MM-DD>.md` (daily logs),
  `.ade/agents/<slug>/MEMORY.md` (long-term brief, auto-generated).

## Adapter types

Workers dispatch through one of four adapter types:

| Adapter | Config | Purpose |
|---|---|---|
| `claude-local` | `ClaudeLocalAdapterConfig` (model, cwd, cliArgs, instructions, timeout) | Spawns `claude` CLI locally. |
| `codex-local` | `CodexLocalAdapterConfig` (model, cwd, cliArgs, reasoningEffort, timeout) | Spawns `codex` CLI locally. |
| `openclaw-webhook` | `OpenclawWebhookAdapterConfig` (URL, method, headers, bodyTemplate, timeout) | POSTs to an external service and waits for a response. |
| `process` | `ProcessAdapterConfig` (command, args, cwd, env, timeout, shell) | Generic subprocess. |

The worker service forwards the correct adapter config to the
orchestrator when the worker is activated.

## Capability modes

`CtoCapabilityMode` (also applies to workers via `capabilityMode` on
session logs):

- `full_mcp` -- the session connects to the ADE MCP server over the
  bundled stdio proxy and has full tool access.
- `fallback` -- MCP is unavailable (proxy failed to spawn, no socket,
  offline); the session gets only its adapter's built-in tool set.

`capabilityMode` is persisted per session log so history shows which
mode the agent actually ran in.

## Tool access tiers

Each agent type gets a distinct tool palette. The full breakdown is in
[tool-registration](tool-registration.md); summary:

| Tier | CTO | Worker | Regular chat | Coordinator |
|---|:-:|:-:|:-:|:-:|
| Universal (read, write, bash, memory, web, todo) | yes | yes | yes | yes |
| Workflow (createLane, createPR, captureScreenshot, reportCompletion, PR issue resolution) | yes | no | yes | no |
| CTO operator (spawnChat, missions, worker management, Linear) | yes | no | no | no |
| Coordinator (spawn_worker, skip_step, complete_mission, etc.) | no | no | no | yes |
| Linear tools | yes (when connected) | no | no | no |
| `memoryUpdateCore` | yes | yes | no | no |

Standalone chat sessions (sessions without mission/run/step/attempt
context) additionally get `spawn_agent` and all coordinator tools
hidden from both tool listing and tool execution, enforced at the MCP
server boundary. See [tool-registration](tool-registration.md#standalone-chat-restrictions).

## System prompt composition

All three surfaces use the same system-prompt builder
(`buildCodingAgentSystemPrompt` in
`apps/desktop/src/main/services/ai/tools/systemPrompt.ts`) with
different inputs:

- **CTO:** `systemPrompt.ts` output is prefixed by the
  `IMMUTABLE_CTO_DOCTRINE`, `CTO_MEMORY_OPERATING_MODEL`, and
  `CTO_ENVIRONMENT_KNOWLEDGE` blocks from `ctoStateService.ts`, plus
  the active personality overlay and user-defined persona /
  `systemPromptExtension`.
- **Worker:** similar structure, but with `AgentCoreMemory` reconstructed
  into the context and the worker's persona + constraints + system
  prompt extension.
- **Regular chat:** no identity prefix; just lane context, memory
  tools guidance, workflow tools guidance, and permission-mode
  framing.

The prompt branches on which tool names are present (see [Chat Tool
System](../chat/tool-system.md#system-prompt-composition)) so renaming
a tool silently changes the prompt.

## Heartbeat and activation

`workerHeartbeatService.ts` schedules worker activations:

- `HeartbeatPolicy.enabled` gates scheduling entirely.
- `intervalSec` controls periodic wake-up.
- `wakeOnDemand` allows the CTO or Linear dispatcher to activate the
  worker outside the schedule.
- `activeHours` restricts heartbeats to a time window (with timezone).

When a worker activates, the runtime:

1. Assembles a memory briefing (`memoryBriefingService.ts`).
2. Resolves the adapter config.
3. Dispatches through the orchestrator or spawns a chat session (via
   the CTO's `spawnChat` tool) depending on the activation kind.
4. Records a `worker_agents` runtime row and an `AgentSessionLogEntry`.

## Session logs

Both CTO and workers maintain append-only session logs:

- CTO: `cto_session_logs` table.
- Workers: `worker_agent_runs` (runtime rows) and session log entries
  persisted under `.ade/agents/<slug>/`.

Each entry carries: session id, summary, started/ended timestamps,
provider, model id, capability mode, and a previous-hash pointer
(`prevHash`) so integrity of the log can be verified. The log integrity
service (`projects/logIntegrityService.ts`) computes and verifies these
hashes.

## Subordinate activity feed

CTO sessions include a `CtoSubordinateActivityEntry` feed surfaced in
the CTO surface. Entries record chat turns and worker runs with:

- `agentId`, `agentName`
- `activityType`: `chat_turn` or `worker_run`
- `summary`, `sessionId`, `taskKey`, `issueKey`

This feed is the CTO's awareness of what workers have been doing; the
CTO can proactively check it at the start of each session via the
`Daily Context` protocol.

## Daily logs

The CTO writes append-only daily logs at
`.ade/cto/daily/<YYYY-MM-DD>.md`. Workers have their own at
`.ade/agents/<slug>/daily/<YYYY-MM-DD>.md`. Daily logs are included in
the continuity context for the current day, providing within-day
session-to-session continuity without the full history weight.

## IPC surface

Defined in `apps/desktop/src/shared/ipc.ts` (search `ade.cto.*` and
`ade.workers.*`). Handlers in `registerIpc.ts`.

Representative channels:

| Channel | Purpose |
|---|---|
| `ade.cto.getState` | Fetch `CtoSnapshot` (identity + core memory + recent sessions + subordinate activity). |
| `ade.cto.updateIdentity` | Patch identity fields. |
| `ade.cto.updateCoreMemory` | Patch core memory fields. |
| `ade.cto.ensureSession` | Create or fetch the CTO's persistent chat session. |
| `ade.cto.appendSessionLog` | Append to the session log (internal; called by agentChatService on completion). |
| `ade.cto.getSystemPromptPreview` | Generate a preview of the CTO's system prompt for the UI. |
| `ade.workers.list` | List worker identities. |
| `ade.workers.upsert` | Create or update a worker. |
| `ade.workers.remove` | Soft-delete a worker. |
| `ade.workers.getCoreMemory` | Fetch a worker's core memory. |
| `ade.workers.updateCoreMemory` | Patch a worker's core memory. |
| `ade.workers.triggerWakeup` | Force a worker heartbeat. |
| `ade.workers.heartbeatStatus` | Current heartbeat schedule + last fire. |
| `ade.workers.getBudget` | Monthly budget + spend. |

## Fragile and tricky wiring

- **Core memory version reconciliation.** On startup,
  `reconcileCoreMemoryOnStartup()` compares the SQLite `version` to the
  filesystem `version` and picks the newer. Concurrent edits (user
  editing the JSON file while ADE is running) can create version
  inversions; the reconciler writes the loser back to sync but loses
  the other side's changes. Always edit through the UI or the
  `updateCoreMemory` IPC when possible.
- **Post-compaction identity re-injection.** CTO and worker identity
  sessions re-inject `buildReconstructionContext()` after chat context
  compaction; missing this path loses the persona mid-session. The
  wiring lives in `agentChatService.ts` and relies on an explicit
  `refreshReconstructionContext()` call from the compaction handler.
- **Subordinate activity ordering.** `appendCtoSubordinateActivity`
  prepends to the feed and caps at N entries. Rapid concurrent writes
  can race; writes go through `ctoStateService` which serialises via
  the db layer.
- **Personality preset lookup.** `getCtoPersonalityPreset()` falls back
  to the first preset (`strategic`) on unknown input. Removing or
  renaming a preset id would silently remap existing CTO identities
  to the default. Keep preset ids stable.
- **Worker slug uniqueness.** `slugify(input)` can collide; the service
  guarantees uniqueness by appending `-2`, `-3`, etc. when the slug
  already exists. Renaming a worker does not move its filesystem
  directory.
- **Adapter config secret policy.** `assertEnvRefSecretPolicy` rejects
  raw secrets embedded in adapter configs, forcing `${env:VAR_NAME}`
  references. Bypassing this check (e.g., via direct SQL writes)
  allows secrets to leak into transcripts.
- **Daily log integrity hashes.** Each session log entry carries
  `prevHash` linking back to the previous entry. Manually deleting a
  row from the table breaks the chain; `logIntegrityService` will
  detect the break on next verification but won't rebuild the chain.
- **Adapter type ↔ capability mode.** `claude-local` and `codex-local`
  can run in `full_mcp` mode only when the MCP socket server is
  running; if the socket fails, workers silently fall back to
  `fallback` mode. Surface this via capability mode in the session
  log entry.
- **Standalone-chat tool filtering at MCP boundary.** The filter is
  applied in `apps/mcp-server/src/mcpServer.ts` based on the
  `initialize` payload's identity. A client that omits identity
  falls back to `external` role with minimal tool access; a client
  that forges a mission id could theoretically get elevated access,
  so the socket is local-only and the proxy cannot be externally
  reached.

## Detail docs

- [Identity and Personas](identity-and-personas.md) -- how CTO and
  worker identity is stored, reconciled, and injected into sessions,
  including the personality preset system and immutable doctrine.
- [Tool Registration](tool-registration.md) -- MCP integration,
  bundled proxy, tool registry, role-based filtering, capability
  mode fallback.

## Related docs

- [Chat README](../chat/README.md) -- session lifecycle, identity
  session filtering.
- [Chat Agent Routing](../chat/agent-routing.md) -- provider and
  model selection for agents.
- [Memory README](../memory/README.md) -- memory briefing, core
  memory, and scope rules.
- [Chat Tool System](../chat/tool-system.md) -- details of universal,
  workflow, and coordinator tiers.
</content>
</invoke>