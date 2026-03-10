# W-UX: CTO + Org Experience Overhaul — Implementation Plan

## Context

W1-W4 shipped the CTO agent, worker org chart, heartbeat system, and Linear sync — but with significant UX gaps. The CTO works without any setup (should require initialization), there's no identity configuration beyond basic name/persona, the Linear connection flow is confusing, theming is inconsistent across CTO/Automations/Memory surfaces, and worker management is scattered. This workstream addresses all UX gaps to make the CTO system feel intentional and polished.

**Parallel work note**: User is working on W7b and another item in separate lanes. We must NOT touch orchestrator, mission, or lane files.

---

## Design Direction (frontend-design)

**Aesthetic**: Industrial-utilitarian command center. The CTO system manages agents — the UI should feel like a mission control dashboard. Sharp edges (border-radius: 0 is already the convention), dense information display, JetBrains Mono for data, Space Grotesk for headings. The existing design language is already strong — we extend it, not fight it.

**Key visual choices**:
- Onboarding wizard: Full-height overlay with left progress rail + right content area, dark translucent backdrop
- Status indicators: Pulsing dot animations for active states, not just static colors
- Worker cards: Dense info cards with subtle gradient borders on hover
- Identity editor: Split view — form left, live prompt preview right
- Memory browser: Three-column layout (scope rail | entry list | detail panel)

---

## Phase 1: Foundation — Types, Tokens, IPC

### 1.1 Extended Types

**`apps/desktop/src/shared/types/cto.ts`** — Add:
```ts
CtoOnboardingState { completedSteps: string[], dismissedAt?: string, completedAt?: string }
CtoSystemPromptPreview { prompt: string, tokenEstimate: number }
```

Extend `CtoIdentity` with optional fields: `personality`, `communicationStyle`, `constraints: string[]`, `systemPromptExtension`, `onboardingState`

**`apps/desktop/src/shared/types/agents.ts`** — Add optional fields to `AgentIdentity`: `personality`, `communicationStyle`, `constraints: string[]`, `systemPromptExtension`

Add worker template type:
```ts
WorkerTemplate { id: string, name: string, role: AgentRole, title: string, capabilities: string[], description: string }
```

### 1.2 Design Token Consolidation

**`apps/desktop/src/renderer/components/cto/shared/designTokens.ts`** — NEW

Extract duplicated class patterns from TeamPanel, CtoSettingsPanel, LinearSyncPanel:
- `inputCls`, `selectCls`, `labelCls`, `textareaCls`, `cardCls`
- `agentStatusMap` — status → {color, label, dotClass} mapping
- `WORKER_TEMPLATES` — static template presets (Backend Engineer, QA Tester, DevOps, Researcher, Custom)

### 1.3 New IPC Channels

**`apps/desktop/src/shared/ipc.ts`** — Add 6 channels:
- `ctoGetOnboardingState: "ade.cto.getOnboardingState"`
- `ctoCompleteOnboardingStep: "ade.cto.completeOnboardingStep"`
- `ctoDismissOnboarding: "ade.cto.dismissOnboarding"`
- `ctoResetOnboarding: "ade.cto.resetOnboarding"`
- `ctoPreviewSystemPrompt: "ade.cto.previewSystemPrompt"`
- `ctoGetLinearProjects: "ade.cto.getLinearProjects"`

**`apps/desktop/src/preload/preload.ts`** — Add 6 methods to `cto` namespace (follow pattern at existing cto methods)

---

## Phase 2: Service Layer (Main Process)

### 2.1 Onboarding State Management

**`apps/desktop/src/main/services/cto/ctoStateService.ts`** — Extend with:
- `getOnboardingState()` — read from `cto_identity_state` payload JSON (onboardingState field), default `{ completedSteps: [] }`
- `completeOnboardingStep(stepId)` — append to completedSteps, persist
- `dismissOnboarding()` — set dismissedAt timestamp
- `resetOnboarding()` — clear completedSteps and dismissedAt

First-run detection: `completedSteps.length === 0 && !dismissedAt`

### 2.2 System Prompt Preview

**`apps/desktop/src/main/services/cto/ctoStateService.ts`** — Add:
- `previewSystemPrompt()` — reads current identity, assembles prompt from persona + personality + communicationStyle + constraints + systemPromptExtension. Returns `{ prompt, tokenEstimate: Math.ceil(prompt.length / 4) }`

### 2.3 Linear Project Discovery

