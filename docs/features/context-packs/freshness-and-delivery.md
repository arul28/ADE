# Context Freshness and Delivery

How context flows from the codebase to AI calls: event-driven
refresh of `.ade/context/*.ade.md` canonical docs, throttling,
prefs resolution, and how live exports reach the consuming service.

Canonical backend: `apps/desktop/src/main/services/context/contextDocService.ts`.
Builder implementation: `contextDocBuilder.ts`.

## Context doc prefs

Stored in `AdeDb` under `context:docs:preferences.v1`:

```ts
type ContextDocRefreshPrefs = {
  cadence: ContextRefreshTrigger;     // legacy, still stored for backcompat
  events: ContextRefreshEvents;       // new event-based model
  provider: "codex" | "claude" | "opencode";
  modelId: string | null;
  reasoningEffort: string | null;
  updatedAt: string;
};
```

`ContextDocPrefs` (IPC shape, narrower) has:

- `provider`
- `modelId`
- `reasoningEffort`
- `events` (the 7-key boolean map)

The renderer reads via `window.ade.context.getPrefs()` and writes via
`savePrefs(prefs)`. Persistence is immediate — no confirm dialog.

## Event triggers

Seven events can trigger auto-refresh:

- `session_end`
- `commit`
- `pr_create`
- `pr_land`
- `mission_start`
- `mission_end`
- `lane_create`

Mapped to `ContextRefreshEvents` keys:

```ts
const EVENT_NAME_TO_KEY = {
  session_end: "onSessionEnd",
  commit: "onCommit",
  pr_create: "onPrCreate",
  pr_land: "onPrLand",
  mission_start: "onMissionStart",
  mission_end: "onMissionEnd",
  lane_create: "onLaneCreate",
};
```

Each event has a minimum interval enforced per event type:

```ts
const AUTO_REFRESH_MIN_INTERVAL_MS = {
  session_end: 45 * 60_000,    // 45 min
  commit: 15 * 60_000,         // 15 min
  pr_create: 15 * 60_000,
  pr_land: 15 * 60_000,
  mission_start: 15 * 60_000,
  mission_end: 15 * 60_000,
  lane_create: 45 * 60_000,    // 45 min
};
```

Defaults when no prefs are stored and no config override is set:

```ts
const DEFAULT_EVENTS = { onPrCreate: true, onMissionStart: true };
```

## Trigger resolution

`resolveEnabledEvents()` priority (highest wins):

1. `ProjectConfigFile.contextRefreshEvents` in shared or local config
   (whichever has booleans set first)
2. Stored `ContextDocRefreshPrefs.events` if any event is enabled
3. `DEFAULT_EVENTS`

This lets teams lock event triggers via committed `ade.yaml` while
still allowing per-user tweaks via stored prefs.

## Auto-refresh flow

`maybeAutoRefreshDocs({ event, reason, force? })`:

1. Look up the event key; return null if unknown.
2. Check `enabledEvents[eventKey]` — if disabled, settle the pending
   state without running and log `auto_refresh_event_disabled`.
3. Read stored prefs; require a `modelId`. If missing, log
   `auto_refresh_skipped_missing_model` and return null.
4. Write `generation` state as `pending` (so the UI can show queued
   progress).
5. Check throttle: if the last run was within
   `minIntervalMs` and `force !== true`, settle pending and log
   `auto_refresh_skipped_recent`.
6. Call `generateDocsInternal` with source=`"auto"` and the event
   metadata.

The service prevents concurrent runs by awaiting `activeGeneration`
when it exists. Duplicate event fires within a run collapse into
the first one.

## Manual generation

`generateDocs(docArgs)`:

1. Require a `modelId` (throws if missing).
2. Delegate to `generateDocsInternal` with source=`"manual"` and
   reason=`"manual_generate"`.

Called from:

- Settings > Workspace > Context — `ContextSection.tsx`
- Onboarding > Context step — `ProjectSetupPage.tsx`
- CLI-like developer hooks (future)

## Generation internal flow

`generateDocsInternal(docArgs, meta)`:

1. If another generation is already in-flight, return the same
   promise.
2. Normalize provider, model, reasoning effort from args.
3. Persist prefs (so auto-refresh later uses the same provider).
4. Write `generation.state = "running"` and emit push event.
5. Call `runContextDocGeneration(deps, args)` from
   `contextDocBuilder`.
6. On success:
   - log `context_docs.generate.complete`
   - write `generation.state = "succeeded"` with `finishedAt`
   - update `context:docs:lastRun.v1` for throttle calculations
7. On warning/degraded:
   - log at `warn` level
   - write `state = "succeeded"` with warnings attached
8. On failure:
   - log `context_docs.generate.failed`
   - write `state = "failed"` with `error`

## Stale generation recovery

If the process crashes mid-generation, the DB state can be stuck in
`pending` / `running`. On service construction,
`reconcileGenerationStatus()` runs:

1. If `activeGeneration` is live, leave state alone.
2. Otherwise, check the baseline timestamp
   (`startedAt ?? requestedAt`). If the timestamp is missing, set
   state to `failed` with a "state left in progress" error.
3. If the baseline is older than
   `STALE_GENERATION_TIMEOUT_MS = 5 minutes`, set state to `failed`
   with a "previous generation did not finish" error.
4. Otherwise leave the pending state in place (a live generation
   elsewhere might still be running).

## Push-based status updates

