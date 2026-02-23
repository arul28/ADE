# UI Overhaul — Remaining Gaps (v2)

> **Context:** Two rounds of agents have now completed the bulk of the UI overhaul from `/Users/arul/ADE/docs/ui-overhaul.md`. The foundation, motion system, stagger animations, ambient backgrounds, per-tab enhancements, 3D graph scene, and celebration triggers are all in place. This doc covers what is still missing or incomplete against the original spec.

> **CRITICAL WARNING — DISK SAFETY:** **NEVER spawn background bash tasks that run in loops.** Do NOT use `while true` or polling loops in background shell commands. Before finishing your work, run `du -sh /private/tmp/claude-501/` to verify no output files have grown beyond a few MB.

---

## PRIORITY ZERO: Visual Quality Is Still Fundamentally Broken

**Two full rounds of agents have failed to make the UI look good.** The animations, tint system, and motion work are technically in place, but the overall visual impression is bland, boring, clunky, and sloppy. The screenshots below prove it. This section must be addressed BEFORE any of the feature gaps below — there is no point adding 3D post-processing or flow particles if the base UI looks like a developer prototype.

### Core Visual Problems (from user review with screenshots)

**1. Too Many Hard Separator Lines — The #1 Visual Problem**
Everywhere you look, `border-b border-border` lines create a rigid, spreadsheet-like grid. The app looks like a 2010-era admin panel, not a modern developer tool. This is visible on EVERY tab:
- History page: every event row separated by a full-width hairline
- Lanes page: Inspector pane sections divided by hard lines, lane list has hard separators
- Work page: session list items divided by hard lines, pane headers use hard lines
- Automations page: form sections divided by hard lines

**FIX:** Replace hard `border-b` separators with:
- Spacing/padding gaps between items (let the background breathe through)
- Subtle `bg-card/30` or `bg-muted/20` alternating rows where grouping is needed
- Floating cards with `rounded-xl` and soft `shadow-sm` for distinct sections
- `divide-y divide-border/10` (10-20% opacity) where lines are truly necessary
- Group related items into `ade-floating-pane` cards with rounded corners

Search for `border-b` and `border-t` across all component files. Most of them need to be removed or softened dramatically. The goal: sections should feel like they float, not like they're caged in a wireframe grid.

**2. Dark Theme Is Too Dark, Light Theme Is Too Light**
- Dark mode `--color-bg` is pure/near-black — needs to be lifted to a dark gray (e.g., `#0f1117` or `#121318`)
- Dark mode surfaces lack contrast differentiation — `bg-card`, `bg-muted`, `bg-surface-raised` all blend together
- Light mode is too washed out — needs warmer off-white tones and slightly more surface contrast
- Many components are NOT optimized for both themes — text that's readable in dark mode becomes invisible or garish in light mode, and vice versa

**FIX:** In `index.css` theme variables:
- Dark: lift base bg from near-black to `hsl(228 14% 8%)` or similar, increase surface layer contrast
- Light: shift base from pure white to warm off-white `hsl(220 20% 97%)`, strengthen card/muted contrast
- Audit every component for both themes — especially text colors on colored backgrounds (status badges, chips, diff stats)

**3. Information Regurgitation / Data Dumping**
The UI dumps raw data everywhere without hierarchy or progressive disclosure:
- History page: shows 10+ identical "Project pack refreshed" entries with no grouping or deduplication — should collapse repeated events
- Lanes Inspector: shows every property as a flat key-value dump — needs collapsible sections, visual hierarchy
- Automations page: empty form with no guidance, massive whitespace — needs better empty states and inline help
- Work page: session list shows all metadata inline — should show summary with expand-for-details

**FIX:**
- Add collapsible/expandable sections (`<details>` or Radix Collapsible) to dense information panes
- Group repeated events (e.g., "Project pack refreshed x12" with expand)
- Use progressive disclosure: show 2-3 key fields, click to expand full details
- Add "Show more" / "Show less" toggles to long lists
- Information density controls: compact/comfortable/spacious view toggle per pane

**4. Sidebar Collapse Animation Is Broken**
When collapsing the sidebar, all tab icons visibly shift/jitter for a split second before settling. This makes the collapse feel cheap and broken.

**FIX:** The collapse transition likely has a layout shift caused by the text labels disappearing before the width animation completes. Fix by:
- Hiding text labels with `opacity: 0` + `overflow: hidden` FIRST, then animate width
- Using `transform: translateX()` instead of width animation to avoid layout recalculation
- Or: use `position: absolute` for the text labels so they don't affect icon positioning during transition
- Test: rapidly toggle sidebar 10 times — icons should NEVER shift position

