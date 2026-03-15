# Appendix: Program Rules, Risks, and KPIs

## 7. Sequence and Pull-Forward Rules

Base build order:

1. Phase 1 (Agent SDK Integration + AgentExecutor Interface) — **Complete**
1.5. Phase 1.5 (Agent Chat Integration) — **Complete**
2. Phase 2 (MCP Server) — **Complete**
3. Phase 3 (AI Orchestrator + Missions Overhaul) — **Complete** (Overhaul Phases 1-7 shipped including reflection protocol closure; Task 8 soak is tracked as verification hardening)
4. Phase 4 (CTO + Ecosystem)
5. Phase 5 (Play Runtime Isolation)
6. Phase 6 (Multi-Device Sync & iOS Companion) — **NEW**
7. Phase 7 (Full iOS & Advanced Remote) — **NEW**
8. Phase 8 (Core Extraction + SpacetimeDB Evaluation) — **DEFERRED/OPTIONAL**

Pull-forward rules:

- Phase 5 (Play Runtime Isolation) may begin after Phase 3 starts if resources allow, as it depends on the deterministic runtime (already shipped) rather than the AI orchestrator specifically.
- Phase 2 (MCP Server) and Phase 1 (Agent SDK Integration) may overlap in late Phase 1 for tool contract design work.
- Phase 1.5 (Agent Chat Integration) runs in parallel with Phase 1. It depends only on Phase 1 W1 (package installation) being complete. All other Phase 1.5 work is independent of Phase 1 runtime integration workstreams.
- Phase 3 mission phases UI work runs alongside the Phase 3 completion package since it depends on orchestrator runtime, not specific P3 workstreams.
- Phase 3 remaining tasks (Tasks 1-8) are a hard prerequisite for full autonomous mission quality. Phase 4 CTO and ecosystem work should not bypass these runtime foundations.
- Phase 6 cr-sqlite prototyping may begin during Phase 5 to derisk sync integration.
- Phase 7 iOS polish work may begin during late Phase 6 once the core iOS app is functional.
- Phase 8 activates ONLY if Phase 6 cr-sqlite reveals fundamental sync issues.

---

## 8. Phase Gate Checklist (Before Next Phase)

Each phase must satisfy:

- Feature behavior validated by automated tests and manual smoke checks.
- No unresolved P0/P1 regressions in lanes/terminals/git/conflicts paths.
- Docs updated: affected feature docs + affected architecture docs + plan references.
- DB/state change handling documented for local data shape changes (without adding legacy runtime compatibility branches).
- Telemetry/audit events emitted for newly introduced execution surfaces.

---

