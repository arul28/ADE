# ADE Future Directions — Discussion Notes

> Summary of exploratory discussion on iOS integration, auto-rebase, MCP server,
> embedded coordinator agent, and ADE's position in the multi-agent landscape.
> February 2026.

---

## Table of Contents

1. [iOS / Mobile Integration](#1-ios--mobile-integration)
2. [Auto-Rebase Across Lanes](#2-auto-rebase-across-lanes)
3. [ADE MCP Server](#3-ade-mcp-server)
4. [Intent Registry & Conflict Prevention](#4-intent-registry--conflict-prevention)
5. [Embedded Coordinator Agent](#5-embedded-coordinator-agent)
6. [ADE vs. jj (Jujutsu)](#6-ade-vs-jj-jujutsu)
7. [Competitive Landscape (Feb 2026)](#7-competitive-landscape-feb-2026)
8. [ADE's Unique Differentiators](#8-ades-unique-differentiators)
9. [Recommended Build Order](#9-recommended-build-order)

---

## 1. iOS / Mobile Integration

### Problem

SSH-to-laptop works but is inefficient — requires the machine to be on, a stable
network path, and the phone UX is poor.

### Options Evaluated

#### Option A: Thin Client Against Hosted Agent (Lowest effort, ship first)

ADE already has an AWS backend (API Gateway, Lambda, S3, DynamoDB) that mirrors
packs, lane metadata, and PR status. An iOS app could consume this data directly.

**What it provides:**
- Lane list with status badges (from DynamoDB)
- Pack narrative viewer (from S3)
- Conflict risk overview (from mirrored conflict data)
- PR management (via GitHub API using existing Clerk OAuth tokens)
- Push notifications for conflict detection and PR events

**What it doesn't provide:**
- Live terminal access
- Direct file editing
- Git operations against local repo

**Tech stack:** SwiftUI + URLSession against API Gateway (or React Native for
future web dashboard code sharing).

#### Option B: Headless ADE Server + iOS Client (Best long-term play)

Separate ADE into two deployable artifacts:

1. **ADE Core Server** — extract the Electron main process into a standalone
   Node.js server. Expose ADE's 82+ IPC channels over WebSocket/REST.
2. **ADE iOS Client** — native SwiftUI app connecting to the server. Renders UI,
   sends commands, receives state updates.

This mirrors the VS Code → code-server → browser architecture.

**Why it's viable:** ADE's main process is already cleanly separated from the
renderer via typed IPC. The IPC channel contract IS the API — swap Electron IPC
for WebSocket messages.

**Terminal support:** PTYs run on the server; output streams to the phone (same
model as Termius, Blink Shell, a]Term).

**Challenges:**
- Extracting main process from Electron into standalone Node.js
- Auth/security for the WebSocket connection
- Network latency for terminal interactions
- Setup UX (users must run the server somewhere)

#### Option C: Hybrid — Hosted Agent + SSH for Terminals (Pragmatic v1)

Combine Options A and B at lower effort:

- ADE iOS app connects to hosted agent for lane status, packs, conflicts, PRs
- For terminal access, users configure SSH to their machine (like Termius)
- ADE iOS opens SSH sessions scoped to lane worktree paths

80% of value with 30% of the engineering.

#### Option D: Cloud-Native ADE (Longer term)

Run the core engine (lanes, git ops, terminals) in the cloud. Full ADE from any
device. Massive architectural shift — essentially competing with Codespaces/Gitpod
but with ADE's orchestration layer. Not recommended as a near-term priority.

### Rejected Approaches

- **isomorphic-git / libgit2 on iOS**: Technically possible but impractical. Phone
  storage/compute can't handle real repos. Not worth the effort.
- **Direct Electron port**: iOS doesn't allow Electron. No path here.

### Recommendation

Ship **Option C** (hosted agent + SSH terminals) as v1. Design the API contract
for **Option B** (headless server) in parallel. The IPC-to-WebSocket refactor is
the highest-leverage infrastructure investment for multi-platform support.

---

## 2. Auto-Rebase Across Lanes

### Concept

When a branch advances (lane merges to main, parent lane gets new commits,
external push), automatically rebase dependent lanes — but only when safe.

### Mechanism

ADE already has `git merge-tree` conflict prediction. Use it as a gate:

1. Branch advances (e.g., Lane A merges into main)
2. Job engine fires `headChanged` event
3. For each dependent lane, run `git merge-tree` simulation
4. **Clean result** → auto-rebase silently, update status to "rebased, up to date"
5. **Conflict result** → don't touch it, mark lane with badge: "rebase available,
   conflicts expected in [files]"

### Scenarios

**Scenario 1: Lane merges to main → sibling lanes rebase**

```
Before:                    After A merges:
main ──┬── Lane A         main (includes A) ──┬── Lane B (auto-rebased ✓)
       ├── Lane B                              ├── Lane C (auto-rebased ✓)
       ├── Lane C                              └── Lane D (flagged: conflicts)
       └── Lane D
```

**Scenario 2: Parent lane in stack advances → children rebase**

```
main ── auth (new commits) ── auth-ui (auto-restacked if clean)
```

Existing restack operation, but automatic.

**Scenario 3: Main advances from external push**

ADE detects main moved via fetch/polling. Same simulation logic. Auto-rebase
clean lanes, flag conflicting ones.

**Scenario 4: Cascade rebase in deep stacks**

```
main ── A ── B ── C
```

A merges to main → B rebases onto main → if clean, C rebases onto new B.
Cascade is sequential and **stops at the first conflict**. Don't rebase C onto
a conflicted B.

**Scenario 5: Multiple lanes merge simultaneously**

Job engine coalesces rebase jobs (already deduplicates). Dependent lanes rebase
once onto the final state, not once per merge.

### UX

- Lane list badges: "Rebased automatically" (green) or "Rebase available — N
  conflicts" (yellow)
- Notification when manual intervention needed
- Click badge → conflict preview → resolve or delegate to agent
- Project-level setting: "Auto-rebase: ON/OFF" (some teams want manual control)

### Implementation

- New job type: `autoRebase` triggered by `headChanged` on any lane
- Gate on existing `conflictService.simulateMerge()` result
- Sequential cascade with stop-on-conflict
- New lane status: `autoRebased | rebasePending | rebaseConflict`

---

## 3. ADE MCP Server

### Concept

Expose ADE's core services as MCP (Model Context Protocol) tools. Any
MCP-compatible agent (Claude Code, Cursor, Codex) can interact with ADE
programmatically — creating lanes, checking conflicts, claiming files, reading
packs, and orchestrating work.

### Why MCP

MCP is the de facto standard for agent-to-tool connectivity as of 2026:
- Adopted by Anthropic, OpenAI, Google, Microsoft
- Donated to Linux Foundation's Agentic AI Foundation (Dec 2025)
- Claude Code, Cursor, and Codex CLI all support MCP servers natively
- Building an MCP server means instant compatibility with every major agent

### Proposed Tool Surface

```
── Lane Management ──────────────────────────────────────────
ade.list_lanes()                    → all lanes with status, branch, parent
ade.create_lane(branch, parent?)    → create new lane (worktree)
ade.get_lane_status(lane)           → dirty/clean, ahead/behind, conflicts
ade.archive_lane(lane)              → archive completed lane
ade.update_lane_parent(lane, parent)→ reparent a lane (for stacking)

── Context & Packs ──────────────────────────────────────────
ade.get_project_pack()              → global project state snapshot
ade.get_lane_pack(lane)             → lane-specific context snapshot
ade.get_lane_diff(lane)             → current working tree diff summary

── Conflict System ──────────────────────────────────────────
ade.check_conflicts(lane)           → conflicts for this lane vs base and peers
ade.check_all_conflicts()           → pairwise conflict matrix summary
ade.run_merge_simulation(a, b)      → simulate merging two lanes

── Intent Registry (new) ────────────────────────────────────
ade.claim_files(lane, files[])      → register intent to modify files
ade.release_files(lane, files[]?)   → release claims (all if no files specified)
ade.get_claimed_files()             → all claims across all lanes
ade.check_claim_conflicts(files[])  → would claiming these conflict with existing?

── Git Operations ───────────────────────────────────────────
ade.stage_files(lane, files[])      → stage files in lane
ade.commit(lane, message)           → commit staged changes
ade.push(lane)                      → push lane's branch
ade.sync(lane, strategy?)           → fetch + merge/rebase from base

── Sessions ─────────────────────────────────────────────────
ade.spawn_session(lane, command)    → start terminal session in lane's worktree
ade.list_sessions(lane?)            → active/completed sessions
ade.get_session_status(session)     → running/exited, exit code, duration

── PRs ──────────────────────────────────────────────────────
ade.create_pr(lane, title, body?)   → create GitHub PR from lane
ade.get_pr_status(lane)             → checks, reviews, merge status
ade.land_pr(lane)                   → merge PR if checks pass
```

### Architecture

Two deployment options:

**Option 1: Standalone process (recommended for v1)**

```
┌────────────────┐     local socket     ┌──────────────┐
│  ADE Desktop   │◄───────────────────►│  ADE MCP     │
│  (Electron)    │     (or HTTP)        │  Server      │
└────────────────┘                      │  (Node.js)   │
                                        └──────┬───────┘
                                               │ stdio/SSE
                                               ▼
                                        ┌──────────────┐
                                        │  Agent       │
                                        │  (Claude     │
                                        │   Code, etc) │
                                        └──────────────┘
```

MCP server runs as a separate Node.js process. Communicates with ADE Desktop via
local socket or HTTP. Agents connect to the MCP server via stdio or SSE.

**Option 2: Embedded in Electron main process**

MCP server runs inside the Electron main process alongside existing services.
Simpler but tighter coupling. Could use stdio transport with the agent.

### Why This Matters

The MCP server turns ADE from "a tool you look at" into "infrastructure that
agents use." It's the difference between a dashboard and a platform.

---

## 4. Intent Registry & Conflict Prevention

### The Three Layers of Defense

```
Layer 1: INTENT REGISTRY (Prevention — before work starts)
  Agent calls ade.claim_files() before writing code.
  ADE checks for overlapping claims.
  Conflicts prevented before they happen.
  Cost: zero rework.

Layer 2: COORDINATION EVENTS (Detection — during work)
  File watcher detects unclaimed file modifications.
  ADE cross-references with other lanes' claims and changes.
  Fires event if overlap detected.
  Cost: low — caught early, minimal rework.

Layer 3: CONFLICT PREDICTION (Safety net — continuous)
  Existing merge-tree simulation.
  Runs on HEAD change and file modifications.
  Catches everything layers 1 and 2 missed.
  Cost: medium — conflict exists in code, needs resolution.
```

### Intent Registry Service Design

```typescript
// New service: intentService
interface FileClaim {
  laneId: string;
  filePath: string;
  claimedAt: Date;
  claimedBy?: string;  // agent/session identifier
}

interface IntentService {
  claimFiles(laneId: string, files: string[]): ClaimResult;
  releaseFiles(laneId: string, files?: string[]): void;
  getClaimsForLane(laneId: string): FileClaim[];
  getAllClaims(): FileClaim[];
  checkConflicts(files: string[]): ClaimConflict[];
}

interface ClaimResult {
  granted: string[];             // files successfully claimed
  conflicts: ClaimConflict[];    // files already claimed by others
}

interface ClaimConflict {
  filePath: string;
  claimedByLane: string;
  claimedAt: Date;
}
```

### How Claims Populate

- **Explicit**: Agent calls `ade.claim_files()` via MCP before starting work
- **Implicit**: As files are modified in a lane, ADE auto-registers soft claims
- **Predictive**: On session start, use Gemini Flash to predict likely files from
  task description (optional, low-stakes use of cheap model)

### Coordination Events

New event types for the job engine:

- `claimConflict`: Fired when a claim overlaps with existing claim
- `implicitOverlap`: Fired when file watcher detects unclaimed modification that
  overlaps with another lane
- `claimReleased`: Fired when a lane releases claims (work complete)

These events can trigger notifications, update lane badges, and inform the
coordinator (whether embedded or external via MCP).

---

## 5. Embedded Coordinator Agent

### Concept

Use the Claude Agent SDK (TypeScript) to embed a coordinator agent directly
inside ADE. This agent has direct access to all ADE services and can plan work,
create lanes, dispatch agents, monitor progress, and handle conflicts — all from
within ADE's own UI.

### Why This Is a Good Idea

- **Direct service access**: No MCP indirection. The coordinator calls
  `laneService.create()`, `conflictService.simulate()`, etc., directly.
- **Purpose-built UI**: ADE can render a coordination panel — task planner,
  progress view, lane assignment visualization.
- **Out of the box**: Users get orchestration without configuring external tools.
- **Full control**: You control the system prompt, tool definitions, and
  coordination logic.

### Why This Isn't Dumb (Comparison with MCP Approach)

| Dimension | Embedded Coordinator | MCP Server + External Agent |
|-----------|---------------------|-----------------------------|
| Setup | Zero config | User must configure MCP in their agent |
| Cost | Requires API key (BYOK) | User's existing agent subscription |
| Control | Full — you design the prompts | Dependent on agent's capabilities |
| Context | Lean — talks to services directly | Agent must read packs (extra tokens) |
| Flexibility | Fixed to your implementation | Works with any agent |
| UX | Integrated into ADE UI | External terminal/IDE |

### Architecture

```
┌─────────────────────────────────────────────────────┐
│  ADE Desktop (Electron)                             │
│                                                     │
│  ┌──────────────────────────────────────────────┐   │
│  │  Renderer                                    │   │
│  │  ┌──────────────────────────────────────┐    │   │
│  │  │  Coordinator Panel (new tab/panel)   │    │   │
│  │  │  - Chat interface                    │    │   │
│  │  │  - Task planner view                 │    │   │
│  │  │  - Lane assignment visualization     │    │   │
│  │  │  - Progress monitoring               │    │   │
│  │  └──────────────────────────────────────┘    │   │
│  └──────────────────────┬───────────────────────┘   │
│                         │ IPC                        │
│  ┌──────────────────────▼───────────────────────┐   │
│  │  Main Process                                │   │
│  │                                              │   │
│  │  ┌────────────────────┐  ┌────────────────┐  │   │
│  │  │  Coordinator       │  │  Existing      │  │   │
│  │  │  Service           │  │  Services      │  │   │
│  │  │  (Claude Agent SDK)│──│  (lanes, git,  │  │   │
│  │  │                    │  │   packs, etc.) │  │   │
│  │  └────────┬───────────┘  └────────────────┘  │   │
│  │           │                                   │   │
│  │           ▼                                   │   │
│  │  Spawns Claude Code / Codex sessions          │   │
│  │  in lane worktrees via ptyService             │   │
│  └──────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────┘
```

### The Coordinator's Workflow

```
User: "Build auth, products, and cart features in parallel"

Coordinator (Claude Agent SDK, running in ADE main process):
  1. Calls laneService.create("feature/auth", { parent: "main" })
  2. Calls laneService.create("feature/products", { parent: "main" })
  3. Calls laneService.create("feature/cart", { parent: "main" })
  4. Calls intentService.claimFiles("feature/auth", predicted_files)
  5. Calls intentService.claimFiles("feature/products", predicted_files)
  6. Calls intentService.claimFiles("feature/cart", predicted_files)
  7. Checks for claim conflicts → reroutes if needed
  8. Spawns agent sessions via ptyService in each lane
  9. Monitors via packService (reads packs as sessions complete)
  10. On conflict event → reads both packs, decides resolution strategy
  11. When all done → runs merge simulations → integrates in order
```

### Context Efficiency

The coordinator agent's context stays lean because:

- Pack narratives: ~300-500 tokens per lane
- Project pack: ~1000 tokens
- Intent registry state: ~200 tokens
- Conflict status: ~500 tokens
- **Total for 10 lanes: ~7000 tokens out of 200k window**

The coordinator never reads source code. Worker agents in each lane have their
own context windows for the actual code work.

### BYOK Requirement

The embedded coordinator requires an LLM API key. Support:
- Anthropic (Claude) — primary, via Claude Agent SDK
- OpenAI — via Agents SDK (alternative)
- User brings their own key (BYOK) — stored in OS keychain

### Recommendation: Build Both

1. **MCP server first** (lower effort, immediately useful, no API key cost)
2. **Embedded coordinator second** (premium feature, better UX, requires BYOK)
3. Both use the same underlying services — same intent registry, same conflict
   system, same pack infrastructure

---

## 6. ADE vs. jj (Jujutsu)

### Comparison

| Dimension | jj (Jujutsu) | ADE |
|-----------|-------------|-----|
| **What it is** | New VCS (replaces git CLI, uses git storage) | Orchestration layer on top of git |
| **Core innovation** | Conflicts as first-class state; auto-rebase; working copy is a commit | Lanes, packs, conflict prediction, agent handoffs |
| **Parallel work** | Automatic rebasing; conflicts stored, not blocking | Parallel worktrees + proactive merge-tree simulation |
| **Conflict model** | Commit conflicted state, resolve later | Predict conflicts before merge, propose AI resolution |
| **Agent awareness** | None | Purpose-built for agent orchestration |
| **Adoption cost** | Replace git CLI | Additive — works with existing git |

### Ideas Worth Borrowing from jj

- **Conflict-as-state**: Allow "tentative merges" that carry conflicts forward as
  tracked state rather than blocking the merge entirely.
- **Auto-rebase**: Continuous automatic rebasing when parent changes (see
  Section 2 above, adapted with ADE's conflict prediction as a safety gate).
- **Working copy as commit**: Every state is addressable. ADE's checkpoints
  approach this for session boundaries but could be more granular.

### Key Difference

jj fixes git's **data model**. ADE fixes git's **workflow model**. They're
complementary, not competitive. ADE could theoretically use jj as a backend, but
jj's adoption is too small to bet on.

---

## 7. Competitive Landscape (Feb 2026)

### First-Party Agent Orchestrators

| Product | What It Does | Status |
|---------|-------------|--------|
| **Claude Code Agent Teams** | One CC session as team lead, coordinates workers. Inter-agent communication. | Experimental (Feb 2026) |
| **OpenAI Codex App** | macOS desktop "command center." Multiple agents in isolated worktrees. Auditable traces. | Launched Feb 2026 |
| **VS Code Background Agents** | Background agents in dedicated worktrees. Multiple simultaneous. | Stable (v1.107, Nov 2025) |
| **Intent (Augment)** | Coordinator → specialist → verifier pattern. Supports external agents. | Available |
| **Warp Oz** | Cloud platform for running/managing coding agents. CLI + API. | Available |

### Community Orchestrators

| Tool | Approach |
|------|----------|
| **Claude Squad** | tmux multiplexer for parallel Claude Code instances |
| **ccswarm** | Multi-agent orchestration with specialized agent pools (Frontend, Backend, DevOps, QA) |
| **Claude Flow** | MCP-based orchestration, supports Codex CLI |
| **Zerg** | Production infrastructure for parallel Claude Code |
| **wt** | Lightweight git worktree orchestrator for agent workflows |

### Agent SDKs (for building embedded agents)

| SDK | Language | Can Embed in Desktop App? |
|-----|----------|--------------------------|
| **Claude Agent SDK** | Python, TypeScript | Yes — claude-agent-desktop exists as proof |
| **OpenAI Agents SDK** | Python, Node.js | Yes — Codex App is itself a desktop app |
| **ChatKit (OpenAI)** | React, Vue, Angular | Yes — designed for building chat UIs |

### What Exists vs. What Doesn't

**Genuinely exists and works:**
- Running parallel agents in git worktrees (manual or with tools)
- Claude Code Agent Teams (experimental but functional)
- Codex App multi-agent orchestration
- Claude Agent SDK / OpenAI Agents SDK for custom agents
- MCP as standard for tool connectivity

**Nascent / rough-edged:**
- Cross-tool coordination (Claude + Codex + Cursor together)
- Session resumption and fault tolerance
- Unified monitoring dashboard

**Does not exist:**
- Proactive conflict prediction across parallel agents
- File-level intent registry / claim system
- Pack-style durable context snapshots for agent handoffs
- Heterogeneous agent coordination on a single platform
- Conflict prevention (not just detection) across sessions

---

## 8. ADE's Unique Differentiators

Given the competitive landscape, ADE's defensible advantages are:

1. **Conflict prediction system** — nobody else runs proactive merge-tree
   simulations across parallel workstreams. Everyone discovers conflicts at merge
   time.

2. **Pack system** — durable, versioned, LLM-friendly context snapshots. No other
   tool generates structured handoff documents between agent sessions.

3. **Intent registry** (proposed) — file-level claim system for preventing
   conflicts before code is written. Entirely novel.

4. **Unified cockpit** — single dashboard showing all lanes, conflicts, packs,
   PRs, terminal sessions. Other tools are either CLI-only or single-purpose.

5. **Agent-agnostic** — works with any agent (Claude, Codex, Cursor, Devin).
   Most orchestrators are locked to one agent ecosystem.

6. **MCP server** (proposed) — turns ADE into coordination infrastructure that
   any agent can use. The combination of MCP tools + intent registry + conflict
   prediction doesn't exist anywhere.

### What ADE Is NOT Competing On

- Not competing on being an agent (Devin, Factory)
- Not competing on being an IDE (Cursor, VS Code)
- Not competing on being a VCS (jj, Sapling)
- Competing on being the **orchestration and coordination layer** for parallel
  agentic development

---

## 9. Recommended Build Order

Priority ordering based on value, effort, and competitive positioning:

### Phase Next-A: ADE MCP Server

**Effort:** Medium | **Value:** Very High | **Why first:** Immediately useful,
makes ADE a platform, no API key cost, instant compatibility with Claude Code /
Cursor / Codex.

Deliverables:
- [ ] MCP server process (Node.js, stdio + SSE transport)
- [ ] Lane management tools (list, create, status, archive)
- [ ] Pack reading tools (project pack, lane pack)
- [ ] Conflict tools (check, simulate, matrix)
- [ ] Git operation tools (stage, commit, push, sync)
- [ ] Session tools (spawn, list, status)
- [ ] PR tools (create, status, land)
- [ ] Documentation and agent prompt templates

### Phase Next-B: Intent Registry

**Effort:** Low-Medium | **Value:** High | **Why:** Unique differentiator. Makes
conflict prevention possible. Natural complement to MCP server.

Deliverables:
- [ ] `intentService` with claim/release/check operations
- [ ] SQLite table for file claims
- [ ] Implicit claim registration via file watcher
- [ ] MCP tools for intent operations
- [ ] Coordination events in job engine
- [ ] Lane badge updates for claim conflicts
- [ ] UI: claim visualization in lane detail

### Phase Next-C: Auto-Rebase

**Effort:** Low | **Value:** Medium | **Why:** Leverages existing conflict
prediction. Small delta on existing restack logic.

Deliverables:
- [ ] `autoRebase` job type in job engine
- [ ] Merge-tree gate (only rebase if clean)
- [ ] Cascade logic with stop-on-conflict
- [ ] Lane status: `autoRebased | rebasePending | rebaseConflict`
- [ ] Notification for manual-intervention-needed
- [ ] Project setting: auto-rebase on/off

### Phase Next-D: Embedded Coordinator Agent

**Effort:** High | **Value:** Very High | **Why:** Premium feature, best UX,
but requires API key and more engineering.

Deliverables:
- [ ] Claude Agent SDK integration in main process
- [ ] Coordinator service with tool definitions (maps to ADE services)
- [ ] BYOK API key management (Anthropic, OpenAI)
- [ ] Coordinator UI panel (chat, task planner, lane assignment, progress)
- [ ] Worker agent spawning via ptyService
- [ ] Pack-based monitoring loop
- [ ] Conflict mitigation strategies (reroute, sequence, reparent, split)

### Phase Next-E: iOS App v1

**Effort:** Medium | **Value:** Medium | **Why:** Ship monitoring/triage app
against existing hosted agent backend.

Deliverables:
- [ ] SwiftUI app connecting to existing API Gateway
- [ ] Lane list with status badges
- [ ] Pack narrative viewer
- [ ] Conflict risk overview
- [ ] PR management (create, review, land)
- [ ] Push notifications (conflict detection, PR events)
- [ ] SSH terminal integration (configurable remote host)

### Phase Next-F: Headless ADE Server

**Effort:** Very High | **Value:** Very High | **Why:** Enables true
multi-platform support. Biggest architectural investment.

Deliverables:
- [ ] Extract main process services into standalone Node.js server
- [ ] WebSocket API matching IPC channel contract
- [ ] Authentication and session management
- [ ] iOS client upgrade to full-featured thin client
- [ ] Web client (optional, reuse renderer components)
- [ ] Docker deployment option

---

## Open Questions

1. **MCP transport**: stdio (simplest, one agent at a time) vs SSE (multiple
   agents, more complex)? Start with stdio, add SSE later?

2. **Intent registry granularity**: File-level claims or directory-level? File
   is more precise but noisier. Could support both with a glob pattern system.

3. **Coordinator model selection**: Claude Agent SDK only, or also support
   OpenAI Agents SDK? Starting with one reduces complexity.

4. **Auto-rebase safety**: Should there be a "dry run" notification before
   auto-rebasing, or just do it and show a badge? Lean toward just doing it
   for clean cases (the whole point is reducing friction).

5. **iOS app scope**: Monitor-only v1, or include terminal SSH from day one?
   SSH adds significant complexity but is the most requested feature.

6. **Pricing model**: Embedded coordinator uses the user's API key (BYOK). But
   should ADE offer a hosted coordinator option using ADE's own API quota for
   paying users?
