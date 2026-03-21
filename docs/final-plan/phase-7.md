# Phase 7: Full iOS & Advanced Remote

## Phase 7 -- Full iOS & Advanced Remote (6-8 weeks)

Goal: Complete the iOS app by adding all remaining desktop tabs (Missions, CTO/Chat, Automations, Graph, History) and deepening the existing Settings surface to desktop parity, while shipping advanced multi-device features. Phase 6 proved the sync architecture, shipped the W5 hardening baseline for Lanes / Files / Work / PRs plus the sync-focused Settings tab, and shipped W6 full live-desktop parity for the iPhone Lanes tab. Phase 7 brings the remaining AI orchestration surfaces to mobile and adds VPS provider integrations and advanced notification routing.

Phase 7 continues the two operating modes established in Phase 6:

- **independent desktop mode** for desktop-class ADE machines that move between machines using git plus tracked portable ADE intelligence
- **controller-to-host mode** for phones and secondary desktops that attach to a live host for real-time control and visibility

Phase 7 is primarily about deepening the controller-to-host story on iOS and VPS-backed hosts. It does not change the rule that a connected live host/controller session has one execution host at a time.

### Reference docs

- Phase 6 workstreams — cr-sqlite sync, WebSocket protocol, iOS app, device registry
- [architecture/AI_INTEGRATION.md](../architecture/AI_INTEGRATION.md) — orchestrator, agent runtimes, computer use
- [features/CTO.md](../features/CTO.md) — CTO state, daily logs, Linear sync, org chart
- [features/MISSIONS.md](../features/MISSIONS.md) — mission lifecycle, interventions, artifacts
- [features/CHAT.md](../features/CHAT.md) — agent chat sessions, providers

### Dependencies

- Phase 6 complete (multi-device sync on desktop, W5 iPhone hardening baseline for Lanes / Files / Work / PRs + Settings, and W6 full iPhone Lanes parity shipped).

---

### Architecture Overview

Phase 7 does not introduce new sync infrastructure. The Phase 6 W5 hardening pass already owns sync correctness, authoritative iPhone hydration for the four shipped tabs, reconnect/revoke clarity, persisted work-session lane names, lane-backed Files read-only parity, and the baseline desktop-theme parity pass. Phase 6 W6 then expanded the iPhone Lanes tab to the full live desktop surface, including stack, git, diff, rebase/conflict, manage, and lane-scoped work/chat flows. Phase 7 is pure feature work beyond that shipped baseline:

1. **Remaining iOS tabs** — Missions, CTO/Chat, Automations, Graph, History, plus full Settings parity beyond the Phase 6 sync shell. Each tab reads from the already-synced local SQLite database and sends commands to the host via the existing WebSocket protocol.
2. **VPS provider integrations** — one-click host provisioning on Hetzner, DigitalOcean, or any SSH-accessible machine.
3. **Advanced remote workflows** — mobile automation controls, push notifications for AI events, computer-use artifact viewing, and cross-device notification routing.
4. **iOS polish** — animations, dark mode, iPad support, widgets, Spotlight integration.

Because the sync layer is complete from Phase 6, adding each new iOS tab follows a consistent pattern:
- Read state from local cr-sqlite database (already synced)
- Render SwiftUI views
- Send commands to host via WebSocket for execution operations
- Zero sync layer changes required

Phase 7 also assumes the Phase 6 portability contract is already in place for desktop ADE machines:

- another desktop can recover important durable ADE project intelligence after clone/pull
- phones still depend on a live reachable host
- Phase 7 does not attempt multi-host active-active execution

---

### Workstreams

#### W1: iOS Missions Tab

High-parity SwiftUI implementation of the desktop Missions page.

- **Mission list**: all missions with status indicators (planning, running, paused, completed, failed), assigned agent, phase progress.
- **Mission detail view**: phase progress visualization, step list with per-step status, worker assignment, budget utilization bar, timeline of events.
- **Launch new missions**: text input → command routes to host → host plans and executes. Phone shows planning progress in real-time via cr-sqlite sync.
- **Intervention handling**: view intervention details → approve/reject with optional comment. This is the primary mobile use case for the Missions tab — fast approval from anywhere.
- **Mission history**: searchable archive of past missions with outcome, duration, budget spent.
- **Budget overview**: per-mission and aggregate spend. Budget threshold warnings.

#### W2: iOS CTO & Agent Chat Tab

Combined CTO management and agent chat interface for iOS.

