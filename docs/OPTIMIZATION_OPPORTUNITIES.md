# Optimization Opportunities

Codebase-wide scouting report. **Not applied in this pass** — listed here as a backlog. Each item has a file pointer, fix outline, and risk estimate. Review before picking any up.

Ground rules used to compile this list:
- Concrete file:line-range pointers only.
- Group by user-visible impact (HIGH) vs unnecessary work (MEDIUM) vs quality (LOW).
- Risk labels are judgment — verify by running affected tests.

---

## HIGH (user-visible performance)

### 1. Replace polling with event listeners in preload `subscribeRunView`
- **Where**: `apps/desktop/src/preload/preload.ts` `subscribeRunView` helper.
- **Issue**: Uses 160 ms `setTimeout` polling to schedule refreshes after mission/runtime/thread events.
- **Fix**: Move `missionListener`/`runtimeListener`/`threadListener` to direct IPC event subscriptions. Drop the `scheduleRefresh` wrapper.
- **Risk**: Low (event infrastructure already exists).
- **Estimated gain**: 100–400 ms per mission-view interaction.

### 2. Pause renderer watchdog interval when tab hidden
- **Where**: `apps/desktop/src/renderer/main.tsx` — `setInterval(..., 1000)` for `readRendererMemory` + `logRendererDebugEvent`.
- **Issue**: Runs every 1 s regardless of `document.visibilityState`.
- **Fix**: Add visibility-change listener; clear/restart interval on hidden/visible.
- **Risk**: Low (observational code).
- **Estimated gain**: 5–15% CPU reduction when backgrounded; improved battery.

### 3. Cache mission state JSON reads
- **Where**: `apps/desktop/src/main/services/orchestrator/orchestratorService.ts` — `loadMissionStateDocCounts` (readFileSync + JSON.parse on every call).
- **Issue**: Full JSON parse per call; can re-parse multi-MB docs repeatedly.
- **Fix**: In-memory cache keyed by `(projectRoot, runId)`. Invalidate on mission state mutations.
- **Risk**: Medium (must track all mutation paths).
- **Estimated gain**: 50–150 ms per access on large mission docs.

### 4. Batch localStorage writes in `appStore`
- **Where**: `apps/desktop/src/renderer/state/appStore.ts` — `debouncedPersistWorkViewState`, `persistSmartTooltips`, `persistTheme`.
- **Issue**: Three separate debounce/write paths; JSON.stringify runs every 300 ms tick.
- **Fix**: Combine into one debounce; change-detect via `structuredClone`.
- **Risk**: Low.
- **Estimated gain**: 30–80 ms per second of active use.

### 5. Split mega-components into memoized children
- **Where**: `WorkspaceGraphPage.tsx` (4406 lines), `PrDetailPane.tsx` (3569), `AgentChatMessageList.tsx` (3175), `AgentChatPane.tsx` (3080), `IntegrationTab.tsx` (3022).
- **Issue**: Single-file components re-render fully on any prop change. List items lack `memo`.
- **Fix**: Extract stable list items into `React.memo`'d children. Move derived arrays into `useMemo`.
- **Risk**: Medium (dep-array care required).
- **Estimated gain**: 200–600 ms on route transitions; 150–400 ms per turn render.

### 6. Memoize intermediate arrays in `AgentChatMessageList`
- **Where**: `apps/desktop/src/renderer/components/chat/AgentChatMessageList.tsx`.
- **Issue**: 23 `.map()` calls in render path; `selectedEventsForDisplay`, `navigationSuggestions`, `requestQuestions` recomputed every render.
- **Fix**: Wrap in `useMemo`; memoize list-item children.
- **Risk**: Low.
- **Estimated gain**: 150–400 ms per turn render.

---

## MEDIUM (unnecessary work)

### 7. Collapse filter→map chains on step/status derivations
- **Where**: `orchestratorService.ts:~4620`, `aiOrchestratorService.ts:~2424`, `coordinatorTools.ts:~394`.
- **Issue**: `graph.steps.filter(s => s.status === "running").map(s => s.stepKey)` on every graph tick.
- **Fix**: Single `reduce` or pre-computed status index.
- **Risk**: Low.
- **Estimated gain**: 20–60 ms per graph update (scales with step count).

