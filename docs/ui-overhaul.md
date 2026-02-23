# ADE UI Overhaul: The Complete Plan

> **Status:** Design Specification (Pre-Implementation)
> **Last Updated:** 2026-02-22
> **Decision:** Electric Cyan brand, Balanced density, Selective 3D (Graph + Missions)

---

## Table of Contents

1. [Design Philosophy](#1-design-philosophy)
2. [Brand Identity & Color System](#2-brand-identity--color-system)
3. [Typography](#3-typography)
4. [Theme Architecture (Dark + Light)](#4-theme-architecture)
5. [Per-Tab Visual Identity System](#5-per-tab-visual-identity-system)
6. [Global Component Language](#6-global-component-language)
7. [Motion & Animation System](#7-motion--animation-system)
8. [3D & WebGL Strategy](#8-3d--webgl-strategy)
9. [Tab-by-Tab Detailed Specifications](#9-tab-by-tab-detailed-specifications)
10. [Navigation & Shell Redesign](#10-navigation--shell-redesign)
11. [Micro-Interactions & Moments of Delight](#11-micro-interactions--moments-of-delight)
12. [Performance Budget](#12-performance-budget)
13. [Migration Strategy](#13-migration-strategy)
14. [Implementation Phases](#14-implementation-phases)

---

## 1. Design Philosophy

### Core Principles

ADE is an agentic development environment. The user is the boss; the agents are the team. The UI should feel like walking into a **premium, well-designed office building** — each room (tab) has a distinct purpose and atmosphere, but they all belong to the same company.

**Three words that define ADE's aesthetic: Alive. Precise. Confident.**

- **Alive:** The interface breathes. Backgrounds shift with Perlin noise gradients. Status indicators pulse with spring physics. The app feels inhabited by agents doing work, not displaying static cards.
- **Precise:** Typography is deliberate. Spacing is mathematical. Every pixel serves a purpose. This is a tool for serious work, and it respects the user's intelligence.
- **Confident:** Bold brand color. No hedging with 6 themes. One identity. ADE knows what it is.

### What We're Killing

| Removed | Reason |
|---------|--------|
| 6 novelty themes (e-paper, bloomberg, rainbow, sky, pats, github) | Fragments brand identity. Nobody knows what ADE looks like. |
| System fonts (SF Pro, Segoe UI) | Generic. Every Electron app looks the same. |
| 10-11px body text | Too small. Feels utilitarian, not premium. |
| Flat CSS background animations | Too subtle to notice. Wasted potential. |
| Generic card-everywhere pattern | Every surface looks the same. No hierarchy. |
| Serif font stack | Not appropriate for a dev/agent tool. |

### What We're Keeping

| Kept | Reason |
|------|--------|
| Per-tab ambient backgrounds | Strong foundation. Needs to be elevated, not replaced. |
| Framer Motion layout animations | Already using `layoutId` for tab indicator. Expand this pattern. |
| PaneTilingLayout system | Power users need resizable panes. This works well. |
| CSS custom properties architecture | Clean theme switching. Just changing the values. |
| `data-theme` attribute system | Keeps the same mechanism, just fewer themes. |
| Three.js + R3F (already installed) | `three@0.183.0`, `@react-three/fiber@8.17.10`, `@react-three/drei@9.122.0` already in package.json. |
| Reduced motion support | Accessibility is non-negotiable. |

---

## 2. Brand Identity & Color System

### The Brand Color: Electric Cyan

**Primary Cyan:** `#06d6a0` — a teal-shifted cyan that sits between green and blue. Distinctive, energetic, reads well on both dark and light backgrounds.

This is NOT Tailwind's cyan-500. This is a custom value tuned to:
- Stand apart from Cursor (purple), Linear (violet), GitHub (blue), Warp (dark teal)
- Feel electric and intelligent without being cold
- Pair naturally with warm accents per tab

**Brand Color Scale:**

```
--cyan-50:  #ecfdf5
--cyan-100: #d1fae5
--cyan-200: #a7f3d0
--cyan-300: #6ee7b7
--cyan-400: #34d399
--cyan-500: #06d6a0  ← PRIMARY
--cyan-600: #05b384
--cyan-700: #049068
--cyan-800: #036b4e
--cyan-900: #024734
--cyan-950: #012a1f
```

### Neutral Scale (Zinc-based, custom-tuned)

```
--neutral-0:   #ffffff
--neutral-25:  #fafafa
--neutral-50:  #f5f5f6
--neutral-100: #e4e4e7
--neutral-200: #d4d4d8
--neutral-300: #a1a1aa
--neutral-400: #71717a
--neutral-500: #52525b
--neutral-600: #3f3f46
--neutral-700: #27272a
--neutral-800: #1c1c1f
--neutral-850: #141416
--neutral-900: #0f0f11
--neutral-950: #09090b
```

### Per-Tab Tint Colors

Each tab gets a **tint color** applied at 5-10% opacity over surfaces. These are NOT full palette replacements — they're a subtle hue wash that gives each room its atmosphere.

| Tab | Tint Color | Hex | Reasoning |
|-----|-----------|-----|-----------|
| Run | Brand Cyan | `#06d6a0` | Home base. Pure ADE identity. |
| Lanes | Warm Amber | `#f59e0b` | Industrial production energy. Assembly line warmth. |
| Files | Neutral (no tint) | — | Let the code be the color. Clean library. |
| Work | Terminal Green | `#22c55e` | Phosphor heritage. Closest to the machine. |
| Conflicts | Tension Red | `#ef4444` | Urgency. Resolves to green on fix. |
| Graph | Deep Indigo | `#6366f1` | Spatial. Architectural. Blueprint room. |
| PRs | Emerald | `#10b981` | Outbound/shipping. Green = go. |
| History | Warm Sepia | `#d97706` | Archive warmth. Chronicle feel. |
| Automations | Engine Orange | `#f97316` | Mechanical. Engine heat. |
| Missions | Deep Blue | `#3b82f6` | Strategic. War room. Command & control. |
| Settings | Neutral (no tint) | — | Utilitarian. No decoration needed. |

### Semantic Colors (Shared Across Themes)

```
--color-success:  #22c55e   (green-500)
--color-warning:  #f59e0b   (amber-500)
--color-error:    #ef4444   (red-500)
--color-info:     #3b82f6   (blue-500)

--color-diff-add: #22c55e
--color-diff-del: #ef4444
--color-diff-hunk: #3b82f6
```

### Status Colors (Agent/Mission States)

```
Queued:     --neutral-400  (gray)
Planning:   #3b82f6        (blue)
Review:     #06b6d4        (cyan)
Running:    #22c55e        (green)
Attention:  #f59e0b        (amber)
Done:       #10b981        (emerald)
Failed:     #ef4444        (red)
Canceled:   --neutral-500  (dark gray)
```

---

## 3. Typography

### Font Stack

**Kill:** SF Pro Text, Segoe UI, system-ui, Source Serif 4
**Replace with:**

```css
--font-sans: "Geist", -apple-system, BlinkMacSystemFont, sans-serif;
--font-mono: "Geist Mono", "JetBrains Mono", ui-monospace, monospace;
```

**Why Geist:** Designed by Vercel specifically for developer tools. Excellent legibility at small sizes. Modern geometric feel without being cold. The mono variant is equally refined. This font pair alone will elevate the entire app.

**Installation:** `npm install geist` (provides both Geist and Geist Mono as variable fonts).

### Type Scale

All sizes bumped up from current. Minimum body text is 13px.

```
--text-2xs:  11px  / 1.45  (metadata, timestamps, tertiary labels)
--text-xs:   12px  / 1.5   (chips, badges, compact labels)
--text-sm:   13px  / 1.5   (body text, form labels, descriptions)
--text-base: 14px  / 1.55  (primary content, list items)
--text-lg:   16px  / 1.5   (section headers, pane titles)
--text-xl:   18px  / 1.4   (page titles)
--text-2xl:  22px  / 1.3   (hero numbers, key metrics)
--text-3xl:  28px  / 1.2   (dashboard display numbers)
```

### Type Treatments

**Pane titles:** `text-xs font-medium tracking-widest uppercase text-muted-fg`
(Keep current monospace uppercase pattern — it works. Just bump to 12px.)

**Body text:** `text-sm text-fg leading-relaxed`
(13px, comfortable reading.)

**Metric numbers:** `font-mono text-2xl font-semibold tracking-tight`
(Big, confident, monospace. For dashboards.)

**Code/terminal:** `font-mono text-sm`
(13px mono. Readable.)

**Timestamps:** `font-mono text-2xs text-muted-fg`
(11px, subtle, consistent.)

---

## 4. Theme Architecture

### Two Themes Only

**Dark (default):** `data-theme="dark"`
**Light:** `data-theme="light"`

No other themes. This IS ADE.

### Dark Theme (Default)

The "after-hours office." LED-lit, focused, the cyan glows against dark surfaces.

```css
[data-theme="dark"] {
  /* Backgrounds */
  --color-bg:               #0f0f11;     /* neutral-900 */
  --color-surface:          #141416;     /* neutral-850 */
  --color-surface-raised:   #1c1c1f;     /* neutral-800 */
  --color-surface-recessed: #09090b;     /* neutral-950 */
  --color-surface-overlay:  #1c1c1f;     /* neutral-800 */
  --color-card:             #18181b;     /* between 850 and 800 */

  /* Foreground */
  --color-fg:               #e4e4e7;     /* neutral-100 */
  --color-card-fg:          #e4e4e7;
  --color-muted-fg:         #71717a;     /* neutral-400 */

  /* Accent */
  --color-accent:           #06d6a0;     /* brand cyan */
  --color-accent-fg:        #012a1f;     /* dark on cyan */
  --color-accent-muted:     rgba(6, 214, 160, 0.12); /* subtle tint */

  /* Borders */
  --color-border:           #27272a;     /* neutral-700 */
  --color-muted:            #27272a;

  /* Glow */
  --color-glow:             rgba(6, 214, 160, 0.15);

  /* Shadows */
  --shadow-card:            0 1px 3px -1px rgba(0, 0, 0, 0.3);
  --shadow-float:           0 8px 24px -8px rgba(0, 0, 0, 0.5);
  --shadow-inset:           inset 0 1px 2px rgba(0, 0, 0, 0.2);
  --shadow-panel:           0 2px 8px -2px rgba(0, 0, 0, 0.3);

  /* Gradients */
  --gradient-surface:       linear-gradient(180deg, #141416, #0f0f11);
  --gradient-panel:         linear-gradient(180deg, #1c1c1f 0%, #141416 100%);
}
```

### Light Theme

The "morning office." Sunlit, clean, the cyan becomes a crisp accent.

```css
[data-theme="light"] {
  /* Backgrounds */
  --color-bg:               #f5f5f6;     /* neutral-50 */
  --color-surface:          #fafafa;     /* neutral-25 */
  --color-surface-raised:   #ffffff;     /* pure white */
  --color-surface-recessed: #e4e4e7;     /* neutral-100 */
  --color-surface-overlay:  #ffffff;
  --color-card:             #ffffff;

  /* Foreground */
  --color-fg:               #0f0f11;     /* neutral-900 */
  --color-card-fg:          #0f0f11;
  --color-muted-fg:         #52525b;     /* neutral-500 */

  /* Accent */
  --color-accent:           #049068;     /* darker cyan for contrast */
  --color-accent-fg:        #ffffff;
  --color-accent-muted:     rgba(4, 144, 104, 0.08);

  /* Borders */
  --color-border:           #d4d4d8;     /* neutral-200 */
  --color-muted:            #e4e4e7;

  /* Glow */
  --color-glow:             rgba(4, 144, 104, 0.1);

  /* Shadows */
  --shadow-card:            0 1px 3px -1px rgba(0, 0, 0, 0.06);
  --shadow-float:           0 8px 24px -8px rgba(0, 0, 0, 0.12);
  --shadow-inset:           inset 0 1px 2px rgba(0, 0, 0, 0.04);
  --shadow-panel:           0 2px 8px -2px rgba(0, 0, 0, 0.06);

  /* Gradients */
  --gradient-surface:       linear-gradient(180deg, #fafafa, #f5f5f6);
  --gradient-panel:         linear-gradient(180deg, #ffffff 0%, #fafafa 100%);
}
```

### Per-Tab Tint Application

Each tab injects its tint via a CSS class on the main content area:

```css
/* Applied to the main content container when a tab is active */
.tab-tint-missions {
  --tab-tint: 219, 39%;     /* Deep blue HSL */
  --tab-tint-rgb: 59, 130, 246;
}
.tab-tint-lanes {
  --tab-tint: 38, 92%;      /* Amber HSL */
  --tab-tint-rgb: 245, 158, 11;
}
/* etc. for each tab */
```

These variables are consumed by:
- Background ambient layer: `background: radial-gradient(..., rgba(var(--tab-tint-rgb), 0.04), transparent)`
- Active interactive elements within the tab
- The hero visualization's dominant hue
- Subtle 1px border tint on primary surfaces: `border-color: rgba(var(--tab-tint-rgb), 0.08)`

---

## 5. Per-Tab Visual Identity System

Each tab is a "room" in the ADE office. Every room shares the same furniture (components), but has its own wallpaper (ambient background), lighting (tint), and centerpiece (hero visualization).

### The Three Layers of Tab Identity

```
Layer 1: AMBIENT BACKGROUND
├── Full-bleed canvas behind all content
├── GPU-rendered fragment shader OR CSS gradient
├── Perlin noise base with tab-specific pattern overlay
├── Opacity: 0.15 (dark) / 0.08 (light)
├── Responds to prefers-reduced-motion
└── Cross-fades on tab switch (400ms)

Layer 2: SURFACE TINT
├── Subtle hue wash on card/surface backgrounds
├── rgba(var(--tab-tint-rgb), 0.03) on cards
├── rgba(var(--tab-tint-rgb), 0.06) on hover states
├── Accent-colored active states for tab-specific controls
└── 1px border tint on primary pane container

Layer 3: HERO VISUALIZATION
├── The signature visual element of the tab
├── Functional — displays real data
├── The most visually striking element on the page
├── Each tab has exactly ONE hero
└── Described in detail per-tab below
```

### Tab Switch Transitions

When switching tabs:
1. Current ambient background fades out (200ms ease-out)
2. New ambient background fades in (300ms ease-in, 100ms delay)
3. Content area: existing content fades down 4px + fades out (150ms)
4. New content: staggers in from bottom (children offset by 30ms each, spring physics)
5. Sidebar active indicator slides to new position (Framer Motion `layoutId`, already implemented)

---

## 6. Global Component Language

### Surface Hierarchy

Four elevation levels, consistently applied everywhere:

```
Level 0: RECESSED    bg-surface-recessed   (tiling surface, gutters)
Level 1: BASE        bg-bg                 (page background)
Level 2: RAISED      bg-surface-raised     (topbar, cards, panes)
Level 3: FLOATING    bg-surface-overlay     (dropdowns, modals, tooltips, command palette)
```

Each level gets progressively lighter (dark theme) or more shadowed (light theme).

### Pane Treatment

Replace the current `.ade-floating-pane` generic card with a more refined treatment:

```css
.ade-pane {
  background: var(--color-card);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);   /* 4px — tight, professional */

  /* Liquid glass inner refraction — inspired by Unseen's refraction work */
  box-shadow:
    var(--shadow-card),
    inset 0 1px 0 rgba(255, 255, 255, 0.03);  /* top edge highlight */

  transition: border-color 150ms ease, box-shadow 150ms ease;
}

.ade-pane:hover {
  border-color: rgba(var(--tab-tint-rgb), 0.15);
}

.ade-pane:focus-within {
  border-color: rgba(var(--tab-tint-rgb), 0.25);
  box-shadow:
    var(--shadow-card),
    inset 0 1px 0 rgba(255, 255, 255, 0.03),
    0 0 0 1px rgba(var(--tab-tint-rgb), 0.08);
}
```

### Button System

Three variants, refined:

```
PRIMARY:   bg-accent text-accent-fg
           hover: brightness-110, translateY(-1px)
           active: translateY(0), scale(0.98)
           Spring: stiffness 400, damping 25

SECONDARY: bg-transparent border border-border text-fg
           hover: bg-muted/30, border-color shift toward tab-tint
           active: scale(0.98)

GHOST:     bg-transparent text-muted-fg
           hover: text-fg, bg-muted/20
           active: scale(0.98)
```

All buttons get a 1px `translateY` on hover (float up) and `scale(0.98)` on active (press down). This is the "tactile feedback" principle — every click feels physical.

### Input Fields

```css
.ade-input {
  background: var(--color-surface-recessed);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);   /* 3px */
  padding: 6px 10px;
  font-size: 13px;
  color: var(--color-fg);
  transition: border-color 150ms, box-shadow 150ms;
}

.ade-input:focus {
  border-color: var(--color-accent);
  box-shadow: 0 0 0 2px var(--color-accent-muted);
  outline: none;
}
```

### Chips & Badges

```css
.ade-chip {
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.02em;
  padding: 2px 8px;
  border-radius: 99px;           /* pill shape */
  background: var(--color-muted);
  color: var(--color-muted-fg);
  border: 1px solid transparent;
}

/* Status variants use semantic colors at low opacity */
.ade-chip-success {
  background: rgba(34, 197, 94, 0.12);
  color: #22c55e;
  border-color: rgba(34, 197, 94, 0.2);
}
/* Same pattern for warning, error, info */
```

### Empty States

Every tab/pane must have a composed empty state. No generic "Nothing here" text.

```
Structure:
┌─────────────────────────────────┐
│                                 │
│        [Contextual Icon]        │  48px, muted-fg/30 opacity
│                                 │
│      Primary message (lg)       │  text-lg font-medium text-fg
│   Secondary description (sm)    │  text-sm text-muted-fg max-w-[45ch]
│                                 │
│      [ Action Button ]          │  Primary variant, if applicable
│                                 │
└─────────────────────────────────┘
```

Each empty state is **contextual to its room**:
- Missions empty: "No missions running. Your agents are standing by." + "Start a Mission" CTA
- Files empty: "Open a file from the tree to begin editing."
- Graph empty: "Create lanes to see your workspace graph."
- History empty: "No operations recorded yet. Activity will appear here as you work."

---

## 7. Motion & Animation System

### Physics Constants

All interactive motion uses spring physics. No linear easing. No CSS `ease-in-out` for interactive elements.

```typescript
// motion.ts — shared spring configs
export const springs = {
  // Snappy — buttons, toggles, quick state changes
  snappy: { type: "spring", stiffness: 500, damping: 30 },

  // Default — most UI transitions
  default: { type: "spring", stiffness: 300, damping: 25 },

  // Gentle — page transitions, large movements
  gentle: { type: "spring", stiffness: 150, damping: 20 },

  // Bouncy — celebratory moments, completion animations
  bouncy: { type: "spring", stiffness: 400, damping: 15 },

  // Slow — ambient background transitions, camera movements
  slow: { type: "spring", stiffness: 50, damping: 15 },
} as const;
```

### Animation Categories

**1. Ambient (Always Running)**
- Tab background noise gradients: continuous, 20-30s cycle
- Status indicator pulses: 2s cycle, spring-based opacity
- Agent activity breathing: 4s cycle on active workers
- Performance: GPU-only properties (opacity, transform), isolated components

**2. Transitional (On State Change)**
- Tab switches: 300-400ms cross-fade + content stagger
- Pane resize: real-time, no animation (direct manipulation)
- Modal open/close: scale(0.96) + opacity fade, 200ms spring
- Toast enter/exit: translateX slide, 300ms spring
- List item add/remove: height + opacity, `AnimatePresence`

**3. Interactive (On User Action)**
- Button hover: translateY(-1px), 100ms
- Button press: scale(0.98), 60ms
- Card hover: border-color shift, 150ms
- Drag start: scale(1.02) + shadow increase
- Drag end: spring back to position

**4. Celebratory (Rare, Earned)**
- Mission complete: particle burst + HUD flash (2s, then gone)
- All tests pass: emerald ripple across Run tab background (3s)
- PR merged: card dissolves with satisfaction animation (1s)
- First-time events: one-time reward animations (described per-tab)

### Stagger Pattern

All lists and grids use staggered entry:

```typescript
const containerVariants = {
  hidden: {},
  visible: {
    transition: { staggerChildren: 0.03, delayChildren: 0.05 }
  }
};

const itemVariants = {
  hidden: { opacity: 0, y: 6 },
  visible: {
    opacity: 1,
    y: 0,
    transition: springs.default
  }
};
```

30ms stagger per child. Fast enough to not feel slow, slow enough to see the cascade.

### Reduced Motion

When `prefers-reduced-motion: reduce`:
- All ambient animations stop
- Transitions become instant (0ms duration)
- Stagger becomes simultaneous
- 3D scenes render but don't animate
- Status indicators use color-only (no pulse)

---

## 8. 3D & WebGL Strategy

### Already Installed

```json
{
  "three": "^0.183.0",
  "@react-three/fiber": "^8.17.10",
  "@react-three/drei": "^9.122.0",
  "maath": "^0.10.8"
}
```

No new dependencies needed for 3D. Everything is already in `package.json`.

### Where 3D Lives

**Full Three.js scenes (2 tabs):**
1. **Graph Tab** — Force-directed 3D node graph (the flagship visual)
2. **Missions Tab** — 2.5D DAG visualization with depth

**Inline 3D elements (lightweight):**
3. **Run Tab** — Small 3D status orb (ambient, decorative)
4. **Onboarding** — Fly-through camera (one-time experience)

**Everything else: CSS/Framer Motion only.** No unnecessary 3D.

### Graph Tab: 3D Force Graph (Flagship)

**Replaces:** Current `@xyflow/react` 2D graph
**Technology:** `@react-three/fiber` + custom force simulation via `maath`

**Scene Composition:**
```
Canvas (full pane, transparent background)
├── Camera (perspective, FOV 60, subtle auto-drift)
├── Environment
│   ├── Ambient light (0.3 intensity)
│   ├── Point light at camera position (0.8 intensity, follows camera)
│   └── Fog (matches bg color, near: 30, far: 80)
├── Node Meshes
│   ├── Sphere geometry (radius based on importance)
│   ├── MeshStandardMaterial (emissive = status color, roughness 0.3, metalness 0.7)
│   ├── Glow ring (sprite, additive blending) per active node
│   └── Label (Billboard text, Drei's <Text>)
├── Edge Lines
│   ├── Line2 geometry (drei's <Line>)
│   ├── Dashed pattern for "blocked" edges
│   ├── Animated particle flow along edge (direction = dependency)
│   └── Opacity based on relevance to selected node
├── Post-processing (drei's <EffectComposer>)
│   ├── Bloom (intensity 0.4, threshold 0.8, radius 0.6)
│   ├── ChromaticAberration (offset: [0.001, 0.001], edges only)
│   └── Vignette (darkness 0.3)
└── Controls
    ├── OrbitControls (damping, auto-rotate when idle)
    ├── Click-to-focus (camera flies to node, DOF on background)
    └── Minimap (2D overlay, top-right corner, CSS-rendered)
```

**Interactions:**
- **Hover node:** Node scales 1.3x, emissive increases, label becomes fully opaque, connected edges brighten
- **Click node:** Camera smoothly flies to node (Gemini-style choreography, 800ms spring). Background nodes blur. Detail panel slides in from right.
- **Click away:** Camera returns to overview position (1000ms gentle spring). All nodes restore.
- **Drag node:** Node follows cursor in 3D space. Connected edges stretch with spring physics.
- **Scroll:** Zoom in/out with inertia.
- **Idle (10s no interaction):** Camera begins slow auto-orbit (0.1 rad/s).

**Performance:**
- Max 200 nodes before switching to instanced rendering
- Edge particles only visible within camera frustum
- Post-processing disabled on machines with < 4GB GPU memory (detect via `renderer.capabilities`)
- Fallback: if WebGL context lost, show 2D xyflow graph (current implementation)

### Missions Tab: 2.5D DAG

**Enhances:** Current `OrchestratorDAG.tsx` (CSS-only)
**Technology:** CSS `perspective` + `transform-style: preserve-3d` + Framer Motion

NOT a full Three.js scene. This is CSS 3D transforms for a convincing depth effect without the overhead.

```css
.dag-container {
  perspective: 1200px;
  perspective-origin: 50% 40%;
}

.dag-node {
  transform-style: preserve-3d;
  /* Nodes closer to "camera" (top of pipeline) are slightly larger */
  /* Each row gets transform: translateZ(calc(var(--depth) * -20px)) */
}

.dag-node:hover {
  transform: translateZ(10px) scale(1.05);
  box-shadow: 0 12px 32px -8px rgba(var(--tab-tint-rgb), 0.25);
}
```

**Enhancements over current:**
- Depth-based sizing (earlier steps slightly larger)
- Hover pops node forward in Z-space
- Connection lines rendered as SVG with animated dash-offset (flow direction)
- Active/running nodes have a breathing glow ring
- Completed nodes have a checkmark that draws itself (SVG line-draw animation)
- Failed nodes have a brief red pulse on failure, then static red ring

---

## 9. Tab-by-Tab Detailed Specifications

### 9.1 Run Tab (The Lobby)

**Route:** `/project` | **Component:** `ProjectHomePage.tsx`
**Tint:** Brand Cyan `#06d6a0` | **Vibe:** Command center, live dashboard

**Ambient Background:**
Replace current radar sweep with a Perlin noise gradient in cyan tones. Slow-moving, organic, like looking at deep water from above. The noise field should have 2-3 octaves with very low frequency (the blobs are large and slow).

**Layout Redesign:**
```
┌──────────────────────────────────────────────────────────────┐
│ PROJECT NAME                                    [Quick Add +]│
├─────────────────────────┬────────────────────────────────────┤
│                         │                                    │
│  PROCESSES              │  HEALTH DASHBOARD                  │
│  ┌──────────────────┐   │  ┌────────────────────────────┐    │
│  │ Process 1  ● RUN │   │  │  3 Running  1 Stopped      │    │
│  │ Process 2  ● RUN │   │  │  12 Tests   100% Passing   │    │
│  │ Process 3  ○ OFF │   │  │  2 Lanes    0 Conflicts    │    │
│  └──────────────────┘   │  └────────────────────────────┘    │
│                         │                                    │
│  TESTS                  │  RECENT ACTIVITY                   │
│  ┌──────────────────┐   │  ┌────────────────────────────┐    │
│  │ Suite 1  ✓ Pass  │   │  │  10:32  Push to main       │    │
│  │ Suite 2  ✓ Pass  │   │  │  10:28  Tests passed       │    │
│  │ Suite 3  ✗ Fail  │   │  │  10:25  PR #42 merged      │    │
│  └──────────────────┘   │  └────────────────────────────┘    │
│                         │                                    │
├─────────────────────────┴────────────────────────────────────┤
│ CONFIG  (collapsible, tucked at bottom)                      │
└──────────────────────────────────────────────────────────────┘
```

**Hero Element:** The Health Dashboard metrics. Big monospace numbers (`text-2xl font-mono`). Each metric is a single value with a label below it. No cards wrapping individual metrics — use negative space and a single container row.

**Key Changes:**
- Process status rows: departure-board style. When status changes, the old value slides up and new value slides down (like an airport flip board). Use Framer Motion `AnimatePresence` with `mode="popLayout"`.
- Test results: horizontal bar showing pass/fail ratio. Green fills from left. Animated on change.
- Recent activity: simple chronological list, newest first, no wrapping cards. Just `border-b` separators.
- Config section: collapsed by default. Expand with a smooth height animation. Most users don't need this daily.

**Empty State:** "No project configured. Add processes and test suites to get started." with a Setup button.

---

### 9.2 Lanes Tab (The Production Floor)

**Route:** `/lanes` | **Component:** `LanesPage.tsx`
**Tint:** Warm Amber `#f59e0b` | **Vibe:** Industrial, active, parallel tracks

**Ambient Background:**
Horizontal flowing lines at different speeds (already have `ade-tab-bg-lanes` with racing lines). Elevate: increase contrast, make the lines slightly amber-tinted, add a subtle parallax effect where lines at different "depths" move at different speeds (3 layers, CSS only).

**Layout:** Keep existing PaneTilingLayout (5-pane). This tab is complex and power users have customized their layouts. Don't break that.

**Key Changes:**
- **Lane tabs:** Currently cramped. Add breathing room. Each lane tab should be 36px tall (up from ~28px). The active lane tab gets a 2px bottom border in amber instead of accent color.
- **Lane stack graph (left pane):** The tree visualization should have smoother connecting lines. Use SVG paths with rounded corners instead of sharp angles. Add a subtle pulse animation on the lane that's currently being worked on.
- **Diff pane:** Monaco editor stays. But the pane header should show file path as a breadcrumb with clickable segments. Diff stats (`+12 -3`) should use colored numbers (green/red).
- **Conflict chips:** Keep the current animated badges (they're well-done). Just update colors to match new semantic palette.

**Empty State:** "No lanes created yet. Lanes let you work on multiple features in parallel." with "Create Lane" CTA.

---

### 9.3 Files Tab (The Library)

**Route:** `/files` | **Component:** `FilesPage.tsx`
**Tint:** None (neutral) | **Vibe:** Quiet, organized, code-focused

**Ambient Background:**
Almost nothing. A very faint diagonal grid pattern at 3% opacity. This room is about the content. The code IS the visual.

**Layout:** Keep existing 3-pane (tree | editor | search). This is a familiar pattern.

**Key Changes:**
- **File tree icons:** Replace current colored dots with refined file-type icons. Use a consistent 14px size. Color-code by language but desaturated (not neon — muted tones).
- **File tree indentation:** Currently uses vertical lines. Refine: make them 1px, `border-border/20` opacity, with rounded corners at junctions.
- **Editor tabs:** Slightly taller (32px). Active tab: `bg-card` with bottom border in accent. Inactive: `bg-transparent`. Dirty indicator: small cyan dot (not a bullet character).
- **Quick open modal:** Full command palette treatment. Same as the global Cmd+K palette in styling. Large, centered, with fuzzy search and keyboard navigation.
- **File open animation:** When a file opens, the editor content fades in from `opacity: 0` over 150ms. Subtle, not flashy. Like pulling a book off a shelf.

**Empty State:** "Select a file from the tree to view and edit." (centered in editor pane, with a keyboard shortcut hint for quick-open).

---

### 9.4 Work Tab (The Workshop)

**Route:** `/work` | **Component:** `TerminalsPage.tsx`
**Tint:** Terminal Green `#22c55e` | **Vibe:** Raw, hands-on, close to the machine

**Ambient Background:**
The "code rain" pattern (already exists) but elevated. Make it green-tinted. Increase contrast slightly. Add a very subtle CRT scanline effect (1px horizontal lines at 2% opacity, green-tinted). This tab should feel like you've stepped closer to the hardware.

**Layout:** Keep existing session list | terminal | details pane.

**Key Changes:**
- **Terminal rendering:** xterm.js stays. But the terminal container should have a slightly darker background than other tabs (`bg-surface-recessed` forced, not `bg-card`). This creates the sense of physical depth — the terminal is recessed into the surface.
- **Session list:** Each session row should show a small activity sparkline (last 30s of output activity). Just a tiny 40px-wide bar chart showing output volume. Monochrome green.
- **Active terminal border:** When a terminal is actively receiving output, its pane border should have a faint green glow that pulses with output frequency. Not on every character — batch it per second.
- **Terminal attention:** The amber/green dot system is good. Keep it. Just make sure it uses the new status colors.

**Empty State:** "No terminal sessions. Start a new session to begin working." with "New Session" button styled with a terminal-green accent.

---

### 9.5 Conflicts Tab (The Situation Room)

**Route:** `/conflicts` | **Component:** `ConflictsPage.tsx`
**Tint:** Tension Red `#ef4444` | **Vibe:** Urgency, resolution, progress

**Ambient Background:**
Diagonal tension lines (already exists as `ade-tab-bg-conflicts`). Elevate: make lines red-tinted. Add a "breathing" effect where the line spacing subtly contracts and expands (simulating tension). When no conflicts exist, the background should be nearly invisible (2% opacity).

**Key Changes:**
- **Risk Matrix:** Keep the animated pulse system (it's excellent). Update colors to new semantic palette. Add a gradient background to the matrix that shifts from red (high risk) to green (low risk) across the diagonal.
- **Merge workflow:** The tab system (Merge One / Merge Multiple) should use the same tab component as everywhere else. Consistent height, consistent animation.
- **Resolution progress:** When a conflict is being resolved, show a progress indicator that transitions the tint from red toward green. The ambient background should respond too — tension lines relax (spacing increases, opacity decreases) as conflicts are resolved.
- **Monaco diff view:** Keep as-is. The conflict markers (ours/theirs highlighting) are well-implemented.

**Empty State:** "No conflicts detected. Your branches are clean." with a relaxed green tint replacing the red tint. The tension lines should be gone. The room relaxes when there's nothing to resolve.

---

### 9.6 Graph Tab (The Blueprint Room)

**Route:** `/graph` | **Component:** `WorkspaceGraphPage.tsx`
**Tint:** Deep Indigo `#6366f1` | **Vibe:** Spatial, architectural, the flagship 3D experience

**Ambient Background:**
None needed — the 3D scene IS the background. The Three.js canvas fills the entire pane with a transparent background, and the scene's fog matches `--color-bg`. Stars/particles from the current constellation background should be incorporated INTO the 3D scene as distant background particles.

**This is the showcase tab.** See Section 8 for full 3D specification.

**Overlay UI (HTML on top of canvas):**
- **Minimap:** Top-right corner, 120x80px, semi-transparent card. Shows the full graph in 2D with a viewport rectangle indicating current camera position.
- **Controls:** Bottom-right, small icon buttons for: zoom-to-fit, toggle auto-rotate, switch to 2D fallback.
- **Search:** Top-left, floating search input to find and fly-to specific nodes.
- **Node detail panel:** Slides in from right when a node is clicked. 300px wide, `bg-surface-overlay` with the pane treatment. Shows lane name, branch, status, recent commits, links to other tabs.

**Empty State:** The 3D scene shows an empty void with distant particles slowly drifting. A centered message: "Create lanes to build your workspace graph." The void itself is beautiful — indigo fog with twinkling particles.

---

### 9.7 PRs Tab (The Shipping Dock)

**Route:** `/prs` | **Component:** `PRsPage.tsx`
**Tint:** Emerald `#10b981` | **Vibe:** Outbound, tracking, chain visualization

**Ambient Background:**
Gentle upward-flowing gradient (like heat shimmer). Emerald-tinted at very low opacity. The "launch pad" concept from current `ade-tab-bg-prs` but refined to be more subtle and directional (upward = outbound/shipping).

**Layout:** Keep 2-pane (PR list | PR detail). The split works.

**Key Changes:**
- **Stacked chain visualization:** This is unique to ADE. Make it the hero. The chain view should use SVG connecting lines with rounded corners and animated flow particles moving upward (toward merge). Each PR in the chain is a node with clear status coloring.
- **PR state chips:** Redesigned with the new chip system.
  - Draft: `bg-purple-500/12 text-purple-400 border-purple-500/20`
  - Open: `bg-blue-500/12 text-blue-400 border-blue-500/20`
  - Merged: `bg-emerald-500/12 text-emerald-400 border-emerald-500/20`
  - Closed: `bg-neutral-500/12 text-neutral-400 border-neutral-500/20`
- **CI checks:** Inline indicators (small dots) instead of text badges. Green dot = passing, red dot = failing, amber dot = pending. Hover to see details.
- **Merge animation:** When a PR merges, the card briefly flashes emerald, the chain visualization updates with the node dissolving upward (like a package leaving the dock), and the rest of the chain shifts up smoothly.

**Empty State:** "No pull requests yet. PRs will appear here when you push branches." with emerald tint.

---

### 9.8 History Tab (The Archive)

**Route:** `/history` | **Component:** `HistoryPage.tsx`
**Tint:** Warm Sepia `#d97706` | **Vibe:** Timeline, chronicle, retrospective

**Ambient Background:**
Concentric circular arcs (already exists as `ade-tab-bg-history`). Keep but refine: warm amber tint, slower rotation (90s cycle), reduced opacity. Should feel like the hands of a clock, or rings in a tree trunk.

**Layout:** Keep 2-pane (timeline | detail).

**Key Changes:**
- **Timeline:** The left pane should be a true vertical timeline with a center line and events branching left/right alternately. Each event is a dot on the line with a card extending to the side. The line should be 1px, `border-border/40`. Dots are 8px circles colored by operation type.
- **Timeline scroll:** As you scroll, events that enter the viewport fade in with a 100ms stagger. Events leaving fade to 50% opacity. The timeline line draws itself as you scroll (SVG stroke-dashoffset animation tied to scroll position).
- **Operation detail:** The right pane should show formatted metadata. JSON displayed with syntax highlighting (not raw monospace dump). Timestamps formatted as both relative ("2h ago") and absolute ("Feb 22, 2026 at 10:32 AM").

**Empty State:** "No history yet. Operations will be recorded as you work." The timeline line is present but empty — just a fading vertical line with a subtle pulse at the top (waiting for the first event).

---

### 9.9 Automations Tab (The Engine Room)

**Route:** `/automations` | **Component:** `AutomationsPage.tsx`
**Tint:** Engine Orange `#f97316` | **Vibe:** Mechanical, systematic, self-running

**Ambient Background:**
Rotating gears (already exists as `ade-tab-bg-automations`). This is perfect for the theme. Refine: add a second gear layer at a different scale and speed. Make gears orange-tinted. Add a very subtle "heat haze" shimmer effect on the background.

**Key Changes:**
- **Automation cards:** Each automation rule should be displayed as a "machine" — a horizontal flow showing: TRIGGER (left, amber icon) -> CONDITION (center, neutral) -> ACTION (right, orange icon). Connected by a thin line with animated flow particles (tiny dots moving left to right).
- **Run history:** Below each automation, a compact sparkline showing last 20 executions. Green dots for success, red for failure. Hovering shows a tooltip with execution details.
- **Natural language input:** The "create automation" dialog should have a prominent text input at the top: "Describe what should happen..." with AI parsing. The typed text should transform into the trigger-condition-action flow in real time as the AI parses it.

**Empty State:** The gears in the background are visible but still (no rotation). Message: "No automations configured. Describe a rule and ADE will run it for you." When the first automation is created, the gears start turning.

---

### 9.10 Missions Tab (The War Room)

**Route:** `/missions` | **Component:** `MissionsPage.tsx`
**Tint:** Deep Blue `#3b82f6` | **Vibe:** Strategic, high-stakes, command center

**Ambient Background:**
Topographic contour map pattern in deep blue. Faintly glowing lines on a dark background, like a strategic planning surface. Slow-moving Perlin noise distorts the contour lines subtly. This is NOT the current nebula aurora — it's more structured, more military-strategic.

**Sub-tabs (5 internal tabs):**

**Board View (Status):**
- Kanban columns for mission states (Queued, Planning, Running, Done, Failed)
- Mission cards: condensed, 2-line summary. Status dot + title + elapsed time.
- Active missions have a faint breathing glow on their card border (blue).
- Dragging missions between columns should be supported (manual override).

**Execution Plan:**
- 2.5D DAG visualization (see Section 8).
- Nodes colored by executor type (Claude: blue, Codex: emerald, Shell: amber, Manual: neutral).
- Active node has a spinning ring around it (thin, blue, 4s rotation).
- Completed nodes have a check that draws itself.

**Activity Feed:**
- Keep the category dropdown filter (good decision to replace 12 buttons).
- Timeline entries should stagger in as they arrive (real-time).
- Error entries get a red left border and slightly red-tinted background.
- Warning entries get amber treatment.

**Agent Channels:**
- Slack-style chat interface (already implemented).
- Refine: channel sidebar should have tighter spacing. Active channels get a green dot. Unread indicator (cyan dot with count).
- Message bubbles: coordinator messages full-width, worker messages indented. No speech bubble chrome — just left border (2px, color-coded by agent).
- Input field: monospace, dark background, with a "Send to [Agent Name]" placeholder.

**Usage Dashboard:**
- Big metric cards at top (tokens, cost, duration). Monospace numbers, `text-2xl`.
- Model breakdown: horizontal stacked bar chart, not just text. Claude variants in blue spectrum, Codex in emerald spectrum.
- Per-mission filter: toggle to scope metrics to selected mission.

**Empty State (Board):** "No missions yet. Missions coordinate your AI agents to accomplish complex tasks." with "Start Mission" CTA. The topographic background is dimmed to near-invisible.

---

### 9.11 Settings Tab (The Back Office)

**Route:** `/settings` | **Component:** `SettingsPage.tsx`
**Tint:** None | **Vibe:** Administrative, clean, functional

**Ambient Background:**
Blueprint grid (already exists). Keep at very low opacity (5%). This room is utilitarian.

**Key Changes:**
- **Theme selector:** Replace 6-theme grid with a simple toggle: Dark | Light. Two cards side by side, each showing a mini-preview of the theme. Selected theme has a cyan border.
- **Section navigation:** The 7 sections in the left sidebar are good. Refine icon sizes to 16px. Add a subtle transition when switching sections (content fade, 150ms).
- **Form styling:** All inputs, toggles, and selectors should use the refined input system from Section 6.
- **Usage section (within settings):** Move the full usage dashboard here from being a sub-tab of Missions. Make it a first-class settings section with historical data.

---

## 10. Navigation & Shell Redesign

### TopBar

**Current:** 40px height, gradient "ADE" logo, project tabs, command palette trigger.

**Changes:**
- **Height:** Keep 40px. It's compact and efficient.
- **ADE logo:** Replace gradient text with a clean, bold "ADE" in Geist at 14px font-weight-700. Accent color (`#06d6a0`). No gradient, no glow. Confidence, not flash.
- **Project tabs:** Refine spacing. Max-width per tab: 160px (down from 180px). Active tab: solid accent underline (2px bottom border), no background fill. This is cleaner.
- **Dividers:** Replace gradient divider with a simple 1px `border-border/30` vertical line.
- **Command palette button:** Keep `Cmd+K` display. Style as a ghost button with a subtle border. On hover, the border becomes accent-tinted.

### Sidebar (TabNav)

**Current:** 52px collapsed, 168px expanded on hover. 10 tabs + settings.

**Changes:**
- **Width:** Keep 52px collapsed. Expand to 180px (slightly wider for Geist font).
- **Icons:** Replace Lucide icons with Phosphor Icons (`@phosphor-icons/react`). Phosphor has a more consistent weight and better visual harmony. Use the "regular" weight (not bold, not thin).
- **Icon size:** 20px collapsed, 16px expanded (with labels).
- **Active indicator:** Keep the Framer Motion `layoutId` sliding bar. Change from 3px to 2px width. Use accent color.
- **Tab labels:** `font-sans text-xs font-medium` (Geist, 12px). Not monospace. The mono was too technical-feeling for navigation labels.
- **Tab grouping:** Add a subtle separator between "core" tabs (Run, Lanes, Files, Work) and "tools" tabs (Conflicts, Graph, PRs, History, Automations, Missions). Just a 1px horizontal line at 20% opacity.
- **Settings pinned to bottom:** Keep this pattern.
- **Terminal attention dot:** Keep, update to new status colors.

### Tab Icon Mapping (Phosphor)

| Tab | Phosphor Icon | Reasoning |
|-----|--------------|-----------|
| Run | `PlayCircle` | Start/dashboard |
| Lanes | `GitBranch` | Branch management (more specific than LayoutGrid) |
| Files | `FileCode` | Code files |
| Work | `Terminal` | Terminal sessions |
| Conflicts | `GitMerge` | Merge conflicts (more specific than Bug) |
| Graph | `Graph` | Workspace visualization |
| PRs | `GitPullRequest` | Pull requests |
| History | `ClockCounterClockwise` | Time/history |
| Automations | `Robot` | Automated processes |
| Missions | `Strategy` | Strategic missions |
| Settings | `GearSix` | Configuration |

### Command Palette

**Current:** Triggered by Cmd+K, basic implementation.

**Redesign:**
- Center of screen, 560px wide, max 400px tall.
- `bg-surface-overlay` with `backdrop-blur-xl` (real glassmorphism, not just bg).
- Inner border: `1px solid rgba(255,255,255,0.06)` (liquid glass refraction edge).
- Shadow: `0 24px 48px -12px rgba(0,0,0,0.5)` (dramatic float shadow).
- Search input: 48px tall, `text-lg`, no border, just bottom separator line.
- Results: grouped by category (Navigate, Actions, Recent). Each category with a muted label.
- Selected result: `bg-accent-muted` highlight with arrow key navigation.
- Keyboard hints: right-aligned, `text-2xs font-mono text-muted-fg`.
- Open animation: scale from 0.96 + opacity, 200ms spring. Backdrop fades in 150ms.
- Close animation: scale to 0.98 + opacity out, 150ms.

---

## 11. Micro-Interactions & Moments of Delight

### Everyday Interactions

**Button press feedback:**
All buttons: `active:scale-[0.97] active:translate-y-[0.5px]` (CSS, instant, no JS needed). This tiny physical press makes every click feel tactile.

**Card hover lift:**
All pane containers on hover: `translateY(-1px)` + shadow increases from `shadow-card` to `shadow-card-hover`. 150ms transition. The card "lifts" toward your cursor.

**Input focus ring:**
On focus, inputs get: `box-shadow: 0 0 0 2px var(--color-accent-muted)`. A soft cyan glow appears around the field. 150ms transition.

**Toggle switch:**
Toggles animate the thumb with spring physics (stiffness: 500, damping: 30). The track color transitions from neutral to accent. The thumb has a tiny shadow that changes direction based on position.

**Dropdown open:**
Dropdowns scale from `scaleY(0.95) opacity(0)` to `scaleY(1) opacity(1)`. Transform origin at top. 150ms spring. Items inside stagger in by 20ms each.

### Contextual Rewards

**Mission completion celebration:**
When a mission status changes to "done":
1. The mission card briefly flashes with a cyan border (200ms)
2. A subtle particle burst emanates from the card (12-16 particles, cyan, fading over 1.5s)
3. The ambient background brightens for 2 seconds (opacity 0.15 -> 0.25 -> 0.15)
4. The card's status dot does an "overshoot" spring animation (scale 1 -> 1.8 -> 1)

This is the **Gemini leopard moment**. Rare, earned, memorable.

**All tests passing:**
When all test suites report green:
1. The test summary bar fills to 100% with an emerald sweep (500ms)
2. A brief emerald ripple crosses the Run tab background (radial gradient expanding from center, 2s)
3. Gone. Never repeated for the same test run.

**PR merge:**
When a PR state changes to "merged":
1. The PR card in the list gets a brief emerald highlight
2. In the stacked chain view, the merged PR node dissolves upward (translateY -20px, opacity 0, 800ms)
3. The remaining chain nodes slide up to fill the gap (Framer Motion `layout` prop handles this automatically)

**First-time events:**
One-time animations that never repeat (tracked in localStorage):
- First lane created: the Graph tab icon in the sidebar briefly pulses, drawing attention to the new visualization
- First mission launched: the Missions ambient background "ignites" (opacity ramps from 0 to full over 3s)
- First PR created: a subtle confetti of 8 emerald dots falls in the PR detail pane (1.5s)

### Ambient Life

**Agent activity indicators:**
When agents are working (missions running), the Missions tab icon in the sidebar has a breathing glow (2s cycle, cyan at 30% opacity). This tells the user "work is happening" without them needing to visit the tab.

**Terminal output pulse:**
Active terminals cause the Work tab border (when that pane is visible) to pulse faintly green in rhythm with output frequency. Batched per second, not per character.

**Status dots:**
All status dots (running, attention, etc.) use spring-based opacity animation instead of linear CSS animation. The spring creates a more organic, breathing feel compared to the mechanical `linear` timing.

---

## 12. Performance Budget

### Targets

| Metric | Target | Current |
|--------|--------|---------|
| First Contentful Paint | < 500ms | ~400ms |
| Tab switch latency | < 100ms | ~50ms |
| 3D scene (Graph) init | < 2s | N/A |
| Ambient background FPS | 60fps | 60fps |
| Memory (idle) | < 200MB | ~150MB |
| Memory (Graph 3D active) | < 350MB | N/A |
| Memory (all tabs visited) | < 400MB | ~250MB |

### Rules

1. **Ambient backgrounds:** All Perlin noise / gradient animations run on GPU via CSS `will-change: background` or fragment shaders on a `<canvas>`. Never use JS `requestAnimationFrame` for background animations.

2. **3D scenes:** Only ONE Three.js canvas is ever mounted at a time. When leaving the Graph tab, the scene is unmounted (not hidden). State (camera position, selected node) is preserved in React state and restored on re-mount.

3. **Particle effects:** Celebratory particles (mission complete, etc.) are created as DOM elements with CSS animations, not canvas particles. They're removed from the DOM after animation ends. Max 20 particles per event.

4. **Stagger animations:** Lists longer than 50 items skip stagger animation and render all at once. The stagger is imperceptible at that length and adds unnecessary delay.

5. **Reduced motion:** When `prefers-reduced-motion: reduce` is active, ALL performance budget concerns become irrelevant because no animations run.

6. **Image/asset budget:** Zero external image fetches. All decorative elements are CSS, SVG, or procedural (shader/math). No Unsplash, no static PNGs for backgrounds. This keeps the app fully offline-capable and fast.

---

## 13. Migration Strategy

### What Gets Deleted

```
FILES TO DELETE:
- None (all changes are edits to existing files)

CODE TO REMOVE:
- 4 theme definitions from index.css: bloomberg, rainbow, sky, pats
- ThemeId type: remove "bloomberg" | "rainbow" | "sky" | "pats"
- Theme selector grid in GeneralSection.tsx: replace with dark/light toggle
- THEME_IDS array: reduce to ["dark", "light"]
- All [data-theme="bloomberg"], [data-theme="rainbow"], [data-theme="sky"], [data-theme="pats"] CSS blocks
```

### What Gets Renamed

```
THEME RENAMES:
- "github" theme → "dark" (closest to the new dark theme, easiest migration)
- "e-paper" theme → "light" (closest to the new light theme)
- All CSS variable values updated in both themes

FONT RENAMES:
- --font-sans: system fonts → "Geist"
- --font-mono: system fonts → "Geist Mono"
- --font-serif: removed entirely
```

### What Gets Added

```
NEW DEPENDENCIES:
- geist (font package)
- @phosphor-icons/react (icon library)

ALREADY INSTALLED (no action needed):
- three, @react-three/fiber, @react-three/drei, maath
- framer-motion / motion
- @xyflow/react (kept as 2D fallback for Graph)

NEW FILES:
- src/renderer/components/graph/Graph3DScene.tsx (Three.js scene)
- src/renderer/components/graph/GraphNode3D.tsx (3D node mesh)
- src/renderer/components/graph/GraphEdge3D.tsx (3D edge line)
- src/renderer/components/graph/GraphControls.tsx (overlay UI)
- src/renderer/lib/shaders/ (fragment shaders for ambient backgrounds, if using WebGL approach)
- src/renderer/lib/springs.ts (shared spring configurations)

MODIFIED FILES (every renderer component):
- index.css (complete theme overhaul)
- All 99 components (icon imports, font classes, color classes, spacing)
- AppShell.tsx (tab tint system)
- TabNav.tsx (Phosphor icons, grouping, sizing)
- TopBar.tsx (logo, tab styling)
- SettingsPage.tsx / GeneralSection.tsx (theme toggle)
- TabBackground.tsx (new ambient systems)
- WorkspaceGraphPage.tsx (3D integration)
- OrchestratorDAG.tsx (2.5D enhancement)
```

### CSS Variable Migration Map

| Old Variable | New Variable | Notes |
|-------------|-------------|-------|
| All `--color-*` vars | Same names, new values | Values change, names stay |
| `--font-serif` | Removed | No serif in the design system |
| `--shadow-separator` | Kept | Same name, updated values |
| `--gradient-surface` | Kept | Same name, simpler values |
| New: `--color-accent-muted` | Added | `rgba(accent, 0.12)` |
| New: `--tab-tint-rgb` | Added | Per-tab tint system |
| New: `--tab-tint` | Added | HSL version of tint |

---

## 14. Implementation Phases

### Phase 1: Foundation (Typography, Colors, Themes)

**Scope:** Replace theme system, install fonts, update CSS variables.

**Tasks:**
1. Install `geist` font package, configure in CSS `@font-face`
2. Install `@phosphor-icons/react`
3. Rewrite `index.css` theme definitions: delete 4 themes, rename 2, update all values
4. Update `ThemeId` type and `THEME_IDS` in `shared/types.ts`
5. Update `GeneralSection.tsx` theme selector: 6-grid → dark/light toggle
6. Update `appStore.ts` theme logic and `readInitialTheme()` fallback
7. Global find-replace: `font-serif` references → remove
8. Update type scale: bump all `text-[10px]` to `text-2xs` (11px), all `text-[11px]` to `text-xs` (12px)
9. Update button, chip, input component base styles
10. Verify all 99 components render correctly with new theme

**Estimated scope:** ~30 files modified

### Phase 2: Navigation & Shell

**Scope:** TopBar, TabNav, Sidebar, Command Palette redesign.

**Tasks:**
1. Replace Lucide icons with Phosphor across TabNav
2. Update TabNav: grouping separator, sizing, label font
3. Update TopBar: logo, project tabs, divider, command button
4. Implement per-tab tint CSS class system in AppShell
5. Implement tab switch transition (content stagger)
6. Redesign Command Palette overlay
7. Update sidebar expand/collapse widths and timing

**Estimated scope:** ~8 files modified

### Phase 3: Tab Ambient Backgrounds

**Scope:** Replace all 12 `ade-tab-bg-*` CSS classes with new ambient systems.

**Tasks:**
1. Rewrite `TabBackground.tsx` with new per-tab visuals
2. Implement Perlin noise gradient backgrounds (CSS or shader approach, evaluate performance)
3. Update each tab's ambient pattern per spec (Section 9)
4. Implement cross-fade transition on tab switch
5. Test reduced-motion compliance
6. Performance profiling: ensure 60fps on all backgrounds

**Estimated scope:** ~3 files modified (TabBackground.tsx, index.css, AppShell.tsx)

### Phase 4: Component Refinement (Per-Tab Polish)

**Scope:** Update each tab's internal components to match new design language.

**Tasks (per tab):**
1. **Run:** Dashboard layout, departure-board animations, health metrics
2. **Lanes:** Lane tab spacing, stack graph SVG refinement, diff header
3. **Files:** File tree icons, editor tabs, quick-open modal
4. **Work:** Terminal container depth, session sparklines, output pulse
5. **Conflicts:** Risk matrix colors, resolution progress indicator
6. **PRs:** Chain visualization, state chips, merge animation
7. **History:** Timeline redesign, scroll-driven line draw
8. **Automations:** Trigger-action flow cards, sparkline run history
9. **Missions:** Board cards, activity feed stagger, channel refinement, usage metrics
10. **Settings:** Theme toggle, form styling, section transitions
11. **All tabs:** Empty state compositions

**Estimated scope:** ~60 files modified (largest phase)

### Phase 5: 3D Graph Tab

**Scope:** Build the Three.js force-directed graph.

**Tasks:**
1. Create `Graph3DScene.tsx` with R3F Canvas
2. Implement node meshes with PBR materials
3. Implement edge lines with animated flow particles
4. Add post-processing pipeline (bloom, chromatic aberration, vignette)
5. Implement camera controls (orbit, click-to-focus, idle auto-rotate)
6. Build overlay UI (minimap, search, controls, detail panel)
7. Implement 2D fallback (keep current xyflow, toggle-able)
8. Performance testing: 50 nodes, 100 nodes, 200 nodes
9. WebGL context loss recovery

**Estimated scope:** ~6 new files, ~2 modified files

### Phase 6: Missions 2.5D DAG & Micro-Interactions

**Scope:** Enhance DAG, implement celebratory animations.

**Tasks:**
1. Add CSS 3D perspective to `OrchestratorDAG.tsx`
2. Implement depth-based node sizing and hover Z-translation
3. Add SVG animated flow lines on edges
4. Implement mission completion celebration (particles + flash)
5. Implement all-tests-pass emerald ripple
6. Implement PR merge dissolution animation
7. Implement first-time event animations
8. Implement ambient life indicators (sidebar glow, terminal pulse)
9. Add spring-based status dot animations globally
10. Final polish pass on all motion

**Estimated scope:** ~15 files modified

---

## Appendix A: Comparison — Before & After

### Before
- 6 themes, fragmented identity
- System fonts, 10-11px body text
- Flat CSS backgrounds at 20% opacity
- Generic card-everywhere pattern
- Lucide icons (inconsistent weight)
- 2D graph (xyflow)
- Linear CSS easing on all transitions
- No celebratory moments
- No per-tab color differentiation

### After
- 2 themes (dark + light), unified brand
- Geist + Geist Mono, 13px minimum body
- Perlin noise gradients + refined ambient patterns
- Hierarchical surface system (recessed/base/raised/floating)
- Phosphor icons (consistent weight and style)
- 3D force graph (Three.js flagship)
- Spring physics on all interactive motion
- Earned celebration animations
- Per-tab tint colors creating distinct room atmospheres

---

## Appendix B: Design Tokens Quick Reference

```css
/* Copy-paste ready for implementation */

/* Brand */
--brand-cyan: #06d6a0;

/* Spacing */
--space-1: 4px;
--space-2: 8px;
--space-3: 12px;
--space-4: 16px;
--space-5: 20px;
--space-6: 24px;
--space-8: 32px;
--space-10: 40px;
--space-12: 48px;

/* Radius */
--radius-sm: 2px;
--radius-md: 3px;
--radius-lg: 4px;
--radius-xl: 6px;
--radius-full: 9999px;

/* Transitions */
--duration-instant: 0ms;
--duration-fast: 100ms;
--duration-normal: 150ms;
--duration-slow: 300ms;
--duration-ambient: 20000ms;

/* Z-Index Scale */
--z-base: 0;
--z-raised: 1;
--z-sticky: 10;
--z-overlay: 20;
--z-modal: 30;
--z-toast: 40;
--z-tooltip: 50;
```

---

## Appendix C: Inspiration Sources

- **Gemini by Lusion** — Cinematic camera choreography, PBR materials, HUD overlay, moment of surprise (leopard)
- **ATMOS by Leeroy** — Perlin noise gradients, scroll-driven pace, 3D typography, dreamy atmosphere
- **Unseen Studio** — Inline 3D models, refraction shaders, particle experiments, dark portfolio aesthetic
- **Arcade by Output** — Per-section visual worlds within a unified product, each tab has its own personality
- **Linear** — Clean, confident, developer-focused. The benchmark for "premium dev tool" aesthetics
- **Warp Terminal** — Terminal-first, agents panel, dark focused UI
- **Wave Terminal** — Tiled composable workspace, multi-widget layouts