**5. Tab Switch Stagger Animation Gets Annoying**
The stagger entrance animation plays every time you switch tabs. When working fast and switching tabs frequently, this creates a distracting delay/flutter effect. Content should appear instantly on revisit.

**FIX:**
- Only play stagger animation on FIRST mount of each tab per session
- Track visited tabs in a `Set` (React context or Zustand)
- On revisit: content appears instantly (no animation delay)
- Or: reduce stagger to 30ms total (vs current ~200ms), make it barely perceptible
- The animation should feel like a welcome, not a loading screen

**6. No Visual "Wow Factor" — Still Looks Like Every Other Dev Tool**
Despite all the technical work (spring physics, ambient backgrounds, tint system), the visual result is indistinguishable from any Electron app with Tailwind dark mode. There is nothing that makes someone look at ADE and say "that looks premium."

**What would create wow factor:**
- Glassmorphism: `backdrop-blur-xl` + semi-transparent surfaces (`bg-card/60`) on floating panels
- Subtle gradient meshes or noise textures on key surfaces (not just flat colors)
- Glow effects: active/selected items emit a soft colored glow (not just a border change)
- Depth: layered surfaces with visible z-separation (soft shadows, not just borders)
- Premium typography: tighter letter-spacing on headings, proper font weight hierarchy
- Micro-animations that respond to interaction (hover ripples, click feedback, drag inertia)
- The 3D graph should be visible as a subtle background element or hero moment, not hidden behind a toggle

**7. Components Need Dark/Light Mode Audit**
Multiple components render incorrectly in one or both themes:
- Status badges and chips may have poor contrast
- Card backgrounds blend into page backgrounds
- Borders that are visible in dark mode vanish in light mode
- Text colors that work in dark mode become unreadable in light mode

**FIX:** Go through every component file and test both themes. Key areas:
- All `.text-*` classes on `.bg-*` backgrounds
- All `border-*` classes — ensure visible in both themes
- All `bg-card`, `bg-muted`, `bg-surface-*` usages — ensure contrast against parent
- Status colors (green/red/amber/blue) — ensure legible against both dark and light surfaces

### Evidence From Screenshots

**History Page:**
- Flat, repetitive event list with no visual hierarchy
- Every row identical height and style — no differentiation for event types
- Detail pane on right is a plain text dump with `border-b` separators
- Timeline dots are tiny and bland — no glow, no status coloring
- Overall impression: a log viewer, not a timeline

**Automations Page:**
- Massive empty space with a basic form
- No visual interest — flat card with generic inputs
- Toggle switches are standard browser checkboxes (the `ade-toggle` CSS class may not be applied everywhere)
- Trigger→action flow visualization exists but is not prominent enough
- Overall impression: a settings page, not an automation builder

**Lanes Page:**
- 5+ panes crammed together with hard separator lines everywhere
- Inspector pane dumps all properties as flat text
- Lane list items are dense text blocks with no breathing room
- Diff pane has colored stats (working!) but the overall layout is claustrophobic
- Overall impression: information overload, needs collapsible sections and better spacing

**Work Page:**
- Session list with sparklines visible (one thing that works!)
- But two large empty state panels take up most of the screen
- Pane headers use bare `border-b` separators
- Terminal output area is flat black — needs the `bg-surface-recessed` treatment
- Overall impression: functional but lifeless

---

## What Is Already Done (DO NOT REDO)

### Phase 1-2 (Previous Agent)
- ✅ 6 themes → 2 (dark + light) with migration logic
- ✅ Geist + Geist Mono fonts installed via `@font-face`
- ✅ All Lucide icons → Phosphor icons across 95+ files
- ✅ Typography bumped, `font-serif` removed
- ✅ Per-tab tint CSS classes (`tab-tint-*` with `--tab-tint-rgb`)
- ✅ Tab background cross-fade in `TabBackground.tsx`
- ✅ TopBar simplified, TabNav updated, Command palette redesigned
- ✅ Settings theme selector: dark/light toggle
- ✅ Empty states added to all tabs