## 9. Primary Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| CLI subscription availability varies by user | Some users may lack Claude or Codex subscriptions | `guest` mode preserves full local functionality; clear subscription detection in onboarding |
| CLI tool stability and breaking changes | Two different SDKs (`ai-sdk-provider-claude-code` and `@openai/codex-sdk`) are in play; provider SDK or CLI updates may break execution paths | Pin provider package versions; `AgentExecutor` interface isolates the orchestrator from SDK-level changes; executor implementations are the only code that touches SDK internals |
| Claude subscription auth policy uncertainty | Anthropic may restrict subscription OAuth in third-party tools | Community Vercel provider workaround; `AgentExecutor` interface enables quick switch to official SDK if policy changes |
| Context window limits under large missions | Orchestrator may lose coherence on complex multi-step missions | Progressive context loading; context pressure management; pack compression; **compaction engine (Hivemind HW6) triggers at 70% threshold with durable resume** |
| Monolithic IPC concentration | Slows core extraction and relay work | Domain adapter split in Phase 8 with parity test gates |
| Unsafe unattended execution | High blast radius for unattended automations | Policy gates, intervention states, and centralized budget policy in Settings > Usage |
| Runtime isolation brittleness | Play instability | Deterministic lease model + diagnostics + fallback mode |
| Cross-device race conditions | Inconsistent mission outcomes | cr-sqlite CRDTs + optimistic locking + event sequencing |
| MCP tool permission model gaps | Orchestrator may invoke unsafe operations | Permission/policy layer with deny-by-default; audit logging for all tool calls |
| Codex App Server protocol stability | App Server is relatively new; protocol changes may break integration | Pin `codex` CLI version; generate TypeScript schemas from installed version; adapter pattern isolates protocol changes |
| Claude multi-turn session quality vs Codex | Claude via community provider may have rougher multi-turn UX than Codex's purpose-built App Server | `AgentChatService` interface allows per-provider UX tuning; feature parity is a goal but not a hard requirement |
| localhost subdomain browser compatibility | Safari/Firefox may not resolve `*.localhost` subdomains | Feature detection at startup; fallback to port-based isolation; document browser requirements |
| Port exhaustion on machines with many lanes | Machines with 20+ lanes may exhaust ephemeral port ranges | Configurable port range size per lane; lease release on lane archive; diagnostics for port pressure |
| Docker dependency for lane environment init | Lane env init features require Docker for service startup | Docker is optional; env file copying and dependency install work without Docker; clear error messages when Docker is unavailable |
| .ade/ directory size growth | Large repos with extensive mission history | Pruning policy for old mission logs; archive cold memory; .gitignore for embeddings cache |
| sqlite-vec embedding quality | Poor retrieval if embeddings are low quality | Hybrid BM25+vector ensures keyword fallback; configurable embedding provider |
| Memory consolidation false positives | LLM incorrectly merges distinct memories | 0.85 similarity threshold is conservative; user can review/undo in Settings |
| External MCP server reliability | Agent execution blocked by unreachable external server | Timeout + fallback to local-only execution; external MCP is always optional |
| Custom phase instructions too vague for orchestrator | Orchestrator can't execute phase properly | Semantic validation during pre-flight; require minimum instruction detail |
| Subscription budget estimation inaccuracy | User unexpectedly hits rate limits | Best-effort estimation with clear 'approximate' labeling; graceful rate-limit handling (pause/wait/retry) |
| Phase ordering constraint conflicts | Circular dependencies in custom phases | Structural validation catches cycles during pre-flight |
| cr-sqlite compatibility | cr-sqlite vendored native extension loaded via node:sqlite — W1 implemented successfully on desktop | Phase 8 SpacetimeDB as fallback if long-term issues arise |
| cr-sqlite project maturity | cr-sqlite is pre-1.0; API or merge behavior may change | Pin version; maintain fork if needed; Phase 8 provides alternative path |
| Tailscale adoption friction | Users may resist installing a VPN tool for device sync | Tailscale is optional; LAN-only mode works without it; clear docs on privacy (peer-to-peer, no cloud relay) |
| Brain single-point-of-failure | If brain machine goes offline, no agents run | Brain transfer protocol allows quick failover; VPS brain option for always-on; offline cached state on all devices |
| WebSocket sync reliability | Sync connection drops may cause stale state on viewer devices | Version-based catch-up on reconnect; offline queue replay; cr-sqlite CRDTs handle eventual consistency |
| SpacetimeDB migration scope | 103 tables, ~926 SQL operations across 40+ files is a significant migration | Only triggered if cr-sqlite fails; agent swarm can accelerate; repository abstraction limits blast radius |
| iOS App Store review | Apple may reject or delay the iOS app | Submit early; follow Apple guidelines strictly; plan for review cycles in timeline |
| Push notification infrastructure | APNs requires some server-side infrastructure | Multiple options (self-hosted, FCM, no-push fallback); minimal infra requirements |

---

## 10. KPI Framework

### Product KPIs

- Mission prompt -> first meaningful action latency
- Mission completion rate without manual recovery
- AI orchestrator plan quality (step relevance, minimal unnecessary steps)
- Pre-merge issue discovery rate before merge attempt
- Mobile intervention completion rate

