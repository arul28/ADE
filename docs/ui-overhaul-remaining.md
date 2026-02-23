# UI Overhaul — Remaining Work (Detailed Agent Prompt)

> **Context:** A previous agent completed Phase 1-2 of the UI overhaul from `/Users/arul/ADE/docs/ui-overhaul.md`. It handled the mechanical migration (icon swap, theme reduction, typography bumps, font installation) but did NOT deliver on the visual quality, motion design, 3D experiences, or the "alive, precise, confident" aesthetic that the spec demands. The app still looks flat, bland, and cluttered. This prompt covers everything that's still missing.

> **CRITICAL WARNING — DISK SAFETY:** A previous agent session created a 200GB runaway file at `/private/tmp/claude-501/` by spawning a background bash monitoring loop that was never stopped. **NEVER spawn background bash tasks that run in loops.** If you need to check agent progress, use `TaskOutput` which is bounded. Do NOT use `while true` or polling loops in background shell commands. Before finishing your work, run `du -sh /private/tmp/claude-501/` to verify no output files have grown beyond a few MB. Also check `/Users/arul/ADE/.ade/logs/main.jsonl` — it bloated to 56GB from debug logging. If it's large again, delete it.

---

## What Was Already Done (DO NOT REDO)

- ✅ 6 themes → 2 (dark + light) with migration logic in `appStore.ts`
- ✅ Geist + Geist Mono fonts installed via `@font-face` in `index.css`
- ✅ All Lucide icons → Phosphor icons (`@phosphor-icons/react`) across 95 files
- ✅ `font-serif` removed everywhere
- ✅ Typography bumped: `text-[10px]` → `text-[11px]`, `text-[11px]` → `text-xs`
- ✅ Per-tab tint CSS classes (`tab-tint-*` with `--tab-tint-rgb`)
- ✅ Tab background cross-fade in `TabBackground.tsx` (350ms transition)
- ✅ Spring physics constants in `motion.ts` (snappy, default, gentle, bouncy, slow)
- ✅ TopBar simplified (plain bold ADE text, simplified divider)
- ✅ TabNav updated (Phosphor icons, grouping separator, 2px indicator)
- ✅ Command palette redesigned (glassmorphism, 560px, grouped results, keyboard nav)
- ✅ Settings theme selector: dark/light toggle cards
- ✅ Empty states added to all tabs
- ✅ Missions DAG: CSS 3D perspective + spinning ring + check/X status icons
- ✅ PR state chips redesigned with new color scheme
- ✅ Breathing glow on active mission cards
- ✅ `TypeScript compiles clean` — zero errors

---

## What Is Still Missing (YOUR WORK)

Read the full spec at `/Users/arul/ADE/docs/ui-overhaul.md` for complete details. Below is a prioritized breakdown.

### Priority 1: Visual Quality — The App Looks Flat and Cluttered

The #1 complaint. The app has bare white/gray lines separating information dumps, no visual hierarchy, no breathing room. Fix these across ALL tabs:

**A. Surface hierarchy is not being used properly (Section 6)**
- Panes should use `.ade-pane` class with proper `box-shadow`, inner top-edge highlight (`inset 0 1px 0 rgba(255,255,255,0.03)`), and hover/focus border tinting via `--tab-tint-rgb`
- Cards should NOT all look the same. Use the 4-level surface hierarchy: recessed (gutters/backgrounds), base (page bg), raised (cards/panes), floating (overlays/modals)
- Add `translateY(-1px)` hover lift + `shadow-card-hover` on interactive cards (Section 11)
- Replace bare `border-b border-border` separators with proper spacing, grouped sections, and subtle section headers

**B. Content stagger animations on tab switch (Section 5)**
- When switching tabs, content should stagger in from bottom: children offset by 30ms each with spring physics
- Use the `staggerContainerFast` and `staggerItemSpring` variants already defined in `motion.ts`
- Wrap each tab's main content sections in `<motion.div variants={staggerContainerFast} initial="hidden" animate="visible">` and each child in `<motion.div variants={staggerItemSpring}>`

**C. Button hover/press physics (Section 6 + 11)**
- PRIMARY buttons: `hover:brightness-110 hover:translate-y-[-1px]`, `active:translate-y-0 active:scale-[0.98]`
- SECONDARY buttons: hover border-color should shift toward `--tab-tint-rgb`
- Already have `active:scale-[0.97]` in CSS but missing the hover float-up on primary buttons

