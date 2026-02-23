# ADE Design System
## Industrial Technical + Purple Theme

A dark, technical aesthetic inspired by industrial dashboards with a purple accent color scheme. Designed for developer tools, git workflows, and agentic development environments.

---

## Color Palette

### Backgrounds
| Token | Hex | Usage |
|-------|-----|-------|
| `bg-primary` | `#0F0D14` | Main screen background, modals |
| `bg-secondary` | `#13101A` | Cards, elevated surfaces |
| `bg-tertiary` | `#0C0A10` | Headers, footers, input backgrounds |
| `bg-hover` | `#1A1720` | Hover states on dark backgrounds |

### Borders & Dividers
| Token | Hex | Usage |
|-------|-----|-------|
| `border-default` | `#1E1B26` | Card borders, dividers |
| `border-subtle` | `#27272A` | Input borders, inactive states |
| `border-muted` | `#52525B` | Disabled elements |

### Text Colors
| Token | Hex | Usage |
|-------|-----|-------|
| `text-primary` | `#FAFAFA` | Headings, important text |
| `text-secondary` | `#A1A1AA` | Body text, descriptions |
| `text-muted` | `#71717A` | Labels, placeholders, hints |
| `text-disabled` | `#52525B` | Disabled text, inactive tabs |

### Accent Colors
| Token | Hex | Usage |
|-------|-----|-------|
| `accent-primary` | `#A78BFA` | Primary buttons, active states, links |
| `accent-primary-subtle` | `#A78BFA18` | Accent backgrounds (badges, selected items) |
| `accent-primary-border` | `#A78BFA30` | Accent borders |

### Status Colors
| Status | Solid | Subtle BG | Border |
|--------|-------|-----------|--------|
| Success | `#22C55E` | `#22C55E18` | `#22C55E30` |
| Warning | `#F59E0B` | `#F59E0B18` | `#F59E0B30` |
| Error | `#EF4444` | `#EF444418` | `#EF444430` |
| Info | `#3B82F6` | `#3B82F615` | `#3B82F630` |

---

## Typography

### Font Families
- **UI Text:** `JetBrains Mono` (monospace)
- **Headlines:** `Space Grotesk` (sans-serif)

### Type Scale
| Style | Font | Size | Weight | Letter Spacing | Usage |
|-------|------|------|--------|----------------|-------|
| heading-lg | Space Grotesk | 20px | 700 | -0.5px | Page titles |
| heading-md | Space Grotesk | 16px | 700 | -0.3px | Modal titles |
| heading-sm | JetBrains Mono | 12px | 600 | 0px | Card titles |
| label | JetBrains Mono | 10px | 700 | 1px | ALL-CAPS labels |
| label-sm | JetBrains Mono | 9px | 500-600 | 1px | Badges |
| body | JetBrains Mono | 11-12px | 400 | 0px | Body text |
| stat-number | Space Grotesk | 28px | 700 | 0px | Large stats |

### Text Rules
- **ALL-CAPS** for labels, badges, button text, tab names
- Monospace everywhere except large headlines
- Line height: 1.4-1.6 for body text

---

## Components

### Buttons

**Primary Button**
- Background: `#A78BFA`
- Text: `#0F0D14`, JetBrains Mono, 11px, 700, 1px spacing
- Padding: `12px 24px`
- Corner Radius: `0px`
- Icon: 14x14px, `#0F0D14`, 8px gap

**Secondary Button**
- Background: transparent
- Border: `1px solid #27272A`
- Text: `#71717A`

**Danger Button**
- Background: `#EF444418`
- Border: `1px solid #EF444430`
- Text/Icon: `#EF4444`

### Input Fields

**Default**
- Background: `#0C0A10`
- Border: `1px solid #27272A`
- Text: `#FAFAFA`, JetBrains Mono, 12px
- Padding: `12px 16px`

**Focused**
- Border: `1px solid #A78BFA`

### Badges

| Status | Background | Text |
|--------|------------|------|
| Active | `#A78BFA18` | `#A78BFA` |
| Success | `#22C55E18` | `#22C55E` |
| Warning | `#F59E0B18` | `#F59E0B` |
| Error | `#EF444418` | `#EF4444` |
| Info | `#3B82F615` | `#3B82F6` |

- Padding: `3-4px 8-10px`
- Font: JetBrains Mono, 8-9px, 700, 1px spacing

### Cards

**Standard Card**
- Background: `#13101A`
- Border: `1px solid #1E1B26`
- Padding: `16-20px`
- Corner Radius: `0px`

**Selected Card**
- Background: `#A78BFA12`
- Border-Left: `3px solid #A78BFA`

### Tabs

**Tab Item**
- Padding: `10px 16px`
- Gap: `8px` between number and label
- Number format: `"01"`, `"02"` (zero-padded)

| State | Number | Label | Background |
|-------|--------|-------|------------|
| Inactive | `#52525B` | `#71717A` | transparent |
| Active | `#A78BFA` | `#FAFAFA` | `#A78BFA18` + 2px left border |

### Icons (Lucide)
- Small: 12x12px
- Default: 14x14px
- Medium: 16x16px
- Large: 20x20px

Common icons: `git-branch`, `git-pull-request`, `circle-check`, `loader`, `triangle-alert`, `plus`, `search`, `layers`, `sparkles`

---

## Layout Patterns

### Header
- Height: `64px`
- Padding: `0 24px`
- Divider: `1px #1E1B26` below

### Split Pane
- Left Panel: `400px` fixed
- Right Panel: `fill_container`
- Divider: `1px #1E1B26`

### Modal
- Width: `560px`
- Header: `56px`, `#0C0A10`
- Body: `24px` padding
- Footer: `72px`, `#0C0A10`

---

## CSS Variables

```css
:root {
  --bg-primary: #0F0D14;
  --bg-secondary: #13101A;
  --bg-tertiary: #0C0A10;
  --border-default: #1E1B26;
  --border-subtle: #27272A;
  --text-primary: #FAFAFA;
  --text-secondary: #A1A1AA;
  --text-muted: #71717A;
  --accent-primary: #A78BFA;
  --success: #22C55E;
  --warning: #F59E0B;
  --error: #EF4444;
  --info: #3B82F6;
  --font-mono: "JetBrains Mono", monospace;
  --font-sans: "Space Grotesk", sans-serif;
}
Quick Checklist
 Background: #0F0D14
 Cards: #13101A with 1px #1E1B26 border
 Corner radius: 0px (always sharp)
 ALL-CAPS for labels/buttons
 JetBrains Mono for UI, Space Grotesk for headlines
 Tabs numbered: "01", "02", etc.
 Active states: left border 3px #A78BFA
 Primary buttons: solid #A78BFA with dark text
 Header: 64px height, 24px horizontal padding
 Letter spacing: 1px for ALL-CAPS

---
