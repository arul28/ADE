# Agents

ADE does not ship a standalone agents hub page. Agent behavior is
delivered through three runtime surfaces: the CTO, worker agents, and
regular lane-bound chat sessions. This feature folder documents identity,
persona overlays, capability modes, and the ADE CLI tool bridge shared by
those surfaces.

## Source file map

| Path | Role |
|---|---|
| `apps/desktop/src/main/services/cto/ctoStateService.ts` | CTO identity, session logs, subordinate activity, daily logs, immutable doctrine, personality overlays, and system-prompt preview. |
| `apps/desktop/src/main/services/cto/workerAgentService.ts` | Worker identity CRUD, adapter config validation, slug generation, secret policy enforcement, revisions, session context, and `.ade/agents/<slug>/` files. |
| `apps/desktop/src/main/services/cto/workerHeartbeatService.ts` | Heartbeat scheduling for workers. |
| `apps/desktop/src/main/services/cto/workerBudgetService.ts` | Monthly budget tracking. |
| `apps/desktop/src/main/services/cto/flowPolicyService.ts` | Worker flow policies. |
| `apps/desktop/src/main/services/cto/workerAdapterRuntimeService.ts` | Adapter lifecycle for supported worker adapter types. |
| `apps/desktop/src/main/services/ai/tools/ctoOperatorTools.ts` | CTO-only tools for chat spawning, worker management, and Linear dispatch. |
| `apps/desktop/src/main/services/agentTools/agentToolsService.ts` | Detects external CLI tools on PATH. |
| `apps/ade-cli/src/cli.ts` | Agent-focused `ade` command surface and text/JSON output formatters. Includes the `ade ios-sim` (alias `ade ios`, `ade simulator`) family — see [iOS Simulator feature](../ios-simulator/README.md), the `ade --socket app-control ...` driver for live Electron apps, and the `ade --socket browser ...` driver for the in-app browser. The browser CLI covers tabs/navigation (`browser panel`, `open`, `new-tab`, `switch`, `close`), agent sessions (`browser session start`, `browser sessions`, `browser session <action> <id>`, `--browser-session <id>`), hidden-tab observations/actions (`observe --map`, `click/fill/clear-field/press/wait --handle`, `trace`, `proof`), and selection / inspect commands. `ade secrets list|get|set|delete` is the typed surface for encrypted project-scoped ADE secrets that agents may read when the user names a secret. `ade chat create --provider codex --model <id> --reasoning-effort <tier> --no-fast --permissions full-auto` starts a persistent Work chat with explicit provider settings; `--print-config`/`--dry-run` prints the resolved create payload and provider permission mapping without launching. `ade agent spawn` remains the legacy lane-scoped CLI-session launcher for Codex/Claude and deliberately rejects reasoning-effort flags; use `ade chat create` or `ade shell start-cli ... --reasoning-effort <tier>` when a launch must pin reasoning. `ade shell start --lane <id> --chat-session <chatId>` (or `ADE_CHAT_SESSION_ID` from the env) attaches a tracked shell to an existing chat so `ade --socket terminal read --chat-session "$ADE_CHAT_SESSION_ID" --text` resolves to it. `ade lanes link-linear-issue <laneId> --linear-issue-json '{...}'` (aliases `link-linear`, `linear-link`) links one or more Linear issues to an existing lane with optional `--role`, `--source`, `--include-in-pr`/`--no-include-in-pr`, and `--close-on-merge` flags. |
| `apps/ade-cli/src/adeRpcServer.ts` | Private ADE action RPC: registers actions, handles JSON-RPC, applies session-identity-based filtering, builds lane-scoped ADE guidance / `ADE_AGENT_SKILLS_DIRS` for worker CLI launches, and returns GitHub + ADE PR URLs from PR creation tools when available. |
| `apps/desktop/src/main/services/cli/adeCliService.ts` | Desktop-side install / status / uninstall surface for the `ade` launcher. Owns the install-target path resolution and the optional shell-rc PATH append. |
| `apps/desktop/src/shared/adeCliGuidance.ts` | Canonical agent-prompt guidance builder for finding and using `ade`, reading Agent Skills on demand, naming the bundled ADE skills, using socket-backed live surfaces, registering proof, and cleaning up started processes. Injected into Work chats, CLI launches, ADE Code/TUI sessions, CTO/worker agents, and mobile-started runtime work. |
| `apps/desktop/src/shared/agentSkillRoots.ts` | Resolves and formats Agent Skill roots injected into prompts and CLI environments: lane/current-working-directory ancestors, user homes, inherited `ADE_AGENT_SKILLS_DIRS`, packaged ADE resources, and source fallbacks across `.cursor`, `.claude`, `.agents`, `.ade`, and `.codex` skill directories. |
| `apps/desktop/src/shared/ctoPersonalityPresets.ts` | CTO personality overlays. |
| `apps/desktop/src/shared/types/agents.ts` | Worker identity, role, adapter, and runtime types. |
| `apps/desktop/src/shared/types/cto.ts` | CTO identity, capability mode, personality, onboarding, and prompt-preview types. |