- **CTO chat**: full CTO conversation interface. Send messages, view responses with code blocks and diffs. CTO identity and memory context preserved on host — phone is just the UI.
- **Worker agent chat**: select any worker from the org chart → start or continue a conversation.
- **Ad-hoc agent chat**: start a new chat session with any configured provider/model. Host spawns the agent, phone is the interface.
- **Org chart view**: CTO + workers, their status (idle/running/paused), current assignment, budget utilization.
- **Streaming token display**: real-time character-by-character rendering of agent responses via WebSocket.
- **Inline code blocks**: syntax highlighting for all major languages in agent responses. Copy-to-clipboard.
- **Inline diff viewer**: syntax-highlighted unified diffs embedded in chat messages. Tap to expand.
- **Chat session management**: archive, rename, pin sessions. Session search.
- **CTO daily summary**: the CTO's daily log rendered as a timeline view. Shows decisions, dispatched work, Linear issue handling, and memory updates from the past 24 hours.

#### W3: iOS Automations, Graph & History Tabs

Remaining desktop tabs brought to iOS.

**Automations tab:**
- Automation rule list with status (enabled/disabled), trigger class (`time-based` or `action-based`), and last run.
- Automation detail: trigger config, execution type (`agent-session`, `mission`, `built-in task`), and run history.
- Enable/disable automations from phone.
- View automation run results in Automations history and mission-linked outcomes in Missions.

**Graph tab:**
- Workspace topology visualization adapted for mobile (simplified layout, tap to zoom).
- Risk, activity, sync, and PR overlays as toggleable layers.
- Node tap → navigate to lane/PR/mission detail.

**History tab:**
- Operation history list with filters (by type, by lane, date range).
- Operation detail view.
- Search across operations.

#### W4: iOS Full Settings Tab

Complete Settings implementation for iOS beyond the Phase 6 sync shell.

- **Devices**: full device management — add, remove, configure, transfer host. Same as desktop Settings > Devices.
- **AI Providers**: view configured providers. Add/edit API keys (stored in iOS Keychain, synced as encrypted blobs or entered per-device).
- **Notifications**: per-event-type toggles, DND schedule, notification priority levels.
- **General**: appearance (dark mode), behavior preferences.
- **Context & Docs**: view context docs status, trigger regeneration (routes to host).
- **Usage**: usage overview, centralized budget policy (Settings > Usage), pacing status.

#### W5: Push Notifications & Notification Routing

- Host sends notification events to iOS peers over WebSocket. iOS app uses local notifications when in foreground.
- **APNs relay** for notifications when app is backgrounded or terminated:
  - Option A: Self-hosted — tiny Node.js relay on host or VPS, forwards directly to APNs.
  - Option B: Firebase Cloud Messaging — free tier, handles APNs delivery.
  - Option C: No push — phone relies on background refresh and manual checks.
- **Notification events**:
  - Mission completed / failed
  - Intervention needed (approve/reject) — **highest priority**
  - Agent error requiring attention
  - Budget threshold reached
  - Host status change (went offline, transferred)
  - Automation run digest ready
- Notification tap → deep link to relevant screen (mission detail, intervention, chat).
- **Cross-device notification routing**: if the user is actively using ADE on their Mac, suppress duplicate push notifications on iOS (host tracks which device is "active" via WebSocket activity).
- **Do Not Disturb schedule**: set quiet hours per device. Host respects DND and queues non-critical notifications.
- **Notification priority levels**:
  - **Critical**: intervention needed, mission failed, host offline — always delivered.
  - **Informational**: mission completed, agent finished, budget milestone — respects DND.
  - **Digest**: batch low-priority events into periodic summary (configurable: hourly, daily).
- **Notification history**: scrollable list of past notifications in Settings.

#### W6: VPS Provider Integrations

Built-in integrations for provisioning always-on host machines with one click.

- **Hetzner**: API integration for server creation (region, size), management, and teardown. Supports ARM and x86.
- **DigitalOcean**: Droplet provisioning via API.
- **Generic SSH**: Connect any machine with SSH access — user provides host, port, key. ADE installs itself and configures as host.
- Provider setup in Settings > Devices > VPS Providers: add API key, select provider, region, and size.
- **One-click host provisioning**: "Create VPS Host" → provisions server → installs Node.js + ADE → runs headless → configures as host → auto-pairs with your devices.
- VPS management panel: start/stop/restart, resource monitoring (CPU, RAM, disk), uptime, estimated cost.
- VPS host runs ADE headlessly via `xvfb-run electron .` (from Phase 6 W4).
- Auto-reconnect: if VPS reboots, systemd restarts ADE, devices reconnect automatically.
- Available from both desktop Settings and iOS Settings.