**D. Input focus rings (Section 6)**
- All inputs on focus: `box-shadow: 0 0 0 2px var(--color-accent-muted)` with 150ms transition
- The `.ade-input` class exists in CSS but most inputs don't use it — they use inline Tailwind. Either apply the class or ensure the focus ring pattern is consistent.

**E. Dropdown animations (Section 11)**
- All dropdowns should scale from `scaleY(0.95) opacity(0)` to `scaleY(1) opacity(1)`, transform-origin top, 150ms spring
- Items inside should stagger by 20ms each

### Priority 2: Ambient Backgrounds Need to Be Elevated (Section 5 + 9)

The ambient backgrounds exist but they're too subtle and generic. Each tab's background should create a distinct "room" atmosphere per the spec:

- **Run tab:** Perlin noise gradient in cyan tones. Slow-moving, organic, like deep water. NOT the current radar sweep.
- **Lanes tab:** Horizontal flowing lines, amber-tinted, 3-layer parallax at different speeds
- **Files tab:** Very faint diagonal grid at 3% opacity. Almost nothing — let the code be the visual.
- **Work tab:** Green-tinted code rain, elevated contrast, subtle CRT scanline effect (1px horizontal lines at 2% opacity)
- **Conflicts tab:** Red-tinted diagonal tension lines with breathing effect (spacing contracts/expands). When no conflicts: nearly invisible (2% opacity).
- **Graph tab:** No CSS background needed — the 3D scene IS the background (Phase 5)
- **PRs tab:** Gentle upward-flowing emerald gradient (heat shimmer / launch pad)
- **History tab:** Concentric circular arcs, warm amber, slow 90s rotation cycle
- **Automations tab:** Two gear layers at different scales/speeds, orange-tinted, subtle heat haze shimmer
- **Missions tab:** Topographic contour map in deep blue with slow Perlin noise distortion. NOT nebula/aurora.
- **Settings tab:** Blueprint grid at 5% opacity. Utilitarian.

**Performance rule:** All backgrounds must be GPU-rendered (CSS `will-change: background` or CSS gradients/animations only). No JS `requestAnimationFrame`. Must respect `prefers-reduced-motion`.

### Priority 3: Motion & Spring Physics Applied to Components (Section 7)

The spring configs exist in `motion.ts` but almost NO components actually use them. The app feels static.

**Apply springs to:**
- Tab content transitions (stagger children on mount)
- List item add/remove (`AnimatePresence` with height + opacity)
- Modal/dialog open/close (scale 0.96 + opacity, 200ms spring)
- Toast enter/exit (translateX slide, 300ms spring)
- Process status changes in Run tab: departure-board flip animation (`AnimatePresence mode="popLayout"`)
- Toggle switches: spring-animated thumb (stiffness 500, damping 30)
- Status dot animations: spring-based opacity instead of linear CSS `animate-pulse`

### Priority 4: Per-Tab Specific Enhancements (Section 9)

Each tab has specific visual upgrades in the spec that were not implemented:

**Run tab (9.1):**
- Health dashboard with big monospace metric numbers (`text-2xl font-mono`)
- Process status: departure-board flip animation on status change
- Test results: horizontal bar showing pass/fail ratio, green fills from left
- Recent activity: simple chronological list with `border-b` separators, no wrapping cards
- Config section: collapsed by default, smooth height animation expand

**Lanes tab (9.2):**
- Lane tabs: 36px tall (up from ~28px), active tab gets amber bottom border
- Stack graph: SVG paths with rounded corners, pulse on active lane
- Diff header: file path breadcrumb with clickable segments, colored diff stats (`+12` green, `-3` red)

**Files tab (9.3):**
- Editor tabs: 32px tall, active: `bg-card` + accent bottom border, inactive: `bg-transparent`
- Dirty indicator: small cyan dot (not bullet character)
- File open animation: editor content fades in from opacity 0 over 150ms

**Work tab (9.4):**
- Session list: small activity sparkline per session (40px wide bar chart, monochrome green)
- Active terminal border: faint green glow pulsing with output frequency (batched per second)

**Conflicts tab (9.5):**
- Risk matrix: gradient background shifting red→green across diagonal
- Resolution progress: tint transitions red→green as conflicts resolve

**PRs tab (9.7):**
- Stacked chain visualization: SVG connecting lines with rounded corners + animated flow particles moving upward
- Merge animation: card flashes emerald, chain node dissolves upward