**`apps/desktop/src/main/services/cto/linearSyncService.ts`** — Add or use existing Linear client to:
- `listLinearProjects()` — call Linear GraphQL API, return `{ id, name, slug, teamName }[]`

### 2.4 IPC Handler Registration

**`apps/desktop/src/main/services/ipc/registerIpc.ts`** — Register handlers for 6 new channels. Follow existing pattern (e.g., lines 4296-4489). Each handler calls the corresponding service method.

---

## Phase 3: Shared UI Components

All in `apps/desktop/src/renderer/components/cto/shared/`:

### 3.1 `AgentStatusBadge.tsx` — NEW
Replaces duplicated status dot/chip logic in AgentSidebar + TeamPanel.
Props: `{ status: AgentStatus, size?: "sm" | "md", pulse?: boolean }`
- Renders colored dot + uppercase label using Chip
- Pulse animation on "running" status via CSS `animate-pulse`

### 3.2 `MemoryEntryCard.tsx` — NEW
Reusable memory entry display card.
Props: `{ entry: MemoryEntry, compact?, onPin?, onArchive?, onPromote?, onDelete?, onClick? }`
- Shows category badge, content preview (2-line clamp), tier indicator, confidence bar
- Hover: shows quick actions

### 3.3 `TimelineEntry.tsx` — NEW
Reusable event row for activity feeds.
Props: `{ timestamp, title, subtitle?, status?, statusVariant?, icon?, children? }`
- Timestamp left, content right, optional expandable children
- Replaces duplicated patterns in WorkerDetailPanel sessions/runs and CtoSettingsPanel session logs

### 3.4 `StepWizard.tsx` — NEW
Multi-step wizard shell (reused by onboarding + worker creation).
Props: `{ steps: {id, label, icon, completed?}[], activeStep, onStepChange?, children, onComplete?, onSkip? }`
- Left rail with step indicators (vertical, numbered circles with connecting lines)
- Right content area for active step
- Bottom bar: Back/Next/Skip/Complete buttons

### 3.5 `ConnectionStatusDot.tsx` — NEW
Tiny pulsing status indicator.
Props: `{ status: "connected" | "degraded" | "disconnected", label?: string }`
- Green = connected, Yellow = degraded, Red = disconnected
- Optional label text next to dot

---

## Phase 4: Feature Components

### 4.1 CTO Onboarding Wizard

**`apps/desktop/src/renderer/components/cto/OnboardingWizard.tsx`** — NEW

Full-overlay wizard using `StepWizard`. Three steps:

**Step 1 — Identity Setup**: Name input, persona textarea, personality preset selector (Professional/Casual/Technical/Custom), model selector. Preview card showing how CTO will introduce itself.

**Step 2 — Project Context**: Auto-detect project type (show detected frameworks/languages). Project summary textarea. Key conventions chip input. Active focus areas. Progress indicator during optional repo scan (calls existing `ctoUpdateCoreMemory`).

**Step 3 — Integrations**: Linear token paste with inline validation (calls `ctoSetLinearToken` then `ctoGetLinearConnectionStatus`). Project discovery list (calls `ctoGetLinearProjects`). Show existing GitHub connection status (read-only).

Each step completion calls `ctoCompleteOnboardingStep`. Skip calls `ctoDismissOnboarding`.

### 4.2 Onboarding Banner

**`apps/desktop/src/renderer/components/cto/OnboardingBanner.tsx`** — NEW

Dismissible banner below CtoPage tab bar when onboarding was skipped. Accent-bordered strip with "Complete your CTO setup" message and "Continue Setup" button.

### 4.3 Enhanced Identity Editor

**`apps/desktop/src/renderer/components/cto/IdentityEditor.tsx`** — NEW

Replaces inline identity editing in CtoSettingsPanel. Two-column layout:
- **Left**: Form with all identity fields (name, persona, personality preset, communicationStyle {verbosity, proactivity, escalationThreshold}, constraints tag list, model preferences, systemPromptExtension textarea)
- **Right**: Live prompt preview panel showing assembled system prompt (calls `ctoPreviewSystemPrompt` on change with debounce). Shows token estimate.

Shared between CTO and workers (via `agentId` prop — null = CTO, string = worker).

### 4.4 CTO Memory Browser

**`apps/desktop/src/renderer/components/cto/CtoMemoryBrowser.tsx`** — NEW

