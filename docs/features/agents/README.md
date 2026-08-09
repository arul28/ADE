# Agents

ADE does not ship a standalone agents hub page. Agent behavior is delivered through three runtime surfaces: the CTO, regular lane-bound chat sessions, and machine-owned personal chats. This feature folder documents identity, persona overlays, capability modes, the smart-memory system, and the ADE CLI tool bridge the project surfaces share.

The former worker/hiring agents were removed. There is one persistent identity — the CTO — and everything else is an ephemeral chat session. Regular sessions bind a visible lane; personal sessions use an internal compatibility lane that is never exposed as project context.

## Source file map

| Path | Role |
|---|---|
| `apps/desktop/src/main/services/cto/ctoStateService.ts` | CTO identity, session logs, daily/onboarding state, immutable doctrine, personality overlays, and system-prompt preview. |
| `apps/desktop/src/main/services/cto/ctoMemoryService.ts` | The CTO's smart-memory file store (`MEMORY.md`, `thread-state.md`, daily logs, search, injection sections). |
| `apps/desktop/src/main/services/ai/tools/ctoOperatorTools.ts` | CTO operator tools for chat spawning, lanes/PRs/git/tests, Linear reads/writes, and the `saveMemory` / `searchMemory` / `readMemory` memory tools. |
| `apps/desktop/src/main/services/agentTools/agentToolsService.ts` | Detects external CLI tools on PATH. |
| `apps/desktop/src/main/services/ai/piInstallation.ts` | Resolves the user's Pi installation — CLI path, SDK package root/entry, agent dir, `auth.json` / models / settings paths, provider inventory, and a `blocker` when the SDK path is unusable. `sdkAvailable` and `cliAvailable` are independent signals. |
| `apps/desktop/src/main/services/ai/piAuthService.ts` | In-app Pi sign-in: enumerates signable providers, drives Pi's own `ModelRuntime.login` on a dedicated inventory-only worker, and relays Pi's prompts and notices to whatever surface is listening. Relays credentials, never stores or logs them. |
| `apps/ade-cli/src/cli.ts` | Agent-focused `ade` command surface and text/JSON output formatters. `ade new chat --mode chat|cli ... --type <subagent|peer>` mirrors the desktop New Chat toggle; parented agent sessions inherit `ADE_CHAT_SESSION_ID` and must choose a type, while `--no-parent` creates an independent top-level session. `ade chat read <session> --limit <n> --max-chars <n>` silently reads a bounded project-backed transcript window across registered projects, and `--page --cursor <offset>` walks older content. Personal chats remain on `ade chat ... --personal`. The file also owns typed Work status, scheduled work, Linear attachment, secrets, iOS Simulator, App Control, and browser command families. |
| `apps/ade-cli/src/services/account/accountAuthService.ts` | Optional ADE account auth for humans, remote agents, and CI: loopback OAuth, account-directory device authorization, shared `account.session.v1` refresh storage, JWT-`exp`-authoritative access-token refresh, one cross-process refresh-rotation recovery attempt after `invalid_grant`, and ephemeral `ADE_ACCOUNT_TOKEN` credentials. |
| `apps/ade-cli/src/adeRpcServer.ts`, `apps/ade-cli/src/multiProjectRpcServer.ts`, `apps/ade-cli/src/runtimeRoles.ts` | Private ADE action RPC, caller-role boundary, and multi-project routing. `start_cli_session` requires `subagent` or `peer` whenever it records parent lineage. The RPC edge derives trusted parent→child turn provenance for `chat.messageSession`, strips spoofed provenance, keeps writes/history/lifecycle scoped, and permits bounded transcript reads from project-backed chats. The machine router locates the owning registered project for a chat id and aggregates foreign-project chat search while excluding personal chats. |
| `apps/desktop/src/main/services/builtInBrowser/builtInBrowserActorCapabilities.ts`, `desktopBridgeServer.ts`; `apps/ade-cli/src/services/builtInBrowser/desktopBridgeClient.ts` | Browser-automation security boundary. ADE issues an opaque in-memory capability for each chat-owned agent/terminal; the runtime strips caller routing and carries the token over a separately authenticated bridge, then Electron validates it in the issuing process and restores only its bound browser scope. |
| `apps/desktop/src/main/utils/codexComputerUse.ts` | Security boundary for direct Codex Computer Use: explicit config opt-in, stable/cache candidate resolution, executable check, and strict OpenAI code-signature identity verification. |
| `apps/desktop/resources/agent-skills/ade-cli-control-plane/SKILL.md` | Agent-facing ADE CLI control-plane guidance. |
| `apps/desktop/src/main/services/ai/tools/systemPrompt.ts` | Provider-runtime prompt assembly, including one shared timezone-safe scheduled-work contract for Claude, Codex, Cursor, Droid, and OpenCode. |
| `apps/desktop/resources/agent-skills/ade-mosaic/SKILL.md` | Agent-facing schema for Mosaic v1 interactive cards: an agent emits a fenced ` ```mosaic ` JSON block to ask the user for structured input (select / multiselect / number / input / approval / table) and the submitted answers return as the next user message. Parsing/rendering live in `apps/desktop/src/shared/chatMosaic.ts` (see [chat composer-and-ui.md](../chat/composer-and-ui.md)). |
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
New Codex agents default to GPT-5.6 Sol, with Terra and Luna immediately below
it and GPT-5.5 retained. Provider-native web, MCP/connector, image, and
subagent activity is normalized into compact transcript events so every client
can show what the agent did without dumping raw SDK/app-server envelopes.

Claude SDK session-message snapshots include `parent_agent_id`. ADE preserves
it as `parentAgentId` on subagent snapshots so desktop surfaces can build the
real nested hierarchy; `null` or absent means a depth-one child of the main
session. Live frames remain defensive because not every SDK start event carries
the parent id.

The `ade --socket browser ...` driver is available only to an ADE-launched,
chat-bound agent or owned terminal. Its opaque browser actor capability binds
the call to that chat's lane/project or personal tab collection. The runtime
rejects missing capabilities and strips forged routing; Electron validates the
opaque token in its issuing process before restoring the bound scope. Neither
path exposes renderer-only profile diagnostics or permission administration.

Every regular chat runtime can schedule its own durable future work through
`ade chat scheduled-work create` or
`ade actions run chat.createScheduledWork`. The schedule is ADE-owned rather
than provider-owned, so Codex, Cursor, Droid, OpenCode, and Claude all use the
same runtime scheduler and `messageSession(kind: "wake")` delivery path. Their
shared runtime prompt and bundled CLI skill prefer a relative one-shot for
"wake in N" intent, require an explicit offset for absolute time, identify cron
as brain-machine-local, and tell the agent to verify the returned local and ISO
next-run values before ending the turn.

Regular chat and tracked CLI agents can also narrate their lifecycle directly
into the Work list:

- `ade chat note "testing desktop auth fallback"` updates the row's quiet
  status line, trimmed to at most 72 characters (agents aim for 6 words or fewer);
  an empty note clears it.
- `ade chat ask "Which account should I use?"` creates a loud, persisted
  `Needs you` state, clears settle, and sends a time-sensitive push. The next
  user turn clears the ask.
- `ade session snooze <id> --for 1h` quiets a row the agent is waiting on
  without claiming the work is done; a hand-raise wakes it early.

Agents deliberately **cannot settle**. `ade chat settle`, `ade chat unsettle`,
`ade session settle`, and `ade session unsettle` were removed in 2026-07:
whether work is actually finished is a subjective judgment agents are
unreliable at, and a chat that settles itself disappears from the user's active
list on the agent's say-so. Invoking a removed command exits 2 with a message
naming the two remaining paths — the user settling the row in ADE, and the
deterministic `autoSettleLaneSessionsOnPrMerge` policy. Nothing derives a
settle either: a completed turn or a clean CLI exit leaves the row
active/ended, never settled.

`buildAdeBootstrapGuidance` exposes the surviving commands in the injected
agent prompt (`ADE_SESSION_STATUS_PROTOCOL_GUIDANCE`), including the explicit
"you cannot settle or unsettle a session" line.

### Bundled skill distribution

ADE keeps one canonical bundled skill tree at
`apps/desktop/resources/agent-skills` (packaged as
`Resources/agent-skills`). It does not install those skills into
`~/.claude/skills`, `~/.agents/skills`, `~/.cursor/skills`,
`~/.factory/skills`, or `~/.config/opencode/skills`; doing so leaks
ADE-specific capabilities into unrelated harness sessions.

Each ADE-launched session receives the canonical root through
`ADE_AGENT_SKILLS_DIRS` and the compact skill catalog in
`buildAdeBootstrapGuidance`. Provider-native integrations are session-scoped:

- Codex app-server receives `skills/extraRoots/set` and uses
  `perCwdExtraUserRoots` when listing skills.
- Claude Agent SDK loads the bundled root as a local plugin through its
  `.claude-plugin/plugin.json`; tracked Claude CLI launches receive the same
  validated root through `--plugin-dir`.
- OpenCode's currently shipped config schema, Cursor, and Droid do not expose
  an arbitrary standalone skill-root option ADE can safely set, so they use
  the catalog plus the provider-independent
  `ade skill list --text` / `ade skill show <name> --text` activation path.

The same CLI activation path is available to every provider and remains the
compatibility fallback for older runtime versions. On startup, ADE performs a
one-time conservative migration of the former global installation: it reads
the ADE-owned `.ade-skills.json` manifest, removes only copies whose contents
still match ADE's bundle, preserves modified or unverifiable copies, and then
retires the manifest.

SDK-backed Claude, Codex, Cursor, Droid, and OpenCode chats receive
`ADE_CHAT_SESSION_ID` plus `ADE_DEFAULT_ROLE=agent` (or `orchestrator` for an
orchestration lead), and their persistent guidance names the concrete
`--session` argument. Tracked provider CLIs receive the same session binding
and an `agent` role on both first launch and resume. This keeps the lifecycle
surface provider-neutral and prevents the host brain's CTO-capable process role
from leaking into a child agent.

On macOS, Codex agents can use the canonical `mcp__computer_use` tool when the
user explicitly enabled the bundled Computer Use plugin or MCP server and the
standalone OpenAI helper passes signature verification. The same path is
installed for native Work chat and tracked Codex CLI start/resume; normal MCP
elicitation consent still applies.

### Personal chat agents

Ephemeral machine-owned sessions with no user-visible project, lane, repository,
or PR identity. They share provider/model/turn infrastructure with regular chat
but receive a neutral general-assistant prompt and a scratch cwd. Project ADE
guidance, project slash-command discovery, orchestration/Linear metadata, and
project workflow tools are not injected. See [Personal chats](../personal-chats/README.md).

## Spawning agents and spawn types

Any chat-bound agent can run `ade new chat` to spawn either another ADE chat
or a tracked agent CLI session. Both modes inherit
`orchestrationParentSessionId` from the spawner's `ADE_CHAT_SESSION_ID`, and
both accept `--parent`, `--no-parent`, and the required parented-spawn type
`--type subagent|peer`. Plain shell terminals do not record this lineage. The
child is a normal agent with the same runtime, permissions, and tools, but the
type is a coordination contract: `subagent` is required whenever the parent
will need, join, read, or review the result (including parallel work); `peer`
is fire-and-forget and leaves quiet turn-completion notes. Missing types and
the legacy `none` value are rejected for new parented sessions.

Every parent-dispatched subagent chat turn returns its child turn id and latest
bounded assistant summary, steering an active parent or waking an idle parent.
Human-dispatched child turns and peer turns leave quiet notes. The persisted
lineage/dispatch metadata makes this restart-safe and per-turn rather than a
one-shot kickoff notification; final delivery failure becomes visible in the
child after bounded retries.

For a CLI child, the same parent/type fields are persisted in the tracked
session's `resumeMetadata` and projected onto `TerminalSessionSummary` for
lineage UI. They do not populate `chatSessionId`, which remains reserved for
terminal ownership, and a later resume-command refresh preserves the lineage.

The orchestrator's `spawnAgent` tool
(`services/ai/tools/orchestrationTools.ts`) and the orchestration domain
spawn path (`services/orchestration/orchestrationDomain.ts`) set the same
field, defaulting to `spawnKind: "subagent"` so orchestration workers report
back to their lead without polling. Both child types receive
`ADE_PARENT_CHAT_SESSION_ID` / `ADE_SPAWN_KIND` and type-specific self-report
guidance; `chat.messageSession` remains the recovery path.

Orchestration `spawnAgent` / `messageAgent` are idempotent: each carries a
`requestId` (explicit or deterministically derived) backed by a service-owned
receipt, so a retried call replays its original result rather than spawning a
second worker. Completion no longer depends on the lead polling transcripts —
when a worker or validator reaches a terminal state the service enqueues a
`completion` entry in the run outbox in the same transaction and drains it to
the lead, and the lead can also block on the `awaitAgent` tool. See
[Tool Registration › Orchestration sessions](tool-registration.md#in-process-path).

The runtime mechanics — provider-native mid-turn completion steering, the
idle/fallback message and peer-notice paths, and the navigation/pill/breadcrumb
surfacing — live in
[Chat › Spawn types and completion reporting](../chat/README.md#spawn-types-and-completion-reporting).
When the spawned work must carry the current lane's unmerged commits, spawn
into a child lane instead of a fresh one — see
[Lanes › Child-lane guidance for spawned work](../lanes/stacking.md#child-lane-guidance-for-spawned-work).

## Agent CLI install / auth from chat

When a chat targets a provider whose CLI is missing or unauthenticated on the active runtime, the chat surfaces an inline `AgentCliAuthCard`. The card is built by `classifyAgentCliError` from `apps/ade-cli/src/services/agentRegistry.ts` and gives the user a tracked terminal action for install or login.

The important invariant is runtime locality: a desktop window bound to a remote `ade serve` daemon launches the install/auth command on that remote machine, not locally.

**Pi is the exception: it signs in inside ADE.** Settings → Providers drives
Pi's own `ModelRuntime.login` through `piAuthService.ts` and renders whatever Pi
asks for — an auth URL, a device code with a copyable user code, a text or
secret field, or a choice list — as ADE cards. ADE relays the user's answers and
never reads, stores, or logs a credential; Pi's own `AuthStorage` owns
`auth.json`. Pi's terminal `/login` remains available beside the in-app flow and
is the only path when the Pi SDK is unavailable (missing package, or a Node
older than `PI_SDK_MIN_NODE`). See
[Agent Routing › Pi sign-in](../chat/agent-routing.md#pi-sign-in).

### ADE account auth for agents and CI

ADE accounts remain optional for local workflows. On an SSH or display-less
runtime, `ade login` prints a device verification URL and short code that can
be approved in any browser; browser-capable local runtimes retain the loopback
OAuth callback. Fully non-interactive automation provisions a versioned,
self-contained refresh credential once with `ade account token create`, stores
it in a secret manager, and exposes it to the machine brain as
`ADE_ACCOUNT_TOKEN`. The envelope includes the public OAuth refresh context, so
the consuming host needs no local Clerk configuration. The token never enters
project files or operational logs, and account actions remain CTO-only.

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

| Tier | CTO | Regular chat | Personal chat |
|---|:-:|:-:|:-:|
| Provider-native general tools (reasoning, web, scratch files/shell as permitted) | yes | yes | yes |
| ADE project workflow guidance/actions | yes | yes | no |
| CTO operator (spawnChat, lanes/PRs/git/tests, memory tools) | yes | no | no |
| Linear tools | yes (when connected) | no | no |

Standalone chat sessions connected through the ADE CLI have elevated tools hidden from tool listing and execution at the ADE CLI server boundary.

## Prompt composition

The project surfaces use `buildCodingAgentSystemPrompt` with different identity/context prefixes; personal chat deliberately does not:

- **CTO:** immutable CTO doctrine, active personality overlay, persona, continuity model, memory-system guidance, environment knowledge, recent session context, injected durable memory, and the user-defined prompt extension.
- **Regular chat:** lane context, workflow tool guidance, and permission-mode framing.
- **Personal chat:** a compact general-assistant directive stating that no
  repository/project is attached and that explicit filesystem/shell work must
  remain inside the supplied scratch cwd.

### Orchestration boundary and provider capabilities

The orchestration protocol is injected into the provider system/developer
prompt only for sessions carrying an orchestration role. Ordinary chats do
not receive or follow that protocol, and `ade-orchestrator` is not a bundled
skill. Orchestrator leads may inspect their lane but their provider-native
mutating tools are denied at each provider's runtime boundary; workers retain
the tools needed to edit and validate.

Provider capability isolation is role-scoped. In particular, ordinary
OpenCode chats and workers retain the user's OpenCode configuration, project
configuration, and MCP servers. Only an OpenCode orchestration lead receives
ADE's isolated configuration and ADE-owned MCP lease. Other providers apply
their equivalent lead gate without changing ordinary-chat configuration.

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
- **A bound session never inherits CTO authority.** Keep role resolution on
  `resolveSessionBoundRole` in both single-project and multi-project RPC
  servers, and stamp tracked CLI / SDK chat environments with an explicit
  agent-or-orchestrator role. A daemon may be CTO-capable, but that capability
  is unrelated to the child session's identity.

## Detail docs

- [Identity and Personas](identity-and-personas.md) — identity storage, reconstruction, personality presets, immutable doctrine, and the memory system.
- [Tool Registration](tool-registration.md) — ADE CLI integration, action registration, role-based filtering, and capability fallback.

## Related docs

- [Personal chats](../personal-chats/README.md) — projectless agent sessions and
  their machine-scope isolation contract.
- [CTO](../cto/README.md) — the CTO thread and settings surface.
- [Chat README](../chat/README.md) — session lifecycle and identity session filtering.
- [Chat Agent Routing](../chat/agent-routing.md) — provider and model selection for agents.
- [Chat Tool System](../chat/tool-system.md) — universal, workflow, and coordinator tool details.
