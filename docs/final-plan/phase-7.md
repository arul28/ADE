# Phase 7: Full iOS & Advanced Remote

## Phase 7 -- Full iOS & Advanced Remote (6-8 weeks)

Goal: Complete the iOS app by adding all remaining desktop tabs (Missions, CTO/Chat, Automations, Graph, History, Settings) and ship advanced multi-device features. Phase 6 proved the sync architecture and delivered project management from the phone — Phase 7 brings the full AI orchestration experience to mobile and adds VPS provider integrations, Night Shift, and advanced notification routing.

### Reference docs

- Phase 6 workstreams — cr-sqlite sync, WebSocket protocol, iOS app, device registry
- [architecture/AI_INTEGRATION.md](../architecture/AI_INTEGRATION.md) — orchestrator, agent runtimes, computer use
- [features/CTO.md](../features/CTO.md) — CTO state, daily logs, Linear sync, org chart
- [features/MISSIONS.md](../features/MISSIONS.md) — mission lifecycle, interventions, artifacts
- [features/CHAT.md](../features/CHAT.md) — agent chat sessions, providers

### Dependencies

- Phase 6 complete (multi-device sync, iOS Lanes/Files/Work/PRs tabs working end-to-end).

---

### Architecture Overview

Phase 7 does not introduce new sync infrastructure. All 103 tables already sync to iOS from Phase 6 — the data is on the device. Phase 7 is pure feature work:

1. **Remaining iOS tabs** — Missions, CTO/Chat, Automations, Graph, History, full Settings. Each tab reads from the already-synced local SQLite database and sends commands to the brain via the existing WebSocket protocol.
2. **VPS provider integrations** — one-click brain provisioning on Hetzner, DigitalOcean, or any SSH-accessible machine.
3. **Advanced remote workflows** — Night Shift mobile briefings, push notifications for AI events, computer-use artifact viewing, and cross-device notification routing.
4. **iOS polish** — animations, dark mode, iPad support, widgets, Spotlight integration.

Because the sync layer is complete from Phase 6, adding each new iOS tab follows a consistent pattern:
- Read state from local cr-sqlite database (already synced)
- Render SwiftUI views
- Send commands to brain via WebSocket for execution operations
- Zero sync layer changes required

---

### Workstreams

#### W1: iOS Missions Tab

High-parity SwiftUI implementation of the desktop Missions page.

- **Mission list**: all missions with status indicators (planning, running, paused, completed, failed), assigned agent, phase progress.
- **Mission detail view**: phase progress visualization, step list with per-step status, worker assignment, budget utilization bar, timeline of events.
- **Launch new missions**: text input → command routes to brain → brain plans and executes. Phone shows planning progress in real-time via cr-sqlite sync.
- **Intervention handling**: view intervention details → approve/reject with optional comment. This is the primary mobile use case for the Missions tab — fast approval from anywhere.
- **Mission history**: searchable archive of past missions with outcome, duration, budget spent.
- **Budget overview**: per-mission and aggregate spend. Budget threshold warnings.

#### W2: iOS CTO & Agent Chat Tab

Combined CTO management and agent chat interface for iOS.

- **CTO chat**: full CTO conversation interface. Send messages, view responses with code blocks and diffs. CTO identity and memory context preserved on brain — phone is just the UI.
- **Worker agent chat**: select any worker from the org chart → start or continue a conversation.
- **Ad-hoc agent chat**: start a new chat session with any configured provider/model. Brain spawns the agent, phone is the interface.
- **Org chart view**: CTO + workers, their status (idle/running/paused), current assignment, budget utilization.
- **Streaming token display**: real-time character-by-character rendering of agent responses via WebSocket.
- **Inline code blocks**: syntax highlighting for all major languages in agent responses. Copy-to-clipboard.
- **Inline diff viewer**: syntax-highlighted unified diffs embedded in chat messages. Tap to expand.
- **Chat session management**: archive, rename, pin sessions. Session search.
- **CTO daily summary**: the CTO's daily log rendered as a timeline view. Shows decisions, dispatched work, Linear issue handling, and memory updates from the past 24 hours.

#### W3: iOS Automations, Graph & History Tabs

Remaining desktop tabs brought to iOS.

**Automations tab:**
- Automation rule list with status (enabled/disabled), trigger type, last run.
- Automation detail: trigger config, action config, run history.
- Enable/disable automations from phone.
- View automation run results.

**Graph tab:**
- Workspace topology visualization adapted for mobile (simplified layout, tap to zoom).
- Risk, activity, sync, and PR overlays as toggleable layers.
- Node tap → navigate to lane/PR/mission detail.