## Agent surfaces

### CTO

One persistent project-level identity. The CTO carries a structured
`CtoIdentity` document: name, persona, personality preset, communication
style, constraints, model preferences, onboarding state, and optional
system-prompt extension.

### Workers

Zero-or-more named agent identities per project, stored as
`agent_identities` rows plus `.ade/agents/<slug>/` files. Each worker has
a role (`engineer`, `qa`, `designer`, `devops`, `researcher`, `general`),
adapter type, runtime policy, heartbeat schedule, budget, Linear mapping,
and optional persona fields.

### Regular chat agents

Ephemeral sessions bound to a lane. They have no persistent identity
document; the session state lives in the transcript and resumes across
restarts.

## Agent CLI install / auth from chat

When a chat targets a provider whose CLI is missing or unauthenticated on
the active runtime, the chat surfaces an inline `AgentCliAuthCard`. The
card is built by `classifyAgentCliError` from
`apps/ade-cli/src/services/agentRegistry.ts` and gives the user a
tracked terminal action for install or login.

The important invariant is runtime locality: a desktop window bound to a
remote `ade serve` daemon launches the install/auth command on that
remote machine, not locally.

## Identity shapes

```ts
type CtoIdentity = {
  name: string;
  version: number;
  persona: string;
  personality?: CtoPersonalityPreset;
  customPersonality?: string;
  communicationStyle?: CtoCommunicationStyle;
  constraints?: string[];
  systemPromptExtension?: string;
  onboardingState?: CtoOnboardingState;
  modelPreferences: CtoModelPreferences;
  updatedAt: string;
};

type AgentIdentity = {
  id: string;
  name: string;
  slug: string;
  role: AgentRole;
  title?: string;
  reportsTo: string | null;
  capabilities: string[];
  status: AgentStatus;
  adapterType: AdapterType;
  adapterConfig: AgentAdapterConfig;
  runtimeConfig: AgentRuntimeConfig;
  linearIdentity?: AgentLinearIdentity;
  personality?: string;
  communicationStyle?: string;
  constraints?: string[];
  systemPromptExtension?: string;
  budgetMonthlyCents: number;
  spentMonthlyCents: number;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
};
```

## Adapter types

Workers dispatch through one of three adapter types. The type definition
is exactly `"claude-local" | "codex-local" | "process"`.

| Adapter | Purpose |
|---|---|
| `claude-local` | Spawns `claude` locally. |
| `codex-local` | Spawns `codex` locally. |
| `process` | Generic managed subprocess wrapper. |

## Capability modes

`CtoCapabilityMode` is persisted per identity session log:

- `full_tooling` — the session connected to the ADE CLI/action bridge.
- `fallback` — the bridge was unavailable and the adapter used its own
  built-in tool set.

## Tool access tiers

| Tier | CTO | Worker | Regular chat |
|---|:-:|:-:|:-:|
| Universal (read, write, bash, web, todo) | yes | yes | yes |
| Workflow (createLane, createPR, captureScreenshot, reportCompletion, PR issue resolution) | yes | no | yes |
| CTO operator (spawnChat, worker management, Linear) | yes | no | no |
| Linear tools | yes (when connected) | no | no |

Standalone chat sessions connected through ADE CLI with no
worker context have elevated tools hidden from tool listing and
execution at the ADE CLI server boundary.

