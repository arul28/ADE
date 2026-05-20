# Missions tab action inventory

This is the audit matrix for Missions-tab autoresearch. It is deliberately not a
completion claim. A row is only `measured` when a real Missions-tab UI run has a
matching manual marker, an equivalent UI-derived probe against the perf-pass
repo, a Codex Computer Use observation recorded in this matrix, or a focused
test that reproduces the exact behavior.

Coverage states:

- `source`: found in source, not yet driven in the current inventory pass.
- `measured`: exact row covered by a real Missions UI run, UI-derived probe,
  Codex Computer Use observation, or focused fixture test with evidence.
- `measured-partial`: driven in an earlier partial pass; must be re-driven by
  this matrix before claiming full coverage.
- `fixture-needed`: safe to drive, but needs seeded mission/run/worker state.
- `sandbox-only`: may start agents, local tools, or mutate the perf-pass repo.
- `prompt-only`: destructive or externally visible path. Open and measure the
  confirmation/preflight, then cancel unless explicitly allowed.
- `external-skip`: opens another app, browser, external service, or copies data
  out of ADE.
- `not-applicable`: row came from an older/source-derived inventory item but
  the current visible Missions surface no longer exposes that control.

Comparison target from Factory Missions docs:

- Collaborative planning must be conversational, not a one-shot prompt.
- Plans should break large work into features/milestones and validation points.
- Mission Control should show progress, workers, interventions, and re-planning.
- Users should be able to pause, redirect, unblock, and recover stuck work.
- Cost/duration should be explained in terms of worker and validation runs.

Evidence used so far:

- `missions-ui-audit-20260520-025200`
- `missions-ui-audit-perfpass-20260520-025349`
- Codex Computer Use observation on 2026-05-20: live Electron app
  `/Users/admin/Projects/ADE/apps/desktop/node_modules/electron/dist/Electron.app`,
  URL `localhost:5173/missions`, project `/Users/admin/Projects/perf pass`,
  ADE window resized to `1460x880`.
- Codex Computer Use observation on 2026-05-20 of the completed FleetOps mission:
  create dialog, settings dialog, mission selection, Conversations/Plan/Timeline/
  Artifacts tabs, artifact preview, completed worker history, and Manage dialog.
- Codex Computer Use observation on 2026-05-20 of the Factory-style create flow:
  filled a large prompt, applied Codex low/full-auto, added a custom
  Discovery / Requirements phase, enabled Ask Questions, reordered it between
  Planning and Development, and ran Review Launch. Preflight passed with one
  budget warning and no failures; launch was canceled at the boundary.
- Codex Computer Use observation on 2026-05-20 of live mission
  `Planning policy smoke v11 in this perf-pass repo.`:
  planner opened a blocking manual-input question, the answer was submitted
  through the inline intervention panel, Planning phase approval was submitted,
  workers ran through implementation/integration/testing/validation/closeout,
  and closeout produced the ADE-local proof note `.ade/planning-smoke-v11.md`.
  After the desktop build refreshed the single default `/tmp/ade-runtime-dev.sock`
  runtime, the same mission rehydrated from `BLOCKED` to `DONE`.
- Live CDP/Codex Computer Use check on 2026-05-20 after HMR: `/missions`
  exposed `[data-route="missions"]`, dashboard recent actions rendered `VIEW`
  instead of inert `RERUN`/`RETRY`, and the ADE dev window stayed at `1460x880`.
- Large fixture pass on 2026-05-20 used only the existing attach-launched
  Electron app on `localhost:5173` and the existing `/tmp/ade-runtime-dev.sock`
  runtime. It did not launch a second dev app and did not touch
  `/tmp/ade-runtime-dev-tui-perf-241a6c0b.sock`. The seeded perf-pass mission
  `perf-large-mission-20260520` rendered in the sidebar at `132/132`, with
  132 steps, 132 attempts, 720 chat messages, 2,200 timeline events, 90 mission
  artifacts, 90 orchestrator artifacts, 90 checkpoints, and 6 resolved
  interventions. Attached CDP timings on the live window: `missions.list.ipc`
  3ms, `missions.dashboard.ipc` 4ms, `missions.fullView.large.ipc` 25ms;
  tab render probes showed Overview 624 nodes, Conversations 850, Plan 4,635
  with 17 compact `SHOW MORE` controls after optimization, Timeline 1,929,
  Artifacts 2,554, heap about 113MB after 5s idle.
