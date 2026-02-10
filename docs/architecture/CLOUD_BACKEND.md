# Cloud Backend (AWS) (Auth, Mirror Storage, Jobs, LLM Gateway)

Last updated: 2026-02-10

This document answers: what runs in the cloud, how auth works, where repo mirrors live, and how LLM calls are executed.

## 1. Cloud Responsibilities (And Non-Responsibilities)

Cloud does:

- Authenticate users and authorize access to projects.
- Store repo mirrors (read-only from agent perspective).
- Run hosted-agent jobs:
  - narrative pack augmentation
  - conflict proposal generation (patches)
- Store job artifacts (packs, proposals, logs).
- Notify desktop app of job progress/completion.

Cloud does not:

- run tests
- apply patches to user repos
- perform git merges/rebases on behalf of the user

## 2. Concrete AWS MVP Stack (Locked)

You asked for specifics. This is the locked AWS-native stack for the hosted-agent MVP (chosen to consume AWS credits):

- Infrastructure as code: **SST** (deploys to AWS)
- Auth: **Amazon Cognito User Pool** + **Hosted UI**
  - Login method: **GitHub OAuth** federated into Cognito (no email verification flow required)
- API: **API Gateway (HTTP API)** + **AWS Lambda**
  - REST endpoints for projects, lanes, mirror uploads, jobs, artifacts
- Queue: **SQS**
  - job ingestion + retries + DLQ
- Workers: **Lambda (SQS-triggered)**
  - run pack narrative jobs and conflict proposal jobs
- Storage: **S3**
  - repo mirror blobs, lane manifests/snapshots, job artifacts (packs, proposals)
- Metadata DB: **DynamoDB**
  - users/projects/lanes/jobs/artifacts pointers + budgets
- Secrets: **AWS Secrets Manager**
  - model provider API keys and other backend secrets
- Observability:
  - **CloudWatch Logs/Metrics** (baseline)
  - optionally **Sentry** for error aggregation

## 2.1 Are We Serverless?

Yes. For MVP:

- API is Lambda behind API Gateway
- jobs run in Lambda via SQS trigger
- data lives in S3 + DynamoDB

No EC2/ECS required for v1.

## 3. Auth (Desktop -> Cloud) (Cognito Hosted UI + GitHub)

### 3.1 Goals

- Works for desktop apps cross-platform.
- Supports refresh tokens and long-lived sessions.
- Allows project-scoped permissions.

### 3.2 How Users Login (Desktop)

Login UX:

1. User clicks "Sign in" in ADE desktop.
2. ADE opens the system browser to **Cognito Hosted UI**.
3. User logs in with **GitHub** (Cognito federates to GitHub OAuth).
4. Cognito redirects to the desktop app callback URL.
5. Desktop exchanges the auth code for tokens and stores refresh token in the OS keychain.

API auth:

- Desktop sends `access_token` (JWT) on every API call (Bearer token).
- API Gateway uses a JWT authorizer (Cognito) or Lambda authorizer to validate tokens.
- Lambdas enforce `(user, project)` authorization.

### 3.3 Callback URL (MVP)

MVP recommendation: **loopback redirect** to avoid custom URL scheme complexity.

- Cognito callback URL: `http://127.0.0.1:<random_port>/callback`
- Desktop starts a temporary local HTTP server for the login flow and captures the auth code.

V1: add custom URL scheme (`ade://auth/callback`) if desired.

### 3.4 Cognito Setup (Concrete)

Minimum Cognito configuration:

- Create a Cognito User Pool
- Configure an **App Client**:
  - enable OAuth2 Authorization Code Grant
  - enable PKCE
  - scopes: `openid`, `email`, `profile`
- Configure Hosted UI domain (AWS-provided domain is fine for MVP)
- Add GitHub as a federated IdP:
  - create GitHub OAuth app (client id/secret)
  - configure Cognito IdP and map claims (email, username)
- Add callback URLs:
  - `http://127.0.0.1:<port>/callback` (desktop loopback)

Desktop stores tokens in OS keychain and uses `access_token` for API calls.

### 3.3 Authorization Model

- User belongs to an org (optional for MVP).
- User has access to projects.
- All mirror and job operations are scoped to `(user, project)`.

