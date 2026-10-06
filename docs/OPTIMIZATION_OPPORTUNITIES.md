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
- **Where**: `PrDetailPane.tsx` (3569), `AgentChatMessageList.tsx` (3175), `AgentChatPane.tsx` (3080), `IntegrationTab.tsx` (3022).
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
- **Where**: `IntegrationTab.tsx` (`OutcomeDot` config), `AppShell.tsx` (`EMPTY_TERMINAL_ATTENTION`), others.
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

## Applied

Items applied in this pass (2026-04-14):

- **#2 — Pause renderer watchdog when tab hidden**. `apps/desktop/src/renderer/main.tsx` now runs the 1 s event-loop-stall watchdog only while `document.visibilityState === "visible"`; start/stop helpers + `visibilitychange` listener (with `beforeunload` teardown).
- **#10 — Combine warmup timers**. `apps/desktop/src/renderer/state/appStore.ts` collapsed `warmLaneStatusTimer` + `warmProviderModeTimer` into a single `warmupTimer` that fires both `refreshLanes` and `refreshProviderMode` after `Math.max(1200, 1800)` ms.
- **#13 — Hoist inline config objects**. `IntegrationTab.tsx` now defines `OUTCOME_DOT_CONFIG` at module scope (the inline outcome map used by `OutcomeDot`). `AppShell.tsx` was already module-scoped for `EMPTY_TERMINAL_ATTENTION` (no change needed).
- **#19 — Atomic UserPreferences store**. `appStore.ts` now persists `theme` / `terminalPreferences` / `smartTooltipsEnabled` into one key (`ade.userPreferences.v1`) with a single `setItem` per change. Legacy keys (`ade.theme`, `ade.smartTooltips`, `ade.terminalPreferences.v1`) are still read as a one-time migration fallback; every setter now snapshots prev state via `set((prev) => { ... })` and writes the unified JSON.
- **#20 — Compact JSON for machine files**. `apps/desktop/src/preload/preload.ts` was re-audited; it currently has no `JSON.stringify(x, null, 2)` call sites — no-op for this pass.

Verification: `cd apps/desktop && npx tsc --noEmit -p .` passed. All 8 vitest shards passed (0 failed test files, all previously-drifted tests fixed in Part A).

---

## Heavy-load pass (2026-10-05)

Trigger: with many chats running across projects, chats stopped showing status and needed a nudge, and switching chats and tabs was slow. Method: read the installed brain's logs, then reproduce each cost on a lane dev build (own socket, `--no-sync`) and measure it with deterministic counts over the DevTools protocol (React commits, style recalcs, script and task time, V8 CPU profiles of the brain), before and after each change. All numbers are from macOS on the same machine.

### Root cause of the frozen chats

The installed brain died with `FATAL ERROR: JavaScript heap out of memory` (10:06 on 2026-10-05, and on 2026-10-03). Its heap went 356 → 822 → 1,538 MB in fifteen minutes, then to 2.9 GB of live strings in its last 40 seconds. A brain death drops every chat's live status at once.

The heap filled with App Control screencast frames. A session pushes a 80–350 KB base64 JPEG at the page's repaint rate whether or not anything watches. The local desktop subscribed to every frame, and the brain's local RPC socket queued writes with no limit, so a client that read slower than ~16 MB/s grew the brain's heap until V8 aborted. Agents driving dev apps with App Control in other lanes were enough to set it off.

### Applied

