# Security & Privacy Architecture

> Roadmap reference: `docs/final-plan.md` is the canonical future plan and sequencing source.

> Last updated: 2026-02-19

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
| GitHub PAT (local) | `.ade/local.yaml` (gitignored) | Plaintext on disk (protected by OS file permissions) |

ADE does not store any API keys or authentication tokens. AI features are powered by CLI tools (Claude Code, Codex) that manage their own authentication independently.

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
| Confidence heuristics for proposals | Done | Confidence scoring (high/medium/low) displayed in ConflictsPage proposal list |

**Overall status**: DONE. Core local security model (process isolation, preload bridge, config trust, operation tracking, path validation, force push safety, secret redaction, proposal confidence) is fully implemented. ADE is a local-only application with no cloud backend — AI features are powered by local CLI tools via the agent SDKs (AgentExecutor interface).
