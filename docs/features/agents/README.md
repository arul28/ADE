# Agents

ADE does not ship a standalone agents hub page. Agent behavior is delivered through two runtime surfaces: the CTO and regular lane-bound chat sessions. This feature folder documents identity, persona overlays, capability modes, the smart-memory system, and the ADE CLI tool bridge those surfaces share.

The former worker/hiring agents were removed. There is one persistent identity — the CTO — and everything else is an ephemeral lane-bound chat session.

## Source file map

| Path | Role |
|---|---|
| `apps/desktop/src/main/services/cto/ctoStateService.ts` | CTO identity, session logs, daily/onboarding state, immutable doctrine, personality overlays, and system-prompt preview. |
| `apps/desktop/src/main/services/cto/ctoMemoryService.ts` | The CTO's smart-memory file store (`MEMORY.md`, `thread-state.md`, daily logs, search, injection sections). |
| `apps/desktop/src/main/services/ai/tools/ctoOperatorTools.ts` | CTO operator tools for chat spawning, lanes/PRs/git/tests, Linear reads/writes, and the `saveMemory` / `searchMemory` / `readMemory` memory tools. |
| `apps/desktop/src/main/services/agentTools/agentToolsService.ts` | Detects external CLI tools on PATH. |
| `apps/ade-cli/src/cli.ts` | Agent-focused `ade` command surface and text/JSON output formatters. Includes the `ade ios-sim` (alias `ade ios`, `ade simulator`) family — see [iOS Simulator feature](../ios-simulator/README.md), the `ade --socket app-control ...` driver for live Electron apps, and the `ade --socket browser ...` driver for the in-app browser. `ade secrets list|get|set|delete` is the typed surface for encrypted project-scoped ADE secrets that agents may read when the user names a secret. `ade new chat --mode chat|cli --lane <lane|auto> --provider codex --model <id> --reasoning-effort <tier> --no-fast --permissions full-auto --prompt "..."` mirrors the desktop New Chat toggle. `ade chat create` / `ade new --mode chat` default `orchestrationParentSessionId` from `ADE_CHAT_SESSION_ID` so agent-spawned chats link back to the spawning chat (`--parent <sessionId>` overrides, `--no-parent` opts out). `ade chat read <session> --text` reads recent transcript messages. `ade lanes link-linear-issue <laneId> --linear-issue-json '{...}'` (aliases `link-linear`, `linear-link`) links Linear issues to an existing lane. |
| `apps/ade-cli/src/adeRpcServer.ts` | Private ADE action RPC: registers actions, handles JSON-RPC, applies session-identity-based filtering, builds lane-scoped ADE guidance / `ADE_AGENT_SKILLS_DIRS` for CLI launches, and returns GitHub + ADE PR URLs from PR creation tools when available. |
| `apps/desktop/resources/agent-skills/ade-cli-control-plane/SKILL.md` | Agent-facing ADE CLI control-plane guidance. |
| `apps/desktop/resources/agent-skills/ade-mosaic/SKILL.md` | Agent-facing schema for Mosaic v1 interactive cards: an agent emits a fenced ` ```mosaic ` JSON block to ask the user for structured input (select / multiselect / number / input / approval / table) and the submitted answers return as the next user message. Discovered on demand rather than named in the `adeBundledAgentSkills` bootstrap list; parsing/rendering live in `apps/desktop/src/shared/chatMosaic.ts` (see [chat composer-and-ui.md](../chat/composer-and-ui.md)). |
| `apps/desktop/src/main/services/cli/adeCliService.ts` | Desktop-side install / status / uninstall surface for the `ade` launcher. |
| `apps/desktop/src/shared/adeCliGuidance.ts` | Canonical agent-prompt guidance builder for finding and using `ade`, reading Agent Skills on demand, using socket-backed live surfaces, registering proof, and cleaning up processes. Injected into Work chats, CLI launches, ADE Code/TUI sessions, the CTO, and mobile-started runtime work. |
| `apps/desktop/src/shared/agentSkillRoots.ts` | Resolves and formats Agent Skill roots injected into prompts and CLI environments. |
| `apps/desktop/src/shared/ctoPersonalityPresets.ts` | CTO personality overlays. |
| `apps/desktop/src/shared/types/cto.ts` | CTO identity, capability mode, personality, onboarding, memory, and prompt-preview types. |

## Agent surfaces

### CTO

One persistent project-level identity. The CTO carries a structured `CtoIdentity` document (name, persona, personality preset, communication style, constraints, model preferences, onboarding state, optional prompt extension) plus a smart-memory system that survives sessions, compaction, and model switches. See [CTO](../cto/README.md) and [Identity and Personas](identity-and-personas.md).

### Regular chat agents

Ephemeral sessions bound to a lane. They have no persistent identity document; the session state lives in the transcript and resumes across restarts.

## Agent CLI install / auth from chat

When a chat targets a provider whose CLI is missing or unauthenticated on the active runtime, the chat surfaces an inline `AgentCliAuthCard`. The card is built by `classifyAgentCliError` from `apps/ade-cli/src/services/agentRegistry.ts` and gives the user a tracked terminal action for install or login.

The important invariant is runtime locality: a desktop window bound to a remote `ade serve` daemon launches the install/auth command on that remote machine, not locally.

## Identity shape

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
```

