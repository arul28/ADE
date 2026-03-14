# Validation Contract — Milestone 3 (UI Architecture) & Milestone 4 (UI/UX Overhaul)

> Generated: 2026-03-10
> Baseline: `MissionsPage.tsx` (2,437 lines, 45 useState hooks), `MissionChatV2.tsx` (1,755 lines), `MissionRunPanel.tsx` (645 lines)

---

## Milestone 3 — UI Architecture (`VAL-ARCH-*`)

### VAL-ARCH-001 — Zustand Store Replaces Component-Local State

**Title:** Mission page state extracted to zustand store

**Description:** The `MissionsPage` default export must not declare any `useState` hooks for domain state. All state currently managed via the 45 `useState` calls (missions list, selectedMissionId, selectedMission, runGraph, dashboard, loading/error flags, settings state, tab state, intervention state, toast state, etc.) must be read from a zustand store via selector hooks. Transient UI-only state (e.g. a tooltip hover) may remain local but must not exceed 5 `useState` calls in the top-level component.

**Pass/Fail Condition:**
- `grep -c 'useState' MissionsPage.tsx` ≤ 5
- A file `useMissionsStore.ts` (or equivalent) exists exporting a zustand store with `create()`
- The store exports typed selectors for at least: `missions`, `selectedMissionId`, `selectedMission`, `runGraph`, `dashboard`, `activeTab`, `loading`, `error`
- Unit test: importing the store and calling `getState()` returns the expected initial shape

**Evidence:** Code review (grep count), unit test output (`vitest`), store type assertion test

---

### VAL-ARCH-002 — MissionsPage Component Decomposition

**Title:** MissionsPage split into focused sub-components

**Description:** `MissionsPage.tsx` must be ≤ 400 lines. The current 2,437-line mega-component must be decomposed into separately importable components: sidebar/mission-list, detail header, tab bar, workspace content area, settings dialog host, manage-mission dialog, and attention toast layer.

**Pass/Fail Condition:**
- `wc -l MissionsPage.tsx` ≤ 400
- At least 6 new component files exist under `components/missions/` that are imported by `MissionsPage.tsx`
- Each extracted component file is ≤ 500 lines
- No component has more than 10 props (prop-drilling indicates missing store extraction)

**Evidence:** `wc -l` on all mission component files, code review for import graph

---

### VAL-ARCH-003 — MissionChatV2 Decomposition

**Title:** MissionChatV2.tsx split into focused sub-components

**Description:** `MissionChatV2.tsx` (currently 1,755 lines) must be ≤ 500 lines. Channel sidebar, message rendering, input area, structured-signal filtering, mention resolution, and approval handling must be extracted into separate files.

**Pass/Fail Condition:**
- `wc -l MissionChatV2.tsx` ≤ 500
- Channel list/sidebar is a separate component
- Message rendering logic (signal classification, structured value formatting) is in separate modules
- Input area with mention support is a separate component
- Unit tests for `isSignalMessage`, `isUsefulStructuredSignal`, and `collapsePlannerStreamMessages` pass independently (currently these are tested via re-exports — they must be directly importable from their own module)

**Evidence:** `wc -l`, unit test output, import graph review

---

### VAL-ARCH-004 — IPC Consolidation via getFullMissionView

**Title:** Single IPC call replaces waterfall of 6+ separate calls

**Description:** When a mission is selected, the current code fires 6+ separate IPC calls in sequence or parallel (`missions.get`, `orchestrator.listRuns`, `orchestrator.getRunGraph`, `orchestrator.listArtifacts`, `orchestrator.listWorkerCheckpoints`, `orchestrator.getModelCapabilities`). A new `getFullMissionView()` IPC handler must consolidate these into a single round-trip returning all data needed to render the mission detail view.

**Pass/Fail Condition:**
- A `getFullMissionView` IPC handler exists in the main process
- Selecting a mission in the UI triggers at most 2 IPC calls for initial load (the consolidated call + optional real-time subscription setup)
- The consolidated response type includes: `mission: MissionDetail`, `runGraph: OrchestratorRunGraph | null`, `artifacts: OrchestratorArtifact[]`, `workerCheckpoints: OrchestratorWorkerCheckpoint[]`, `modelCapabilities: GetModelCapabilitiesResult | null`
- Unit test: calling `getFullMissionView({ missionId })` returns a well-typed response with all fields populated
- No waterfall `window.ade.orchestrator.*` calls remain in the component for initial load

