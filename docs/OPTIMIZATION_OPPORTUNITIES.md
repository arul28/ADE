# Optimization Opportunities

Codebase-wide scouting report. **Not applied in this pass** — listed here as a backlog. Each item has a file pointer, fix outline, and risk estimate. Review before picking any up.

Ground rules used to compile this list:
- Concrete file:line-range pointers only.
- Group by user-visible impact (HIGH) vs unnecessary work (MEDIUM) vs quality (LOW).
- Risk labels are judgment — verify by running affected tests.

---

## HIGH (user-visible performance)

### 1. Pause renderer watchdog interval when tab hidden
- **Where**: `apps/desktop/src/renderer/main.tsx` — `setInterval(..., 1000)` for `readRendererMemory` + `logRendererDebugEvent`.
- **Issue**: Runs every 1 s regardless of `document.visibilityState`.
- **Fix**: Add visibility-change listener; clear/restart interval on hidden/visible.
- **Risk**: Low (observational code).
- **Estimated gain**: 5–15% CPU reduction when backgrounded; improved battery.

### 2. Batch localStorage writes in `appStore`
- **Where**: `apps/desktop/src/renderer/state/appStore.ts` — `debouncedPersistWorkViewState`, `persistSmartTooltips`, `persistTheme`.
- **Issue**: Three separate debounce/write paths; JSON.stringify runs every 300 ms tick.
- **Fix**: Combine into one debounce; change-detect via `structuredClone`.
- **Risk**: Low.
- **Estimated gain**: 30–80 ms per second of active use.

### 3. Split mega-components into memoized children
- **Where**: `PrDetailPane.tsx` (3569), `AgentChatMessageList.tsx` (3175), `AgentChatPane.tsx` (3080).
- **Issue**: Single-file components re-render fully on any prop change. List items lack `memo`.
- **Fix**: Extract stable list items into `React.memo`'d children. Move derived arrays into `useMemo`.
- **Risk**: Medium (dep-array care required).
- **Estimated gain**: 200–600 ms on route transitions; 150–400 ms per turn render.

### 4. Memoize intermediate arrays in `AgentChatMessageList`
- **Where**: `apps/desktop/src/renderer/components/chat/AgentChatMessageList.tsx`.
- **Issue**: 23 `.map()` calls in render path; `selectedEventsForDisplay`, `navigationSuggestions`, `requestQuestions` recomputed every render.
- **Fix**: Wrap in `useMemo`; memoize list-item children.
- **Risk**: Low.
- **Estimated gain**: 150–400 ms per turn render.

---

## MEDIUM (unnecessary work)

### 5. Collapse filter→map chains on step/status derivations
- **Where**: `coordinatorTools.ts:~394` (the `orchestratorService.ts` / `aiOrchestratorService.ts` call sites went away with the orchestration mode).
- **Issue**: `graph.steps.filter(s => s.status === "running").map(s => s.stepKey)` on every graph tick.
- **Fix**: Single `reduce` or pre-computed status index.
- **Risk**: Low.
- **Estimated gain**: 20–60 ms per graph update (scales with step count).

### 6. Lazy-load non-essential preload IPC routes
- **Where**: `apps/desktop/src/preload/preload.ts` (~550 exposed methods).
- **Issue**: Entire IPC surface is eagerly constructed at renderer-bridge time.
- **Fix**: Lazy-load onboarding/automations/cto bridges on first use.
- **Risk**: Medium (renderer must tolerate late binding).
- **Estimated gain**: 50–150 ms faster startup.

### 7. Parallelize / defer main-process service initialization
- **Where**: `apps/desktop/src/main/main.ts`.
- **Issue**: ~50 service constructors run in series on app startup.
- **Fix**: Defer non-critical services (automations, cto, skillRegistry) to project-load or first-use. Parallelize independent init.
- **Risk**: Medium (guarantee IPC handlers exist before renderer calls).
- **Estimated gain**: 500–1500 ms faster project-open.

### 8. Combine `warmLaneStatusTimer` + `warmProviderModeTimer`
- **Where**: `apps/desktop/src/renderer/state/appStore.ts` lane/provider warmup section.
- **Issue**: Two independent 1200 ms and 1800 ms timers cascading refreshes.
- **Fix**: Single `scheduleWarmup` with merged delay.
- **Risk**: Low.
- **Estimated gain**: Fewer redundant network requests; 50–100 ms per interaction.

