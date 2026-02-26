# Context Contract v2 (backward compatible) — Packs, Exports, Markers, Graphs, Manifests, And Deltas

> Roadmap reference: `docs/final-plan.md` is the canonical future plan and sequencing source.

> Last updated: 2026-02-26

This document is the **authoritative contract** for ADE context artifacts used by:

- long-running, parallel "orchestrator mode" workflows
- spawning new agent runtimes with clean context windows
- AI integration service consuming bounded exports via Vercel AI SDK
- Guest-mode, deterministic-only workflows (no AI providers)

The contract prioritizes **reviewability** (diffable, structured artifacts) and **bounded context** (token-budgeted exports), rather than raw "dump everything" prompts.

---

## Goals

- **Stable parsing**: Packs and exports have stable headers and stable section markers.
- **Diff-friendly**: Context artifacts are structured, concise, and avoid transcript slabs by default.
- **Budgeted exports**: Orchestrators consume `Lite`/`Standard` exports by default. `Deep` is explicit and on-demand.
- **Provider-neutral AI**: AI is powered by Vercel AI SDK, which spawns subscription-powered CLI tools locally. No remote gateway assumptions.
- **Guest mode useful**: Packs, versions, events, diffs, and exports are all usable without any AI provider.
- **Explainable handoffs**: Every AI job submission records context delivery metadata with reason codes and explicit fallbacks.

Non-goals:

- Orchestrator UI / agent runner implementation (out of scope here).
- Full "pack dump" exports by default (intentionally avoided).

---

## AI Job Context Delivery

AI jobs (narratives, conflict proposals, PR drafts) consume **bounded exports** (for example `LaneExportStandard`) locally via the AI integration service.

Context is consumed entirely on the local machine:

- Bounded exports are built from pack data (token-budgeted, redacted).
- The AI integration service passes exports to CLI tools spawned by Vercel AI SDK.
- No network transmission of context is required — all processing is local.
- Exports are still structured, token-budgeted, and redacted for safety.

This is intentionally deterministic and observable:

- Pack events like `narrative_requested` record the delivery mode and metadata.
- The export level, approximate token count, and provider information are tracked.

### Runtime Profile File Injection (OpenClaw-Inspired, ADE-Owned)

For agent runtimes, ADE assembles profile files on every run rather than persisting full transcript state in model memory.

Injected profile blocks:

- `IDENTITY` (persona, role, policy defaults, allowed tool classes)
- `TOOLS` (effective tool policy after identity + project policy merge)
- `USER_PREFS` (project/user preferences relevant to the runtime)
- `HEARTBEAT` (run-local status, blockers, and recent transitions)
- `MEMORY_SUMMARY` (bounded retrieved snippets from scoped memory namespaces)

Contract rules:

- Profile files are reconstructed per runtime launch or resume.
- Profile files are bounded by export budget and redaction policy.
- Runtime profile assembly must be replayable from DB + pack/export state (no hidden in-memory dependency).

### Expected Behavior Matrix

| Scenario | AI Context | Notes |
|----------|-----------|------|
| New lane with active session | bounded export consumed locally | Works whenever a subscription provider is available |
| No subscription provider (guest mode) | no AI context needed | Deterministic packs still refresh normally |
| Conflict-heavy lane | bounded export with conflict data | Conflict risk summary included in lane exports |
| Periodic delta handoff | delta digest + bounded export | Deterministic ordering, optional omission metadata preserved |

## Pack Keys

`packKey` is the stable identifier for a pack scope.

### Required `packKey` patterns

- Project pack:
  - `project`
- Lane pack:
  - `lane:<laneId>`
- Feature pack:
  - `feature:<featureKey>`
- Plan pack:
  - `plan:<laneId>`
- Mission pack:
  - `mission:<missionId>`
- Conflict pack:
  - `conflict:<laneId>:<peerKey>`
  - `peerKey` is either:
    - a peer lane id (e.g. `lane-2`)
    - or the base ref (e.g. `main`) for lane-vs-base conflict context

Notes:

- `laneId` is the ADE lane UUID / stable id, not the lane name or branch ref.
- `featureKey` is a user-defined tag (e.g. an issue key) used to aggregate lanes.