**History tab:**
- Operation history list with filters (by type, by lane, date range).
- Operation detail view.
- Search across operations.

#### W4: iOS Full Settings Tab

Complete Settings implementation for iOS (Phase 6 shipped minimal connection settings only).

- **Devices**: full device management — add, remove, configure, transfer brain. Same as desktop Settings > Devices.
- **AI Providers**: view configured providers. Add/edit API keys (stored in iOS Keychain, synced as encrypted blobs or entered per-device).
- **Notifications**: per-event-type toggles, DND schedule, notification priority levels.
- **General**: appearance (dark mode), behavior preferences.
- **Context & Docs**: view context docs status, trigger regeneration (routes to brain).
- **Usage & Budget**: usage overview, budget caps, pacing status.

#### W5: Push Notifications & Notification Routing

- Brain sends notification events to iOS peers over WebSocket. iOS app uses local notifications when in foreground.
- **APNs relay** for notifications when app is backgrounded or terminated:
  - Option A: Self-hosted — tiny Node.js relay on brain or VPS, forwards directly to APNs.
  - Option B: Firebase Cloud Messaging — free tier, handles APNs delivery.
  - Option C: No push — phone relies on background refresh and manual checks.
- **Notification events**:
  - Mission completed / failed
  - Intervention needed (approve/reject) — **highest priority**
  - Agent error requiring attention
  - Budget threshold reached
  - Brain status change (went offline, transferred)
  - Night Shift morning briefing ready
- Notification tap → deep link to relevant screen (mission detail, intervention, chat).
- **Cross-device notification routing**: if the user is actively using ADE on their Mac, suppress duplicate push notifications on iOS (brain tracks which device is "active" via WebSocket activity).
- **Do Not Disturb schedule**: set quiet hours per device. Brain respects DND and queues non-critical notifications.
- **Notification priority levels**:
  - **Critical**: intervention needed, mission failed, brain offline — always delivered.
  - **Informational**: mission completed, agent finished, budget milestone — respects DND.
  - **Digest**: batch low-priority events into periodic summary (configurable: hourly, daily).
- **Notification history**: scrollable list of past notifications in Settings.

#### W6: VPS Provider Integrations

Built-in integrations for provisioning always-on brain machines with one click.

- **Hetzner**: API integration for server creation (region, size), management, and teardown. Supports ARM and x86.
- **DigitalOcean**: Droplet provisioning via API.
- **Generic SSH**: Connect any machine with SSH access — user provides host, port, key. ADE installs itself and configures as brain.
- Provider setup in Settings > Devices > VPS Providers: add API key, select provider, region, and size.
- **One-click brain provisioning**: "Create VPS Brain" → provisions server → installs Node.js + ADE → runs headless → configures as brain → auto-pairs with your devices.
- VPS management panel: start/stop/restart, resource monitoring (CPU, RAM, disk), uptime, estimated cost.
- VPS brain runs ADE headlessly via `xvfb-run electron .` (from Phase 6 W4).
- Auto-reconnect: if VPS reboots, systemd restarts ADE, devices reconnect automatically.
- Available from both desktop Settings and iOS Settings.

#### W7: Night Shift & Mobile Briefings

- **Night Shift**: schedule agent work to run overnight on the brain. Define a list of missions or tasks to execute during a time window (e.g., 11pm-6am). Brain runs them sequentially. Results are ready in the morning.
- **Morning briefing (iOS)**: on first app open after Night Shift completes, show a structured summary:
  - Missions completed / failed
  - Key changes per lane (diffstat, file summary)
  - Interventions that need attention
  - Budget consumed
  - CTO recommendations for the day
- Morning briefing is a single scrollable card — not a chat conversation. Tap any section to dive into the detail view.
- Push notification when Night Shift completes: "Night Shift finished — 3 missions completed, 1 needs attention."
- Night Shift configuration available from both desktop and iOS Settings.

#### W8: Computer-Use Artifact Viewing (iOS)

- **Screenshot gallery**: browse computer-use artifacts (screenshots, annotated captures) generated by agents. Organized by mission, lane, and timestamp.
- **Proof chain viewer**: follow the sequence of screenshots an agent captured during a computer-use session. Swipe through the timeline.
- **Artifact detail**: tap a screenshot to see full resolution with pinch-to-zoom. View associated metadata (agent, mission step, timestamp, annotation).
- **Video frame scrubber**: for video-captured computer-use sessions, scrub through frames on the phone (frames fetched on demand from brain, not pre-synced).