## 4. Repo Mirrors ("Cloud Clones")

You want the hosted agent to read the whole repo (minus excludes) without round-tripping to the desktop for every file. That implies a cloud mirror.

### 4.1 Mirror Type (Recommended): Content-Addressed Working-Tree Mirror (S3)

Store file blobs keyed by hash:

- `blobHash = sha256(content)`
- object store path like: `blobs/<blobHash>`

Maintain a per-lane "manifest" that maps paths to blob hashes:

- `projects/<projectId>/lanes/<laneId>/snapshots/<snapshotId>/manifest.json`

Manifest contains:

- base refs/shas (optional)
- head sha at time of snapshot (if known)
- list of files:
  - path
  - blobHash
  - executable bit (optional)

Benefits:

- Upload only changed blobs.
- Deduplicate across lanes and snapshots.
- Make "read whole repo" cheap and fast for workers.

### 4.2 Sync Protocol (Desktop -> Cloud)

On session end (forced):

1. Desktop computes changed files relative to last synced snapshot.
2. Desktop uploads missing blobs directly to object storage using signed URLs.
3. Desktop uploads a new manifest and marks it as latest.

During active work (coalesced):

- Same flow, but limited by:
  - `coalesceSeconds`
  - `dirtyLineThreshold`

Excludes:

- Desktop filters files based on exclude rules (see config).

### 4.3 Retention

For MVP:

- Keep only the last N snapshots per lane (e.g., 20).
- Keep blobs that are still referenced by any kept manifest.

## 5. Jobs and Artifacts

### 5.1 Job Types

- `UpdateProjectPackNarrative`
- `UpdateLanePackNarrative`
- `UpdateConflictPackNarrative`
- `ProposeConflictResolution`
- `DraftPrDescription`

### 5.2 Inputs

Jobs should reference mirror state via IDs, not by embedding repo content:

- `projectId`, `laneId`
- `snapshotId` (which mirror state to read)
- deterministic pack(s) content or pointers
- conflict metadata (files/hunks) if applicable

### 5.3 Outputs

- Narrative markdown blocks to attach to packs (or a combined "narrative pack").
- Patch proposals (unified diffs) with:
  - explanation
  - files touched
  - confidence metadata

Artifacts stored in object storage with DB pointers.

## 6. LLM Gateway (Server-Side Model Calls)

### 6.1 What The "LLM Gateway" Is (And What We’ll Use)

We will run our own gateway as a **Lambda module/service** (not a third-party product). It provides:

- a single internal API for "generate narrative" and "propose patch"
- provider routing (OpenAI, Anthropic, Bedrock, etc.)
- budgets, caching, and guardrails

### 6.2 Model Providers (Not Locked Yet)

We intentionally keep the model/provider choice configurable.

The LLM gateway should support:

- multiple providers (OpenAI / Anthropic / Bedrock)
- routing by job type (pack narrative vs conflict proposal)
- per-project budgets and rate limits

### 6.3 Why a gateway

- Keeps provider API keys off the client.
- Centralizes budgets, caching, and safety policies.

### 6.4 Request shaping (Cost control)

Even with "read whole repo", workers should avoid dumping the entire repo into the prompt.

Prompt should be built from:

- deterministic packs (project/lane/conflict)
- targeted file reads from mirror:
  - conflict files
  - immediately related files discovered via search

Hard limits per job:

- max files read
- max bytes read
- max tokens in/out

### 6.5 Caching

- Cache summaries keyed by `(blobHash, promptVersion)` so rereads are cheap.
- Cache "project map" results keyed by `(snapshotId, configVersion)`.

## 7. Desktop Notification of Job Status

MVP options:

- Poll `GET /v1/jobs?projectId=...`
- Later:
  - API Gateway WebSocket API
  - AppSync subscriptions

Job status events:

- queued
- running
- needs_more_context (internal)
- succeeded (artifact pointers)
- failed (error, retryable?)

## 8. GitHub Auth (Separate Concern)

GitHub PR integration can be implemented either with:

- OAuth token per user (simpler)
- GitHub App (better long-term for teams)

This is orthogonal to hosted agent auth. The hosted agent does not need GitHub credentials to read repo mirrors or propose patches.

