# CTO — Persistent Project-Aware Agent

> Roadmap reference: `docs/final-plan.md` is the canonical future plan and sequencing source.

> Last updated: 2026-02-27
>
> **Status: Planned** — Phase 4 establishes infrastructure and basic interface. Detailed implementation is deferred.

---

## Table of Contents

- [Overview](#overview)
  - [Why a CTO Agent](#why-a-cto-agent)
  - [Design Philosophy](#design-philosophy)
- [Core Capabilities](#core-capabilities)
  - [Mission Creation & Management](#mission-creation--management)
  - [Lane Management](#lane-management)
  - [Project State Awareness](#project-state-awareness)
  - [Question Answering](#question-answering)
  - [Request Routing](#request-routing)
- [Memory Architecture](#memory-architecture)
  - [Three-Tier Memory Integration](#three-tier-memory-integration)
  - [Auto-Compaction](#auto-compaction)
  - [Temporal Decay & Composite Scoring](#temporal-decay--composite-scoring)
  - [Knowledge Accumulation](#knowledge-accumulation)
- [Identity & State](#identity--state)
  - [.ade/cto/ Directory](#adecto-directory)
  - [Identity Persistence](#identity-persistence)
  - [State Portability](#state-portability)
- [Interaction Model](#interaction-model)
  - [Persistent Chat Interface](#persistent-chat-interface)
  - [Conversation Patterns](#conversation-patterns)
  - [Always-On Availability](#always-on-availability)
- [External Integration](#external-integration)
  - [MCP Tool Surface](#mcp-tool-surface)
  - [External Agent Workflow](#external-agent-workflow)
  - [OpenClaw & Other Agents](#openclaw--other-agents)
- [Relationship to Missions](#relationship-to-missions)
  - [Strategic vs Tactical](#strategic-vs-tactical)
  - [CTO to Mission Flow](#cto-to-mission-flow)
- [Deferred Design](#deferred-design)

---

## Overview

The **CTO** (Chief Technical Officer) is ADE's always-on, persistent, project-aware AI agent. It occupies its own tab in the ADE desktop app and serves as the single point of contact for all project-level questions, decisions, and actions. The CTO replaces the former Concierge Agent concept with a broader mandate: rather than simply routing requests, the CTO is a persistent agent that accumulates deep knowledge about the entire project and uses that knowledge to make informed decisions, create missions, manage lanes, and answer questions — like having a CTO who knows everything about the codebase and never forgets.

The CTO is the answer to a fundamental problem with current AI coding tools: every conversation starts from scratch. Context is expensive to rebuild, and even the best retrieval systems lose nuance. The CTO solves this by maintaining a persistent identity with three-tier memory (core/hot/cold) and auto-compacting context that ensures it never truly forgets. Facts, decisions, architectural patterns, team preferences, and project history accumulate over time and are always available.

### Why a CTO Agent

Traditional AI assistants are **session-scoped** — they know nothing before the conversation starts and forget everything when it ends. Project-level knowledge (architecture decisions, coding conventions, dependency choices, past failures, team preferences) must be re-explained every session. This is wasteful and error-prone.

The CTO agent is **identity-scoped** — it persists across all sessions, accumulates project knowledge over time, and brings that knowledge to every interaction. After a few weeks of use, the CTO knows the project as well as a senior team member who has been on the project from day one.

Key differentiators from session-scoped assistants:

| Aspect | Session-Scoped Assistant | CTO Agent |
|---|---|---|
| **Knowledge lifetime** | Dies with the session | Persists forever (three-tier memory) |
| **Project awareness** | Must be told every time | Accumulates automatically |
| **Decision context** | Isolated to current conversation | Full history of past decisions |
| **Routing intelligence** | Requires explicit instructions | Learns preferences over time |
| **Cross-session continuity** | None | Seamless — picks up where it left off |

### Design Philosophy

The CTO is modeled after a real-world Chief Technical Officer — someone who:

- **Knows the entire codebase** and its history, not just the file currently open.
- **Remembers past decisions** and their rationale, so the team does not repeat mistakes.
- **Makes autonomous decisions** when the path is clear and escalates when it is not.
- **Delegates effectively** — creates missions and spins up lanes for tactical work rather than doing everything inline.
- **Communicates proactively** — surfaces issues, progress, and recommendations without being asked.
- **Learns continuously** — every interaction makes it more effective.

---

## Core Capabilities

### Mission Creation & Management

The CTO can create and manage missions on behalf of the user:

- **Create missions from conversation**: "We need to refactor the auth module to use JWT refresh tokens" triggers mission creation with an AI-generated phased plan.
- **Estimate complexity**: Before creating a mission, the CTO assesses task complexity based on project knowledge — file count, architectural impact, dependency chains, and past experience with similar tasks.
- **Select execution strategy**: Based on complexity and user preferences, the CTO decides whether to launch a full multi-step mission, a single-step task agent, or handle the request inline.
- **Monitor active missions**: The CTO tracks all running missions and can relay status, surface interventions, and provide progress summaries.
- **Steer missions**: When a mission encounters problems or the user changes requirements, the CTO can steer the mission with updated instructions.

### Lane Management

The CTO has full awareness of the project's lane topology:

- **Create lanes**: Spin up new worktree lanes for development work.
- **Check lane status**: Report on active lanes, their branches, and current state.
- **Coordinate lane usage**: Suggest which lane to use for new work based on current lane state and active missions.

### Project State Awareness

The CTO maintains a continuously updated mental model of the project:

- **Codebase structure**: Module boundaries, key files, dependency graph, build system configuration.
- **Active work**: Running missions, open lanes, pending interventions, recent commits.
- **Historical context**: Past missions and their outcomes, architectural decisions and their rationale, recurring issues and their resolutions.
- **Team patterns**: Preferred coding conventions, PR strategy, testing approach, model preferences.

### Question Answering

The CTO can answer questions about the project without requiring the user to provide context:

- "How does the auth middleware handle expired tokens?" — answers from project knowledge.
- "What was the rationale for switching from Jest to Vitest?" — answers from decision history.
- "Which lanes are currently active and what's running on them?" — answers from live state.
- "What happened with last night's Night Shift run?" — answers from mission history and memory.

### Request Routing

When the CTO receives a request it cannot or should not handle inline, it routes to the appropriate subsystem:

| Request Type | Routed To | Example |
|---|---|---|
| Large development task | Mission system (phased plan) | "Refactor the auth module to use JWT refresh tokens" |
| Small code change | Task agent (one-off) | "Fix the typo in README.md line 42" |
| Status query | Inline answer from memory + MCP tools | "What's the status of the auth refactor?" |
| PR review request | Review pipeline | "Review PR #87 before I merge" |
| Code question | Inline answer from project knowledge | "How does the rate limiter work?" |
| External agent request | Appropriate subsystem via intent classification | Any request arriving via MCP from an external agent |

---

## Memory Architecture

The CTO is the primary consumer of ADE's three-tier memory system. While all agents use the same memory infrastructure (documented in detail in `AGENTS.md`), the CTO's usage pattern is unique: it accumulates project-level knowledge over its entire lifetime rather than within a single mission or session.

### Three-Tier Memory Integration

| Tier | CTO Usage |
|---|---|
| **Tier 1 — Core Memory** (~2-4K tokens, always loaded) | The CTO's essential working context: current project state summary, active missions, recent decisions, and critical constraints. Self-edited by the CTO via `memoryUpdateCore` as the project evolves. |
| **Tier 2 — Hot Memory** (retrieved on demand via hybrid search) | The bulk of the CTO's accumulated project knowledge: architectural decisions, coding conventions, past mission outcomes, user preferences, episodic memories from past interactions, and procedural knowledge. Retrieved via composite-scored hybrid search (BM25 + vector). |
| **Tier 3 — Cold Memory** (archival, never in context) | Historical records, old mission summaries, superseded decisions, and low-importance observations. Accessible via deep search but excluded from standard retrieval. |

### Auto-Compaction

The CTO's conversations can be long-running. When context usage approaches 70% of the model's window, the compaction engine triggers a **pre-compaction flush**:

1. The CTO is prompted to persist important facts, decisions, and observations to memory before compaction.
2. The CTO uses its own intelligence to decide what matters — not a mechanical extraction rule.
3. After the flush, context is compacted (summarized and truncated), but the important content has already been written to durable memory.
4. Post-compaction, the CTO continues with its Tier 1 core memory intact and Tier 2 retrieval available — effectively picking up where it left off with minimal information loss.

This cycle can repeat indefinitely. The CTO never truly "forgets" because the pre-compaction flush ensures important knowledge migrates to durable storage before context eviction.

### Temporal Decay & Composite Scoring

Memory retrieval uses composite scoring to surface the most relevant knowledge:

```
relevance = semantic(0.5) + recency(0.2) + importance(0.2) + access_frequency(0.1)
```

- **Recency** uses a 30-day half-life: today's memories score 100%, one-month-old memories score 50%, six-month-old memories score ~1.6%.
- **Exceptions**: Core memory (Tier 1), promoted facts, and pinned memories never decay.
- **Effect**: Recent decisions and active project context naturally surface first, while old but semantically relevant knowledge (e.g., a critical architectural decision from three months ago) still scores well if its semantic and importance signals are strong.

### Knowledge Accumulation

Over time, the CTO's memory naturally stratifies:

- **First week**: Basic project structure, build system, key files, user preferences.
- **First month**: Coding conventions, testing patterns, common failure modes, dependency quirks.
- **Ongoing**: Architectural decision history, mission outcome patterns, team workflow preferences, learned routing patterns, procedural knowledge about what works and what does not.

This accumulation is what makes the CTO fundamentally different from a session-scoped assistant. Each interaction adds to a growing knowledge base that makes every future interaction more informed.

---

## Identity & State

### .ade/cto/ Directory

The CTO's persistent state lives in the `.ade/cto/` directory at the project root:

```
.ade/cto/
├── identity.yaml           # CTO persona, model preferences, policy config
├── core-memory.json        # Tier 1 core memory (always loaded into context)
├── memory/
│   ├── hot.json            # Tier 2 hot memory entries (source data)
│   └── archive/            # Tier 3 cold storage
└── state.json              # Current operational state (active missions, pending items)
```

### Identity Persistence

The CTO's identity file defines its persona and operating parameters:

```yaml
# .ade/cto/identity.yaml
name: "CTO"
version: 1
persona: |
  You are the CTO of this project. You have deep knowledge of the entire
  codebase, its history, and the team's preferences. You make informed
  decisions, delegate effectively, and communicate proactively. You
  remember everything important about this project.
modelPreferences:
  provider: claude
  model: opus
  reasoningEffort: high
memoryPolicy:
  autoCompact: true
  compactionThreshold: 0.7
  preCompactionFlush: true
  temporalDecayHalfLife: 30
```

The identity file is versioned. Each edit increments the version number, and previous versions are retained for audit.

### State Portability

The `.ade/cto/` directory follows the same portability principles as the rest of `.ade/`:

- **Committable to the repository**: Any machine with the repo clone has the CTO's full state.
- **Git is the sync layer**: No separate cloud sync needed.
- **Embeddings are local**: The embeddings cache is in `.gitignore` and regenerated locally. The source JSON data is what gets committed.
- **Merge-friendly**: JSON with sorted keys for clean diffs, YAML for human readability.

---

## Interaction Model

### Persistent Chat Interface

The CTO tab in the ADE desktop app provides a persistent chat interface:

- **Single thread**: Unlike mission chat (which has per-mission threads), the CTO has one continuous conversation thread per project.
- **Context carries over**: The CTO remembers previous conversations through its memory system. Even after compaction, it can retrieve relevant context from past sessions.
- **Rich responses**: The CTO can render code blocks, file references, mission status cards, lane summaries, and other structured content inline in the conversation.

### Conversation Patterns

The CTO supports several interaction modes:

- **Direct question**: "How does the payment flow work?" — the CTO answers from project knowledge.
- **Task delegation**: "We need to add dark mode support" — the CTO creates a mission, explains the plan, and monitors execution.
- **Status check**: "What's going on right now?" — the CTO summarizes active missions, recent commits, and pending items.
- **Decision discussion**: "Should we use Redis or Memcached for the session store?" — the CTO provides informed analysis based on project context, past decisions, and technical trade-offs.
- **Review request**: "Take a look at PR #42" — the CTO reviews the PR and provides feedback.

### Always-On Availability

The CTO is available whenever the ADE desktop app is running. It does not require explicit activation or session creation — the user opens the CTO tab and starts talking. The CTO's memory ensures continuity even across app restarts.

---

## External Integration

### MCP Tool Surface

External agents interact with the CTO through the ADE MCP server. The CTO acts as the intelligent front door for all external requests, replacing the need for external agents to understand ADE's internal tool surface.

Key MCP tools available to external agents:

- **Mission tools**: `create_mission`, `get_mission`, `start_mission`, `pause_mission`, `cancel_mission`, `steer_mission`
- **Lane tools**: `create_lane`, `get_lane_status`, `merge_lane`, `rebase_lane`
- **Agent tools**: `spawn_agent`, `get_worker_states`, `resolve_intervention`
- **Context tools**: `read_context`, `check_conflicts`, `get_timeline`
- **Integration tools**: `create_integration`, `simulate_integration`, `commit_changes`, `get_final_diff`, `get_pr_health`

### External Agent Workflow

When an external agent connects to ADE via MCP:

1. **Connection**: The external agent establishes an MCP connection (stdio for headless, Unix socket for embedded mode).
2. **Request arrives at CTO**: The request is received by the CTO, which classifies intent using its project knowledge and learned routing patterns.
3. **Context enrichment**: The CTO adds context from its own memory — user preferences, past routing outcomes, project conventions — before delegating.
4. **Delegation**: The CTO routes to the appropriate subsystem (mission orchestrator, task agent, review pipeline, or answers inline).
5. **Execution**: The routed subsystem performs the work.
6. **Result return**: Results, status updates, and artifacts are returned via MCP to the external agent.

### OpenClaw & Other Agents

The CTO is designed as a drop-in backend for persistent agent systems like OpenClaw. The typical integration pattern:

```
External agent (OpenClaw, Claude Code, Codex CLI) receives user request
    |
    v
Connects to ADE MCP server
    |
    v
CTO receives request, classifies intent
    |
    v
CTO enriches with project context from memory
    |
    v
Routes to appropriate subsystem:
  - Large task → Mission system (phased plan)
  - Small task → Task agent (one-off)
  - Question  → Inline answer from CTO knowledge
  - Review    → Review pipeline
    |
    v
Work executes (agents work in lanes)
    |
    v
Results returned via MCP
    |
    v
External agent reports back to user
```

The CTO's persistent memory means routing improves over time. If a user consistently wants TypeScript refactoring routed to a specific agent identity or prefers a particular PR strategy, the CTO learns these patterns and applies them automatically.

#### OpenClaw Integration Architecture

OpenClaw (https://github.com/openclaw/openclaw) is a self-hosted personal AI assistant that runs as a local-first gateway daemon connecting to messaging platforms (WhatsApp, Telegram, Slack, Discord, iMessage, etc.). It supports multiple isolated agents, each with their own workspace, persona, and memory. The CTO agent is designed to integrate with OpenClaw as a specialized "tech department" — one of several agents in the user's personal agent network.

**Conceptual relationship:**
- OpenClaw = personal life gateway. Multiple agents handle different domains (virtual self, CFO, marketing lead, etc.).
- ADE CTO = the entire tech department. One persistent agent with deep project knowledge, mission orchestration, and memory.
- They are complementary, not competing. OpenClaw is the outer shell (your life); CTO is a specialized department within that shell.

**How CTO appears in OpenClaw:**
CTO is not a native OpenClaw agent (those run inside OpenClaw's own runtime). Instead, CTO is exposed to OpenClaw via a bridge — either as a custom skill, a webhook endpoint, or a Gateway WebSocket operator client. From the user's perspective, messaging "CTO" through OpenClaw feels native, but under the hood OpenClaw forwards to ADE.

##### Bridge Architecture

The bridge service runs inside ADE's Electron main process and provides bidirectional communication:

```
┌─────────────────────────────────────┐
│         ADE Electron App            │
│                                     │
│  ┌──────────────┐  ┌─────────────┐  │
│  │  CTO Agent   │  │  OpenClaw   │  │
│  │  (Vercel AI) │◄─┤  Bridge     │  │
│  └──────────────┘  │  Service    │  │
│                    │             │  │
│                    │ HTTP :3742  │  │
│                    │ WS client   │  │
│                    └──────┬──────┘  │
└───────────────────────────┼─────────┘
                            │
                    localhost network
                            │
┌───────────────────────────┼─────────┐
│     OpenClaw Gateway                │
│   ws://127.0.0.1:18789              │
│                           │         │
│  ┌────────────────────────▼──────┐  │
│  │  Gateway WS API (operator)   │  │
│  │  + /hooks/agent endpoint     │  │
│  └──────────────┬────────────────┘  │
│                 │                   │
│  ┌──────────────▼──────────────┐    │
│  │  Multi-Agent Router         │    │
│  │  ┌─────────┐ ┌───────────┐  │    │
│  │  │  main   │ │ cfo, etc. │  │    │
│  │  │  agent  │ │           │  │    │
│  │  └────┬────┘ └───────────┘  │    │
│  └───────┼──────────────────────┘   │
│          │ sessions_send            │
│          └──────────────────────    │
└─────────────────────────────────────┘
```

##### OpenClaw → CTO Flow (Inbound)

1. An OpenClaw agent (e.g., the user's "main" virtual self agent) calls `sessions_send` targeting a `hook:ade-cto` session key.
2. OpenClaw's Gateway routes to that session and triggers a `message:received` hook.
3. The hook handler POSTs the message to ADE's bridge HTTP server at `http://127.0.0.1:3742/cto`.
4. ADE's bridge forwards via IPC to the CTO agent, which processes the request with full project memory and MCP tool access.
5. The bridge POSTs the CTO's reply back via `POST http://127.0.0.1:18789/hooks/agent` with the appropriate `sessionKey`.
6. OpenClaw delivers the reply back to the original session, and the `sessions_send` call resolves.

##### CTO → OpenClaw Flow (Proactive Outbound)

1. CTO (or the ADE mission orchestrator) wants to proactively message an OpenClaw agent (e.g., notify the user's virtual self about a completed mission).
2. ADE's bridge service, connected as a WebSocket `operator` client to OpenClaw's Gateway, calls `sessions_send` directly over the WebSocket.
3. The target OpenClaw agent receives the message in its active session.
4. Any reply comes back as streamed `agent` events to ADE's WebSocket connection.

##### OpenClaw Configuration

The OpenClaw side requires:

```json5
// ~/.openclaw/openclaw.json
{
  agents: {
    defaults: {
      tools: {
        agentToAgent: {
          enabled: true,
          allow: ["main", "cfo", "marketing"]
        }
      }
    }
  },
  hooks: {
    token: "<ade-bridge-secret>",
    allowRequestSessionKey: true,
    allowedAgentIds: ["main"]
  }
}
```

And a custom skill at `~/.openclaw/workspace/skills/ade-cto/SKILL.md` that teaches OpenClaw agents when and how to invoke CTO (either via the bridge HTTP endpoint or via `sessions_send` to the hook session).

##### Alternative: Simpler Skill-Only Bridge

For a minimal integration without the full WebSocket bridge, a custom OpenClaw skill can use the `exec` tool to `curl` ADE's HTTP endpoint directly:

```markdown
---
name: ade-cto
description: Consult the ADE CTO agent for technical decisions and code questions
---
# ADE CTO Agent
Use the exec tool to consult the ADE CTO:
curl -s -X POST "http://127.0.0.1:3742/cto" \
  -H "Content-Type: application/json" \
  -d '{"question": "<question>", "context": "<context>"}'
```

This approach is one-directional (OpenClaw → CTO only) but requires no WebSocket integration. The full bidirectional bridge is recommended for production use.

##### Key Technical Constraints

- OpenClaw's `sessions_send` is blocked via the HTTP `/tools/invoke` endpoint (hardcoded deny list). Must use the WebSocket API or gateway hooks instead.
- OpenClaw has no native MCP client — it cannot connect to ADE's MCP server directly. The bridge must translate between OpenClaw's protocol and ADE's MCP/IPC surface.
- OpenClaw's `agentToAgent` tool is disabled by default and must be explicitly enabled with an allow-list.
- Sub-agents spawned via `sessions_spawn` do not get session tools — only depth-1 orchestrators can use `sessions_send`.
- The ADE bridge must handle OpenClaw's device pairing protocol (challenge-nonce, `connect` handshake, `deviceToken` persistence) for WebSocket operator connections.
- OpenClaw webhook handlers must be non-blocking (fire-and-forget). The bridge HTTP server should acknowledge immediately and process asynchronously.

---

## Relationship to Missions

### Strategic vs Tactical

The CTO and the mission system operate at different levels of abstraction:

| Aspect | CTO | Missions |
|---|---|---|
| **Level** | Strategic / project-level | Tactical / task-level |
| **Lifetime** | Persistent (lives as long as the project) | Temporary (created, executed, completed) |
| **Scope** | Entire project knowledge and history | Single goal with a phased plan |
| **Role** | Decides what work to do and how | Executes the work |
| **Memory** | Accumulates project-level knowledge | Accumulates task-level facts (promoted to project after completion) |

The CTO **creates** missions. Missions **execute** work. The CTO monitors mission progress, surfaces interventions, and incorporates outcomes into its project knowledge after missions complete.

### CTO to Mission Flow

When the CTO determines that a request requires a mission:

1. **Complexity assessment**: The CTO estimates task complexity from project knowledge — file count, architectural impact, dependency chains, similar past missions.
2. **Mission creation**: The CTO calls `create_mission` with the task description, enriched with relevant project context.
3. **Plan review**: The mission orchestrator generates a phased plan. The CTO can review and steer if needed.
4. **Execution monitoring**: While the mission executes, the CTO tracks progress and can relay status to the user or external agent.
5. **Outcome integration**: After the mission completes, the CTO absorbs the outcome into its memory — what worked, what failed, what was learned.

---

## Deferred Design

The CTO feature is **Planned**. Phase 4 of the ADE roadmap establishes the foundational infrastructure that the CTO will build on:

- **Memory service**: Three-tier memory with compaction, hybrid search, and composite scoring.
- **Agent runtime**: Unified agent definition, runtime, and memory model.
- **MCP tool surface**: Full tool coverage for external agent integration.
- **Identity persistence**: `.ade/` directory structure and versioned identity files.

Detailed CTO implementation is deferred to a later phase. The following areas require design work before implementation begins:

- **Chat UI specifics**: Layout, components, and keyboard shortcuts for the CTO tab.
- **Conversation persistence**: How conversation history is stored and resumed across app restarts.
- **Proactive behavior**: When and how the CTO should surface information without being asked (e.g., morning briefing, mission completion notifications).
- **Multi-project support**: How the CTO handles users working across multiple projects.
- **Model selection and cost management**: Budget controls for the CTO's ongoing operation (it consumes tokens for every interaction and memory operation).
- **Learning rate and accuracy**: How quickly the CTO should adopt new patterns vs. maintaining stable behavior.
- **Trust and permissions**: What the CTO can do autonomously vs. what requires user approval.

These design questions will be addressed when the CTO moves from Planned to In Progress.
