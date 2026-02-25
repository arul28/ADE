# ADE Design Template
## Industrial Technical Shell Theme (Contract v2)

A high-density, technical aesthetic for ADE shell surfaces (sidebar + top header/project selection) with sharp edges, mono-first UI text, and accent-led state styling.

---

## Visual Direction

- Base mood: industrial, tool-like, high-contrast
- Shape language: hard edges (`0px` radius)
- Typography: monospace-first for controls/navigation, sans for larger headings
- Interaction style: subtle tints + border-led affordances, never soft neumorphism

---

## Core Palette

### Dark (default)

| Primitive | Value | Notes |
|---|---|---|
| Background | `#0F0D14` | app canvas |
| Surface | `#13101A` | elevated panes/cards |
| Recessed | `#0C0A10` | control wells / inputs |
| Border | `#1E1B26` | default separators |
| Text primary | `#FAFAFA` | key labels |
| Text muted | `#71717A` | secondary labels |
| Accent | `#A78BFA` | active/focus/action |
| Success | `#22C55E` | running/success states |
| Warning | `#F59E0B` | attention needed |
| Error | `#EF4444` | missing/failure |

### Light

| Primitive | Value | Notes |
|---|---|---|
| Background | `#F5F3F0` | warm off-white canvas |
| Surface | `#FAF8F5` | shell surfaces |
| Recessed | `#EAE7E2` | controls |
| Border | `#D6D3CE` | separators |
| Text primary | `#1A1A1E` | key labels |
| Text muted | `#636370` | secondary labels |
| Accent | `#049068` | active/focus/action |

---

## Typography Contract

- UI text: `JetBrains Mono` via `var(--font-mono)`
- Headlines: `Space Grotesk` via `var(--font-sans)`
- Shell controls and tabs:
  - size: `11px`
  - letter spacing: `0`
  - casing: preserve component-specific casing (no forced uppercase in project tabs)

---

## Global Token Contract

These tokens are source-of-truth in `apps/desktop/src/renderer/index.css`.

### Base Tokens (`--color-*`)

- Foundation surfaces, text, borders, accent, semantic statuses.
- Consumers should treat these as generic cross-app tokens.

### Shell Tokens (`--shell-*`)

Use these for all `AppShell`, `TopBar`, and `TabNav` styling to avoid hardcoded values.

| Group | Tokens |
|---|---|
| Header layout/surface | `--shell-header-height`, `--shell-header-padding-start`, `--shell-header-padding-end`, `--shell-header-bg`, `--shell-header-fg`, `--shell-header-border`, `--shell-header-divider` |
| Sidebar layout/surface | `--shell-sidebar-collapsed-width`, `--shell-sidebar-expanded-width`, `--shell-sidebar-bg`, `--shell-sidebar-border` |
| Sidebar item states | `--shell-sidebar-item-height`, `--shell-sidebar-item-fg`, `--shell-sidebar-item-hover-fg`, `--shell-sidebar-item-hover-bg`, `--shell-sidebar-item-active-fg`, `--shell-sidebar-item-active-bg`, `--shell-sidebar-item-active-rail`, `--shell-sidebar-separator` |
| Project-tab states | `--shell-project-tab-bg`, `--shell-project-tab-fg`, `--shell-project-tab-hover-bg`, `--shell-project-tab-hover-fg`, `--shell-project-tab-hover-border`, `--shell-project-tab-active-bg`, `--shell-project-tab-active-fg`, `--shell-project-tab-active-border`, `--shell-project-tab-missing-bg`, `--shell-project-tab-missing-fg`, `--shell-project-tab-missing-border`, `--shell-project-tab-open-bg`, `--shell-project-tab-open-fg`, `--shell-project-tab-open-border`, `--shell-project-tab-focus-bg`, `--shell-project-tab-focus-fg`, `--shell-project-tab-focus-border`, `--shell-project-tab-focus-ring`, `--shell-project-tab-font-family`, `--shell-project-tab-font-size`, `--shell-project-tab-letter-spacing` |
| Shell control states | `--shell-control-bg`, `--shell-control-fg`, `--shell-control-border`, `--shell-control-hover-bg`, `--shell-control-hover-fg`, `--shell-control-hover-border`, `--shell-control-open-bg`, `--shell-control-open-fg`, `--shell-control-open-border`, `--shell-control-focus-bg`, `--shell-control-focus-fg`, `--shell-control-focus-border`, `--shell-control-focus-ring`, `--shell-control-kbd-bg`, `--shell-control-kbd-fg` |
| Attention dots | `--shell-status-running`, `--shell-status-attention` |

---

## Shared Utility-Class Contract

`index.css` provides reusable shell utility classes that consume the shell tokens:

- `ade-shell-header`
- `ade-shell-header-divider`
- `ade-shell-project-tab`
- `ade-shell-control`
- `ade-shell-control-kbd`
- `ade-shell-sidebar-item`
- `ade-shell-sidebar-separator`
- `ade-shell-sidebar-active-rail`
- `ade-sidebar-clip` (width + border from shell tokens)
- `ade-sidebar` (surface from shell tokens)

---

## Component Consumption Rules

### Top header + project selection (`TopBar.tsx`)

- Header root MUST use `ade-shell-header`.
- Header dividers MUST use `ade-shell-header-divider`.
- Project tabs MUST use `ade-shell-project-tab` and encode state via `data-state`:
  - `active`
  - `missing`
  - `open`
  - omit for default
- Icon/search/zoom controls MUST use `ade-shell-control`.
- Keyboard hint pills MUST use `ade-shell-control-kbd`.

### Sidebar shell (`AppShell.tsx` + `TabNav.tsx`)

- Sidebar container MUST keep `ade-sidebar-clip` + `ade-sidebar`.
- Sidebar nav links SHOULD use `ade-shell-sidebar-item` and set `data-active="true"` for active route.
- Active indicator rail SHOULD use `ade-shell-sidebar-active-rail`.
- Group separators SHOULD use `ade-shell-sidebar-separator`.

### Prohibited patterns

- No new raw hex values in shell components.
- No ad-hoc one-off state colors when a shell token exists.
- No duplicated local constants for shell spacing/colors/typography.

---

## Quick Verification Checklist

- Sidebar + header are fully theme-aware under both `dark` and `light`.
- Active/hover/missing/focus/open/selected states resolve only through `--shell-*` tokens.
- Shell components consume shared utility classes instead of hardcoded color strings.
- Primitive names stay stable and non-overlapping with existing `--color-*` foundations.