| Change | Where | Measured |
|---|---|---|
| A local RPC client more than 64 MiB behind is dropped (it reconnects from its cursor); a droppable notification (a frame) is skipped for a client more than 1 MiB behind | `apps/ade-cli/src/cli.ts`, `jsonrpc.ts`, `multiProjectRpcServer.ts` | Stalled client: brain RSS 431 → 1,611 MB in 60 s before; flat ~400 MB after |
| Screencast frames reach live listeners but are never kept in the replay buffer (they evicted every chat event within a second, so reconnects read as gaps) | `apps/ade-cli/src/eventBuffer.ts`, `bootstrap.ts` | Gap detection now tracks the newest lost id, not contiguous ids |
| A screencast streams only while something shows or records it: desktop windows declare the lanes they paint (`holdFrames`), sync viewers and recordings count, an older client that never declares keeps today's always-on behaviour | `appControlLaneController.ts`, `appControlService.ts`, `appControlSyncStream.ts`, `appControlFrameSubscriptions.ts`, `localRuntimeConnectionPool.ts` | Nobody watching, 30 s: brain CPU 9 s → 2.5 s, controlled app 29.5 s → 7.7 s |
| Frames reach only the window that paints that lane | `runtimeBridge.ts`, `main.ts`, `preload.ts` | Renderer receives no frames for unwatched lanes |
| Frame dimensions read from the JPEG header, not a full base64 decode | `services/shared/imageDimensions.ts` | Brain CPU while streaming to a viewer −12% |
| Cross-machine lane sync loop broken: every successful remote call re-stamped `lastAttemptedAt` and broadcast a connection snapshot, and each snapshot forced a git-status read of every other machine, itself a call | `remoteConnectionService.ts`, `crossMachineLanes.ts`, `appStore.ts` | Idle renderer, chat open, 5 s: React commits 107 → 26, style recalcs 1,170 → 27, main-thread task 1,415 → 64 ms; ~6 forced status reads/s of every other machine → none |
| Login-shell PATH and npm prefix reads memoized for 60 s (a synchronous `zsh -lc` spawn per agent env build blocked the brain's event loop) | `cliExecutableResolver.ts` | Brain, 6 streaming chats, 20 s: busy 12.8 s → 2.9 s (with the next two rows) |
| Search indexer reads the PR list once per pass, not once per PR (quadratic in PRs) | `searchService.ts` | |
| Turn diff summaries read only untracked files the turn touched, and count lines natively | `turnDiffSummary.ts` | |
| Project config served from a stat-keyed cache; each `get()` re-parsed YAML and rewrote `test_suites` in a write transaction, once per session row in a chat list | `projectConfigService.ts` | |
| Transcript rows stay memoized while typing (two list callbacks closed over the draft) | `AgentChatPane.tsx` | Per keystroke: script 7.2 → 4.3 ms, task 13.7 → 9.6 ms, ~16 row re-renders → 0 |

### Backlog, measured but not applied

- **CSS spinners cost main-thread time.** Any running `animate-spin` (SVG or HTML) or the stepped `activity-hdr-pulse` forces a full main-thread frame at display rate: ~240 style recalcs/s and ~130 ms/s of main-thread work with three spinners on screen, ~15% of a renderer core whenever chats run. Chrome's trace reports the transform animation as composited (`compositeFailed: 0`), a lone spinner on an empty page still costs it, page zoom and the device scale factor do not change it, and plain Chrome does not show it. Root cause not found. Options: a Chromium-level fix, pausing indicators in an unfocused window, or swapping spinners for composited opacity pulses (a visual decision). *Applied in the Windows pass below: spinners now turn in 30 steps a second.*
- **Streaming a long tight list is O(n²).** The settled/tail cut sits only on blank lines, so a 60-item list stays in the tail and is re-parsed and re-rendered every reveal frame: 707 commits and ~22% of a core in script over 8 s for one visible streaming chat (~2–3 ms a frame). Cutting between list items risks a visible gap and wrong numbering for `1.`-only lists; memoizing `li` by content is the safer half.
- **The draft lives in `AgentChatPane`**, so each keystroke still renders the whole pane (~4 ms script). Moving it into the composer removes that.
- **Chat switch**: header 20–60 ms, transcript 100–200 ms cold and ~60 ms warm on long real chats. Hover or pointerdown prefetch would make most switches warm; the forced history reconcile on a cache hit could wait for idle.
- **Session rows lose identity on every refresh** (`useWorkSessions` sets the fresh IPC array) and three listeners refetch the session list per chat lifecycle event. Mild at the loads reproduced here (4–6 chats); worth reconciling rows by shallow equality.
- `ClaudeCacheTtlBadge` and per-row `SessionStatusLabel` timers commit several times a second; one shared clock would batch them.
- A framer-motion transition leaves `filter: blur(0px)` on the chat surface wrapper.
- An upstream `get_github_repositories` call hits its 30-per-hour limit on dev app launches.

### Machine hygiene seen during the pass (not ADE code)

- Three brains ran on the shared `~/.ade` (installed plus two lane dev brains). A dev window also re-spawns its dev brain after the launcher stops it, so stop the whole process group.
- An orphaned `python3 -` heredoc from another lane's agent spun at 100% of a core for 11.5 hours.
- A desktop `tsc --noEmit` from another agent held 4.7 GB and 1.7 cores; several agents typechecking at once saturates the machine.

---

## Windows pass (2026-10-05)

Trigger: ADE on Windows felt slow everywhere, and no performance pass had been run there. Method: attach the inspector to the installed brain on the Windows PC (`process._debugProcess`), take 10-minute CPU profiles and attribute busy time to the nearest ADE frame, then reproduce each cost in isolation (the real `runGit`, the real credential store, the real resolver) or on a lane dev build (own named pipe, `--no-sync`) and measure before and after. Renderer costs were measured by OS-level process CPU with no debugger attached, and by Chromium traces for the per-frame breakdown. The PC: Windows 11, 240 Hz display at 110% scaling, an 80-entry `PATH`.

### What the installed brain was doing

Its log recorded 1,643 `brain.event_loop_near_miss` warnings, 20-50 a day on busy days, median 3.6-5.9 s, worst 15 s, almost all during background work. Over a 10-minute profile, 61 s of JavaScript ran, in 156 blocks of 100 ms or more:

| Busy time | Where | Why it is a Windows cost |
|---|---|---|
| 20.3 s | `spawn` under `runGitOnce` | libuv runs `CreateProcess` on the calling thread |
| ~13 s | credential `getSync`: lock file create/write/delete, `sleepSync`, decrypt | file create/delete passes through Defender |
| 6.3 s | `os.networkInterfaces()` in `readLocalNetworkMetadata` | synchronous adapter enumeration, ~3 calls a second |
| 4.7 s | CLI discovery: `stat` per PATHEXT name x 2 casings x every dir | 80-entry PATH, 29,536 stats per pass |
| 2.6 s | `git remote get-url origin`, `where.exe`, `gh auth token` | a spawn per poll |

### Applied

| Change | Where | Measured |
|---|---|---|
| Git spawns run on a worker thread; tree kill runs `taskkill` to completion in the worker before killing the leader | `services/shared/offThreadSpawn.ts`, `services/git/git.ts` | Real `runGit`, 256 calls: worst event-loop gap 146-1,179 ms -> 15-16 ms; wall and main CPU at parity |
| A settled credential read is reused while one `stat` shows the file unchanged; expires with the 5 s quarantine probe | `ade-cli/.../credentials/credentialStore.ts` | 300 `getSync`: 323 ms -> 3.2 ms |
| Network interface list reused for 5 s | `ade-cli/.../sync/deviceRegistryService.ts` | ~6 s per 10 min -> ~0 |
| CLI discovery lists each directory once (10 s), no `where.exe` | `services/ai/cliExecutableResolver.ts`, `authDetector.ts` | 14 lookups: 450 ms / 29,536 stats -> 37 ms cold, 5 ms warm / 6 stats |
| Origin URL from the repo git cache | `ade-cli/src/headlessLinearServices.ts` | 43 spawns per 5 min -> one per 5 min |
| `gh auth token` and `tailscale status` off the event loop | same files, `execFileOffThread` | 83-121 ms blocks -> none |
| Every spinner turns in 30 steps a second | `renderer/index.css` (`--animate-spin`) and the custom spin keyframes | One 16px spinner, renderer + GPU: ~58% of a core -> idle noise; per 2 s main-thread task 436 -> 145 ms, layerize 214 -> 25 ms |

Whole-brain check, dev brain near idle, same 5-minute window: busy 5,267 -> 2,791 ms, blocks >= 50 ms 17 -> 8, worst 784 -> 346 ms.

Why spinners: Electron does not composite CSS rotations (keyframes, the `rotate` property and the Web Animations API alike, in ADE's document or a bare iframe, with or without DevTools attached). Each display frame re-runs paint and layerize for the whole window and the GPU composites it, so the cost scales with the refresh rate. Opacity animations are composited and stay cheap; the pulses were already quantized with `steps()` for a related GPU cost.

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

### Applied

| Change | Where | Measured |
|---|---|---|
| An unfiltered catalog parse is memoized per machine scope, keyed on the catalog object's identity and a new registry generation; a `filter`ed caller (the open picker, harness reach) keeps the uncached path | `ModelPicker/modelCatalog.ts`, `shared/modelRegistry.ts` | `descriptorsFromAgentChatModelCatalog` on this machine's real 83-model catalog: 0.448 -> 0.002 ms a call |
| `getModelById` caches the descriptors its parse-and-construct tail builds for dynamic ids (`pi:...`, OpenCode refs, `ollama/...`, `cursor/...`, `droid/...`), dropped on a registry-generation change | `shared/modelRegistry.ts` | 110 mixed ids: 0.112 -> 0.019 ms |
| Model-label and lane-name sorts go through one shared `Intl.Collator` | `shared/formatting.ts` and its five hot callers | 110-label sort: 1.40 -> 0.023 ms; `handoffAvailableModelIds` 0.967 -> 0.046 ms a call |
| Claude Code's daemon is discovered on Windows too: `\.\pipe\cc-daemon-<nonce>-control`, nonce from `<config dir>/daemon/pipe.key` | `chat/agentChatService.ts` | Endpoint, line protocol and fail-closed paths verified against a stand-in pipe server; the one live consumer could previously only answer `unknown` |

### Claude background-job reattach on Windows

The backlog said each Claude follow-up respawns the CLI on Windows because
Claude Code ships no `control.sock` there. Both halves needed correcting.

- **Claude Code does have a Windows daemon.** Its own bundle resolves the
  control endpoint as `\.\pipe\cc-daemon-<nonce>-control` on Windows and
  `<tmp>/cc-daemon-<uid>/<hash>/control.sock` elsewhere, with the nonce in
  `<config dir>/daemon/pipe.key` validated as 16 hex characters. It even reports
  `sockDir: \.\pipe\cc-daemon-*` in its own diagnostics. ADE implemented the
  POSIX half only, so `resolveClaudeDaemonControlSocket` could never return an
  endpoint on Windows.
- **The respawn the backlog described was unreachable anyway.**
  `_runClaudeBackgroundTurn` — the whole `claude --bg` turn path, including
  `dispatchClaudeBackgroundPrompt` and its reply-into-a-live-job branch — has no
  callers. No Claude chat turn goes through it, so no turn was paying a respawn
  for want of a socket. Left in place; deleting a path this size is the owner's
  call, not a perf pass's.
- **What was actually broken is settle teardown.**
  `hasLiveClaudeBackgroundJob` deliberately answers `unknown` rather than `gone`
  when it cannot reach a daemon, so a settle does not mistake a running job for
  a finished one. On Windows it could only ever answer `unknown`, so a session
  carrying a recorded `claudeBackgroundJobShort` spent the confirmation budget
  and reported residue that did not exist — the exact failure the comment above
  it was written to prevent. Narrow today, because only the dead path and
  restored records set that field.
- **Not verified:** an exchange with a live Claude daemon. `claude --bg` refuses
  to start from a non-TTY until the workspace trust prompt is accepted, and
  faking that means writing the user's Claude config. The endpoint construction,
  the `proto: 1` line protocol over a Windows named pipe, and both fail-closed
  paths (missing key, malformed key) are verified against a stand-in pipe server
  on this host.

### Closed by measurement, not by code

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

