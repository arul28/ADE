# UI Overhaul — Consolidated Remaining Gaps

> **Context:** Three rounds of agents have completed the foundation: theme system (deep blue-navy dark, warm off-white light), glassmorphism on all floating panes, semantic color tokens replacing all hardcoded zinc, input/card standardization across 30+ files, 3D graph scene with Bloom/Vignette/camera-fly/minimap/search/detail-panel/edge-particles, stagger animations (first-visit-only), spring physics in motion.ts, per-tab tint system, Phosphor icons, Geist fonts. All of that is DONE. This doc covers ONLY what is still missing.

> **CRITICAL WARNING — DISK SAFETY:** **NEVER spawn background bash tasks that run in loops.** Do NOT use `while true` or polling loops in background shell commands.

---

## Technical Constraints

- **Stack:** Electron 40 + React 18 + Vite + Tailwind CSS 4 + Zustand + Framer Motion (`motion/react`)
- **TypeScript strict mode** — run `cd /Users/arul/ADE/apps/desktop && npx tsc --noEmit` after changes
- **Performance:** <200MB idle, <400MB all tabs, 60fps backgrounds
- **Only ONE Three.js canvas mounted at a time** — unmount on tab leave
- **Reduced motion:** respect `prefers-reduced-motion: reduce` everywhere
- **Icons:** `@phosphor-icons/react` with `size={N}` and `weight="regular"`
- **Fonts:** Geist (sans) and Geist Mono (mono)
- **No external images** — all visuals are CSS, SVG, or procedural

## Files to Read First

1. `/Users/arul/ADE/apps/desktop/src/renderer/index.css` — CSS themes, tint system, animations
2. `/Users/arul/ADE/apps/desktop/src/renderer/lib/motion.ts` — Spring configs and animation variants
3. `/Users/arul/ADE/apps/desktop/src/renderer/components/graph/Graph3DScene.tsx` — Current 3D graph

---

## Gap 1: Sidebar Collapse Jitter

**File:** `index.css` (`.ade-sidebar` rule), `AppShell.tsx`

When collapsing the sidebar, tab icons visibly shift/jitter for a split second. The current animation uses CSS `width` transition which causes layout recalculation.

**Fix:**
- Switch from `width` animation to `transform: translateX()` or use `position: absolute` for text labels so they don't affect icon positioning during transition
- Hide text labels with `opacity: 0` + `overflow: hidden` FIRST, then animate width
- Test: rapidly toggle sidebar hover 10 times — icons should NEVER shift position

---

## Gap 2: 3D Graph — Missing Advanced Features

**File:** `src/renderer/components/graph/Graph3DScene.tsx`

Already done: Bloom, Vignette, camera fly-to, minimap, search, detail panel, edge particles, auto-rotate.

Still missing:

**A. ChromaticAberration post-processing**
- Add `ChromaticAberration` effect (offset `[0.001, 0.001]`, edges only) to the existing `EffectComposer`
- Install `@react-three/postprocessing` if not already present (check package.json first)

**B. GPU capability detection**
- Detect low-end GPU via `renderer.capabilities` (check `maxTextureSize`, VRAM hints)
- Disable post-processing (Bloom, ChromaticAberration, Vignette) on low-end machines
- Add a `useEffect` that reads WebGL capabilities on mount

**C. Force simulation (organic layout)**
- Use `maath` package (already installed) for force-directed layout
- Replace current static 2D→3D position mapping with a real force simulation
- Nodes should spread organically in 3D space, not just map XY coordinates

**D. Instanced rendering for large graphs**
- When node count > 200, switch from individual `<Sphere>` components to `<InstancedMesh>`
- Maintain interactivity (hover/click) via raycasting on instance IDs

---

## Gap 3: Per-Tab Specific Enhancements

### 3A. Lanes Tab
**Files:** `LanesPage.tsx`, `LaneRow.tsx`

- Lane tabs should be 36px tall (currently ~28px) with amber 2px bottom border on active
- Stack graph SVG connecting lines: rounded corners + pulse animation on active lane
- Diff header: file path as breadcrumb with clickable segments (currently just a flat string)

### 3B. Files Tab
**File:** `FilesPage.tsx`

- Editor tabs: 32px tall, active gets `bg-card` + accent bottom border, inactive `bg-transparent`
- Dirty indicator: replace bullet character with a small cyan dot (`w-1.5 h-1.5 rounded-full bg-accent`)
- File open animation: editor content fades in from `opacity: 0` over 150ms
- File tree indentation: 1px vertical lines (`border-border/20`) with rounded corners at junctions

### 3C. PRs Tab — Chain Visualization
**Files:** `PRsPage.tsx`, `LanePrPanel.tsx`

- Stacked chain: SVG connecting lines with rounded corners + animated flow particles moving upward
- Merge animation: merged PR card flashes emerald, chain node dissolves upward (`translateY(-20px)`, `opacity: 0`, 800ms spring), remaining nodes slide up via Framer Motion `layout` prop

### 3D. History Tab — Scroll-Driven Effects
**File:** `HistoryPage.tsx`

- Scroll-driven line draw: SVG `stroke-dashoffset` animation tied to scroll position (the timeline line draws itself as you scroll)
- Events leaving viewport: fade to 50% opacity (use `IntersectionObserver`)

### 3E. Automations Tab — Flow & Sparklines
**File:** `AutomationsPage.tsx`

- Trigger→action connecting line: add animated flow particles (tiny dots moving left to right along the line)
- Run history sparkline per automation: last 20 executions as small dots (green=success, red=failure) below each rule
- Natural language "create automation" dialog: text input "Describe what should happen..." with AI-parsed trigger-condition-action preview

---

## Gap 4: Missions Tab Polish