## 8.1 Why GitHub Auth Is Still Needed (Later)

- Hosted agent reads from the mirrored S3 contents, not directly from GitHub.
- GitHub auth is only needed for:
  - creating PRs
  - reading PR status/checks
  - pushing branches (git remote auth) if you want to do it without the user’s local git credential manager

For MVP, PR integration can be local-only (user’s git auth) or use a GitHub token later.

## 9. Minimal API Endpoints (MVP)

Examples (names can change, but this is the intended surface):

- `POST /v1/projects` create/register project
- `POST /v1/projects/:id/lanes` register lane
- `POST /v1/mirror/:projectId/:laneId/snapshots` create snapshot manifest (after blob uploads)
- `POST /v1/jobs` enqueue job
- `GET /v1/jobs?projectId=...` list jobs
- `GET /v1/artifacts/:id` fetch artifact metadata (pack/proposal pointers)

Blob upload pattern:

- `POST /v1/uploads` -> returns signed **S3** URLs for missing blob hashes
- Desktop uploads directly to **S3** using those signed URLs

## 10. Concrete AWS Resources (MVP)

### 10.1 S3 Layout

Use one bucket with prefixes (simpler) or two buckets (clearer). Recommended: one bucket with prefixes.

Bucket: `ade-<env>-store`

- `blobs/<sha256>`: content-addressed blobs (dedup across lanes)
- `projects/<projectId>/lanes/<laneId>/snapshots/<snapshotId>/manifest.json`
- `projects/<projectId>/artifacts/<artifactId>/...` (packs, proposals, logs)

Enable:

- SSE-S3 (default) or SSE-KMS (later if needed)
- lifecycle rules:
  - keep only last N snapshots per lane (delete old manifests)
  - delete unreferenced blobs after a grace period (requires GC job)

### 10.2 DynamoDB Tables (Minimal)

Table: `ade-<env>-meta`

Single-table design is possible, but for MVP you can also use multiple tables. Recommended MVP: multiple tables to reduce complexity.

Option A (multiple tables):

- `ade-<env>-projects`:
  - PK: `userId`
  - SK: `projectId`
  - attrs: `rootName`, `createdAt`, `settingsJson`
- `ade-<env>-lanes`:
  - PK: `projectId`
  - SK: `laneId`
  - attrs: `name`, `baseRef`, `createdAt`, `status`
- `ade-<env>-jobs`:
  - PK: `projectId`
  - SK: `jobId`
  - attrs: `type`, `status`, `createdAt`, `updatedAt`, `snapshotId`, `artifactIds[]`, `error`
  - GSI1: PK=`jobId` for direct lookup (optional)
- `ade-<env>-artifacts`:
  - PK: `projectId`
  - SK: `artifactId`
  - attrs: `type`, `s3Key`, `createdAt`, `metadataJson`

### 10.3 SQS

Queue: `ade-<env>-jobs`

- DLQ: `ade-<env>-jobs-dlq`
- message body includes:
  - `projectId`, `laneId?`, `jobType`, `snapshotId`, `inputsPointers`

### 10.4 Lambda Functions

- `ade-<env>-api` (API handlers):
  - `POST /v1/projects`
  - `POST /v1/uploads` (presigned URLs)
  - `POST /v1/jobs` (enqueue SQS)
  - `GET /v1/jobs` (poll)
  - `GET /v1/artifacts/:id` (metadata + signed download URL)
- `ade-<env>-worker` (SQS consumer):
  - reads mirror state from S3
  - calls LLM gateway module/provider
  - writes artifacts to S3
  - updates job status in DynamoDB

### 10.5 API Gateway Auth

Use a JWT authorizer integrated with Cognito User Pool for all endpoints except:

- health check
- login bootstrap endpoints (if any)

### 10.6 Secrets Manager

Store:

- LLM provider API keys
- any signing secrets for presigned URL policies (if needed beyond AWS signing)

Never ship these secrets to the desktop.

## 11. Deployment With SST (MVP)

SST should define:

- API Gateway + Lambdas
- S3 bucket(s)
- SQS queue + worker subscription
- DynamoDB table(s)
- Cognito resources (or reference existing)

This keeps environments reproducible (`dev`, `staging`, `prod`).