### Phase 3-6 (Current Agent Sessions)
- ✅ Spring physics constants + 7 new animation variant sets in `motion.ts`
- ✅ Stagger animations on ALL 12 tab pages
- ✅ Button hover physics (float-up, shadow boost, tab-tinted outlines)
- ✅ Global input focus rings
- ✅ Radix Dialog/Popover/Dropdown/Select enter/exit animations
- ✅ Dropdown item stagger (CSS nth-child delays)
- ✅ `ade-card-interactive` hover lift on 7+ component files
- ✅ `ade-floating-pane`: inner top-edge highlight, tab-tinted hover + focus-within borders
- ✅ `ade-toggle` CSS class for spring-animated toggle switches
- ✅ Chip status variant CSS classes (success/warning/error/info)
- ✅ Ambient backgrounds enhanced for all 12 tabs
- ✅ `Graph3DScene.tsx` created with R3F + integrated into WorkspaceGraphPage with 2D/3D toggle
- ✅ Run tab: health dashboard metrics, process status flip, test pass/fail bar, collapsible config
- ✅ Lanes tab: colored diff stats (green/red), commit timeline stagger, diff pane stat badges
- ✅ Conflicts tab: risk matrix heat-map gradient, resolution progress tinting (5 levels)
- ✅ PRs tab: status badge flip transitions, conflict badge pulse animations
- ✅ History tab: vertical timeline with connector line, status-colored dots, stagger
- ✅ Terminal: active terminal green glow pulse, session sparklines
- ✅ Automations: trigger→action flow visualization
- ✅ Celebration CSS keyframes + triggers wired to mission complete, tests pass, PR merge
- ✅ First-time event tracking via localStorage
- ✅ Kbd component: realistic key shadow
- ✅ `prefers-reduced-motion` coverage for all animations
- ✅ TypeScript compiles clean (zero errors)

---

## What Is Still Missing (Remaining Gaps)

### Priority 1: 3D Graph — Advanced Features (Section 8)

The basic `Graph3DScene.tsx` is built (sphere nodes, edge lines, fog, auto-rotate, OrbitControls, 2D/3D toggle). The following advanced features from the spec are NOT implemented:

**A. Post-processing pipeline**
- `@react-three/postprocessing` is NOT installed. Need to `npm install @react-three/postprocessing`
- Add `EffectComposer` with:
  - `Bloom` (intensity 0.4, threshold 0.8, radius 0.6)
  - `ChromaticAberration` (offset [0.001, 0.001], edges only)
  - `Vignette` (darkness 0.3)
- Must detect low-end GPU via `renderer.capabilities` and disable post-processing

**B. Click-to-focus camera fly**
- When a node is clicked, camera should smoothly fly to it (800ms spring)
- Background nodes should blur (DOF effect via post-processing)
- Click-away returns camera to overview (1000ms gentle spring)
- Currently clicking a node just navigates to the lane page

**C. Minimap overlay**
- 120x80px semi-transparent card, top-right corner
- Shows full graph in 2D with viewport rectangle
- Currently only has a node count badge

**D. Search overlay**
- Floating search input, top-left
- Find and fly-to specific nodes by name
- Not implemented

**E. Node detail panel**
- Slides in from right when a node is clicked (300px wide, `bg-surface-overlay`)
- Shows lane name, branch, status, recent commits, links to other tabs
- Not implemented

**F. Edge particle flow**
- Animated particles flowing along edges in dependency direction
- Currently edges are static lines

**G. Force simulation**
- Spec mentions custom force simulation via `maath` package
- Current implementation uses 2D positions from the existing xyflow nodes scaled into 3D
- Real force-directed layout would make the 3D view more organic

**H. Instanced rendering**
- For graphs with 200+ nodes, switch to instanced meshes for performance
- Not implemented (current: individual Sphere components per node)

### Priority 2: Per-Tab Specific Enhancements (Section 9)

Several per-tab visual details from the spec are not yet implemented:

**A. Lanes tab (Section 9.2)**
- Lane tabs should be 36px tall (currently ~28px) with amber bottom border on active
- Stack graph SVG connecting lines should have rounded corners + pulse on active lane
- Diff header: file path should be a breadcrumb with clickable segments

**B. Files tab (Section 9.3)**
- Editor tabs should be 32px tall with active: `bg-card` + accent bottom border
- Dirty indicator should be a small cyan dot (not bullet character)
- File open animation: editor content fades in from opacity 0 over 150ms
- File tree: refined indentation with 1px `border-border/20` vertical lines and rounded corners at junctions

**C. Work tab (Section 9.4)**
- Terminal container should force `bg-surface-recessed` (darker than other tabs)
- Session sparklines are added but show deterministic placeholder data — needs real output activity data pipeline

**D. PRs tab (Section 9.7)**
- Stacked chain visualization: SVG connecting lines with rounded corners + animated flow particles moving upward
- Merge animation: card flashes emerald, chain node dissolves upward, remaining nodes slide up via Framer Motion `layout` prop

**E. History tab (Section 9.8)**
- True alternating left/right timeline (currently all events are on one side)
- Scroll-driven line draw: SVG `stroke-dashoffset` animation tied to scroll position
- Events leaving viewport should fade to 50% opacity

**F. Automations tab (Section 9.9)**
- Trigger→action flow exists but doesn't have animated flow particles on the connecting line
- Run history sparkline per automation (last 20 executions, green/red dots)
- Natural language "create automation" dialog with AI-parsed trigger-condition-action preview