### 4A. Kanban Board DnD
**File:** `MissionsPage.tsx`

- Kanban columns exist but drag-and-drop between columns (manual override) is not implemented
- Add drag support using native HTML drag API or a lightweight library

### 4B. Agent Channels Refinement
**File:** `AgentChannels.tsx`

- Channel sidebar: tighter spacing, active channels get a green dot indicator, unread messages show cyan dot with count
- Message bubbles: coordinator messages full-width, worker messages indented with 2px left border color-coded by agent
- Input placeholder: "Send to [Agent Name]" (dynamic based on selected channel)

### 4C. Usage Dashboard
**File:** `UsageDashboard.tsx`

- Big metric cards at top: tokens, cost, duration displayed as `text-2xl font-mono` numbers
- Model breakdown: replace text-only display with horizontal stacked bar chart (Claude variants in blue spectrum, Codex in emerald spectrum)

---

## Gap 5: Missions 2.5D DAG Enhancement

**File:** `OrchestratorDAG.tsx`

The DAG has CSS 3D perspective already. Missing:

- **Depth-based sizing:** earlier pipeline steps slightly larger than later ones
- **Hover Z-pop:** on hover, node `transform: translateZ(10px) scale(1.05)` with `box-shadow: 0 12px 32px -8px rgba(var(--tab-tint-rgb), 0.25)`
- **Connection lines:** SVG with animated `stroke-dashoffset` (flow direction indicator)
- **Completed nodes:** checkmark draws itself (SVG line-draw animation using `stroke-dasharray` + `stroke-dashoffset` transition)
- **Failed nodes:** brief red pulse on failure, then static red ring

---

## Gap 6: Celebration Animations

### 6A. Mission Complete
**File:** `MissionsPage.tsx`

When mission status → "done":
1. Card briefly flashes cyan border (200ms)
2. 12-16 particle burst from card (cyan, DOM elements with CSS animation, removed after 1.5s)
3. Ambient background brightens for 2s (opacity 0.15 → 0.25 → 0.15)
4. Status dot does overshoot spring (scale 1 → 1.8 → 1)

### 6B. All Tests Pass
**File:** `ProjectHomePage.tsx`

When all suites green:
1. Test summary bar fills to 100% with emerald sweep (500ms)
2. Radial emerald ripple across Run tab background (2s, one-time per test run)

### 6C. PR Merge
**File:** `PRsPage.tsx`

When PR state → "merged":
1. PR card brief emerald highlight
2. In stacked chain, merged node dissolves upward (translateY -20px, opacity 0, 800ms)
3. Remaining chain nodes slide up (Framer Motion `layout`)

### 6D. First-Time Events
Track in `localStorage`, fire once ever:
- **First lane created:** Graph tab icon in sidebar pulses briefly
- **First mission launched:** Missions ambient background "ignites" (opacity ramps 0→full over 3s)
- **First PR created:** 8 emerald confetti dots fall in PR detail pane (1.5s)

---

## Gap 7: Ambient Life Indicators

### 7A. Sidebar Mission Glow
**Files:** `TabNav.tsx`, needs IPC wiring from main process

When missions are running, the Missions tab icon in sidebar has a breathing cyan glow (2s cycle, 30% opacity). Requires:
- Expose "any mission running" state from main process → renderer via IPC
- Apply CSS class `ade-tab-icon-active` (already defined) based on that state

### 7B. Terminal Output Pulse
**Files:** `TerminalsPage.tsx`, needs IPC data pipeline

Active terminals cause Work tab pane border to pulse faintly green synced to output frequency. Requires:
- Terminal runtime batches output-per-second data
- Renderer receives the frequency and maps it to border glow intensity

### 7C. Status Dots — Spring Animation
**Files:** All components using `animate-pulse` on status dots

Replace linear CSS `animate-pulse` with Framer Motion spring-based opacity animation using the `pulseGlow` variant from `motion.ts`. Makes breathing feel organic instead of mechanical.

---

## Summary Table

| # | Gap | Complexity | Files |
|---|-----|-----------|-------|
| 1 | Sidebar collapse jitter | Medium | index.css, AppShell.tsx |
| 2 | 3D Graph advanced (ChromaticAberration, force sim, instancing, GPU detect) | High | Graph3DScene.tsx |
| 3A | Lanes: 36px tabs, SVG rounded corners, breadcrumb | Medium | LanesPage.tsx, LaneRow.tsx |
| 3B | Files: editor tabs, cyan dirty dot, fade-in, tree lines | Medium | FilesPage.tsx |
| 3C | PRs: chain SVG particles, merge animation | High | PRsPage.tsx, LanePrPanel.tsx |
| 3D | History: scroll-driven line draw, viewport fade | Medium | HistoryPage.tsx |
| 3E | Automations: flow particles, sparklines, NL dialog | High | AutomationsPage.tsx |
| 4A | Missions kanban DnD | Medium | MissionsPage.tsx |
| 4B | Agent channels refinement | Low | AgentChannels.tsx |
| 4C | Usage dashboard bar chart | Medium | UsageDashboard.tsx |
| 5 | Missions 2.5D DAG (Z-pop, line-draw, flow) | Medium | OrchestratorDAG.tsx |
| 6A | Celebration: mission complete | Medium | MissionsPage.tsx |
| 6B | Celebration: all tests pass | Low | ProjectHomePage.tsx |
| 6C | Celebration: PR merge | Medium | PRsPage.tsx |
| 6D | First-time event animations | Low | TabNav.tsx, various |
| 7A | Sidebar mission glow (needs IPC) | Medium | TabNav.tsx + main process |
| 7B | Terminal output pulse (needs IPC) | High | TerminalsPage.tsx + main process |
| 7C | Status dots spring animation | Low | Multiple files |
