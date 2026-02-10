# Hosted ADE Agent (Read-Only Mirror)

Last updated: 2026-02-10

## 1. Purpose

The hosted ADE agent provides:

- narrative augmentation for packs (reasoning and summaries)
- conflict resolution proposals (patches + explanation)

It does not:

- apply patches
- run tests
- mutate repo state

## 2. Repo Mirror Model

The hosted agent can "read the whole repo" by maintaining a synced mirror, subject to excludes.

Sync policy:

- forced sync on terminal session end
- coalesced sync while edits are happening (time window + dirty-line threshold)

Exclude defaults (customizable):

- `.git/**`
- `.ade/**`
- `**/node_modules/**`
- `**/dist/**`, `**/build/**`, `**/.next/**`, `**/coverage/**`
- `.env`, `.env.*`, `*.pem`, `*.key`, `*id_rsa*`

## 3. Job Types (Cloud)

- `UpdateProjectPackNarrative`
- `UpdateLanePackNarrative`
- `UpdateConflictPackNarrative`
- `ProposeConflictResolution`
- `DraftPrDescription`

Inputs:

- deterministic pack(s) + metadata (lane id, base ref, shas)
- optional full diffs for specific files (bounded)

Outputs:

- narrative markdown (to be merged into packs or shown as "agent notes")
- patch proposals (unified diffs) with confidence metadata

## 4. Security and Trust Requirements

- Strong tenant isolation.
- Encryption in transit and at rest.
- Access control: hosted agent only reads mirrors for projects the user authorized.
- Retention: bounded retention for mirrors and artifacts; make policy explicit in product.
- Audit logs: what was read, what was produced.

## 5. Cost Controls (Required)

- Per-job token budgets and file-read budgets.
- Caching keyed by content hash (avoid rereading/resummarizing unchanged files).
- Coalescing: do not run narrative jobs on every keystroke; tie to session end/commit.

## 6. Swappability

The same pipeline must work with:

- Hosted provider (default)
- BYOK provider (no mirror; local retrieval only)
- CLI provider (best-effort, interactive)

All providers implement the same internal `ManagerProvider` output types.