### Orchestrator Intelligence KPIs (Project Hivemind)

- Fan-out detection accuracy (meta-reasoner correctly identifies parallelizable work)
- Context compaction trigger accuracy (compaction at 70% prevents context overflow without premature loss)
- Inter-agent message delivery success rate (PTY + SDK channels)
- Memory promotion accuracy (auto-promoted facts are confirmed vs. rejected by users)
- Run narrative usefulness (agents reference shared narrative in subsequent decisions)
- Smart fan-out step injection success rate (dynamically injected steps complete without errors)
- Validation loop pass rate at first attempt (step/milestone/mission)
- Replan quality score (post-replan success without additional user intervention)
- Lane continuity rework rate (rework resolved in original lane vs re-homed)

### Memory KPIs

- Memory retrieval relevance score (hybrid search vs keyword-only baseline)
- Pre-compaction flush success rate (memories persisted before compaction)
- Memory consolidation accuracy (user confirmation rate for merged memories)
- Episodic memory extraction completeness (key facts captured vs missed)
- cr-sqlite sync round-trip accuracy (state identical across devices after sync)

### CTO & Ecosystem KPIs

- CTO response relevance and task completion rate
- External MCP connection success rate
- Remote mission launch success rate (from viewer device to brain)

### Reliability KPIs

- Orchestrator failure classification coverage
- AI session context window utilization efficiency
- Runtime isolation collision rate
- WebSocket sync reconnect success rate
- Conflict prediction false-positive/false-negative trend
- MCP tool call success rate and latency
- Lane setup time: <5s (env init + port allocation + proxy registration)
- Port collision rate: 0%
- Proxy latency overhead: <5ms per request
- Provider parity stability (normalized permission/tool errors resolved with same intervention UX across Claude/Codex)

### Multi-Device Sync KPIs

- cr-sqlite changeset sync latency (target: <100ms on LAN, <500ms over Tailscale)
- Sync convergence accuracy (all devices reach identical state after concurrent writes)
- Brain transfer completion time (target: <10s including agent stop/start)
- Device pairing success rate (QR code scan to connected state)
- WebSocket reconnection time after network interruption
- Offline queue replay success rate
- VPS headless brain uptime

### Mobile KPIs

- iOS mission launch success rate from phone
- Push notification delivery latency (event to phone notification)
- Agent chat response display latency on mobile
- Offline cached state availability (phone shows data without connection)
- VPS provider provisioning success rate (one-click brain setup)

### Adoption KPIs

- Subscription detection success rate at onboarding
- `guest` vs `subscription` mode usage ratio
- Mission weekly active users
- Time-based automation adoption rate
- Automation run completion and intervention rate
- Phase profile creation rate (users creating custom profiles vs using defaults)
- Custom phase adoption rate (missions using custom phases vs built-in only)
- CTO agent activation rate
- Pre-flight checklist pass rate (first attempt vs requiring fixes)
- Learning pack entry confirmation rate (auto-generated entries confirmed by users vs. deleted)
- External MCP server configuration rate (users connecting external tools)

### Mission Phases KPIs (Phase 3)

- Phase completion rate per phase type
- Custom phase validation pass rate (pre-flight)
- Tiered validation gate pass rate at first attempt
- Intervention granularity effectiveness (single-worker pause vs mission-wide impact)
- Plan tab real-time update latency
- Phase profile usage distribution

---

## 11. Research Context & External Ecosystem

This section captures the research findings, external system analysis, and community architecture patterns that informed ADE's design decisions. These are documented here so the rationale behind key design choices is preserved alongside the plan.

### 11.1 OpenClaw Analysis

OpenClaw is the primary external agent platform ADE is designed to interoperate with. Key facts (as of Feb 2026):