---

## Machine-Readable Header (Schema `ade.context.v1`)

Every pack and export must contain a machine-readable header as a **JSON code fence** at the top of the markdown:

```json
{
  "schema": "ade.context.v1",
  "contractVersion": 2,
  "projectId": "proj_local_...",
  "packKey": "lane:lane-123",
  "packType": "lane",
  "exportLevel": "standard",
  "laneId": "lane-123",
  "peerKey": null,
  "baseRef": "main",
  "headSha": "abc123...",
  "deterministicUpdatedAt": "2026-02-14T00:00:00.000Z",
  "narrativeUpdatedAt": "2026-02-14T00:00:00.000Z",
  "versionId": "ver-...",
  "versionNumber": 42,
  "contentHash": "sha256...",
  "providerMode": "subscription",
  "graph": {
    "schema": "ade.packGraph.v1",
    "relations": [
      {
        "relationType": "depends_on",
        "targetPackKey": "project",
        "targetPackType": "project",
        "rationale": "Lane export depends on project context."
      }
    ]
  },
  "dependencyState": {
    "requiredMerges": [],
    "blockedByLanes": [],
    "mergeReadiness": "unknown"
  },
  "conflictState": {
    "status": "unknown",
    "lastPredictedAt": null,
    "overlappingFileCount": 0,
    "peerConflictCount": 0
  },
  "omissions": [
    {
      "sectionId": "narrative",
      "reason": "omitted_by_level",
      "recommendedLevel": "deep"
    }
  ],
  "exportedAt": "2026-02-14T00:00:01.000Z"
}
```

### Required header fields

- Identity:
  - `schema` (must be `ade.context.v1`)
  - `packKey`
  - `packType` (`project` | `lane` | `conflict` | `feature` | `plan` | `mission`)
  - `exportLevel` (exports only: `lite` | `standard` | `deep`)
- Scope:
  - `laneId` (nullable)
  - `peerKey` (nullable)
- Git snapshot:
  - `baseRef` (nullable)
  - `headSha` (nullable)
- Time:
  - `deterministicUpdatedAt` (nullable)
  - `narrativeUpdatedAt` (nullable)
- Version metadata:
  - `versionId` (nullable)
  - `versionNumber` (nullable)
  - `contentHash` (nullable)
- Provider:
  - `providerMode` (`guest` | `subscription`)

Notes:

- Packs rendered before the version is created may have `versionId/versionNumber/contentHash = null`. Consumers should treat the header as a contract for **presence of keys**, not necessarily non-null values.
- Exports returned over IPC include the authoritative version metadata.
- Secrets must never appear in headers.
- `contractVersion` is advisory (monotonic). Do not hard-gate parsing on it.

### Optional (but recommended) header fields

- Graph envelope:
  - `graph.schema` must be `ade.packGraph.v1`
  - `graph.relations[]` use `relationType`:
    - `depends_on` | `parent_of` | `blocked_by` | `blocks` | `shares_base` | `merges_into`
  - Each relation should include a stable `targetPackKey` and may include:
    - `targetLaneId`, `targetBranch`, `targetHeadCommit`, `targetVersionId`
- Machine-readable state:
  - `dependencyState` (required merges / blocked-by / merge readiness)
  - `conflictState` (prediction freshness + coverage + unresolved counts)
- Export omissions:
  - `omissions[]` enumerates omitted/truncated sections and why (`omitted_by_level` | `truncated_section` | `budget_clipped` | `data_unavailable`)

---

## Stable Section Markers

Markers are stable HTML comments used to preserve user-editable content across deterministic refreshes and to enable safe section replacement without truncation.

### Current stable markers

- Intent:
  - `<!-- ADE_INTENT_START -->`
  - `<!-- ADE_INTENT_END -->`
- Todos:
  - `<!-- ADE_TODOS_START -->`
  - `<!-- ADE_TODOS_END -->`
- Narrative:
  - `<!-- ADE_NARRATIVE_START -->`
  - `<!-- ADE_NARRATIVE_END -->`
- Task spec (orchestrator-critical):
  - `<!-- ADE_TASK_SPEC_START -->`
  - `<!-- ADE_TASK_SPEC_END -->`