- Focused unit coverage added on 2026-05-20 for Smart Budget default hydration,
  Smart Budget settings persistence, dashboard recent-action labels, and
  phase-approval steering transitions. Focused Plan coverage also asserts that
  large missions compact duplicate step lists until expanded.
- Steer/replan fixture pass on 2026-05-20 used only the existing
  attach-launched Electron app and perf-pass DB. Mission
  `perf-steer-mission-20260520` rendered as `BLOCKED`, `2/5`, with one open
  manual-input intervention, a paused run, one `coordinator_steering` runtime
  event, one `plan_revised` event, and one `intervention_opened` event. Codex
  Computer Use observed the inline intervention, Conversations feed, Timeline
  entries for `Plan revised` and `User steering`, and Plan state with one
  succeeded step, one superseded broad dashboard step, one ready replacement
  schedule-risk step, one blocked operator-review step, and one pending
  validation step. A post-build CUA check also verified selecting the mission
  rewrites the URL to `missionId=perf-steer-mission-20260520`, so reloads no
  longer fall back to the previous large fixture. No workers or second dev
  runtime were launched.
- Focused tests from the current worktree listed in each row.

## Route shell and dashboard

| id | action | state | evidence |
| --- | --- | --- | --- |
| missions.route.open | Open Missions route on perf-pass project | measured | CUA 2026-05-20 observed `localhost:5173/missions` with project `perf pass`; source `MissionsPage.tsx` |
| missions.route.resize | Verify ADE window stays larger than default after restart | measured | CUA 2026-05-20; System Events reported ADE at `1460x880` after Electron PID restarts |
| missions.dashboard.home.empty | Render no-selection dashboard / empty active missions | measured-partial | `missions-ui-audit-perfpass-20260520-025349`, marker `missions-home-empty`; CUA 2026-05-20 showed dashboard cards |
| missions.dashboard.recent.select | Select recent mission from dashboard | measured | `MissionsHomeDashboard.test.tsx`; live CDP 2026-05-20 showed recent actions as `VIEW` |
| missions.dashboard.rerun | Click recent mission `RERUN` | not-applicable | Dashboard recent actions were relabeled to `VIEW` because the control only selects a mission; `MissionsHomeDashboard.test.tsx` |
| missions.dashboard.new | Click dashboard `NEW MISSION` | source | `MissionsHomeDashboard.tsx`, `missionCreateDialogStore.ts` |
| missions.route.inactive | Switch away and confirm Missions polling quiets while inactive | fixture-needed | `MissionActiveContext.tsx`, `useMissionRunView.ts`, docs/features/missions/README.md |

## Sidebar and mission list

| id | action | state | evidence |
| --- | --- | --- | --- |
| missions.sidebar.refresh | Click sidebar Refresh | measured | CUA 2026-05-20 clicked Refresh after direct fixture seeding; total updated without restarting ADE; `MissionSidebar.tsx`; store coverage `useMissionsStore.test.ts` |
| missions.sidebar.settings.open | Open Mission Settings from sidebar gear | measured | CUA 2026-05-20 opened settings modal; `MissionSidebar.tsx`, `MissionSettingsDialog.tsx` |
| missions.sidebar.new | Open New Mission from sidebar plus button | measured | CUA 2026-05-20 opened Create Mission modal; `MissionSidebar.tsx`, `CreateMissionDialog.tsx` |
| missions.sidebar.search.match | Type a matching mission search | source | `MissionSidebar.tsx` |
| missions.sidebar.search.nomatch | Type a no-match mission search and clear | source | `MissionSidebar.tsx` |
| missions.sidebar.view.list | Switch to list view | source | `MissionSidebar.tsx`; virtualized list `data-testid=mission-list-virtual` |
| missions.sidebar.view.board | Switch to board view | source | `MissionSidebar.tsx`; board view is not virtualized |
| missions.sidebar.select | Select mission from list | measured | CUA 2026-05-20 selected completed FleetOps mission and steer/replan fixture from list; post-build CUA verified list selection synced the `missionId` URL query |
| missions.sidebar.context.open | Right-click mission list item context menu | source | `MissionSidebar.tsx`, `ManageMissionDialog.tsx` |
| missions.sidebar.context.open-mission | Context menu Open Mission | source | `MissionContextMenu` |
| missions.sidebar.context.manage | Context menu Manage Mission | source | `MissionContextMenu`, `ManageMissionDialog.tsx` |
| missions.sidebar.status.block | Selected mission status block updates title/status/phase/open counts | measured | helper tests in `missionHelpers.test.ts`; CUA 2026-05-20 showed selected mission title, completed state, phase badge, open count, and artifact count |

