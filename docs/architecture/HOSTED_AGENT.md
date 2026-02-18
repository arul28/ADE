# Hosted Agent Architecture

> Last updated: 2026-02-16

The hosted ADE agent is a cloud-based service that receives read-only snapshots of lane state and uses large language models to generate useful artifacts. It is designed as a stateless, event-driven processing layer that never directly interacts with the user's repository.

---

## Table of Contents

- [Overview](#overview)
- [Design Decisions](#design-decisions)
- [Technical Details](#technical-details)
  - [Architecture Diagram](#architecture-diagram)
  - [Job Types](#job-types)
  - [Mirror Sync Protocol](#mirror-sync-protocol)
  - [Exclude Rules](#exclude-rules)
  - [LLM Gateway](#llm-gateway)
  - [Provider Swapping](#provider-swapping)
  - [Authentication (OAuth 2.0 PKCE)](#authentication-oauth-20-pkce)
  - [Secret Redaction](#secret-redaction)
  - [Context Delivery Policy](#context-delivery-policy)
  - [Job Polling & Deduplication](#job-polling--deduplication)
  - [BYOK Provider Details](#byok-provider-details)
  - [GitHub Integration (Hosted)](#github-integration-hosted)
  - [Artifact Structure](#artifact-structure)
- [Integration Points](#integration-points)
- [Implementation Status](#implementation-status)

---

## Overview

The hosted agent exists to offload computationally expensive and latency-tolerant work from the desktop application. Rather than running LLM inference locally or requiring users to manage API keys, the hosted agent provides a managed service that processes lane snapshots and returns generated artifacts.

### Hosted Is A Gateway (Self-Hostable)

“Hosted” in ADE is a **remote gateway protocol**, not “AWS required”.

- The desktop app targets a configurable base URL:
  - `providers.hosted.apiBaseUrl` in `.ade/local.yaml` (can point to a self-hosted deployment)
- Hosted state is keyed by:
  - `remoteProjectId`

Diagnostics and error messages must reference `apiBaseUrl` and `remoteProjectId` when relevant.

### Context Inputs Are Bounded Exports

For LLM jobs, ADE sends **token-budgeted exports** (Lite/Standard/Deep) rather than raw, unbounded pack dumps or transcript slabs.

Examples:
- Lane narrative generation: `LaneExportStandard`
- Conflict resolution proposals: `LaneExportLite` (lane + optional peer) + `ConflictExportStandard`

All outbound payloads must be redacted before leaving the local machine.

### Key Contract

The hosted agent **NEVER** mutates the repository. This is the foundational invariant of the entire architecture. The agent receives content-addressed blobs and manifests, processes them with LLMs, and returns generated artifacts. The local desktop core is the **ONLY** component allowed to:

- Edit files on disk
- Run git commands
- Execute tests or build processes
- Perform undo operations

This separation ensures that the hosted agent can never corrupt the user's working state, and that all changes are previewed and applied under full user control on the local machine.

### High-Level Flow

1. Desktop detects a state change in a lane (new commits, pack updates, conflict detected).
2. Desktop optionally syncs a read-only mirror snapshot (blobs/manifests) when a job type needs file-level context.
3. Desktop submits a job request specifying the job type and **bounded export** context (Lite/Standard/Deep) and lane metadata.
4. The hosted agent processes the job, invoking LLMs as needed.
5. The resulting artifact is stored remotely (implementation-defined) and recorded as job/artifact metadata.
6. Desktop polls for completion (or receives a webhook) and downloads the artifact.
7. Desktop presents the artifact to the user for review and optional application.

---

## Design Decisions

### Why a Read-Only Mirror?

Allowing the cloud service to write back to the repository introduces significant risks: merge conflicts with local work, race conditions between local and remote edits, and potential data loss. By enforcing a strict read-only contract, we eliminate an entire class of failure modes. The desktop app is the single source of truth for repository state.

### Why Content-Addressed Storage?

Content-addressed blobs (keyed by SHA-256 of their contents) provide natural deduplication across lanes, projects, and even users. If two developers upload the same library file, only one copy is stored. This reduces storage costs and upload bandwidth, and makes delta sync straightforward: only blobs not already present on the server need to be uploaded.

### Why Queue + Workers (Reference Implementation)

Job processing is inherently bursty. A developer might submit several jobs in quick succession after a merge, then nothing for hours. A queue + worker model provides:

- backpressure and retries
- scaling under load (or concurrency limits in self-hosted deployments)
- isolation from desktop UI latency

ADE’s managed Hosted deployment may use serverless building blocks (queue + ephemeral workers), but **self-hosted deployments can use any equivalent queue/worker system** as long as the HTTP API contract is compatible with `providers.hosted.apiBaseUrl`.

### Why a Custom LLM Gateway?

Third-party LLM orchestration frameworks add unnecessary abstraction and vendor lock-in. The LLM gateway is a focused internal module that handles prompt construction from templates, model invocation via provider APIs, token budget enforcement, response validation, and retry logic. Keeping this in-house allows tight integration with ADE's specific job types and cost controls.

---

## Technical Details

### Architecture Diagram

```
Desktop App                              Hosted Gateway (ADE-managed or self-hosted)
┌──────────────┐                        ┌──────────────────────────────────────────┐
│              │  Optional mirror sync  │                                          │
│  Lane State  │ ─────────────────────> │  Mirror store (blobs/manifests)          │
│              │                        │                                          │
│              │  Submit job (exports)  │  HTTP API (apiBaseUrl)                   │
│              │ ─────────────────────> │    │                                     │
│              │                        │    ▼                                     │
│              │                        │  Job queue                               │
│              │                        │    │                                     │
│              │                        │    ▼                                     │
│              │                        │  Worker(s)                               │
│              │                        │    │                                     │
│              │                        │    ├── LLM gateway ──> provider(s)      │
│              │                        │    │                                     │
│              │                        │    ▼                                     │
│              │   Poll / webhook       │  Artifact store + metadata               │
│              │ <───────────────────── │  (implementation-defined)                │
└──────────────┘                        └──────────────────────────────────────────┘
```

### Job Types

#### `NarrativeGeneration`

Generates a human-readable lane narrative from a **bounded lane export** (Standard by default). The LLM produces structured markdown narrative that summarizes what changed, why, and what to do next. The result is applied locally via marker-based replacement (`ADE_NARRATIVE_START/END`) and recorded as a pack event + immutable version.

- **Input**: `LaneExportStandard` (token-budgeted, redacted)
- **Output**: markdown narrative text
- **LLM Usage**: Required (summarization task)
- **Budgeting**: Input exports are bounded; output should be bounded by the hosted gateway per job type

#### `ProposeConflictResolution`

Analyzes conflict pack data to understand both sides of a conflict and generates a proposed resolution diff. The output includes a unified diff, a natural-language explanation of the resolution strategy, and a confidence score indicating how likely the resolution is to be correct.

- **Input**: bounded exports (token-budgeted, redacted):
  - `LaneExportLite` (lane)
  - `LaneExportLite` (peer lane, optional)
  - `ConflictExportStandard`
- **Output**: Resolution diff + explanation + confidence score
- **LLM Usage**: Required (reasoning task)
- **Budgeting**: Input exports are bounded; output should be bounded by the hosted gateway per job type
- **Confidence Scoring**: `high` (isolated change, clear intent), `medium` (overlapping but non-contradictory), `low` (semantic conflict, needs human review)

#### `DraftPrDescription`

Generates a pull request title, body, and reviewer suggestions from lane pack data and commit history. The body follows a configurable template (default: summary, changes, testing notes, screenshots placeholder).

- **Input**: bounded exports (token-budgeted, redacted), typically `LaneExportStandard`
- **Output**: PR title + body markdown + suggested reviewers
- **LLM Usage**: Required (generation task)
- **Template**: Configurable in `.ade/ade.yaml` under `providers.hosted.prTemplate`

### Mirror Sync Protocol

The mirror sync protocol ensures the hosted service has an up-to-date snapshot of the relevant lane state without transferring the entire repository on every change.

#### Upload Flow

1. Desktop computes the set of changed files since the last sync (tracked by last-sync manifest hash).
2. For each changed file, desktop computes the SHA-256 hash of the file contents.
3. Desktop sends a batch existence check to the server: "which of these hashes do you already have?"
4. Server responds with the subset of hashes it does **not** have.
5. Desktop uploads only the missing blobs (content-addressed by SHA-256).
6. Desktop uploads the updated lane manifest, which maps file paths to blob references.

#### Manifest Structure

```json
{
  "version": 1,
  "projectId": "proj_abc123",
  "laneId": "lane_xyz789",
  "headSha": "a1b2c3d4...",
  "branchRef": "refs/heads/feature/my-lane",
  "timestamp": "2026-02-11T10:30:00Z",
  "files": {
    "src/main.ts": { "blobSha": "sha256:abcdef...", "size": 1234 },
    "src/utils.ts": { "blobSha": "sha256:fedcba...", "size": 567 }
  },
  "metadata": {
    "laneTitle": "Feature: Auth Flow",
    "parentLaneId": "lane_parent123",
    "tags": ["feature", "auth"]
  }
}
```

### Exclude Rules

The following patterns are **never** uploaded to the hosted mirror, regardless of configuration:

| Category | Patterns |
|----------|----------|
| Version control | `.git/`, `.ade/` |
| Dependencies | `node_modules/`, `vendor/`, `.venv/`, `__pycache__/` |
| Build output | `dist/`, `build/`, `.next/`, `.nuxt/`, `target/` |
| Secrets | `.env`, `.env.*`, `*.pem`, `*.key`, `*.cert`, `credentials.json`, `secrets.*`, `.aws/credentials`, `id_rsa`, `id_ed25519` |
| Size limit | Files exceeding **400 KB** per file |
| File cap | Max **400 files** per lane |
| User-defined | Patterns from `providers.hosted.mirrorExcludePatterns` in `.ade/ade.yaml` |

**Binary detection**: Files are checked for null bytes. If a file is non-text but has a known text extension (`.md`, `.txt`, `.json`, `.yml`, `.yaml`, `.toml`, `.js`, `.ts`, `.tsx`, `.jsx`, `.css`, `.html`, `.cjs`, `.mjs`, `.sh`, `.py`, `.rs`, `.go`, `.java`, `.kt`, `.swift`, `.rb`, `.php`, `.sql`), it is included regardless.

**Secret redaction**: All text file content is passed through `redactSecrets()` before upload. This strips API keys, tokens, private keys, and GitHub PATs from the content payload. See [Secret Redaction](#secret-redaction) below.

### LLM Gateway

The LLM gateway is an internal module within the Hosted worker runtime that handles all LLM interactions. It is **not** a third-party product or service. (ADE’s managed deployment may run workers serverlessly; self-hosted deployments can run workers as long-running processes.)

**Responsibilities**:

- **Prompt construction**: Assembles prompts from job-specific templates and input data. Templates are versioned alongside the worker code.
- **Model selection**: Routes jobs to appropriate models based on complexity. Complex reasoning tasks (conflict resolution) use Claude; simpler generation tasks may use smaller, faster models.
- **Token budget enforcement**: Each job type has a configured maximum token budget. The gateway truncates input context if necessary to stay within budget and rejects responses that exceed output limits.
- **Response validation**: Validates LLM output against expected schemas (e.g., conflict resolution must produce a valid unified diff).
- **Retry logic**: Retries on transient failures (rate limits, timeouts) with exponential backoff. Permanent failures (invalid response after 3 attempts) are recorded as job failures.
- **Prompt caching**: Caches system prompts and repeated context prefixes to reduce token consumption on subsequent invocations.

### Provider Swapping

ADE supports multiple LLM provider configurations to accommodate different user needs and organizational policies.

| Provider Mode | Description | Configuration Location |
|---------------|-------------|----------------------|
| `guest` | No AI features — packs generate deterministic content only | Default (no config needed) |
| `hosted` | Remote Hosted gateway (ADE-managed or self-hosted) | `.ade/ade.yaml` + `.ade/local.yaml` (apiBaseUrl/remoteProjectId) |
| `byok` | Bring Your Own Key (Anthropic, OpenAI, Gemini) | `.ade/local.yaml` (API key never in shared config) |
| `cli` | Local CLI tools (ollama, llama.cpp, etc.) | `.ade/local.yaml` |

When `byok` or `cli` is selected, job processing happens locally on the desktop rather than in the cloud. The same job types and prompt templates are used, but invocation goes through the local provider instead of the hosted Lambda workers.

**Configuration examples** (`.ade/local.yaml`):

```yaml
providers:
  mode: hosted
  hosted:
    apiBaseUrl: "https://hosted.example.com"
    remoteProjectId: "proj_..."
```

```yaml
providers:
  mode: byok
  byok:
    provider: "anthropic"   # anthropic | openai | gemini
    apiKey: "sk-ant-..."
    model: "claude-sonnet-4-5-20250929"
```

### Authentication (OAuth 2.0 PKCE)

Hosted mode uses **OAuth 2.0 PKCE** (Proof Key for Code Exchange) with a local loopback callback for secure desktop sign-in.

**Flow**:
1. Desktop generates a 48-byte random PKCE verifier + SHA-256 code challenge.
2. Opens the system browser to the Clerk authorize endpoint with `code_challenge`.
3. Spins up a local HTTP server on `127.0.0.1:42420` to receive the callback.
4. User authenticates in browser; callback delivers the authorization code.
5. Desktop exchanges the code + verifier for access/refresh/ID tokens.
6. Tokens are encrypted via Electron `safeStorage` and stored at `~/.ade/hosted/hosted-auth.v1.bin`.

**Token management**:
- Access tokens are refreshed automatically if expiring within **60 seconds** (checked before every API call).
- ID tokens are preferred for API authorization (better `aud` claim for API Gateway); falls back to access token.
- JWT claims (`sub`, `email`, `preferred_username`, `name`) are decoded for user profile display.
- On 401 Unauthorized, the token is auto-refreshed and the request retried once.

**Constants**:
- Callback port: `42420`
- Auth storage filename: `hosted-auth.v1.bin`
- Sign-in timeout: 180 seconds

### Secret Redaction

All data leaving the local machine is scrubbed by the redaction engine before transmission.

**`redactSecrets(text)`** — single-pass regex replacement:
- `api_key=...`, `api-key=...`, `apiKey=...` → `<redacted>`
- `token=...`, `secret=...`, `password=...` → `<redacted>`
- Private keys (PEM blocks) → `<redacted-private-key>`
- GitHub PATs: `ghp_*`, `github_pat_*` → `<redacted-token>`
- OpenAI/Anthropic keys: `sk-*` → `<redacted-token>`

**`redactSecretsDeep(value, maxDepth=8)`** — recursive deep scan:
- Traverses objects, arrays, and nested structures
- Uses WeakSet to prevent circular reference loops
- Max recursion depth: 8 (configurable)

**Applied to**:
- All mirror sync blob content before upload
- All BYOK prompts before sending to provider API
- All bounded exports before transmission

### Context Delivery Policy

The desktop decides whether to send job context inline or via mirror reference using `hostedContextPolicy.ts`:

**Thresholds**:
- `AUTO_MIRROR_THRESHOLD_BYTES`: 60,000 — payloads above this size prefer mirror delivery.
- `INLINE_FALLBACK_MAX_BYTES`: 18,000 — maximum inline fallback payload size for mirror-ref jobs.

**Decision logic** (`decideHostedContextDelivery()`):
1. Conflict jobs (`ProposeConflictResolution`, `ConflictResolution`) force mirror delivery.
2. If payload exceeds `AUTO_MIRROR_THRESHOLD_BYTES`, use mirror-ref.
3. Otherwise, use inline delivery.

**Inline fallback construction** (`buildInlineFallbackParams()`):
- Two-pass reduction to fit within `INLINE_FALLBACK_MAX_BYTES`:
  - Pass 1: Clip pack body to 1,800 chars, file contexts to 60 items.
  - Pass 2: Clip pack body to 900 chars, file contexts to 24 items.
- Fallback is always included in mirror-ref submissions so jobs succeed even if ref resolution fails.

**Telemetry**: Every job submission records `contextDelivery` metadata (mode, contextSource, reasonCode, contextRefSha256, warnings, confidenceLevel) in the `narrative_requested` pack event.

### Job Polling & Deduplication

**Polling backoff strategy**:
| Parameter | Value |
|-----------|-------|
| Initial delay | 700ms |
| Max delay | 4,000ms |
| Backoff multiplier | 1.8× per iteration |
| Stall timeout | 90 seconds (if status doesn't change) |
| Overall timeout floor | 60 seconds |
| Retry on transient error | Up to 4 times |

**Stall detection**: If the job status doesn't change for 90 seconds, polling fails immediately. This prevents infinite waits on stuck jobs.

**In-flight request deduplication**: Requests with identical payloads return the same promise. Deduplication keys are computed using SHA-256 of the JSON-serialized payload:
- Lane narrative requests: keyed by `(laneId, packBody)`
- Conflict proposal requests: keyed by `(laneId, peerLaneId, conflictContext)`
- PR description requests: keyed by `(laneId, prContext)`

This prevents duplicate work when the UI rapidly requests the same AI job.

**Upload batching**: Mirror blob uploads are batched in groups of **40 blobs** per HTTP request. The server returns which hashes it already has; only missing blobs are uploaded.

### BYOK Provider Details

When `byok` mode is configured, the desktop makes direct API calls to the selected LLM provider with no cloud round-trip.

**Supported providers and endpoints**:

| Provider | Endpoint | Auth |
|----------|----------|------|
| OpenAI | `https://api.openai.com/v1/chat/completions` | `Authorization: Bearer {apiKey}` |
| Anthropic | `https://api.anthropic.com/v1/messages` | `x-api-key: {apiKey}`, `anthropic-version: 2023-06-01` |
| Gemini | `https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent` | `key={apiKey}` query param |

**Gemini model normalization**: Strips `models/` prefix if present. Model must start with `gemini-` (e.g., `gemini-1.5-flash-latest`).

**Prompt templates per job type**:

| Job Type | System Prompt Role | Max Output Tokens | Temperature |
|----------|-------------------|-------------------|-------------|
| Narrative Generation | "ADE's narrative writer" — concise developer-facing markdown | 900 | 0.2 |
| PR Description | "ADE's PR drafting assistant" — factual GitHub-pasteable markdown | 1,200 | 0.2 |
| Conflict Resolution | "ADE's conflict resolution assistant" — explanation + unified diff | 1,600 | 0.2 |

**Output parsing**:
- **Confidence scores**: Parsed from response text via regex (`confidence: X` or `confidence: X%`), normalized to 0–1 range.
- **Diff extraction**: Fenced `` ```diff ... ``` `` blocks are extracted from response text.
- All user prompts are **redacted** before sending to the provider.

### GitHub Integration (Hosted)

The hosted service can proxy GitHub API calls on behalf of the desktop when the GitHub app is connected:

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `GET /projects/{id}/github/status` | GET | Check GitHub app connection status |
| `POST /projects/{id}/github/connect/start` | POST | Initiate GitHub app installation |
| `POST /projects/{id}/github/disconnect` | POST | Disconnect GitHub app |
| `GET /projects/{id}/github/events` | GET | List GitHub events |
| `POST /projects/{id}/github/api` | POST | Proxy arbitrary GitHub API calls |

The proxy forwards `{ method, path, query, body }` to GitHub and returns `{ data: T }`.

### Artifact Structure

Job artifacts returned by the hosted gateway can be:
- A simple string (narrative text, PR body)
- An object with content + metadata:
  ```json
  {
    "content": "...",
    "metadata": {
      "provider": "anthropic",
      "model": "claude-sonnet-4-5-20250929",
      "inputTokens": 2400,
      "outputTokens": 850,
      "latencyMs": 3200
    }
  }
  ```

Provider metadata (when available) is recorded in pack event payloads for cost tracking and performance monitoring.

---

## Integration Points

### Desktop Application

- **Mirror sync + job submission**: `apps/desktop/src/main/services/hosted/hostedAgentService.ts` handles auth, optional mirror sync, job submission, polling, and artifact fetch.
- **Bounded context exports**: `apps/desktop/src/main/services/packs/packExports.ts` builds Lite/Standard/Deep exports used as AI job inputs.
- **Artifact display**: Pack Viewer and Conflicts UI consume artifacts returned by Hosted/BYOK jobs.
- **Configuration**: Provider settings read from `projectConfigService.ts` (merged shared + local config).

### Reference: ADE-Managed Deployment (AWS)

- **SST**: All AWS resources defined and deployed via SST (see [CLOUD_BACKEND.md](./CLOUD_BACKEND.md)). Self-hosted deployments may use different infrastructure.
- **API Gateway**: Entry point for all desktop-to-cloud communication.
- **S3**: Storage for blobs, manifests, and artifacts.
- **SQS**: Decouples job submission from processing.
- **DynamoDB**: Metadata for projects, lanes, jobs, and artifacts.

### LLM Providers

- **Anthropic API**: Primary provider for hosted and BYOK configurations.
- **OpenAI API**: Supported for hosted and BYOK configurations.
- **Google Gemini API**: Supported for BYOK configurations (`gemini-*` models).
- **Local CLI**: Any CLI tool that accepts stdin prompts and produces stdout responses (planned).

---

## Implementation Status

| Component | Status | Notes |
|-----------|--------|-------|
| Architecture design | Complete | Documented in this file |
| Mirror sync protocol | Complete | `hostedAgentService.syncMirror()` — content-addressed blob upload, manifest upsert, pack sync, transcript sync |
| S3 blob storage | Complete | SST-provisioned `ade-<stage>-blobs`, `ade-<stage>-manifests`, `ade-<stage>-artifacts` buckets |
| SQS job queue | Complete | SST-provisioned `ade-<stage>-jobs` queue with DLQ and CloudWatch alarms |
| Lambda workers | Complete | `jobWorker.handler` processes NarrativeGeneration, ProposeConflictResolution, DraftPrDescription |
| LLM gateway module | Complete | `infra/packages/core/src/llmGateway.ts` — supports Anthropic, OpenAI, Gemini, Mock providers |
| `NarrativeGeneration` job | Complete | Cloud worker + desktop `requestLaneNarrative()` + job engine integration |
| `ProposeConflictResolution` job | Complete | Cloud worker + desktop `requestConflictProposal()` + conflict service integration |
| `DraftPrDescription` job | Complete | Cloud worker + prompt template ready; desktop PR integration planned for Phase 7 |
| Provider swapping (BYOK/CLI) | Complete | SettingsPage UI for Hosted/BYOK/CLI selection; API key management in local.yaml |
| Exclude rules enforcement | Complete | Default + user-configurable exclude patterns; `redactSecrets()` for content redaction |
| Cost controls | Complete | Rate limiting (per-minute, daily jobs, daily tokens) via DynamoDB `ade-<stage>-rate-limits` |
| Clerk OAuth auth flow | Complete | Desktop PKCE loopback sign-in, token refresh, OS secure storage for tokens |
| API Gateway + JWT auth | Complete | Clerk JWT authorizer on all protected routes; tenant isolation via `sub` claim |
| DynamoDB tables | Complete | projects, lanes, jobs, artifacts, rate-limits tables all provisioned |
| Desktop settings UI | Complete | Provider mode selector, consent flow, bootstrap config, sign-in/sign-out, mirror sync |
| Startup auth page | Complete | `StartupAuthPage.tsx` — consent, sign-in with Clerk, continue as guest |

**Overall status**: COMPLETE. Phase 6 is fully implemented across cloud infrastructure and desktop integration.