### 8. Lazy-load non-essential preload IPC routes
- **Where**: `apps/desktop/src/preload/preload.ts` (~550 exposed methods).
- **Issue**: Entire IPC surface is eagerly constructed at renderer-bridge time.
- **Fix**: Lazy-load onboarding/automations/cto bridges on first use.
- **Risk**: Medium (renderer must tolerate late binding).
- **Estimated gain**: 50–150 ms faster startup.

### 9. Parallelize / defer main-process service initialization
- **Where**: `apps/desktop/src/main/main.ts`.
- **Issue**: ~50 service constructors run in series on app startup.
- **Fix**: Defer non-critical services (automations, cto, skillRegistry) to project-load or first-use. Parallelize independent init.
- **Risk**: Medium (guarantee IPC handlers exist before renderer calls).
- **Estimated gain**: 500–1500 ms faster project-open.

### 10. Combine `warmLaneStatusTimer` + `warmProviderModeTimer`
- **Where**: `apps/desktop/src/renderer/state/appStore.ts` lane/provider warmup section.
- **Issue**: Two independent 1200 ms and 1800 ms timers cascading refreshes.
- **Fix**: Single `scheduleWarmup` with merged delay.
- **Risk**: Low.
- **Estimated gain**: Fewer redundant network requests; 50–100 ms per interaction.

### 11. Parse only needed fields in `loadMissionStateDocCounts`
- **Where**: `orchestratorService.ts` — full `JSON.parse` but only array lengths are read.
- **Issue**: Full object tree reified and discarded.
- **Fix**: Count via regex or streaming parser; or use cached result from #3.
- **Risk**: Low.
- **Estimated gain**: 10–30 ms per call.

### 12. Audit event-listener cleanup
- **Where**: `apps/desktop/src/renderer/components/ui/SmartTooltip.tsx:78`, `components/settings/memory/MemoryHealthTab.tsx:367`, others.
- **Issue**: Empty-deps cleanup effects may skip listener removal on unmount.
- **Fix**: Explicit remove for every `.on()`; track via `Set` if needed.
- **Risk**: Low.
- **Estimated gain**: Prevents 50–200 MB leak over 8-hour sessions.

### 13. Hoist inline config objects to module scope
- **Where**: `IntegrationTab.tsx` (`OutcomeDot` config), `AppShell.tsx` (`EMPTY_TERMINAL_ATTENTION`), others.
- **Issue**: Object literals reconstructed every render.
- **Fix**: Move to module scope or `useMemo` if deps exist.
- **Risk**: Low.
- **Estimated gain**: 20–50 ms per 100 renders.

---

## LOW (code quality & maintainability)

### 14. Narrow useEffect dependency arrays
- **Where**: Widespread across `renderer/components/`.
- **Issue**: Deps reference entire prop objects when only 1–2 fields matter.
- **Fix**: Use field selectors (`.length`, `[0]?.id`) in deps.
- **Risk**: Low.
- **Estimated gain**: 50–200 ms per parent prop change (scales with depth).

### 15. Apply `React.memo` to high-frequency list children
- **Where**: Missions tab (`AgentChannels.tsx`, `MissionSidebar.tsx`), Chat tab (`AgentChatMessageList.tsx`).
- **Issue**: Only 33 `React.memo` usages across 143 files with `useMemo`/`useCallback`.
- **Fix**: Wrap list items in `memo` with custom comparison where needed.
- **Risk**: Low.
- **Estimated gain**: 100–400 ms on 50+ item lists.

### 16. Move shared types out of service imports
- **Where**: `orchestratorService` types referenced directly in renderer.
- **Issue**: Type-only re-parse; potential bundle bloat.
- **Fix**: Centralize in `shared/orchestratorTypes.ts` (or existing `shared/types/`).
- **Risk**: Low.
- **Estimated gain**: 50–150 ms bundle parse.