### Rules

- Deterministic pack refresh must **preserve** content between markers.
- Narrative updates must use marker-based replacement (`ADE_NARRATIVE_*`) and must not truncate or delete content outside the narrative region.
- If a pack is missing markers (legacy packs), the next refresh must **upgrade in-place** by inserting markers rather than breaking compatibility.

---

## Task Spec Section (Lane Packs + Lane Exports)

Lane packs and lane exports must include a durable, user/orchestrator-editable `Task Spec` section bounded by `ADE_TASK_SPEC_START/END`.

The task spec should cover, at minimum:

- Problem statement
- Scope / non-goals
- Acceptance criteria (checklist)
- Constraints / conventions
- Dependencies (parent lane, required merges)

This section is a primary input for orchestrators and should be prioritized above narrative text.

---

## Export Levels

Exports are bounded views of packs designed for consumption by LLM jobs and orchestrators.

### Levels

- `Lite`
  - Default for spawning new agents and quick context.
  - Strictly bounded; focuses on task spec, intent, key deltas, and blockers.
- `Standard`
  - Default for narrative generation and most orchestrator steps.
  - Includes broader summaries (sessions table, validation, errors) while staying bounded.
- `Deep`
  - Explicit and on-demand.
  - Includes additional low-signal sections (e.g. narrative text) within a larger budget.

---

## Data Path Diagram

```
Pack refresh (lane/project/conflict)
  │
  ▼
Build bounded export (Lite/Standard/Deep)
  │
  ▼
AI Integration Service (local)
  │
  ▼
Vercel AI SDK spawns CLI tool (claude/codex)
  │
  ▼
CLI tool processes export locally
  │
  ▼
Result returned
  │
  ▼
Pack event recorded + narrative applied
```

---

## Conflict Prediction Summary Packs (Deterministic, No AI Required)

Conflict prediction summaries are stored on disk for each lane:

- `.ade/packs/conflicts/predictions/<laneId>.json`

This file is deterministic and must remain useful in Guest mode.

---

## Competitor Notes (Mapped to ADE Decisions)

Sources:

