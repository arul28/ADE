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