The service accepts an `onStatusChanged` callback at construction.
`buildStatusSnapshot()` reads the current `ContextStatus` and
`emitStatusChanged()` invokes the callback. The main-process IPC
layer forwards the callback to the renderer via the
`ade.context.statusChanged` event channel.

This replaces the previous polling path where the renderer called
`getStatus()` on a timer. In the current code the renderer still
reads `getStatus()` once on mount and relies on push events after.

## Doc paths

`resolveContextDocPath(projectRoot, docId)` returns:

- `prd_ade`: `<root>/.ade/context/PRD.ade.md`
- `architecture_ade`: `<root>/.ade/context/ARCHITECTURE.ade.md`

`openDoc({ docId })` IPC resolves the path and opens it via
`shell.openPath`. If the canonical file does not exist, it falls back
to the most recent `.ade/context/generated/<ts>/` version.

## Live exports

Exports are not touched by the event-driven doc regeneration path.
They synthesize from local state on demand. Typical delivery:

- `conflictService` constructs `laneExportLite` inline when building
  a conflict proposal (`laneExportLevel = "lite"`).
- `orchestratorQueries` pass `projectExportLevel = "lite"` and
  `laneExportLevel = "standard"` when gathering mission context.
- External resolver runs use per-run context files written at
  invocation time rather than any persisted pack.

Exports include the context contract markers from
`contextContract.ts`:

- `ADE_INTENT_START` / `ADE_INTENT_END`
- `ADE_TODOS_START` / `ADE_TODOS_END`
- `ADE_NARRATIVE_START` / `ADE_NARRATIVE_END`
- `ADE_TASK_SPEC_START` / `ADE_TASK_SPEC_END`
- JSON header fence with `schema: "ade.context.v1"`

Contract version (`CONTEXT_CONTRACT_VERSION = 4`) is advisory; consumers
should not gate hard on the value.

## Packs as audit/history

Persisted pack files and pack versions under `.ade/history/` and
`.ade/artifacts/packs/versions/` still exist for:

- audit trails
- compatibility with external consumers that accept
  `ade://pack/<path>` resource URIs
- optional persisted summaries for offline viewing

Writing to packs is still done by some code paths (project pack
index in `packs_index` table, lane pack directories) but reading from
them at AI-call time is discouraged.

## Fallback writes

When `contextDocBuilder.runContextDocGeneration` fails to write to
the canonical path (permissions, symlink issues, read-only FS), it
writes to `.ade/context/generated/<timestamp>/` instead and marks
the result with `usedFallbackPath: true`. The `ContextStatus` exposes
a `fallbackWrites` counter the UI uses to surface "generation wrote
to fallback path" warnings.

## Delivery flow summary

```
Event (PR create, mission start, session end...)
  └─→ emit to contextDocService.maybeAutoRefreshDocs
        ├─ resolveEnabledEvents (config > prefs > defaults)
        ├─ throttle check (AUTO_REFRESH_MIN_INTERVAL_MS)
        ├─ generateDocsInternal (single-flight via activeGeneration)
        │   ├─ persistContextDocRefreshPrefs
        │   ├─ writeGenerationStatus("running")
        │   └─ runContextDocGeneration (contextDocBuilder)
        │       ├─ discover docs (.ade/context + root docs + bounded scan)
        │       ├─ hybrid summarize (AI + deterministic)
        │       ├─ write canonical file, fallback to generated/<ts>/ on failure
        │       └─ return ContextGenerateDocsResult
        └─ writeGenerationStatus("succeeded" | "failed")

AI call (chat turn, mission step, conflict proposal)
  └─→ service-local:
        ├─ read .ade/context/PRD.ade.md / ARCHITECTURE.ade.md
        ├─ build live export at required level
        └─ attach unified-memory retrievals
```

## Gotchas

- Event triggers fire regardless of whether anything has actually
  changed. The throttle is the only cheap guard; content
  deduplication happens inside the builder via fingerprints.
- `session_end` is expensive to hook into because every terminal
  close fires one. The 45-minute throttle is deliberate.
- Without a configured `modelId`, auto-refresh is a no-op. Users on
  guest mode will never see auto-refresh success unless they also
  configure a local model through OpenCode (LM Studio / Ollama).
- `lane_create` fires during lane init, which is already an expensive
  flow. Consider disabling it for short-lived lanes to avoid compounding
  the first-create latency.
- Docs are considered `stale` when their fingerprint differs from the
  source fingerprint. Fingerprints are sha256 of canonical source
  bundles. If a user manually edits a doc and leaves it
  unfingerprint-matched, it may flip to `stale` after the next run.
- Canonical docs are preferred over packs by every discovery path.
  If you need a doc to show up in AI context, put it at
  `.ade/context/*.ade.md` or reference it from there.

## Cross-links

- Event sources that call `maybeAutoRefreshDocs`:
  `apps/desktop/src/main/services/history/` (session end),
  `apps/desktop/src/main/services/git/` (commit),
  `apps/desktop/src/main/services/prs/` (PR create/land),
  mission services, lane services.
- Settings UI for prefs:
  `apps/desktop/src/renderer/components/settings/ContextSection.tsx`.
- Onboarding step that prompts initial generation:
  [../onboarding-and-settings/first-run.md](../onboarding-and-settings/first-run.md)
- Config `contextRefreshEvents` field:
  [../onboarding-and-settings/configuration-schema.md](../onboarding-and-settings/configuration-schema.md)