- [Entire blog](https://entire.io/blog)
- [Entire CLI](https://github.com/entireio/cli)
- [OneContext](https://github.com/TheAgentContextLab/OneContext)

Findings and concrete ADE decisions:

- Entire CLI stores agent session metadata on a separate git branch (`entire/checkpoints/v1`) and links it to commits, enabling rewind/resume and audit trails.
  - ADE already provides immutable pack versions + checkpoints + append-only pack events; context delivery is explicit and deterministic with delivery-mode metadata for auditability.
- OneContext positions a unified, agent-self-managed context layer with trajectory recording and cross-agent continuation.
  - ADE's approach remains deterministic-first: stable pack headers/markers + bounded exports + compact delta digests. Context delivery is explicit and local-first via Vercel AI SDK.

It should include (at minimum):

- `laneId`
- `status` (lane-level conflict status summary)
- `overlaps` (peer overlap summaries)
- `matrix` (lane-vs-peer risk summaries relevant to the lane)
- `generatedAt`
- Partial-coverage metadata when not computing a full matrix:
  - `truncated: true`
  - `strategy: "prefilter-overlap" | "full" | ...`
  - `pairwisePairsComputed`
  - `pairwisePairsTotal`

Lane exports must surface a **concise conflict risk summary** derived from this file (status + top risky peers + last prediction time + coverage info when truncated).

---

## Manifests (Lane + Project Exports)

Lane exports and project exports include a normalized, machine-readable manifest section:

- `## Manifest` (JSON code fence)
- Lane export manifest schema: `ade.manifest.lane.v1`
- Project export manifest schema: `ade.manifest.project.v1`

The manifest is intended to be:

- compact and stable (null-safe defaults; no inference-only assumptions)
- dependency-rich (lane lineage, merge readiness, conflict touchpoints)
- useful for cross-session handoff without requiring full pack body reads

---

## Conflict Lineage (Conflict Exports)

Conflict exports may include a provenance section:

- `## Conflict Lineage` (JSON code fence)
- schema: `ade.conflictLineage.v1`

This captures:

- prediction freshness (`predictionAt`, `lastRecomputedAt`, `stalePolicy`)
- coverage metadata (`pairwisePairsComputed/Total`, `strategy`, `truncated`)
- conflict touchpoints (`openConflictSummaries`, unresolved resolution state when available)

---

## Orchestrator Delta Feed

Orchestrators must keep context windows clean by consuming changes incrementally rather than reloading full packs.

### Recommended consumption loop

1. Track a cursor:
   - `sinceIso` timestamp from the last checkpoint / last export consumed
2. Preferred: Read a compact delta digest since cursor:
   - `ade.packs.getDeltaDigest({ packKey, sinceVersionId? | sinceTimestamp, minimumImportance })`
   - Example response (abridged):

```json
{
  "packKey": "lane:lane-123",
  "packType": "lane",
  "since": {
    "sinceVersionId": "ver-old",
    "sinceTimestamp": "2026-02-15T19:00:00.000Z",
    "baselineVersionId": "ver-old",
    "baselineVersionNumber": 12,
    "baselineCreatedAt": "2026-02-15T19:00:00.000Z"
  },
  "newVersion": {
    "packKey": "lane:lane-123",
    "packType": "lane",
    "versionId": "ver-new",
    "versionNumber": 13,
    "contentHash": "sha256...",
    "updatedAt": "2026-02-15T19:10:00.000Z"
  },
  "changedSections": [{ "sectionId": "task_spec", "changeType": "modified" }],
  "highImpactEvents": [{ "eventType": "narrative_update", "payload": { "importance": "high" } }],
  "blockers": [{ "kind": "merge", "summary": "Blocked by parent lane ..."}],
  "conflicts": { "status": "conflict-predicted", "lastPredictedAt": "..." },
  "decisionState": { "recommendedExportLevel": "standard", "reasons": ["..."] },
  "handoffSummary": "..."
}
```
3. Fallback (lower-level): Read new pack events since cursor:
   - `ade.packs.listEventsSince({ packKey, sinceIso, limit })`
4. If events/digest imply material change:
   - fetch head version:
     - `ade.packs.getHeadVersion({ packKey })`
   - diff against last-seen version:
     - `ade.packs.diffVersions({ fromId, toId })`
5. For bounded context to send to an agent:
   - `ade.packs.getLaneExport({ laneId, level: "lite" | "standard" | "deep" })`
   - `ade.packs.getProjectExport({ level })`
   - `ade.packs.getConflictExport({ laneId, peerLaneId?, level })`

Rule: **Agents consume exports**; packs/versions are used for auditability and diffs, not as default prompt payloads.

---

## Orchestrator Context Policy Profiles

- `orchestrator_deterministic_v1` (default):
  - narrative excluded by default,
  - docs included as digest refs,
  - bounded lane/project exports (`standard`/`lite` defaults).
- `orchestrator_narrative_opt_in_v1` (explicit):
  - narrative inclusion enabled,
  - larger bounded export defaults,
  - still subject to token/file budgets.
- Each orchestrated attempt records the selected profile id and context snapshot cursor for replay/audit.

### Project docs handling contract

- Default orchestrator context includes PRD + architecture document digest refs (`path`, `sha256`, `bytes`) for auditability.
- Full doc bodies are only included when step policy explicitly requests full docs.
- Snapshot metadata must explicitly declare docs mode (`digest_ref` vs `full_body`) and truncation state.

### Budget guidance (approximate)

Budgets are enforced via a lightweight heuristic (`~4 chars/token`), then clipped as a safety net.

- Lane exports:
  - Lite: ~800 tokens max
  - Standard: ~2800 tokens max
  - Deep: ~8000 tokens max (bounded, on-demand)

Other pack types have similar tiered budgets, but lane exports are the primary orchestrator substrate.

### Lane export required content (all levels)

- Header fence (`ade.context.v1`)
- `## Task Spec` section with markers
- `## Intent` section with markers
- `## Conflict Risk Summary` (bounded)
- `## What Changed` (bounded)
- `## Validation` (bounded)
- `## Errors & Issues` (bounded, ANSI-stripped, deduped)
- `## Sessions` (summary table only; avoid transcript dumps)
- `## Next Steps` / blockers (actionable checklist)
- `## Notes / Todos` (optional; bounded; marker-preserving)

`Deep` may additionally include:

- `## Narrative (Deep)` with narrative markers (bounded)

---

## 2026-02-26 Addendum — Scoped Memory and Runtime Context Assembly

### Scoped Memory Namespaces

ADE replaces the old layer labels with explicit scopes:

| Namespace | Scope | Persistence | Primary source |
|-----------|-------|-------------|----------------|
| `runtime-thread` | Current runtime session | Ephemeral (compacted) | Active transcript/session state |
| `run` | Current mission/run | Run-scoped | `orchestrator_shared_facts`, run metadata |
| `project` | Project-wide reusable knowledge | Durable | `memories` (`status = promoted`) |
| `identity` | Agent-definition owned memory | Durable | `memories` + `agent_identities` mapping |
| `daily-log` | Time-window operational continuity | Bounded durable | Briefings/checkpoint summaries |

### Runtime Context Assembly Contract

`buildFullPrompt()`-style assembly follows:

1. System instructions + step/task policy
2. Bounded pack export (`lite`/`standard`/`deep`)
3. Retrieved scoped memories (`project` + `identity` + optional `daily-log`)
4. Shared run facts (`run` namespace)
5. Runtime profile files (`IDENTITY`, `TOOLS`, `USER_PREFS`, `HEARTBEAT`, `MEMORY_SUMMARY`)
6. Active conversation (`runtime-thread`, subject to compaction)

### Writeback and Compaction Contract

When context pressure reaches threshold:

1. Extract durable facts/decisions with provenance and write to `run`/`project`/`identity` targets by policy.
2. Produce compaction summary for the runtime-thread.
3. Replace high-volume transcript content with summary while retaining current task anchors.
4. Persist transcript + compaction metadata to `attempt_transcripts`.

Continuity is achieved by deterministic reconstruction from scoped stores, not by assuming a model process is permanently "always on."

---

## Optional: Git-Native Sharing (Design Note)

For multi-machine handoffs, ADE can optionally provide a git-native sharing mechanism:

- A dedicated "pack branch" storing export artifacts:
  - `refs/ade/exports/<projectId>`
- Commits contain only:
  - `exports/<packKey>/<exportLevel>.md`
  - optional `checkpoints/<id>.json` (small metadata only)
- Commit trailers link back to local pack metadata:
  - `ADE-PackKey: lane:lane-123`
  - `ADE-VersionId: ver-...`
  - `ADE-CheckpointId: chk-...`

This is intentionally **optional** and should never replace local `.ade/` durable state. It exists to enable git-native context sharing in organizations that prefer local-only workflows.

---

## 2026-02-16 Addendum — Context Docs + External Resolver Metadata

Contract version is now `4` (additive only).

New optional schemas:

- `ade.contextDocStatus.v1`
- `ade.contextDocRun.v1`
- `ade.conflictExternalRun.v1`

Compatibility guarantees:

- Existing pack/export/event/checkpoint consumers remain valid.
- Legacy fields and IPC channels remain unchanged.
- New fields are additive and optional.

---

## 2026-02-19 Addendum — Orchestrator Context Snapshot Provenance

Contract version remains additive/backward-compatible.

Orchestrator attempt snapshots now include optional provenance fields inside cursor payloads:

- `packDeltaDigest` (digest since prior runtime cursor)
- `missionHandoffIds` (handoff records incorporated in the bundle)
- `contextSources` (deterministic list of context source categories)
- `docsMode` (`digest_ref` or `full_body`)
- `docsBudgetBytes`
- `docsConsumedBytes`
- `docsTruncatedCount`

Runtime policy clarifications:

- Default orchestrator profile (`orchestrator_deterministic_v1`) still excludes narrative unless explicitly overridden.
- `full_docs` mode is only selected by explicit step policy and remains bounded by byte budget.
- Snapshot metadata must remain replayable from DB alone (no hidden in-memory dependency).

Auditability additions:

- Every run/step/attempt/claim transition is persisted as an append-only timeline event.
- Quality-gate evaluations are persisted as deterministic snapshots for operator review.