## Mission creation dialog

| id | action | state | evidence |
| --- | --- | --- | --- |
| missions.create.open | Open Create Mission dialog | measured | CUA 2026-05-20 opened modal from sidebar plus button |
| missions.create.prompt | Fill a large mission prompt | measured | CUA 2026-05-20 filled Factory-style launch-operations mission prompt in Create Mission dialog |
| missions.create.models.codex-low | Apply Codex low/full-auto preset | measured | CUA 2026-05-20 showed orchestrator and phases set to `openai/gpt-5.5 · low`; helper coverage in `CreateMissionDialog.test.ts` |
| missions.create.models.phase-sync | Apply one model config to all phases | measured | `CreateMissionDialog.test.ts` |
| missions.create.profile.select | Select a phase profile | source | `CreateMissionDialog.tsx` |
| missions.create.phase.add-custom | Add custom phase before closeout | measured | `CreateMissionDialog.test.ts` |
| missions.create.phase.edit | Edit phase key/name/instructions/model/validation/questions | measured | CUA 2026-05-20 configured custom Discovery / Requirements name, key, description, instructions, Ask Questions, and phase order; persistence coverage in `missionService.test.ts` |
| missions.create.phase.required-question | Configure Planning to require a blocking question before exit | measured | backend and launch-request coverage in `missionService.test.ts`, `coordinatorTools.test.ts`, `orchestratorService.test.ts` |
| missions.create.permissions | Edit worker permissions / sandbox controls | measured-partial | CUA 2026-05-20 confirmed Codex low/full-auto preset set Codex workers to full access; direct editor controls still need UI pass |
| missions.create.budget.smart | Toggle smart budget panel and budget caps | measured | `CreateMissionDialog.test.ts` covers Smart Budget defaults in new mission launch drafts; `useMissionsStore.test.ts` covers hydrate/save to project config |
| missions.create.team-runtime | Change max workers / parallelism settings | source | `CreateMissionDialog.tsx` |
| missions.create.preflight | Run launch preflight and inspect warnings/blockers | measured | CUA 2026-05-20 Review Launch passed for 7-phase Factory-style mission with `Planning -> Discovery / Requirements -> Development -> Integration -> Testing -> Validation -> Closeout`; one budget warning, zero failures |
| missions.create.launch | Launch a mission from the dialog | sandbox-only | Starts agents and mutates perf-pass repo |
| missions.create.high-teammate-confirm | Confirm high teammate/parallelism warning | fixture-needed | `CreateMissionDialog.tsx` |
| missions.create.close | Close dialog without launch | measured | CUA 2026-05-20 closed modal with Cancel and returned to dashboard |

## Mission settings dialog

| id | action | state | evidence |
| --- | --- | --- | --- |
| missions.settings.open | Open Mission Settings dialog | measured | CUA 2026-05-20 opened settings modal from sidebar gear |
| missions.settings.defaults | Change default profile / default models | measured-partial | CUA 2026-05-20 observed default model, teammate plan, worker permissions, smart budget, and profile list; `useMissionsStore.test.ts` covers Smart Budget config hydration/persistence |
| missions.settings.profile.clone | Clone a phase profile | source | `MissionSettingsDialog.tsx` |
| missions.settings.profile.edit | Edit profile name/description/phases | source | `MissionSettingsDialog.tsx`, `PhaseCardEditor.tsx` |
| missions.settings.profile.export | Export selected phase profile | external-skip | File dialog / download-like path in `MissionSettingsDialog.tsx` |
| missions.settings.profile.import | Import phase profile JSON | external-skip | File picker path in `MissionSettingsDialog.tsx` |
| missions.settings.profile.delete | Delete phase profile | prompt-only | `MissionSettingsDialog.tsx` |
| missions.settings.save | Save settings | measured-partial | Backend coverage in `missionService.test.ts`; `useMissionsStore.test.ts` covers renderer settings save into local project config; live UI save pass missing |
| missions.settings.close | Close settings without saving | measured | CUA 2026-05-20 closed settings modal without saving |