Replaces the memory tab content. Three-column layout:
- **Left rail**: Scope selector (Project/CTO/Workers/Mission) with health cards showing entry count/limit, tier distribution bars
- **Center**: Entry list with search bar (supports scope/category/tier filters), sort by relevance/recency/importance. Each entry uses `MemoryEntryCard`
- **Right panel**: Entry detail slide-out with full content (syntax highlighted), metadata table, history, actions (pin/unpin, promote, archive, edit, delete)

Quick actions in scope cards: "Run Sweep", "Run Consolidation" (calls existing IPC: `memoryRunSweep`, `memoryRunConsolidation`).

Uses existing IPC: `memorySearch`, `memoryList`, `memoryHealthStats`, `memoryUpdate`, `memoryPromote`, `memoryArchive`.

### 4.5 Enhanced Linear Connection Panel

**`apps/desktop/src/renderer/components/cto/LinearConnectionPanel.tsx`** — NEW

Replaces connection step in LinearSyncPanel with guided flow:
1. Token paste with inline validation (green checkmark / red X)
2. On valid token: show org name + project discovery multi-select
3. `ConnectionStatusDot` in the panel header
4. Error recovery: banner on 401 with "Reconnect" button, rate limit cooldown display

### 4.6 Worker Creation Wizard

**`apps/desktop/src/renderer/components/cto/WorkerCreationWizard.tsx`** — NEW

Template-first creation using `StepWizard`:
- **Step 1 — Template**: Grid of template cards (Backend Engineer, QA Tester, DevOps, Researcher, Custom). Each card shows role icon, name, description, pre-filled capabilities.
- **Step 2 — Identity**: Pre-filled from template. Name, title, role, capabilities (editable chip input), reports-to selector.
- **Step 3 — Adapter & Runtime**: Adapter type selector, model/webhook/command config, budget, heartbeat policy.

On complete: calls existing `ctoSaveAgent`.

### 4.7 Worker Detail Slide-Out

**`apps/desktop/src/renderer/components/cto/WorkerDetailSlideOut.tsx`** — NEW

Right-side slide-out panel (overlays main content, 480px width). Internal tabs:
- **Overview**: Status badge, identity card, capabilities chips, quick actions (Wake, Pause, Chat, Edit, Remove)
- **Activity**: `TimelineEntry` list of heartbeat runs, sessions, mission participation
- **Memory**: Worker core memory view/edit (same pattern as CtoSettingsPanel core memory)
- **Config**: Revision history with rollback, adapter details, budget usage chart

### 4.8 Team Panel Redesign

**`apps/desktop/src/renderer/components/cto/TeamPanel.tsx`** — MODIFY

Redesign to grid of worker cards:
- Card view: status dot (pulsing if running), name, role, budget bar (spent/limit), last heartbeat relative timestamp
- Click card → opens `WorkerDetailSlideOut`
- "Hire Worker" button → opens `WorkerCreationWizard` (replaces current `WorkerEditorPanel` for new workers)
- Keep `WorkerEditorPanel` for editing existing workers (accessed from slide-out "Edit" action)

---

## Phase 5: Integration & Wiring

### 5.1 CtoPage.tsx — MODIFY

Major wiring changes:
1. Load onboarding state in `loadCtoState`, add `onboardingState` to local state
2. Conditional rendering: show `OnboardingWizard` overlay when uninitialized
3. Show `OnboardingBanner` when dismissed but incomplete
4. Add "Memory" tab to TABS array: `{ id: "memory", label: "Memory", icon: Database }`
5. Render `CtoMemoryBrowser` in memory tab
6. Wire `WorkerDetailSlideOut` — open on worker card click, pass agent data
7. Update team tab to use redesigned `TeamPanel` (cards instead of flat list)

### 5.2 CtoSettingsPanel.tsx — MODIFY

- Replace inline identity editor with `IdentityEditor` component
- Add "Re-run Setup Wizard" button that calls `ctoResetOnboarding` then sets local state to show wizard
- Keep existing core memory and session log sections unchanged

### 5.3 LinearSyncPanel.tsx — MODIFY

- Replace connection step content with `LinearConnectionPanel`
- Add `ConnectionStatusDot` to panel header
- Add section header labels: "Connection Status" vs "Dispatch Policy"

### 5.4 AgentSidebar.tsx — MODIFY

- Replace inline status dots with `AgentStatusBadge`
- Add onboarding incomplete indicator on CTO entry (small badge/dot)

---

## Phase 6: Theming Polish