- **Scale**: ~233K GitHub stars, one of the largest open-source AI agent projects.
- **Architecture**: Node.js service running on the user's machine. File-based Markdown memory (MEMORY.md + daily logs). Lobster workflow engine for multi-step agent coordination.
- **Ecosystem**: 5,700+ community-built skills on ClawHub (their skill marketplace).
- **MCP support**: Native MCP client support — OpenClaw agents can connect to ADE's MCP server directly.
- **Security concerns**: Significant security issues identified — CVE-2026-25253 (prompt injection via skill descriptions), 800+ malicious skills discovered on ClawHub, and general concerns about running untrusted community skills with system access.

**ADE's relationship to OpenClaw**: ADE is not a competitor. OpenClaw is a general-purpose personal AI agent platform; ADE is a specialized development orchestration tool. They connect via MCP — OpenClaw (or any external agent) connects to ADE's MCP server to delegate development tasks. The CTO agent serves as the persistent project-aware entry point for these external requests.

**Three paths considered**:
1. Replace OpenClaw features in ADE — rejected (scope creep, different domain)
2. Fork OpenClaw and embed — rejected (maintenance burden, security surface)
3. **ADE as orchestration brain alongside OpenClaw** — chosen (clean separation, MCP bridge, each tool does what it's best at)

### 11.2 Community Architecture Patterns

Two notable community setups that informed ADE's multi-machine and context management design:

**Elvis Sun's ZOE/CODEX Architecture**:
- Uses ZOE as an orchestrator managing business context and decision-making in one context window, while CODEX workers handle pure code generation in separate windows.
- Achieved **94 commits/day** with this architecture.
- Key insight: **context windows are zero-sum** — mixing business/orchestration context with code context degrades both. Separating them into distinct windows lets each agent focus on what it does best.
- Directly informed ADE's leader/worker model in the orchestrator: the orchestrator holds mission context (planning, coordination, decisions) while workers hold code context (file contents, test results, implementation details).

**Alex Finn's Multi-Machine Setup**:
- Runs **3 Mac Studios** as dedicated agent workers with a hybrid cloud/local strategy.
- Uses **local Qwen 3.5** (open-source model) for cost-sensitive tasks — significant cost savings for repetitive or lower-complexity work.
- **Ralph QA agent**: A dedicated QA agent that reviews other agents' work and can **edit other agents' memories** — writing corrections, adding gotchas, and updating procedures based on QA findings. This is a powerful pattern: one agent that improves other agents' future performance by maintaining their memory.
- Demonstrated that hybrid cloud/local model selection (expensive cloud models for complex tasks, local models for simple ones) is practical and cost-effective.
- Informed ADE's model-per-task-type routing and the future possibility of local model backends.

### 11.3 Factory Missions Findings (2026 review)

Primary source: https://factory.ai/news/missions

Factory Missions introduced several concrete execution patterns worth adopting in ADE's Phase 3 completion package:

1. Milestone-level validation before progression, not just final-task validation.
2. Fresh feature-scoped worker contexts to reduce context drift.
3. Targeted parallelism where dependencies are low, instead of blanket fan-out.
4. Clarifying-question planning pass before execution commitment.
5. Role-specialized mission execution with model routing by role.
6. Risk-scored command execution with auditable traces.

Program implication:

- These patterns map directly to Phase 3 Tasks 1-2 and 5 (team runtime model, validation contracts, mission policy flags, structured worker reporting, and HITL risk gates).
- Phase 4 should build CTO and ecosystem capabilities on top of these runtime foundations instead of duplicating them.

### 11.4 Virtual Me (V) Concept

The "Virtual Me" is a user-land concept where a personal AI agent (likely running on OpenClaw or similar) serves as the user's single entry point for all tasks — not just development. V delegates:
- Development tasks → ADE (via MCP/CTO agent)
- Research tasks → research agents
- Scheduling → calendar agents
- Communication → email/Slack agents

**Memory management for V** (relevant because V connects to ADE):
- **Importance classification**: V must filter small talk from actionable information. Not every conversation contains memories worth persisting. An importance classifier (LLM-based) scores incoming information on a 0-1 scale; only items above a threshold (e.g., 0.5) are considered for persistence.
- **Pre-compaction flush**: Same pattern as ADE agents — before V's context is compacted, a silent turn prompts V to save important memories. V's context includes a mix of development, personal, and coordination context, making selective persistence critical.
- **Temporal decay**: V's memories decay with the same 30-day half-life, but "reinforcement through access" is especially important for V because repeated topics (daily standup updates, recurring projects) should stay fresh.
- **Context separation from ADE**: V is not ADE's concern. V reads the repo to understand what happened (via git log, `.ade/` state files). ADE does not need to "report to V" — V observes ADE's outputs the same way a human developer would.
- **ADE provides infrastructure, not the agent**: The `.ade/` directory, MCP server, and CTO agent give V everything it needs to interact with ADE. The composition of V as a higher-level orchestrator is user-land.

### 11.5 Agent Communication Protocols

Protocols evaluated during research for inter-agent and agent-to-human communication:

**A2A Protocol (Google)**: Agent-to-agent discovery and communication protocol. Provides standardized agent capability advertisement and structured message exchange between agents from different platforms. Relevant for future scenarios where ADE agents need to discover and communicate with agents running on other platforms (not just via MCP tool calls, but via structured protocol). Not adopted in Phase 4 — MCP provides sufficient inter-platform communication for current needs. Candidate for Phase 8+ if multi-platform agent orchestration demand emerges.

**A2H Protocol (Twilio)**: Agent-to-human communication across channels (SMS, voice, chat, email). Provides standardized patterns for agents to reach humans through their preferred channel. Relevant for Phase 6 (Multi-Device Sync & iOS Companion) and for agents that need to notify users when interventions are needed. Currently, ADE uses IPC push events and (Phase 6) APNs for human communication. A2H patterns could inform a future multi-channel notification system.

**MCP Async Tasks**: Experimental MCP primitive for long-running agent work. Allows an MCP tool call to return immediately with a task ID, and the caller polls or subscribes for completion. Relevant for ADE's MCP server when external agents launch missions — missions are long-running and the current MCP request/response model blocks until completion. When the MCP async task spec stabilizes, ADE should adopt it for mission-launch and task-agent-launch tools.

### 11.6 Durable Execution Patterns

**Temporal / Inngest patterns**: Durable execution frameworks that provide crash-recoverable, resumable workflows. Key properties: automatic retries with configurable backoff, state persistence across process restarts, workflow versioning, and step-level idempotency.

ADE's orchestrator achieves similar properties through:
- **Deterministic state machine** (`orchestratorService.ts` + extracted modules `orchestratorQueries.ts`, `stepPolicyResolver.ts`, `orchestratorConstants.ts`): Tracks runs, steps, attempts, and claims with durable SQLite records.
- **Transcript persistence** (`attempt_transcripts` table): Full conversation history stored per attempt, enabling `resumeUnified()` after crashes.
- **Compaction summaries**: When context is compacted, the summary is stored as a resumable checkpoint.
- **Step-level retry**: Each step has configurable `maxRetries` with the orchestrator managing retry state.

ADE does not use Temporal or Inngest directly because: (1) adding a separate durable execution runtime increases deployment complexity for a desktop app, (2) SQLite + the orchestrator state machine already provides sufficient durability for the single-machine case, and (3) the orchestrator's resume capability (`resumeUnified()`) handles the most common crash-recovery scenario (app restart during mission). For the multi-machine case (Phase 6+), cr-sqlite sync handles cross-device state replication, and the brain/viewer architecture provides execution management.

### 11.7 Memory System Research Summary

Comprehensive research was conducted across the agent memory landscape. The following systems were evaluated, and specific patterns were adopted or adapted for ADE's memory architecture (detailed attribution in phase-4.md W16 "Prior Art & Design References"):

| System | Key Pattern Adopted | Benchmark / Finding |
|---|---|---|
| **MemGPT / Letta** | Three-tier memory (core/archival/recall), agent self-managed read/write | 74% accuracy with file operations (validates file-backed portable storage) |
| **Mem0** | PASS/REPLACE/APPEND/DELETE consolidation on every write | 68.5% accuracy on memory tasks |
| **CrewAI** | Composite scoring formula, RecallFlow multi-signal retrieval | Adopted with simplified weights (0.5/0.2/0.2/0.1) |
| **OpenClaw** | Pre-compaction flush (agent-driven persistence), hybrid BM25+vector search, MEMORY.md pattern | Validated agent-intelligence-based extraction over mechanical rules |
| **LangMem (LangChain)** | Episodic/procedural memory taxonomy, cross-episode pattern extraction | Procedural memories require multi-episode observation, not single-session |
| **A-MEM** | Zettelkasten-inspired automatic linking between memory entries | Deferred full graph navigation; implicit linking via APPEND consolidation |
| **JetBrains (NeurIPS 2025)** | Observation masking (placeholder replacement for old tool outputs) | Outperforms LLM summarization while being cheaper |
| **SOUL.md / CLAUDE.md** | Identity persistence via versioned Markdown/YAML files | Community-validated pattern; ADE formalizes with version history + audit |

**Key design decisions from research**:
- File-backed memory over database-only: Letta's 74% > Mem0's 68.5%, and file-backed enables git portability.
- Agent-driven pre-compaction flush over mechanical extraction: The agent understands its own context better than any rule-based system.
- Conservative 0.85 cosine similarity threshold for consolidation: False merges are worse than minor duplication.
- 30-day half-life for temporal decay: Balances freshness with stability — a month-old memory keeps 50% recency score.
- Observation masking over LLM summarization for old tool outputs: Cheaper, faster, and empirically better (JetBrains finding).
- Hybrid BM25+vector over pure vector: Code identifiers and error messages need exact keyword matching; pure vector misses these.

---

## 12. Program Definition of Done

The program is complete when:

- Missions launch complex workflows from plain language with AI-powered orchestration and auditable outcomes.
- AI orchestrator executes across lanes/processes/tests/PRs via MCP tools with robust recovery.
- Orchestrator decisions flow through the deterministic runtime with full context provenance.
- Agents collaborate via inter-agent messaging, shared facts, and run narrative (Hivemind infrastructure).
- Smart fan-out dynamically parallelizes work when meta-reasoner detects opportunities.
- Context compaction prevents overflow and supports durable session resume.
- Memory system tracks agent identities and promotes validated knowledge with confidence scoring.
- Play supports deterministic lane isolation.
- Missions use configurable phase pipelines with pre-flight validation and tiered quality gates.
- CTO agent provides persistent project-aware assistance with full memory and context.
- Automations support only time-based and action-based triggers.
- Automations execution types are `agent-session`, `mission`, and `built-in task`.
- Desktop, VPS, and iOS sync state in real-time via cr-sqlite. Any device can view and control; the brain runs agents.
- MCP server safely exposes ADE capabilities to the AI orchestrator and external agent ecosystems.
- VPS deployment enables always-on brain machines for unattended agent execution.
- cr-sqlite enables zero-cloud-dependency multi-device sync with CRDT conflict resolution.
- iOS companion app provides full participation in ADE workflows from mobile.
- Device pairing is one-time, and state is available offline on all devices.
- Learning packs automatically accumulate project-specific knowledge from agent interactions with confidence-based injection.
- Chat-to-mission escalation bridges interactive chat sessions with full mission orchestration.
- Lane isolation (env, ports, hostname, cookies) prevents cross-lane interference.
- All core features work in `guest` mode without any subscriptions.