## Header and lifecycle controls

| id | action | state | evidence |
| --- | --- | --- | --- |
| missions.header.manage | Open Manage Mission from header | measured | CUA 2026-05-20 opened Manage dialog from terminal mission header |
| missions.header.start | Start a not-started mission | sandbox-only | `MissionHeader.tsx` |
| missions.header.rerun | Rerun terminal mission | sandbox-only | `MissionHeader.tsx`; CUA 2026-05-20 showed a terminal mission with RERUN available |
| missions.header.pause | Pause active run from header | prompt-only | Mutates active run; `MissionHeader.tsx` |
| missions.header.resume | Resume paused run from header | prompt-only | Mutates active run; `MissionHeader.tsx` |
| missions.header.cancel | Cancel active mission from header | prompt-only | Header has `window.confirm`; `MissionHeader.tsx` |
| missions.header.archive | Archive terminal mission from header | prompt-only | Header has `window.confirm`; `MissionHeader.tsx` |
| missions.manage.pause | Pause run from Manage dialog | prompt-only | `ManageMissionDialog.tsx` |
| missions.manage.resume | Resume run from Manage dialog | prompt-only | `ManageMissionDialog.tsx` |
| missions.manage.cancel | Cancel mission from Manage dialog | prompt-only | `ManageMissionDialog.tsx`; confirmation parity covered by `ManageMissionDialog.test.tsx` |
| missions.manage.archive | Archive mission from Manage dialog | prompt-only | CUA 2026-05-20 observed terminal archive modal; confirmation parity covered by `ManageMissionDialog.test.tsx` |
| missions.manage.cleanup-lanes | Toggle "also archive lanes" and archive | prompt-only | CUA 2026-05-20 observed lane-cleanup checkbox; `ManageMissionDialog.test.tsx` covers cleanup-specific confirmation text |

## Overview tab

| id | action | state | evidence |
| --- | --- | --- | --- |
| missions.overview.open | Open Overview tab | source | `MissionTabContainer.tsx`; tab ARIA coverage in `MissionTabContainer.test.tsx` |
| missions.overview.office | Inspect mission control office panel | source | `MissionControlOfficePanel.tsx`, `missionControlViewModel.test.ts` |
| missions.overview.run-panel | Inspect run panel phase/worker state | source | `MissionRunPanel.tsx`, `missionControlViewModel.test.ts` |
| missions.overview.intervention.open | Open intervention from overview panels | fixture-needed | Requires open intervention; `routeMissionIntervention` |
| missions.overview.prompt-inspect | Inspect coordinator prompt from active phase panel | fixture-needed | `MissionActivePhasePanel.tsx`, `PromptInspectorCard.tsx` |
| missions.overview.brief-scroll | Scroll long mission brief | source | `MissionTabContainer.tsx` |

## Conversations tab

