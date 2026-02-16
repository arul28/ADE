# Cloud Backend Architecture (AWS)

> Last updated: 2026-02-12

The ADE cloud backend is a fully serverless AWS stack for hosted mirror sync and async job processing.

---

## Overview

The cloud backend serves two primary functions:

1. Mirror storage: receive and store read-only lane snapshots (content-addressed blobs + manifests).
2. Job processing: run asynchronous hosted jobs (narratives, conflict proposals, PR drafting) against **bounded desktop exports**, optionally delivered via mirror references.

The backend uses API Gateway, Lambda, DynamoDB, S3, and SQS in AWS. Authentication is handled by Clerk OAuth/JWT, with API Gateway JWT validation.

---

## Design Decisions

### Why Serverless?

ADE workloads are bursty. Serverless keeps idle cost near zero and scales automatically during sync/job spikes.

### Why SST?

SST provides TypeScript-native infrastructure definitions with concise serverless constructs and easy stage isolation.

### Why Clerk Instead of Cognito?

Phase 6 requires a desktop-friendly social sign-in with simpler UX and reliable OAuth flows. Clerk provides:

- GitHub + Google social auth setup in one app
- OAuth public clients + PKCE support for native/desktop loopback auth
- OIDC/JWT-compatible issuer for API Gateway authorizers
- Simpler operational model than maintaining Cognito + GitHub federation wiring

### Why DynamoDB + S3 + SQS?

- DynamoDB: low-latency metadata/state keyed by user/project/job
- S3: cheap durable mirror/artifact storage
- SQS: straightforward retry + DLQ semantics for hosted jobs

---

## Technical Details

### Service Map

```text
Desktop App
  -> Clerk OAuth authorize/token (GitHub/Google sign-in, PKCE)
  -> API Gateway HTTP API (Bearer access token)
      -> JWT authorizer (issuer/audience from Clerk)
      -> Lambda API handlers
          -> DynamoDB (projects/lanes/jobs/artifacts/rate-limits)
          -> S3 (blobs/manifests/artifacts)
          -> SQS (jobs)
              -> Lambda worker
                  -> LLM gateway
                  -> S3 + DynamoDB artifact/status updates
```

### Infrastructure as Code (SST)

All resources are defined in `infra/sst.config.ts` with stage-scoped naming (`ade-<stage>-...`).

- Stage isolation: `dev`, `staging`, `prod`
- Shared-account safety: account allowlist + optional global tags
- Resource naming discipline: ADE prefix + stage scope for every resource

### Authentication Flow (Desktop)

1. Desktop starts PKCE flow to Clerk OAuth authorize endpoint.
2. User signs in with GitHub in browser.
3. Clerk redirects back to desktop loopback callback (`127.0.0.1:42420/callback`).
4. Desktop exchanges code for access/refresh/id tokens at Clerk token endpoint.
5. Desktop stores auth tokens in OS-backed secure storage.
6. Desktop uses access token for API requests; refresh token is used for silent renewal.
7. API Gateway validates JWT (`iss` + `aud`) before invoking protected handlers.

### API Endpoints

