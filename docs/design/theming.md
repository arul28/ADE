# Theming

ADE ships a real theme system: a versioned theme format, a shipped library of
26 families, a searchable gallery, and a runtime engine that repaints every
surface. This doc
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

### Light mode readability

Most component colours are written for a dark page. Light themes stay readable
through the `[data-theme="light"]` seam rather than through per-component
branches, so every light theme (built-in and shipped families alike) gets the
same treatment:

- **Status tints.** Light mode restates Tailwind's pale shades (50–400) as deep
  ones, and 900/950 as pale ones in the colour families, so `text-amber-200` or
  `text-red-300/75` reads on a light page. The grey families remap only 50–400.
  A pale or deep colour that must not flip — text on the always-accent user
  bubble or a fixed dark overlay — is written as a hex (`text-[#ecfeff]/85`).
- **Overlays and hairlines.** Faint washes and borders are tints of
  `--color-fg` (`bg-fg/[0.06]`, `border-fg/10`, `fgTint(6)` in
  `laneDesignTokens.ts`), not of white, so they show on light pages and look
  the same on dark ones.
- **Surfaces.** Menus and popovers paint from tokens (`--work-popover-bg`,
  `--color-popup-bg`, `POPOVER_SURFACE_CLASS` in `paneMenuTokens.ts`), never a
  hard-coded dark hex.
- **Lane and status colours as text.** Use `toneText(color)` in TS or
  `text-tone-[#hex]` in a class. Both keep the colour whole on dark pages and
  pull it toward `--color-fg` on light pages by `--ade-tone-text-strength`.
- **Text on a solid tone fill** (an amber button, a violet checkbox) uses
  `--ade-on-tone-ink`: near-black on dark pages, white on light ones.
- **Chat ink.** The "No tint" chat palette and anything printed on the user's
  accent bubble use `--chat-ink`; light pages set it to `--color-fg` and the
  bubble pins it back to white.

## The format

`apps/desktop/src/shared/theme/` owns the whole model — no React, no DOM, no
`window`, so the renderer, the tests and any future CLI surface agree on it.

| File | Responsibility |
|---|---|
| `types.ts` | `AdeTheme`, the semantic palette keys, the ANSI keys, the export envelope. |
| `color.ts` | Colour maths: hex / `rgb()` / `oklch()` parsing, sRGB mixing, Oklch lightness shifts, WCAG contrast. |
| `resolve.ts` | Derives every omitted palette token and emits the CSS-variable override map plus the xterm palette. |
| `validate.ts` | Parses and **repairs** untrusted themes; the versioned import/export envelope. |
| `jsonc.ts` | Parses JSON with comments and trailing commas, which is what VS Code theme files are. |
| `syntax.ts` | The ten syntax colours and the TextMate-scope table that reads them from `tokenColors` and writes them to Shiki. |
| `vscode.ts` | Best-effort VS Code theme import: maps the workbench, terminal and code colours it understands and reports what it could not. |
| `family.ts` | The builder every shipped family is written with (`family`, `ansi`) and the gallery collections. |
| `library.ts`, `libraryOriginals.ts`, `libraryClassics.ts` | The shipped themes and the id → theme resolution used everywhere. |

A theme states the core five — `bg`, `fg`, `surface`, `card`, `accent` — and may
override any of ~30 semantic tokens (surfaces, borders, muted text, status and
diff tones, the accent family, popover/modal/composer). Everything it omits is
derived from those, per base mode. It may also declare a 16-colour terminal ANSI
palette.

A theme may also state **`syntax`** and **`flair`**, both optional:

- `syntax` holds ten code colours (comment, keyword, string, number, function,
  type, constant, variable, property, operator). Omitted ones are derived from
  the theme's terminal palette and nudged until they read against the
  background. The file editor (Monaco) and chat code blocks (Shiki) are painted
  from them — `renderer/theme/codeTheme.ts` — so a theme paints its code like
  everything else. `dark` and `light` keep the editor and code colours ADE has
  always shipped.
- `flair` is the part that is not colour: `radius` (sharp, default, soft,
  round), `shadow` (soft, flat, hard, glow, plus a `shadowColor` for hard),
  `sansFont` (default, mono, serif, rounded) and `backdrop` (none, grid, dots,
  scanlines, noise, aurora). Every field is a closed list of names. A theme
  file can come from a stranger, so nothing in it is ever a CSS string; the
  engine maps each name to a vetted value.

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
`data-theme-id` on `<html>` and remove any stale copy from `<body>`, and set
`color-scheme`. It does no
layout reads, so it never forces reflow, and it is called from exactly one
effect in `App.tsx` keyed on `themeId` + `customThemes`.

Flair reaches the page two ways. Corners, shadows and the interface face are
custom properties the engine writes (`--radius-*`, `--pane-radius`,
`--shadow-*`, `--theme-font-sans`), and `index.css` expresses its own radii
through the same scale so they follow. The backdrop is one static layer,
`html[data-theme-backdrop]::after`, drawn from `--ade-flair-backdrop*` with
pointer events off. A few rules read `data-theme-radius` and `data-theme-shadow`
for surfaces that state a radius or shadow of their own; they run only while the
active theme asks. The Interface font preference still wins over a theme's face.

Terminals are painted separately: `TerminalView.tsx` reads the active theme's
resolved ANSI palette and hands it to xterm. `dark` and `light` keep their
hand-tuned terminal colours; every other theme paints the terminal from its own
palette.