| id | action | state | evidence |
| --- | --- | --- | --- |
| missions.chat.open | Open Conversations tab | measured | CUA 2026-05-20 opened tab on completed FleetOps mission |
| missions.chat.global | Select global mission feed | measured | CUA 2026-05-20 observed read-only Mission Feed with worker results, tests, and closed-run warning |
| missions.chat.orchestrator | Select orchestrator channel | measured | CUA 2026-05-20 selected Orchestrator transcript with load-older control and closed-run composer block |
| missions.chat.worker.active | Select active worker channel | fixture-needed | Needs active worker |
| missions.chat.worker.completed | Expand/select completed worker history | measured | CUA 2026-05-20 expanded Completed (8) and selected Integration worker read-only transcript; `MissionThreadMessageList.test.ts` verifies closed worker history hydrates from durable Agent Chat events; `missionChatChannelModel.test.ts` covers stale/completed channel logic |
| missions.chat.completed.collapse | Collapse completed workers section | source | `ChatChannelList.tsx` |
| missions.chat.load-older | Load older messages in a thread | fixture-needed | `MissionChatV2.tsx` |
| missions.chat.raw-tail.live-worker | Poll raw transcript tail only for live worker thread | measured | `ChatMessageArea.test.ts`, `MissionThreadMessageList.test.ts` |
| missions.chat.message.orchestrator | Message orchestrator / steer mission | sandbox-only | Sends message into runtime; `MissionChatV2.tsx`, `ChatInput.tsx` |
| missions.chat.message.worker | Message active worker | sandbox-only | Sends message into worker thread; `MissionChatV2.tsx`, `ChatInput.tsx` |
| missions.chat.message.blocked | Verify composer disabled on completed worker/global/history | measured | CUA 2026-05-20 observed closed-run warning and read-only composer footer on Mission Feed, Orchestrator, and completed worker history |
| missions.chat.mention | Append mention target from composer chips | source | `ChatInput.tsx` |
| missions.chat.controls.pause | Pause active run from chat controls | prompt-only | `MissionChatV2.tsx` |
| missions.chat.controls.resume | Resume paused run from chat controls | prompt-only | `MissionChatV2.tsx` |
| missions.chat.controls.cancel | Cancel run from chat controls | prompt-only | `MissionChatV2.tsx` |
| missions.chat.jump.worker | Jump from Plan selected step to worker channel | measured | CUA 2026-05-20 reproduced stale shared-lane misroute, then verified Plan `Planning worker` jumps to `Planning: Planning worker`; regression coverage in `missionChatChannelModel.test.ts` |

## Plan tab

| id | action | state | evidence |
| --- | --- | --- | --- |
| missions.plan.open | Open Plan tab | measured | CUA 2026-05-20 opened Plan tab on completed FleetOps mission, the 132-step synthetic fixture, and the steer/replan fixture |
| missions.plan.summary | Inspect plan summary/assumptions/risks | measured | CUA 2026-05-20 observed planner review, assumptions/risks, milestone grouping, dependency DAG, large-fixture compact groups, and steer/replan replacement state |
| missions.plan.phase.expand | Inspect phase-grouped step list | measured | CUA 2026-05-20 observed Planning, Development, Integration, Testing, Validation step groups; large fixture shows first 10 steps per phase with `SHOW MORE` expansion controls; steer fixture shows succeeded, superseded, ready, blocked, and pending steps |
| missions.plan.step.select | Select a plan step | measured | CUA 2026-05-20 observed selected Planning worker detail panel and latest worker attempt |
| missions.plan.step.output | Toggle full step output | source | `StepDetailPanel.tsx` |
| missions.plan.step.prompt | Inspect selected step effective prompt | fixture-needed | `StepDetailPanel.tsx`, `PromptInspectorCard.tsx` |
| missions.plan.step.worker-jump | Jump selected step to worker thread | measured | `missionChatChannelModel.test.ts`; live UI pass missing |
| missions.plan.dag.select | Select step from dependency graph | source | `OrchestratorDAG.tsx`, `PlanTab.tsx` |
| missions.plan.progress | Phase progress ignores canceled/display-only task shells correctly | measured | `PlanTab.test.ts`, `missionHelpers.test.ts`, `missionControlViewModel.test.ts`; `PlanTab.test.ts` also covers large-plan list compaction |

## Timeline and logs tab