### 9. Audit event-listener cleanup
- **Where**: `apps/desktop/src/renderer/components/ui/SmartTooltip.tsx:78`, renderer panels with `.on()` subscriptions, others.
- **Issue**: Empty-deps cleanup effects may skip listener removal on unmount.
- **Fix**: Explicit remove for every `.on()`; track via `Set` if needed.
- **Risk**: Low.
- **Estimated gain**: Prevents 50–200 MB leak over 8-hour sessions.

### 10. Hoist inline config objects to module scope
- **Where**: `AppShell.tsx` (`EMPTY_TERMINAL_ATTENTION`), others.
- **Issue**: Object literals reconstructed every render.
- **Fix**: Move to module scope or `useMemo` if deps exist.
- **Risk**: Low.
- **Estimated gain**: 20–50 ms per 100 renders.

---

## LOW (code quality & maintainability)

### 11. Narrow useEffect dependency arrays
- **Where**: Widespread across `renderer/components/`.
- **Issue**: Deps reference entire prop objects when only 1–2 fields matter.
- **Fix**: Use field selectors (`.length`, `[0]?.id`) in deps.
- **Risk**: Low.
- **Estimated gain**: 50–200 ms per parent prop change (scales with depth).

### 12. Apply `React.memo` to high-frequency list children
- **Where**: Chat tab (`AgentChatMessageList.tsx`) and other high-volume lists.
- **Issue**: Only 33 `React.memo` usages across 143 files with `useMemo`/`useCallback`.
- **Fix**: Wrap list items in `memo` with custom comparison where needed.
- **Risk**: Low.
- **Estimated gain**: 100–400 ms on 50+ item lists.

### 13. Move shared types out of service imports
- **Where**: main-process service types referenced directly in renderer modules.
- **Issue**: Type-only re-parse; potential bundle bloat.
- **Fix**: Centralize in `shared/types/`.
- **Risk**: Low.
- **Estimated gain**: 50–150 ms bundle parse.

### 14. Atomic `UserPreferences` store
- **Where**: `appStore.ts` — `theme`, `terminalPreferences`, `smartTooltips` each persist separately.
- **Issue**: Three writes where one would do.
- **Fix**: Single atomic store + write.
- **Risk**: Low.
- **Estimated gain**: 20–40 ms on settings changes.

### 16. Compact JSON for machine-consumed files
- **Where**: `preload.ts:~452` and similar writers using `JSON.stringify(x, null, 2)`.
- **Issue**: Pretty-print cost on every write.
- **Fix**: Compact for machine files; pretty only on explicit human-export.
- **Risk**: Low.
- **Estimated gain**: 5–20 ms per save.

---

## Estimated total impact if all applied

- Startup: 1–3 s faster project-open.
- Interactions: 200–800 ms faster on heavy pages (PRs, graph, chat).
- Process footprint: 50–200 MB smaller over long sessions.

## Highest ROI (pick these first)

1. #1 — pause renderer watchdog when hidden (trivial, big battery win).
2. #3 — split mega-components on the hot paths (chat list, PR detail, graph).
3. #7 — defer non-critical service init (biggest startup gain).
4. #2 — batch localStorage writes in `appStore`.
5. #9 — audit event-listener cleanup.

Review risks before picking these up — several touch fragile boundaries (main.ts startup ordering, preload IPC surface). Run full test suite after any change.

## Heavy-load pass (2026-10-05)

### Backlog, measured but not applied