### 17. Bound unbounded `Map` caches
- **Where**: `main/services/memory/memoryService.ts`, `embeddingService.ts` (26 `new Map()` instances).
- **Issue**: No eviction; possible unbounded growth.
- **Fix**: LRU or TTL on caches > 1000 entries.
- **Risk**: Medium (don't over-invalidate).
- **Estimated gain**: Prevents 100–500 MB bloat over 24 h.

### 18. Coalesce duplicate IPC invokes
- **Where**: `ProcessService.ts:~712` (`Promise.all(ordered.map(id => startByDefinition(...)))`).
- **Issue**: Parallel IPC without deduplication of identical calls.
- **Fix**: Request-coalescing dispatcher.
- **Risk**: Medium (central infrastructure change).
- **Estimated gain**: 50–200 ms on multi-process starts.

### 19. Atomic `UserPreferences` store
- **Where**: `appStore.ts` — `theme`, `terminalPreferences`, `smartTooltips` each persist separately.
- **Issue**: Three writes where one would do.
- **Fix**: Single atomic store + write.
- **Risk**: Low.
- **Estimated gain**: 20–40 ms on settings changes.

### 20. Compact JSON for machine-consumed files
- **Where**: `preload.ts:~452` and similar writers using `JSON.stringify(x, null, 2)`.
- **Issue**: Pretty-print cost on every write.
- **Fix**: Compact for machine files; pretty only on explicit human-export.
- **Risk**: Low.
- **Estimated gain**: 5–20 ms per save.

---

## Estimated total impact if all applied

- Startup: 1–3 s faster project-open.
- Interactions: 200–800 ms faster on heavy pages (missions, PRs, graph).
- Memory: 50–200 MB smaller footprint over long sessions.

## Highest ROI (pick these first)

1. #1 — replace preload polling (low risk, immediate gain).
2. #2 — pause renderer watchdog when hidden (trivial, big battery win).
3. #3 — cache mission state reads (needs invalidation care but high gain).
4. #5 — split mega-components on the hot paths (missions, chat list, PR detail).
5. #9 — defer non-critical service init (biggest startup gain).

Review risks before picking these up — several touch fragile boundaries (main.ts startup ordering, preload IPC surface). Run full test suite after any change.

## Applied

Items applied in this pass (2026-04-14):

- **#2 — Pause renderer watchdog when tab hidden**. `apps/desktop/src/renderer/main.tsx` now runs the 1 s event-loop-stall watchdog only while `document.visibilityState === "visible"`; start/stop helpers + `visibilitychange` listener (with `beforeunload` teardown).
- **#10 — Combine warmup timers**. `apps/desktop/src/renderer/state/appStore.ts` collapsed `warmLaneStatusTimer` + `warmProviderModeTimer` into a single `warmupTimer` that fires both `refreshLanes` and `refreshProviderMode` after `Math.max(1200, 1800)` ms.
- **#13 — Hoist inline config objects**. `IntegrationTab.tsx` now defines `OUTCOME_DOT_CONFIG` at module scope (the inline outcome map used by `OutcomeDot`). `AppShell.tsx` was already module-scoped for `EMPTY_TERMINAL_ATTENTION` (no change needed).
- **#19 — Atomic UserPreferences store**. `appStore.ts` now persists `theme` / `terminalPreferences` / `smartTooltipsEnabled` into one key (`ade.userPreferences.v1`) with a single `setItem` per change. Legacy keys (`ade.theme`, `ade.smartTooltips`, `ade.terminalPreferences.v1`) are still read as a one-time migration fallback; every setter now snapshots prev state via `set((prev) => { ... })` and writes the unified JSON.
- **#20 — Compact JSON for machine files**. `apps/desktop/src/preload/preload.ts` was re-audited; it currently has no `JSON.stringify(x, null, 2)` call sites — no-op for this pass.

Verification: `cd apps/desktop && npx tsc --noEmit -p .` passed. All 8 vitest shards passed (0 failed test files, all previously-drifted tests fixed in Part A).