#### W9: Advanced Offline Resilience (iOS)

Phase 6 shipped basic offline state and command queuing. This workstream hardens it.

- **Optimistic UI**: when user takes an action offline (approve intervention, send chat message), the UI updates immediately with a "pending sync" indicator. On reconnect, the action replays and the indicator resolves.
- **Conflict resolution UI**: if an offline action conflicts with state that changed on the brain while disconnected (e.g., user approved an intervention that was already auto-resolved), show a clear explanation and resolution options.
- **Offline data budget**: iOS devices track local database size. If approaching device storage limits, older data is evicted (tombstoned locally, re-fetched on demand from brain).
- **Background sync**: when iOS app is backgrounded, periodic background fetch keeps state fresh (within iOS background execution limits — ~30 seconds per fetch window).
- **Reconnection UX**: on reconnect after extended offline period, show a catch-up summary ("12 new events since you were last connected") before dumping the user into the live state.

#### W10: iOS App Polish

- **Animations and transitions**: smooth navigation transitions, list animations, pull-to-refresh spring physics, swipe gestures for common actions (archive lane, dismiss notification, approve intervention).
- **Dark mode**: full dark mode support matching desktop ADE's visual language.
- **iPad support**: adaptive layout for iPad — sidebar navigation, split-view for chat + lane list, larger diff viewer, multi-column layouts.
- **Widget support**: iOS home screen widget showing brain status (online/offline), active mission count, and latest intervention needing attention. Tap to open relevant screen.
- **Spotlight integration**: search missions, lanes, PRs, and agent chats from iOS Spotlight.
- **Haptic feedback**: confirmation haptics on message send, intervention approval, mission launch, and PR merge.
- **Performance**: lazy loading for all list views, image caching for agent-generated screenshots, SQLite query optimization for mobile (smaller page size, aggressive WAL checkpointing).

#### W11: Validation

**Missions tab:**
- Mission list displays all missions with correct status.
- Launch mission from phone → brain executes → progress visible on phone in real-time.
- Intervention approval from phone → reflected on desktop and brain.
- Mission history search returns correct results.

**CTO & Chat tab:**
- CTO chat: send message → response appears with code blocks and diffs.
- Worker chat: select worker → start conversation → brain processes.
- Streaming tokens render in real-time.
- Org chart displays correct status for all agents.
- CTO daily summary renders timeline correctly.

**Remaining tabs:**
- Automations: enable/disable from phone → reflected on brain.
- Graph: topology renders, nodes are tappable and navigate correctly.
- History: operations list matches desktop, filters work.
- Settings: all sections functional, changes sync to brain.

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

**Night Shift:**
- Schedule missions → brain executes overnight → morning briefing on phone.
- Night Shift interrupted → partial results shown with clear status.

**Offline resilience:**
- Extended offline (hours) → reconnect → catch-up summary → queued actions replay.
- Offline conflict → clear resolution UI.
- Background fetch keeps state fresh.

**Polish:**
- Dark mode renders correctly across all screens.
- iPad layout uses space effectively.
- Widget displays current brain status.
- Spotlight search returns relevant results.
- Haptics fire on all configured actions.

---

### Exit criteria

1. iOS Missions tab provides full mission management: list, detail, launch, intervention approval, history, budget.
2. iOS CTO/Chat tab provides full agent chat: CTO, workers, ad-hoc sessions, streaming tokens, inline diffs, org chart.
3. iOS Automations tab allows viewing and toggling automation rules.
4. iOS Graph tab renders workspace topology with interactive overlays.
5. iOS History tab provides searchable operation history.
6. iOS Settings tab covers devices, providers, notifications, general, context, and usage.
7. Push notifications reliably deliver across all app states with deep links.
8. Cross-device notification routing suppresses duplicates when desktop is active.
9. DND schedule works with priority-based notification levels.
10. VPS provider integration allows one-click brain provisioning for at least two providers (Hetzner + Generic SSH).
11. Night Shift allows scheduling overnight work with a structured morning briefing on iOS.
12. CTO daily summary viewable as a timeline on the phone.
13. Computer-use artifacts (screenshots, proof chains) browsable from the phone.
14. Offline actions use optimistic UI with pending indicators that resolve on reconnect.
15. iPad layout provides a meaningful improvement over phone layout.
16. iOS home screen widget shows brain status and active mission count.
17. iOS app feels native — smooth animations, dark mode, haptic feedback, Spotlight integration.