**Evidence:** IPC handler implementation, grep for `window.ade.orchestrator` calls in mission selection path, unit test

---

### VAL-ARCH-005 — Mission List Virtualization

**Title:** Mission sidebar list is virtualized for 300+ items

**Description:** The mission sidebar currently renders all items in a flat `.map()` loop (up to 300 items per the `list({ limit: 300 })` call). The list must be virtualized so that only visible items are mounted in the DOM. Scrolling through 300 missions must not cause visible frame drops.

**Pass/Fail Condition:**
- Mission list uses a virtualization strategy (custom windowing or a library like `@tanstack/react-virtual`)
- With 300 missions loaded, DOM node count in the sidebar is ≤ 40 (visible items + buffer)
- agent-browser screenshot: scrolling the mission list shows no layout glitches or blank gaps
- Performance: rendering 300 missions does not cause React DevTools to report any component render > 16ms

**Evidence:** agent-browser DOM inspection (`querySelectorAll` count), screenshot during scroll, code review for virtualization implementation

---

### VAL-ARCH-006 — Message List Virtualization

**Title:** Chat message lists are virtualized for long conversations

**Description:** Mission chat threads (in `MissionChatV2` / `MissionThreadMessageList`) must virtualize message rendering. The existing `AgentChatMessageList` already has virtualization patterns (line 1140+) — mission chat must use a comparable approach. Conversations with 200+ messages must render without mounting all DOM nodes.

**Pass/Fail Condition:**
- Message list uses virtualization (windowed rendering)
- With 200+ messages in a thread, DOM node count for message elements is ≤ 50
- Scrolling to top and bottom of a long conversation works smoothly
- Jump-to-message (`chatJumpTarget`) still correctly scrolls to and highlights the target message after virtualization

**Evidence:** agent-browser DOM count check, agent-browser scroll test, unit test for jump-to behavior

---

### VAL-ARCH-007 — Polling and Event Subscription Cleanup

**Title:** Single coordinated polling system with no redundant subscriptions

**Description:** The current implementation has: (a) `useMissionPolling` shared coordinator with 2s master tick, (b) per-component `setInterval` for checkpoint status (10s), (c) `window.ade.missions.onEvent` subscription with debounced refresh, (d) `window.ade.orchestrator.onEvent` subscription with debounced refresh, (e) `useMissionRunView` with its own 10s polling + `subscribeRunView` + `onEvent` listener. These overlapping mechanisms must be unified. All polling must go through `useMissionPolling` or a single store-level subscription system, with no component-level `setInterval` or `setTimeout` for refresh.

**Pass/Fail Condition:**
- Zero `setInterval` calls in mission component files (all polling through the shared coordinator or store)
- Zero `window.setTimeout` calls used for refresh scheduling in components (debouncing moves to store/middleware)
- Event subscriptions (`onEvent`, `subscribeRunView`) are registered at most once per active mission, in the store layer
- `useMissionPolling` registrations total ≤ 3 for a fully loaded mission detail view
- No duplicate IPC calls fire when both a polling tick and an event arrive within 500ms (verified by IPC call counting in test)

**Evidence:** grep for `setInterval`/`setTimeout` in components, IPC call log analysis, unit test with mock timers

---

### VAL-ARCH-008 — Store Selectors Prevent Unnecessary Re-renders

**Title:** Zustand selectors are granular and memoized

**Description:** Components must subscribe to only the store slices they need. The sidebar should not re-render when `runGraph` changes. The chat tab should not re-render when `missionListView` changes. Selector granularity must be verified.

**Pass/Fail Condition:**
- Each component uses fine-grained selectors (e.g. `useStore(s => s.selectedMissionId)`) not `useStore()`
- React DevTools profiler shows: changing tabs does not re-render the mission list sidebar
- React DevTools profiler shows: receiving a runGraph update does not re-render tabs that don't consume runGraph
- No component subscribes to more than 5 store fields via a single selector

**Evidence:** Code review for selector patterns, React DevTools profiler screenshots via agent-browser

---

## Milestone 4 — UI/UX Overhaul (`VAL-UX-*`)