| id | action | state | evidence |
| --- | --- | --- | --- |
| missions.timeline.open | Open Timeline tab | measured | CUA 2026-05-20 opened Timeline tab and observed summary, filters, raw toggle, event rows, run narrative, `Plan revised`, and `User steering` entries |
| missions.timeline.category | Change timeline category filter | source | `OrchestratorActivityFeed.tsx` |
| missions.timeline.search | Search/filter timeline events | source | `OrchestratorActivityFeed.tsx` |
| missions.timeline.severity | Change severity chips | source | `OrchestratorActivityFeed.tsx` |
| missions.timeline.reset | Reset timeline filters | source | `OrchestratorActivityFeed.tsx` |
| missions.timeline.raw-events | Toggle raw maintenance events | source | `OrchestratorActivityFeed.tsx` |
| missions.timeline.expand | Expand grouped/individual event details | source | `OrchestratorActivityFeed.tsx` |
| missions.timeline.raw-logs.open | Toggle Show raw logs | source | `MissionTabContainer.tsx`, `MissionLogsTab.tsx` |
| missions.logs.channel-filter | Toggle raw log channels | source | `MissionLogsTab.tsx` |
| missions.logs.refresh | Refresh raw logs | source | `MissionLogsTab.tsx` |
| missions.logs.export | Export raw logs | external-skip | Browser/download/clipboard boundary; `MissionLogsTab.tsx` |
| missions.logs.load-more | Load older raw logs | fixture-needed | Needs >200 events |
| missions.timeline.presentation | Suppress low-signal internal chatter and humanize kept entries | measured | `missionFeedPresentation.test.ts`, `MissionThreadMessageList.test.ts` |

## Artifacts and proof tab

| id | action | state | evidence |
| --- | --- | --- | --- |
| missions.artifacts.open | Open Artifacts tab | measured | CUA 2026-05-20 opened Artifacts tab on completed FleetOps mission |
| missions.artifacts.group.phase | Group artifacts by phase | measured | CUA 2026-05-20 observed phase grouping with closeout expected evidence |
| missions.artifacts.group.type | Group artifacts by type | source | `MissionArtifactsTab.tsx` |
| missions.artifacts.group.worker | Group artifacts by worker | measured | Added `WORKER` grouping in `MissionArtifactsTab.tsx`; `missionControlViewModel.test.ts` asserts attempt/worker grouping for orchestrator, checkpoint, and mission artifacts |
| missions.artifacts.requirements.optional | Toggle optional closeout requirements | source | `MissionArtifactsTab.tsx` |
| missions.artifacts.select | Select artifact and preview | measured | CUA 2026-05-20 selected Integration test results and previewed `npm test`/`npm run build` output |
| missions.artifacts.open-uri | Open URI-backed artifact | external-skip | `MissionArtifactsTab.tsx` |
| missions.artifacts.computer-use | Inspect computer-use proof panel/snapshot | fixture-needed | `MissionComputerUsePanel.tsx` |
| missions.artifacts.grouping | Merge mission/orchestrator/checkpoint/missing expected evidence | measured | `missionControlViewModel.test.ts` |

## Interventions and planning questions

| id | action | state | evidence |
| --- | --- | --- | --- |
| missions.intervention.panel | See open intervention in intervention panel | measured | CUA 2026-05-20 v11 mission exposed the planner's manual-input question inline after selected mission detail rehydration; steer/replan fixture also showed the open manual-input approval panel; regression coverage in `useMissionsStore.test.ts` |
| missions.intervention.manual.open | Open manual input response modal | measured | CUA 2026-05-20 v11 mission used the inline manual-input panel; `ManualInputResponseModal.tsx`, `MissionDetailView.tsx` |
| missions.intervention.manual.answer | Submit answer to manual input | measured | CUA 2026-05-20 answered `Documentation-only...` and clicked `RESOLVE`; DB showed manual_input resolved and mission resumed; regression coverage in `useMissionsStore.test.ts` |
| missions.intervention.quiz.open | Open clarification quiz modal | fixture-needed | `ClarificationQuizModal.tsx` |
| missions.intervention.quiz.answer | Submit quiz answers / default assumptions | sandbox-only | Calls `steerMission`; `MissionDetailView.tsx` |
| missions.intervention.phase-approval.resolve | Approve a phase transition intervention and continue into the target phase | measured | CUA 2026-05-20 v11 approved Planning; `aiOrchestratorService.test.ts` verifies `steerMission` updates `phaseRuntime` and records a `phase_transition` event |
| missions.planning.question.required | Planner skipping required blocking question pauses run and opens intervention | measured | `orchestratorService.test.ts`, `coordinatorTools.test.ts`, `planningQuestionPolicy.ts`; managed ADE chat `request_user_input` answers are persisted as resolved planning clarification so the phase gate does not ask a duplicate generic question |
| missions.planning.question.resolve | Answer required planning question and retry planning | measured | CUA 2026-05-20 v11 answered planner question; `aiOrchestratorService.test.ts`, `workerTracking.ts`, `useMissionsStore.test.ts` |