## Prompt composition

All three surfaces use `buildCodingAgentSystemPrompt` with different
identity/context prefixes:

- **CTO:** immutable CTO doctrine, active personality overlay, persona,
  environment knowledge, recent session context, subordinate activity,
  and user-defined prompt extension.
- **Worker:** worker identity, role, adapter/runtime constraints, recent
  worker session context, and user-defined prompt extension.
- **Regular chat:** lane context, workflow tool guidance, and
  permission-mode framing.

## Heartbeat and activation

`workerHeartbeatService.ts` schedules worker activations. The runtime
resolves the worker identity, adapter config, and current lane/project
context, then spawns a chat session via the CTO's `spawnChat` tool or
the worker adapter runtime.

## Session logs

CTO and workers maintain append-only session logs. Each entry carries
session id, summary, started/ended timestamps, provider, model id,
capability mode, and a previous-hash pointer (`prevHash`) so
`logIntegrityService.ts` can verify the chain.

## Subordinate activity feed

CTO sessions include a `CtoSubordinateActivityEntry` feed surfaced in
the CTO UI. Entries record worker chat turns and worker runs with the
agent id/name, activity type, summary, session id, task key, and issue
key.

## Daily logs

The CTO writes append-only daily logs at `.ade/cto/daily/<YYYY-MM-DD>.md`.
Workers have their own daily logs under `.ade/agents/<slug>/daily/`.
These files provide within-day session continuity without loading full
transcripts.

## IPC surface

Representative channels:

| Channel | Purpose |
|---|---|
| `ade.cto.getState` | Fetch CTO identity, recent sessions, and subordinate activity. |
| `ade.cto.updateIdentity` | Patch identity fields. |
| `ade.cto.ensureSession` | Create or fetch the CTO's persistent chat session. |
| `ade.cto.appendSessionLog` | Append to the CTO session log. |
| `ade.cto.getSystemPromptPreview` | Generate a preview for the UI. |
| `ade.workers.list` | List worker identities. |
| `ade.workers.upsert` | Create or update a worker. |
| `ade.workers.remove` | Soft-delete a worker. |
| `ade.workers.triggerWakeup` | Force a worker heartbeat. |
| `ade.workers.heartbeatStatus` | Current heartbeat schedule and last fire. |
| `ade.workers.getBudget` | Monthly budget and spend. |

## Fragile and tricky wiring

- **Post-compaction identity re-injection.** CTO and worker identity
  sessions call `refreshReconstructionContext()` after chat context
  compaction. Missing this path loses the persona mid-session.
- **Subordinate activity ordering.** `appendCtoSubordinateActivity`
  prepends to the feed and caps at N entries. Writes go through
  `ctoStateService`, but callers should still sort by `createdAt` when
  strict chronology matters.
- **Personality preset lookup.** `getCtoPersonalityPreset()` falls back
  to the first preset (`strategic`) on unknown input. Keep preset ids
  stable.
- **Worker slug uniqueness.** `slugify(input)` can collide; the service
  appends `-2`, `-3`, etc. when needed. Renaming a worker does not move
  its filesystem directory.
- **Adapter config secret policy.** `assertEnvRefSecretPolicy` rejects
  raw secrets embedded in adapter configs, forcing `${env:VAR_NAME}`
  references.
- **Daily log integrity hashes.** Session log entries carry `prevHash`.
  Manual row deletion breaks the chain and is detected by
  `logIntegrityService`.
- **Standalone-chat tool filtering at ADE CLI boundary.** Filtering is
  applied in `apps/ade-cli/src/adeRpcServer.ts` from the initialize
  payload's identity.

## Detail docs

- [Identity and Personas](identity-and-personas.md) -- identity storage,
  reconstruction, personality presets, and immutable doctrine.
- [Tool Registration](tool-registration.md) -- ADE CLI integration,
  action registration, role-based filtering, and capability fallback.

## Related docs

- [Chat README](../chat/README.md) -- session lifecycle and identity
  session filtering.
- [Chat Agent Routing](../chat/agent-routing.md) -- provider and model
  selection for agents.
- [Chat Tool System](../chat/tool-system.md) -- universal, workflow, and
  coordinator tool details.