#### W7: Mobile automations execution and digest

- Configure and monitor time-based and action-based automations from iOS.
- Show a structured run digest in Automations history:
  - Runs completed / failed
  - Execution type used (`agent-session`, `mission`, `built-in task`)
  - Interventions that need attention
  - Usage summary from Settings > Usage policy context
- Digest is a single scrollable card. Tap any section to open Automations history or the linked mission.
- Push notification when digest is ready: "Automations digest ready — 3 runs completed, 1 needs attention."
- Automation configuration remains available from desktop and iOS Settings/Automations surfaces.

#### W8: Computer-Use Artifact Viewing (iOS)

- **Screenshot gallery**: browse computer-use artifacts (screenshots, annotated captures) generated by agents. Organized by mission, lane, and timestamp.
- **Proof chain controller**: follow the sequence of screenshots an agent captured during a computer-use session. Swipe through the timeline.
- **Artifact detail**: tap a screenshot to see full resolution with pinch-to-zoom. View associated metadata (agent, mission step, timestamp, annotation).
- **Video frame scrubber**: for video-captured computer-use sessions, scrub through frames on the phone (frames fetched on demand from host, not pre-synced).

#### W9: Advanced Offline Resilience (iOS)

Phase 6 shipped basic offline state and command queuing. This workstream hardens it.

- **Optimistic UI**: when user takes an action offline (approve intervention, send chat message), the UI updates immediately with a "pending sync" indicator. On reconnect, the action replays and the indicator resolves.
- **Conflict resolution UI**: if an offline action conflicts with state that changed on the host while disconnected (e.g., user approved an intervention that was already auto-resolved), show a clear explanation and resolution options.
- **Offline data budget**: iOS devices track local database size. If approaching device storage limits, older data is evicted (tombstoned locally, re-fetched on demand from host).
- **Background sync**: when iOS app is backgrounded, periodic background fetch keeps state fresh (within iOS background execution limits — ~30 seconds per fetch window).
- **Reconnection UX**: on reconnect after extended offline period, show a catch-up summary ("12 new events since you were last connected") before dumping the user into the live state.

#### W10: iOS App Polish

- **Animations and transitions**: smooth navigation transitions, list animations, pull-to-refresh spring physics, swipe gestures for common actions (archive lane, dismiss notification, approve intervention).
- **Dark mode**: full dark mode support matching desktop ADE's visual language.
- **iPad support**: adaptive layout for iPad — sidebar navigation, split-view for chat + lane list, larger diff viewer, multi-column layouts.
- **Widget support**: iOS home screen widget showing host status (online/offline), active mission count, and latest intervention needing attention. Tap to open relevant screen.
- **Spotlight integration**: search missions, lanes, PRs, and agent chats from iOS Spotlight.
- **Haptic feedback**: confirmation haptics on message send, intervention approval, mission launch, and PR merge.
- **Performance**: lazy loading for all list views, image caching for agent-generated screenshots, SQLite query optimization for mobile (smaller page size, aggressive WAL checkpointing).

#### W11: Validation

**Missions tab:**
- Mission list displays all missions with correct status.
- Launch mission from phone → host executes → progress visible on phone in real-time.
- Intervention approval from phone → reflected on desktop and host.
- Mission history search returns correct results.

**CTO & Chat tab:**
- CTO chat: send message → response appears with code blocks and diffs.
- Worker chat: select worker → start conversation → host processes.
- Streaming tokens render in real-time.
- Org chart displays correct status for all agents.
- CTO daily summary renders timeline correctly.

**Remaining tabs:**
- Automations: enable/disable from phone → reflected on host.
- Graph: topology renders, nodes are tappable and navigate correctly.
- History: operations list matches desktop, filters work.
- Settings: all sections functional, changes sync to host.

**Push notifications:**
- APNs relay delivers notifications in all app states (foreground, background, terminated).
- Deep links navigate to correct screens.
- Cross-device suppression: using desktop → phone stays quiet.
- DND schedule respected.
- Notification history accurate.

**VPS provisioning:**
- Hetzner/DO: create → install → pair → verify agent execution → teardown.
- Generic SSH: configure → install → pair → verify.
- VPS reboot → ADE auto-restarts → devices auto-reconnect.

**Automations digest:**
- Schedule time-based automations and action-based automations → host executes → digest on phone.
- Interrupted runs show partial results with clear status and linked run records.

**Offline resilience:**
- Extended offline (hours) → reconnect → catch-up summary → queued actions replay.
- Offline conflict → clear resolution UI.
- Background fetch keeps state fresh.

