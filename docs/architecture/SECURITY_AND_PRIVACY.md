# Security & Privacy Architecture

> Last updated: 2026-02-11

This document describes how ADE protects user data, source code, and development workflows across both the local desktop application and the optional hosted cloud services.

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
  - [Hosted Mirror Security](#hosted-mirror-security)
  - [Transcript Privacy](#transcript-privacy)
  - [Proposal Safety](#proposal-safety)
  - [Git Safety](#git-safety)
  - [Audit Trail](#audit-trail)
- [Integration Points](#integration-points)
- [Implementation Status](#implementation-status)

---

## Overview

ADE's security architecture is built on the principle of local-first data sovereignty. All source code, configuration, and development state remain on the user's machine by default. No data leaves the local environment without explicit, informed consent. When cloud features are enabled, a strict read-only contract ensures the hosted service can never modify the user's repository.

The architecture addresses threats across multiple layers: process isolation within the Electron application, secret protection during mirror uploads, command trust for shared configuration, and proposal safety for AI-generated changes.

---

## Design Decisions

### Why Local-First?

Developers' source code is their most sensitive asset. Cloud-first architectures require users to trust a third party with their entire codebase, which is unacceptable for many organizations and individuals. By making cloud features strictly opt-in and read-only, ADE provides the benefits of AI-assisted development without requiring users to relinquish control of their code.

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
| **Local-first** | All code stays on the user's machine by default. No data leaves without explicit opt-in. Cloud features are additive, never required. |
| **Least privilege** | The renderer process has zero direct system access. The main process services expose only typed, validated operations through a strict IPC allowlist. |
| **Read-only cloud** | The hosted agent NEVER mutates the repository. All proposals are previewed locally and applied under user control. |
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

ADE implements multiple layers of protection to prevent secrets from being exposed, uploaded, or committed.

#### Default Exclude Patterns

The following patterns are excluded from hosted mirror uploads by default:

| Category | Patterns |
|----------|----------|
| Environment files | `.env`, `.env.*`, `.env.local`, `.env.production` |
| Private keys | `*.pem`, `*.key`, `*.p12`, `*.pfx` |
| Certificates | `*.cert`, `*.crt`, `*.ca-bundle` |
| Credential files | `credentials.json`, `service-account.json`, `keyfile.json` |
| Token files | `.npmrc` (may contain tokens), `.pypirc`, `.docker/config.json` |
| SSH keys | `id_rsa`, `id_ed25519`, `*.pub` (in `.ssh/`) |
| Cloud configs | `aws-credentials`, `.aws/credentials` |

#### Secret Storage

| Secret Type | Storage Location | Encryption |
|-------------|-----------------|------------|
| Hosted Clerk OAuth tokens | OS keychain (macOS Keychain, Windows Credential Manager, Linux Secret Service) | OS-level encryption |
| BYOK API keys | `.ade/local.yaml` (gitignored) | Plaintext on disk (protected by OS file permissions) |
| Clerk OAuth tokens | Memory (access/ID) + OS keychain (refresh) | OS-level encryption for refresh token |

**Important**: API keys for BYOK providers must ONLY be placed in `local.yaml`, never in `ade.yaml`. The config validation system warns if it detects an `apiKey` field in the shared config file.

#### Redaction Rules

When uploading content to the hosted mirror, ADE applies redaction rules to strip potential secrets from transcripts and file contents:

- Environment variable values matching common secret patterns (`*_KEY`, `*_SECRET`, `*_TOKEN`, `*_PASSWORD`)
- Strings matching known token formats (JWT patterns, API key prefixes)
- Custom redaction patterns configurable in `.ade/ade.yaml` under `mirror.redact`

#### AI Job Payloads (Bounded Exports)

When Hosted or BYOK is enabled, ADE’s default LLM inputs are **token-budgeted context exports**, not raw pack dumps or transcript slabs.

- Lane narrative generation uses `LaneExportStandard` (bounded).
- Conflict proposals use `LaneExportLite` (lane + optional peer) and `ConflictExportStandard` (bounded).

Before any outbound request (Hosted or BYOK), ADE applies redaction to export content to reduce the risk of leaking secrets.

Notes:
- Guest mode remains fully functional: packs/events/versions/checkpoints/exports are generated deterministically without any network calls.
- Hosted can be self-hosted by configuring `providers.hosted.apiBaseUrl` in `.ade/local.yaml`; diagnostics should reference `apiBaseUrl` and `remoteProjectId` (no AWS assumptions).

### Configuration Trust

See [CONFIGURATION.md](./CONFIGURATION.md) for the full trust model specification.

**Summary**: Process and test commands defined in `ade.yaml` (shared config) require explicit user approval before execution. Trust is tracked via SHA-256 hash comparison. Changes to the shared config invalidate trust and prompt the user for re-approval. Commands in `local.yaml` (personal config) are always trusted.

### Hosted Mirror Security

When the optional cloud features are enabled, the following security measures protect uploaded data.

#### Encryption

| Layer | Method | Details |
|-------|--------|---------|
| At rest | S3 SSE-S256 | Server-side encryption with Amazon S3-managed keys |
| In transit | TLS 1.3 | All API communication encrypted |
| DynamoDB | Encryption at rest | AWS-managed encryption for all table data |

#### Tenant Isolation

Each user's data is fully isolated:

- **S3**: Blobs stored under `<projectId>/` prefix. IAM policies prevent cross-tenant access at the bucket policy level.
- **DynamoDB**: All queries include `userId` as the partition key. Lambda functions operate within the authenticated user's scope only.
- **API Gateway**: JWT authorizer validates Clerk-issued JWT on every request. User identity extracted from token claims, not request parameters.

#### Access Logging

All API access is logged with:

- Timestamp (ISO 8601)
- User ID (JWT `sub`)
- Action type (upload, download, job-submit, delete)
- Resource identifiers (project ID, lane ID, blob hash)
- Request metadata (IP address, user agent)

Logs are stored in CloudWatch with a configurable retention period (default: 90 days).

#### Data Retention

- Default retention: 30 days for artifacts, indefinite for blobs (until project deleted)
- Configurable per-project retention policy
- User can delete all hosted data at any time via API or desktop UI
- Deletion is recursive: deleting a project removes all blobs, manifests, artifacts, and metadata
- Deletion is confirmed (not soft-deleted) — data is permanently removed from S3 and DynamoDB

### Transcript Privacy

Terminal session transcripts are a particularly sensitive data category because they may contain commands with inline secrets, output from credential management tools, or application logs with sensitive data.

**Local storage**: Transcripts are stored in `.ade/transcripts/` on the local machine. They are included in `.ade/` which is excluded from git by default.

**Upload policy**: Transcript upload to the hosted mirror is opt-in and configurable per project:

```yaml
# In ade.yaml
mirror:
  uploadTranscripts: false    # Default: false
```

When upload is enabled, redaction rules are applied before transmission. Transcripts are never shared across tenants.

### Proposal Safety

When the hosted agent generates proposals (conflict resolutions, PR descriptions), the following safety measures ensure the user maintains full control.

**Preview before apply**: All proposals are displayed as diffs in the desktop UI before any changes are made to the repository. The user explicitly chooses to apply or discard each proposal.

**Operation recording**: When a proposal is applied, an operation record is created with:

- Pre-apply state (HEAD SHA, working tree hash)
- Post-apply state (new HEAD SHA, modified files)
- The proposal content itself
- Timestamp and source (which job generated the proposal)

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

**Retention**: Local audit trail is retained indefinitely (until the user explicitly clears it or deletes the `.ade/` directory). The audit trail is not uploaded to the hosted mirror.

**Queryable fields**: Operations can be queried by lane, time range, operation type, or SHA reference. The History page in the UI provides a visual timeline of operations.

---

## Integration Points

### Electron Main Process

- **BrowserWindow config**: `nodeIntegration: false`, `contextIsolation: true`, CSP headers
- **Preload script**: Typed IPC allowlist via `contextBridge.exposeInMainWorld`
- **IPC handlers**: Argument validation on every handler in `registerIpc.ts`

### Configuration System

- **Trust model**: SHA-based approval for shared config commands (see [CONFIGURATION.md](./CONFIGURATION.md))
- **Secret detection**: Warns if `apiKey` found in `ade.yaml` instead of `local.yaml`
- **Validation**: Schema validation prevents malformed config from being saved

### Hosted Mirror

- **Exclude rules**: Default and configurable patterns prevent secret upload (see [HOSTED_AGENT.md](./HOSTED_AGENT.md))
- **Redaction**: Secret patterns stripped from transcripts and file contents before upload
- **Encryption**: SSE-S256 at rest, TLS 1.3 in transit
- **Tenant isolation**: IAM policies and partition key scoping

### Git Operations

- **Path validation**: All operations scoped to lane root directory
- **Force push safety**: `--force-with-lease` only
- **Operation tracking**: Pre/post SHA recorded for undo capability
- **History service**: Stores operations in SQLite for audit trail

### Cloud Backend

- **Clerk JWT**: All API requests authenticated and authorized
- **CloudWatch logging**: All access logged with user identity and action type
- **Data deletion**: Recursive, confirmed deletion via API (see [CLOUD_BACKEND.md](./CLOUD_BACKEND.md))

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
| Default exclude patterns for secrets | Done | Pattern list defined and enforced in mirror sync + exports |
| Secret redaction rules | Done | `redactSecrets()` and `redactSecretsDeep()` in `apps/desktop/src/main/utils/redaction.ts`; applied to all outbound AI payloads and mirror uploads |
| Hosted mirror encryption | Done | S3 SSE-S256 at rest, TLS 1.3 in transit (Phase 6 cloud backend) |
| Tenant isolation (IAM/DynamoDB) | Done | IAM policies + DynamoDB partition key scoping + JWT authorizer (Phase 6) |
| Access logging (CloudWatch) | Done | All API access logged with user ID, action type, resource IDs (Phase 6) |
| Data retention and deletion | Done | Recursive project deletion via API and desktop UI; configurable retention (Phase 6) |
| Transcript upload redaction | Done | Opt-in upload with redaction rules applied before transmission (Phase 6) |
| Confidence heuristics for proposals | Done | Confidence scoring (high/medium/low) displayed in ConflictsPage proposal list (Phase 6) |

**Overall status**: DONE. Core local security model (process isolation, preload bridge, config trust, operation tracking, path validation, force push safety) and cloud security features (mirror encryption, tenant isolation, access logging, data retention, secret redaction, transcript privacy, proposal confidence) are all implemented across Phases -1 through 8.