### VAL-UX-001 — Text Wrapping and Responsive Layout

**Title:** All text content wraps properly at any viewport width

**Description:** Currently, mission titles, prompts, step titles, and worker labels use `truncate` / `text-overflow: ellipsis` / `whiteSpace: nowrap` extensively (23+ instances in MissionsPage alone). Long mission titles and step descriptions are cut off. Content areas must use proper text wrapping with `word-break: break-word` and responsive container sizing. Truncation is acceptable only in the sidebar mission list and tab labels — never in detail/content areas.

**Pass/Fail Condition:**
- In the mission detail header: mission title wraps to multiple lines rather than truncating
- In step detail: step title and description are fully visible with word wrapping
- In mission prompt display (line ~1908): content wraps correctly (this already has `pre-wrap` — confirm preserved)
- In chat messages: long code blocks and URLs do not overflow their containers horizontally
- agent-browser test at viewport widths 900px, 1200px, 1600px: no horizontal scrollbar appears in the main content area
- Sidebar mission list items may truncate title to 1 line but show full title on hover (tooltip)

**Evidence:** agent-browser screenshots at 3 viewport widths, DOM inspection for overflow properties

---

### VAL-UX-002 — Feed Deduplication

**Title:** Repeated `manual_step_requires_operator` messages are collapsed

**Description:** When a mission step repeatedly requires operator intervention, the activity feed / chat shows duplicate messages. Consecutive messages of the same `interventionType` for the same step must be collapsed into a single entry with a count badge (e.g. "Requires operator input ×3"). The most recent message content is shown; older duplicates are hidden behind an expandable disclosure.

**Pass/Fail Condition:**
- When 5 consecutive `manual_step_requires_operator` events exist for the same step, only 1 entry renders with a "×5" badge
- Clicking the collapsed entry expands to show all 5 individual messages
- Non-consecutive duplicates (interleaved with other event types) are not collapsed
- Unit test: `collapseFeedMessages([...5 duplicates...])` returns array of length 1 with `count: 5`
- agent-browser test: the collapsed entry is visually distinct (badge visible, expand affordance present)

**Evidence:** Unit test output, agent-browser screenshot of collapsed feed

---

### VAL-UX-003 — Accurate Progress Counts

**Title:** Progress percentages exclude retries and variant attempts

**Description:** The current `executionProgress` computation (around line 225 of MissionsPage) counts all steps including retries and superseded variants. A step that failed and was retried should count as 1 unit of work, not 2. The `filterExecutionSteps` helper must exclude superseded/retry steps from the denominator.

**Pass/Fail Condition:**
- Given 10 logical steps where 2 were retried (12 total step records): progress shows `X/10` not `X/12`
- Steps with status `superseded` are excluded from both numerator and denominator
- Retry attempts (same `stepKey` or `parentStepId`) count only the latest attempt
- Unit test: `computeProgress(stepsWithRetries)` returns correct `{ completed, total, pct }` excluding retries
- The progress bar in the detail header reflects the corrected percentage

**Evidence:** Unit test output, agent-browser screenshot showing progress bar with correct fraction

---

### VAL-UX-004 — Flat Navigation Hierarchy

**Title:** Mission detail navigation is flat (no nested sub-tabs)

**Description:** Currently the Plan tab has a sub-view toggle (`planSubview: "board" | "dag"`) and the activity panel has a mode toggle (`activityPanelMode: "signal" | "logs"`). These create hidden navigation depth. All views should be promoted to top-level tabs or integrated into a single view. The user should reach any content within 1 click from the tab bar.

**Pass/Fail Condition:**
- The tab bar contains all navigable views as direct tabs (no sub-toggles within tabs)
- `planSubview` state is eliminated; board and DAG are either merged or promoted to separate tabs
- `activityPanelMode` state is eliminated; signal and logs are visible simultaneously or as separate tabs
- agent-browser test: every piece of mission information is reachable within exactly 1 tab click from the detail view
- Tab count is ≤ 7 (to prevent tab bar overflow)

**Evidence:** agent-browser tab navigation test, code review for eliminated sub-view state

---

### VAL-UX-005 — Intervention UX Redesign

**Title:** Interventions shown in single clear panel, not repeated error blocks

