/**
 * The kit's entire stylesheet, as a string.
 *
 * A plugin page runs inside an isolated guest with a strict CSP: no CDN, no
 * external stylesheet, no Tailwind build step. So the kit ships its CSS as
 * plain text and the page injects it once. Everything here is written against
 * `--ade-*` custom properties, which `applyAdeTheme()` sets from the palette
 * the host bridge reports.
 *
 * The desktop app never injects this sheet. Its components carry the original
 * Tailwind utilities alongside the `ade-*` class names, so inside the app
 * Tailwind draws them and this file is inert. That is the whole reason the two
 * hosts cannot drift: there is one component, and this file is the second
 * implementation of its *appearance*, checked against `index.css` values.
 *
 * Class names are not a public API. Theme with tokens, not by overriding rules.
 */

import { darkTheme, lightTheme, themeToCss } from "./createTheme";

export const ADE_STYLE_ID = "ade-ui-styles";

export const adeCss = `
${themeToCss(darkTheme, ":root")}

${themeToCss(lightTheme, ':root[data-ade-theme="light"]')}

@media (prefers-color-scheme: light) {
${themeToCss(lightTheme, ':root:not([data-ade-theme="dark"])')}
}

/* Base ------------------------------------------------------------------- */

.ade-root,
body.ade-root {
  margin: 0;
  color: var(--ade-fg);
  background: var(--ade-bg);
  font-family: var(--ade-font-sans);
  font-size: 12px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}
.ade-root *,
.ade-root *::before,
.ade-root *::after { box-sizing: border-box; }

/* Button ----------------------------------------------------------------- */

.ade-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  font-family: var(--ade-font-mono);
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 1px;
  transition: all 100ms;
  border: 0;
  cursor: pointer;
}
.ade-btn:active { scale: 0.97; }
.ade-btn:disabled { opacity: 0.4; pointer-events: none; }
.ade-btn-sm { height: 28px; padding-inline: 12px; }
.ade-btn-md { height: 32px; padding-inline: 16px; }
.ade-btn-primary { color: #0F0D14; }
.ade-btn-primary:hover { filter: brightness(1.1); }
.ade-btn-outline { color: #A1A1AA; }
.ade-btn-outline:hover { color: #FAFAFA; border-color: #A78BFA50; }
.ade-btn-ghost { color: #71717A; }
.ade-btn-ghost:hover { color: #FAFAFA; background: #1A1720; }
.ade-btn-danger { color: #EF4444; }
.ade-btn-danger:hover { filter: brightness(1.1); }

/* Chip ------------------------------------------------------------------- */

.ade-chip {
  display: inline-flex;
  align-items: center;
  padding: 4px 10px;
  font-family: var(--ade-font-mono);
  font-size: 9px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 1px;
  color: #71717A;
}

/* Pane header ------------------------------------------------------------ */

.ade-pane-header {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: space-between;
  padding-inline: 16px;
  min-height: 36px;
}
.ade-pane-header-left { min-width: 0; display: flex; align-items: center; gap: 8px; }
.ade-pane-header-right { display: flex; align-items: center; gap: 6px; }
.ade-pane-header-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--ade-font-mono);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 1px;
  text-transform: uppercase;
  color: #71717A;
  user-select: none;
}
.ade-pane-header-meta {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--ade-font-mono);
  font-size: 9px;
  color: #52525B;
}

/* Empty state ------------------------------------------------------------ */

.ade-empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 40px;
  text-align: center;
}
.ade-empty-state-icon {
  margin-bottom: 16px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: #52525B;
}
.ade-empty-state-title {
  font-family: var(--ade-font-sans);
  font-size: 14px;
  font-weight: 700;
  letter-spacing: -0.3px;
  color: #FAFAFA;
}
.ade-empty-state-description {
  margin-top: 8px;
  margin-inline: auto;
  max-width: 45ch;
  font-family: var(--ade-font-mono);
  font-size: 11px;
  line-height: 1.625;
  color: #71717A;
}

/* Icons ------------------------------------------------------------------ */

.ade-vcs-lane-icon,
.ade-vcs-branch-icon { flex-shrink: 0; }

.ade-linear-project-icon {
  display: grid;
  flex-shrink: 0;
  place-items: center;
  border-radius: 4px;
  line-height: 1;
}
.ade-linear-project-icon-initial {
  font-size: 9px;
  font-weight: 600;
  color: rgba(255, 255, 255, 0.9);
}

/* Input ------------------------------------------------------------------ */

.ade-input {
  height: 32px;
  width: 100%;
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  background: rgba(255, 255, 255, 0.03);
  padding-inline: 10px;
  font-family: var(--ade-font-sans);
  font-size: 12px;
  color: var(--ade-fg);
  outline: none;
  transition: border-color 150ms, box-shadow 150ms;
}
.ade-input::placeholder { color: color-mix(in srgb, var(--ade-muted-fg) 55%, transparent); }
.ade-input:hover { border-color: rgba(255, 255, 255, 0.14); }
.ade-input:focus {
  border-color: color-mix(in srgb, var(--ade-accent) 45%, transparent);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--ade-accent) 20%, transparent);
}

/* Markdown --------------------------------------------------------------- */

.ade-markdown { color: var(--ade-fg); font-family: var(--ade-font-sans); }
.ade-markdown-p { margin: 0 0 12px; max-width: 100%; white-space: pre-wrap; overflow-wrap: break-word; }
.ade-markdown-p:last-child { margin-bottom: 0; }
.ade-markdown-ul,
.ade-markdown-ol { margin: 0 0 12px; padding-left: 20px; }
.ade-markdown-ul { list-style: disc; }
.ade-markdown-ol { list-style: decimal; }
.ade-markdown-li { overflow-wrap: anywhere; margin-bottom: 4px; }
.ade-markdown-h1,
.ade-markdown-h2,
.ade-markdown-h3,
.ade-markdown-h4 { font-weight: 600; line-height: 1.35; margin: 20px 0 8px; }
.ade-markdown-h1:first-child,
.ade-markdown-h2:first-child,
.ade-markdown-h3:first-child,
.ade-markdown-h4:first-child { margin-top: 0; }
.ade-markdown-h1 { font-size: 19px; letter-spacing: -0.015em; }
.ade-markdown-h2 { font-size: 16px; letter-spacing: -0.012em; }
.ade-markdown-h3 { font-size: 14px; letter-spacing: -0.008em; }
.ade-markdown-h4 { font-size: 12.5px; }
.ade-markdown-hr { margin: 12px 0; border: 0; border-top: 1px solid var(--ade-border); }
.ade-markdown-pre {
  margin: 0 0 12px;
  overflow: auto;
  border-radius: 6px;
  padding: 12px;
  font-family: var(--ade-font-mono);
  font-size: 11px;
  line-height: 1.45;
  background: rgba(0, 0, 0, 0.25);
  border: 1px solid rgba(255, 255, 255, 0.06);
}
.ade-markdown-code {
  border-radius: 4px;
  padding: 1px 4px;
  font-family: var(--ade-font-mono);
  font-size: 11px;
  overflow-wrap: anywhere;
  background: rgba(0, 0, 0, 0.30);
}
.ade-markdown-code-block { font-family: var(--ade-font-mono); }
.ade-markdown-quote {
  margin: 0 0 12px;
  border-left: 2px solid var(--ade-border);
  padding-left: 12px;
  color: var(--ade-muted-fg);
}
.ade-markdown-strong { font-weight: 600; color: var(--ade-fg); }
.ade-markdown-a { color: var(--ade-accent); text-decoration: underline; text-underline-offset: 2px; }
.ade-markdown-table-wrap { margin: 0 0 12px; max-width: 100%; overflow-x: auto; }
.ade-markdown-table { width: 100%; border-collapse: collapse; text-align: left; }
.ade-markdown-th,
.ade-markdown-td {
  padding: 4px 8px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  overflow-wrap: break-word;
}
.ade-markdown-th { font-weight: 600; }
.ade-markdown-td { vertical-align: top; }

/* Lane combobox popover ---------------------------------------------------

   .ade-lane-trigger needs nothing here: it is Tailwind-only in the app and
   carries no ade-* appearance of its own.

   Geometry is byte-for-byte what index.css has (radii, padding, heights,
   durations, easings). Only the colour sources move: the app's work-surface
   variables have no meaning in a page, so each maps onto its nearest --ade-*
   token — --work-popover-bg → the solid card, --work-popover-border and
   --work-pane-border → the border token, --work-popover-shadow → the panel
   shadow, --work-popover-item-active → a mix of the accent, --color-fg and
   --color-muted-fg → their --ade-* twins. */

@keyframes ade-popover-in {
  from { opacity: 0; transform: scaleY(0.96); }
  to { opacity: 1; transform: scaleY(1); }
}

.ade-lane-popover {
  position: relative;
  z-index: 9999;
  min-width: 200px;
  max-width: 280px;
  max-height: 320px;
  background: var(--ade-card-solid);
  border: 1px solid var(--ade-border);
  border-radius: 10px;
  box-shadow: var(--ade-shadow-panel);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  overflow: hidden;
  display: flex;
  flex-direction: column;
  animation: ade-popover-in 120ms cubic-bezier(0.34, 1.56, 0.64, 1);
}

.ade-lane-popover-search-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 10px;
  flex-shrink: 0;
  border-bottom: 1px solid var(--ade-border);
}

.ade-lane-popover-search {
  height: 32px;
  border: none;
  background: transparent;
  padding: 0;
  font-size: 11px;
  color: var(--ade-fg);
  outline: none;
  box-shadow: none;
  width: 100%;
  min-width: 0;
  appearance: none;
  -webkit-appearance: none;
}

.ade-lane-popover-search:focus,
.ade-lane-popover-search:focus-visible {
  outline: none;
  box-shadow: none;
  border: none;
  background: transparent;
}

.ade-lane-popover-search::placeholder {
  color: var(--ade-muted-fg);
  opacity: 0.6;
}

.ade-lane-popover-list {
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 4px;
  flex: 1;
  min-height: 0;
}

.ade-lane-popover-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 6px;
  font-size: 11px;
  font-weight: 400;
  color: var(--ade-fg);
  cursor: pointer;
  border: none;
  background: transparent;
  width: 100%;
  text-align: left;
  transition: box-shadow 120ms ease, background 120ms ease;
}

.ade-lane-popover-item:hover {
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.05),
    0 4px 14px -6px rgba(0, 0, 0, 0.55);
}

.ade-lane-popover-item[data-selected="true"] {
  background: color-mix(in srgb, var(--ade-accent) 16%, transparent);
  font-weight: 500;
}

.ade-lane-popover-item[data-selected="true"]:hover {
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.07),
    0 6px 16px -6px rgba(0, 0, 0, 0.62);
}

.ade-lane-popover-item-featured {
  justify-content: center;
  gap: 6px;
  padding-top: 8px;
  padding-bottom: 8px;
}

.ade-orchestrator-rainbow-text {
  background: linear-gradient(
    90deg,
    #ff5f5f 0%,
    #ff9b3f 16%,
    #f7d05c 33%,
    #59d97f 50%,
    #4f93ff 66%,
    #a566ff 83%,
    #ff5f5f 100%
  );
  background-size: 200% 100%;
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  font-weight: 500;
  background-position: 0 0;
}

/* The component drops framer's entrance spring, so the keyframe above is the
   only entrance there is — which is why the reduced-motion opt-out lives here
   rather than in a hook. */
@media (prefers-reduced-motion: reduce) {
  .ade-lane-popover { animation: none; }
}

/* Liquid glass ------------------------------------------------------------

   The app draws these off its chat-surface variables (--chat-panel-border,
   --chat-glass-*). A page has none, so the sheens become literals over the
   card and border tokens; every radius, blur, saturation and shadow offset is
   the one index.css ships. */

.ade-liquid-glass-menu {
  border-radius: 16px;
  border: 1px solid var(--ade-border);
  background: linear-gradient(
    180deg,
    color-mix(in srgb, var(--ade-card) 94%, var(--ade-bg) 6%) 0%,
    var(--ade-card) 100%
  );
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.055),
    0 24px 56px -20px rgba(0, 0, 0, 0.58),
    0 0 0 1px rgba(255, 255, 255, 0.012);
}

.ade-liquid-glass-pill {
  position: relative;
  overflow: hidden;
  border: 1px solid var(--ade-border);
  background: linear-gradient(
    180deg,
    color-mix(in srgb, var(--ade-card) 78%, transparent) 0%,
    color-mix(in srgb, var(--ade-surface) 76%, transparent) 100%
  );
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.082),
    0 8px 22px -18px rgba(0, 0, 0, 0.48);
  backdrop-filter: blur(20px) saturate(145%);
  -webkit-backdrop-filter: blur(20px) saturate(145%);
}
`;

/**
 * Put the stylesheet in the document once. Idempotent by element id, so two
 * mounted surfaces cannot emit two copies.
 */
export function injectAdeStyles(doc?: Document): void {
  const target = doc ?? (typeof document === "undefined" ? null : document);
  if (!target) return;
  if (target.getElementById(ADE_STYLE_ID)) return;
  const style = target.createElement("style");
  style.id = ADE_STYLE_ID;
  style.textContent = adeCss;
  (target.head ?? target.documentElement).appendChild(style);
}
