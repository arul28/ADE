# Theming

ADE ships a real theme system: a versioned theme format, a shipped library, a
searchable gallery, and a runtime engine that repaints every surface. This doc
is the contract. Read it before touching a colour token, the Appearance
settings, or anything that reads `--color-*`.

## The seam

Colours live as CSS custom properties in
`apps/desktop/src/renderer/index.css`, defined twice — once under
`[data-theme="dark"]` and once under `[data-theme="light"]`. Tailwind maps them
in `apps/desktop/tailwind.config.cjs` through `@theme`, so a utility like
`bg-card` compiles to `background: var(--color-card)`.

A theme does **not** replace that seam. It feeds it:

- `dark` and `light` are the stylesheet's own two blocks and are applied by
  `data-theme` alone. The engine emits **no** inline variables for them, so the
  default install renders byte-for-byte as it always has.
- Every other theme (shipped extras, custom, imported) is applied by the engine
  writing the semantic palette as inline custom properties on `<html>`. Inline
  styles win over both stylesheet blocks, and every derived token in index.css
  that is written as `color-mix(in srgb, var(--color-accent) …)` or
  `var(--color-surface)` recomputes from the new palette automatically.
- The engine also writes the tokens that are hard-coded per block (gradients,
  shadows, chat glass, pane and work chrome, the PR surfaces) so a custom
  background does not leave a stale dark strip behind.

`data-theme` carries the **base mode** (which structural block to use);
`data-theme-id` carries **identity** (which theme is active).

## The format

`apps/desktop/src/shared/theme/` owns the whole model — no React, no DOM, no
`window`, so the renderer, the tests and any future CLI surface agree on it.

| File | Responsibility |
|---|---|
| `types.ts` | `AdeTheme`, the semantic palette keys, the ANSI keys, the export envelope. |
| `color.ts` | Colour maths: hex / `rgb()` / `oklch()` parsing, sRGB mixing, Oklch lightness shifts, WCAG contrast. |
| `resolve.ts` | Derives every omitted palette token and emits the CSS-variable override map plus the xterm palette. |
| `validate.ts` | Parses and **repairs** untrusted themes; the versioned import/export envelope. |
| `library.ts` | The shipped themes and the id → theme resolution used everywhere. |

A theme states the core five — `bg`, `fg`, `surface`, `card`, `accent` — and may
override any of ~30 semantic tokens (surfaces, borders, muted text, status and
diff tones, the accent family, popover/modal/composer). Everything it omits is
derived from those, per base mode. It may also declare a 16-colour terminal ANSI
palette.

`AdeTheme.baseMode` (`dark` / `light`) selects the structural block. It is
declared by the theme, or inferred from the background's relative luminance when
missing.

### Repair, never throw

A theme can arrive from localStorage written by an older ADE, from an account
row written by a newer one, or from a `.json` file a stranger shared. Parsing
drops unknown palette keys, drops colours that will not parse (the resolver
derives a replacement), slugs a bad id from the name, and dedupes by id. The one
thing refused outright is a file whose envelope `version` is newer than this
build understands — repairing it would silently discard tokens it gained.

### Applying a theme

`apps/desktop/src/renderer/theme/applyTheme.ts` is the only place a resolved
theme touches the DOM. One pass per theme change: clear the properties the
previous theme owned, write the new ones on `<html>`, set `data-theme` and
`data-theme-id` on `<html>` and `<body>`, and set `color-scheme`. It does no
layout reads, so it never forces reflow, and it is called from exactly one
effect in `App.tsx` keyed on `themeId` + `customThemes`.

Terminals are painted separately: `TerminalView.tsx` reads the active theme's
resolved ANSI palette and hands it to xterm. `dark` and `light` keep their
hand-tuned terminal colours; every other theme paints the terminal from its own
palette.

## Persistence and sync

The active theme id (`themeId`) and the custom theme list (`customThemes`) live
in the same `ade.userPreferences.v1` blob as every other preference, and both
are registered in `renderer/lib/accountSettingsSync.ts` under the `account`
scope — so a theme follows you to another machine and the web client, the same
way the chat font size does. The legacy `theme` key is still written (the base
mode) so older clients keep working.

Two ordering facts matter and are deliberate:

- The renderer keeps a custom theme **id** verbatim even before its definition
  has arrived from sync; `resolveThemeById` falls back to the default at paint
  time and repaints the instant the theme list lands. Resolving early would pin
  the machine to the default and lose the user's choice.
- `setTheme` recomputes the store's `theme` (base mode) from the id and the
  current custom list, so `data-theme`, `color-scheme` and the title-bar overlay
  never disagree with the painted palette.

## Adding a theme

Add an `AdeTheme` to `ADE_BUILTIN_THEMES` in `library.ts`. It needs an id, a
name, a base mode and at least the core five palette colours; the gallery preview
and every surface work from there. Do **not** add per-theme CSS blocks to
index.css — that would create a second code path for official themes.

## The customizer

Appearance → Theme → **Customize…** opens `ThemeCustomizer.tsx`, the advanced
editor. It starts from the active theme, lets the user override any semantic
token, and shows the same `resolveTheme` output the app paints with, so the
preview and the live contrast warnings are the real thing.

The save rule lives in `themeCustomizerModel.ts` (`planThemeSave`,
`upsertCustomTheme`) rather than in the dialog, so it is testable without
rendering: **editing a shipped theme never mutates it.** Save always writes a
custom theme; a theme derived from a shipped base gets a fresh, collision-free
id, while editing an existing custom theme keeps its id and replaces it in
place. The base's inherited description and author are dropped from the saved
theme. Duplicate seeds a new draft; Delete removes a custom theme and returns to
the default; Reset to base restores every token to the base's resolved value.

## Adding a token

Add the semantic key to `ADE_THEME_PALETTE_KEYS` and a derivation in
`resolvePalette`, then emit it from `resolveCssVars`. If it is a token the
stylesheet already derives with `color-mix`/`var()`, emitting it is unnecessary
and should be skipped — the seam recomputes it.