- **CSS spinners cost main-thread time.** Any running `animate-spin` (SVG or HTML) or the stepped `activity-hdr-pulse` forces a full main-thread frame at display rate: ~240 style recalcs/s and ~130 ms/s of main-thread work with three spinners on screen, ~15% of a renderer core whenever chats run. Chrome's trace reports the transform animation as composited (`compositeFailed: 0`), a lone spinner on an empty page still costs it, page zoom and the device scale factor do not change it, and plain Chrome does not show it. Root cause not found. Options: a Chromium-level fix, pausing indicators in an unfocused window, or swapping spinners for composited opacity pulses (a visual decision). *Applied in the Windows pass below: spinners now turn in 30 steps a second.*
- **Streaming a long tight list is O(n²).** The settled/tail cut sits only on blank lines, so a 60-item list stays in the tail and is re-parsed and re-rendered every reveal frame: 707 commits and ~22% of a core in script over 8 s for one visible streaming chat (~2–3 ms a frame). Cutting between list items risks a visible gap and wrong numbering for `1.`-only lists; memoizing `li` by content is the safer half.
- **The draft lives in `AgentChatPane`**, so each keystroke still renders the whole pane (~4 ms script). Moving it into the composer removes that.
- **Chat switch**: a warm switch is one synchronous task of about 35 ms in the dev build. The chat pane renders about 11 times for one switch, and about 350 components mount for the new rows; fewer pane renders is the next step. A cold open (89-266 ms) waits for its first render (row build, markdown parse, mounts), not for data: the history read takes 4-19 ms, so a prefetch does not help. Numbers and method: `docs/perf/macos-baseline.md`, "switch pass".
- **Session rows lose identity on every refresh** (`useWorkSessions` sets the fresh IPC array) and three listeners refetch the session list per chat lifecycle event. Mild at the loads reproduced here (4–6 chats); worth reconciling rows by shallow equality.
- `ClaudeCacheTtlBadge` and per-row `SessionStatusLabel` timers commit several times a second; one shared clock would batch them. **Applied** (PR #1660, 2026-10-16): those two, plus `ThinkingPreview`'s elapsed span, `SubagentActivityCards`, `BackgroundJobRunRow` and `AdeCard`, now read one shared timer per period through `renderer/lib/ticker.ts` (with `renderer/lib/liveDuration.ts` holding the shared elapsed-duration hook). One timer for any number of live rows, and React commits every subscriber in a single pass; the tick still lands when it did. Only the timer is shared — each subscriber keeps its own reading, because a reading shared through the channel is stale for a component joining one that is already ticking, which on the thirty-second channel prints a waiting label a whole minute high.
- A framer-motion transition leaves `filter: blur(0px)` on the chat surface wrapper.
- An upstream `get_github_repositories` call hits its 30-per-hour limit on dev app launches.

## Windows pass (2026-10-05)

Trigger: ADE on Windows felt slow everywhere, and no performance pass had been run there. Method: attach the inspector to the installed brain on the Windows PC (`process._debugProcess`), take 10-minute CPU profiles and attribute busy time to the nearest ADE frame, then reproduce each cost in isolation (the real `runGit`, the real credential store, the real resolver) or on a lane dev build (own named pipe, `--no-sync`) and measure before and after. Renderer costs were measured by OS-level process CPU with no debugger attached, and by Chromium traces for the per-frame breakdown. The PC: Windows 11, 240 Hz display at 110% scaling, an 80-entry `PATH`.

### Backlog, measured but not applied

- **Single SQLite writes of 190-346 ms** (`writeOwnRow`, `setLastError`) in the dev brain. WAL with `synchronous = NORMAL` is already set; the likely causes are lock waits against a second brain on the same project database (a dev setup artifact) or WAL checkpoints. Needs a measurement on a single-brain machine before any change.
- **`ensureLocalDevice` writes the device row on every call** with a fresh `last_seen_at`, several times a second, and each write replicates to peers. Skipping unchanged writes for a few seconds touches sync semantics; decide what `last_seen_at` freshness peers need first.
- **Chat switch** costs the same on a production renderer as on the dev build: ~280 ms to settle warm, 500-900 ms cold, ~230 ms of main-thread work per warm switch, almost all script (style ~30 ms, layout ~8 ms). Measured by navigating the dev window to `vite preview` of a sourcemapped `vite build` and mapping CPU profiles back to source. Per warm switch: the transcript list ~38 ms and the chat pane ~32 ms inclusive; model-catalog work ~24 ms — `handoffAvailableModelIds` and `orderAvailableModelIds` in `AgentChatPane.tsx`, `descriptorsFromAgentChatModelCatalog`, `cursorCloudEligibleModelIds` — because `getModelById` rebuilds a dynamic OpenCode/Pi descriptor on every call and the pane recomputes these per mount. Making the ordering O(n) did not move it; caching resolved descriptors, or keeping the pane mounted across switches, is the lever. The `MeasuredEventRow` `offsetHeight` read is the commit's own style and layout arriving early, not extra work.
- **Claude follow-ups respawn the CLI on Windows** (no background-job reattach), so every turn pays a process launch; see `docs/development/windows-support.md`.
- Smooth sheen animations (`ade-launch-rail-sheen`, `ade-reasoning-ultra-sheen`, `ade-workflow-card-sheen`, `chv-sweep`, `prs-shimmer`) and decorative onboarding loops are not quantized yet.

---

## Windows pass, round 2 (2026-10-06)

Same PC and method as the pass above: isolate the real unit and measure it
before and after. Renderer animation costs are measured with a fresh Electron
window and a Chromium trace over CDP (`scripts/perf-animation-lab`), never with
process CPU -- on this 32-core machine with other agents building, the same
strategy sampled 11.0% then 5.0% of a core and the ordering inverted between
runs, while the trace repeats to within 2%.

### Closed by measurement, not by code

- **The 190-346 ms SQLite writes are a second brain, not ADE's writes.** The
  backlog asked for a single-brain measurement first. On this machine, with one
  brain running and a copy of the live 7.2 MB project database opened through
  ADE's own `openKvDb` (same pragmas, cr-sqlite loaded):

  | | cost |
  |---|---|
  | `writeOwnRow`'s `runtime_processes` upsert (a plain table), 200x | mean 0.02 ms, p95 0.04, max 0.12 |
  | the `ensureLocalDevice` shape -- select, update, select back, on CRR `devices`, 200x | mean 0.08 ms, p95 0.10, max 1.98 |
  | the same with the write skipped | mean 0.01 ms |
  | `wal_checkpoint(TRUNCATE)` after the run | 3.9 ms |

  So neither write is expensive and a checkpoint is not the cause. A second
  *process* holding a write transaction is, and it reproduces the recorded range
  on the nose: a single write behind another process's transaction took 164.8 ms
  behind a 120 ms hold, 326.6 ms behind 250 ms, and 1,076.7 ms behind 1,000 ms --
  the holder's time plus ~50-80 ms. 190-346 ms is a peer holding a write for
  ~130-280 ms. Nothing to fix in ADE; the fix is one brain per project database,
  which `/context` already tells every agent to check.
- **Skipping the `ensureLocalDevice` write is not worth its risk.** It saves
  0.06-0.07 ms a call. At "several times a second" that is ~0.2 ms a second, and
  the price is changing what `last_seen_at` freshness peers can assume. Dropped.
- **A contended write blocks the whole event loop, then throws.** `node:sqlite`
  is synchronous, so a write waiting on another writer is not an async wait: the
  brain's event loop stops for the full contention. Worse, if releasing the lock
  depends on the blocked process's own event loop, nothing can release it -- an
  in-process version of the test above waited the entire `busy_timeout` of 5,000
  ms and then threw `database is locked`. This is the mechanism behind the
  `brain.event_loop_near_miss` warnings seen during two-brain sessions, and the
  reason "one brain per project database" is a performance rule and not only a
  correctness one.
- **A shared 30 Hz spinner clock is the wrong trade.** The backlog above asked
  for a timer-driven spinner to replace the `steps(30)` CSS animation, on the
  estimate that the per-vsync tick cost ~0.25 ms. It does not. Traced over 8 s
  with three 16px spinners on a 239 Hz display:

  | strategy | total | compositor draws | draw ms | main-thread ms |
  |---|---|---|---|---|
  | `steps(30)` keyframes (ships today) | 65 | 1,923 (240/s) | 65 | 0 |
  | one JS clock writing `--angle` on `:root` at 30 Hz | 151 | 243 (30/s) | 40 | 111 |
  | one JS clock rewriting a stylesheet rule at 30 Hz | 144 | 243 (30/s) | 40 | 104 |
  | `linear` keyframes (before the first Windows pass) | 218 | 1,922 | 218 | 0 |

  The clock does cut compositor draws 240/s -> 30/s as hoped, but it buys 25 ms
  of draw with 86 ms of style recalc, layerize, raster, timer and script. It is
  2.3x more total work than what ships. Do not build it.
- **The cost is "an animation is running", not "how many".** `steps(30)` traced
  59 ms per 8 s with one spinner, 65 with three, 69 with ten, 94 with thirty: a
  running animation holds the compositor in a draw loop at the display rate, and
  each extra spinner adds ~1.2 ms per 8 s. One spinner is already ~0.74% of a
  core, so the lever that remains is pausing indicators nobody is looking at,
  not making each one cheaper.
- **`will-change: transform` buys nothing here.** Promoting the rotating element
  measured 62 ms against 60 ms unpromoted, inside run-to-run variance. Electron
  is already compositing the transform; the draw loop is the cost.


---
