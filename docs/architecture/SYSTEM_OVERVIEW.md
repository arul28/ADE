# ADE system overview

> Product behavior and scope live in [`../PRD.md`](../PRD.md). This document owns the top-level technical shape and points to the deeper architecture references.
>
> Last updated: 2026-03-25

## System shape

ADE is a local-first development control plane built around a trusted Electron main process, a typed preload bridge, and an untrusted renderer. Repo mutation, process execution, and durable state flow through main-process services. Agent runtimes, MCP access, and integrations plug into that core instead of bypassing it.

At a high level, ADE has four technical layers:

1. renderer surfaces for lanes, files, work, missions, PRs, CTO, automations, and settings
2. preload APIs that expose a narrow typed IPC contract
3. main-process services for git, PTYs, files, missions, memory, context generation, and integrations
4. external/runtime edges for provider-backed AI execution, ADE's MCP server, GitHub, Linear, and other bridges

## Trust boundaries

- The renderer does not mutate the repository directly.
- The preload layer exposes typed, allowlisted capabilities rather than raw Node access.
- Main-process services own filesystem writes, git commands, process lifecycle, SQLite access, and policy enforcement.
- Computer-use and artifact flows must enforce policy in code, not just by prompt wording.

## Core service areas

### Workspace and execution

- lane/worktree management, including creating child lanes from unstaged changes
- git status, diff, merge, rebase, and queue-oriented PR operations
- tracked PTY sessions and managed processes
- test execution and runtime controls

### Orchestration and AI

- mission planning and worker coordination
- agent chat and CTO flows with provider-native permission controls (Claude permission mode, Codex approval policy/sandbox, unified permission mode)
- provider-flexible AI runtime selection
- turn-level memory orientation guard that blocks mutating tools until agents have consulted project memory
- generated context docs and bounded context delivery with push-based status updates
- ADE-owned MCP tool surfaces

### Memory and context

- unified memory storage in SQLite
- project, mission, and agent-scoped retrieval
- generated `.ade/context/*` bootstrap cards
- project pack and compatibility export surfaces where still required

### External integrations

- GitHub and pull request workflows
- Linear sync, routing, and dispatch
- external MCP connections
- OpenClaw and other bridge-style integrations

## Data and state

- project-local state lives under `.ade/`
- runtime metadata lives primarily in `.ade/ade.db`
- machine-local sensitive or transient data lives under `.ade/secrets`, `.ade/cache`, and `.ade/artifacts`
- generated agent bootstrap docs live under `.ade/context/`
- shared contracts for renderer/main-process/preload live in `apps/desktop/src/shared`

## Integration points

- desktop renderer <-> preload <-> main process via typed IPC
- AI runtimes via provider-native or OpenAI-compatible paths
- ADE MCP server via `apps/mcp-server`
- repo state via git CLI and ADE-owned workspace services
- GitHub, Linear, and other external systems through explicit service adapters

## Key patterns

- Preserve service-first fixes over renderer-only workarounds.
- Keep IPC contracts, preload types, shared types, and renderer usage aligned.
- Hydrate heavy UI surfaces in stages so project open and tab switches stay responsive.
- Use canonical docs for broad coverage and `.ade/context/*` for bounded startup context.
- Prefer deterministic, reviewable artifacts over implicit in-memory state when context needs to survive long-running workflows.

## Architecture document map

- Desktop runtime and performance rules: [`DESKTOP_APP.md`](./DESKTOP_APP.md)
- Context ownership and generation contract: [`CONTEXT_CONTRACT.md`](./CONTEXT_CONTRACT.md)
- Data model and storage: [`DATA_MODEL.md`](./DATA_MODEL.md)
- AI runtime/orchestrator details: [`AI_INTEGRATION.md`](./AI_INTEGRATION.md)
- Configuration model: [`CONFIGURATION.md`](./CONFIGURATION.md)
- Security and privacy: [`SECURITY_AND_PRIVACY.md`](./SECURITY_AND_PRIVACY.md)
- Git engine details: [`GIT_ENGINE.md`](./GIT_ENGINE.md)
- iOS client architecture: [`IOS_APP.md`](./IOS_APP.md)
- Job execution model: [`JOB_ENGINE.md`](./JOB_ENGINE.md)
- Memory system details: [`MEMORY.md`](./MEMORY.md)
- Sync architecture: [`MULTI_DEVICE_SYNC.md`](./MULTI_DEVICE_SYNC.md)
