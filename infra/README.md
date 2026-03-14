# ADE Cloud Infrastructure (Phase 6)

This directory contains the SST deployment for ADE's Phase 6 cloud backend.

## What Gets Deployed

- API Gateway HTTP API + Lambda handlers
- API Gateway JWT authorizer configured for Clerk-issued access tokens
- SQS jobs queue + DLQ + worker Lambda subscriber
- S3 buckets for blobs, manifests, and generated artifacts
- DynamoDB tables for projects, lanes, jobs, artifacts, and rate limits
- Secrets Manager secret for hosted LLM credentials
- CloudWatch alarms for queue age and DLQ visibility

## Shared Account Safety

This stack is configured for the shared ADE AWS account and enforces ADE ownership:

- AWS profile: `default` by default (override with `AWS_PROFILE`)
- Allowed account ID: set via `ADE_ALLOWED_AWS_ACCOUNT_ID` environment variable
- Optional global tags on all taggable resources (enable with `ADE_ENABLE_AWS_DEFAULT_TAGS=true`):
  - `project=ade`
  - `environment=<stage>`
  - `managed-by=sst`
- Resource naming strategy:
  - All names are `ade-<stage>-...`
  - S3 buckets include account suffix for global uniqueness (`ade-<stage>-<bucket>-<accountId>`)

Note: Some shared-account IAM setups block API Gateway stage tagging. If deploy fails on `apigateway:TagResource`, leave global default tags disabled (the current default) and rely on ADE-prefixed resource names.

## Clerk Setup (GitHub + Google Sign-In / Sign-Up)

Phase 6 uses Clerk OAuth for desktop hosted auth. Social sign-in is supported through GitHub and Google.

1. Create a Clerk application.
2. Enable social connections in Clerk:
- GitHub
- Google
3. Create a Clerk OAuth application for ADE desktop:
- Client type: `Public`
- Redirect URIs:
  - `http://127.0.0.1:42420/callback`
  - `http://localhost:42420/callback`
- Scopes: `openid profile email offline_access`
4. Copy these values:
- Clerk publishable key
- Clerk secret key
- Clerk OAuth client ID (from the Clerk OAuth application created above)

Important:
- `CLERK_OAUTH_CLIENT_ID` is the OAuth app client ID from Clerk (`Configure` -> `OAuth applications`).
- It is not the GitHub OAuth app client ID and not the Google OAuth client ID used inside Clerk social connection setup.

## Prerequisites

1. Install dependencies:

```bash
cd infra
npm install
```

2. Configure required SST secrets (stage-scoped):

```bash
npx sst secret set NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY <clerk-publishable-key> --stage dev
npx sst secret set CLERK_OAUTH_CLIENT_ID <clerk-oauth-client-id> --stage dev
```

Optional (reserved for server-side Clerk API work in later phases):

```bash
npx sst secret set CLERK_SECRET_KEY <clerk-secret-key> --stage dev
```

3. Optional auth overrides (normally not needed):
- `ADE_CLERK_FRONTEND_API_URL`
- `ADE_CLERK_ISSUER`
- `ADE_CLERK_OAUTH_METADATA_URL`
- `ADE_CLERK_OAUTH_SCOPES`

4. Create/update the hosted LLM secret in AWS Secrets Manager after first deploy:

Secret name output: `ade-<stage>-llm-provider`

Expected JSON value:

```json
{
  "openaiApiKey": "sk-...",
  "anthropicApiKey": "sk-ant-...",
  "geminiApiKey": "AIza...",
  "defaultProvider": "gemini",
  "defaultModel": "gemini-3-flash-preview"
}
```

## Deploy

```bash
cd infra
./scripts/deploy.sh dev
```

Or directly:

```bash
npx sst deploy --stage dev
npx sst deploy --stage staging
npx sst deploy --stage prod
```

## Desktop Bootstrap Config (No Manual Endpoint Entry)

After each deploy, write a desktop bootstrap file from SST outputs:

```bash
cd infra
bash ./scripts/write-desktop-bootstrap.sh dev
```

The script reads `infra/.sst/outputs.json` (written by `sst deploy`) and writes:

- `.ade/hosted/bootstrap.json`

The desktop Startup page and Settings page can apply Clerk + API configuration directly from this file.

## Rate Limits / Quotas

Hosted job submission enforces per-user limits in DynamoDB:

- jobs per minute
- jobs per day
- estimated tokens per day

Tune via environment variables:

- `ADE_RATE_LIMIT_JOBS_PER_MINUTE`
- `ADE_RATE_LIMIT_DAILY_JOBS`
- `ADE_RATE_LIMIT_DAILY_ESTIMATED_TOKENS`

## Outputs

`sst deploy` prints the outputs needed by the desktop client:

- `apiUrl`
- `clerk.publishableKey`
- `clerk.oauthClientId`
- `clerk.issuer`
- `clerk.frontendApiUrl`
- `clerk.oauthMetadataUrl`
- `clerk.oauthAuthorizeUrl`
- `clerk.oauthTokenUrl`
- `clerk.oauthRevocationUrl`
- `clerk.oauthUserInfoUrl`
- `clerk.oauthScopes`
- bucket/table/queue names
- `llmProviderSecretArn`
