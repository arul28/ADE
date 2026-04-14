# Context Packs

ADE has three distinct notions that sometimes get conflated:

- **Context docs** — the canonical `.ade/context/PRD.ade.md` and
  `ARCHITECTURE.ade.md` files that summarize the project for the AI.
  Regenerated on demand and on event triggers.
- **Live exports** — synthesized at request time from current local
  state (project, lane, feature, plan, mission, conflict). They do not
  require any persisted file.
- **Packs** — persisted compatibility artifacts under
  `.ade/artifacts/packs/`. Historical file-shaped snapshots for
  audit, export compatibility, and legacy consumers.

The runtime contract is: **live exports + unified memory are the
source of truth** for AI calls. Packs remain as file-shaped
compatibility artifacts but are not the runtime source.

## Source file map

Main process:

- `apps/desktop/src/main/services/context/contextDocService.ts` —
  orchestrates generation runs, stores prefs, reconciles stale
  in-flight state, emits push events to the renderer. ~660 lines.
- `apps/desktop/src/main/services/context/contextDocBuilder.ts` —
  builds the canonical docs from repo scan + git history + doc
  discovery + AI narration. Resolves doc paths, writes to preferred
  path or fallback. ~1,480 lines.
- `apps/desktop/src/main/services/context/contextDocService.test.ts`
  and `contextDocBuilder.test.ts` — unit coverage.
- `apps/desktop/src/main/services/conflicts/conflictService.ts` —
  uses `laneExportLite` at ~line 2300; consumes live exports for
  conflict proposals.
- `apps/desktop/src/main/services/orchestrator/orchestratorQueries.ts`
  — mission/planning queries pass `laneExportLevel`, `projectExportLevel`.

Packs filesystem layout (still managed, but not the runtime source):

- `.ade/artifacts/packs/project_pack.md` — project pack
- `.ade/artifacts/packs/lanes/<laneId>/lane_pack.md`
- `.ade/artifacts/packs/features/<featureKey>/feature_pack.md`
- `.ade/artifacts/packs/plans/<laneId>/plan_pack.md`
- `.ade/artifacts/packs/missions/<missionId>/mission_pack.md`
- `.ade/artifacts/packs/conflicts/v2/<laneId>__<peer>.md`
- `.ade/artifacts/packs/external-resolver-runs/<runId>/`
- `.ade/history/` — pack history with SQLite-backed index
- `.ade/artifacts/packs/versions/` — versioned pack files

Path resolution: `apps/desktop/src/shared/adeLayout.ts`
(`resolveAdeLayout(projectRoot).packsDir`). Migrations:
`apps/desktop/src/main/services/projects/adeProjectService.ts`
handles moving `.ade/packs` → `.ade/artifacts/packs`.

Canonical context docs:

- `.ade/context/PRD.ade.md`
- `.ade/context/ARCHITECTURE.ade.md`

Fallback paths when writing canonical files fails:

- `.ade/context/generated/<timestamp>/PRD.ade.md`
- `.ade/context/generated/<timestamp>/ARCHITECTURE.ade.md`

Shared types and contract:

- `apps/desktop/src/shared/types/packs.ts` — `ContextStatus`,
  `ContextDocStatus`, `ContextDocHealth` (`missing` | `incomplete` |
  `fallback` | `stale` | `ready`), `ContextDocOutputSource`
  (`ai` | `deterministic` | `previous_good`),
  `ContextDocGenerationStatus`, `ContextGenerateDocsArgs`,
  `ContextGenerateDocsResult`, `ContextDocPrefs`,
  `ContextRefreshEvents`, `ContextRefreshTrigger`.
- `apps/desktop/src/shared/contextContract.ts` — public-contract
  marker strings used in pack/export text (intent markers, narrative
  markers, task-spec markers), `CONTEXT_HEADER_SCHEMA_V1`,
  `CONTEXT_CONTRACT_VERSION = 4`, `PackRelation`, `PackGraphEnvelopeV1`,
  `ExportOmissionV1`.

Renderer:

- `apps/desktop/src/renderer/components/settings/ContextSection.tsx`
  — Settings > Workspace > Context tab. Doc list, health indicators,
  inline generation controls (provider, model, reasoning effort,
  event triggers), generation status card. ~550 lines.
- `apps/desktop/src/renderer/components/context/contextShared.ts`
  — `describeContextDocHealth`, `relativeTime`,
  `listActionableContextDocs`. Used by both Settings and onboarding.

IPC:

- `ade.context.getStatus` — `ContextStatus`
- `ade.context.statusChanged` — push event replacing the old poll
- `ade.context.generateDocs` — manual generation with
  `ContextGenerateDocsArgs`
- `ade.context.openDoc` — open a doc in the system editor
- `ade.context.getPrefs` / `savePrefs` — `ContextDocPrefs`

## Detail doc

- [freshness-and-delivery.md](./freshness-and-delivery.md) — when
  context docs regenerate, how packs get delivered, and the runtime
  truth path.

## Runtime truth

Runtime exports are synthesized from current local state when
requested. Functions:

- `getProjectExport({ level })`
- `getLaneExport({ laneId, level })`
- `getConflictExport({...})`
- `getFeatureExport({...})`
- `getPlanExport({ laneId, level })`
- `getMissionExport({ missionId, level })`