### 6.1 Import Consolidation

Update TeamPanel, CtoSettingsPanel, LinearSyncPanel to import shared `inputCls/labelCls/textareaCls/selectCls/cardCls` from `shared/designTokens.ts` instead of defining locally.

### 6.2 MemoryInspector.tsx Migration

Migrate inline styles (`laneDesignTokens` COLORS, MONO_FONT, LABEL_STYLE, cardStyle, primaryButton, outlineButton) to Tailwind utility classes for consistency with CTO surfaces. Use Button component instead of custom button functions.

### 6.3 Dark Mode Audit

Verify all new components use CSS variables / Tailwind theme utilities. No hardcoded light colors. The existing palette is dark-first so this is mainly verification.

---

## Files to Create (14 new files)

| File | Purpose |
|------|---------|
| `renderer/components/cto/shared/designTokens.ts` | Shared class patterns + templates |
| `renderer/components/cto/shared/AgentStatusBadge.tsx` | Status indicator component |
| `renderer/components/cto/shared/MemoryEntryCard.tsx` | Memory entry display card |
| `renderer/components/cto/shared/TimelineEntry.tsx` | Activity feed entry |
| `renderer/components/cto/shared/StepWizard.tsx` | Multi-step wizard shell |
| `renderer/components/cto/shared/ConnectionStatusDot.tsx` | Connection status dot |
| `renderer/components/cto/OnboardingWizard.tsx` | CTO first-run wizard |
| `renderer/components/cto/OnboardingBanner.tsx` | Incomplete setup banner |
| `renderer/components/cto/IdentityEditor.tsx` | Identity form + prompt preview |
| `renderer/components/cto/CtoMemoryBrowser.tsx` | Unified memory browser |
| `renderer/components/cto/LinearConnectionPanel.tsx` | Guided Linear connection |
| `renderer/components/cto/WorkerCreationWizard.tsx` | Template-based worker creation |
| `renderer/components/cto/WorkerDetailSlideOut.tsx` | Worker detail panel |
| `renderer/components/cto/WorkerActivityFeed.tsx` | Worker activity timeline |

## Files to Modify (12 existing files)

| File | Changes |
|------|---------|
| `shared/types/cto.ts` | Add onboarding types, extend CtoIdentity |
| `shared/types/agents.ts` | Add optional personality fields, WorkerTemplate |
| `shared/ipc.ts` | Add 6 new IPC channels |
| `preload/preload.ts` | Add 6 new bridge methods |
| `main/services/cto/ctoStateService.ts` | Onboarding state + prompt preview methods |
| `main/services/cto/linearSyncService.ts` | Linear project discovery |
| `main/services/ipc/registerIpc.ts` | Register 6 new handlers |
| `renderer/components/cto/CtoPage.tsx` | Onboarding gate, Memory tab, wiring |
| `renderer/components/cto/CtoSettingsPanel.tsx` | Use IdentityEditor, add re-run button |
| `renderer/components/cto/LinearSyncPanel.tsx` | Use LinearConnectionPanel + status dot |
| `renderer/components/cto/AgentSidebar.tsx` | Use AgentStatusBadge |
| `renderer/components/cto/TeamPanel.tsx` | Redesign to card grid + slide-out |
| `renderer/components/settings/MemoryInspector.tsx` | Migrate inline styles to Tailwind |

## Files NOT Touched (W7b/parallel safety)

- `main/services/orchestrator/` — W7b territory
- `renderer/components/missions/` — W7b territory
- `renderer/components/lanes/` — Separate concern
- `main/services/memory/` — Service layer already works, only IPC consumers

---

## Verification

1. **Build**: `pnpm build` from `apps/desktop/` — no TypeScript errors
2. **First-run flow**: Launch app → CTO tab should show onboarding wizard, not chat
3. **Skip + banner**: Skip onboarding → banner shows, click "Continue Setup" → wizard returns
4. **Identity editor**: Settings tab → edit identity → Preview Prompt shows assembled prompt
5. **Worker creation**: Team tab → Hire Worker → template wizard → worker appears in sidebar
6. **Worker detail**: Click worker card → slide-out opens with tabs
7. **Memory browser**: Memory tab → scope selector works, search returns results, entry detail opens
8. **Linear connection**: Linear tab → paste token → validates → shows projects
9. **Theming**: Toggle light/dark mode → all new surfaces render correctly
10. **Status badges**: All agent status indicators use AgentStatusBadge consistently
