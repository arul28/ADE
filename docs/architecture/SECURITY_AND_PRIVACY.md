# Security & Privacy Architecture

> Roadmap reference: `docs/final-plan/README.md` is the canonical future plan and sequencing source.

> Last updated: 2026-03-15

This document describes how ADE protects user data, source code, and development workflows. ADE is a fully local-first desktop application — all code, configuration, and AI processing remain on the user's machine.

---

## Table of Contents

- [Overview](#overview)
- [Design Decisions](#design-decisions)
- [Technical Details](#technical-details)
  - [Core Security Principles](#core-security-principles)
  - [Process Isolation (Electron)](#process-isolation-electron)
  - [IPC Security](#ipc-security)
  - [Secret Protection](#secret-protection)
  - [Configuration Trust](#configuration-trust)
  - [Proposal Safety](#proposal-safety)
  - [Git Safety](#git-safety)
  - [Audit Trail](#audit-trail)
- [Integration Points](#integration-points)
- [Implementation Status](#implementation-status)

---

## Overview

ADE's security architecture is built on the principle of local-first data sovereignty. All source code, configuration, and development state remain on the user's machine. No data leaves the local environment unless the user explicitly invokes an AI-powered feature, in which case the Vercel AI SDK spawns local CLI tools (Claude Code, Codex) that communicate with their respective services using the user's own existing subscriptions.

The architecture addresses threats across multiple layers: process isolation within the Electron application, secret protection in AI context exports, command trust for shared configuration, and proposal safety for AI-generated changes.

---

## Design Decisions

### Why Local-First?

Developers' source code is their most sensitive asset. Cloud-first architectures require users to trust a third party with their entire codebase, which is unacceptable for many organizations and individuals. ADE keeps everything local — AI features are powered by spawning CLI tools that the developer already has installed and subscribed to, using the Vercel AI SDK. No ADE-operated cloud service ever sees the user's code.

### Why Strict Process Isolation?

Electron applications that grant the renderer process full Node.js access are vulnerable to cross-site scripting (XSS) attacks that can escalate to arbitrary code execution. If a malicious payload reaches the renderer (e.g., through a rendered markdown preview or a terminal escape sequence), it could access the file system, execute commands, or exfiltrate data. ADE's architecture ensures the renderer has zero direct system access, with all operations mediated through a typed IPC allowlist.

### Why SHA-Based Config Trust Over Signing?

The threat model for configuration trust is not a sophisticated attacker forging commits, but a careless or malicious change to shared config that introduces unwanted shell commands. SHA comparison detects any modification and prompts for user review, which is sufficient for this threat model. GPG or code signing would add significant key management complexity for marginal additional security.

### Why Operation-Level Audit Trails?

Git commit history captures the "what" of changes but not the "how" or "why" at the operational level. ADE's audit trail records every operation (branch creation, merge, discard, apply-proposal) with timestamps, pre/post state references, and metadata. This enables precise undo, debugging of unexpected state, and compliance with organizational audit requirements.

---

## Technical Details

### Core Security Principles

The following five principles guide all security-related design decisions in ADE:

| Principle | Description |
|-----------|-------------|
| **Local-first** | All code stays on the user's machine. AI runs locally via CLI tools (Claude Code, Codex) using existing subscriptions through the Vercel AI SDK. No ADE-operated cloud service is involved. |
| **Least privilege** | The renderer process has zero direct system access. The main process services expose only typed, validated operations through a strict IPC allowlist. |
| **AI via local CLI** | AI features are powered by spawning `claude` and `codex` CLI processes locally. ADE never holds or transmits API keys — CLI tools use their own authenticated sessions. |
| **Audit trail** | Every operation is recorded with timestamps, SHA transitions, and metadata for full traceability and undo capability. |
| **Reversibility** | Git operations track pre/post HEAD SHA. Destructive operations require confirmation. Operations can be undone through the operation timeline. |

### Process Isolation (Electron)

ADE enforces strict separation between the main process (trusted) and the renderer process (untrusted).

```
┌─────────────────────────────────────────────────────────────┐
│                     Main Process (Trusted)                   │
│                                                             │
│  Full Node.js access:                                       │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  │
│  │ File I/O │  │  PTY     │  │  Git     │  │  SQLite  │  │
│  │ Service  │  │  Service │  │  Service │  │  (kvDb)  │  │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘  │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐  │
│  │              Preload Script (Bridge)                  │  │
│  │  contextBridge.exposeInMainWorld("ade", { ... })     │  │
│  │  Strict IPC allowlist — only typed operations        │  │
│  └──────────────────────────────────────────────────────┘  │
├─────────────────────────────────────────────────────────────┤
│                   Renderer Process (Untrusted)              │
│                                                             │
│  React application:                                         │
│  - No require() available                                  │
│  - No remote module                                        │
│  - No direct file/process/network access                   │
│  - Can ONLY call window.ade.* methods                      │
│  - Content Security Policy enforced                        │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

**BrowserWindow configuration**:

```typescript
const mainWindow = new BrowserWindow({
  webPreferences: {
    nodeIntegration: false,        // No Node.js in renderer
    contextIsolation: true,        // Separate contexts for preload and renderer
    sandbox: false,                // Required for preload functionality
    preload: path.join(__dirname, "preload.js"),
  },
});
```

**Content Security Policy**:

The CSP restricts what the renderer can load and execute:

- `default-src 'self'` — Only load resources from the app origin
- `script-src 'self'` — No inline scripts, no eval
- `style-src 'self' 'unsafe-inline'` — Allow inline styles (required for Tailwind)
- `connect-src 'self'` — No external network requests from renderer
- `img-src 'self' data:` — Allow local and data URI images

### IPC Security

All communication between the renderer and main process goes through a typed IPC allowlist defined in the preload script. The renderer cannot invoke arbitrary IPC channels.

**Allowlist structure**:

```typescript
// preload.ts — only these operations are exposed
contextBridge.exposeInMainWorld("ade", {
  // Project operations
  openRepo: () => ipcRenderer.invoke("open-repo"),
  getProject: () => ipcRenderer.invoke("project:get"),

  // Lane operations
  getLanes: () => ipcRenderer.invoke("lanes:list"),
  createLane: (args) => ipcRenderer.invoke("lanes:create", args),

  // Terminal operations
  ptySpawn: (args) => ipcRenderer.invoke("pty:spawn", args),
  ptyWrite: (args) => ipcRenderer.invoke("pty:write", args),
  ptyKill: (id) => ipcRenderer.invoke("pty:kill", id),

  // Config operations
  configGet: () => ipcRenderer.invoke("config:get"),
  configSave: (args) => ipcRenderer.invoke("config:save", args),
  configConfirmTrust: (args) => ipcRenderer.invoke("config:confirmTrust", args),

  // Event subscriptions
  onPtyData: (cb) => ipcRenderer.on("pty.data", cb),
  onLanesChanged: (cb) => ipcRenderer.on("lanes.changed", cb),
});
```

**Validation**: Every IPC handler in the main process validates its arguments against expected types and constraints before processing. Invalid arguments result in a structured error response, never a crash.

### Secret Protection

ADE implements multiple layers of protection to prevent secrets from being exposed or committed.

#### Secret Storage

| Secret Type | Storage Location | Encryption |
|-------------|-----------------|------------|
| GitHub PAT (local) | `.ade/secrets/github/github-token.v1.bin` | Encrypted with Electron `safeStorage` |
| API provider keys | `.ade/secrets/api-keys.json` | Plaintext on disk with `0600` permissions |
| Sync site identity | `.ade/secrets/sync-site-id` | Plaintext (never syncs, used as cr-sqlite site ID) |
| Sync device identity | `.ade/secrets/sync-device-id` | Plaintext (stable machine-local device ID) |
| Sync bootstrap token | `.ade/secrets/sync-bootstrap-token` | Plaintext (shared pairing token for desktop-to-desktop connection) |

ADE keeps CLI-backed authentication with the tools themselves (Claude Code, Codex). When ADE stores local secrets for secret-backed integrations, they remain on disk under the machine-local `.ade/secrets/` area or in `.ade/local.secret.yaml`. Sync-related secrets (site ID, device ID, bootstrap token) are machine-specific and never replicated via cr-sqlite. See [MULTI_DEVICE_SYNC.md](./MULTI_DEVICE_SYNC.md) for the full sync security model.

#### AI Context Exports (Bounded Payloads)

When AI features are invoked via the Vercel AI SDK, ADE's inputs are **token-budgeted context exports**, not raw pack dumps or transcript slabs.

- Lane narrative generation uses `LaneExportStandard` (bounded).
- Conflict proposals use `LaneExportLite` (lane + optional peer) and `ConflictExportStandard` (bounded).

Before any AI invocation, ADE applies redaction to export content to reduce the risk of leaking secrets embedded in code or configuration.

#### Redaction Rules

ADE applies redaction rules to strip potential secrets from context sent to AI tools:

- Environment variable values matching common secret patterns (`*_KEY`, `*_SECRET`, `*_TOKEN`, `*_PASSWORD`)
- Strings matching known token formats (JWT patterns, API key prefixes)
- Custom redaction patterns configurable in `.ade/ade.yaml` under `ai.redact`

### Configuration Trust

See [CONFIGURATION.md](./CONFIGURATION.md) for the full trust model specification.

**Summary**: Process and test commands defined in `ade.yaml` (shared config) require explicit user approval before execution. Trust is tracked via SHA-256 hash comparison. Changes to the shared config invalidate trust and prompt the user for re-approval. Commands in `local.yaml` (personal config) are always trusted.

### Proposal Safety

When the AI orchestrator generates proposals (conflict resolutions, PR descriptions) via the Vercel AI SDK, the following safety measures ensure the user maintains full control.

**Preview before apply**: All proposals are displayed as diffs in the desktop UI before any changes are made to the repository. The user explicitly chooses to apply or discard each proposal.

**Operation recording**: When a proposal is applied, an operation record is created with:

- Pre-apply state (HEAD SHA, working tree hash)
- Post-apply state (new HEAD SHA, modified files)
- The proposal content itself
- Timestamp and source (which task generated the proposal)

**Undo capability**: Operations can be undone through the operation timeline. Undo restores the pre-apply state using the recorded SHA references.

**Confidence heuristics**: Proposals include a confidence indicator:

| Confidence | Criteria | UI Treatment |
|------------|----------|-------------|
| High | Small, isolated changes; tests pass after apply | Green indicator, "Apply" button prominent |
| Medium | Moderate changes; no test regressions | Yellow indicator, review encouraged |
| Low | Wide-ranging changes; semantic conflicts; no tests | Red indicator, "Needs Review" label, apply requires confirmation |

### Git Safety

ADE enforces several safety measures for git operations to prevent accidental data loss.

#### Path Validation

All file operations validate that the target path is within the lane's root directory. This prevents directory traversal attacks where a malicious proposal could attempt to modify files outside the expected scope.

```typescript
function validatePath(lanePath: string, targetPath: string): boolean {
  const resolved = path.resolve(lanePath, targetPath);
  return resolved.startsWith(path.resolve(lanePath));
}
```

#### Branch Protection

- The primary lane can be configured as "protected," preventing direct commits (force push through pull requests only).
- Force push uses `--force-with-lease`, never `--force`, to prevent overwriting others' work.
- Destructive operations (discard changes, hard reset) require explicit user confirmation in the UI.

#### Operation Tracking

Every git operation records:

| Field | Description |
|-------|-------------|
| `operationId` | Unique identifier (ULID) |
| `type` | Operation type (commit, merge, rebase, discard, apply-proposal) |
| `preHeadSha` | HEAD SHA before the operation |
| `postHeadSha` | HEAD SHA after the operation |
| `laneId` | Lane where the operation occurred |
| `timestamp` | ISO 8601 timestamp |
| `metadata` | Operation-specific details |

### Audit Trail

The audit trail provides a complete record of significant operations for debugging, undo, and compliance purposes.

**Storage**: Operations are stored in the SQLite database (`kvDb.ts`) in a dedicated table with indexed timestamps and lane IDs.

**Retention**: Local audit trail is retained indefinitely (until the user explicitly clears it or deletes the `.ade/` directory).

**Queryable fields**: Operations can be queried by lane, time range, operation type, or SHA reference. The History page in the UI provides a visual timeline of operations.

### Memory Scoping and Promotion Policy

The memory architecture introduces scoped knowledge namespaces that agents can read and write under policy. Security controls ensure memory cannot leak across projects, runs, or identity boundaries.

#### Memory Scoping Rules

The unified memory system uses three scopes (defined as `UnifiedMemoryScope` in `unifiedMemoryService.ts`):

| Scope | Visibility | Write Access | Examples |
|-------|-----------|-------------|----------|
| `project` | All runtimes in the project (policy filtered) | Agents with active claims and policy grant | Conventions, architecture decisions, dependency notes |
| `agent` | Runtimes using the same agent definition/identity | Policy-filtered by identity ownership (`scope_owner_id` = agent ID) | Agent-specific preferences, procedures, learned patterns |
| `mission` | Runtimes in the current mission/run | Agents in the run (`scope_owner_id` = run/mission ID) | Shared facts, blockers, dependencies, mission-specific context |

Legacy scope names (`user`, `lane`) are normalized to `agent` and `mission` respectively by `normalizeScope()` in `unifiedMemoryService.ts`.

CTO core memory coexists as a separate always-in-context system outside the three-scope model.

**Cross-project isolation**: Memories are strictly scoped to a single project via `project_id`. There is no mechanism for memories to leak between projects. Each project's `.ade/ade.db` contains its own independent memory store.

**Agent identity scoping**: Memories with scope `agent` are tagged with a `scope_owner_id` matching the agent definition. They are injected only for runtimes bound to that identity (subject to policy). This prevents one identity's learned biases from affecting unrelated agents.

**CTO and worker threads**: CTO conversations (CTO tab) and worker runtime threads are not automatically merged into mission transcripts. Promotion into durable memory requires explicit scoped writeback rules.

#### Candidate Memory Promotion Policy

Memories follow a lifecycle: `candidate` --> `promoted` --> `archived`. This prevents low-quality or speculative information from being permanently injected into runtime context.

| Status | Injected into Prompts | Source | Transition Criteria |
|--------|----------------------|--------|-------------------|
| `candidate` | No (unless explicitly requested) | Agent-created during runs | Auto-promoted if confidence >= threshold, or manually promoted |
| `promoted` | Yes (scope/policy filtered) | Auto-promotion or user action | Archived by user/policy when stale or superseded |
| `archived` | No | User action or system policy | Can be restored by explicit user action |

**Confidence scoring**: Candidate memories include a `confidence` field (0.0-1.0) set by the creating agent. Only memories with confidence >= the configurable threshold (`ai.orchestrator.memory.auto_promote_threshold`, default 0.8) are auto-promoted. This prevents speculative or uncertain observations from entering the project knowledge base.

**Staleness policy**: Candidate memories older than `max_candidate_age_hours` (default 168 hours / 7 days) are automatically archived. This prevents accumulation of stale, unreviewed candidate memories.

**User oversight**: The Context Budget Panel in the UI displays candidate memories awaiting promotion. Users can review, promote, or archive candidates manually. All promotion and archival actions are logged for audit.

**Redaction**: Memory content is subject to the same secret redaction rules applied to all AI context exports. Memories containing detected secret patterns are redacted before injection into prompts.

---

## Integration Points

### Electron Main Process

- **BrowserWindow config**: `nodeIntegration: false`, `contextIsolation: true`, CSP headers
- **Preload script**: Typed IPC allowlist via `contextBridge.exposeInMainWorld`
- **IPC handlers**: Argument validation on every handler in `registerIpc.ts`

### Configuration System

- **Trust model**: SHA-based approval for shared config commands (see [CONFIGURATION.md](./CONFIGURATION.md))
- **Validation**: Schema validation prevents malformed config from being saved

### AI Orchestrator

- **Vercel AI SDK**: Spawns `claude` and `codex` CLI processes for AI tasks
- **MCP Server**: Exposes ADE tools to the AI orchestrator
- **Redaction**: Secret patterns stripped from context exports before AI invocation
- **Bounded exports**: Token-budgeted context payloads prevent excessive data exposure
- **Memory scoping**: Promoted memories and shared facts injected into agent prompts with project/run-level isolation
- **Compaction writeback**: Facts extracted before context compaction to prevent knowledge loss

### Git Operations

- **Path validation**: All operations scoped to lane root directory
- **Force push safety**: `--force-with-lease` only
- **Operation tracking**: Pre/post SHA recorded for undo capability
- **History service**: Stores operations in SQLite for audit trail

---

## Implementation Status

| Component | Status | Notes |
|-----------|--------|-------|
| Process isolation (Electron) | Done | `nodeIntegration: false`, `contextIsolation: true` |
| Preload bridge (typed IPC allowlist) | Done | `contextBridge.exposeInMainWorld` with strict channels |
| Content Security Policy | Done | Enforced in BrowserWindow |
| IPC argument validation | Done | All handlers validate inputs |
| Config trust model | Done | SHA-based approval in SQLite kv table |
| Operation tracking (audit trail) | Done | Pre/post SHA recorded for git operations |
| Path validation for file operations | Done | Lane root scoping enforced |
| Force push safety (`--force-with-lease`) | Done | Hard-coded in git service |
| Secret redaction rules | Done | `redactSecrets()` and `redactSecretsDeep()` in `apps/desktop/src/main/utils/redaction.ts`; applied to all outbound AI context payloads |
| Confidence heuristics for proposals | Done | Confidence scoring (high/medium/low) displayed in the Graph conflict panel and proposal flows |
| Memory scoping (project-level isolation) | Done | Memories scoped by project_id, no cross-project leakage |
| Candidate memory promotion policy | Done | Confidence-based auto-promotion, staleness archival, user oversight via Context Budget Panel |
| Memory content redaction | Done | Secret redaction rules applied to memory content before prompt injection |
| Shared facts scoping (run-level isolation) | Done | Shared facts scoped to orchestrator run via run_id |

**Overall status**: DONE. Core local security model (process isolation, preload bridge, config trust, operation tracking, path validation, force push safety, secret redaction, proposal confidence, memory scoping, memory promotion policy) is fully implemented. ADE is a local-only application with no cloud backend — AI features are powered by local CLI tools via the agent SDKs (AgentExecutor interface).

---

## Brain Deployment Trust Model

Compute-backend abstraction was dropped with Phase 5.5. The current and planned trust model is simpler:

| Deployment | Trust Level | Data Location | Network Access | Credential Handling |
|-----------|-------------|---------------|----------------|-------------------|
| Local brain | Full trust | On-device | Host network | OS keychain / local secret files |
| User-owned VPS brain (planned Phase 6) | Controlled trust | Remote machine the user operates | User-managed network path (for example Tailscale) | Machine-local secret files / keychain equivalent |

Current guidance:
- Sensitive/proprietary code: local brain by default.
- Always-on unattended execution: future user-owned VPS brain, not a managed ADE compute backend.
- Third-party managed sandboxes such as Daytona are not part of the active ADE architecture or roadmap.

## Per-Lane Proxy Security

The per-lane hostname proxy (*.localhost) provides security isolation:

- **Cookie Isolation**: Each lane hostname is a separate origin — browsers enforce cookie separation automatically
- **Auth State Isolation**: OAuth redirects target lane-specific hostnames, preventing cross-lane auth confusion
- **Port Isolation**: Each lane gets a dedicated port range, preventing port collisions
- **No Cross-Lane Access**: Proxy only routes to the lane matching the Host header — no lane can access another's dev server

The proxy runs locally and does not expose any ports externally. All *.localhost traffic stays on the loopback interface.