**Description:** Currently, interventions surface through multiple redundant paths: (a) auto-opened modal (`activeInterventionId`), (b) `HaltBanner` in MissionRunPanel, (c) attention toasts, (d) status badge change to `intervention_required`, and (e) chat thread messages. This creates visual noise where the same problem appears in 3+ places simultaneously. The redesign must provide a single, prominent intervention panel that replaces the modal + toast + banner pattern.

**Pass/Fail Condition:**
- Open interventions render in a dedicated panel within the mission detail view (not a modal overlay)
- The intervention panel shows: title, type, created timestamp, response input, and resolve/dismiss actions
- When an intervention is open: no separate modal auto-opens (the `ClarificationQuizModal` and `ManualInputResponseModal` modals are removed or refactored into the panel)
- Attention toasts for interventions still fire but clicking them navigates to the intervention panel, not opens a modal
- agent-browser test: with 1 open intervention, the intervention content appears in exactly 1 location in the DOM (not duplicated across modal + banner + toast body)
- For multiple simultaneous interventions: the panel shows a stacked list with individual resolve actions

**Evidence:** agent-browser DOM inspection (count elements containing intervention title), screenshot of intervention panel

---

### VAL-UX-006 — Mission Lifecycle Actions (Archive, Cancel, Stop)

**Title:** Clear distinction between stop, cancel, and archive actions

**Description:** The current manage-mission dialog conflates stopping a run, canceling a mission, and archiving. These are three distinct operations: (1) **Stop** = pause the current run but keep the mission active, (2) **Cancel** = terminate the mission permanently, (3) **Archive** = hide a terminal mission from the active list. Each must have its own clearly labeled action with a confirmation step and visual distinction.

**Pass/Fail Condition:**
- The mission context menu / manage dialog offers exactly three lifecycle actions: Stop Run, Cancel Mission, Archive Mission
- Stop Run: only available when `runGraph.run.status` is `running` or `paused`; calls `pauseRun` or `cancelRun` appropriately
- Cancel Mission: available for any non-terminal mission; sets mission status to `canceled` and cancels any active run
- Archive Mission: only available for terminal missions (`completed`, `failed`, `canceled`); removes from active list
- Each action has a distinct visual style (Stop = amber/warning, Cancel = red/danger, Archive = gray/neutral)
- Confirmation dialog appears before Cancel and Archive (not for Stop, which is instantly reversible via Resume)
- agent-browser test: right-clicking an in-progress mission shows Stop and Cancel but not Archive; right-clicking a completed mission shows Archive but not Stop

**Evidence:** agent-browser context menu screenshots for different mission states, unit test for lifecycle action availability logic

---

### VAL-UX-007 — Status Coherence Across Panels

**Title:** Mission status is consistent across sidebar, header, run panel, and chat

**Description:** A mission's status must display identically in every location: sidebar badge, detail header badge, run panel status indicator, and chat channel status. Currently, the sidebar uses `STATUS_BADGE_STYLES[status]`, the run panel uses its own `STATUS_COLOR` map, and chat uses `STATUS_DOT`. These must converge to a single source-of-truth mapping.

