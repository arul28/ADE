# Cloud Backend Architecture (AWS)

> Last updated: 2026-02-11

The ADE cloud backend is a fully serverless AWS stack that powers the hosted agent service and mirror sync infrastructure. It is designed for minimal operational overhead, pay-per-use pricing, and strict tenant isolation.

---

## Table of Contents

- [Overview](#overview)
- [Design Decisions](#design-decisions)
- [Technical Details](#technical-details)
  - [AWS Service Map](#aws-service-map)
  - [Infrastructure as Code (SST)](#infrastructure-as-code-sst)
  - [Authentication Flow](#authentication-flow)
  - [API Endpoints](#api-endpoints)
  - [DynamoDB Tables](#dynamodb-tables)
  - [S3 Buckets](#s3-buckets)
  - [Job Processing Pipeline](#job-processing-pipeline)
  - [LLM Gateway](#llm-gateway)
  - [Naming Conventions](#naming-conventions)
  - [Cost Estimation](#cost-estimation)
- [Integration Points](#integration-points)
- [Implementation Status](#implementation-status)

---

## Overview

The cloud backend serves two primary functions:

1. **Mirror storage**: Receives and stores read-only snapshots of lane state (content-addressed blobs and manifests) uploaded from the desktop application.
2. **Job processing**: Executes asynchronous jobs (LLM-powered artifact generation) against the mirrored data and returns results to the desktop.

The backend is fully serverless, using AWS Lambda for compute, S3 for storage, DynamoDB for metadata, SQS for job queuing, and Cognito for authentication. All infrastructure is defined and deployed using SST (Serverless Stack), an infrastructure-as-code framework built on top of AWS CDK.

---

## Design Decisions

### Why Serverless?

ADE's cloud workload is inherently bursty. Developers interact in bursts (merge a branch, submit a few jobs, wait for results) with long idle periods in between. A serverless architecture scales to zero during idle time and handles bursts without pre-provisioned capacity. This keeps costs proportional to actual usage rather than requiring always-on infrastructure.

### Why SST Over Raw CDK or Terraform?

SST provides higher-level constructs purpose-built for serverless applications (API routes, queue consumers, bucket notifications) while still allowing escape hatches to raw CDK when needed. It also provides a local development mode (`sst dev`) that enables rapid iteration without deploying to AWS. The team's existing TypeScript expertise aligns well with SST's TypeScript-native approach.

### Why Cognito?

Cognito provides managed user authentication with built-in support for OAuth providers (GitHub) and JWT token issuance. While it has known UX limitations in its hosted UI, these are acceptable for ADE because the primary interaction is a one-time desktop login flow, not a web application login page. Cognito eliminates the need to manage user databases, password hashing, or token signing infrastructure.

### Why DynamoDB Over RDS?

ADE's metadata access patterns are well-suited to DynamoDB's key-value model: lookups by project ID, lane ID, or job ID. There are no complex relational queries or multi-table joins required. DynamoDB's serverless mode (pay-per-request) aligns with the bursty access pattern, and its single-digit-millisecond latency ensures responsive API interactions.

### Why SQS Over Step Functions?

Current job types are single-step (receive input, process, store output). SQS provides simple, reliable message delivery with built-in retry and dead-letter queue support. Step Functions would add unnecessary complexity for single-step workflows. If multi-step orchestration is needed in the future (e.g., jobs that chain multiple LLM calls), Step Functions can be introduced for those specific job types without replacing the SQS foundation.

---

## Technical Details

### AWS Service Map

```
┌─────────────────────────────────────────────────────────────────┐
│                        AWS Account                              │
│                                                                 │
│  ┌──────────┐    ┌──────────────┐    ┌──────────────────────┐  │
│  │ Cognito  │    │ API Gateway  │    │ CloudWatch           │  │
│  │ User Pool│───>│ (HTTP API)   │    │ (Logs + Metrics)     │  │
│  │ + GitHub │    │              │    │                      │  │
│  │ OAuth    │    └──────┬───────┘    └──────────────────────┘  │
│  └──────────┘           │                                      │
│                         ▼                                      │
│              ┌──────────────────┐                               │
│              │ Lambda Functions │                               │
│              │ ┌──────────────┐ │                               │
│              │ │ API Handlers │ │──────> DynamoDB Tables        │
│              │ └──────────────┘ │        ┌──────────────────┐  │
│              │ ┌──────────────┐ │        │ ade-<env>-       │  │
│              │ │ Job Workers  │ │        │   projects       │  │
│              │ └──────┬───────┘ │        │   lanes          │  │
│              └────────┼─────────┘        │   jobs           │  │
│                       │                  │   artifacts      │  │
│              ┌────────▼─────────┐        └──────────────────┘  │
│              │ SQS Job Queue    │                               │
│              │ + Dead Letter Q  │        S3 Buckets             │
│              └──────────────────┘        ┌──────────────────┐  │
│                                          │ ade-<env>-       │  │
│                                          │   blobs          │  │
│                                          │   manifests      │  │
│                                          │   artifacts      │  │
│                                          └──────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### Infrastructure as Code (SST)

All AWS resources are defined in an SST configuration. The project structure follows SST conventions:

```
infra/
├── sst.config.ts          # SST project configuration
├── stacks/
│   ├── AuthStack.ts       # Cognito User Pool + GitHub OAuth
│   ├── ApiStack.ts        # API Gateway + Lambda handlers
│   ├── StorageStack.ts    # S3 buckets + DynamoDB tables
│   ├── QueueStack.ts      # SQS queues + Lambda consumers
│   └── MonitoringStack.ts # CloudWatch dashboards + alarms
└── packages/
    ├── functions/         # Lambda function code
    │   ├── api/           # API handler functions
    │   └── workers/       # Job worker functions
    └── core/              # Shared business logic
        ├── llm/           # LLM gateway module
        ├── jobs/          # Job type definitions
        └── models/        # DynamoDB data models
```

**Environment stages**: `dev`, `staging`, `prod`. Each stage deploys a fully isolated set of resources with the naming convention `ade-<env>-<resource>`.

### Authentication Flow

The desktop application authenticates with the cloud backend using Cognito with GitHub OAuth. The flow uses a loopback redirect to capture the authorization code locally.

```
Desktop App                 Cognito                    GitHub
    │                          │                          │
    │  1. Open browser to      │                          │
    │     Cognito hosted UI    │                          │
    │ ────────────────────────>│                          │
    │                          │  2. Redirect to GitHub   │
    │                          │     OAuth consent        │
    │                          │ ────────────────────────>│
    │                          │                          │
    │                          │  3. User authorizes      │
    │                          │<────────────────────────│
    │                          │                          │
    │  4. Authorization code   │                          │
    │     to localhost:PORT    │                          │
    │<────────────────────────│                          │
    │                          │                          │
    │  5. Exchange code for    │                          │
    │     tokens               │                          │
    │ ────────────────────────>│                          │
    │                          │                          │
    │  6. Access + Refresh +   │                          │
    │     ID tokens returned   │                          │
    │<────────────────────────│                          │
    │                          │                          │
    │  7. Store tokens in      │                          │
    │     OS keychain          │                          │
    │                          │                          │
```

**Token management**:

| Token | Purpose | Lifetime | Storage |
|-------|---------|----------|---------|
| Access token | API authentication (Bearer header) | 1 hour | Memory (runtime) |
| Refresh token | Obtain new access tokens | 30 days | OS keychain |
| ID token | User identity claims (email, sub) | 1 hour | Memory (runtime) |

The desktop app automatically refreshes the access token using the refresh token before it expires. If the refresh token itself expires (30 days without use), the user is prompted to re-authenticate.

### API Endpoints

All endpoints are authenticated via Cognito JWT (Bearer token in Authorization header). The API is versioned implicitly via the SST stage.

| Method | Path | Description | Request Body | Response |
|--------|------|-------------|-------------|----------|
| `POST` | `/projects` | Register a new project | `{ name, repoUrl?, rootPath }` | `{ projectId, createdAt }` |
| `GET` | `/projects/:id` | Get project metadata | — | `{ projectId, name, lanes, ... }` |
| `POST` | `/projects/:id/upload` | Upload a batch of blobs | Multipart: blob data + metadata | `{ uploaded, deduplicated }` |
| `POST` | `/projects/:id/lanes/:lid/manifest` | Update lane manifest | Manifest JSON | `{ manifestId, timestamp }` |
| `POST` | `/projects/:id/jobs` | Submit a processing job | `{ type, laneId, params }` | `{ jobId, status: "queued" }` |
| `GET` | `/projects/:id/jobs/:jid` | Get job status and result | — | `{ jobId, status, artifactId? }` |
| `GET` | `/projects/:id/artifacts/:aid` | Download generated artifact | — | Artifact content (JSON or markdown) |
| `DELETE` | `/projects/:id` | Delete project and all data | — | `{ deleted: true }` |

**Error responses** follow a consistent format:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Human-readable description",
    "details": {}
  }
}
```

### DynamoDB Tables

All tables use on-demand (pay-per-request) billing mode.

#### `ade-<env>-projects`

| Attribute | Type | Key | Description |
|-----------|------|-----|-------------|
| `userId` | String | PK | Cognito user sub |
| `projectId` | String | SK | Unique project identifier |
| `name` | String | — | Project display name |
| `repoUrl` | String | — | Git remote URL (optional) |
| `createdAt` | String | — | ISO 8601 timestamp |
| `updatedAt` | String | — | ISO 8601 timestamp |
| `blobCount` | Number | — | Total blobs stored |
| `totalSize` | Number | — | Total storage in bytes |

#### `ade-<env>-lanes`

| Attribute | Type | Key | Description |
|-----------|------|-----|-------------|
| `projectId` | String | PK | Parent project ID |
| `laneId` | String | SK | Unique lane identifier |
| `headSha` | String | — | Current HEAD commit SHA |
| `branchRef` | String | — | Git branch reference |
| `manifestKey` | String | — | S3 key for latest manifest |
| `lastSyncAt` | String | — | ISO 8601 timestamp of last sync |

#### `ade-<env>-jobs`

| Attribute | Type | Key | Description |
|-----------|------|-----|-------------|
| `projectId` | String | PK | Parent project ID |
| `jobId` | String | SK | Unique job identifier (ULID) |
| `type` | String | — | Job type enum |
| `status` | String | GSI PK | `queued`, `processing`, `completed`, `failed` |
| `laneId` | String | — | Target lane |
| `params` | Map | — | Job-type-specific parameters |
| `artifactId` | String | — | Result artifact ID (when completed) |
| `submittedAt` | String | — | ISO 8601 timestamp |
| `completedAt` | String | — | ISO 8601 timestamp |
| `error` | Map | — | Error details (when failed) |

**GSI**: `status-index` with PK `status` and SK `submittedAt` for efficient status-based queries.

#### `ade-<env>-artifacts`

| Attribute | Type | Key | Description |
|-----------|------|-----|-------------|
| `projectId` | String | PK | Parent project ID |
| `artifactId` | String | SK | Unique artifact identifier |
| `jobId` | String | — | Source job ID |
| `type` | String | — | Artifact type (narrative, diff, pr-description) |
| `s3Key` | String | — | S3 key for artifact content |
| `contentHash` | String | — | SHA-256 of artifact content |
| `createdAt` | String | — | ISO 8601 timestamp |
| `expiresAt` | Number | — | TTL epoch for auto-deletion |

### S3 Buckets

All buckets have versioning disabled (content-addressed storage provides immutability), server-side encryption enabled (SSE-S256), and public access blocked.

| Bucket | Key Format | Purpose | Lifecycle |
|--------|-----------|---------|-----------|
| `ade-<env>-blobs` | `<projectId>/<sha256>` | Content-addressed source file blobs | Deleted when project deleted |
| `ade-<env>-manifests` | `<projectId>/<laneId>/manifest.json` | Lane manifest snapshots | Overwritten on each sync |
| `ade-<env>-artifacts` | `<projectId>/<artifactId>` | Generated artifacts (narratives, diffs) | TTL-based expiry (default 30 days) |

### Job Processing Pipeline

```
Desktop                API Gateway          SQS                Lambda Worker
   │                       │                  │                      │
   │  POST /jobs           │                  │                      │
   │ ─────────────────────>│                  │                      │
   │                       │  Validate +      │                      │
   │                       │  write to DDB    │                      │
   │                       │  (status:queued) │                      │
   │                       │                  │                      │
   │                       │  SendMessage     │                      │
   │                       │ ────────────────>│                      │
   │                       │                  │                      │
   │  { jobId, "queued" }  │                  │  Receive message     │
   │ <─────────────────────│                  │ ────────────────────>│
   │                       │                  │                      │
   │                       │                  │  Update DDB          │
   │                       │                  │  (status:processing) │
   │                       │                  │                      │
   │                       │                  │  Fetch blobs from S3 │
   │                       │                  │  Invoke LLM gateway  │
   │                       │                  │  Store artifact in S3│
   │                       │                  │  Update DDB          │
   │                       │                  │  (status:completed)  │
   │                       │                  │                      │
   │  GET /jobs/:jid       │                  │                      │
   │ ─────────────────────>│                  │                      │
   │  { status, artifact } │                  │                      │
   │ <─────────────────────│                  │                      │
```

**Retry policy**: Messages are retried up to 3 times with exponential backoff. After 3 failures, the message is moved to a dead-letter queue for investigation. The job status is updated to `failed` with error details.

**Visibility timeout**: 5 minutes (sufficient for most LLM-powered jobs). Extended to 15 minutes for `ProposeConflictResolution` jobs, which may require multiple LLM rounds.

### LLM Gateway

The LLM gateway is an internal module (not a third-party service) that runs within the Lambda worker process. See [HOSTED_AGENT.md](./HOSTED_AGENT.md) for detailed gateway architecture.

**Key responsibilities within the cloud backend context**:

- Load prompt templates from the deployment bundle (versioned with Lambda code)
- Select the appropriate model based on job type and configured provider
- Enforce per-job token budgets to prevent runaway costs
- Cache system prompts and repeated context prefixes
- Validate LLM responses against expected output schemas
- Report token usage metrics to CloudWatch for cost monitoring

### Naming Conventions

All AWS resources follow a consistent naming convention for clarity and environment isolation. **ADE is deployed in a shared AWS account** alongside other projects, so all resources MUST be prefixed with `ade-` and tagged for identification.

**AWS Account Context:**
- Account: `695094375923`
- IAM User: `ArulSharma` (profile: `arulsharma`)
- Deployment tool: SST (uses the `arulsharma` AWS profile)

**Resource Naming:**

```
ade-<env>-<resource>
```

| Component | Example (prod) | Example (dev) |
|-----------|---------------|--------------|
| S3 bucket | `ade-prod-blobs` | `ade-dev-blobs` |
| DynamoDB table | `ade-prod-projects` | `ade-dev-projects` |
| SQS queue | `ade-prod-jobs` | `ade-dev-jobs` |
| Lambda function | `ade-prod-api-submitJob` | `ade-dev-api-submitJob` |
| Cognito pool | `ade-prod-users` | `ade-dev-users` |
| CloudWatch log group | `/ade/prod/api` | `/ade/dev/api` |
| IAM roles | `ade-prod-api-role` | `ade-dev-api-role` |

**Mandatory Resource Tags:**

Every AWS resource created for ADE MUST include these tags. Configure in the SST `sst.config.ts` via `app.tags`:

| Tag Key | Value | Purpose |
|---------|-------|---------|
| `project` | `ade` | Identify ADE resources in the shared account |
| `environment` | `dev` / `staging` / `prod` | Environment isolation |
| `managed-by` | `sst` | Track IaC-managed resources |

SST configuration for global tagging:

```typescript
// sst.config.ts
export default $config({
  app(input) {
    return {
      name: "ade",
      removal: input?.stage === "prod" ? "retain" : "remove",
      home: "aws",
      providers: {
        aws: {
          profile: "arulsharma",
          region: "us-east-1",
        },
      },
    };
  },
  // ...
});
```

SST automatically prefixes all resource names with `{app}-{stage}-` when using `sst.aws.*` constructs (e.g., `new sst.aws.Dynamo(...)` named `"projects"` becomes `ade-dev-projects`). Ensure all constructs use short, descriptive names without redundant `ade-` prefixes in code — SST handles the prefixing.

### Cost Estimation

Estimated costs for a single active developer with moderate usage (10 job submissions per day, 500 MB mirrored repository).

| Service | Monthly Estimate | Basis |
|---------|-----------------|-------|
| Lambda | ~$1-5 | ~300 invocations/month, avg 10s duration |
| S3 | ~$0.50-2 | 500 MB storage + request fees |
| DynamoDB | ~$0.50-1 | ~1,000 reads/writes per month (on-demand) |
| SQS | ~$0.01 | ~300 messages/month (free tier covers most) |
| API Gateway | ~$0.50 | ~1,000 requests/month |
| Cognito | Free | Under 50,000 MAU free tier |
| LLM API | ~$5-30 | Variable by model and token usage, budget-capped |
| **Total** | **~$8-39** | **Per developer per month** |

These estimates assume the AWS free tier is exhausted. Actual costs will be lower during early adoption due to free tier benefits.

---

## Integration Points

### Desktop Application

- **Auth service** (`authService.ts`): Manages Cognito login flow, token storage in OS keychain, and automatic refresh.
- **Sync service** (`mirrorSyncService.ts`): Handles blob upload, manifest generation, and delta computation against the API.
- **Job service** (`hostedJobService.ts`): Submits jobs, polls for status, and downloads artifacts.
- **Config service** (`projectConfigService.ts`): Provides provider configuration that determines whether jobs go to the cloud or are processed locally.

### Hosted Agent

- The cloud backend is the runtime environment for the hosted agent (see [HOSTED_AGENT.md](./HOSTED_AGENT.md)).
- Lambda workers implement the job types defined in the hosted agent architecture.
- The LLM gateway module runs within the Lambda execution context.

### Security

- All security policies described in [SECURITY_AND_PRIVACY.md](./SECURITY_AND_PRIVACY.md) apply to the cloud backend.
- Cognito JWT validation on every API request.
- Tenant isolation enforced at the DynamoDB and S3 key prefix level.
- Encryption at rest and in transit for all data stores.

---

## Implementation Status

| Component | Status | Notes |
|-----------|--------|-------|
| Architecture design | Complete | Documented in this file |
| SST project scaffolding | Not started | `infra/` directory not created |
| Cognito User Pool | Not started | GitHub OAuth provider not configured |
| API Gateway + routes | Not started | Endpoint definitions designed |
| DynamoDB tables | Not started | Schema designed |
| S3 buckets | Not started | Naming and policies designed |
| SQS queues | Not started | Retry and DLQ policies designed |
| Lambda API handlers | Not started | — |
| Lambda job workers | Not started | Depends on LLM gateway |
| LLM gateway module | Not started | Prompt templates not authored |
| CloudWatch monitoring | Not started | — |
| Desktop auth integration | Not started | `authService.ts` not implemented |
| Desktop sync integration | Not started | `mirrorSyncService.ts` not implemented |
| Cost monitoring dashboard | Not started | — |

**Overall status**: NOT YET STARTED. Architecture fully designed, AWS stack not provisioned, no implementation work has begun.
