# ADE Pack + Context Validation Playbook

This guide is for validating the full context data plane after the hardening work:

- deterministic pack freshness
- hosted context source selection (inline vs mirror-ref)
- conflict context quality and insufficient-context guard
- mirror cleanup lifecycle and telemetry

Use this with:
- `/Users/arul/ADE/docs/guides/ADE_GUIDED_ACTIVITY_CONFLICT_CAFE.md`

## Scope

This playbook validates:

1. Packs stay deterministic and compact.
2. Hosted jobs carry explainable context provenance.
3. Conflict jobs receive scoped file evidence.
4. Missing context does not produce speculative patches.
5. Mirror growth is bounded with cleanup telemetry.

This playbook does not validate:

1. lane scheduling changes
2. merge strategy redesign
3. orchestrator/routing/lane-spawn behavior

## UI map (where to check each behavior)

| Behavior | UI location | What to expect |
|---|---|---|
| Pack refresh/versioning | Lanes → Inspector → Packs | New refresh/version events and fresh timestamps |
| Marker preservation | Lanes → Files + Packs | Task Spec/Intent marker content survives deterministic refresh |
| Conflict evidence scope | Conflicts tab proposal prepare panel | Relevant file list matches real overlap/conflict files |
| Insufficient-context guard | Conflicts tab proposal result | Explicit data gap / insufficient context instead of speculative diff |
| Context delivery telemetry | Settings → Hosted | fallback count, insufficient-context count, staleness reason |
| Mirror sync lifecycle | Settings → Hosted | last sync attempt/success/error updates |
| Mirror cleanup lifecycle | Settings → Hosted | last cleanup attempt/success/error + reclaimed/deleted metrics |
| Traceability in history | History tab + pack activity | events reflect source and outcome |

## Track A: deterministic pack checks (Guest mode or Hosted)

1. Run tracked terminal sessions in at least 2 lanes.
2. End those sessions.
3. In Packs view, refresh deterministic packs.
4. Open Activity and Versions.
5. Edit lane pack marker sections in Files:
- `<!-- ADE_TASK_SPEC_START --> ... <!-- ADE_TASK_SPEC_END -->`
- `<!-- ADE_INTENT_START --> ... <!-- ADE_INTENT_END -->`
6. Refresh pack again.

Pass criteria:

1. Activity shows refresh/version events.
2. Version diffs show deterministic updates.
3. Marker content remains intact after refresh.

## Track B: docs freshness + context fingerprint

1. Edit one docs file in your repo:
- `docs/PRD.md` or any file in `docs/architecture/*` or `docs/features/*`.
2. Refresh project pack.
3. Open project export/manifest view in Packs.

Pass criteria:

1. `contextFingerprint` changes after docs edit.
2. `lastDocsRefreshAt` updates.
3. `contextVersion` is present.
4. If docs are unreadable/missing, `docsStaleReason` is explicit.

## Track C: hosted context source selection

Precondition: Hosted (or BYOK path that calls hosted jobs) is enabled.

1. Run **Sync Mirror Now** once in Settings.
2. Trigger a small narrative-style job.
3. Trigger a conflict proposal job from Conflicts tab on a known overlap pair.

Check Settings and related job surfaces.

Pass criteria:

1. Small job tends to use inline path.
2. Conflict proposal uses mirror-first path unless unavailable.
3. If mirror path fails, fallback is explicit and counters increment.
4. Staleness reason is visible when mirror is old.

Reason codes you may see:

- `AUTO_INLINE_UNDER_THRESHOLD`
- `AUTO_MIRROR_JOBTYPE_CONFLICT`
- `AUTO_MIRROR_PARAMS_LARGE`
- `POLICY_MIRROR_PREFERRED`
- `POLICY_STALE_CONTEXT_REQUIRED`
- `CONTEXT_RETRIEVAL_INCOMPLETE`

## Track D: conflict context integrity

Use two lanes that both changed the same lines/files.

1. In Conflicts tab, select the pair and click **Prepare**.
2. Validate the prepared scope.
3. Send proposal request.

Pass criteria:

1. `relevantFilesForConflict` matches real overlap/conflicted files.
2. Context includes per-file evidence (left/right/base snippets/hunks where available).
3. Omission reasons are explicit if clipped:
- `omitted:path_count_limit`
- `omitted:byte_cap`
- `omitted:no_text_context`
- `omitted:binary`
- `omitted:secret-filter`

## Track E: insufficient-context behavior (critical safety)

Goal: confirm ADE does not generate a speculative patch when conflict evidence is incomplete.

Steps:

1. Prepare a conflict proposal where file evidence is intentionally incomplete or stale.
2. Request proposal.

Pass criteria:

1. Result is explicitly marked insufficient context.
2. Data-gap reasons are listed.
3. Patch content is empty (no speculative diff).

## Track F: mirror cleanup lifecycle

1. Run **Sync Mirror Now**.
2. Run **Clean Mirror Data** in Settings.
3. Repeat after additional lane updates if needed.

Pass criteria:

1. Cleanup does not break job submission.
2. Active/reachable manifests remain usable.
3. Cleanup telemetry updates:
- reachable blobs
- orphaned blobs
- deleted blobs
- reclaimed bytes
- cleanup result/error

## Automated test suite (required)

Run from ADE desktop package:

```bash
cd /Users/arul/ADE/apps/desktop
npm test -- \
  src/main/services/hosted/hostedContextPolicy.test.ts \
  src/main/services/hosted/contextResolution.test.ts \
  src/main/services/hosted/mirrorCleanupPlan.test.ts \
  src/main/services/hosted/promptProvenance.test.ts \
  src/main/services/conflicts/conflictService.test.ts \
  src/main/services/packs/packDeltaDigest.test.ts \
  src/main/services/packs/packExports.test.ts \
  src/main/services/packs/packService.docsFreshness.test.ts
```

What this test bundle covers:

1. policy decision matrix + fallback clipping
2. context ref resolution and inline fallback
3. prompt provenance contract
4. conflict context extraction + insufficient guard
5. pack omission metadata + docs freshness
6. mirror cleanup reachability planning

## Final sign-off checklist

All items must be true:

1. Pack refresh/events/versions work and are deterministic.
2. Docs churn updates project context fingerprint.
3. Hosted context source/fallback telemetry is visible in Settings.
4. Conflict proposal scope matches real files.
5. Insufficient context blocks speculative patch output.
6. Mirror cleanup runs and reports metrics without blocking normal flow.
7. Automated test suite passes.