**Pass/Fail Condition:**
- A single `STATUS_CONFIG` (or equivalent) export defines color, label, and icon for each `MissionStatus` value
- All components import from this single source — no local `STATUS_COLOR`, `STATUS_DOT`, or equivalent maps in individual component files
- grep for `Record<string, string>` pattern matching status color maps returns exactly 1 result (the canonical config)
- agent-browser test: for a mission in `intervention_required` status, the badge color is identical (#F59E0B) in sidebar, header, and run panel
- For `OrchestratorRunStatus` (a different type), a separate canonical map exists but is not conflated with `MissionStatus` maps

**Evidence:** grep for status color maps, agent-browser pixel-color comparison screenshots

---

### VAL-UX-008 — Environment Error Clarity

**Title:** ADE platform errors are visually distinct from AI provider noise

**Description:** When a mission fails, the user sees error messages from multiple sources: ADE orchestrator errors, AI provider API errors (rate limits, context length), executor runtime errors (CLI crashes), and low-signal noise (MCP metadata, streaming status). These must be visually categorized so the user can immediately identify: (a) is this an ADE bug? (b) is this a provider issue? (c) is this expected retry behavior?

**Pass/Fail Condition:**
- Error messages in the activity feed / halt banner include a source badge: `ADE`, `Provider`, `Executor`, or `Runtime`
- ADE errors use red styling; Provider errors use amber/warning styling; Executor errors use blue/info styling
- The `NOISY_EVENT_TYPES` set (currently 8 event types in missionHelpers) is used to filter noise from the error display — these events never appear as "errors" to the user
- agent-browser test: an API rate-limit error shows with `Provider` badge in amber, not as a red ADE error
- Unit test: `classifyErrorSource(error)` correctly categorizes at least: `orchestrator_internal_error` → ADE, `api_rate_limit` → Provider, `cli_process_exit` → Executor, `scheduler_tick` → filtered/hidden

**Evidence:** Unit test output, agent-browser screenshot of categorized error display

---

### VAL-UX-009 — Clean Spacing and Visual Density

**Title:** Mission UI uses consistent spacing scale and readable density

**Description:** The current UI has inconsistent spacing: padding values range from `1px` to `10px` in arbitrary increments, font sizes range from `8px` to `14px` with 7 different sizes used. A consistent spacing scale (4px base) and type scale (max 4 sizes) must be applied.

**Pass/Fail Condition:**
- All padding/margin values in mission components are multiples of 4px (4, 8, 12, 16, 20, 24)
- Font sizes used across mission components are limited to at most 4 values (e.g. 10px, 12px, 14px, 16px)
- No inline `fontSize` values below 10px (the current 8px and 9px labels are too small for accessibility)
- agent-browser accessibility check: text contrast ratio ≥ 4.5:1 for all body text, ≥ 3:1 for large text
- agent-browser screenshot at 100% zoom: all text is readable without squinting

**Evidence:** grep for font-size/padding values, agent-browser accessibility audit, comparison screenshots

---

### VAL-UX-010 — Responsive Sidebar Width

**Title:** Mission sidebar is resizable and responsive

**Description:** The sidebar is currently fixed at `w-[248px]`. On narrow viewports this consumes too much space; on wide viewports the detail area is underutilized. The sidebar must be resizable via drag handle, with a minimum of 200px and maximum of 400px, persisting the user's preference.

**Pass/Fail Condition:**
- A drag handle exists on the right edge of the sidebar
- Dragging resizes the sidebar between 200px and 400px
- The user's width preference is persisted (survives page reload)
- At viewport width < 900px, the sidebar collapses to an overlay/drawer that can be toggled
- agent-browser test: drag the handle to 300px, reload, sidebar is still 300px

**Evidence:** agent-browser drag interaction test, localStorage/store inspection for persisted width

---

## Summary Matrix

| ID | Area | Verification Method | Automated? |
|---|---|---|---|
| VAL-ARCH-001 | Zustand store | grep + unit test | ✅ |
| VAL-ARCH-002 | Component split | wc -l + code review | ✅ |
| VAL-ARCH-003 | Chat split | wc -l + unit test | ✅ |
| VAL-ARCH-004 | IPC consolidation | grep + unit test | ✅ |
| VAL-ARCH-005 | List virtualization | agent-browser DOM count | ✅ |
| VAL-ARCH-006 | Message virtualization | agent-browser DOM count | ✅ |
| VAL-ARCH-007 | Polling cleanup | grep + unit test | ✅ |
| VAL-ARCH-008 | Selector granularity | profiler + code review | ⚠️ partial |
| VAL-UX-001 | Text wrapping | agent-browser screenshots | ✅ |
| VAL-UX-002 | Feed dedup | unit test + agent-browser | ✅ |
| VAL-UX-003 | Progress counts | unit test + agent-browser | ✅ |
| VAL-UX-004 | Flat navigation | agent-browser + code review | ✅ |
| VAL-UX-005 | Intervention panel | agent-browser DOM + screenshot | ✅ |
| VAL-UX-006 | Lifecycle actions | agent-browser + unit test | ✅ |
| VAL-UX-007 | Status coherence | grep + agent-browser pixel check | ✅ |
| VAL-UX-008 | Error clarity | unit test + agent-browser | ✅ |
| VAL-UX-009 | Spacing/density | grep + agent-browser a11y | ✅ |
| VAL-UX-010 | Responsive sidebar | agent-browser drag test | ✅ |
