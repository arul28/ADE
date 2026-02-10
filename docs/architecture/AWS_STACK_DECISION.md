# AWS Stack Decision (MVP)

Last updated: 2026-02-10

We are locking the hosted-agent backend to AWS to consume AWS credits and keep the infra vendor-simple.

## Locked AWS Services

- IaC/deploy: **SST**
- Auth: **Cognito User Pool + Hosted UI**
  - login: **GitHub OAuth** federated into Cognito (no email verification path)
- API: **API Gateway (HTTP API) + Lambda**
- Jobs: **SQS + Lambda worker**
- Storage: **S3**
  - mirrors (content-addressed blobs + manifests)
  - artifacts (packs, proposals)
- Metadata DB: **DynamoDB**
- Secrets: **Secrets Manager**
- Observability: **CloudWatch** (baseline), optional **Sentry**

## Notes

- Desktop app distribution is separate from backend hosting.
- The LLM provider/model is intentionally not locked. Backend implements a provider-agnostic "LLM gateway" module.

## Naming (Suggested)

For a single AWS account hosting multiple projects, use a consistent prefix:

- `ade-<env>-api`
- `ade-<env>-jobs`
- `ade-<env>-mirrors` (S3)
- `ade-<env>-artifacts` (S3) (can be same bucket with prefixes)
- `ade-<env>-meta` (DynamoDB)
- `ade-<env>-secrets`

Where `<env>` is `dev`/`staging`/`prod`.