## Final large mission proof

| id | action | state | evidence |
| --- | --- | --- | --- |
| missions.final.create-large | Create a large Factory-style mission with custom phases | measured-partial | CUA 2026-05-20 created and preflighted the large Factory-style mission, then canceled at launch boundary; still needs final launch/run proof |
| missions.final.planning-questions | Verify planning asks and user answers blocking questions | measured | CUA 2026-05-20 v11 planner asked one blocking question; answer resolved through inline intervention; stale detail and intervention-identity refresh regressions covered by `useMissionsStore.test.ts` |
| missions.final.delegate-workers | Verify coordinator delegates to workers only when useful | measured | CUA/DB 2026-05-20 v11 launched Planning, Implementation, integration no-op, Testing, Validation, validator, and Closeout workers; single-lane integration correctly avoided merge work |
| missions.final.worker-chat | Verify orchestrator/worker/worker-like conversations are visible and readable | measured | CUA 2026-05-20 v11 Mission Feed showed operator decisions, validation signals, worker results, changed files, and test summaries; completed worker history visible |
| missions.final.replan-intervene | Verify pause/steer/replan path on a live or fixture mission | measured | CUA/DB 2026-05-20 on `perf-steer-mission-20260520`: paused run, one open manual-input approval, `coordinator_steering`, `plan_revised`, and `intervention_opened` timeline/runtime events; Plan showed superseded broad dashboard work, ready schedule-risk replacement, blocked operator review, and pending validation. Regression coverage in `aiOrchestratorService.test.ts` and `missionHelpers.test.ts` |
| missions.final.result-lane | Verify mission finalizes into a result lane and summarizes work | measured | CUA/DB 2026-05-20 v11 result lane `a72a5379-0679-43fa-bfc8-e94e2fee9937`; finalization blocked state preserved until risk-note closeout inference patch; result-lane conflict regression covered in `aiOrchestratorService.test.ts` |
| missions.final.performance | Verify UI remains responsive under a large mission history | measured | CUA/CDP 2026-05-20 on synthetic 132-step fixture: list 3ms, dashboard 4ms, fullView 25ms, tab panes rendered successfully, heap held near 113MB after 5s idle; Plan duplicate step lists compacted by default; official ADE_PERF launch remains optional because it would start a separate runner |

## Current highest-risk unproven rows

- Full create dialog UI from open -> prompt -> custom phases -> preflight is
  covered by CUA; launch remains intentionally pending until the runtime
  hardening checks pass.
- Planning question enforcement and the live UI intervention answer/retry path
  are covered by the v11 mission proof. The follow-up bug was stale selected
  mission detail when open intervention count or identity changed.
- Phase approval is now covered at both the v11 UI boundary and service level:
  approving a `phase_approval` intervention updates the run `phaseRuntime` and
  records a `phase_transition` timeline event.
- Large-read-side pressure is covered by the 132-step synthetic mission fixture.
  The Plan tab had the largest DOM pressure, so duplicate group/phase step lists
  now compact by default on large missions while keeping the dependency DAG and
  explicit expansion controls available.
- Pause, steer, and replan read-side behavior is covered by the steer/replan
  fixture. The service now records steering as runtime/timeline events, and the
  timeline helper renders both `Plan revised` and `User steering` entries for
  operator recovery context.
- Manage dialog destructive actions now have confirmation parity tests; a live
  prompt-only confirmation pass remains intentionally canceled unless allowed.
- Timeline/logs/artifacts have helper and completed-mission coverage; worker
  artifact grouping is now implemented, and the large fixture now covers
  2,200 timeline events plus 90 mission artifacts / 90 orchestrator artifacts
  on the live read side.
- The already-running default dev runtime on `/tmp/ade-runtime-dev.sock`
  initially displayed stale closeout-blocked state for v11; after the standard
  desktop build refreshed that single runtime, the mission rehydrated as DONE.
  No second runtime was launched, and the TUI socket
  `/tmp/ade-runtime-dev-tui-perf-241a6c0b.sock` was left untouched.
- Missions performance probes are now registered. The current proof is attached
  CDP/CUA against the already-running app; an official ADE_PERF run is optional
  and should use a unique socket/CDP port if run later.