Level is `"lite"`, `"standard"`, or `"deep"`. They do not require a
pre-refreshed on-disk pack file to exist first. Consumers like
`conflictService` call them in-line when they need a compact
representation of a lane's state.

Conflict external-resolver runs now consume generated per-run context
files plus optional `.ade/context/*.ade.md` docs. They no longer
assume `.ade/artifacts/packs/...` files are present.

## Context doc generation

`ContextDocService.generateDocs(args)` is the entry point for
manual runs; `maybeAutoRefreshDocs({ event, reason, force? })` is the
entry point for event-driven refreshes.

Inputs (`ContextGenerateDocsArgs`):

- `provider`: `"codex" | "claude" | "opencode"`
- `modelId`: string | undefined
- `reasoningEffort`: string | null
- `trigger`: legacy `ContextRefreshTrigger`
- `events`: `ContextRefreshEvents`

Outputs (`ContextGenerateDocsResult`):

- `degraded`: boolean — true when AI narration failed but
  deterministic fallback produced content
- `usedFallbackPath`: boolean — true when canonical write failed and
  the run wrote to `.ade/context/generated/<ts>/`
- `generatedAt`: ISO timestamp
- `warnings`: list with `code`, `message`, optional `actionLabel`,
  `actionPath`
- `docResults`: per-doc `{ id, health, source, sizeBytes }`

### Discovery

Doc discovery prioritizes (from `contextDocBuilder`):

1. `.ade/context/PRD.ade.md` (canonical)
2. `.ade/context/ARCHITECTURE.ade.md` (canonical)
3. root-level docs: `README.md`, `CLAUDE.md`, `AGENTS.md`
4. bounded repo scan for PRD-ish / architecture-ish / guide-ish docs
   using `DOC_PRD_HINT_RE`, `DOC_ARCH_HINT_RE`, `DOC_GUIDE_HINT_RE`

Docs are truncated to `CONTEXT_DOC_MAX_CHARS = 8_000` per source.

### Output

Two canonical docs with required heading sets:

- `PRD.ade.md`: "What this is", "Who it's for", "Feature areas",
  "Current state", "Working norms"
- `ARCHITECTURE.ade.md`: "System shape", "Core services", "Data and
  state", "Integration points", "Key patterns"

A doc is `ready` when it exists, has all required headings, and
matches the current fingerprint. Other health states:
`missing`, `incomplete`, `fallback`, `stale`.

## Context doc status

`ContextStatus` shape:

```ts
type ContextStatus = {
  docs: ContextDocStatus[];                 // PRD, architecture
  canonicalDocsPresent: string[];
  canonicalDocsScanned: string[];
  canonicalDocsFingerprint: string | null;
  canonicalDocsUpdatedAt: string | null;
  projectExportFingerprint: string | null;
  projectExportUpdatedAt: string | null;
  contextManifestRefs: { project, packs, transcripts };
  fallbackWrites: number;
  insufficientContextCount: number;
  warnings: ContextDocWarning[];
  generation: ContextDocGenerationStatus;   // current in-flight state
};
```

The service pushes updates via `onStatusChanged` callback — the
renderer subscribes through `ade.context.statusChanged` rather than
polling.

## Unified memory (separate subsystem)

Unified memory (project/agent/mission scopes, Tier 1-3 lifecycle) is a
separate subsystem managed through Settings > Memory. It is not part
of packs. Memory-backed indexed skill files are managed from the
Workspace skill-file surface and hidden from the generic memory
browser so they cannot be orphaned.

## Guest mode

In guest mode (`ai.mode === "guest"`), deterministic compatibility
packs remain usable — narrative generation is simply skipped. The
"degraded" flag in the generation result is set true and the
`fallback` health state surfaces in the UI so users know content is
deterministic.

## Gotchas

- Packs are not the runtime source of truth. Fresh AI calls go
  through live exports and unified memory. Relying on a specific
  pack file existing will produce stale data.
- The canonical docs are the ones services consume — if you need to
  surface project knowledge to the AI, update `PRD.ade.md` /
  `ARCHITECTURE.ade.md`, not a pack file.
- Fallback writes land under `.ade/context/generated/<ts>/`. These
  are not cleaned up automatically; the `fallbackWrites` counter in
  `ContextStatus` is the signal to show a banner in the UI.
- Generation status can get stuck in `pending` / `running` if the
  process crashes mid-run. `reconcileGenerationStatus` normalizes
  this on service construction using
  `STALE_GENERATION_TIMEOUT_MS = 5 minutes`.
- `activeGeneration` is a service-scoped promise. Concurrent
  generation requests await it instead of kicking off a duplicate.
- The migration from `.ade/packs` to `.ade/artifacts/packs` is
  handled in `adeProjectService.ts` — projects opened under older
  ADE versions may briefly show both paths during migration.
- Don't add new pack consumers. Use live exports or unified memory
  instead; packs are frozen as compatibility artifacts.

## Cross-links

- Freshness and delivery: [freshness-and-delivery.md](./freshness-and-delivery.md)
- Config triggers for auto-refresh:
  [../onboarding-and-settings/configuration-schema.md](../onboarding-and-settings/configuration-schema.md)
- Settings UI for context docs:
  `apps/desktop/src/renderer/components/settings/ContextSection.tsx`
- Memory (separate): Settings > Memory tab