### Priority 3: Missions Tab Polish (Section 9.10)

**A. Board view**
- Kanban columns for mission states (Queued, Planning, Running, Done, Failed)
- Drag missions between columns (manual override)
- Currently uses a sidebar list, not kanban columns

**B. Agent channels refinement**
- Channel sidebar: tighter spacing, active channels get green dot, unread indicator with count
- Message bubbles: coordinator full-width, worker indented, left border color-coded by agent
- Input placeholder: "Send to [Agent Name]"

**C. Usage dashboard**
- Big metric cards at top: tokens, cost, duration (`text-2xl font-mono`)
- Model breakdown: horizontal stacked bar chart (not just text)
- Per-mission filter toggle

### Priority 4: Missions 2.5D DAG Enhancement (Section 8)

The current OrchestratorDAG already has CSS 3D perspective. Missing:
- Depth-based sizing (earlier pipeline steps slightly larger)
- Hover pops node forward in Z-space (`transform: translateZ(10px) scale(1.05)`)
- Connection lines: SVG with animated `stroke-dashoffset` (flow direction)
- Completed nodes: checkmark draws itself (SVG line-draw animation)
- Failed nodes: brief red pulse, then static red ring

### Priority 5: Advanced Micro-Interactions (Section 11)

**A. Status dots spring animation**
- All status dots (running, attention) should use spring-based opacity animation instead of linear CSS `animate-pulse`
- Replace with `motion.div` using `pulseGlow` variant from `motion.ts`

**B. Sidebar ambient life**
- When missions are running: Missions tab icon breathing glow (2s cycle, cyan 30% opacity)
- Requires exposing "any mission running" state from main process to renderer via IPC
- CSS class `ade-tab-icon-active` exists but isn't wired to actual mission state

**C. Terminal output pulse**
- Work tab pane border pulses green in rhythm with terminal output frequency
- Needs output frequency data from terminal runtime (batched per second)

---

## Technical Constraints

- **Electron + React 18 + Vite + Tailwind CSS 4 + Zustand + Framer Motion (`motion/react`)**
- **TypeScript strict mode** — run `cd /Users/arul/ADE/apps/desktop && npx tsc --noEmit` after changes
- **Performance budget:** <200MB idle, <400MB all tabs visited, 60fps backgrounds
- **Only ONE Three.js canvas mounted at a time** — unmount on tab leave
- **Reduced motion:** respect `prefers-reduced-motion: reduce` everywhere
- **Icons:** `@phosphor-icons/react` with `size={N}` and `weight="regular"`
- **Fonts:** Geist (sans) and Geist Mono (mono)
- **No external images** — all visuals are CSS, SVG, or procedural
- **`@react-three/postprocessing` is NOT installed** — install before using

## Files to Read First

1. `/Users/arul/ADE/docs/ui-overhaul.md` — The complete spec (1380 lines)
2. `/Users/arul/ADE/apps/desktop/src/renderer/index.css` — CSS with themes, tint system, animations
3. `/Users/arul/ADE/apps/desktop/src/renderer/lib/motion.ts` — Spring configs and animation variants
4. `/Users/arul/ADE/apps/desktop/src/renderer/components/graph/Graph3DScene.tsx` — Current 3D graph implementation
5. `/Users/arul/ADE/apps/desktop/src/renderer/components/graph/WorkspaceGraphPage.tsx` — Graph page with 2D/3D toggle

## What Success Looks Like

**The #1 goal is visual quality.** If the base UI still looks bland and clunky, nothing else matters. Priority order:

1. **Kill the grid of separator lines** — remove 80%+ of `border-b` usage, replace with floating cards, spacing, and subtle shadows. The app should feel like surfaces floating in space, not rows in a table.
2. **Fix both themes** — dark should be rich dark gray (not black), light should be warm off-white (not pure white). Every component must look correct in both.
3. **Add visual depth and premium feel** — glassmorphism, glow effects, gradient accents, proper shadow layering. The app should look like it costs money.
4. **Fix sidebar collapse jitter** — smooth, layout-stable animation.
5. **Fix tab stagger annoyance** — only animate on first visit per session.
6. **Progressive disclosure** — collapsible sections, "show more" toggles, grouped repeated events. Kill the data dumping.
7. **3D Graph polish** — post-processing, camera fly, overlays make it the flagship showcase.
8. **Per-tab visual details** — lane tab heights, file tab dirty dots, alternating history timeline.
9. **Missions board** — kanban columns instead of sidebar list.
10. **SVG flow particles** — animated dots flowing along PR chain connectors and DAG edges.

**The test:** Show the app to someone who has never seen it. If they say "that looks nice" within 3 seconds, the visual overhaul is working. Right now, they would say "looks like every other dev tool."