All protected routes require `Authorization: Bearer <token>` with Clerk-issued JWT.

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/projects` | Register hosted mirror project |
| `GET` | `/projects/:id` | Read project metadata |
| `POST` | `/projects/:id/upload` | Upload blob batch |
| `POST` | `/projects/:id/lanes/:lid/manifest` | Upsert lane manifest |
| `POST` | `/projects/:id/packs/manifest` | Upsert packs manifest (discoverable pack blobs) |
| `POST` | `/projects/:id/transcripts/manifest` | Upsert transcripts manifest (discoverable transcript blobs) |
| `POST` | `/projects/:id/jobs` | Submit hosted job |
| `GET` | `/projects/:id/jobs/:jid` | Poll job status |
| `GET` | `/projects/:id/artifacts/:aid` | Fetch artifact content |
| `DELETE` | `/projects/:id` | Delete hosted project data |

### DynamoDB Tables

- `ade-<stage>-projects` (PK: `userId`, SK: `projectId`)
- `ade-<stage>-lanes` (PK: `projectId`, SK: `laneId`)
- `ade-<stage>-jobs` (PK: `projectId`, SK: `jobId`, GSI `statusIndex`)
- `ade-<stage>-artifacts` (PK: `projectId`, SK: `artifactId`, TTL `expiresAt`)
- `ade-<stage>-rate-limits` (PK: `userId`, SK: `windowKey`, TTL `expiresAt`)

`userId` is derived from JWT `sub` claim and is the tenant partition key for project ownership and rate limits.

### S3 Buckets

- `ade-<stage>-blobs-<accountId>`
- `ade-<stage>-manifests-<accountId>`
- `ade-<stage>-artifacts-<accountId>`

All buckets are private and encrypted at rest.

---

## How Job Context Works (Inline vs Mirror Ref)

Hosted jobs accept `params` (arbitrary JSON) which ADE uses to build LLM prompts.

ADE supports two delivery modes:

1. **Inline params**: Desktop sends bounded exports (for example `LaneExportStandard` as `packBody`) directly in the job submission `params`. This works even if mirror sync is disabled.
2. **Mirror ref params**: Desktop uploads the full `params` JSON as a content-addressed blob to S3 (via `/projects/:id/upload`) and submits a small `params` object containing:
   - `__adeContextRef` (sha256 + metadata)
   - `__adeContextInline` (a reduced inline fallback)

The worker resolves `__adeContextRef` before building prompts. If resolution fails, it falls back to `__adeContextInline`.

### Why DynamoDB Exists If Mirror Can Hold Context

DynamoDB stores durable job metadata (status transitions, error details, metrics) and small request parameters. Mirror refs keep those request records small while still allowing richer context to live in S3 when needed.

### Queue + Worker

- Jobs queue: `ade-<stage>-jobs`
- DLQ: `ade-<stage>-jobs-dlq`
- Worker Lambda consumes queue (batch size 1) and writes status/artifacts.

### LLM Gateway

Hosted workers use the LLM gateway module with provider secrets from AWS Secrets Manager (`ade-<stage>-llm-provider`). Gemini support remains available.

### Monitoring

CloudWatch alarms:

- DLQ visible message count > 0
- Oldest jobs queue message age >= 5 minutes

---

## Naming and Shared Account Safety

ADE is deployed in a shared AWS account. Safety constraints:

- All resources prefixed with `ade-`
- Stage-scoped names (`dev`, `staging`, `prod`)
- Optional default tags:
  - `project=ade`
  - `environment=<stage>`
  - `managed-by=sst`

---

## Integration Points

### Desktop

- Hosted auth service: Clerk OAuth loopback sign-in + token refresh + secure token persistence
- Hosted sync service: blob/manifests upload pipeline
- Hosted jobs service: submit/poll/fetch artifact flows
- Settings/startup UX: apply bootstrap + sign-in/guest decisions

### Security

- API authentication enforced at API Gateway JWT authorizer
- Tenant isolation via `sub`-partitioned records and per-project checks
- In-transit TLS + at-rest encryption across services
- Secret redaction on mirrored text content

---

## Implementation Status

Phase 6 cloud stack and desktop hosted path are implemented in this repository with Clerk-based auth replacing Cognito.

---

## 2026-02-16 Hardening Addendum

### Mirror lifecycle and cleanup

The backend now enforces bounded mirror growth with a reachability-based cleanup path:

1. Load active manifest references (`lane`, `packs`, `transcripts`, `project`).
2. Parse reachable blob digests from manifests.
3. Scan blob objects with scan caps (`maxObjectsScanned`, `maxBytesScanned`).
4. Mark stale, unreachable digests as orphan candidates (grace window).
5. Delete only capped orphan batches (`maxDelete`).
6. Return cleanup telemetry in response payload.

New cleanup telemetry fields:

- `mirrorReachableBlobs`
- `mirrorOrphanedBlobs`
- `mirrorDeleted`
- `mirrorReclaimedBytes`
- `cleanupResult`
- `cleanupError`

New endpoint:

- `POST /projects/:id/mirror/cleanup`

### Job resolution behavior (worker)

- Worker resolves `__adeContextRef` first.
- On missing ref object, worker falls back to `__adeContextInline`.
- Worker records context source in job metrics (`mirror` | `inline` | `inline_fallback`).
- Conflict jobs with incomplete file context return structured insufficient-context artifacts instead of speculative patches.

### Why this improves reliability and cost

- Reliability:
  - Context provenance is explicit and auditable end-to-end.
  - Fallbacks are deterministic with warning surfaces.
  - Conflict jobs avoid unsafe patch speculation when evidence is incomplete.
- Cost:
  - Orphan blob cleanup prevents unbounded S3 growth.
  - Scan/delete caps keep cleanup predictable and safe.

---

## 2026-02-16 Addendum — Narrative Timing + Inline/Mirror Decision Framing

### End-to-end flow (authoritative)

`repo change -> pack refresh -> context export decision -> job submission -> worker context resolution -> prompt build -> model -> artifact -> pack event`

### Mirror vs inline matrix (operational)

- Inline: default for bounded narrative/project exports and mirror-independent reliability.
- Mirror-ref: used for large payloads, conflict-heavy submissions, or mirror-preferred policy.
- Inline fallback is always included for mirror-ref jobs to prevent hard failures.

ADE does **not** default to full-repo mirror context for every job. This is intentional:

- lower request variance
- deterministic bounded prompts
- better failure explainability

### Phase telemetry

Hosted narrative calls now track:

- submit start + submit duration
- queue wait duration
- poll duration
- artifact fetch duration
- total duration
- explicit timeout reason codes

These are surfaced to desktop status (`contextTelemetry`) and persisted in narrative pack events for postmortems.