**Polish:**
- Dark mode renders correctly across all screens.
- iPad layout uses space effectively.
- Widget displays current host status.
- Spotlight search returns relevant results.
- Haptics fire on all configured actions.

---

### Execution Order

#### Dependency Graph

```
W1 (Missions tab) ──────────────┐
W2 (CTO/Chat tab) ──────────────┤
W3 (Automations/Graph/History) ──┼──► W5 (push notifications) ──► W9 (offline resilience)
W4 (full Settings parity) ───────┘          │
                                            ▼
W6 (VPS providers) ◄── W4 (Settings parity)   W7 (mobile automations)
                                            │
W8 (computer-use artifacts)                 ▼
                                       W10 (polish)
                                            │
                                            ▼
                                       W11 (validation)
```

Key dependencies:
- W1-W4 are largely independent of each other (all read from already-synced cr-sqlite data) and can run in parallel.
- W5 (push notifications) depends on at least one tab being functional to have notification sources.
- W6 (VPS providers) depends on W4 (Settings UI for provider configuration).
- W7 (mobile automations) depends on W3 (Automations tab) and W5 (push for digest notifications).
- W8 (computer-use artifacts) is independent -- can run anytime after Phase 6.
- W9 (offline resilience) depends on W5 (notification queuing) and core tabs being functional.
- W10 (polish) depends on all tabs being feature-complete.
- W11 (validation) depends on everything.

#### Wave Groupings

**Wave 1: Remaining iOS Tabs (W1-W4) in Parallel -- ~3-4 weeks**

Four workstreams built in parallel. Each follows the same Phase 6 pattern: read from local cr-sqlite database (data already synced), render SwiftUI views, send commands to host. No sync layer changes needed. Missions and CTO/Chat are the highest-effort tabs (streaming tokens, inline diffs, intervention flows).

**Wave 2: Infrastructure (W5-W6) -- ~1-2 weeks**

Push notifications (APNs relay or FCM) and VPS provider integrations (Hetzner, DigitalOcean, generic SSH). These are backend-heavy workstreams that can run in parallel with late Wave 1 tab work.

**Wave 3: Advanced Features (W7-W9) -- ~1-2 weeks**

Mobile automations digest, computer-use artifact viewing, and advanced offline resilience (optimistic UI, conflict resolution, background sync hardening). These refine the experience built in Waves 1-2.

**Wave 4: Polish and Validation (W10-W11) -- ~1-2 weeks**

Animations, dark mode, iPad adaptive layout, widgets, Spotlight, haptics, and comprehensive cross-platform validation.

#### Rough Effort Estimates

| Wave | Workstreams | Duration | Risk |
|---|---|---|---|
| Wave 1 | W1-W4 | 3-4 weeks | Low (pattern proven in Phase 6, data already synced) |
| Wave 2 | W5-W6 | 1-2 weeks | Medium (APNs infrastructure, provider API integrations) |
| Wave 3 | W7-W9 | 1-2 weeks | Low (refinement work, well-scoped) |
| Wave 4 | W10-W11 | 1-2 weeks | Low (polish, validation) |

**Total: 6-8 weeks** (matches phase estimate). Phase 7 is lower risk than Phase 6 because the sync layer is complete and the iOS tab pattern is proven. The main effort is SwiftUI UI work.

---

### Exit criteria

1. iOS Missions tab provides full mission management: list, detail, launch, intervention approval, history, budget.
2. iOS CTO/Chat tab provides full agent chat: CTO, workers, ad-hoc sessions, streaming tokens, inline diffs, org chart.
3. iOS Automations tab allows viewing and toggling automation rules.
4. iOS Graph tab renders workspace topology with interactive overlays.
5. iOS History tab provides searchable operation history.
6. iOS Settings reaches desktop parity for devices, providers, notifications, general, context, and usage.
7. Push notifications reliably deliver across all app states with deep links.
8. Cross-device notification routing suppresses duplicates when desktop is active.
9. DND schedule works with priority-based notification levels.
10. VPS provider integration allows one-click host provisioning for at least two providers (Hetzner + Generic SSH).
11. iOS supports time-based and action-based automations with a structured run digest.
12. CTO daily summary viewable as a timeline on the phone.
13. Computer-use artifacts (screenshots, proof chains) browsable from the phone.
14. Offline actions use optimistic UI with pending indicators that resolve on reconnect.
15. iPad layout provides a meaningful improvement over phone layout.
16. iOS home screen widget shows host status and active mission count.
17. iOS app feels native — smooth animations, dark mode, haptic feedback, Spotlight integration.
