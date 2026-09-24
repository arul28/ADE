# Local brand assets (optional)

Primary marks use **`@lobehub/icons`** (`ProviderLogos.tsx`, `ToolLogos.tsx`). Remaining families use **`@lobehub/icons-static-svg`** via `lobeProviderIconSrc.ts`. See [Lobe Icons skill](https://lobehub.com/icons/skill.md).

## Cursor

Cursor CLI / subscription rows use **`Cursor.Avatar`** from `@lobehub/icons`. This folder may keep `cursor.svg` for one-off experiments or future overrides; it is not imported by the app today.

## Droid

`droid.svg` is the local Factory Droid mark used for the Droid provider/runtime. Model rows still use the underlying model-family marks (Claude, OpenAI, Gemini, etc.) when the Droid model id reveals one.

`droid-mark.svg` is the same Droid glyph without its black backing disc, filled solid so it can be used as a CSS mask and painted in `currentColor` (the empty-state import hint uses it).