## Persistence: per computer

Appearance is **per computer**, not per account. The active theme id
(`themeId`), the custom theme list (`customThemes`), `themeFollowsSystem`, the
interface and terminal preferences all live in the `ade.userPreferences.v1`
blob in this machine's localStorage and are **not** in
`ACCOUNT_SYNCED_SETTINGS`. A laptop, a desktop and a browser each keep their own
look; signing in on a new machine does not carry a theme over. The page is under
Settings → Machines → This computer → Appearance, and has no copy under a remote
machine. (The Apple device options that used to share the page stay on the
account, on their own Account page, because the host reads the remote streaming
cap from the account store.)

Rows an older build already wrote to the account are ignored, not deleted. Move
a theme between machines with Export and Import.

`setTheme` recomputes the store's `theme` (base mode) from the id and the
current custom list, so `data-theme`, `color-scheme` and the title-bar overlay
never disagree with the painted palette. The legacy `theme` key is still
written (the base mode) so older clients keep working.

## Adding a theme

Add a `family(...)` to `library.ts` (an ADE family), `libraryOriginals.ts` (a
theme with its own flair) or `libraryClassics.ts` (an editor scheme with its
code colours). A family states a dark and a light variant; each needs a
description and at least the core five palette colours. State `terminal` for
a scheme that has an official ANSI set, and `syntax` for one that has editor
colours. Run both variants through `resolveTheme` and check text contrast
before shipping. Do **not** add per-theme CSS blocks to index.css — that would
create a second code path for official themes. Use `flair` for shape and depth,
and `tags` so the gallery search finds it.

## The gallery

`ThemeGallery.tsx` shows the families in shelves (`THEME_COLLECTIONS`: ADE,
Originals, Editor classics) and then the user's own themes. The search field
matches a family's name, both variant names and descriptions, its tags and its
shelf, and every word has to match. Each swatch shows the theme's corner and
depth on its accent dot; the stage names the theme's flair in plain words.

## The customizer

Appearance → Theme → **Customize…** opens `ThemeCustomizer.tsx`, the advanced
editor. It starts from the active theme, lets the user override any semantic
token, the ten code colours and the shape settings (corners, depth, interface
type, backdrop), and shows the same `resolveTheme` output the app paints with, so the
preview and the live contrast warnings are the real thing.

The save rule lives in `themeCustomizerModel.ts` (`planThemeSave`,
`upsertCustomTheme`) rather than in the dialog, so it is testable without
rendering: **editing a shipped theme never mutates it.** Save always writes a
custom theme; a theme derived from a shipped base gets a fresh, collision-free
id, while editing an existing custom theme keeps its id and replaces it in
place. The base's inherited description and author are dropped from the saved
theme. Duplicate seeds a new draft; Delete removes a custom theme and returns to
the default; Reset to base restores every token to the base's resolved value.

## Import and export

`ThemeImportExport.tsx` (Appearance → Theme) exports the active theme as the
versioned ADE envelope — copied to the clipboard and downloaded as
`ade-theme-<id>.json` — and imports a `.json` file back. The export carries the
palette, terminal colours, code colours and flair. Import accepts either an ADE
theme (`prepareImportedTheme` gives it a collision-free id and stamps its
source) or a VS Code theme. Files are read with `parseJsonc`, so the comments
and trailing commas VS Code themes carry no longer fail as "not valid JSON".
`ThemeFilesHelp` (a disclosure under the gallery) says all of this to the user
and links to Open VSX, the VS Code Marketplace and vscodethemes.com.

VS Code import (`shared/theme/vscode.ts`) is **best-effort and says so**. It
maps the `colors` keys that translate cleanly to ADE tokens, the
`terminal.ansi*` keys to the ANSI palette, and `tokenColors` to the ten syntax
colours (through the scope table in `syntax.ts`; `keyword.operator` and
property scopes need an exact entry, so a broad `keyword` rule does not paint
every operator). It takes the base mode from the file's `type`, falling back to
the editor background, and returns the keys it could not map — plus `include`
and `semanticTokenColors` when present, which it does not follow. The import
dialog shows that list and how many code colours came in. It still does not read
a `.vsix`; unzip it and pick a file from its `themes` folder.

## Adding a token

Add the semantic key to `ADE_THEME_PALETTE_KEYS` and a derivation in
`resolvePalette`, then emit it from `resolveCssVars`. If it is a token the
stylesheet already derives with `color-mix`/`var()`, emitting it is unnecessary
and should be skipped — the seam recomputes it.

## Per-project themes are deliberately not shipped

A theme is a user preference, like the chat font size: it lives in
`ade.userPreferences.v1` on this computer. A per-project theme would layer a
second, project-scoped choice on top, and the seam for that already exists
(`accountSettingsSync` supports an `account-repo` scope keyed on the project's
git remote). It is not shipped because the product questions have more than one
reasonable answer and the answers disagree with each other:

- Does a project pin **replace** the user's theme for that project, or only
  override the accent on top of it?
- When a project pins a theme, what does the gallery's **Active** state show,
  and what does **Customize…** edit — the pin, or the account theme?
- Does the pin **travel** to other machines (it can, via `account-repo` scope)
  or stay local to the checkout?

Each answer changes the gallery, the customizer, and the sync key. Picking one
without a decision would bake a guess into persisted state that is awkward to
migrate. The format, engine, and settings scopes already carry what the feature
needs, so it is a self-contained follow-up once those questions are answered.
