# W-UX: CTO + Org Experience Overhaul
> Source: [OpenClaw SOUL.md](https://github.com/nichochar/openclaw/tree/main/src/openclaw) — agent identity and personality pattern. [Paperclip §7 Runtime Context](https://github.com/paperclipai/paperclip/blob/main/doc/SPEC.md) — fat/thin context delivery for different activation modes. [Symphony §8](https://github.com/openai/symphony/blob/main/SPEC.md) — agent-driven tracker writes, workpad pattern.

Dependencies: **W1-W4** (shipped). Can run in parallel with W6½. No dependency on embeddings.

W1-W4 shipped the CTO agent, worker org chart, heartbeat system, and Linear sync. The remaining W-UX follow-through is now complete: the CTO shell, onboarding/setup path, Linear connection flow, worker visibility surfaces, memory browser, and cross-surface theming have all been finished and validated in the app.

##### Audit Snapshot (2026-03-12)

- Implemented in code today: `CtoPage.tsx`, `TeamPanel.tsx`, `LinearSyncPanel.tsx`, `CtoSettingsPanel.tsx`, and file-backed CTO/worker state via `ctoStateService.ts`.
- Implemented in code today: `OnboardingWizard.tsx` and onboarding state handling in the CTO shell.
- Identity/config persistence already follows the file-as-truth model for the current CTO/worker state files.
- Completed in the 2026-03-12 closure pass: polished onboarding/setup flow, guided Linear connection panel, richer worker activity visibility, unified memory browsing, and the broader visual/theming consistency pass.

##### CTO Initialization & Onboarding

The CTO onboarding flow is now a complete first-run experience with resilient loading, guided setup, repo scanning/bootstrap, and integration handoff into the broader CTO surface.

- **First-run detection**: Use the persisted CTO onboarding state to show onboarding instead of dropping users directly into the full CTO surface when setup is incomplete.

- **Onboarding wizard** (3 steps, skippable):
  1. **Identity Setup**: Name the CTO (default: "CTO"), choose personality preset (Professional / Casual / Minimal), set primary model. Preview card shows how the CTO will introduce itself.
  2. **Project Context**: Auto-detect project type from `package.json`/`Cargo.toml`/`go.mod`/etc. Offer to bootstrap project memory (creates Tier 1 entries for project stack, structure, key patterns). Show progress while context is being assembled.
  3. **Integrations**: Connect Linear (guided OAuth or token paste with validation), configure automations (on/off with simple presets: "Auto-dispatch bugs"), connect OpenClaw (if installed).

- **Skip behavior**: User can skip any step. CTO activates with defaults. A "Complete Setup" banner persists in the CTO tab until all steps are done or explicitly dismissed.

- **Re-run**: Settings > CTO > "Re-run Setup Wizard" button for reconfiguration.

- **Implementation detail**: Onboarding state is persisted with the CTO identity, and the wizard now completes the scan/bootstrap and integration connection path rather than stopping at scaffolding.

##### Identity System

Inspired by [OpenClaw's SOUL.md](https://github.com/nichochar/openclaw/tree/main/src/openclaw), but structured as YAML for machine readability and stored in `.ade/cto/identity.yaml`.

- **Identity schema**:
  ```typescript
  interface AgentIdentity {
    name: string;                    // "CTO", "Backend Lead", etc.
    personality: "professional" | "casual" | "minimal" | "custom";
    customPersonality?: string;      // free-text if personality === "custom"
    role: string;                    // "Chief Technology Officer" — display role
    capabilities: string[];          // ["architecture", "code-review", "planning", "debugging"]
    constraints: string[];           // ["never deploy without tests", "always use TypeScript"]
    communicationStyle: {
      verbosity: "concise" | "detailed" | "adaptive";
      proactivity: "reactive" | "balanced" | "proactive";
      escalationThreshold: "low" | "medium" | "high"; // when to ask user vs decide
    };
    model: string;                   // preferred model ID
    fallbackModel?: string;          // fallback if primary unavailable
    systemPromptExtension?: string;  // appended to base system prompt
  }
  ```

- **Identity ↔ system prompt**: On CTO/worker activation, `identityToSystemPrompt(identity)` converts the identity into a system prompt prefix. This replaces the current hardcoded CTO prompt with a configurable one.

- **Identity editor**: Settings > CTO > Identity panel. Form-based editor for all fields. "Preview Prompt" button shows the assembled system prompt. Changes saved to `.ade/cto/identity.yaml` and to the `agents` table.

- **Worker identities**: Each worker in `.ade/agents/<name>/identity.yaml` has the same schema. Workers inherit unset fields from the CTO identity (cascade pattern). Worker identity editor accessible from the Team panel.

- **"File as truth" principle** (from OpenClaw): If `identity.yaml` exists on disk, it is the source of truth — DB is synced from file on startup. If the file is edited externally (e.g., in a text editor or by another agent), ADE picks up the changes on next activation. This enables version-controlled identity configuration.

##### Memory Inspector Improvements

The current memory inspector is functional but hard to use for understanding what the system knows and why.

- **Unified memory browser**: Single pane replacing separate memory views. Left sidebar: scope selector (Project / CTO / Workers / Mission). Main area: entry list with inline expand. Top bar: search with scope/category/tier filters.

- **Entry detail view**: Click an entry → slide-out panel showing:
  - Full content (syntax-highlighted if code/JSON)
  - Metadata: tier, category, confidence, importance, observationCount, source
  - History: when created, last accessed, confidence changes over time
  - Related entries (lexical similarity, later: semantic similarity from W7a)
  - Actions: pin/unpin, promote/archive, edit content, delete

- **Scope health cards**: At the top of each scope view, cards showing:
  - Entry count vs hard limit (progress bar)
  - Tier distribution (Tier 1 / Tier 2 / Tier 3 / Archived)
  - Last sweep and consolidation timestamps
  - Quick actions: "Run Sweep", "Run Consolidation"

- **Search improvements**: Search results show relevance score, matching text highlighted, filter by date range, sort by score/recency/importance.

##### Linear Connection UX

The Linear connection flow is now guided, validated, and recoverable, with OAuth plus manual token fallback, project discovery, status indicators, and clear reconnect/retry states.

- **Connection flow**:
  1. Settings > Integrations > Linear: "Connect Linear" button.
  2. Two options: OAuth flow (redirect to Linear, get token automatically) or manual token paste.
  3. On token entry: immediate validation — call Linear API to verify token, show org name and available projects.
  4. Project selector: multi-select from discovered projects. Each project shows team, issue count, and current sync status.
  5. Per-project config: default worker assignment, auto-dispatch rules (which labels/priorities to auto-dispatch), concurrency limits.

- **Connection status indicator**: In the CTO tab header and Linear sync panel:
  - Green dot + "Connected" when token valid and sync running.
  - Yellow dot + "Sync paused" when paused by user or rate limited.
  - Red dot + "Disconnected" when token invalid or API unreachable.
  - Last sync timestamp and next scheduled sync.

- **CTO ↔ Automations Linear boundary**: Clear UI separation:
  - **CTO tab > Linear panel**: Shows what CTO is working on from Linear. Issues assigned, in-progress missions, completed items. CTO-initiated actions (dispatch, comment, status update).
  - **Automations tab > workflow rules**: Shows local, GitHub, and generic webhook rules plus Linear post-actions. Automations can post to Linear, but do not own Linear issue intake or routing.
  - **Shared state**: Both surfaces read from shared project state, but CTO owns Linear intake/routing while Automations owns programmable non-Linear triggers and follow-up actions.

- **Error recovery**: If Linear API returns 401 (token revoked), show a banner: "Linear connection lost — [Reconnect]". If rate limited, show remaining cooldown. If webhook delivery fails, show retry count and manual retry button.

##### Theming Consistency

The CTO, Automations, Memory, and Worker Management surfaces were built in separate workstreams and have inconsistent visual treatment.

- **Design tokens**: Establish a shared set of design tokens for the "agent system" surfaces:
  - Status colors: active (green), paused (yellow), failed (red), idle (gray), completing (blue)
  - Agent badges: consistent avatar style (initials in colored circle), role label typography
  - Card styles: consistent padding, border radius, shadow, and hover states across all agent-related cards
  - Timeline styles: consistent event rendering across Mission logs, CTO activity, and worker runs

- **Component library alignment**: Audit all agent-system components and align:
  - Status badges: one `AgentStatusBadge` component used everywhere (CTO tab, Team panel, Automations, Mission logs)
  - Memory entry cards: one `MemoryEntryCard` component used in Memory inspector, CTO memory panel, Mission artifacts
  - Timeline entries: one `TimelineEntry` component used in Mission logs, CTO activity feed, worker run history
  - Configuration forms: consistent form layout, label alignment, and validation UX across CTO settings, worker settings, automation rules, and Linear config

- **Dark mode audit**: Verify all agent-system surfaces render correctly in dark mode. Fix contrast issues, missing dark-mode variables, and hard-coded colors.

##### Worker Visibility & Management

Workers are currently created and managed from scattered locations. This workstream consolidates worker management into a discoverable, consistent experience.

- **Team panel redesign**: CTO tab > Team panel becomes the primary worker management surface:
  - Worker list with avatar, name, role, status (active/idle/paused), last activation, current task
  - Quick actions: pause, resume, configure, view memory, view runs
  - "Add Worker" button with a template selector (Backend Dev, Frontend Dev, QA, Custom)
  - Drag-to-reorder for org chart hierarchy
  - Worker detail slide-out: identity editor, memory browser, run history, budget usage

- **Worker creation wizard**: "Add Worker" opens a 2-step wizard:
  1. **Template**: Choose from preset templates or start blank. Templates pre-fill identity, capabilities, adapter, and heartbeat config.
  2. **Configure**: Review and adjust identity fields, set adapter (claude-local, codex-local, etc.), set heartbeat interval, set monthly budget.

- **Worker activity feed**: Each worker has an activity timeline showing:
  - Heartbeat activations (with reason: scheduled, wake-on-demand, mission)
  - Mission participation (which missions, which steps, outcomes)
  - Memory writes (what the worker learned)
  - Budget consumption (daily/weekly bars)

- **Fat/thin context delivery** (from [Paperclip](https://github.com/paperclipai/paperclip/blob/main/doc/SPEC.md)):
  | Activation Mode | Context Level | What's Injected |
  |-----------------|---------------|-----------------|
  | Mission worker | Fat (L0+L1+L2+mission) | Full project context + phase context + agent memory + mission state |
  | Heartbeat check | Thin (L0 only) | Pinned project conventions only — minimize token cost for routine checks |
  | Wake-on-demand | Standard (L0+L1) | Pinned context + relevant project memory for the demand topic |
  | CTO activation | Deep (L0+L1+L2) | Full project context + CTO memory + relevant agent summaries |

##### Service Architecture

W-UX functionality is distributed across existing Phase 4 services rather than standalone service files:

```
ctoStateService.ts            — CTO identity, onboarding state (completedSteps, first-run gating), project scan, identity YAML read/write, file-as-truth sync, prompt assembly
linearOAuthService.ts         — OAuth flow (redirect + callback)
linearCredentialService.ts    — Token storage, validation, connection status
linearSyncService.ts          — Sync loop, project discovery, dashboard state
workerAgentService.ts         — Worker CRUD, template system, agent lifecycle
shared/designTokens.ts        — Shared design token definitions (renderer)
```

Services instantiated in `main.ts`. `ctoStateService` gates CTO activation on first run via persisted onboarding state and loads identity from `.ade/cto/identity.yaml` on startup. Linear connection UX wraps `linearOAuthService` + `linearCredentialService` + `linearSyncService`.

##### IPC Channels

All CTO/worker/Linear channels use the `ade.cto.*` namespace in `ipc.ts`:

| Channel | Direction | Purpose |
|---------|-----------|---------|
| `ade.cto.getOnboardingState` | renderer → main | Get onboarding progress |
| `ade.cto.completeOnboardingStep` | renderer → main | Mark an onboarding step complete |
| `ade.cto.dismissOnboarding` | renderer → main | Dismiss the onboarding banner |
| `ade.cto.resetOnboarding` | renderer → main | Re-run setup wizard from settings |
| `ade.cto.runProjectScan` | renderer → main | Bootstrap project memory from repo scan |
| `ade.cto.getState` | renderer → main | Load CTO identity and full state |
| `ade.cto.updateIdentity` | renderer → main | Save CTO identity changes |
| `ade.cto.previewSystemPrompt` | renderer → main | Preview assembled system prompt |
| `ade.cto.saveAgent` | renderer → main | Create or update a worker agent |
| `ade.cto.listAgents` | renderer → main | List all workers in the org chart |
| `ade.cto.listAgentRuns` | renderer → main | Fetch worker run history / activity |
| `ade.cto.setLinearToken` | renderer → main | Store Linear API token |
| `ade.cto.startLinearOAuth` | renderer → main | Begin OAuth redirect flow |
| `ade.cto.getLinearConnectionStatus` | renderer → main | Connection health + sync state |
| `ade.cto.getLinearProjects` | renderer → main | List available Linear projects |

##### Renderer Components

```
CtoPage.tsx                   — Consolidated CTO shell with onboarding, team, memory, Linear, and settings tabs
OnboardingWizard.tsx          — Multi-step onboarding modal
OnboardingBanner.tsx          — Persistent setup reminder / resume surface
IdentityEditor.tsx            — Form-based identity editor (shared between CTO and workers)
LinearConnectionPanel.tsx     — Guided Linear connection flow (OAuth + manual token + validation)
LinearSyncPanel.tsx           — Linear sync controls, status, and routing configuration
CtoMemoryBrowser.tsx          — Memory inspection with procedures, skills, sync, and raw-memory tabs
CtoSettingsPanel.tsx          — CTO configuration surface
WorkerCreationWizard.tsx      — Template-based worker creation
WorkerDetailSlideOut.tsx      — Worker detail slide-out with tabs
WorkerActivityFeed.tsx        — Merged heartbeat/session activity timeline per worker
TeamPanel.tsx                 — Consolidated worker management surface
AgentSidebar.tsx              — Agent list sidebar navigation
OpenclawConnectionPanel.tsx   — OpenClaw bridge connection and status

shared/AgentStatusBadge.tsx   — Unified status badge used across CTO, Team, Automations
shared/MemoryEntryCard.tsx    — Shared memory entry card for memory browser and CTO memory
shared/TimelineEntry.tsx      — Shared timeline event component for activity feeds and logs
shared/ConnectionStatusDot.tsx— Connection health dot indicator
shared/StepWizard.tsx         — Shared multi-step wizard scaffold (used by onboarding and worker creation)
shared/designTokens.ts        — Agent-system design tokens (status colors, card styles, typography)
```

**Implementation status (2026-03-12):** ✅ Complete. The onboarding flow, guided Linear setup, worker activity visibility, unified memory browsing, and theming/component consistency pass are all shipped.

**Tests:**
- CTO onboarding: first-run detection shows wizard, completed steps persisted, skip behavior activates CTO with defaults, re-run from settings resets onboarding state.
- Identity system: identity.yaml round-trip (write → read → identical), file-as-truth sync (external edit detected on startup), identity-to-prompt conversion produces valid system prompt, worker identity inherits unset fields from CTO.
- Identity editor: form renders with current values, save writes to file and DB, preview shows assembled prompt, validation rejects empty name.
- Linear connection: token validation calls API and shows org name, invalid token shows error, project discovery lists available projects, connection status indicator reflects API health.
- Linear boundary: CTO panel shows assigned issues, Automations panel shows trigger rules, no conflicting writes to sync state.
- Theming: AgentStatusBadge renders correct colors for each status, dark mode renders without contrast issues, design tokens apply consistently.
- Worker management: worker list renders with correct status, quick actions (pause/resume) update state, "Add Worker" opens creation wizard, template pre-fills identity fields.
- Worker creation: template selector shows available templates, configure step allows field edits, created worker appears in team panel.
- Fat/thin context: mission worker receives fat context (L0+L1+L2+mission), heartbeat receives thin context (L0 only), wake-on-demand receives standard context (L0+L1).
- Worker activity feed: heartbeat activations appear in feed, mission participation shows correct outcomes, memory writes listed with content preview.
- Project scan: repo scan detects project type, creates Tier 1 project memory entries, progress indicator updates during scan.