**History tab (9.8):**
- True vertical timeline with center line, events branching left/right alternately
- Timeline scroll: events fade in with 100ms stagger, line draws itself via stroke-dashoffset

**Automations tab (9.9):**
- Each rule as trigger→condition→action flow with connecting line + animated flow particles
- Run history sparkline per automation (last 20 executions)

### Priority 5: 3D Graph Tab (Section 8 — Phase 5)

This is the flagship visual. Three.js packages are already installed (`three@0.183.0`, `@react-three/fiber@8.17.10`, `@react-three/drei@9.122.0`, `maath@0.10.8`).

**Build:**
- `Graph3DScene.tsx` — R3F Canvas with perspective camera, fog, lighting
- `GraphNode3D.tsx` — Sphere meshes, PBR materials (emissive = status color, roughness 0.3, metalness 0.7), glow rings on active nodes, billboard text labels
- `GraphEdge3D.tsx` — Line2 geometry, dashed for blocked edges, animated particle flow
- Post-processing: Bloom (0.4 intensity), ChromaticAberration (edges), Vignette
- OrbitControls with damping, click-to-focus camera fly, idle auto-rotate (10s timeout)
- Overlay UI: minimap (120x80px top-right), search (top-left), controls (bottom-right), detail panel (slides from right on click)
- 2D fallback: keep current xyflow, toggle button
- Performance: instanced rendering above 200 nodes, post-processing disabled on low-end GPU

**CRITICAL:** Only ONE Three.js canvas mounted at a time. Unmount on tab leave, restore state on return.

### Priority 6: Micro-Interactions & Celebrations (Section 11 — Phase 6)

**Celebratory animations (rare, earned):**
- Mission complete: card cyan flash (200ms) + 12-16 particle burst (cyan, 1.5s) + background brightens 2s
- All tests pass: emerald sweep fills bar to 100% (500ms) + radial emerald ripple across Run tab bg (2s)
- PR merged: emerald highlight + chain node dissolves upward (translateY -20px, opacity 0, 800ms)

**First-time events (one-time, tracked in localStorage):**
- First lane: Graph tab icon pulses in sidebar
- First mission: Missions ambient bg "ignites" (opacity ramps 0→full over 3s)
- First PR: 8 emerald confetti dots in PR detail pane (1.5s)

**Ambient life:**
- Missions running → Missions tab icon in sidebar has breathing cyan glow (2s cycle)
- Active terminals → Work tab pane border pulses faintly green with output frequency
- All status dots: spring-based opacity animation (not linear CSS)

---

## Files to Read First

1. `/Users/arul/ADE/docs/ui-overhaul.md` — The complete spec (1380 lines). READ ALL OF IT.
2. `/Users/arul/ADE/apps/desktop/src/renderer/index.css` — Current CSS with themes, tint system, ambient backgrounds
3. `/Users/arul/ADE/apps/desktop/src/renderer/lib/motion.ts` — Spring configs (already defined, need to be USED)
4. `/Users/arul/ADE/apps/desktop/src/renderer/components/ui/TabBackground.tsx` — Current cross-fade system
5. `/Users/arul/ADE/apps/desktop/src/renderer/components/app/AppShell.tsx` — Shell + tint injection

## Technical Constraints

- **Electron + React 18 + Vite + Tailwind CSS 4 + Zustand + Framer Motion (`motion/react`)**
- **TypeScript strict mode** — run `cd /Users/arul/ADE/apps/desktop && npx tsc --noEmit` after changes
- **Performance budget:** <200MB idle, <400MB all tabs visited, 60fps on backgrounds
- **Only ONE Three.js canvas mounted at a time**
- **Reduced motion:** respect `prefers-reduced-motion: reduce` everywhere
- **Icons:** Use `@phosphor-icons/react` with `size={N}` and `weight="regular"` props (already migrated)
- **Fonts:** Geist (sans) and Geist Mono (mono) — `@font-face` already in `index.css`
- **No external images.** All visuals are CSS, SVG, or procedural (shaders/math)

## What Success Looks Like

The app should feel **alive, precise, and confident**:
- Each tab feels like a distinct "room" with its own atmosphere
- Content staggers in with spring physics on tab switch
- Interactive elements feel physical (hover lift, press feedback)
- Information is organized in clear visual hierarchy, not dumped with bare lines
- The 3D Graph tab is the flagship showcase
- Celebratory moments reward the user for achievements
- The overall impression is "premium dev tool" — like Linear or Raycast, not like a generic Electron app