## Capability modes

`CtoCapabilityMode` is persisted per CTO session log:

- `full_tooling` — the session connected to the ADE CLI/action bridge.
- `fallback` — the bridge was unavailable and the adapter used its own built-in tool set.

## Tool access tiers

| Tier | CTO | Regular chat |
|---|:-:|:-:|
| Universal (read, write, bash, web, todo) | yes | yes |
| Workflow (createLane, createPR, captureScreenshot, reportCompletion, PR issue resolution) | yes | yes |
| CTO operator (spawnChat, lanes/PRs/git/tests, memory tools) | yes | no |
| Linear tools | yes (when connected) | no |

Standalone chat sessions connected through the ADE CLI have elevated tools hidden from tool listing and execution at the ADE CLI server boundary.

## Prompt composition

Both surfaces use `buildCodingAgentSystemPrompt` with different identity/context prefixes:

- **CTO:** immutable CTO doctrine, active personality overlay, persona, continuity model, memory-system guidance, environment knowledge, recent session context, injected durable memory, and the user-defined prompt extension.
- **Regular chat:** lane context, workflow tool guidance, and permission-mode framing.

## Smart memory and reconstruction

The CTO's durable memory lives in files under `.ade/cto/` (`MEMORY.md`, `thread-state.md`, `daily/<date>.md`) owned by `ctoMemoryService`. A deterministic flush writes the rolling summary before compaction and before model switches; a best-effort LLM upgrade refines it. `refreshReconstructionContext()` re-injects identity plus memory after compaction and switches. Full details in [Identity and Personas](identity-and-personas.md#smart-memory-system).

## Session logs

The CTO maintains an append-only session log. Each entry carries session id, summary, started/ended timestamps, provider, model id, capability mode, and a previous-hash pointer (`prevHash`) so `logIntegrityService.ts` can verify the chain.

## IPC surface

Representative channels:

| Channel | Purpose |
|---|---|
| `ade.cto.getState` | Fetch CTO identity and recent sessions. |
| `ade.cto.updateIdentity` | Patch identity fields. |
| `ade.cto.ensureSession` | Create or fetch the CTO's persistent chat session. |
| `ade.cto.listSessionLogs` | Read the CTO session log. |
| `ade.cto.previewSystemPrompt` | Generate a system-prompt preview for the UI. |
| `ade.cto.getMemory` / `updateMemory` / `searchMemory` | Read, rewrite, and search durable memory. |

## Fragile and tricky wiring

- **Post-compaction identity re-injection.** The CTO identity session calls `refreshReconstructionContext()` after chat context compaction. Missing this path loses the persona and durable memory mid-session.
- **Personality preset lookup.** `getCtoPersonalityPreset()` falls back to `strategic` on unknown input. Keep preset ids stable.
- **Deterministic memory flush is the guarantee.** The LLM summary upgrade is best-effort; the durable write must never depend on it.
- **Daily log integrity hashes.** Session log entries carry `prevHash`; manual row deletion breaks the chain and is detected by `logIntegrityService`.
- **Standalone-chat tool filtering at ADE CLI boundary.** Filtering is applied in `apps/ade-cli/src/adeRpcServer.ts` from the initialize payload's identity.

## Detail docs

- [Identity and Personas](identity-and-personas.md) — identity storage, reconstruction, personality presets, immutable doctrine, and the memory system.
- [Tool Registration](tool-registration.md) — ADE CLI integration, action registration, role-based filtering, and capability fallback.

## Related docs

- [CTO](../cto/README.md) — the CTO thread and settings surface.
- [Chat README](../chat/README.md) — session lifecycle and identity session filtering.
- [Chat Agent Routing](../chat/agent-routing.md) — provider and model selection for agents.
- [Chat Tool System](../chat/tool-system.md) — universal, workflow, and coordinator tool details.
