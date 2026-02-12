# Hosted Agent Architecture

> Last updated: 2026-02-11

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
- [Integration Points](#integration-points)
- [Implementation Status](#implementation-status)

---

## Overview

The hosted agent exists to offload computationally expensive and latency-tolerant work from the desktop application. Rather than running LLM inference locally or requiring users to manage API keys, the hosted agent provides a managed service that processes lane snapshots and returns generated artifacts.

### Key Contract

The hosted agent **NEVER** mutates the repository. This is the foundational invariant of the entire architecture. The agent receives content-addressed blobs and manifests, processes them with LLMs, and returns generated artifacts. The local desktop core is the **ONLY** component allowed to:

- Edit files on disk
- Run git commands
- Execute tests or build processes
- Perform undo operations

This separation ensures that the hosted agent can never corrupt the user's working state, and that all changes are previewed and applied under full user control on the local machine.

### High-Level Flow

1. Desktop detects a state change in a lane (new commits, pack updates, conflict detected).
2. Desktop uploads changed blobs and an updated manifest to the hosted mirror.
3. Desktop submits a job request specifying the job type and lane context.
4. The hosted agent processes the job, invoking LLMs as needed.
5. The resulting artifact is stored in S3 and its metadata recorded in DynamoDB.
6. Desktop polls for completion (or receives a webhook) and downloads the artifact.
7. Desktop presents the artifact to the user for review and optional application.

---

## Design Decisions

### Why a Read-Only Mirror?

Allowing the cloud service to write back to the repository introduces significant risks: merge conflicts with local work, race conditions between local and remote edits, and potential data loss. By enforcing a strict read-only contract, we eliminate an entire class of failure modes. The desktop app is the single source of truth for repository state.

### Why Content-Addressed Storage?

Content-addressed blobs (keyed by SHA-256 of their contents) provide natural deduplication across lanes, projects, and even users. If two developers upload the same library file, only one copy is stored. This reduces storage costs and upload bandwidth, and makes delta sync straightforward: only blobs not already present on the server need to be uploaded.

### Why SQS + Lambda Over Long-Running Servers?

Job processing is inherently bursty. A developer might submit several jobs in quick succession after a merge, then nothing for hours. SQS + Lambda provides automatic scaling to zero when idle and rapid scale-up under load, with no infrastructure to manage. The trade-off is cold start latency (mitigated by provisioned concurrency for critical job types).

### Why a Custom LLM Gateway?

Third-party LLM orchestration frameworks add unnecessary abstraction and vendor lock-in. The LLM gateway is a focused internal module that handles prompt construction from templates, model invocation via provider APIs, token budget enforcement, response validation, and retry logic. Keeping this in-house allows tight integration with ADE's specific job types and cost controls.

---

## Technical Details

### Architecture Diagram

```
Desktop App                          AWS Cloud
┌──────────────┐                    ┌───────────────────────────────────┐
│              │   Upload blobs     │                                   │
│  Lane State  │ ─────────────────> │  S3 (ade-<env>-blobs)            │
│              │   Upload manifest  │  S3 (ade-<env>-manifests)        │
│              │ ─────────────────> │                                   │
│              │                    │                                   │
│              │   Submit job       │  API Gateway                      │
│              │ ─────────────────> │    │                              │
│              │                    │    ▼                              │
│              │                    │  SQS Job Queue                    │
│              │                    │    │                              │
│              │                    │    ▼                              │
│              │                    │  Lambda Worker                    │
│              │                    │    │                              │
│              │                    │    ├─── LLM Gateway ──> Claude   │
│              │                    │    │                              │
│              │                    │    ▼                              │
│              │   Poll / webhook   │  S3 (ade-<env>-artifacts)        │
│              │ <───────────────── │  DynamoDB (job + artifact meta)  │
└──────────────┘                    └───────────────────────────────────┘
```

### Job Types

#### `UpdatePackNarrative`

Generates a human-readable context summary from raw pack data. Input includes diffs, session transcripts, and file change metadata. The LLM produces a structured markdown narrative that summarizes what changed, why, and what the developer was working on. This narrative is stored as an artifact and displayed in the Pack Viewer.

- **Input**: Pack blob references (diffs, transcripts, file list)
- **Output**: Structured markdown narrative
- **LLM Usage**: Required (summarization task)
- **Token Budget**: ~4,000 output tokens
- **Caching**: Result cached by pack content hash; regenerated only if pack contents change

#### `ProposeConflictResolution`

Analyzes conflict pack data to understand both sides of a conflict and generates a proposed resolution diff. The output includes a unified diff, a natural-language explanation of the resolution strategy, and a confidence score indicating how likely the resolution is to be correct.

- **Input**: Conflict pack (base, ours, theirs file versions, surrounding context)
- **Output**: Resolution diff + explanation + confidence score
- **LLM Usage**: Required (reasoning task)
- **Token Budget**: ~8,000 output tokens
- **Confidence Scoring**: `high` (isolated change, clear intent), `medium` (overlapping but non-contradictory), `low` (semantic conflict, needs human review)

#### `DraftPrDescription`

Generates a pull request title, body, and reviewer suggestions from lane pack data and commit history. The body follows a configurable template (default: summary, changes, testing notes, screenshots placeholder).

- **Input**: Lane pack, commit log, branch metadata
- **Output**: PR title + body markdown + suggested reviewers
- **LLM Usage**: Required (generation task)
- **Token Budget**: ~2,000 output tokens
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
| Secrets | `.env`, `.env.*`, `*.pem`, `*.key`, `*.cert`, `credentials.json`, `secrets.*` |
| Binary threshold | Files exceeding configurable size limit (default: 10 MB) |
| User-defined | Patterns from `.gitignore` and `.ade/exclude` |

Additional exclude patterns can be added in `.ade/ade.yaml` under `mirror.exclude`. Patterns follow `.gitignore` syntax.

### LLM Gateway

The LLM gateway is an internal module within the Lambda worker that handles all LLM interactions. It is **not** a third-party product or service.

**Responsibilities**:

- **Prompt construction**: Assembles prompts from job-specific templates and input data. Templates are versioned and stored alongside the Lambda code.
- **Model selection**: Routes jobs to appropriate models based on complexity. Complex reasoning tasks (conflict resolution) use Claude; simpler generation tasks may use smaller, faster models.
- **Token budget enforcement**: Each job type has a configured maximum token budget. The gateway truncates input context if necessary to stay within budget and rejects responses that exceed output limits.
- **Response validation**: Validates LLM output against expected schemas (e.g., conflict resolution must produce a valid unified diff).
- **Retry logic**: Retries on transient failures (rate limits, timeouts) with exponential backoff. Permanent failures (invalid response after 3 attempts) are recorded as job failures.
- **Prompt caching**: Caches system prompts and repeated context prefixes to reduce token consumption on subsequent invocations.

### Provider Swapping

ADE supports multiple LLM provider configurations to accommodate different user needs and organizational policies.

| Provider | Description | Configuration Location |
|----------|-------------|----------------------|
| `hosted` | ADE managed service (default) | `.ade/ade.yaml` |
| `byok` | Bring Your Own Key (Anthropic, OpenAI, etc.) | `.ade/local.yaml` (API key never in shared config) |
| `cli` | Local CLI tools (ollama, llama.cpp, etc.) | `.ade/local.yaml` |

When `byok` or `cli` is selected, job processing happens locally on the desktop rather than in the cloud. The same job types and prompt templates are used, but invocation goes through the local provider instead of the hosted Lambda workers.

**Configuration example** (`.ade/local.yaml`):

```yaml
providers:
  hosted:
    type: "byok"
    provider: "anthropic"
    apiKey: "sk-ant-..."
    model: "claude-sonnet-4-5-20250929"
```

---

## Integration Points

### Desktop Application

- **Mirror sync**: `mirrorSyncService.ts` manages blob upload, manifest generation, and delta computation.
- **Job submission**: `hostedJobService.ts` submits jobs via API Gateway and polls for results.
- **Artifact display**: Pack Viewer and Conflict Resolver consume artifacts returned by the hosted agent.
- **Configuration**: Provider settings read from `projectConfigService.ts` (merged shared + local config).

### AWS Infrastructure

- **SST**: All AWS resources defined and deployed via SST (see [CLOUD_BACKEND.md](./CLOUD_BACKEND.md)).
- **API Gateway**: Entry point for all desktop-to-cloud communication.
- **S3**: Storage for blobs, manifests, and artifacts.
- **SQS**: Decouples job submission from processing.
- **DynamoDB**: Metadata for projects, lanes, jobs, and artifacts.

### LLM Providers

- **Anthropic API**: Primary provider for hosted and BYOK configurations.
- **OpenAI API**: Supported for BYOK configurations.
- **Local CLI**: Any CLI tool that accepts stdin prompts and produces stdout responses.

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
