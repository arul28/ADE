# @ade-dev/ui

ADE's design-system primitives, theme tokens, and Linear icon set, packaged for
**plugin pages**.

A plugin page (the `webview` surface) draws inside an isolated guest with a
strict content policy. There is no CDN, no external stylesheet, no Tailwind
build step, and no access to the app's renderer. This package is what lets a
page look like the app anyway.

The ADE desktop app consumes the very same modules through
`file:../../packages/ui` plus re-export shims at the old component paths, so the
kit and the app cannot drift apart.

## Install

```sh
npm install @ade-dev/ui react react-dom
```

`react` and `react-dom` are peer dependencies (18 or 19).

## Use it inside the webview

### 1. Inject the stylesheet — never link one

The kit's CSS ships as a **string**, not a `.css` file, because the page's
content policy forbids loading a stylesheet from anywhere. Inject it once:

```tsx
import { AdeStyles } from "@ade-dev/ui";

export function Page() {
  return (
    <>
      <AdeStyles />
      {/* … */}
    </>
  );
}
```

Outside React, call `injectAdeStyles()` once at startup. Both are idempotent.

### 2. Follow the host's theme

The host reports its colour scheme and palette over the bridge. Hand that
straight to `applyAdeTheme`, and again on every `theme` event, so the page
follows the app when the user switches themes:

```ts
import { applyAdeTheme } from "@ade-dev/ui";

const { scheme, tokens } = await window.adePlugin.theme.get();
applyAdeTheme(scheme, tokens);

window.adePlugin.events.on("theme", (next) => applyAdeTheme(next.scheme, next.tokens));
```

`applyAdeTheme` writes the `--ade-*` custom properties onto `:root`. Every
component and every exported style object reads through those properties, so
one call re-themes the whole page. Unknown keys in the host's token map are
dropped rather than written.

If the bridge never answers, the built-in `darkTheme` / `lightTheme` palettes
apply, and they follow `prefers-color-scheme`.

### 3. Draw

```tsx
import { Button, Chip, EmptyState, PaneHeader, COLORS, SANS_FONT } from "@ade-dev/ui";
```

Style objects (`primaryButton()`, `outlineButton()`, `cardStyle()`, `COLORS`,
`LABEL_STYLE`) are plain `CSSProperties` and spread onto a `style` prop.

## Vendor the fonts

`--ade-font-sans` asks for **Geist** and `--ade-font-mono` for **JetBrains
Mono**. The page's content policy allows `font-src 'self'` only, so copy the
`.woff2` files into the plugin's own `dist/` and declare them there:

```css
@font-face {
  font-family: "Geist";
  src: url("./fonts/Geist-Regular.woff2") format("woff2");
  font-weight: 400;
  font-display: swap;
}
```

Do **not** load fonts from Google Fonts or any other origin — the request is
blocked and the page silently falls back to the system stack.

## What is not here

- No `useAppStore`, no Electron, no app routing. The package touches nothing but
  React and the DOM.
- No Tailwind at runtime. Components carry the app's Tailwind class names *and*
  stable `ade-*` class names; inside the app Tailwind draws them, inside a page
  the injected stylesheet does.
- `SmartTooltip` and the vocabulary canvas are deliberately excluded.

## License

AGPL-3.0-only. See `LICENSE`.
